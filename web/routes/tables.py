from __future__ import annotations

import json
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..config import DATASET_DIR, OUT_DIR
from ..file_utils import resolve_slug_file

router = APIRouter()


@router.get("/api/matches/{slug}")
def api_matches(slug: str) -> Dict[str, Any]:
    path = OUT_DIR / f"{slug}.matches.json"
    if not path.exists():
        legacy = OUT_DIR / f"{slug}.matches.json"
        if not legacy.exists():
            raise HTTPException(status_code=404, detail=f"Matches not found for {slug}")
        path = legacy
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


@router.get("/api/tables/{slug}")
def api_tables(slug: str) -> List[Dict[str, Any]]:
    path = resolve_slug_file(slug, "{slug}.pages*.tables.jsonl")
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


@router.get("/api/gold")
def api_gold() -> List[Dict[str, Any]]:
    gold_path = DATASET_DIR / "gold.jsonl"
    if not gold_path.exists():
        raise HTTPException(status_code=404, detail="gold.jsonl not found")
    rows: List[Dict[str, Any]] = []
    with gold_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


@router.get("/pdf/{slug}")
def pdf_for_slug(slug: str):
    pdf_path = resolve_slug_file(slug, "{slug}.pages*.pdf")
    return FileResponse(str(pdf_path))
