from __future__ import annotations

import base64
import json
import zlib
from typing import Any, Dict, List, Optional, Tuple


def ensure_stable_element_id(element: Dict[str, Any]) -> None:
    import hashlib

    meta = element.get("metadata") or {}
    payload = {
        "type": element.get("type"),
        "text": element.get("text"),
        "text_as_html": meta.get("text_as_html"),
        "page_number": meta.get("page_number") or (meta.get("page_numbers") or [None])[0],
        "coordinates": meta.get("coordinates"),
    }
    serialized = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    digest = hashlib.sha1(serialized).hexdigest()[:16]
    stable_id = f"chunk-{digest}"
    original_id = element.get("element_id")
    if original_id and original_id != stable_id:
        meta = dict(meta)
        meta.setdefault("original_element_id", original_id)
        element["metadata"] = meta
    element["element_id"] = stable_id


def decode_orig_elements(meta: Dict[str, Any]) -> List[Dict[str, Any]]:
    payload = meta.get("orig_elements")
    if not payload:
        return []
    try:
        raw = zlib.decompress(base64.b64decode(payload))
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return []


def merge_coordinates(elements: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    points: List[Tuple[float, float]] = []
    layout_w = None
    layout_h = None
    for el in elements:
        coords = ((el.get("metadata") or {}).get("coordinates") or {})
        pts = coords.get("points")
        if pts:
            points.extend((float(x), float(y)) for x, y in pts)
            layout_w = layout_w or coords.get("layout_width")
            layout_h = layout_h or coords.get("layout_height")
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    bbox = [[min_x, min_y], [min_x, max_y], [max_x, max_y], [max_x, min_y]]
    return {
        "layout_width": layout_w,
        "layout_height": layout_h,
        "points": bbox,
        "system": "PixelSpace",
    }


def apply_coordinates_to_chunk(chunk: Dict[str, Any]) -> None:
    meta = chunk.get("metadata") or {}
    coord = meta.get("coordinates")
    if coord and coord.get("points"):
        return
    orig = decode_orig_elements(meta)
    merged = merge_coordinates(orig)
    if merged:
        meta = dict(meta)
        meta["coordinates"] = merged
        if "page_number" not in meta and orig:
            meta["page_number"] = (orig[0].get("metadata") or {}).get("page_number")
        chunk["metadata"] = meta
