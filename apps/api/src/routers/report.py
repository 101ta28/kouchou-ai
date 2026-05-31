import json
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError

from src.auth import CurrentUser, get_current_user, verify_public_api_key
from src.config import settings
from src.schemas.public_report_result import PublicReportResult
from src.schemas.report import Report, ReportStatus, ReportVisibility
from src.schemas.visualization_config import DEFAULT_REPORT_DISPLAY_CONFIG, ReportDisplayConfig
from src.services.report_access import get_accessible_report_slugs, is_platform_owner, request_supabase_json
from src.services.report_status import load_status_as_reports
from src.utils.slug_utils import validate_slug

logger = logging.getLogger("uvicorn")

router = APIRouter()
current_user_dependency = Depends(get_current_user)


def _load_validated_report_result(slug: str) -> dict:
    report_path = settings.REPORT_DIR / slug / "hierarchical_result.json"

    with open(report_path, encoding="utf-8") as f:
        report_result = json.load(f)

    try:
        PublicReportResult.model_validate(report_result)
    except ValidationError as e:
        logger.warning(f"Invalid public report result for {slug}: {e}")
        raise HTTPException(status_code=500, detail="Invalid report data") from e

    return report_result


def _description_from_report_result(slug: str) -> str:
    report_path = settings.REPORT_DIR / slug / "hierarchical_result.json"
    if not report_path.exists():
        return ""

    try:
        with open(report_path, encoding="utf-8") as f:
            report_result = json.load(f)
    except (OSError, json.JSONDecodeError):
        return ""

    overview = str(report_result.get("overview") or "")
    return overview[:180]


def _report_from_database_row(row: dict) -> Report | None:
    slug = row.get("slug")
    if not slug or not (settings.REPORT_DIR / slug / "hierarchical_result.json").exists():
        return None

    try:
        return Report(
            slug=slug,
            title=row.get("title") or slug,
            description=_description_from_report_result(slug),
            status=ReportStatus(row.get("status")),
            visibility=ReportVisibility(row.get("visibility") or ReportVisibility.PRIVATE.value),
            is_pubcom=False,
            created_at=row.get("created_at"),
        )
    except ValueError:
        return None


async def _get_accessible_database_reports(client: httpx.AsyncClient, current_user: CurrentUser) -> list[Report]:
    if await is_platform_owner(client, current_user):
        report_rows = await request_supabase_json(
            client,
            "GET",
            "/rest/v1/reports",
            params={
                "select": "slug,title,status,visibility,created_at",
                "purge_status": "neq.purged",
            },
        )
    else:
        memberships = await request_supabase_json(
            client,
            "GET",
            "/rest/v1/organization_memberships",
            params={"select": "organization_id", "user_id": f"eq.{current_user.user_id}"},
        )
        if not isinstance(memberships, list) or not memberships:
            return []

        organization_ids = [
            membership["organization_id"] for membership in memberships if membership.get("organization_id")
        ]
        if not organization_ids:
            return []

        report_rows = await request_supabase_json(
            client,
            "GET",
            "/rest/v1/reports",
            params={
                "select": "slug,title,status,visibility,created_at",
                "organization_id": f"in.({','.join(organization_ids)})",
                "purge_status": "neq.purged",
            },
        )

    if not isinstance(report_rows, list):
        return []

    reports = [_report_from_database_row(row) for row in report_rows]
    return [report for report in reports if report and report.status == ReportStatus.READY]


def _merge_reports(
    primary_reports: list[Report],
    fallback_reports: list[Report],
    excluded_slugs: set[str] | None = None,
) -> list[Report]:
    excluded_slugs = excluded_slugs or set()
    reports_by_slug = {report.slug: report for report in primary_reports}
    for report in fallback_reports:
        if report.slug in excluded_slugs:
            continue
        reports_by_slug.setdefault(report.slug, report)
    return sorted(reports_by_slug.values(), key=lambda report: report.created_at or "", reverse=True)


@router.get("/reports", dependencies=[Depends(verify_public_api_key)])
async def reports(current_user: CurrentUser = current_user_dependency) -> list[Report]:
    all_reports = load_status_as_reports()
    if settings.AUTH_ENABLED:
        async with httpx.AsyncClient(timeout=20) as client:
            accessible_slugs = await get_accessible_report_slugs(client, current_user)
            database_reports = await _get_accessible_database_reports(client, current_user)
        ready_reports = [
            report for report in all_reports if report.status == ReportStatus.READY and report.slug in accessible_slugs
        ]
        deleted_slugs = {report.slug for report in all_reports if report.status == ReportStatus.DELETED}
        ready_reports = _merge_reports(ready_reports, database_reports, excluded_slugs=deleted_slugs)
    else:
        ready_reports = [
            report for report in all_reports if report.status == ReportStatus.READY and report.is_publicly_visible
        ]
    return ready_reports


@router.get("/reports/{slug}")
async def report(
    slug: str,
    api_key: str = Depends(verify_public_api_key),
    current_user: CurrentUser = current_user_dependency,
) -> dict:
    validate_slug(slug)
    report_path = settings.REPORT_DIR / slug / "hierarchical_result.json"
    all_reports = load_status_as_reports()
    target_report_status = next((report for report in all_reports if report.slug == slug), None)

    if settings.AUTH_ENABLED:
        async with httpx.AsyncClient(timeout=20) as client:
            accessible_slugs = await get_accessible_report_slugs(client, current_user)
            if target_report_status is None and slug in accessible_slugs:
                database_reports = await _get_accessible_database_reports(client, current_user)
                target_report_status = next((report for report in database_reports if report.slug == slug), None)
        if slug not in accessible_slugs:
            raise HTTPException(status_code=404, detail="Report not found")
    if target_report_status is None:
        raise HTTPException(status_code=404, detail="Report not found")
    if target_report_status.status != ReportStatus.READY:
        raise HTTPException(status_code=404, detail="Report is not ready")
    if not settings.AUTH_ENABLED and target_report_status.visibility == ReportVisibility.PRIVATE:
        raise HTTPException(status_code=404, detail="Report is private")
    if not report_path.exists():
        raise HTTPException(status_code=404, detail="Report not found")

    report_result = _load_validated_report_result(slug)

    # レポートにvisibilityを追加
    report_result["visibility"] = target_report_status.visibility.value

    # 可視化設定をマージ（存在する場合）
    # snake_case JSONをpydanticで検証し、camelCaseに変換して返す
    visualization_config_path = settings.REPORT_DIR / slug / "visualization_config.json"
    if visualization_config_path.exists():
        try:
            with open(visualization_config_path) as f:
                raw_config = json.load(f)
            # pydanticで検証（snake_case/camelCase両対応、populate_by_name=True）
            validated_config = ReportDisplayConfig.model_validate(raw_config)
            # camelCaseで出力（by_alias=True）
            report_result["visualizationConfig"] = validated_config.model_dump(by_alias=True)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"Failed to load visualization config for {slug}: {e}")
        except ValidationError as e:
            logger.warning(f"Invalid visualization config for {slug}, using default: {e}")
            report_result["visualizationConfig"] = DEFAULT_REPORT_DISPLAY_CONFIG.model_dump(by_alias=True)

    return report_result


@router.get("/test-error")
async def test_error():
    logger.info("This is a test log message")
    raise ValueError("Test error to check logging")
