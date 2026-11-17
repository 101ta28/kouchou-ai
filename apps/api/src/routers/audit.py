"""Administrator access to evidence and reviewed summaries for public access."""

import os
import tempfile
from pathlib import Path
from typing import Literal

from analysis_core.audit import AuditError
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.background import BackgroundTask

from src.routers.admin_report import verify_admin_api_key
from src.services import public_audit
from src.services.audit import restore_audit_files, restore_audit_index
from src.utils.slug_utils import validate_slug


def private_response(response: Response):
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(
    prefix="/admin/reports/{slug}/audit",
    dependencies=[Depends(verify_admin_api_key), Depends(private_response)],
)

# This endpoint intentionally needs no API key. Only explicitly published
# summaries of READY + PUBLIC reports can reach it.
public_router = APIRouter(prefix="/reports/{slug}/audit", dependencies=[Depends(private_response)])


class PublishAuditRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    reviewed: Literal[True]

    @field_validator("reviewed", mode="before")
    @classmethod
    def explicit_review(cls, value):
        if value is not True:
            raise ValueError("Explicit review is required")
        return value


def publication_error(exc: Exception, *, public: bool = False) -> HTTPException:
    headers = {"Cache-Control": "no-store"}
    if isinstance(exc, FileNotFoundError):
        return HTTPException(404, "Audit publication or public report not found", headers=headers)
    if isinstance(exc, public_audit.PublicationConflict):
        return HTTPException(409, "The selected audit release changed; refresh the list", headers=headers)
    if isinstance(exc, AuditError):
        return HTTPException(
            503 if public else 409, "Audit publication is unavailable or the preview changed", headers=headers
        )
    if isinstance(exc, OSError):
        return HTTPException(503, "Audit publication storage is unavailable", headers=headers)
    return HTTPException(503 if public else 400, "Invalid audit publication data", headers=headers)


@router.get("/{run_id}/public-preview")
def preview_public_audit(slug: str, run_id: str):
    validate_slug(slug)
    try:
        return public_audit.preview_public_audit(slug, run_id)
    except (AuditError, OSError, ValueError) as exc:
        raise publication_error(exc) from exc


@router.put("/{run_id}/publication")
def publish_public_audit(slug: str, run_id: str, request: PublishAuditRequest):
    validate_slug(slug)
    try:
        return public_audit.publish_public_audit(slug, run_id, request.sha256)
    except (AuditError, OSError, ValueError) as exc:
        raise publication_error(exc) from exc


@router.delete("/{run_id}/publication", status_code=204)
def withdraw_public_audit(slug: str, run_id: str):
    validate_slug(slug)
    try:
        public_audit.withdraw_public_audit(slug, run_id)
    except (AuditError, OSError, ValueError) as exc:
        raise publication_error(exc) from exc


@public_router.get("")
def list_public_audits(slug: str, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    try:
        records = public_audit.list_public_audits(slug)
        page = []
        for record in records[offset : offset + limit]:
            release = public_audit.get_public_audit(slug, record["run_id"])
            document = release.pop("document")
            page.append(
                {
                    "run_id": record["run_id"],
                    **release,
                    "kind": document["kind"],
                    "started_at": document["started_at"],
                    "finished_at": document["finished_at"],
                    "status": document["status"],
                }
            )
        return {"total": len(records), "records": page}
    except (AuditError, OSError, ValueError) as exc:
        raise publication_error(exc, public=True) from exc


@public_router.get("/{run_id}")
def get_public_audit(slug: str, run_id: str):
    try:
        return public_audit.get_public_audit(slug, run_id)
    except (AuditError, OSError, ValueError) as exc:
        raise publication_error(exc, public=True) from exc


@public_router.get("/{run_id}/download")
def download_public_audit(slug: str, run_id: str, release_id: str | None = Query(None, pattern=r"^[a-f0-9]{64}$")):
    try:
        data, release = public_audit.download_public_audit(slug, run_id, release_id)
        return Response(
            content=data,
            media_type="application/zip",
            headers={
                "Cache-Control": "no-store",
                "Content-Disposition": f'attachment; filename="public-audit-{run_id}-{release["release_id"][:12]}.zip"',
                "X-Content-Type-Options": "nosniff",
                "X-Audit-Archive-SHA256": release["archive_sha256"],
            },
        )
    except (AuditError, OSError, ValueError) as exc:
        raise publication_error(exc, public=True) from exc


@router.get("")
def list_audit(slug: str, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    validate_slug(slug)
    try:
        records = restore_audit_index(slug).list_records()
        publications = {
            state.source_run_id: state.model_dump(mode="json") for state in public_audit.list_publication_states(slug)
        }
    except (AuditError, OSError, ValueError) as exc:
        raise publication_error(exc) from exc

    def summary(row):
        return {
            **{key: row[key] for key in ("run_id", "kind", "status", "started_at", "finished_at", "parent_run_id")},
            "publication": publications.get(row["run_id"]),
        }

    recommended = next((row for row in records if row["kind"] == "analysis" and row["status"] == "completed"), None)
    if recommended is None:
        recommended = next((row for row in records if row["status"] != "incomplete"), None)
    return {
        "total": len(records),
        "records": [summary(row) for row in records[offset : offset + limit]],
        "recommended_record": summary(recommended) if recommended else None,
    }


@router.get("/{run_id}")
def get_audit(slug: str, run_id: str):
    validate_slug(slug)
    try:
        return restore_audit_index(slug).read(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "Audit record not found") from exc
    except ValueError as exc:
        raise HTTPException(400, "Invalid audit run ID") from exc


@router.get("/{run_id}/verify")
def verify_audit(slug: str, run_id: str):
    validate_slug(slug)
    try:
        return restore_audit_files(slug, run_id).verify(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "Audit record not found") from exc
    except ValueError as exc:
        raise HTTPException(400, "Invalid audit run ID") from exc


@router.get("/{run_id}/download")
def download_audit(slug: str, run_id: str):
    validate_slug(slug)
    destination = None
    try:
        store = restore_audit_files(slug, run_id)
        fd, filename = tempfile.mkstemp(prefix="kouchou-audit-", suffix=".zip")
        os.close(fd)
        destination = Path(filename)
        store.export(run_id, destination)
        return FileResponse(
            destination,
            filename=f"{slug}-audit-{run_id}.zip",
            media_type="application/zip",
            headers={"Cache-Control": "no-store"},
            background=BackgroundTask(destination.unlink, missing_ok=True),
        )
    except FileNotFoundError as exc:
        if destination:
            destination.unlink(missing_ok=True)
        raise HTTPException(404, "Audit record not found") from exc
    except (AuditError, ValueError) as exc:
        if destination:
            destination.unlink(missing_ok=True)
        raise HTTPException(409, "Audit evidence is unavailable or the operation is incomplete") from exc
    except BaseException:
        if destination:
            destination.unlink(missing_ok=True)
        raise
