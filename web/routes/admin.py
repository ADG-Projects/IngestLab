"""Admin API endpoints for system configuration and maintenance.

Provides endpoints for PolicyAsCode (PaC) development mode management,
allowing on-demand updates without server restart.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from chunking_pipeline.pac_dev import (
    get_pac_status,
    is_dev_mode_enabled,
    update_pac,
)

logger = logging.getLogger("chunking.routes.admin")

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/pac/status")
def pac_status() -> dict[str, Any]:
    """Get current PolicyAsCode status and configuration.

    Returns:
        Dict with dev_mode_enabled, path, branch, commit, last_updated, etc.
    """
    return get_pac_status()


@router.post("/pac/update")
def pac_update() -> dict[str, Any]:
    """Update PolicyAsCode: clone if missing, pull if exists, reload modules.

    This endpoint:
    1. Clones PaC to PAC_LOCAL_PATH if not present
    2. Pulls latest changes if already cloned
    3. Clears src.* modules from sys.modules cache
    4. Resets FigureProcessorWrapper singleton

    After calling this endpoint, subsequent figure processing requests
    will use the updated PaC code.

    Returns:
        Dict with success status, clone/pull result, and reload result.
    """
    if not is_dev_mode_enabled():
        return {
            "success": False,
            "error": "PAC_DEV_MODE is not enabled. Set PAC_DEV_MODE=1 to enable.",
        }

    logger.info("Starting PaC update...")
    result = update_pac()

    if result["success"]:
        logger.info(
            f"PaC update complete: {result['clone_result']['action']} "
            f"commit {result['clone_result']['commit']}"
        )
    else:
        logger.error(f"PaC update failed: {result['clone_result']['message']}")

    return result
