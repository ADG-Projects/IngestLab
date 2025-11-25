from __future__ import annotations

import argparse
import json
import os
import sys
import time
from html import escape
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.core.credentials import AzureKeyCredential

from chunking_pipeline.chunker import ensure_stable_element_id
from chunking_pipeline.pages import parse_pages, resolve_pages_in_document, slice_pdf

DEFAULT_ENDPOINT_ENV = "AZURE_FT_ENDPOINT"
DEFAULT_KEY_ENV = "AZURE_FT_KEY"
ALT_ENDPOINT_ENVS = ("DOCUMENTINTELLIGENCE_ENDPOINT", "DI_ENDPOINT")
ALT_KEY_ENVS = ("DOCUMENTINTELLIGENCE_API_KEY", "DI_KEY")
DEFAULT_DI_API_VERSION = "2024-11-30"


def _load_local_env() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    root = Path(__file__).resolve().parents[1]
    for candidate in (root / ".env", root / ".env.local"):
        if candidate.exists():
            load_dotenv(candidate)


_load_local_env()


def _get_env_any(names: List[str]) -> str:
    for name in names:
        val = os.environ.get(name)
        if val:
            return val
    return ""


def write_jsonl(path: Optional[str], elements: List[Dict[str, Any]]) -> None:
    if not path:
        for el in elements:
            sys.stdout.write(json.dumps(el, ensure_ascii=False) + "\n")
        return
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for el in elements:
            fh.write(json.dumps(el, ensure_ascii=False) + "\n")


