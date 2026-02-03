from __future__ import annotations

import os
from pathlib import Path


def _load_local_env() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    root = Path(__file__).resolve().parent
    for candidate in (root / ".env", root / ".env.local"):
        if candidate.exists():
            load_dotenv(candidate)


_load_local_env()

# Initialize PolicyAsCode dev mode path if enabled
# This must happen before importing web.server to ensure sys.path is set
from chunking_pipeline.pac_dev import init_pac_path

init_pac_path()

from web.server import app


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    try:
        port = int(os.environ.get("PORT", "8000"))
    except ValueError:
        port = 8000
    reload = str(os.environ.get("RELOAD", "false")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    uvicorn.run(app, host=host, port=port, reload=reload)
