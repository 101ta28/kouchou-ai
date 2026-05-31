import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from src.auth import CurrentUser, get_current_user, verify_admin_api_key
from src.config import settings
from src.services.sample_report import ensure_sample_report_for_organization

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


class ManagedUserResponse(BaseModel):
    user_id: str
    email: str | None = None
    display_name: str | None = None
    organization_id: str
    organization_slug: str
    organization_name: str
    role: str
    can_delete: bool


class ManagedUsersResponse(BaseModel):
    users: list[ManagedUserResponse]


class DeletedUserResponse(BaseModel):
    user_id: str
    organization_slug: str
    auth_user_deleted: bool


class CurrentUserAccessResponse(BaseModel):
    platform_owner: bool
    roles: list[str]
    viewer_only: bool


class ManageableOrganizationResponse(BaseModel):
    id: str
    slug: str
    name: str
    role: str
    assignable_roles: list[str]


class UserManagementContextResponse(BaseModel):
    platform_owner: bool
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
    if role == "platform_owner":
        return ["viewer", "creator", "admin", "owner"]
    if role == "owner":
        return ["viewer", "creator", "admin"]
    if role == "admin":
        return ["viewer", "creator"]
    return []


async def _get_or_create_organization(client: httpx.AsyncClient, payload: CreateUserRequest) -> tuple[dict, bool]:
    organizations = await _request_json(
        client,
        "GET",
        "/rest/v1/organizations",
        params={"select": "id,slug,name", "slug": f"eq.{payload.organization_slug}"},
    )
    if isinstance(organizations, list) and organizations:
        return organizations[0], False

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
    return created[0], True


async def _get_organization_by_slug(client: httpx.AsyncClient, organization_slug: str) -> dict | None:
    organizations = await _request_json(
        client,
        "GET",
        "/rest/v1/organizations",
        params={"select": "id,slug,name", "slug": f"eq.{organization_slug}", "limit": "1"},
    )
    if isinstance(organizations, list) and organizations:
        return organizations[0]
    return None


async def _is_platform_owner(client: httpx.AsyncClient, current_user: CurrentUser) -> bool:
    if not settings.AUTH_ENABLED:
        return False

    platform_owners = await _request_json(
        client,
        "GET",
        "/rest/v1/platform_owners",
        params={
            "select": "user_id",
            "user_id": f"eq.{current_user.user_id}",
            "limit": "1",
        },
    )
    return isinstance(platform_owners, list) and bool(platform_owners)


async def _get_all_organizations_for_platform_owner(client: httpx.AsyncClient) -> list[ManageableOrganizationResponse]:
    organizations = await _request_json(
        client,
        "GET",
        "/rest/v1/organizations",
        params={"select": "id,slug,name", "order": "slug.asc"},
    )
    if not isinstance(organizations, list):
        return []

    return [
        ManageableOrganizationResponse(
            id=organization["id"],
            slug=organization["slug"],
            name=organization["name"],
            role="platform_owner",
            assignable_roles=_assignable_roles_for_manager("platform_owner"),
        )
        for organization in organizations
        if organization.get("id") and organization.get("slug") and organization.get("name")
    ]


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


async def _get_user_management_context(
    client: httpx.AsyncClient,
    current_user: CurrentUser,
) -> UserManagementContextResponse:
    is_platform_owner = await _is_platform_owner(client, current_user)
    if is_platform_owner:
        return UserManagementContextResponse(
            platform_owner=True,
            organizations=await _get_all_organizations_for_platform_owner(client),
        )

    return UserManagementContextResponse(
        platform_owner=False,
        organizations=await _get_manageable_organizations(client, current_user),
    )


