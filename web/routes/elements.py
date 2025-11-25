from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query

from ..config import DEFAULT_PROVIDER
from ..file_utils import resolve_slug_file

router = APIRouter()
_INDEX_CACHE: Dict[str, Dict[str, Any]] = {}


def _cache_key(slug: str, provider: str) -> str:
    return f"{provider}::{slug}"


def clear_index_cache(slug: str, provider: str) -> None:
    _INDEX_CACHE.pop(_cache_key(slug, provider), None)


def _ensure_index(slug: str, provider: str) -> Dict[str, Any]:
    key = _cache_key(slug, provider)
    path = resolve_slug_file(slug, "{slug}.pages*.chunks.jsonl", provider=provider)
    mtime = path.stat().st_mtime
    cached = _INDEX_CACHE.get(key)
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
            if not element_id:
                continue
            x = y = w = h = None
            if pts:
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
                "x": x if x is not None else 0,
                "y": y if y is not None else 0,
                "w": w if w is not None else 0,
                "h": h if h is not None else 0,
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
    _INDEX_CACHE[key] = cached
    return cached


@router.get("/api/elements/{slug}")
def api_elements(
    slug: str,
    ids: str = Query(..., description="Comma-separated element IDs"),
    provider: str = Query(default=None, description="Data provider id"),
) -> Dict[str, Any]:
    wanted = [s for s in (ids or "").split(",") if s]
    provider_key = provider or DEFAULT_PROVIDER
    idx = _ensure_index(slug, provider_key)["by_id"]
    return {i: idx.get(i) for i in wanted if i in idx}


@router.get("/api/element_types/{slug}")
def api_element_types(slug: str, provider: str = Query(default=None)) -> Dict[str, Any]:
    provider_key = provider or DEFAULT_PROVIDER
    idx = _ensure_index(slug, provider_key)
    counts = idx.get("type_counts", {})
    items = sorted(([k, int(v)] for k, v in counts.items()), key=lambda t: (-t[1], t[0]))
    return {"types": [{"type": k, "count": v} for k, v in items]}


@router.get("/api/boxes/{slug}")
def api_boxes(
    slug: str,
    page: int = Query(..., ge=1),
    types: Optional[str] = Query(None, description="Comma-separated element types to include; omit for all"),
    provider: str = Query(default=None),
) -> Dict[str, Any]:
    provider_key = provider or DEFAULT_PROVIDER
    cache = _ensure_index(slug, provider_key)
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


def _scan_element(slug: str, element_id: str, provider: str) -> Optional[Dict[str, Any]]:
    path = resolve_slug_file(slug, "{slug}.pages*.chunks.jsonl", provider=provider)
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            md = obj.get("metadata") or {}
            if obj.get("element_id") == element_id or md.get("original_element_id") == element_id:
                return obj
    return None


@router.get("/api/element/{slug}/{element_id}")
def api_element(slug: str, element_id: str, provider: str = Query(default=None)) -> Dict[str, Any]:
    provider_key = provider or DEFAULT_PROVIDER
    obj = _scan_element(slug, element_id, provider_key)
    if not obj:
        return {
            "element_id": element_id,
            "type": "Unknown",
            "page_number": None,
            "text": "",
            "text_as_html": None,
            "expected_cols": None,
            "coordinates": {},
            "original_element_id": None,
        }
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
