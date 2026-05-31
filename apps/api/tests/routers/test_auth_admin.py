from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from src.auth import CurrentUser
from src.routers import auth_admin
from src.services import sample_report


@pytest.fixture
def current_user() -> CurrentUser:
    return CurrentUser(user_id="user-1", email="admin@example.com", claims={})


@pytest.fixture
def create_request() -> auth_admin.CreateUserRequest:
    return auth_admin.CreateUserRequest(
        email="new-user@example.com",
        password="temporary-password",
        display_name="New User",
        organization_slug="org-a",
        organization_name="Org A",
        role="viewer",
    )


def _mock_supabase_requests(manager_role: str, *, platform_owner: bool = False):
    async def request_json(client, method, path, *, json=None, params=None, prefer=None):
        if path == "/rest/v1/platform_owners":
            return [{"user_id": "user-1"}] if platform_owner else []
        if path == "/rest/v1/organization_memberships":
            return [{"organization_id": "org-1", "role": manager_role}]
        if path == "/rest/v1/organizations":
            return [{"id": "org-1", "slug": "org-a", "name": "Org A"}]
        raise AssertionError(f"Unexpected Supabase request: {method} {path}")

    return request_json


@pytest.mark.asyncio
async def test_admin_can_issue_viewer_to_own_organization(monkeypatch, current_user, create_request):
    monkeypatch.setattr(auth_admin, "settings", SimpleNamespace(AUTH_ENABLED=True))
    monkeypatch.setattr(auth_admin, "_request_json", _mock_supabase_requests("admin"))

    organization = await auth_admin._require_user_manager_for_payload(object(), current_user, create_request)

    assert organization is not None
    assert organization.slug == "org-a"
    assert organization.assignable_roles == ["viewer", "creator"]


@pytest.mark.asyncio
async def test_admin_cannot_issue_admin_role(monkeypatch, current_user, create_request):
    monkeypatch.setattr(auth_admin, "settings", SimpleNamespace(AUTH_ENABLED=True))
    monkeypatch.setattr(auth_admin, "_request_json", _mock_supabase_requests("admin"))
    create_request.role = "admin"

    with pytest.raises(HTTPException) as exc_info:
        await auth_admin._require_user_manager_for_payload(object(), current_user, create_request)

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Requested role cannot be issued by your organization role"


@pytest.mark.asyncio
async def test_manager_cannot_issue_to_other_organization(monkeypatch, current_user, create_request):
    monkeypatch.setattr(auth_admin, "settings", SimpleNamespace(AUTH_ENABLED=True))
    monkeypatch.setattr(auth_admin, "_request_json", _mock_supabase_requests("owner"))
    create_request.organization_slug = "org-b"

    with pytest.raises(HTTPException) as exc_info:
        await auth_admin._require_user_manager_for_payload(object(), current_user, create_request)

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Users can only be issued into organizations you manage"


@pytest.mark.asyncio
async def test_owner_can_issue_admin_but_not_owner(monkeypatch, current_user, create_request):
    monkeypatch.setattr(auth_admin, "settings", SimpleNamespace(AUTH_ENABLED=True))
    monkeypatch.setattr(auth_admin, "_request_json", _mock_supabase_requests("owner"))
    create_request.role = "admin"

    organization = await auth_admin._require_user_manager_for_payload(object(), current_user, create_request)

    assert organization is not None
    assert organization.assignable_roles == ["viewer", "creator", "admin"]

    create_request.role = "owner"
    with pytest.raises(HTTPException) as exc_info:
        await auth_admin._require_user_manager_for_payload(object(), current_user, create_request)

    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_platform_owner_can_issue_owner_to_new_organization(monkeypatch, current_user, create_request):
    monkeypatch.setattr(auth_admin, "settings", SimpleNamespace(AUTH_ENABLED=True))
    monkeypatch.setattr(auth_admin, "_request_json", _mock_supabase_requests("admin", platform_owner=True))
    create_request.organization_slug = "new-org"
    create_request.role = "owner"

    organization = await auth_admin._require_user_manager_for_payload(object(), current_user, create_request)

    assert organization is None


