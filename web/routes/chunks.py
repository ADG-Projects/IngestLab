from __future__ import annotations

import json
import re
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Query

from chunking_pipeline.chunker import decode_orig_elements

from ..config import DEFAULT_PROVIDER, get_out_dir

router = APIRouter()


def _resolve_chunk_file(slug: str, provider: str) -> Path:
    out_dir = get_out_dir(provider)
    path = out_dir / f"{slug}.chunks.jsonl"
    if path.exists():
        return path
    base, sep, rest = slug.partition(".pages")
    if sep:
        candidate = out_dir / f"{base}.pages{rest}.chunks.jsonl"
        if candidate.exists():
            return candidate
    raise HTTPException(status_code=404, detail=f"Chunk file not found for {slug}")


@router.get("/api/chunks/{slug}")
def api_chunks(slug: str, provider: str = Query(default=None)) -> Dict[str, Any]:
    path = _resolve_chunk_file(slug, provider or DEFAULT_PROVIDER)
    chunks: List[Dict[str, Any]] = []
    count = 0
    total = 0
    min_len: Optional[int] = None
    max_len: Optional[int] = None
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            text = obj.get("text") or ""
            length = len(text)
            count += 1
            total += length
            min_len = length if min_len is None else min(min_len, length)
            max_len = length if max_len is None else max(max_len, length)
            meta = obj.get("metadata") or {}
            orig_boxes: List[Dict[str, Any]] = []
            orig_table_html: Optional[str] = None
            orig_html_is_table = False
            try:
                decoded = decode_orig_elements(meta)
            except Exception:
                decoded = []
            for el in decoded:
                md = el.get("metadata") or {}
                coords = (md.get("coordinates") or {})
                pts = coords.get("points") or []
                if not pts:
                    continue
                xs = [p[0] for p in pts]
                ys = [p[1] for p in pts]
                x = min(xs)
                y = min(ys)
                w = max(xs) - x
                h = max(ys) - y
                page_trimmed = md.get("page_number") or (md.get("page_numbers") or [None])[0]
                box_entry = {
                    "page_trimmed": page_trimmed,
                    "layout_w": coords.get("layout_width"),
                    "layout_h": coords.get("layout_height"),
                    "x": x,
                    "y": y,
                    "w": w,
                    "h": h,
                    "type": el.get("type") or md.get("category"),
                    "element_id": el.get("element_id"),
                    "orig_id": md.get("original_element_id"),
                }
                orig_boxes.append(box_entry)
                html_candidate = md.get("text_as_html") or el.get("text_as_html")
                if html_candidate:
                    is_table = "table" in (el.get("type") or "").lower()
                    if not orig_table_html or (is_table and not orig_html_is_table):
                        orig_table_html = html_candidate
                        orig_html_is_table = is_table
            bbox = None
            try:
                ccoords = (meta.get("coordinates") or {})
                pts = ccoords.get("points") or []
                if pts:
                    xs = [p[0] for p in pts]
                    ys = [p[1] for p in pts]
                    x = min(xs)
                    y = min(ys)
                    w = max(xs) - x
                    h = max(ys) - y
                    page_trimmed = meta.get("page_number") or (meta.get("page_numbers") or [None])[0]
                    bbox = {
                        "page_trimmed": page_trimmed,
                        "layout_w": ccoords.get("layout_width"),
                        "layout_h": ccoords.get("layout_height"),
                        "x": x,
                        "y": y,
                        "w": w,
                        "h": h,
                    }
            except Exception:
                bbox = None
            segment_bbox = None
            segment_span_info: Optional[Tuple[int, int, int]] = None
            if orig_table_html:
                reference_bbox = _pick_table_bbox(orig_boxes) or bbox
                seg_info = _compute_table_segment(meta, obj, orig_table_html, reference_bbox)
                if seg_info:
                    segment_bbox, span, total_rows = seg_info
                    segment_span_info = (span[0], span[1], total_rows)
                    if segment_bbox and reference_bbox and not segment_bbox.get("page_trimmed"):
                        segment_bbox["page_trimmed"] = reference_bbox.get("page_trimmed")
            chunk_entry: Dict[str, Any] = {
                "element_id": obj.get("element_id"),
                "text": text,
                "char_len": length,
                "type": obj.get("type"),
                "metadata": meta,
                "orig_boxes": orig_boxes,
                "bbox": bbox,
            }
            if segment_bbox:
                chunk_entry["segment_bbox"] = segment_bbox
                if segment_span_info:
                    start_idx, end_idx, total_rows = segment_span_info
                    chunk_entry["segment_row_span"] = {
                        "start": start_idx,
                        "end": end_idx,
                        "total": total_rows,
                    }
            chunks.append(chunk_entry)
    summary = {
        "count": count,
        "total_chars": total,
        "min_chars": min_len or 0,
        "max_chars": max_len or 0,
        "avg_chars": (total / count) if count else 0,
    }
    return {"summary": summary, "chunks": chunks}


