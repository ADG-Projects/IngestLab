from __future__ import annotations

import json
import base64
import logging
import mimetypes
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Query

from chunking_pipeline.chunker import decode_orig_elements

from ..config import DEFAULT_PROVIDER, get_out_dir
from ..file_utils import resolve_slug_file

router = APIRouter()
logger = logging.getLogger("chunking.routes.elements")
_INDEX_CACHE: Dict[str, Dict[str, Any]] = {}


def _cache_key(slug: str, provider: str) -> str:
    return f"{provider}::{slug}"


def clear_index_cache(slug: str, provider: str) -> None:
    _INDEX_CACHE.pop(_cache_key(slug, provider), None)


def _resolve_elements_or_chunks_file(slug: str, provider: str) -> Tuple[Path, bool]:
    """Resolve elements file (v5.0+) or fall back to chunks file (legacy).

    Returns (path, is_elements) where is_elements indicates file type.
    """
    # Try elements file first (v5.0+)
    try:
        path = resolve_slug_file(slug, "{slug}.pages*.elements.jsonl", provider=provider)
        return path, True
    except HTTPException:
        pass

    # Fall back to chunks file (legacy pre-v5.0)
    try:
        path = resolve_slug_file(slug, "{slug}.pages*.chunks.jsonl", provider=provider)
        logger.debug(f"Using legacy chunks file for {slug}: {path}")
        return path, False
    except HTTPException:
        pass

    raise HTTPException(
        status_code=404,
        detail=f"No elements or chunks file found for {slug} (provider={provider})",
    )


def _index_from_elements_file(path: Path) -> Tuple[Dict[str, Dict[str, Any]], Dict[int, List[str]], Dict[str, int]]:
    """Build index from a v5.0+ elements.jsonl file."""
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
            coords = md.get("coordinates") or {}
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

    return by_id, by_page, type_counts


def _index_from_chunks_file(path: Path) -> Tuple[Dict[str, Dict[str, Any]], Dict[int, List[str]], Dict[str, int]]:
    """Build index from a legacy chunks.jsonl file.

    Handles two formats:
    1. Chunks with embedded orig_elements (Unstructured chunker output)
    2. Direct element-style chunks (Azure DI legacy output)
    """
    by_id: Dict[str, Dict[str, Any]] = {}
    by_page: Dict[int, List[str]] = {}
    type_counts: Dict[str, int] = {}
    seen_element_ids: set = set()

    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                chunk = json.loads(line)
            except json.JSONDecodeError:
                continue

            meta = chunk.get("metadata") or {}

            # Try to decode orig_elements first (Unstructured chunker format)
            try:
                orig_elements = decode_orig_elements(meta)
            except Exception:
                orig_elements = []

            if orig_elements:
                # Process embedded original elements
                for el in orig_elements:
                    element_id = el.get("element_id")
                    if not element_id or element_id in seen_element_ids:
                        continue
                    seen_element_ids.add(element_id)

                    el_type = el.get("type") or "Unknown"
                    md = el.get("metadata") or {}
                    coords = md.get("coordinates") or {}
                    pts = coords.get("points") or []

                    x = y = w = h = None
                    if pts:
                        xs = [p[0] for p in pts]
                        ys = [p[1] for p in pts]
                        x = min(xs)
                        y = min(ys)
                        w = max(xs) - x
                        h = max(ys) - y

                    page_trimmed = md.get("page_number") or (md.get("page_numbers") or [None])[0]
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
            else:
                # Treat chunk as a direct element (Azure DI legacy format)
                element_id = chunk.get("element_id")
                if not element_id or element_id in seen_element_ids:
                    continue
                seen_element_ids.add(element_id)

                el_type = chunk.get("type") or "Unknown"
                coords = meta.get("coordinates") or {}
                pts = coords.get("points") or []

                x = y = w = h = None
                if pts:
                    xs = [p[0] for p in pts]
                    ys = [p[1] for p in pts]
                    x = min(xs)
                    y = min(ys)
                    w = max(xs) - x
                    h = max(ys) - y

                page_trimmed = (
                    chunk.get("page_number")
                    or meta.get("page_number")
                    or (meta.get("page_numbers") or [None])[0]
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
                    "orig_id": meta.get("original_element_id"),
                }
                if isinstance(page_trimmed, int):
                    by_page.setdefault(page_trimmed, []).append(element_id)
                type_counts[el_type] = type_counts.get(el_type, 0) + 1

    return by_id, by_page, type_counts


