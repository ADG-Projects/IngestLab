#!/usr/bin/env python3
"""CLI helper for PolicyAsCode development mode.

Provides commands to manage the PaC runtime clone for local development.

Usage:
    uv run python scripts/pac_dev.py status   # Show PaC status
    uv run python scripts/pac_dev.py clone    # Clone if not present
    uv run python scripts/pac_dev.py pull     # Pull latest changes
    uv run python scripts/pac_dev.py update   # Clone/pull + reload modules
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Add project root to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from chunking_pipeline.pac_dev import (
    clone_or_pull_pac,
    get_pac_status,
    is_dev_mode_enabled,
    reload_pac_modules,
    update_pac,
)


def cmd_status() -> int:
    """Show current PaC status."""
    status = get_pac_status()
    print(json.dumps(status, indent=2))
    return 0


def cmd_clone() -> int:
    """Clone PaC repository if not present."""
    if not is_dev_mode_enabled():
        print("Error: PAC_DEV_MODE is not enabled. Set PAC_DEV_MODE=1 to enable.")
        return 1

    result = clone_or_pull_pac()
    print(json.dumps(result, indent=2))
    return 0 if result["success"] else 1


def cmd_pull() -> int:
    """Pull latest changes from PaC repository."""
    if not is_dev_mode_enabled():
        print("Error: PAC_DEV_MODE is not enabled. Set PAC_DEV_MODE=1 to enable.")
        return 1

    result = clone_or_pull_pac()
    print(json.dumps(result, indent=2))
    return 0 if result["success"] else 1


def cmd_reload() -> int:
    """Reload PaC modules from cache."""
    if not is_dev_mode_enabled():
        print("Error: PAC_DEV_MODE is not enabled. Set PAC_DEV_MODE=1 to enable.")
        return 1

    result = reload_pac_modules()
    print(json.dumps(result, indent=2))
    return 0


def cmd_update() -> int:
    """Full update: clone/pull + reload modules."""
    if not is_dev_mode_enabled():
        print("Error: PAC_DEV_MODE is not enabled. Set PAC_DEV_MODE=1 to enable.")
        return 1

    result = update_pac()
    print(json.dumps(result, indent=2))
    return 0 if result["success"] else 1


def main() -> int:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="PolicyAsCode development mode CLI helper",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Commands:
  status   Show current PaC status and configuration
  clone    Clone PaC repository if not present
  pull     Pull latest changes (alias for clone if exists)
  reload   Clear module cache to pick up new code
  update   Full update: clone/pull + reload modules

Environment Variables:
  PAC_DEV_MODE     Enable dev mode ("1", "true")
  PAC_LOCAL_PATH   Clone location (default: /tmp/pac or ../PolicyAsCode)
  PAC_BRANCH       Branch to clone/pull
  PAC_REPO_URL     Git repository URL
  GH_TOKEN         GitHub token for private repos
""",
    )
    parser.add_argument(
        "command",
        choices=["status", "clone", "pull", "reload", "update"],
        help="Command to execute",
    )

    args = parser.parse_args()

    commands = {
        "status": cmd_status,
        "clone": cmd_clone,
        "pull": cmd_pull,
        "reload": cmd_reload,
        "update": cmd_update,
    }

    return commands[args.command]()


if __name__ == "__main__":
    sys.exit(main())
