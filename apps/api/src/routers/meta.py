import json
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, Response

from src.auth import CurrentUser, get_optional_current_user
from src.config import settings
from src.schemas.metadata import Metadata
from src.services.report_access import request_supabase_json

router = APIRouter()
CUSTOM_META_DIR = Path(__file__).parent.parent.parent / "public" / "meta" / "custom"
DEFAULT_META_DIR = Path(__file__).parent.parent.parent / "public" / "meta" / "default"
ORGANIZATION_META_DIR = settings.DATA_DIR / "organization_meta"
current_user_dependency = Depends(get_optional_current_user)


def load_metadata_file_path(filename: str) -> Path:
    """メタデータファイルのパスを返す。customファイルが存在する場合はcustomファイルを読み、存在しない場合はdefaultファイルを読む"""
    custom_metadata_path = CUSTOM_META_DIR / filename
    metadata_path = custom_metadata_path if custom_metadata_path.exists() else DEFAULT_META_DIR / filename
    return metadata_path


def _metadata_from_file() -> Metadata:
    metadata_path = load_metadata_file_path("metadata.json")
    with open(metadata_path) as f:
        metadata = json.load(f)

    is_default = "default" in str(metadata_path)
    if is_default:
        return Metadata(
            reporter=metadata.get("reporter"),
            message=metadata.get("message"),
            brandColor=metadata.get("brandColor"),
            isDefault=True,
        )

    return Metadata(
        reporter=metadata.get("reporter"),
        message=metadata.get("message"),
        webLink=metadata.get("webLink"),
        privacyLink=metadata.get("privacyLink"),
        termsLink=metadata.get("termsLink"),
        brandColor=metadata.get("brandColor"),
        isDefault=False,
    )


async def _get_organization_by_slug(client: httpx.AsyncClient, organization_slug: str) -> dict | None:
    organizations = await request_supabase_json(
        client,
        "GET",
        "/rest/v1/organizations",
        params={"select": "id,slug,name", "slug": f"eq.{organization_slug}", "limit": "1"},
    )
    if isinstance(organizations, list) and organizations:
        return organizations[0]
    return None


async def _get_organization_for_report_slug(client: httpx.AsyncClient, report_slug: str) -> dict | None:
    reports = await request_supabase_json(
        client,
        "GET",
        "/rest/v1/reports",
        params={"select": "organization_id", "slug": f"eq.{report_slug}", "limit": "1"},
    )
    if not isinstance(reports, list) or not reports or not reports[0].get("organization_id"):
        return None

    organizations = await request_supabase_json(
        client,
        "GET",
        "/rest/v1/organizations",
        params={"select": "id,slug,name", "id": f"eq.{reports[0]['organization_id']}", "limit": "1"},
    )
    if isinstance(organizations, list) and organizations:
        return organizations[0]
    return None


async def _get_primary_organization_for_user(client: httpx.AsyncClient, current_user: CurrentUser | None) -> dict | None:
    if current_user is None or not settings.AUTH_ENABLED:
        return None

    memberships = await request_supabase_json(
        client,
        "GET",
        "/rest/v1/organization_memberships",
        params={
            "select": "organization_id",
            "user_id": f"eq.{current_user.user_id}",
            "order": "created_at.asc",
            "limit": "1",
        },
    )
    if not isinstance(memberships, list) or not memberships or not memberships[0].get("organization_id"):
        return None

    organizations = await request_supabase_json(
        client,
        "GET",
        "/rest/v1/organizations",
        params={"select": "id,slug,name", "id": f"eq.{memberships[0]['organization_id']}", "limit": "1"},
    )
    if isinstance(organizations, list) and organizations:
        return organizations[0]
    return None


async def _resolve_organization(
    client: httpx.AsyncClient,
    current_user: CurrentUser | None,
    organization_slug: str | None,
    report_slug: str | None,
) -> dict | None:
    if organization_slug:
        return await _get_organization_by_slug(client, organization_slug)
    if report_slug:
        return await _get_organization_for_report_slug(client, report_slug)
    return await _get_primary_organization_for_user(client, current_user)


async def _get_organization_metadata(client: httpx.AsyncClient, organization_id: str) -> dict | None:
    organization_metadata = await request_supabase_json(
        client,
        "GET",
        "/rest/v1/organization_metadata",
        params={
            "select": "reporter,message,web_link,privacy_link,terms_link,brand_color",
            "organization_id": f"eq.{organization_id}",
            "limit": "1",
        },
    )
    if isinstance(organization_metadata, list) and organization_metadata:
        return organization_metadata[0]
    return None