def _ensure_index(slug: str, provider: str) -> Dict[str, Any]:
    key = _cache_key(slug, provider)
    path, is_elements = _resolve_elements_or_chunks_file(slug, provider)
    mtime = path.stat().st_mtime
    cached = _INDEX_CACHE.get(key)
    if cached and cached.get("mtime") == mtime and cached.get("path") == path:
        return cached

    if is_elements:
        by_id, by_page, type_counts = _index_from_elements_file(path)
    else:
        by_id, by_page, type_counts = _index_from_chunks_file(path)

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


def _scan_element(
    slug: str, element_id: str, provider: str, path: Optional[Path] = None
) -> Tuple[Optional[Dict[str, Any]], Optional[Path]]:
    if path:
        target = path
        is_elements = target.name.endswith(".elements.jsonl")
    else:
        target, is_elements = _resolve_elements_or_chunks_file(slug, provider)

    with target.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            if is_elements:
                # v5.0+ elements file - direct element lookup
                md = obj.get("metadata") or {}
                if obj.get("element_id") == element_id or md.get("original_element_id") == element_id:
                    return obj, target
            else:
                # Legacy chunks file - try orig_elements first, then direct element
                meta = obj.get("metadata") or {}
                try:
                    orig_elements = decode_orig_elements(meta)
                except Exception:
                    orig_elements = []

                if orig_elements:
                    for el in orig_elements:
                        el_md = el.get("metadata") or {}
                        if el.get("element_id") == element_id or el_md.get("original_element_id") == element_id:
                            return el, target
                else:
                    # Direct element format (Azure DI legacy)
                    if obj.get("element_id") == element_id or meta.get("original_element_id") == element_id:
                        return obj, target
    return None, target


def _build_image_payload(md: Dict[str, Any], base_dir: Path) -> Dict[str, Any]:
    image_base64 = md.get("image_base64")
    image_mime_type = md.get("image_mime_type")
    image_url = md.get("image_url")
    image_path = md.get("image_path")
    image_data_uri: Optional[str] = None
    source: Optional[str] = None

    if image_base64:
        image_data_uri = f"data:{image_mime_type or 'image/png'};base64,{image_base64}"
        source = "payload"
    elif image_path:
        resolved = Path(image_path)
        if not resolved.is_absolute():
            resolved = base_dir / image_path
        if resolved.exists():
            try:
                blob = resolved.read_bytes()
                mime = image_mime_type or mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
                b64 = base64.b64encode(blob).decode("ascii")
                image_data_uri = f"data:{mime};base64,{b64}"
                source = "file"
                image_mime_type = mime
                image_base64 = b64
                image_path = str(resolved)
            except Exception:
                pass

    return {
        "image_base64": image_base64,
        "image_mime_type": image_mime_type,
        "image_url": image_url,
        "image_path": image_path,
        "image_data_uri": image_data_uri,
        "image_source": source,
    }


@router.get("/api/element/{slug}/{element_id}")
def api_element(slug: str, element_id: str, provider: str = Query(default=None)) -> Dict[str, Any]:
    provider_key = provider or DEFAULT_PROVIDER
    obj, resolved_path = _scan_element(slug, element_id, provider_key)
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
            "image_base64": None,
            "image_mime_type": None,
            "image_url": None,
            "image_path": None,
            "image_data_uri": None,
        }
    md = obj.get("metadata", {})
    page_num = (
        obj.get("page_number")
        or md.get("page_number")
        or (md.get("page_numbers") or [None])[0]
    )
    image_payload = _build_image_payload(md, resolved_path.parent if resolved_path else Path("."))
    return {
        "element_id": obj.get("element_id"),
        "type": obj.get("type"),
        "page_number": page_num,
        "text": obj.get("text"),
        "text_as_html": md.get("text_as_html"),
        "expected_cols": md.get("expected_cols"),
        "coordinates": (md.get("coordinates") or {}),
        "original_element_id": md.get("original_element_id"),
        **image_payload,
    }