async def _get_manageable_organization_for_slug(
    client: httpx.AsyncClient,
    current_user: CurrentUser,
    organization_slug: str,
) -> ManageableOrganizationResponse:
    if await _is_platform_owner(client, current_user):
        organization = await _get_organization_by_slug(client, organization_slug)
        if organization is None:
            raise HTTPException(status_code=404, detail="Organization not found")
        return ManageableOrganizationResponse(
            id=organization["id"],
            slug=organization["slug"],
            name=organization["name"],
            role="platform_owner",
            assignable_roles=_assignable_roles_for_manager("platform_owner"),
        )

    manageable_organizations = await _get_manageable_organizations(client, current_user)
    target_organization = next(
        (organization for organization in manageable_organizations if organization.slug == organization_slug),
        None,
    )
    if target_organization is None:
        raise HTTPException(status_code=403, detail="Users can only be managed in organizations you manage")
    return target_organization


async def _require_user_manager_for_payload(
    client: httpx.AsyncClient,
    current_user: CurrentUser,
    payload: CreateUserRequest,
) -> ManageableOrganizationResponse | None:
    if not settings.AUTH_ENABLED:
        return None

    if await _is_platform_owner(client, current_user):
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


async def _get_auth_users_by_id(client: httpx.AsyncClient, user_ids: list[str]) -> dict[str, dict]:
    if not user_ids:
        return {}

    auth_users = await _request_json(
        client,
        "GET",
        "/auth/v1/admin/users",
        params={"page": "1", "per_page": "1000"},
    )
    users = auth_users.get("users", []) if isinstance(auth_users, dict) else []
    return {user["id"]: user for user in users if user.get("id") in user_ids}


async def _is_target_platform_owner(client: httpx.AsyncClient, user_id: str) -> bool:
    platform_owners = await _request_json(
        client,
        "GET",
        "/rest/v1/platform_owners",
        params={"select": "user_id", "user_id": f"eq.{user_id}", "limit": "1"},
    )
    return isinstance(platform_owners, list) and bool(platform_owners)


async def _get_current_user_roles(client: httpx.AsyncClient, current_user: CurrentUser) -> list[str]:
    if not settings.AUTH_ENABLED:
        return []

    memberships = await _request_json(
        client,
        "GET",
        "/rest/v1/organization_memberships",
        params={"select": "role", "user_id": f"eq.{current_user.user_id}"},
    )
    if not isinstance(memberships, list):
        return []

    return sorted({membership["role"] for membership in memberships if membership.get("role")})


@router.get("/admin/user-management/context", response_model=UserManagementContextResponse)
async def get_user_management_context(
    api_key: str = Depends(verify_admin_api_key),
    current_user: CurrentUser = current_user_dependency,
) -> UserManagementContextResponse:
    async with httpx.AsyncClient(timeout=20) as client:
        return await _get_user_management_context(client, current_user)


@router.get("/admin/current-user/access", response_model=CurrentUserAccessResponse)
async def get_current_user_access(
    api_key: str = Depends(verify_admin_api_key),
    current_user: CurrentUser = current_user_dependency,
) -> CurrentUserAccessResponse:
    async with httpx.AsyncClient(timeout=20) as client:
        platform_owner = await _is_platform_owner(client, current_user)
        roles = await _get_current_user_roles(client, current_user)
        return CurrentUserAccessResponse(
            platform_owner=platform_owner,
            roles=roles,
            viewer_only=not platform_owner and roles == ["viewer"],
        )


