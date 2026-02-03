# Entry point for FastAPI app
from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from .config import (
    STATIC_DIR,
    ensure_chartjs_assets,
    ensure_dirs,
    ensure_markdown_assets,
    ensure_pdfjs_assets,
)
from .routes import (
    admin_router,
    chunker_router,
    chunks_router,
    elements_router,
    extractions_router,
    feedback_router,
    images_router,
    pdfs_router,
    reviews_router,
)
from .extraction_jobs import EXTRACTION_JOB_MANAGER  # noqa: F401 - ensure job manager thread starts

_LOGGING_CONFIGURED = False


def configure_chunking_logging() -> None:
    global _LOGGING_CONFIGURED
    if _LOGGING_CONFIGURED:
        return
    handler = logging.StreamHandler()
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("[chunking] %(asctime)s %(levelname)s %(name)s: %(message)s"))
    for name in ("chunking.routes.admin", "chunking.routes.extractions", "chunking.routes.chunker", "chunking.routes.images", "chunking.extraction_jobs"):
        logger = logging.getLogger(name)
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)
        logger.propagate = False
    _LOGGING_CONFIGURED = True

ensure_dirs()
configure_chunking_logging()

app = FastAPI(title="IngestLab")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.get("/healthz")
def healthz() -> Dict[str, Any]:
    return {"status": "ok"}


app.include_router(admin_router)
app.include_router(extractions_router)
app.include_router(pdfs_router)
app.include_router(elements_router)
app.include_router(chunks_router)
app.include_router(chunker_router)
app.include_router(reviews_router)
app.include_router(feedback_router)
app.include_router(images_router)

app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="ui")

ensure_pdfjs_assets()
ensure_chartjs_assets()
ensure_markdown_assets()
