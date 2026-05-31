from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from src.auth import CurrentUser
from src.routers import auth_admin


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
