"""Review and publication of generated audit summaries, separate from evidence.

Azure state is read from the private container on every request. A stale local
copy must never resurrect a withdrawn release after a restart.
"""

import hashlib
import io
import json
import os
import tempfile
import uuid
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

from analysis_core.audit import AuditBusyError, AuditError, _private_dir, _write_json, utc_now
from analysis_core.public_audit import (
    PublicDocument,
    PublicSchema,
    build_public_audit,
    document_bytes,
    document_digest,
    export_public_audit,
)
from pydantic import Field, field_validator, model_validator

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
    archive_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    archive_bytes: int | None = Field(default=None, ge=1, le=8 * 1024 * 1024)

    @model_validator(mode="after")
    def archive_metadata_pair(self):
        if (self.archive_sha256 is None) != (self.archive_bytes is None):
            raise ValueError("Incomplete archive metadata")
        return self

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


def _archive_bytes(slug: str, run_id: str, release_id: str) -> bytes | None:
    name = f"{release_id}.zip"
    if internal.settings.STORAGE_TYPE == "azure_blob":
        with tempfile.TemporaryDirectory(prefix="kouchou-public-zip-") as temporary:
            path = Path(temporary) / name
            try:
                if not internal.audit_storage().download_file(f"public-audits/{slug}/{run_id}/{name}", str(path)):
                    raise OSError("Could not read audit archive")
            except FileNotFoundError:
                return None
            return _read_archive(path)
    return _read_archive(_directory(slug, run_id) / name)


def _read_archive(path: Path) -> bytes | None:
    if path.is_symlink():
        raise AuditError("Invalid archive path")
    try:
        if path.stat().st_size > 8 * 1024 * 1024:
            raise AuditError("Public archive is too large")
        return path.read_bytes()
    except FileNotFoundError:
        return None