@router.get("/admin/users", response_model=ManagedUsersResponse)
async def list_users(
    organization_slug: str | None = Query(default=None),
    api_key: str = Depends(verify_admin_api_key),
    current_user: CurrentUser = current_user_dependency,
) -> ManagedUsersResponse:
    async with httpx.AsyncClient(timeout=20) as client:
        if organization_slug:
            organizations = [await _get_manageable_organization_for_slug(client, current_user, organization_slug)]
        else:
            context = await _get_user_management_context(client, current_user)
            organizations = context.organizations

        if not organizations:
            return ManagedUsersResponse(users=[])

        organizations_by_id = {organization.id: organization for organization in organizations}
        memberships = await _request_json(
            client,
            "GET",
            "/rest/v1/organization_memberships",
            params={
                "select": "organization_id,user_id,role",
                "organization_id": f"in.({','.join(organizations_by_id)})",
            },
        )
        if not isinstance(memberships, list) or not memberships:
            return ManagedUsersResponse(users=[])

        user_ids = sorted({membership["user_id"] for membership in memberships if membership.get("user_id")})
        auth_users_by_id = await _get_auth_users_by_id(client, user_ids)
        profiles = await _request_json(
            client,
            "GET",
            "/rest/v1/profiles",
            params={"select": "user_id,display_name", "user_id": f"in.({','.join(user_ids)})"},
        )
        profiles_by_id = (
            {profile["user_id"]: profile for profile in profiles if profile.get("user_id")}
            if isinstance(profiles, list)
            else {}
        )

        users: list[ManagedUserResponse] = []
        for membership in memberships:
            organization = organizations_by_id.get(membership.get("organization_id"))
            user_id = membership.get("user_id")
            if not organization or not user_id:
                continue

            auth_user = auth_users_by_id.get(user_id, {})
            profile = profiles_by_id.get(user_id, {})
            role = membership.get("role", "")
            users.append(
                ManagedUserResponse(
                    user_id=user_id,
                    email=auth_user.get("email"),
                    display_name=profile.get("display_name") or auth_user.get("user_metadata", {}).get("display_name"),
                    organization_id=organization.id,
                    organization_slug=organization.slug,
                    organization_name=organization.name,
                    role=role,
                    can_delete=user_id != current_user.user_id and role in organization.assignable_roles,
                )
            )

        return ManagedUsersResponse(
            users=sorted(users, key=lambda user: (user.organization_slug, user.email or "", user.user_id))
        )


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
            organization, organization_created = await _get_or_create_organization(client, payload)
            organization_id = organization["id"]
            organization_slug = organization["slug"]
            if organization_created:
                await ensure_sample_report_for_organization(client, organization, current_user)
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


@router.delete("/admin/users/{user_id}", response_model=DeletedUserResponse)
async def delete_user(
    user_id: str,
    organization_slug: str = Query(min_length=1, pattern=r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"),
    api_key: str = Depends(verify_admin_api_key),
    current_user: CurrentUser = current_user_dependency,
) -> DeletedUserResponse:
    if user_id == current_user.user_id:
        raise HTTPException(status_code=403, detail="You cannot delete your own user")

    async with httpx.AsyncClient(timeout=20) as client:
        organization = await _get_manageable_organization_for_slug(client, current_user, organization_slug)
        memberships = await _request_json(
            client,
            "GET",
            "/rest/v1/organization_memberships",
            params={
                "select": "organization_id,user_id,role",
                "organization_id": f"eq.{organization.id}",
                "user_id": f"eq.{user_id}",
                "limit": "1",
            },
        )
        if not isinstance(memberships, list) or not memberships:
            raise HTTPException(status_code=404, detail="User membership not found")

        target_role = memberships[0].get("role", "")
        if target_role not in organization.assignable_roles:
            raise HTTPException(status_code=403, detail="Requested user cannot be deleted by your organization role")
        if await _is_target_platform_owner(client, user_id):
            raise HTTPException(status_code=403, detail="Platform owners cannot be deleted from this screen")

        await _request_json(
            client,
            "DELETE",
            "/rest/v1/organization_memberships",
            params={"organization_id": f"eq.{organization.id}", "user_id": f"eq.{user_id}"},
        )

        remaining_memberships = await _request_json(
            client,
            "GET",
            "/rest/v1/organization_memberships",
            params={"select": "organization_id", "user_id": f"eq.{user_id}", "limit": "1"},
        )
        auth_user_deleted = not (isinstance(remaining_memberships, list) and remaining_memberships)
        if auth_user_deleted:
            await _request_json(client, "DELETE", f"/auth/v1/admin/users/{user_id}")

    return DeletedUserResponse(user_id=user_id, organization_slug=organization.slug, auth_user_deleted=auth_user_deleted)