@pytest.mark.asyncio
async def test_create_user_reactivates_auth_user_without_memberships(monkeypatch, current_user, create_request):
    monkeypatch.setattr(auth_admin, "settings", SimpleNamespace(AUTH_ENABLED=True))
    calls: list[tuple[str, str]] = []

    async def request_json(client, method, path, *, json=None, params=None, prefer=None):
        calls.append((method, path))
        if path == "/rest/v1/platform_owners":
            return []
        if path == "/rest/v1/organization_memberships" and method == "GET":
            if params.get("select") == "organization_id,role" and params.get("user_id") == "eq.user-1":
                return [{"organization_id": "org-1", "role": "admin"}]
            if params.get("user_id") == "eq.existing-user":
                return []
        if path == "/rest/v1/organizations":
            return [{"id": "org-1", "slug": "org-a", "name": "Org A"}]
        if path == "/auth/v1/admin/users" and method == "POST":
            raise HTTPException(status_code=409, detail="User already exists")
        if path == "/auth/v1/admin/users" and method == "GET":
            return {"users": [{"id": "existing-user", "email": "new-user@example.com"}]}
        if path == "/auth/v1/admin/users/existing-user" and method == "PUT":
            assert json == {
                "password": "temporary-password",
                "email_confirm": True,
                "user_metadata": {"display_name": "New User"},
            }
            return {"id": "existing-user", "email": "new-user@example.com"}
        if path == "/rest/v1/profiles" and method == "POST":
            return {}
        if path == "/rest/v1/organization_memberships" and method == "POST":
            assert json == {"organization_id": "org-1", "user_id": "existing-user", "role": "viewer"}
            return {}
        raise AssertionError(f"Unexpected Supabase request: {method} {path} {params}")

    monkeypatch.setattr(auth_admin, "_request_json", request_json)

    response = await auth_admin.create_user(create_request, current_user=current_user)

    assert response.user_id == "existing-user"
    assert response.organization_id == "org-1"
    assert ("PUT", "/auth/v1/admin/users/existing-user") in calls


@pytest.mark.asyncio
async def test_create_user_keeps_existing_member_as_conflict(monkeypatch, current_user, create_request):
    monkeypatch.setattr(auth_admin, "settings", SimpleNamespace(AUTH_ENABLED=True))

    async def request_json(client, method, path, *, json=None, params=None, prefer=None):
        if path == "/rest/v1/platform_owners":
            return []
        if path == "/rest/v1/organization_memberships" and method == "GET":
            if params.get("select") == "organization_id,role" and params.get("user_id") == "eq.user-1":
                return [{"organization_id": "org-1", "role": "admin"}]
            if params.get("user_id") == "eq.existing-user":
                return [{"organization_id": "org-1", "role": "viewer"}]
        if path == "/rest/v1/organizations":
            return [{"id": "org-1", "slug": "org-a", "name": "Org A"}]
        if path == "/auth/v1/admin/users" and method == "POST":
            raise HTTPException(status_code=409, detail="User already exists")
        if path == "/auth/v1/admin/users" and method == "GET":
            return {"users": [{"id": "existing-user", "email": "new-user@example.com"}]}
        raise AssertionError(f"Unexpected Supabase request: {method} {path} {params}")

    monkeypatch.setattr(auth_admin, "_request_json", request_json)

    with pytest.raises(HTTPException) as exc_info:
        await auth_admin.create_user(create_request, current_user=current_user)

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == "User already exists"