def write_run_metadata(path: Optional[str], run_config: Dict[str, Any]) -> None:
    if not path:
        return
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8") as fh:
        json.dump(run_config, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def _convert_units(value: Optional[float], unit: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    if not unit:
        return value
    unit = unit.lower()
    if unit == "inch":
        return value * 72.0
    if unit in {"pixel", "pixelspace"}:
        return value
    if unit == "foot":
        return value * 72.0 * 12.0
    if unit in {"millimeter", "millimetre", "mm"}:
        return value * (72.0 / 25.4)
    return value


def _bbox_from_polygon(poly: Optional[List[float]]) -> Optional[Tuple[float, float, float, float]]:
    if not poly:
        return None
    if len(poly) % 2 != 0:
        return None
    xs = poly[0::2]
    ys = poly[1::2]
    return min(xs), min(ys), max(xs), max(ys)


def _coords_from_polygon(
    poly: Optional[List[float]],
    layout_w: Optional[float],
    layout_h: Optional[float],
    unit: Optional[str],
) -> Optional[Dict[str, Any]]:
    bbox = _bbox_from_polygon(poly or [])
    if not bbox or layout_w is None or layout_h is None:
        return None
    min_x, min_y, max_x, max_y = bbox
    converted = [_convert_units(v, unit) for v in (min_x, min_y, max_x, max_y)]
    if any(v is None for v in converted):
        return None
    min_x, min_y, max_x, max_y = converted
    return {
        "layout_width": layout_w,
        "layout_height": layout_h,
        "points": [[min_x, min_y], [min_x, max_y], [max_x, max_y], [max_x, min_y]],
        "system": "PixelSpace",
    }


def _table_html(table: Dict[str, Any]) -> str:
    rows = []
    row_count = table.get("row_count") or table.get("rowCount") or 0
    col_count = table.get("column_count") or table.get("columnCount") or 0
    cells = table.get("cells") or []
    cell_map: Dict[Tuple[int, int], str] = {}
    for cell in cells:
        r = cell.get("row_index") if "row_index" in cell else cell.get("rowIndex")
        c = cell.get("column_index") if "column_index" in cell else cell.get("columnIndex")
        if r is None or c is None:
            continue
        cell_map[(int(r), int(c))] = escape(str(cell.get("content") or ""))
    for r in range(int(row_count or 0)):
        tds = []
        for c in range(int(col_count or 0)):
            tds.append(f"<td>{cell_map.get((r, c), '')}</td>")
        rows.append("<tr>" + "".join(tds) + "</tr>")
    return "<table><tbody>" + "".join(rows) + "</tbody></table>"


def _extract_analyze_result(payload: Any) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    if "analyze_result" in payload:
        return payload.get("analyze_result") or {}
    if "analyzeResult" in payload:
        return payload.get("analyzeResult") or {}
    if "result" in payload and isinstance(payload["result"], dict):
        inner = payload["result"]
        if "analyzeResult" in inner:
            return inner.get("analyzeResult") or {}
        return inner
    return payload


def _extract_detected_languages(an_result: Dict[str, Any]) -> List[Dict[str, Any]]:
    def _as_float(value: Any) -> Optional[float]:
        try:
            return float(value)
        except Exception:
            return None

    def _push(locale: Optional[str], confidence: Optional[float], acc: List[Dict[str, Any]], seen: set) -> None:
        if not locale:
            return
        code = str(locale).strip()
        if not code:
            return
        key = code.lower()
        if key in seen:
            return
        seen.add(key)
        acc.append({"locale": code, "confidence": confidence})

    def _parse_entry(entry: Any, acc: List[Dict[str, Any]], seen: set) -> None:
        if not entry:
            return
        if isinstance(entry, str):
            _push(entry, None, acc, seen)
            return
        if isinstance(entry, dict):
            locale = (
                entry.get("locale")
                or entry.get("language")
                or entry.get("language_code")
                or entry.get("languageCode")
            )
            confidence = _as_float(entry.get("confidence") or entry.get("score"))
            _push(locale, confidence, acc, seen)

    detected: List[Dict[str, Any]] = []
    seen_locales: set = set()
    candidates = (
        an_result.get("languages")
        or an_result.get("detected_languages")
        or an_result.get("detectedLanguages")
    )
    if isinstance(candidates, list):
        for item in candidates:
            _parse_entry(item, detected, seen_locales)
    elif isinstance(candidates, dict):
        _parse_entry(candidates, detected, seen_locales)
    else:
        _parse_entry(candidates, detected, seen_locales)

    for doc in an_result.get("documents") or []:
        _parse_entry(doc.get("detected_languages") or doc.get("detectedLanguages"), detected, seen_locales)

    detected.sort(key=lambda item: (item.get("confidence") is not None, item.get("confidence") or 0), reverse=True)
    return detected


def _pick_primary_detected_language(detected: List[Dict[str, Any]]) -> Optional[str]:
    if not detected:
        return None
    preferred: Optional[str] = None
    for item in detected:
        locale = (item.get("locale") or "").strip()
        if not locale:
            continue
        norm = locale.lower()
        if norm.startswith("ar"):
            return "ara"
        if preferred is None:
            preferred = locale
    return preferred


def _page_layouts(an_result: Dict[str, Any]) -> Dict[int, Tuple[Optional[float], Optional[float], Optional[str]]]:
    layouts: Dict[int, Tuple[Optional[float], Optional[float], Optional[str]]] = {}
    for page in an_result.get("pages") or []:
        num = page.get("page_number") if "page_number" in page else page.get("pageNumber")
        unit = page.get("unit")
        width = _convert_units(page.get("width"), unit)
        height = _convert_units(page.get("height"), unit)
        if num is not None:
            layouts[int(num)] = (width, height, unit)
    return layouts


def normalize_elements(an_result: Dict[str, Any]) -> List[Dict[str, Any]]:
    elements: List[Dict[str, Any]] = []
    layouts = _page_layouts(an_result)
    for para in an_result.get("paragraphs") or []:
        regions = para.get("bounding_regions") or para.get("boundingRegions") or []
        region = regions[0] if regions else {}
        page_num = region.get("page_number") if "page_number" in region else region.get("pageNumber")
        layout_w, layout_h, unit = layouts.get(int(page_num or 0), (None, None, None))
        coords = _coords_from_polygon(region.get("polygon"), layout_w, layout_h, unit)
        if not coords:
            continue
        role = para.get("role")
        el_type = role or "Paragraph"
        el = {
            "type": el_type,
            "text": para.get("content"),
            "metadata": {"page_number": page_num, "coordinates": coords, "role": role},
        }
        ensure_stable_element_id(el)
        elements.append(el)
    for page in an_result.get("pages") or []:
        page_num = page.get("page_number") if "page_number" in page else page.get("pageNumber")
        layout_w, layout_h, unit = layouts.get(int(page_num or 0), (None, None, None))
        for line in page.get("lines") or []:
            coords = _coords_from_polygon(line.get("polygon"), layout_w, layout_h, unit)
            if not coords:
                continue
            el = {
                "type": "Line",
                "text": line.get("content"),
                "metadata": {"page_number": page_num, "coordinates": coords},
            }
            ensure_stable_element_id(el)
            elements.append(el)
        for mark in page.get("selection_marks") or page.get("selectionMarks") or []:
            coords = _coords_from_polygon(mark.get("polygon"), layout_w, layout_h, unit)
            if not coords:
                continue
            el = {
                "type": "SelectionMark",
                "text": mark.get("state"),
                "metadata": {"page_number": page_num, "coordinates": coords},
            }
            ensure_stable_element_id(el)
            elements.append(el)

    for table in an_result.get("tables") or []:
        regions = table.get("bounding_regions") or table.get("boundingRegions") or []
        region = regions[0] if regions else {}
        page_num = region.get("page_number") if "page_number" in region else region.get("pageNumber")
        layout_w, layout_h, unit = layouts.get(int(page_num or 0), (None, None, None))
        coords = _coords_from_polygon(region.get("polygon"), layout_w, layout_h, unit)
        html = _table_html(table)
        el = {
            "type": "Table",
            "text": table.get("content"),
            "metadata": {
                "page_number": page_num,
                "coordinates": coords,
                "text_as_html": html,
                "expected_cols": table.get("column_count") or table.get("columnCount"),
            },
        }
        ensure_stable_element_id(el)
        elements.append(el)

    if not elements and an_result.get("content"):
        el = {"type": "Document", "text": an_result.get("content"), "metadata": {"page_number": 1}}
        ensure_stable_element_id(el)
        elements.append(el)

    return elements


def _parse_features(raw: Optional[str]) -> Optional[List[str]]:
    if not raw:
        return None
    return [part.strip() for part in raw.split(",") if part.strip()]


def _parse_fields(raw: Optional[str]) -> Optional[List[str]]:
    if not raw:
        return None
    return [part.strip() for part in raw.split(",") if part.strip()]


def run_di_analysis(
    input_pdf: str,
    trimmed_pdf: str,
    model_id: str,
    api_version: str,
    pages: List[int],
    features: Optional[List[str]],
    locale: Optional[str],
    string_index_type: Optional[str],
    output_content_format: Optional[str],
    query_fields: Optional[List[str]],
    endpoint: str,
    key: str,
) -> Dict[str, Any]:
    client_kwargs: Dict[str, Any] = {}
    client_kwargs["api_version"] = api_version
    client = DocumentIntelligenceClient(endpoint=endpoint, credential=AzureKeyCredential(key), **client_kwargs)
    pages_arg: Optional[str] = None
    if pages:
        pages_arg = ",".join(str(p) for p in pages)
    with open(trimmed_pdf, "rb") as fh:
        poller = client.begin_analyze_document(
            model_id,
            body=fh,
            features=features or None,
            locale=locale or None,
            string_index_type=string_index_type or None,
            output_content_format=output_content_format or None,
            query_fields=query_fields or None,
            pages=pages_arg,
        )
        start = time.time()
        result = poller.result()
        logger = getattr(sys.modules.get(__name__), "logger", None)
        if logger:
            logger.info("DI analyze_document completed in %.2fs", time.time() - start)
        if hasattr(result, "as_dict"):
            return result.as_dict()  # type: ignore[no-any-return]
        if hasattr(result, "to_dict"):
            return result.to_dict()  # type: ignore[no-any-return]
        return result  # type: ignore[no-any-return]


def run_cu_analysis(trimmed_pdf: str, api_version: str, analyzer_id: str, endpoint: str, key: str) -> Dict[str, Any]:
    url = f"{endpoint}/authoring/analyze-document"
    params = {
        "api-version": api_version,
        "stringIndexType": "unicodeCodePoint",
        "analyzerId": analyzer_id,
    }
    response = requests.post(
        url,
        params=params,
        headers={
            "Ocp-Apim-Subscription-Key": key,
        },
        files={"file": ("document.pdf", open(trimmed_pdf, "rb"), "application/pdf")},
        timeout=900,
    )
    response.raise_for_status()
    return response.json()


def build_run_config(provider: str, args: argparse.Namespace, features: Optional[List[str]], endpoint: str) -> Dict[str, Any]:
    cfg: Dict[str, Any] = {
        "provider": provider,
        "input": args.input,
        "pages": args.pages,
        "endpoint": endpoint,
        "model_id": args.model_id,
        "api_version": args.api_version,
    }
    if provider == "azure-di":
        cfg["features"] = features or []
        if args.locale:
            cfg["locale"] = args.locale
        if args.string_index_type:
            cfg["string_index_type"] = args.string_index_type
        if args.output_content_format:
            cfg["output_content_format"] = args.output_content_format
        if args.query_fields:
            cfg["query_fields"] = args.query_fields
    if provider == "azure-cu":
        if args.analyzer_id:
            cfg["analyzer_id"] = args.analyzer_id
    if args.primary_language:
        cfg["primary_language"] = args.primary_language
    if args.ocr_languages:
        cfg["ocr_languages"] = args.ocr_languages
    if args.languages:
        cfg["languages"] = args.languages
    return cfg


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Run Azure Document Intelligence or Content Understanding")
    parser.add_argument("--provider", choices=["document_intelligence", "content_understanding"], default="document_intelligence", help="Azure provider to use")
    parser.add_argument("--input", required=True, help="Path to input PDF")
    parser.add_argument("--pages", required=True, help="Page ranges, e.g., 1-3 or 2,4")
    parser.add_argument("--output", help="Path to write elements JSONL (optional; omit to skip)")
    parser.add_argument("--trimmed-out", required=True, help="Path to write trimmed PDF")
    parser.add_argument("--emit-matches", help="(Deprecated) Path to write matches JSON")
    parser.add_argument("--model-id", dest="model_id", required=False, help="Model/Analyzer id")
    parser.add_argument("--api-version", dest="api_version", required=False, help="API version")
    parser.add_argument("--features", help="Comma-separated feature list")
    parser.add_argument("--locale", help="Locale hint")
    parser.add_argument("--string-index-type", help="String index type")
    parser.add_argument("--output-content-format", help="Content format")
    parser.add_argument("--query-fields", help="Comma-separated query fields")
    parser.add_argument("--analyzer-id", help="Content Understanding analyzer id (defaults to prebuilt-documentSearch)")
    parser.add_argument("--primary-language", choices=["eng", "ara"], help="Primary language override")
    parser.add_argument("--ocr-languages", default=None, help="OCR languages hint")
    parser.add_argument("--languages", default=None, help="Comma-separated language hints")
    parser.add_argument("--run-metadata-out", default=None, help="Optional path to write run metadata with detected languages")
    parser.add_argument("--endpoint", help="Override endpoint")
    parser.add_argument("--key", help="Override API key")
    args = parser.parse_args(argv)

    pages = parse_pages(args.pages)
    valid_pages, dropped_pages, max_page = resolve_pages_in_document(args.input, pages)
    if not valid_pages:
        raise SystemExit(f"No valid pages requested; {args.input} has {max_page} pages.")
    if dropped_pages:
        sys.stderr.write(f"Warning: dropping out-of-range pages {dropped_pages}; document has {max_page} pages.\n")
    trimmed = slice_pdf(args.input, valid_pages, args.trimmed_out, warn_on_drop=False)
    args.pages = ",".join(str(p) for p in valid_pages)
    di_pages = list(range(1, len(valid_pages) + 1))
    elems: List[Dict[str, Any]] = []

    provider = args.provider
    if provider == "document_intelligence":
        endpoint = args.endpoint or _get_env_any([DEFAULT_ENDPOINT_ENV, *ALT_ENDPOINT_ENVS])
        key = args.key or _get_env_any([DEFAULT_KEY_ENV, *ALT_KEY_ENVS])
        if not endpoint or not key:
            raise SystemExit("Document Intelligence requires endpoint/key env (AZURE_FT_ENDPOINT/AZURE_FT_KEY or DOCUMENTINTELLIGENCE_ENDPOINT/DOCUMENTINTELLIGENCE_API_KEY)")
        model_id = args.model_id or "prebuilt-layout"
        api_version = args.api_version or DEFAULT_DI_API_VERSION
        features = _parse_features(args.features)
        result = run_di_analysis(
            input_pdf=args.input,
            trimmed_pdf=trimmed,
            model_id=model_id,
            api_version=api_version,
            pages=di_pages,
            features=features,
            locale=args.locale,
            string_index_type=args.string_index_type,
            output_content_format=args.output_content_format,
            query_fields=_parse_fields(args.query_fields),
            endpoint=endpoint,
            key=key,
        )
        an_result = _extract_analyze_result(result)
        elems = normalize_elements(an_result)
        run_provider = "azure-di"
        args.api_version = api_version
        run_config = build_run_config(run_provider, args, features=features, endpoint=endpoint)
    else:
        endpoint = args.endpoint or os.environ.get(DEFAULT_ENDPOINT_ENV, "")
        key = args.key or os.environ.get(DEFAULT_KEY_ENV, "")
        if not endpoint or not key:
            raise SystemExit("Content Understanding requires endpoint/key env (AZURE_FT_ENDPOINT/AZURE_FT_KEY)")
        analyzer_id = args.analyzer_id or args.model_id or "prebuilt-documentSearch"
        api_version = args.api_version or "2025-11-01"
        raw = run_cu_analysis(trimmed_pdf=trimmed, api_version=api_version, analyzer_id=analyzer_id, endpoint=endpoint, key=key)
        an_result = _extract_analyze_result(raw)
        elems = normalize_elements(an_result)
        run_provider = "azure-cu"
        run_config = build_run_config(run_provider, args, features=_parse_features(args.features), endpoint=endpoint)

    detected_langs = _extract_detected_languages(an_result)
    if detected_langs:
        run_config["detected_languages"] = detected_langs
        primary_detected = _pick_primary_detected_language(detected_langs)
        if primary_detected:
            run_config["detected_primary_language"] = primary_detected

    write_run_metadata(args.run_metadata_out, run_config)

    if args.output:
        write_jsonl(args.output, elems)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
