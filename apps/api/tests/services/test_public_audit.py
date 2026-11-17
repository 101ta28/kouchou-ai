import io
import json
import zipfile
from types import SimpleNamespace

import httpx
import pytest
from analysis_core.audit import AuditSession, AuditStore
from fastapi import FastAPI

from src.schemas.report import ReportStatus, ReportVisibility
from src.services import audit as internal, public_audit
from tests.services.test_audit import MemoryStorage


@pytest.fixture
def publication(tmp_path, monkeypatch):
    settings = SimpleNamespace(
        REPORT_DIR=tmp_path / "outputs",
        CONFIG_DIR=tmp_path / "configs",
        STORAGE_TYPE="local",
        AZURE_AUDIT_CONTAINER_NAME=None,
        ADMIN_API_KEY="audit-admin",
        PUBLIC_API_KEY="public-key",
    )
    monkeypatch.delenv("KOUCHOU_AUDIT_DIR", raising=False)
    monkeypatch.setattr(internal, "settings", settings)
    report = settings.REPORT_DIR / "report"
    report.mkdir(parents=True)
    with AuditSession(
        report, "analysis", {"model": "gpt-4o-mini", "provider": "openai", "question": "private resident name"}
    ) as session:
        (report / "args.csv").write_text("arg-id,argument\n1,private resident name\n")
    status = SimpleNamespace(slug="report", status=ReportStatus.READY, visibility=ReportVisibility.PUBLIC)
    monkeypatch.setattr(public_audit, "load_status_as_reports", lambda: [status])
    return settings, session.run_id, status


def _publish(run_id):
    preview = public_audit.preview_public_audit("report", run_id)
    return public_audit.publish_public_audit("report", run_id, preview["sha256"])


def test_preview_does_not_publish_and_publication_preserves_private_original(publication):
    settings, run_id, _ = publication
    store = AuditStore(settings.REPORT_DIR / "report")
    before = store.file(run_id, "manifest.json").read_bytes()
    preview = public_audit.preview_public_audit("report", run_id)
    assert preview["review_required"]
    assert public_audit.list_public_audits("report") == []
    with pytest.raises(FileNotFoundError):
        public_audit.get_public_audit("report", run_id)
    release = _publish(run_id)
    assert public_audit.get_public_audit("report", run_id) == release
    assert public_audit.list_public_audits("report")[0]["run_id"] == run_id
    assert store.file(run_id, "manifest.json").read_bytes() == before
    assert "private resident name" not in json.dumps(release)
    assert "private resident name" in store.file(run_id, "config.json").read_text()
    # Publishing an already approved digest is idempotent.
    assert _publish(run_id) == release


def test_preview_digest_prevents_publication_of_unreviewed_content(publication):
    _, run_id, _ = publication
    with pytest.raises(public_audit.PublicationConflict):
        public_audit.publish_public_audit("report", run_id, "0" * 64)
    assert public_audit.list_public_audits("report") == []


@pytest.mark.parametrize(
    "visibility,status",
    [
        (ReportVisibility.PRIVATE, ReportStatus.READY),
        (ReportVisibility.UNLISTED, ReportStatus.READY),
        (ReportVisibility.PUBLIC, ReportStatus.PROCESSING),
        (ReportVisibility.PUBLIC, ReportStatus.ERROR),
        (ReportVisibility.PUBLIC, ReportStatus.DELETED),
    ],
)
def test_visibility_and_status_are_rechecked_after_publication(publication, visibility, status):
    _, run_id, report = publication
    _publish(run_id)
    report.visibility, report.status = visibility, status
    for operation in (
        lambda: public_audit.list_public_audits("report"),
        lambda: public_audit.get_public_audit("report", run_id),
        lambda: _publish(run_id),
    ):
        with pytest.raises(FileNotFoundError):
            operation()


def test_withdrawal_keeps_originals_and_blocks_public_access(publication):
    settings, run_id, _ = publication
    _publish(run_id)
    public_audit.withdraw_public_audit("report", run_id)
    assert public_audit.list_public_audits("report") == []
    with pytest.raises(FileNotFoundError):
        public_audit.get_public_audit("report", run_id)
    assert AuditStore(settings.REPORT_DIR / "report").verify(run_id)["valid"]


def test_tampered_public_document_is_not_served(publication):
    settings, run_id, _ = publication
    release = _publish(run_id)
    directory = AuditStore(settings.REPORT_DIR / "report").path / "publications" / run_id
    path = directory / f"{release['release_id']}.json"
    data = json.loads(path.read_text())
    data["comments"] = ["private resident name"]
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        public_audit.get_public_audit("report", run_id)


