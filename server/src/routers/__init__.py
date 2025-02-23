from fastapi import APIRouter

from src.routers import admin_report, healthcheck, meta, report

router = APIRouter()
router.include_router(
    healthcheck.router,
)
router.include_router(report.router)
router.include_router(meta.router)
router.include_router(admin_report.router)