@pytest.mark.asyncio
async def test_create_users_batch_returns_row_results(monkeypatch, current_user, create_request):
    monkeypatch.setattr(auth_admin, "settings", SimpleNamespace(AUTH_ENABLED=True))
    membership_calls: list[dict] = []

    async def request_json(client, method, path, *, json=None, params=None, prefer=None):
        if path == "/rest/v1/platform_owners":
            return []
        if path == "/rest/v1/organization_memberships" and method == "GET":
            if params.get("select") == "organization_id,role" and params.get("user_id") == "eq.user-1":
                return [{"organization_id": "org-1", "role": "admin"}]
        if path == "/rest/v1/organizations":
            return [{"id": "org-1", "slug": "org-a", "name": "Org A"}]
        if path == "/auth/v1/admin/users" and method == "POST":
            return {"id": f"user-{json['email'].split('@')[0]}", "email": json["email"]}
        if path == "/rest/v1/profiles" and method == "POST":
            return {}
        if path == "/rest/v1/organization_memberships" and method == "POST":
            membership_calls.append(json)
            return {}
        raise AssertionError(f"Unexpected Supabase request: {method} {path} {params}")

    monkeypatch.setattr(auth_admin, "_request_json", request_json)
    payload = auth_admin.BatchCreateUsersRequest(
        users=[
            create_request.model_dump(),
            {**create_request.model_dump(), "email": "owner@example.com", "role": "owner"},
        ]
    )

    response = await auth_admin.create_users_batch(payload, current_user=current_user)

    assert len(response.results) == 2
    assert response.results[0].success is True
    assert response.results[0].user is not None
    assert response.results[0].user.email == "new-user@example.com"
    assert response.results[1].success is False
    assert response.results[1].error == "Requested role cannot be issued by your organization role"
    assert membership_calls == [{"organization_id": "org-1", "user_id": "user-new-user", "role": "viewer"}]


@pytest.mark.asyncio
async def test_platform_owner_seeds_sample_report_for_existing_organization(monkeypatch, current_user, create_request):
    monkeypatch.setattr(auth_admin, "settings", SimpleNamespace(AUTH_ENABLED=True))
    sample_calls: list[dict] = []

    async def request_json(client, method, path, *, json=None, params=None, prefer=None):
        if path == "/rest/v1/platform_owners":
            return [{"user_id": "user-1"}]
        if path == "/rest/v1/organizations":
            return [{"id": "org-1", "slug": "org-a", "name": "Org A"}]
        if path == "/auth/v1/admin/users" and method == "POST":
            return {"id": "new-user", "email": "new-user@example.com"}
        if path == "/rest/v1/profiles" and method == "POST":
            return {}
        if path == "/rest/v1/organization_memberships" and method == "POST":
            return {}
        raise AssertionError(f"Unexpected Supabase request: {method} {path} {params}")

    async def ensure_sample_report(client, organization, current_user):
        sample_calls.append(organization)
        return "org-a-sample-report"

    monkeypatch.setattr(auth_admin, "_request_json", request_json)
    monkeypatch.setattr(auth_admin, "ensure_sample_report_for_organization", ensure_sample_report)

    response = await auth_admin.create_user(create_request, current_user=current_user)

    assert response.user_id == "new-user"
    assert sample_calls == [{"id": "org-1", "slug": "org-a", "name": "Org A"}]