def test_private_history_is_not_enumerated(publication):
    settings, run_id, _ = publication
    release = _publish(run_id)
    with AuditSession(settings.REPORT_DIR / "report", "config_edit"):
        pass
    assert len(public_audit.list_public_audits("report")) == 1
    assert public_audit.get_public_audit("report", run_id) == release


def test_azure_release_roundtrip_and_withdrawal_ignore_stale_local_state(publication, monkeypatch, tmp_path):
    settings, run_id, _ = publication
    settings.STORAGE_TYPE = "azure_blob"
    storage = MemoryStorage()
    monkeypatch.setattr(internal, "audit_storage", lambda: storage)
    assert internal.sync_audit_to_storage("report")
    release = _publish(run_id)
    assert storage.uploads[-1] == f"public-audits/report/{run_id}/state.json"
    original_root = AuditStore(settings.REPORT_DIR / "report").root
    monkeypatch.setenv("KOUCHOU_AUDIT_DIR", str(tmp_path / "new-instance"))
    assert public_audit.get_public_audit("report", run_id) == release
    assert public_audit.list_public_audits("report")[0]["run_id"] == run_id
    public_audit.withdraw_public_audit("report", run_id)
    monkeypatch.setenv("KOUCHOU_AUDIT_DIR", str(original_root))
    # This local disk still says published; the remote withdrawal must win.
    assert public_audit.list_public_audits("report") == []
    with pytest.raises(FileNotFoundError):
        public_audit.get_public_audit("report", run_id)


@pytest.mark.parametrize("failure", ["state.json", "/events/", ".json"])
def test_azure_failure_does_not_claim_success(publication, monkeypatch, failure):
    settings, run_id, _ = publication
    settings.STORAGE_TYPE = "azure_blob"
    storage = MemoryStorage()
    monkeypatch.setattr(internal, "audit_storage", lambda: storage)
    assert internal.sync_audit_to_storage("report")
    storage.fail = failure
    with pytest.raises(OSError):
        _publish(run_id)
    assert public_audit.list_public_audits("report") == []


@pytest.mark.asyncio
async def test_http_review_publish_public_download_and_withdrawal(publication, monkeypatch):
    from src.routers import admin_report
    from src.routers.audit import public_router, router

    settings, run_id, report = publication
    monkeypatch.setattr(admin_report, "settings", settings)
    app = FastAPI()
    app.include_router(router)
    app.include_router(public_router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        admin = f"/admin/reports/report/audit/{run_id}"
        public = "/reports/report/audit"
        headers = {"x-api-key": settings.ADMIN_API_KEY}
        assert (await client.get(admin + "/public-preview")).status_code == 401
        assert (await client.get(admin + "/public-preview", headers={"x-api-key": "public-key"})).status_code == 401
        preview = (await client.get(admin + "/public-preview", headers=headers)).json()
        assert (
            await client.put(admin + "/publication", json={"sha256": preview["sha256"], "reviewed": True})
        ).status_code == 401
        assert (await client.get(public)).json() == {"total": 0, "records": []}
        assert (await client.get(f"{public}/{run_id}")).status_code == 404
        for body in (
            {"sha256": preview["sha256"]},
            {"sha256": preview["sha256"], "reviewed": False},
            {"sha256": preview["sha256"], "reviewed": 1},
        ):
            assert (await client.put(admin + "/publication", headers=headers, json=body)).status_code == 422
        assert (
            await client.put(admin + "/publication", headers=headers, json={"sha256": "0" * 64, "reviewed": True})
        ).status_code == 409
        published = await client.put(
            admin + "/publication", headers=headers, json={"sha256": preview["sha256"], "reviewed": True}
        )
        assert published.status_code == 200
        response = await client.get(f"{public}/{run_id}")  # no API key for public data
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        assert "private resident name" not in response.text
        downloaded = await client.get(f"{public}/{run_id}/download")
        assert downloaded.status_code == 200 and downloaded.headers["cache-control"] == "no-store"
        with zipfile.ZipFile(io.BytesIO(downloaded.content)) as archive:
            assert set(archive.namelist()) == {"audit.json", "manifest.json"}
        assert (await client.get(admin + "/download")).status_code == 401
        report.visibility = ReportVisibility.PRIVATE
        assert (await client.get(public)).status_code == 404
        assert (await client.get(f"{public}/{run_id}/download")).status_code == 404
        report.visibility = ReportVisibility.PUBLIC
        assert (await client.delete(admin + "/publication", headers=headers)).status_code == 204
        assert (await client.get(f"{public}/{run_id}")).status_code == 404
