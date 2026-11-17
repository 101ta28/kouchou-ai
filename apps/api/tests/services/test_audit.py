import io
import json
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from analysis_core.audit import AuditSession, AuditStore
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.services import audit


@pytest.fixture
def environment(tmp_path, monkeypatch):
    settings = SimpleNamespace(
        REPORT_DIR=tmp_path / "outputs",
        CONFIG_DIR=tmp_path / "configs",
        STORAGE_TYPE="local",
        AZURE_AUDIT_CONTAINER_NAME=None,
        ADMIN_API_KEY="audit-admin",
        PUBLIC_API_KEY="public-key",
    )
    monkeypatch.delenv("KOUCHOU_AUDIT_DIR", raising=False)
    monkeypatch.setattr(audit, "settings", settings)
    (settings.REPORT_DIR / "report").mkdir(parents=True)
    settings.CONFIG_DIR.mkdir()
    return settings


class MemoryStorage:
    def __init__(self):
        self.blobs = {}
        self.uploads = []
        self.fail = None

    def upload_file(self, local, remote):
        self.uploads.append(remote)
        if self.fail and self.fail in remote:
            return False
        self.blobs[remote] = Path(local).read_bytes()
        return True

    def download_file(self, remote, local):
        if remote not in self.blobs:
            raise FileNotFoundError(remote)
        path = Path(local)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.blobs[remote])
        return True

    def download_directory(self, prefix, local, target_suffixes):
        matched = [name for name in self.blobs if name.startswith(prefix + "/") and name.endswith(target_suffixes)]
        if not matched:
            raise FileNotFoundError(prefix)
        for name in matched:
            self.download_file(name, Path(local) / name[len(prefix) + 1 :])
        return True


def test_private_storage_roundtrip_and_lazy_restore(environment, monkeypatch, tmp_path):
    storage = MemoryStorage()
    environment.STORAGE_TYPE = "azure_blob"
    monkeypatch.setattr(audit, "audit_storage", lambda: storage)
    report = environment.REPORT_DIR / "report"
    with AuditSession(report, "analysis", {"model": "example"}) as session:
        (report / "public_result.json").write_text('{"overview":"test"}')
    assert audit.sync_audit_to_storage("report")
    assert storage.uploads[-1].endswith("/manifest.json")
    assert all(name.startswith("audits/report/") for name in storage.uploads)
    count = len(storage.uploads)
    assert audit.sync_audit_to_storage("report")
    assert len(storage.uploads) == count

    monkeypatch.setenv("KOUCHOU_AUDIT_DIR", str(tmp_path / "restored"))
    store = audit.restore_audit_index("report")
    assert store.read(session.run_id)["status"] == "completed"
    assert not store.file(session.run_id, "after/public_result.json").exists()
    store = audit.restore_audit_files("report", session.run_id)
    assert store.verify(session.run_id)["valid"]
    assert json.loads(store.file(session.run_id, "config.json").read_text())["model"] == "example"


def test_failed_snapshot_upload_does_not_publish_manifest(environment, monkeypatch):
    storage = MemoryStorage()
    storage.fail = "config.json"
    monkeypatch.setattr(audit, "audit_storage", lambda: storage)
    with AuditSession(environment.REPORT_DIR / "report", "analysis") as session:
        pass
    assert not audit.sync_audit_to_storage("report")
    assert not any(name.endswith("/manifest.json") for name in storage.blobs)
    assert not (session.directory / ".synced").exists()


def test_storage_refuses_anonymous_container(monkeypatch):
    from src.services import storage

    client = MagicMock()
    client.get_container_client.return_value.get_container_properties.return_value = {"public_access": "blob"}
    monkeypatch.setattr(storage, "BlobServiceClient", MagicMock(return_value=client))
    monkeypatch.setattr(storage, "DefaultAzureCredential", MagicMock())
    with pytest.raises(ValueError, match="anonymous access disabled"):
        storage.AzureBlobStorageService(container_name="audit", require_private=True)
    client.get_container_client.assert_called_once_with("audit")


