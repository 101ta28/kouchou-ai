import json
import shutil
from datetime import UTC, datetime, timedelta

import httpx

from src.auth import CurrentUser
from src.config import settings
from src.schemas.report import ReportVisibility
from src.services.report_access import request_supabase_json
from src.services.report_status import add_ready_report_to_status

SAMPLE_SOURCE_SLUG = "example-hierarchical-polis"
SAMPLE_REPORT_SUFFIX = "sample-report"
SAMPLE_RETENTION_DAYS = 3650


def build_sample_report_slug(organization_slug: str) -> str:
    return f"{organization_slug}-{SAMPLE_REPORT_SUFFIX}"


def _sample_title(organization_name: str) -> str:
    return f"{organization_name} サンプルレポート"


def _sample_description(report_result: dict) -> str:
    overview = str(report_result.get("overview") or "")
    return overview[:180] if overview else "広聴AI オンラインの操作確認用サンプルレポートです。"


def _copy_sample_report_files(sample_slug: str) -> dict:
    source_dir = settings.REPORT_DIR / SAMPLE_SOURCE_SLUG
    target_dir = settings.REPORT_DIR / sample_slug
    if not source_dir.exists():
        raise FileNotFoundError(f"Sample report source not found: {source_dir}")

    target_dir.mkdir(parents=True, exist_ok=True)
    for source_path in source_dir.iterdir():
        if source_path.is_file():
            shutil.copy2(source_path, target_dir / source_path.name)

    result_path = target_dir / "hierarchical_result.json"
    with open(result_path, encoding="utf-8") as f:
        return json.load(f)


async def ensure_sample_report_for_organization(
    client: httpx.AsyncClient,
    organization: dict,
    current_user: CurrentUser,
) -> str:
    organization_slug = organization["slug"]
    organization_name = organization.get("name") or organization_slug
    sample_slug = build_sample_report_slug(organization_slug)
    report_result = _copy_sample_report_files(sample_slug)
    title = _sample_title(organization_name)
    description = _sample_description(report_result)

    add_ready_report_to_status(
        sample_slug,
        title=title,
        description=description,
        visibility=ReportVisibility.PUBLIC,
    )

    retention_expires_at = datetime.now(UTC) + timedelta(days=max(settings.RETENTION_DAYS, SAMPLE_RETENTION_DAYS))
    await request_supabase_json(
        client,
        "POST",
        "/rest/v1/reports",
        json={
            "slug": sample_slug,
            "organization_id": organization["id"],
            "created_by": current_user.user_id,
            "title": title,
            "status": "ready",
            "visibility": "public",
            "artifact_path": f"reports/{sample_slug}/hierarchical_result.json",
            "retention_expires_at": retention_expires_at.isoformat(),
            "purge_status": "active",
        },
        params={"on_conflict": "slug"},
        prefer="resolution=merge-duplicates",
    )
    return sample_slug