async def _load_metadata(
    current_user: CurrentUser | None,
    organization_slug: str | None,
    report_slug: str | None,
) -> Metadata:
    if settings.AUTH_ENABLED and settings.SUPABASE_URL and settings.SUPABASE_SERVICE_ROLE_KEY:
        async with httpx.AsyncClient(timeout=20) as client:
            organization = await _resolve_organization(client, current_user, organization_slug, report_slug)
            if organization:
                organization_metadata = await _get_organization_metadata(client, organization["id"])
                if organization_metadata:
                    return Metadata(
                        reporter=organization_metadata.get("reporter")
                        or organization.get("name")
                        or organization.get("slug"),
                        message=organization_metadata.get("message") or "",
                        webLink=organization_metadata.get("web_link"),
                        privacyLink=organization_metadata.get("privacy_link"),
                        termsLink=organization_metadata.get("terms_link"),
                        brandColor=organization_metadata.get("brand_color"),
                        organizationSlug=organization.get("slug"),
                        isDefault=False,
                    )

    return _metadata_from_file()


async def _get_organization_asset_path(
    filename: str,
    organization_slug: str | None,
    report_slug: str | None,
) -> Path | None:
    if not settings.AUTH_ENABLED or not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
        return None

    async with httpx.AsyncClient(timeout=20) as client:
        organization = await _resolve_organization(client, None, organization_slug, report_slug)
        if not organization:
            return None
        asset_path = ORGANIZATION_META_DIR / organization["slug"] / filename
        return asset_path if asset_path.exists() else None


@router.get("/meta")
async def get_metadata(
    organization_slug: str | None = Query(default=None),
    report_slug: str | None = Query(default=None),
    current_user: CurrentUser | None = current_user_dependency,
) -> Metadata:
    """
    レポート作成者情報などのメタデータを返す。
    custom/meta/metadata.jsonがあればそれを、なければdefault/meta/metadata.jsonを返す。
    デフォルト環境の場合は、画像やリンクの値は返さない。
    """
    try:
        return await _load_metadata(current_user, organization_slug, report_slug)
    except FileNotFoundError:
        # メタデータファイルが存在しない場合は空のメタデータを返す
        return Metadata(isDefault=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/meta/reporter.png")
async def get_reporter_image(
    organization_slug: str | None = Query(default=None),
    report_slug: str | None = Query(default=None),
):
    """
    レポート作成者の画像を返す。
    custom/meta/report.pngが存在する場合のみ画像を返し、
    存在しない場合やdefaultのみの場合は204 No Contentを返す。
    → デフォルト画像（テスト環境など）が誤って表示されないようにするための仕様。
    """
    organization_asset_path = await _get_organization_asset_path("reporter.png", organization_slug, report_slug)
    if organization_asset_path:
        return FileResponse(organization_asset_path)

    custom_metadata_path = CUSTOM_META_DIR / "reporter.png"
    if custom_metadata_path.exists():
        return FileResponse(custom_metadata_path)
    return Response(status_code=204)


@router.get("/meta/icon.png")
async def get_icon(
    organization_slug: str | None = Query(default=None),
    report_slug: str | None = Query(default=None),
):
    organization_asset_path = await _get_organization_asset_path("icon.png", organization_slug, report_slug)
    if organization_asset_path:
        return FileResponse(organization_asset_path)
    return FileResponse(load_metadata_file_path("icon.png"))


@router.get("/meta/ogp.png")
async def get_ogp(
    organization_slug: str | None = Query(default=None),
    report_slug: str | None = Query(default=None),
):
    organization_asset_path = await _get_organization_asset_path("ogp.png", organization_slug, report_slug)
    if organization_asset_path:
        return FileResponse(organization_asset_path)
    return FileResponse(load_metadata_file_path("ogp.png"))


@router.get("/meta/metadata.json")
async def get_metadata_json(
    organization_slug: str | None = Query(default=None),
    report_slug: str | None = Query(default=None),
    current_user: CurrentUser | None = current_user_dependency,
) -> Metadata:
    """
    レポート作成者情報などのメタデータを返す。
    custom/meta/metadata.jsonがあればそれを、なければdefault/meta/metadata.jsonを返す。
    デフォルト環境の場合は、画像やリンクの値は返さない。
    """
    try:
        return await _load_metadata(current_user, organization_slug, report_slug)
    except FileNotFoundError:
        # メタデータファイルが存在しない場合は空のメタデータを返す
        return Metadata(isDefault=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
