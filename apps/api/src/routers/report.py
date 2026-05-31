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
from src.services.report_access import get_accessible_report_slugs
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


@router.get("/reports", dependencies=[Depends(verify_public_api_key)])
async def reports(current_user: CurrentUser = current_user_dependency) -> list[Report]:
    all_reports = load_status_as_reports()
    if settings.AUTH_ENABLED:
        async with httpx.AsyncClient(timeout=20) as client:
            accessible_slugs = await get_accessible_report_slugs(client, current_user)
        ready_reports = [
            report for report in all_reports if report.status == ReportStatus.READY and report.slug in accessible_slugs
        ]
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

    if target_report_status is None:
        raise HTTPException(status_code=404, detail="Report not found")
    if target_report_status.status != ReportStatus.READY:
        raise HTTPException(status_code=404, detail="Report is not ready")
    if settings.AUTH_ENABLED:
        async with httpx.AsyncClient(timeout=20) as client:
            accessible_slugs = await get_accessible_report_slugs(client, current_user)
        if slug not in accessible_slugs:
            raise HTTPException(status_code=404, detail="Report not found")
    elif target_report_status.visibility == ReportVisibility.PRIVATE:
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
