import httpx

from src.auth import CurrentUser
from src.config import settings


def _require_supabase_service_config() -> tuple[str, str]:
    if not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("Supabase service role configuration is missing")
    return settings.SUPABASE_URL.rstrip("/"), settings.SUPABASE_SERVICE_ROLE_KEY


async def request_supabase_json(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    json: dict | None = None,
    params: dict[str, str] | None = None,
    prefer: str | None = None,
):
    supabase_url, service_role_key = _require_supabase_service_config()
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer

    response = await client.request(method, f"{supabase_url}{path}", headers=headers, json=json, params=params)
    if response.status_code == 204:
        return None
    if response.status_code >= 400:
        raise RuntimeError(f"Supabase request failed: {response.text}")
    return response.json()


async def is_platform_owner(client: httpx.AsyncClient, current_user: CurrentUser) -> bool:
    if not settings.AUTH_ENABLED:
        return False

    platform_owners = await request_supabase_json(
        client,
        "GET",
        "/rest/v1/platform_owners",
        params={"select": "user_id", "user_id": f"eq.{current_user.user_id}", "limit": "1"},
    )
    return isinstance(platform_owners, list) and bool(platform_owners)


async def get_accessible_report_slugs(client: httpx.AsyncClient, current_user: CurrentUser) -> set[str]:
    if await is_platform_owner(client, current_user):
        reports = await request_supabase_json(
            client,
            "GET",
            "/rest/v1/reports",
            params={"select": "slug", "purge_status": "neq.purged"},
        )
        return {report["slug"] for report in reports if report.get("slug")} if isinstance(reports, list) else set()

    memberships = await request_supabase_json(
        client,
        "GET",
        "/rest/v1/organization_memberships",
        params={"select": "organization_id", "user_id": f"eq.{current_user.user_id}"},
    )
    if not isinstance(memberships, list) or not memberships:
        return set()

    organization_ids = [
        membership["organization_id"] for membership in memberships if membership.get("organization_id")
    ]
    if not organization_ids:
        return set()

    reports = await request_supabase_json(
        client,
        "GET",
        "/rest/v1/reports",
        params={
            "select": "slug",
            "organization_id": f"in.({','.join(organization_ids)})",
            "purge_status": "neq.purged",
        },
    )
    return {report["slug"] for report in reports if report.get("slug")} if isinstance(reports, list) else set()
