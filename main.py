from __future__ import annotations

import os

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
