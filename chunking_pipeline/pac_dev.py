"""PolicyAsCode development mode utilities.

This module enables on-demand updates of PolicyAsCode without redeploying
or restarting the server. It works by:

1. Cloning PaC to a runtime directory (e.g., /tmp/pac on Railway)
2. Manipulating sys.path so the runtime clone takes precedence
3. Clearing the module cache so lazy imports pick up new code
4. Resetting cached processors (FigureProcessorWrapper)

Since all PaC imports are lazy (inside methods), clearing sys.modules
and resetting cached processors makes new code take effect immediately.

Environment Variables:
    PAC_DEV_MODE: Enable local/runtime mode ("1", "true")
    PAC_LOCAL_PATH: Path to clone (default: /tmp/pac on Railway, ../PolicyAsCode locally)
    PAC_BRANCH: Branch to clone/pull (default: feature/chunking-visualizer-integration)
    PAC_REPO_URL: Git repo URL (default: https://github.com/kyndryl-agentic-ai/PolicyAsCode.git)
    GH_TOKEN: GitHub token for private repos (same token used by gh CLI)
"""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger

# Default configuration
DEFAULT_BRANCH = "feature/chunking-visualizer-integration"
DEFAULT_REPO_URL = "https://github.com/kyndryl-agentic-ai/PolicyAsCode.git"
DEFAULT_LOCAL_PATH_RAILWAY = "/tmp/pac"
DEFAULT_LOCAL_PATH_DEV = "../PolicyAsCode"

# Module-level state
_pac_path_initialized = False
_pac_path: Path | None = None
_last_updated: datetime | None = None


def _is_truthy(value: str | None) -> bool:
    """Check if an environment variable value is truthy."""
    if not value:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def is_dev_mode_enabled() -> bool:
    """Check if PaC dev mode is enabled via environment variable."""
    return _is_truthy(os.environ.get("PAC_DEV_MODE"))


def get_pac_config() -> dict[str, Any]:
    """Get current PaC configuration from environment.

    Returns:
        Dict with repo_url, branch, local_path, github_token, and dev_mode_enabled.
    """
    # Determine default local path based on environment
    # On Railway, use /tmp; otherwise use relative path for local dev
    is_railway = os.environ.get("RAILWAY_ENVIRONMENT") is not None
    default_path = DEFAULT_LOCAL_PATH_RAILWAY if is_railway else DEFAULT_LOCAL_PATH_DEV

    return {
        "repo_url": os.environ.get("PAC_REPO_URL", DEFAULT_REPO_URL),
        "branch": os.environ.get("PAC_BRANCH", DEFAULT_BRANCH),
        "local_path": os.environ.get("PAC_LOCAL_PATH", default_path),
        "github_token": os.environ.get("GH_TOKEN"),
        "dev_mode_enabled": is_dev_mode_enabled(),
    }


def _get_authenticated_url(repo_url: str, token: str | None) -> str:
    """Build authenticated git URL if token is provided.

    Transforms https://github.com/org/repo.git to https://<token>@github.com/org/repo.git
    """
    if not token:
        return repo_url

    # Handle https:// URLs
    if repo_url.startswith("https://"):
        # Insert token after https://
        return repo_url.replace("https://", f"https://{token}@", 1)

    return repo_url


def init_pac_path() -> bool:
    """Initialize PaC path at startup if dev mode is enabled.

    Adds the runtime PaC path to sys.path so imports resolve there first.
    Should be called early in application startup (in main.py).

    Returns:
        True if path was initialized, False if dev mode is disabled or path doesn't exist.
    """
    global _pac_path_initialized, _pac_path

    if not is_dev_mode_enabled():
        logger.debug("[pac_dev] Dev mode disabled, using installed PaC")
        return False

    config = get_pac_config()
    pac_path = Path(config["local_path"]).resolve()

    # Check if path exists and contains PaC source
    src_path = pac_path / "src"
    if not src_path.exists():
        logger.warning(
            f"[pac_dev] PaC source not found at {pac_path}. "
            "Run /api/admin/pac/update to clone it."
        )
        return False

    # Insert at the beginning of sys.path to take precedence
    pac_path_str = str(pac_path)
    if pac_path_str not in sys.path:
        sys.path.insert(0, pac_path_str)
        logger.info(f"[pac_dev] Added {pac_path_str} to sys.path")

    _pac_path_initialized = True
    _pac_path = pac_path
    return True


