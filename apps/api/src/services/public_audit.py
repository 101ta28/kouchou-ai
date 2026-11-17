"""Review and publication of generated audit summaries, separate from evidence.

Azure state is read from the private container on every request. A stale local
copy must never resurrect a withdrawn release after a restart.
"""

import json
import os
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

from analysis_core.audit import AuditBusyError, AuditError, _private_dir, _write_json, utc_now
from analysis_core.public_audit import PublicDocument, PublicSchema, build_public_audit, document_digest
from pydantic import Field, field_validator

from src.schemas.report import ReportStatus, ReportVisibility
from src.services import audit as internal
from src.services.report_status import load_status_as_reports


class PublicationConflict(AuditError):
    pass


class PublicationState(PublicSchema):
    schema_version: Literal[1] = 1
    status: Literal["published", "withdrawn"]
    source_run_id: str = Field(pattern=r"^[0-9]{8}T[0-9]{12}Z-[a-f0-9]{32}$")
    release_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    updated_at: str

    _timestamp = field_validator("updated_at")(PublicDocument.valid_timestamp.__func__)


def require_public_report(slug: str) -> None:
    from src.utils.slug_utils import validate_slug

    validate_slug(slug)
    report = next((row for row in load_status_as_reports() if row.slug == slug), None)
    if report is None or report.status != ReportStatus.READY or report.visibility != ReportVisibility.PUBLIC:
        raise FileNotFoundError("Public report not found")


def _directory(slug: str, run_id: str) -> Path:
    store = internal.store_for(slug)
    store.record_dir(run_id)  # validates the identifier without reading internal evidence
    root = store.path / "publications"
    directory = root / run_id
    if root.is_symlink() or directory.is_symlink():
        raise AuditError("Invalid publication directory")
    return directory


def _read_json(path: Path):
    if path.is_symlink():
        raise AuditError("Invalid publication file")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def _remote_json(blob: str):
    with tempfile.TemporaryDirectory(prefix="kouchou-public-audit-") as temporary:
        path = Path(temporary) / "record.json"
        try:
            if not internal.audit_storage().download_file(blob, str(path)):
                raise OSError("Could not read audit publication")
        except FileNotFoundError:
            return None
        return _read_json(path)


def _state(slug: str, run_id: str) -> PublicationState | None:
    directory = _directory(slug, run_id)
    if internal.settings.STORAGE_TYPE == "azure_blob":
        data = _remote_json(f"public-audits/{slug}/{run_id}/state.json")
    else:
        data = _read_json(directory / "state.json")
    if data is None:
        return None
    state = PublicationState.model_validate(data)
    if state.source_run_id != run_id:
        raise AuditError("Mismatched publication source")
    return state


def preview_public_audit(slug: str, run_id: str) -> dict:
    store = internal.restore_audit_files(slug, run_id)
    document = build_public_audit(store, run_id)
    return {"document": document, "sha256": document_digest(document), "review_required": True}


@contextmanager
def _publication_lock(slug: str):
    store = internal.store_for(slug)
    _private_dir(store.root)
    _private_dir(store.path)
    path = store.path / ".publication.lock"
    if path.is_symlink():
        raise AuditError("Invalid publication lock")
    with os.fdopen(os.open(path, os.O_CREAT | os.O_RDWR, 0o600), "r+b") as lock:
        try:
            if os.name == "nt":
                import msvcrt

                if os.fstat(lock.fileno()).st_size == 0:
                    lock.write(b"\0")
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise AuditBusyError("Another publication operation is in progress") from exc
        yield


def _save_state(slug: str, state: PublicationState) -> None:
    directory = _directory(slug, state.source_run_id)
    _private_dir(directory)
    data = state.model_dump(mode="json")
    # Requests are retained even if persistence fails; only state.json commits
    # a publication. Do not describe an attempted upload as a completed action.
    event = directory / "events" / f"{uuid.uuid4().hex}.json"
    _write_json(event, {"requested_state": data})
    if internal.settings.STORAGE_TYPE == "azure_blob":
        prefix = f"public-audits/{slug}/{state.source_run_id}"
        storage = internal.audit_storage()
        if not storage.upload_file(str(event), f"{prefix}/events/{event.name}"):
            raise OSError("Could not persist publication action")
        pending = directory / ".pending-state.json"
        try:
            _write_json(pending, data)
            if not storage.upload_file(str(pending), f"{prefix}/state.json"):
                raise OSError("Could not persist publication state")
        finally:
            pending.unlink(missing_ok=True)
    _write_json(directory / "state.json", data)


