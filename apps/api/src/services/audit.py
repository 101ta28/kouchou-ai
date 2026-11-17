"""Private audit persistence. Never put audit files under the public outputs prefix."""

import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path

from analysis_core.audit import AuditSession, AuditStore, sha256

from src.config import settings
from src.services.storage import AzureBlobStorageService, LocalStorageService


def audit_storage():
    if settings.STORAGE_TYPE == "azure_blob":
        return AzureBlobStorageService(
            container_name=settings.AZURE_AUDIT_CONTAINER_NAME,
            require_private=True,
        )
    return LocalStorageService()


def store_for(slug: str) -> AuditStore:
    from src.utils.slug_utils import validate_slug

    validate_slug(slug)
    return AuditStore(settings.REPORT_DIR / slug)


def _sync_marker(directory: Path) -> str:
    metadata = directory / "manifest.json"
    if not metadata.exists():
        metadata = directory / "started.json"
    return json.dumps(
        {
            "storage": settings.STORAGE_TYPE,
            "account": getattr(settings, "AZURE_BLOB_STORAGE_ACCOUNT_NAME", None),
            "container": settings.AZURE_AUDIT_CONTAINER_NAME
            or getattr(settings, "AZURE_BLOB_STORAGE_CONTAINER_NAME", None),
            "metadata_sha256": sha256(metadata),
        },
        sort_keys=True,
    )


def _mark_synced(directory: Path) -> None:
    fd = os.open(directory / ".synced", os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(_sync_marker(directory))


def restore_audit_index(slug: str) -> AuditStore:
    store = store_for(slug)
    if settings.STORAGE_TYPE == "azure_blob":
        store.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        store.root.chmod(0o700)
        store.path.mkdir(exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix=".index-", dir=store.root) as temporary:
            try:
                restored = audit_storage().download_directory(
                    f"audits/{slug}", temporary, target_suffixes=("/manifest.json", "/started.json")
                )
                if not restored:
                    raise OSError("Could not restore private audit index")
            except FileNotFoundError:
                return store  # Reports created before auditing have no history.
            imported = set()
            for path in Path(temporary).glob("*/*.json"):
                directory = store.record_dir(path.parent.name)
                directory.mkdir(exist_ok=True, mode=0o700)
                target = store.file(path.parent.name, path.name)
                # Never overwrite locally active or completed evidence with a remote copy.
                if not target.exists():
                    path.chmod(0o600)
                    os.replace(path, target)
                    imported.add(target)
            for directory in {path.parent for path in imported}:
                metadata = directory / "manifest.json"
                if not metadata.exists():
                    metadata = directory / "started.json"
                # Importing an older started.json must not mark a local final
                # manifest as uploaded when the remote has never received it.
                if metadata in imported:
                    _mark_synced(directory)
        _restrict_permissions(store.path)
    return store


def _restrict_permissions(root: Path) -> None:
    root.chmod(0o700)
    for directory, _, files in os.walk(root):
        Path(directory).chmod(0o700)
        for name in files:
            (Path(directory) / name).chmod(0o600)


def sync_audit_to_storage(slug: str) -> bool:
    store = store_for(slug)
    if not store.path.exists():
        return True
    storage = audit_storage()
    success = True
    for record in store.list_records():
        run_id = record["run_id"]
        directory = store.record_dir(run_id)
        marker = directory / ".synced"
        if marker.exists() and marker.read_text(encoding="utf-8") == _sync_marker(directory):
            continue
        # Upload the manifest last, so it never promises unavailable snapshots.
        names = [item["path"] for item in record["files"]] + ["started.json"]
        if (directory / "manifest.json").exists():
            names.append("manifest.json")
        uploaded = True
        for name in names:
            source = store.file(run_id, name)
            if not source.exists():
                uploaded = False
                break
            if not storage.upload_file(str(source), f"audits/{slug}/{run_id}/{name}"):
                uploaded = False
                break
        if uploaded:
            _mark_synced(directory)
        success = success and uploaded
    return success


def restore_audit_files(slug: str, run_id: str) -> AuditStore:
    store = restore_audit_index(slug)
    record = store.read(run_id)
    if settings.STORAGE_TYPE == "local":
        return store
    storage = audit_storage()
    for item in record["files"]:
        target = store.file(run_id, item["path"])
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                if (
                    not storage.download_file(f"audits/{slug}/{run_id}/{item['path']}", str(target))
                    or not target.exists()
                ):
                    raise OSError("Could not restore audit evidence")
            except FileNotFoundError:
                # Let verify identify missing evidence individually. Export
                # will still fail rather than produce an incomplete bundle.
                continue
    _restrict_permissions(store.record_dir(run_id))
    return store


@contextmanager
def audit_edit(slug: str, kind: str):
    """Archive before/after states around an existing authenticated edit."""
    store = restore_audit_index(slug)
    config_path = settings.CONFIG_DIR / f"{slug}.json"
    entered = False
    try:
        with AuditSession(store.report_dir, kind) as session:
            entered = True
            if config_path.exists():
                session.config = json.loads(config_path.read_text(encoding="utf-8"))
                session.write_data("config.json", session.config)
                session.snapshot(config_path, "before/report_config.json")
            yield session
            if config_path.exists():
                session.snapshot(config_path, "after/report_config.json")
                session.config = json.loads(config_path.read_text(encoding="utf-8"))
    finally:
        if entered and not sync_audit_to_storage(slug):
            raise OSError("Failed to persist private audit evidence")