def clone_or_pull_pac() -> dict[str, Any]:
    """Clone PaC if missing, or pull latest changes if exists.

    Returns:
        Dict with success status, message, commit hash, and any error details.
    """
    global _last_updated

    config = get_pac_config()
    pac_path = Path(config["local_path"]).resolve()
    repo_url = config["repo_url"]
    branch = config["branch"]
    token = config["github_token"]

    # Build authenticated URL for private repos
    auth_url = _get_authenticated_url(repo_url, token)

    result: dict[str, Any] = {
        "success": False,
        "action": None,
        "message": "",
        "commit": None,
        "branch": branch,
        "path": str(pac_path),
        "authenticated": bool(token),
    }

    try:
        if pac_path.exists() and (pac_path / ".git").exists():
            # Repository exists, pull latest
            result["action"] = "pull"
            logger.info(f"[pac_dev] Pulling latest from {branch} in {pac_path}")

            # Update remote URL in case token changed
            subprocess.run(
                ["git", "remote", "set-url", "origin", auth_url],
                cwd=pac_path,
                check=True,
                capture_output=True,
                text=True,
            )

            # Fetch and reset to remote branch (handles force-pushed branches)
            subprocess.run(
                ["git", "fetch", "origin", branch],
                cwd=pac_path,
                check=True,
                capture_output=True,
                text=True,
            )
            subprocess.run(
                ["git", "reset", "--hard", f"origin/{branch}"],
                cwd=pac_path,
                check=True,
                capture_output=True,
                text=True,
            )

            result["message"] = f"Pulled latest from {branch}"

        else:
            # Clone fresh
            result["action"] = "clone"
            logger.info(f"[pac_dev] Cloning to {pac_path}")

            # Create parent directory if needed
            pac_path.parent.mkdir(parents=True, exist_ok=True)

            subprocess.run(
                ["git", "clone", "--branch", branch, "--single-branch", auth_url, str(pac_path)],
                check=True,
                capture_output=True,
                text=True,
            )

            result["message"] = f"Cloned {branch} branch"

        # Get current commit hash
        commit_result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=pac_path,
            capture_output=True,
            text=True,
        )
        if commit_result.returncode == 0:
            result["commit"] = commit_result.stdout.strip()

        _last_updated = datetime.now(timezone.utc)
        result["success"] = True
        result["last_updated"] = _last_updated.isoformat()

        logger.info(
            f"[pac_dev] {result['action'].title()} complete: "
            f"commit {result['commit']}"
        )

    except subprocess.CalledProcessError as e:
        result["message"] = f"Git command failed: {e.stderr or e.stdout or str(e)}"
        logger.error(f"[pac_dev] {result['message']}")
    except Exception as e:
        result["message"] = f"Unexpected error: {e}"
        logger.error(f"[pac_dev] {result['message']}")

    return result


def reload_pac_modules() -> dict[str, Any]:
    """Clear PaC modules from sys.modules and reset cached processors.

    This allows lazy imports to pick up new code after a pull.

    Returns:
        Dict with count of cleared modules and any warnings.
    """
    result: dict[str, Any] = {
        "modules_cleared": 0,
        "processor_reset": False,
        "warnings": [],
    }

    # Clear all src.* modules from cache
    modules_to_remove = [
        name for name in sys.modules
        if name == "src" or name.startswith("src.")
    ]

    for name in modules_to_remove:
        del sys.modules[name]
        result["modules_cleared"] += 1

    logger.info(f"[pac_dev] Cleared {result['modules_cleared']} modules from cache")

    # Reset the FigureProcessorWrapper singleton
    try:
        from chunking_pipeline.figure_processor import reset_processor
        reset_processor()
        result["processor_reset"] = True
        logger.info("[pac_dev] Reset FigureProcessorWrapper")
    except ImportError:
        result["warnings"].append("Could not import reset_processor")
    except Exception as e:
        result["warnings"].append(f"Error resetting processor: {e}")

    return result


def get_pac_status() -> dict[str, Any]:
    """Get current PaC status and configuration.

    Returns:
        Dict with mode, path, branch, commit, last_updated, etc.
    """
    config = get_pac_config()
    pac_path = Path(config["local_path"]).resolve()

    status: dict[str, Any] = {
        "dev_mode_enabled": config["dev_mode_enabled"],
        "path": str(pac_path),
        "branch": config["branch"],
        "repo_url": config["repo_url"],
        "has_token": bool(config["github_token"]),
        "path_exists": pac_path.exists(),
        "path_initialized": _pac_path_initialized,
        "commit": None,
        "last_updated": _last_updated.isoformat() if _last_updated else None,
        "using_installed": not config["dev_mode_enabled"],
    }

    # Get current commit if path exists
    if pac_path.exists() and (pac_path / ".git").exists():
        try:
            commit_result = subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],
                cwd=pac_path,
                capture_output=True,
                text=True,
            )
            if commit_result.returncode == 0:
                status["commit"] = commit_result.stdout.strip()

            # Get current branch
            branch_result = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=pac_path,
                capture_output=True,
                text=True,
            )
            if branch_result.returncode == 0:
                status["current_branch"] = branch_result.stdout.strip()

        except Exception as e:
            status["git_error"] = str(e)

    # Check if installed version is available
    try:
        import importlib.metadata
        status["installed_version"] = importlib.metadata.version("brd-to-opa-pipeline")
    except Exception:
        status["installed_version"] = None

    return status


def update_pac() -> dict[str, Any]:
    """Full update operation: clone/pull, reload modules, reinitialize path.

    This is the main entry point for the admin API endpoint.

    Returns:
        Combined result dict with clone/pull and reload results.
    """
    # Clone or pull
    clone_result = clone_or_pull_pac()

    if not clone_result["success"]:
        return {
            "success": False,
            "clone_result": clone_result,
            "reload_result": None,
        }

    # Reload modules
    reload_result = reload_pac_modules()

    # Reinitialize path
    init_pac_path()

    return {
        "success": True,
        "clone_result": clone_result,
        "reload_result": reload_result,
    }