def _check_archive(data: bytes, document: dict) -> None:
    """Check stored public archives before publishing, including retried uploads.

    Never silently replace a corrupt artifact or include internal/extra files.
    The independent Node/browser verifier remains the recipient's verifier.
    """
    payload = document_bytes(document)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if sorted(archive.namelist()) != ["audit.json", "manifest.json"]:
                raise AuditError("Unexpected files in public archive")
            if any(item.file_size > 4 * 1024 * 1024 for item in archive.infolist()):
                raise AuditError("Public archive member is too large")
            manifest = json.loads(archive.read("manifest.json"))
            if archive.read("audit.json") != payload or manifest != {
                "schema_version": 1,
                "audience": "public",
                "policy_version": document["policy_version"],
                "source_run_id": document["source_run_id"],
                "files": [{"path": "audit.json", "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)}],
                "notice": "Review required before sharing. This archive contains no proof of source-text fidelity.",
            }:
                raise AuditError("Public archive does not match the approved document")
    except (zipfile.BadZipFile, KeyError, UnicodeError, json.JSONDecodeError) as exc:
        raise AuditError("Invalid public archive") from exc


def _freeze_archive(slug: str, run_id: str, document: dict) -> tuple[str, int]:
    release_id = document_digest(document)
    directory = _directory(slug, run_id)
    _private_dir(directory)
    destination = directory / f"{release_id}.zip"
    data = _archive_bytes(slug, run_id, release_id)
    remote_exists = data is not None and internal.settings.STORAGE_TYPE == "azure_blob"
    if data is None:
        # An upload may have failed after writing a local artifact. Reuse it.
        data = _read_archive(destination)
    if data is None:
        fd, name = tempfile.mkstemp(prefix=".archive-", dir=directory)
        os.close(fd)
        temporary = Path(name)
        try:
            export_public_audit(document, temporary)
            data = temporary.read_bytes()
            _check_archive(data, document)
            # The publication lock serializes local writers. Atomic replacement
            # publishes complete bytes, never a partially written ZIP.
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
    _check_archive(data, document)
    if internal.settings.STORAGE_TYPE == "azure_blob" and not remote_exists:
        if not internal.audit_storage().upload_file(
            str(destination), f"public-audits/{slug}/{run_id}/{release_id}.zip"
        ):
            raise OSError("Could not persist public audit archive")
    return hashlib.sha256(data).hexdigest(), len(data)


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
    state = _state(slug, run_id)
    return {
        "document": document,
        "sha256": document_digest(document),
        "review_required": True,
        "publication": state.model_dump(mode="json") if state else None,
    }


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
            release = get_public_audit(slug, run_id, migrate=False)
            if current.archive_sha256 is None:
                digest, size = _freeze_archive(slug, run_id, release["document"])
                require_public_report(slug)
                current = current.model_copy(update={"archive_sha256": digest, "archive_bytes": size})
                _save_state(slug, current)
            # Idempotent approval must not claim a usable release when its
            # already-published archive has disappeared or changed.
            return download_public_audit(slug, run_id, expected_sha256)[1]
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
        archive_sha256, archive_bytes = _freeze_archive(slug, run_id, preview["document"])
        require_public_report(slug)
        state = PublicationState(
            status="published",
            source_run_id=run_id,
            release_id=expected_sha256,
            updated_at=utc_now(),
            archive_sha256=archive_sha256,
            archive_bytes=archive_bytes,
        )
        _save_state(slug, state)
        return _release(state, preview["document"])


def withdraw_public_audit(slug: str, run_id: str) -> None:
    with _publication_lock(slug):
        current = _state(slug, run_id)
        if current is None:
            raise FileNotFoundError("Audit publication not found")
        _save_state(
            slug,
            PublicationState(
                status="withdrawn",
                source_run_id=run_id,
                release_id=current.release_id,
                updated_at=utc_now(),
                archive_sha256=current.archive_sha256,
                archive_bytes=current.archive_bytes,
            ),
        )


def _release(state: PublicationState, document: dict) -> dict:
    return {
        "release_id": state.release_id,
        "published_at": state.updated_at,
        "document": document,
        "archive_sha256": state.archive_sha256,
        "archive_bytes": state.archive_bytes,
    }


def get_public_audit(slug: str, run_id: str, *, migrate: bool = True) -> dict:
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
    if state.archive_sha256 is None and migrate:
        # Upgrade a previously approved JSON release, preserving its publication
        # time and exact approved content. Never rebuild it from internal evidence.
        with _publication_lock(slug):
            release = get_public_audit(slug, run_id, migrate=False)
            current = _state(slug, run_id)
            if current is None or current.status != "published" or current.release_id != release["release_id"]:
                raise FileNotFoundError("Audit publication not found")
            if current.archive_sha256 is None:
                digest, size = _freeze_archive(slug, run_id, release["document"])
                require_public_report(slug)
                current = current.model_copy(update={"archive_sha256": digest, "archive_bytes": size})
                _save_state(slug, current)
            state, document = current, release["document"]
    require_public_report(slug)
    current = _state(slug, run_id)
    if current is None or current.status != "published" or current.release_id != state.release_id:
        raise FileNotFoundError("Audit publication changed")
    return _release(state, document)


def download_public_audit(slug: str, run_id: str, expected_release: str | None = None) -> tuple[bytes, dict]:
    release = get_public_audit(slug, run_id)
    if expected_release is not None and release["release_id"] != expected_release:
        raise PublicationConflict("The selected audit release changed; refresh the list")
    data = _archive_bytes(slug, run_id, release["release_id"])
    if data is None:
        raise AuditError("Published audit archive is unavailable")
    if len(data) != release["archive_bytes"] or hashlib.sha256(data).hexdigest() != release["archive_sha256"]:
        raise AuditError("Published audit archive failed verification")
    _check_archive(data, release["document"])
    # Withdrawal/non-public state must win even if it changed during storage I/O.
    require_public_report(slug)
    state = _state(slug, run_id)
    if state is None or state.status != "published" or state.release_id != release["release_id"]:
        raise FileNotFoundError("Audit publication changed")
    return data, release


def list_publication_states(slug: str) -> list[PublicationState]:
    """Read approval states for administrators, including hidden and withdrawn releases."""
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
    return [PublicationState.model_validate(data) for data in states]


def list_public_audits(slug: str) -> list[dict]:
    require_public_report(slug)
    result = []
    for state in list_publication_states(slug):
        if state.status == "published" and state.release_id:
            # Only approved run IDs appear; no parent IDs or private history counts.
            result.append(
                {"run_id": state.source_run_id, "release_id": state.release_id, "published_at": state.updated_at}
            )
    require_public_report(slug)
    return sorted(result, key=lambda row: row["run_id"], reverse=True)
