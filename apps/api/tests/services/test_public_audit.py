import hashlib
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


@pytest.mark.asyncio
async def test_admin_history_shows_publication_states_for_hidden_reports(publication, monkeypatch):
    from src.routers import admin_report
    from src.routers.audit import public_router, router

    settings, run_id, report = publication
    monkeypatch.setattr(admin_report, "settings", settings)
    app = FastAPI()
    app.include_router(router)
    app.include_router(public_router)
    base = "/admin/reports/report/audit"
    headers = {"x-api-key": settings.ADMIN_API_KEY}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get(base)).status_code == 401
        assert (await client.get(base, headers={"x-api-key": "public-key"})).status_code == 401
        initial = await client.get(base, headers=headers)
        assert initial.headers["cache-control"] == "no-store"
        assert initial.json()["records"][0]["publication"] is None
        release = _publish(run_id)
        report.visibility = ReportVisibility.UNLISTED
        assert (await client.get("/reports/report/audit")).status_code == 404
        listed = (await client.get(base, headers=headers)).json()
        assert listed["records"][0]["publication"]["release_id"] == release["release_id"]
        assert listed["records"][0]["publication"]["status"] == "published"
        assert "private resident name" not in json.dumps(listed)
        preview = (await client.get(f"{base}/{run_id}/public-preview", headers=headers)).json()
        assert preview["publication"]["status"] == "published"
        public_audit.withdraw_public_audit("report", run_id)
        withdrawn = (await client.get(base, headers=headers)).json()
        assert withdrawn["records"][0]["publication"]["status"] == "withdrawn"
        assert public_audit.preview_public_audit("report", run_id)["publication"]["status"] == "withdrawn"


def test_recommended_analysis_is_selected_from_all_pages(publication):
    from src.routers.audit import list_audit

    settings, run_id, _ = publication
    with AuditSession(settings.REPORT_DIR / "report", "visibility_edit"):
        pass
    result = list_audit("report", limit=1, offset=0)
    assert result["total"] == 2
    assert result["records"][0]["kind"] == "visibility_edit"
    assert result["recommended_record"]["run_id"] == run_id
    assert result["recommended_record"]["publication"] is None


def test_admin_publication_states_are_refreshed_from_azure(publication, monkeypatch):
    settings, run_id, report = publication
    settings.STORAGE_TYPE = "azure_blob"
    storage = MemoryStorage()
    monkeypatch.setattr(internal, "audit_storage", lambda: storage)
    assert internal.sync_audit_to_storage("report")
    _publish(run_id)
    report.visibility = ReportVisibility.PRIVATE
    assert public_audit.list_publication_states("report")[0].status == "published"
    public_audit.withdraw_public_audit("report", run_id)
    assert public_audit.list_publication_states("report")[0].status == "withdrawn"


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


@pytest.mark.parametrize("failure", ["state.json", "/events/", ".json", ".zip"])
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
        assert (await client.get(f"{public}/{run_id}/download")).content == downloaded.content
        row = (await client.get(public)).json()["records"][0]
        assert row["archive_sha256"] == hashlib.sha256(downloaded.content).hexdigest()
        assert row["archive_bytes"] == len(downloaded.content)
        assert row["kind"] == "analysis" and row["started_at"]
        assert "document" not in row
        assert downloaded.headers["x-audit-archive-sha256"] == row["archive_sha256"]
        assert (await client.get(f"{public}/{run_id}/download?release_id={'0' * 64}")).status_code == 409
        assert (
            await client.get(f"{public}/{run_id}/download?release_id={row['release_id']}")
        ).content == downloaded.content
        assert (await client.get(admin + "/download")).status_code == 401
        report.visibility = ReportVisibility.PRIVATE
        assert (await client.get(public)).status_code == 404
        assert (await client.get(f"{public}/{run_id}/download")).status_code == 404
        report.visibility = ReportVisibility.PUBLIC
        assert (await client.delete(admin + "/publication", headers=headers)).status_code == 204
        assert (await client.get(f"{public}/{run_id}")).status_code == 404
        assert (await client.get(f"{public}/{run_id}/download")).status_code == 404