class _TableHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.rows: List[List[str]] = []
        self._current_row: List[str] = []
        self._current_cell: List[str] = []
        self._in_cell = False

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        tag = tag.lower()
        if tag == "tr":
            self._current_row = []
        elif tag in {"td", "th"}:
            self._in_cell = True
            self._current_cell = []
        elif tag == "br" and self._in_cell:
            self._current_cell.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"td", "th"}:
            if self._in_cell:
                text = unescape("".join(self._current_cell))
                self._current_row.append(text)
            self._current_cell = []
            self._in_cell = False
        elif tag == "tr":
            if any((cell or "").strip() for cell in self._current_row):
                self.rows.append(self._current_row)
            self._current_row = []

    def handle_data(self, data: str) -> None:
        if self._in_cell and data:
            self._current_cell.append(data)

    def handle_entityref(self, name: str) -> None:
        if self._in_cell:
            self._current_cell.append(unescape(f"&{name};"))

    def handle_charref(self, name: str) -> None:
        if self._in_cell:
            try:
                codepoint = int(name, 16) if name.lower().startswith("x") else int(name)
                self._current_cell.append(chr(codepoint))
            except ValueError:
                pass


def _collect_table_rows(html_text: Optional[str]) -> List[str]:
    if not html_text:
        return []
    parser = _TableHTMLParser()
    try:
        parser.feed(html_text)
        parser.close()
    except Exception:
        return []
    rows: List[str] = []
    for cells in parser.rows:
        joined = " ".join((cell or "").strip() for cell in cells if (cell or "").strip())
        normalized = re.sub(r"\s+", " ", joined.replace("\xa0", " ")).strip()
        if normalized:
            rows.append(normalized)
    return rows


def _normalize_row(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").replace("\xa0", " ")).strip().lower()


def _rows_match(a: str, b: str) -> bool:
    if not a or not b:
        return False
    if a == b:
        return True
    return a in b or b in a


def _find_row_span(orig_rows: List[str], chunk_rows: List[str]) -> Optional[Tuple[int, int]]:
    if not orig_rows or not chunk_rows:
        return None
    haystack = [_normalize_row(r) for r in orig_rows]
    needle = [_normalize_row(r) for r in chunk_rows]
    n = len(needle)
    if n == 0 or len(haystack) < n:
        return None
    for start in range(len(haystack) - n + 1):
        matches = True
        for offset in range(n):
            if not _rows_match(haystack[start + offset], needle[offset]):
                matches = False
                break
        if matches:
            return start, start + n
    first = needle[0]
    last = needle[-1]
    start_idx = next((i for i, row in enumerate(haystack) if _rows_match(row, first)), None)
    if start_idx is None:
        return None
    if n == 1:
        return start_idx, start_idx + 1
    end_idx = next((i for i in range(start_idx + 1, len(haystack)) if _rows_match(haystack[i], last)), None)
    if end_idx is None:
        end_idx = min(len(haystack), start_idx + n)
    else:
        end_idx += 1
    if end_idx <= start_idx:
        return None
    return start_idx, min(len(haystack), end_idx)


def _slice_bbox(
    bbox: Optional[Dict[str, Any]],
    total_rows: int,
    row_span: Tuple[int, int],
    weights: Optional[List[float]] = None,
) -> Optional[Dict[str, Any]]:
    if not bbox or not total_rows:
        return None
    x = bbox.get("x")
    y = bbox.get("y")
    w = bbox.get("w")
    h = bbox.get("h")
    if any(val is None for val in (x, y, w, h)):
        return None
    start, end = row_span
    if start < 0 or end <= start or end > total_rows:
        return None
    seg_y = y
    seg_h = 0.0
    if weights and len(weights) == total_rows:
        total_weight = sum(weights)
        if total_weight <= 0:
            weights = None
    if weights and len(weights) == total_rows:
        acc = [0.0]
        running = 0.0
        for wgt in weights:
            running += max(float(wgt), 0.0)
            acc.append(running)
        total_weight = acc[-1] or 1.0
        start_w = acc[start]
        end_w = acc[end]
        seg_y = y + h * (start_w / total_weight)
        seg_h = h * max((end_w - start_w) / total_weight, 0.0)
    else:
        row_height = h / total_rows
        seg_y = y + row_height * start
        seg_h = row_height * (end - start)
    if seg_h <= 0:
        return None
    return {
        "page_trimmed": bbox.get("page_trimmed"),
        "layout_w": bbox.get("layout_w"),
        "layout_h": bbox.get("layout_h"),
        "x": x,
        "y": seg_y,
        "w": w,
        "h": seg_h,
    }


def _pick_table_bbox(orig_boxes: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for box in orig_boxes:
        t = (box.get("type") or "").lower()
        if "table" in t:
            return box
    return None


def _compute_table_segment(
    meta: Dict[str, Any],
    chunk: Dict[str, Any],
    table_html: Optional[str],
    reference_bbox: Optional[Dict[str, Any]],
) -> Optional[Tuple[Dict[str, Any], Tuple[int, int], int]]:
    if not (table_html and reference_bbox):
        return None
    chunk_html = (meta.get("text_as_html") or chunk.get("text_as_html") or "")
    if "<table" not in chunk_html.lower():
        return None
    orig_rows = _collect_table_rows(table_html)
    row_weights = [max(len(r), 1) for r in orig_rows]
    chunk_rows = _collect_table_rows(chunk_html)
    if not orig_rows or not chunk_rows:
        return None
    span = _find_row_span(orig_rows, chunk_rows)
    if not span:
        return None
    sliced = _slice_bbox(reference_bbox, len(orig_rows), span, row_weights)
    if not sliced:
        return None
    return sliced, span, len(orig_rows)