def test_label_edit_preserves_both_versions(environment, monkeypatch):
    from src.repositories import cluster_repository
    from src.schemas.cluster import ClusterUpdate

    monkeypatch.setattr(cluster_repository, "settings", environment)
    labels = environment.REPORT_DIR / "report" / "hierarchical_merge_labels.csv"
    labels.write_text("id,label,description\nc1,old,before\n")
    assert cluster_repository.ClusterRepository("report").update_csv(
        ClusterUpdate(id="c1", label="new", description="after")
    )
    store = AuditStore(labels.parent)
    record = store.list_records()[0]
    assert record["kind"] == "cluster_label_edit"
    assert "old" in store.file(record["run_id"], "before/hierarchical_merge_labels.csv").read_text()
    assert "new" in store.file(record["run_id"], "after/hierarchical_merge_labels.csv").read_text()


def test_audit_failure_prevents_ready(environment, monkeypatch):
    from src.services import report_launcher

    sync = MagicMock()
    sync.sync_audit_to_storage.return_value = False
    sync.sync_report_files_to_storage.return_value = True
    sync.sync_input_file_to_storage.return_value = True
    sync.sync_config_file_to_storage.return_value = True
    monkeypatch.setattr(report_launcher, "ReportSyncService", lambda: sync)
    update = MagicMock()
    monkeypatch.setattr(report_launcher, "set_status_unless_deleted", update)
    monkeypatch.setattr(report_launcher, "_ensure_error_status_payload", MagicMock())
    report_launcher._settle_completed_report("report")
    update.assert_called_once_with("report", "error")


def test_index_restore_never_overwrites_local_records(environment, monkeypatch):
    storage = MemoryStorage()
    monkeypatch.setattr(audit, "audit_storage", lambda: storage)
    with AuditSession(environment.REPORT_DIR / "report", "analysis") as session:
        pass
    assert audit.sync_audit_to_storage("report")
    original = (session.directory / "manifest.json").read_bytes()
    storage.blobs[f"audits/report/{session.run_id}/manifest.json"] = b'{"status":"older"}'
    environment.STORAGE_TYPE = "azure_blob"
    audit.restore_audit_index("report")
    assert (session.directory / "manifest.json").read_bytes() == original


def test_changing_storage_does_not_skip_previous_local_records(environment, monkeypatch):
    storage = MemoryStorage()
    with AuditSession(environment.REPORT_DIR / "report", "analysis"):
        pass
    assert audit.sync_audit_to_storage("report")  # local no-op must not count as an Azure upload
    environment.STORAGE_TYPE = "azure_blob"
    monkeypatch.setattr(audit, "audit_storage", lambda: storage)
    assert audit.sync_audit_to_storage("report")
    assert any(name.endswith("manifest.json") for name in storage.blobs)


def test_importing_stale_started_record_does_not_mark_local_final_as_synced(environment, monkeypatch):
    storage = MemoryStorage()
    environment.STORAGE_TYPE = "azure_blob"
    monkeypatch.setattr(audit, "audit_storage", lambda: storage)
    with AuditSession(environment.REPORT_DIR / "report", "analysis") as session:
        pass
    started = session.directory / "started.json"
    storage.blobs[f"audits/report/{session.run_id}/started.json"] = started.read_bytes()
    started.unlink()
    audit.restore_audit_index("report")
    assert not (session.directory / ".synced").exists()
    assert audit.sync_audit_to_storage("report")
    assert f"audits/report/{session.run_id}/manifest.json" in storage.blobs


