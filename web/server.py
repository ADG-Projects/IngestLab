# Entry point for FastAPI app
from __future__ import annotations

from typing import Any, Dict

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from .config import (
    STATIC_DIR,
    ensure_chartjs_assets,
    ensure_dirs,
    ensure_pdfjs_assets,
)
from .routes import (
    chunks_router,
    elements_router,
    pdfs_router,
    reviews_router,
    runs_router,
    tables_router,
)

ensure_dirs()

app = FastAPI(title="Chunking Visualizer")

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


app.include_router(runs_router)
app.include_router(pdfs_router)
app.include_router(tables_router)
app.include_router(elements_router)
app.include_router(chunks_router)
app.include_router(reviews_router)

app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="ui")

ensure_pdfjs_assets()
ensure_chartjs_assets()