@pytest.mark.asyncio
async def test_sample_report_is_registered_for_new_organization(monkeypatch, tmp_path, current_user):
    report_dir = tmp_path / "outputs"
    source_dir = report_dir / sample_report.SAMPLE_SOURCE_SLUG
    source_dir.mkdir(parents=True)
    (source_dir / "hierarchical_result.json").write_text(
        '{"config":{"question":"sample"},"overview":"sample overview","clusters":[],"arguments":[]}',
        encoding="utf-8",
    )
    monkeypatch.setattr(sample_report.settings, "REPORT_DIR", report_dir)
    monkeypatch.setattr(sample_report.settings, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(sample_report.settings, "RETENTION_DAYS", 30)

    upsert_calls: list[dict] = []

    async def request_json(client, method, path, *, json=None, params=None, prefer=None):
        upsert_calls.append({"method": method, "path": path, "json": json, "params": params, "prefer": prefer})
        return {}

    monkeypatch.setattr(sample_report, "request_supabase_json", request_json)

    slug = await sample_report.ensure_sample_report_for_organization(
        object(),
        {"id": "org-1", "slug": "org-a", "name": "Org A"},
        current_user,
    )

    assert slug == "org-a-sample-report"
    assert (report_dir / slug / "hierarchical_result.json").exists()
    assert upsert_calls == [
        {
            "method": "POST",
            "path": "/rest/v1/reports",
            "json": {
                "slug": "org-a-sample-report",
                "organization_id": "org-1",
                "created_by": "user-1",
                "title": "Org A サンプルレポート",
                "status": "ready",
                "visibility": "public",
                "artifact_path": "reports/org-a-sample-report/hierarchical_result.json",
                "retention_expires_at": upsert_calls[0]["json"]["retention_expires_at"],
                "purge_status": "active",
            },
            "params": {"on_conflict": "slug"},
            "prefer": "resolution=merge-duplicates",
        }
    ]


@pytest.mark.asyncio
async def test_current_user_access_marks_viewer_only(monkeypatch, current_user):
    monkeypatch.setattr(auth_admin, "settings", SimpleNamespace(AUTH_ENABLED=True))

    async def request_json(client, method, path, *, json=None, params=None, prefer=None):
        if path == "/rest/v1/platform_owners":
            return []
        if path == "/rest/v1/organization_memberships":
            return [{"role": "viewer"}]
        raise AssertionError(f"Unexpected Supabase request: {method} {path}")

    monkeypatch.setattr(auth_admin, "_request_json", request_json)

    response = await auth_admin.get_current_user_access(current_user=current_user)

    assert response.platform_owner is False
    assert response.roles == ["viewer"]
    assert response.viewer_only is True


@pytest.mark.asyncio
async def test_current_user_access_does_not_mark_creator_as_viewer_only(monkeypatch, current_user):
    monkeypatch.setattr(auth_admin, "settings", SimpleNamespace(AUTH_ENABLED=True))

    async def request_json(client, method, path, *, json=None, params=None, prefer=None):
        if path == "/rest/v1/platform_owners":
            return []
        if path == "/rest/v1/organization_memberships":
            return [{"role": "creator"}]
        raise AssertionError(f"Unexpected Supabase request: {method} {path}")

    monkeypatch.setattr(auth_admin, "_request_json", request_json)

    response = await auth_admin.get_current_user_access(current_user=current_user)

    assert response.roles == ["creator"]
    assert response.viewer_only is False


@pytest.mark.asyncio
async def test_admin_can_delete_viewer_from_own_organization(monkeypatch, current_user):
    monkeypatch.setattr(auth_admin, "settings", SimpleNamespace(AUTH_ENABLED=True))
    delete_calls: list[tuple[str, str]] = []

    async def request_json(client, method, path, *, json=None, params=None, prefer=None):
        if path == "/rest/v1/platform_owners":
            return []
        if path == "/rest/v1/organization_memberships" and method == "GET":
            if params.get("organization_id") == "eq.org-1":
                return [{"organization_id": "org-1", "user_id": "user-2", "role": "viewer"}]
            if params.get("user_id") == "eq.user-2":
                return []
            return [{"organization_id": "org-1", "role": "admin"}]
        if path == "/rest/v1/organizations":
            return [{"id": "org-1", "slug": "org-a", "name": "Org A"}]
        if method == "DELETE":
            delete_calls.append((method, path))
            return {}
        raise AssertionError(f"Unexpected Supabase request: {method} {path}")

    monkeypatch.setattr(auth_admin, "_request_json", request_json)

    response = await auth_admin.delete_user("user-2", "org-a", current_user=current_user)

    assert response.user_id == "user-2"
    assert response.organization_slug == "org-a"
    assert response.auth_user_deleted is True
    assert ("DELETE", "/rest/v1/organization_memberships") in delete_calls
    assert ("DELETE", "/auth/v1/admin/users/user-2") in delete_calls


@pytest.mark.asyncio
async def test_admin_cannot_delete_admin_role(monkeypatch, current_user):
    monkeypatch.setattr(auth_admin, "settings", SimpleNamespace(AUTH_ENABLED=True))

    async def request_json(client, method, path, *, json=None, params=None, prefer=None):
        if path == "/rest/v1/platform_owners":
            return []
        if path == "/rest/v1/organization_memberships":
            if params.get("organization_id") == "eq.org-1":
                return [{"organization_id": "org-1", "user_id": "user-2", "role": "admin"}]
            return [{"organization_id": "org-1", "role": "admin"}]
        if path == "/rest/v1/organizations":
            return [{"id": "org-1", "slug": "org-a", "name": "Org A"}]
        raise AssertionError(f"Unexpected Supabase request: {method} {path}")

    monkeypatch.setattr(auth_admin, "_request_json", request_json)

    with pytest.raises(HTTPException) as exc_info:
        await auth_admin.delete_user("user-2", "org-a", current_user=current_user)

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Requested user cannot be deleted by your organization role"