def test_restored_incomplete_record_does_not_block_new_sync(environment, monkeypatch, tmp_path):
    storage = MemoryStorage()
    environment.STORAGE_TYPE = "azure_blob"
    monkeypatch.setattr(audit, "audit_storage", lambda: storage)
    with AuditSession(environment.REPORT_DIR / "report", "analysis") as session:
        pass
    (session.directory / "manifest.json").unlink()  # emulate persisted evidence after a killed process
    assert audit.sync_audit_to_storage("report")
    monkeypatch.setenv("KOUCHOU_AUDIT_DIR", str(tmp_path / "restored"))
    store = audit.restore_audit_index("report")
    assert store.read(session.run_id)["status"] == "incomplete"
    assert not store.file(session.run_id, "config.json").exists()
    with AuditSession(environment.REPORT_DIR / "report", "analysis") as next_session:
        pass
    assert audit.sync_audit_to_storage("report")
    assert f"audits/report/{next_session.run_id}/manifest.json" in storage.blobs


def test_remote_missing_evidence_is_reported(environment, monkeypatch, tmp_path):
    storage = MemoryStorage()
    environment.STORAGE_TYPE = "azure_blob"
    monkeypatch.setattr(audit, "audit_storage", lambda: storage)
    with AuditSession(environment.REPORT_DIR / "report", "analysis") as session:
        pass
    assert audit.sync_audit_to_storage("report")
    del storage.blobs[f"audits/report/{session.run_id}/config.json"]
    monkeypatch.setenv("KOUCHOU_AUDIT_DIR", str(tmp_path / "restored"))
    store = audit.restore_audit_files("report", session.run_id)
    assert {"path": "config.json", "reason": "missing"} in store.verify(session.run_id)["failures"]


def test_config_edit_keeps_original_and_redacts_credentials(environment, monkeypatch):
    from src.repositories import config_repository
    from src.schemas.report_config import ReportConfigUpdate

    monkeypatch.setattr(config_repository, "settings", environment)
    config = environment.CONFIG_DIR / "report.json"
    config.write_text(json.dumps({"question": "original", "user_api_key": "private-test-key"}))
    assert config_repository.ConfigRepository("report").update_json(ReportConfigUpdate(question="updated"))
    store = AuditStore(environment.REPORT_DIR / "report")
    record = store.list_records()[0]
    assert record["kind"] == "config_edit"
    before = store.file(record["run_id"], "before/report_config.json").read_text()
    after = store.file(record["run_id"], "after/report_config.json").read_text()
    assert "original" in before and "updated" in after
    assert "private-test-key" not in before + after
    assert json.loads(store.file(record["run_id"], "final_config.json").read_text())["question"] == "updated"


def test_missing_local_evidence_is_reported_by_verifier(environment):
    with AuditSession(environment.REPORT_DIR / "report", "analysis") as session:
        pass
    (session.directory / "config.json").unlink()
    store = audit.restore_audit_files("report", session.run_id)
    assert {"path": "config.json", "reason": "missing"} in store.verify(session.run_id)["failures"]


def test_admin_authentication_download_and_no_public_route(environment, monkeypatch):
    from src.routers import admin_report
    from src.routers.audit import router

    monkeypatch.setattr(admin_report, "settings", environment)
    with AuditSession(environment.REPORT_DIR / "report", "analysis", {"prompt": "private prompt"}) as session:
        pass
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    base = "/admin/reports/report/audit"
    assert client.get(base).status_code == 401
    assert client.get(base, headers={"x-api-key": "public-key"}).status_code == 401
    headers = {"x-api-key": "audit-admin"}
    listed = client.get(base, headers=headers)
    assert listed.status_code == 200
    assert listed.headers["cache-control"] == "no-store"
    assert listed.json()["records"][0]["run_id"] == session.run_id
    response = client.get(f"{base}/{session.run_id}/download", headers=headers)
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert json.loads(archive.read("config.json"))["prompt"] == "private prompt"
    assert client.get(f"/reports/report/audit/{session.run_id}").status_code == 404
    assert client.get(f"{base}/invalid-id", headers=headers).status_code == 400
    assert client.get(f"{base}/{session.run_id}/verify", headers=headers).json()["valid"]
