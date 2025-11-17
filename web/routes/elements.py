from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query

from ..file_utils import resolve_slug_file

router = APIRouter()
_INDEX_CACHE: Dict[str, Dict[str, Any]] = {}


def clear_index_cache(slug: str) -> None:
    _INDEX_CACHE.pop(slug, None)


def _ensure_index(slug: str) -> Dict[str, Any]:
    path = resolve_slug_file(slug, "{slug}.pages*.tables.jsonl")
    mtime = path.stat().st_mtime
    cached = _INDEX_CACHE.get(slug)
    if cached and cached.get("mtime") == mtime and cached.get("path") == path:
        return cached

    by_id: Dict[str, Dict[str, Any]] = {}
    by_page: Dict[int, List[str]] = {}
    type_counts: Dict[str, int] = {}
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            element_id = obj.get("element_id")
            el_type = obj.get("type") or "Unknown"
            md = obj.get("metadata", {})
            coords = (md.get("coordinates") or {})
            pts = coords.get("points") or []
            if not element_id or not pts:
                continue
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            x = min(xs)
            y = min(ys)
            w = max(xs) - x
            h = max(ys) - y
            page_trimmed = (
                obj.get("page_number")
                or md.get("page_number")
                or (md.get("page_numbers") or [None])[0]
            )
            by_id[element_id] = {
                "page_trimmed": page_trimmed,
                "layout_w": coords.get("layout_width"),
                "layout_h": coords.get("layout_height"),
                "x": x,
                "y": y,
                "w": w,
                "h": h,
                "type": el_type,
                "orig_id": md.get("original_element_id"),
            }
            if isinstance(page_trimmed, int):
                by_page.setdefault(page_trimmed, []).append(element_id)
            type_counts[el_type] = type_counts.get(el_type, 0) + 1

    cached = {
        "mtime": mtime,
        "path": path,
        "by_id": by_id,
        "by_page": by_page,
        "type_counts": type_counts,
    }
    _INDEX_CACHE[slug] = cached
    return cached


@router.get("/api/elements/{slug}")
def api_elements(slug: str, ids: str = Query(..., description="Comma-separated element IDs")) -> Dict[str, Any]:
    wanted = [s for s in (ids or "").split(",") if s]
    idx = _ensure_index(slug)["by_id"]
    return {i: idx.get(i) for i in wanted if i in idx}


@router.get("/api/element_types/{slug}")
def api_element_types(slug: str) -> Dict[str, Any]:
    idx = _ensure_index(slug)
    counts = idx.get("type_counts", {})
    items = sorted(([k, int(v)] for k, v in counts.items()), key=lambda t: (-t[1], t[0]))
    return {"types": [{"type": k, "count": v} for k, v in items]}


@router.get("/api/boxes/{slug}")
def api_boxes(
    slug: str,
    page: int = Query(..., ge=1),
    types: Optional[str] = Query(None, description="Comma-separated element types to include; omit for all"),
) -> Dict[str, Any]:
    cache = _ensure_index(slug)
    by_id = cache["by_id"]
    by_page = cache.get("by_page", {})
    ids = by_page.get(page, [])
    allowed: Optional[set] = None
    if types:
        allowed = {t.strip() for t in types.split(",") if t.strip()}
    result: Dict[str, Any] = {}
    for element_id in ids:
        entry = by_id.get(element_id)
        if not entry:
            continue
        if allowed and entry.get("type") not in allowed:
            continue
        result[element_id] = entry
    return result


def _scan_element(slug: str, element_id: str) -> Optional[Dict[str, Any]]:
    path = resolve_slug_file(slug, "{slug}.pages*.tables.jsonl")
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("element_id") == element_id or ((obj.get("metadata") or {}).get("original_element_id") == element_id):
                return obj
    return None


@router.get("/api/element/{slug}/{element_id}")
def api_element(slug: str, element_id: str) -> Dict[str, Any]:
    obj = _scan_element(slug, element_id)
    if not obj:
        raise HTTPException(status_code=404, detail=f"Element {element_id} not found")
    md = obj.get("metadata", {})
    page_num = (
        obj.get("page_number")
        or md.get("page_number")
        or (md.get("page_numbers") or [None])[0]
    )
    return {
        "element_id": obj.get("element_id"),
        "type": obj.get("type"),
        "page_number": page_num,
        "text": obj.get("text"),
        "text_as_html": md.get("text_as_html"),
        "expected_cols": md.get("expected_cols"),
        "coordinates": (md.get("coordinates") or {}),
        "original_element_id": md.get("original_element_id"),
    }
