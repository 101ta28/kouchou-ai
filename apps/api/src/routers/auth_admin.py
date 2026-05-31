import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from src.auth import CurrentUser, get_current_user, verify_admin_api_key
from src.config import settings

router = APIRouter()
current_user_dependency = Depends(get_current_user)


class CreateUserRequest(BaseModel):
    email: str
    password: str = Field(min_length=8)
    display_name: str = Field(min_length=1)
    organization_slug: str = Field(min_length=1, pattern=r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
    organization_name: str | None = None
    role: str = Field(pattern=r"^(owner|admin|creator|viewer)$")

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if "@" not in normalized or normalized.startswith("@") or normalized.endswith("@"):
            raise ValueError("Invalid email address")
        return normalized


class CreatedUserResponse(BaseModel):
    user_id: str
    email: str
    organization_id: str
    organization_slug: str
    role: str


class ManageableOrganizationResponse(BaseModel):
    id: str
    slug: str
    name: str
    role: str
    assignable_roles: list[str]


class UserManagementContextResponse(BaseModel):
    organizations: list[ManageableOrganizationResponse]


def _supabase_headers() -> dict[str, str]:
    if not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
        raise HTTPException(status_code=500, detail="Supabase service role configuration is missing")

    return {
        "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }


def _supabase_base_url() -> str:
    if not settings.SUPABASE_URL:
        raise HTTPException(status_code=500, detail="SUPABASE_URL is not configured")
    return settings.SUPABASE_URL.rstrip("/")


async def _request_json(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    json: object | None = None,
    params: dict[str, str] | None = None,
    prefer: str | None = None,
) -> object:
    headers = _supabase_headers()
    if prefer:
        headers["Prefer"] = prefer

    response = await client.request(method, f"{_supabase_base_url()}{path}", headers=headers, json=json, params=params)
    if response.status_code >= 400:
        detail = response.text
        if "already been registered" in detail or "User already registered" in detail:
            raise HTTPException(status_code=409, detail="User already exists") from None
        raise HTTPException(status_code=502, detail=f"Supabase request failed: {detail}") from None

    if response.status_code == 204 or not response.content:
        return {}
    return response.json()


def _assignable_roles_for_manager(role: str) -> list[str]:
    if role == "owner":
        return ["viewer", "creator", "admin"]
    if role == "admin":
        return ["viewer", "creator"]
    return []


async def _get_or_create_organization(client: httpx.AsyncClient, payload: CreateUserRequest) -> dict:
    organizations = await _request_json(
        client,
        "GET",
        "/rest/v1/organizations",
        params={"select": "id,slug", "slug": f"eq.{payload.organization_slug}"},
    )
    if isinstance(organizations, list) and organizations:
        return organizations[0]

    created = await _request_json(
        client,
        "POST",
        "/rest/v1/organizations",
        json={
            "slug": payload.organization_slug,
            "name": payload.organization_name or payload.organization_slug,
        },
        prefer="return=representation",
    )
    if not isinstance(created, list) or not created:
        raise HTTPException(status_code=502, detail="Failed to create organization")
    return created[0]


async def _get_manageable_organizations(
    client: httpx.AsyncClient,
    current_user: CurrentUser,
) -> list[ManageableOrganizationResponse]:
    if not settings.AUTH_ENABLED:
        return []

    memberships = await _request_json(
        client,
        "GET",
        "/rest/v1/organization_memberships",
        params={
            "select": "organization_id,role",
            "user_id": f"eq.{current_user.user_id}",
            "role": "in.(owner,admin)",
        },
    )
    if not isinstance(memberships, list) or not memberships:
        return []

    organization_ids = [membership["organization_id"] for membership in memberships if membership.get("organization_id")]
    if not organization_ids:
        return []

    organizations = await _request_json(
        client,
        "GET",
        "/rest/v1/organizations",
        params={
            "select": "id,slug,name",
            "id": f"in.({','.join(organization_ids)})",
        },
    )
    if not isinstance(organizations, list):
        return []

    organizations_by_id = {organization["id"]: organization for organization in organizations if organization.get("id")}
    manageable_organizations: list[ManageableOrganizationResponse] = []
    for membership in memberships:
        organization = organizations_by_id.get(membership.get("organization_id"))
        if not organization:
            continue

        role = membership.get("role", "")
        manageable_organizations.append(
            ManageableOrganizationResponse(
                id=organization["id"],
                slug=organization["slug"],
                name=organization["name"],
                role=role,
                assignable_roles=_assignable_roles_for_manager(role),
            )
        )

    return manageable_organizations


async def _require_user_manager_for_payload(
    client: httpx.AsyncClient,
    current_user: CurrentUser,
    payload: CreateUserRequest,
) -> ManageableOrganizationResponse | None:
    if not settings.AUTH_ENABLED:
        return None

    manageable_organizations = await _get_manageable_organizations(client, current_user)
    target_organization = next(
        (organization for organization in manageable_organizations if organization.slug == payload.organization_slug),
        None,
    )
    if target_organization is None:
        raise HTTPException(status_code=403, detail="Users can only be issued into organizations you manage")

    if payload.role not in target_organization.assignable_roles:
        raise HTTPException(status_code=403, detail="Requested role cannot be issued by your organization role")

    return target_organization


@router.get("/admin/user-management/context", response_model=UserManagementContextResponse)
async def get_user_management_context(
    api_key: str = Depends(verify_admin_api_key),
    current_user: CurrentUser = current_user_dependency,
) -> UserManagementContextResponse:
    async with httpx.AsyncClient(timeout=20) as client:
        organizations = await _get_manageable_organizations(client, current_user)
    return UserManagementContextResponse(organizations=organizations)


@router.post("/admin/users", response_model=CreatedUserResponse, status_code=201)
async def create_user(
    payload: CreateUserRequest,
    api_key: str = Depends(verify_admin_api_key),
    current_user: CurrentUser = current_user_dependency,
) -> CreatedUserResponse:
    async with httpx.AsyncClient(timeout=20) as client:
        manageable_organization = await _require_user_manager_for_payload(client, current_user, payload)

        user = await _request_json(
            client,
            "POST",
            "/auth/v1/admin/users",
            json={
                "email": payload.email,
                "password": payload.password,
                "email_confirm": True,
                "user_metadata": {"display_name": payload.display_name},
            },
        )
        if not isinstance(user, dict) or not user.get("id"):
            raise HTTPException(status_code=502, detail="Failed to create user")

        if manageable_organization is None:
            organization = await _get_or_create_organization(client, payload)
            organization_id = organization["id"]
            organization_slug = organization["slug"]
        else:
            organization_id = manageable_organization.id
            organization_slug = manageable_organization.slug

        await _request_json(
            client,
            "POST",
            "/rest/v1/profiles",
            json={"user_id": user["id"], "display_name": payload.display_name},
            prefer="resolution=merge-duplicates",
            params={"on_conflict": "user_id"},
        )
        await _request_json(
            client,
            "POST",
            "/rest/v1/organization_memberships",
            json={
                "organization_id": organization_id,
                "user_id": user["id"],
                "role": payload.role,
            },
            prefer="resolution=merge-duplicates",
            params={"on_conflict": "organization_id,user_id"},
        )

    return CreatedUserResponse(
        user_id=user["id"],
        email=payload.email,
        organization_id=organization_id,
        organization_slug=organization_slug,
        role=payload.role,
    )