def publish_public_audit(slug: str, run_id: str, expected_sha256: str) -> dict:
    with _publication_lock(slug):
        require_public_report(slug)
        preview = preview_public_audit(slug, run_id)
        if preview["sha256"] != expected_sha256:
            raise PublicationConflict("Preview changed; review a new preview before publishing")
        current = _state(slug, run_id)
        if current and current.status == "published" and current.release_id == expected_sha256:
            return get_public_audit(slug, run_id)
        directory = _directory(slug, run_id)
        destination = directory / f"{expected_sha256}.json"
        existing = _read_json(destination)
        if existing is not None and document_digest(existing) != expected_sha256:
            raise AuditError("Publication artifact failed verification")
        if existing is None:
            _write_json(destination, preview["document"])
        if internal.settings.STORAGE_TYPE == "azure_blob":
            if not internal.audit_storage().upload_file(
                str(destination), f"public-audits/{slug}/{run_id}/{expected_sha256}.json"
            ):
                raise OSError("Could not persist public audit artifact")
        # A report hidden during preparation must not receive a new publication.
        require_public_report(slug)
        state = PublicationState(
            status="published", source_run_id=run_id, release_id=expected_sha256, updated_at=utc_now()
        )
        _save_state(slug, state)
        return {"release_id": expected_sha256, "published_at": state.updated_at, "document": preview["document"]}


def withdraw_public_audit(slug: str, run_id: str) -> None:
    with _publication_lock(slug):
        current = _state(slug, run_id)
        if current is None:
            raise FileNotFoundError("Audit publication not found")
        _save_state(
            slug,
            PublicationState(
                status="withdrawn", source_run_id=run_id, release_id=current.release_id, updated_at=utc_now()
            ),
        )


def get_public_audit(slug: str, run_id: str) -> dict:
    require_public_report(slug)
    state = _state(slug, run_id)
    if state is None or state.status != "published" or not state.release_id:
        raise FileNotFoundError("Audit publication not found")
    if internal.settings.STORAGE_TYPE == "azure_blob":
        document = _remote_json(f"public-audits/{slug}/{run_id}/{state.release_id}.json")
    else:
        document = _read_json(_directory(slug, run_id) / f"{state.release_id}.json")
    if document is None:
        raise AuditError("Published audit artifact is unavailable")
    # Validate both the entire public schema and the digest on every read.
    if document_digest(document) != state.release_id or document["source_run_id"] != run_id:
        raise AuditError("Published audit artifact failed verification")
    require_public_report(slug)
    return {"release_id": state.release_id, "published_at": state.updated_at, "document": document}


def list_public_audits(slug: str) -> list[dict]:
    require_public_report(slug)
    store = internal.store_for(slug)
    if internal.settings.STORAGE_TYPE == "azure_blob":
        with tempfile.TemporaryDirectory(prefix="kouchou-audit-index-") as temporary:
            try:
                if not internal.audit_storage().download_directory(
                    f"public-audits/{slug}", temporary, target_suffixes=("/state.json",)
                ):
                    raise OSError("Could not read public audit index")
            except FileNotFoundError:
                return []
            states = [_read_json(path) for path in Path(temporary).glob("*/state.json")]
    else:
        states = [_read_json(path) for path in (store.path / "publications").glob("*/state.json")]
    result = []
    for data in states:
        state = PublicationState.model_validate(data)
        if state.status == "published" and state.release_id:
            # Only approved run IDs appear; no parent IDs or private history counts.
            result.append(
                {"run_id": state.source_run_id, "release_id": state.release_id, "published_at": state.updated_at}
            )
    require_public_report(slug)
    return sorted(result, key=lambda row: row["run_id"], reverse=True)
