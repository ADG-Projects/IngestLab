from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, UploadFile, File, Query
from fastapi.responses import FileResponse

from ..config import DEFAULT_PROVIDER, RES_DIR, relative_to_root, sanitize_pdf_filename
from ..file_utils import resolve_slug_file

router = APIRouter()


@router.get("/api/pdfs")
def api_pdfs() -> List[Dict[str, Any]]:
    pdfs: List[Dict[str, Any]] = []
    if RES_DIR.exists():
        for p in sorted(RES_DIR.glob("*.pdf")):
            try:
                size = p.stat().st_size
            except OSError:
                size = None
            pdfs.append(
                {
                    "name": p.name,
                    "slug": p.stem,
                    "path": relative_to_root(p),
                    "size": size,
                }
            )
    return pdfs


@router.post("/api/pdfs")
async def api_upload_pdf(file: UploadFile = File(...)) -> Dict[str, Any]:
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="file is required")
    safe_name = sanitize_pdf_filename(file.filename)
    if not safe_name:
        raise HTTPException(status_code=400, detail="Only .pdf files are accepted")
    dest = (RES_DIR / safe_name).resolve()
    if not str(dest).startswith(str(RES_DIR.resolve())):
        raise HTTPException(status_code=400, detail="Invalid destination path")
    if dest.exists():
        raise HTTPException(status_code=409, detail=f"PDF already exists: {safe_name}")
    try:
        with dest.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
    finally:
        await file.close()
    try:
        size = dest.stat().st_size
    except OSError:
        size = None
    return {
        "name": safe_name,
        "slug": dest.stem,
        "path": relative_to_root(dest),
        "size": size,
    }


@router.delete("/api/pdfs/{name}")
def api_delete_pdf(name: str) -> Dict[str, Any]:
    if not name or not name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="name must be a .pdf")
    candidate = (RES_DIR / Path(name).name).resolve()
    if not str(candidate).startswith(str(RES_DIR.resolve())):
        raise HTTPException(status_code=400, detail="invalid path")
    if not candidate.exists():
        raise HTTPException(status_code=404, detail=f"PDF not found: {name}")
    try:
        candidate.unlink()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete: {e}")
    return {"status": "ok", "removed": relative_to_root(candidate)}


@router.get("/res_pdf/{name}")
def pdf_from_res(name: str):
    if not name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="name must be a .pdf")
    candidate = (RES_DIR / name).resolve()
    if not str(candidate).startswith(str(RES_DIR.resolve())):
        raise HTTPException(status_code=400, detail="invalid path")
    if not candidate.exists():
        raise HTTPException(status_code=404, detail=f"PDF not found: {name}")
    return FileResponse(str(candidate))


@router.get("/pdf/{slug}")
def pdf_for_slug(slug: str, provider: str = Query(default=None)):
    path = resolve_slug_file(slug, "{slug}.pages*.pdf", provider=provider or DEFAULT_PROVIDER)
    return FileResponse(str(path))