def test_zip_is_frozen_and_not_regenerated_on_download(publication, monkeypatch):
    settings, run_id, _ = publication
    release = _publish(run_id)
    path = AuditStore(settings.REPORT_DIR / "report").path / "publications" / run_id / f"{release['release_id']}.zip"
    expected = path.read_bytes()
    monkeypatch.setattr(public_audit, "export_public_audit", lambda *args: pytest.fail("Must use stored ZIP"))
    assert public_audit.download_public_audit("report", run_id)[0] == expected
    assert _publish(run_id) == release


@pytest.mark.parametrize("corruption", ["missing", "tampered"])
def test_missing_or_changed_published_zip_is_rejected(publication, corruption):
    settings, run_id, _ = publication
    release = _publish(run_id)
    path = AuditStore(settings.REPORT_DIR / "report").path / "publications" / run_id / f"{release['release_id']}.zip"
    if corruption == "missing":
        path.unlink()
    else:
        data = bytearray(path.read_bytes())
        data[-1] ^= 1
        path.write_bytes(data)
    with pytest.raises(public_audit.AuditError):
        public_audit.download_public_audit("report", run_id)
    with pytest.raises(public_audit.AuditError):
        _publish(run_id)


@pytest.mark.parametrize("through_publish", [False, True])
def test_legacy_publication_freezes_approved_document_preserving_time(publication, monkeypatch, through_publish):
    settings, run_id, _ = publication
    preview = public_audit.preview_public_audit("report", run_id)
    directory = AuditStore(settings.REPORT_DIR / "report").path / "publications" / run_id
    directory.mkdir(parents=True)
    published_at = "2026-01-01T00:00:00+00:00"
    (directory / f"{preview['sha256']}.json").write_text(json.dumps(preview["document"]))
    (directory / "state.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "source_run_id": run_id,
                "status": "published",
                "release_id": preview["sha256"],
                "updated_at": published_at,
            }
        )
    )
    if not through_publish:
        monkeypatch.setattr(
            public_audit, "preview_public_audit", lambda *args: pytest.fail("Do not rebuild approved content")
        )
    release = _publish(run_id) if through_publish else public_audit.get_public_audit("report", run_id)
    data, _ = public_audit.download_public_audit("report", run_id)
    assert release["published_at"] == published_at
    assert release["archive_sha256"] == hashlib.sha256(data).hexdigest()
    assert release["document"] == preview["document"]


def test_withdrawal_during_download_wins(publication, monkeypatch):
    _, run_id, _ = publication
    _publish(run_id)
    original = public_audit._archive_bytes

    def withdraw_after_read(*args):
        data = original(*args)
        public_audit.withdraw_public_audit("report", run_id)
        return data

    monkeypatch.setattr(public_audit, "_archive_bytes", withdraw_after_read)
    with pytest.raises(FileNotFoundError):
        public_audit.download_public_audit("report", run_id)


def test_azure_archive_is_read_from_remote_after_restart(publication, monkeypatch, tmp_path):
    settings, run_id, status = publication
    settings.STORAGE_TYPE = "azure_blob"
    storage = MemoryStorage()
    monkeypatch.setattr(internal, "audit_storage", lambda: storage)
    assert internal.sync_audit_to_storage("report")
    release = _publish(run_id)
    expected, _ = public_audit.download_public_audit("report", run_id)
    monkeypatch.setenv("KOUCHOU_AUDIT_DIR", str(tmp_path / "restarted"))
    assert public_audit.download_public_audit("report", run_id)[0] == expected
    blob = f"public-audits/report/{run_id}/{release['release_id']}.zip"
    storage.blobs[blob] = b"tampered"
    with pytest.raises(public_audit.AuditError):
        public_audit.download_public_audit("report", run_id)


def test_private_report_during_archive_generation_is_not_published(publication, monkeypatch):
    _, run_id, status = publication
    original = public_audit._freeze_archive

    def make_private(*args):
        result = original(*args)
        status.visibility = ReportVisibility.PRIVATE
        return result

    monkeypatch.setattr(public_audit, "_freeze_archive", make_private)
    with pytest.raises(FileNotFoundError):
        _publish(run_id)
    status.visibility = ReportVisibility.PUBLIC
    assert public_audit.list_public_audits("report") == []
