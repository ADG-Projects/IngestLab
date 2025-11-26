from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from unstructured_client import UnstructuredClient
from unstructured_client.models.operations import PartitionRequest
from unstructured_client.models.shared import Files, PartitionParameters

from .chunker import ensure_stable_element_id
from .pages import parse_pages, slice_pdf


def write_jsonl(path: str, elements: List[Dict[str, Any]]) -> None:
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


def _default_api_url() -> str:
    return os.environ.get("UNSTRUCTURED_PARTITION_API_URL") or os.environ.get("UNSTRUCTURED_API_URL") or "https://api.unstructured.io/general/v0/general"


def _default_api_key() -> str:
    return os.environ.get("UNSTRUCTURED_PARTITION_API_KEY") or os.environ.get("UNSTRUCTURED_API_KEY") or ""


def _extract_elements(payload: Any) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return [el for el in payload if isinstance(el, dict)]
    if isinstance(payload, dict):
        if isinstance(payload.get("elements"), list):
            return [el for el in payload.get("elements") or [] if isinstance(el, dict)]
        if isinstance(payload.get("data"), list):
            return [el for el in payload.get("data") or [] if isinstance(el, dict)]
    return []


def _normalize_coordinates(md: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    coords = md.get("coordinates")
    if not coords:
        return None
    if isinstance(coords, dict):
        pts = coords.get("points") or []
        if pts:
            layout_w = coords.get("layout_width")
            layout_h = coords.get("layout_height")
            system = coords.get("system")
            return {"points": pts, "layout_width": layout_w, "layout_height": layout_h, "system": system}
        return None
    if isinstance(coords, list) and coords:
        first = coords[0]
        if isinstance(first, dict) and first.get("points"):
            pts = first.get("points") or []
            layout_w = first.get("layout_width")
            layout_h = first.get("layout_height")
            system = first.get("system")
            return {"points": pts, "layout_width": layout_w, "layout_height": layout_h, "system": system}
    return None


def partition_via_api(
    trimmed_pdf: str,
    strategy: str,
    languages: Optional[List[str]],
    api_url: str,
    api_key: str,
    extract_image_block_types: Optional[List[str]],
    extract_image_block_to_payload: Optional[bool],
) -> List[Dict[str, Any]]:
    if not api_key:
        raise SystemExit("UNSTRUCTURED_PARTITION_API_KEY (or UNSTRUCTURED_API_KEY) is required")

    client = UnstructuredClient(api_key_auth=api_key, server_url=api_url)
    with open(trimmed_pdf, "rb") as fh:
        file_bytes = fh.read()

    file_obj = Files(content=file_bytes, file_name=Path(trimmed_pdf).name, content_type="application/pdf")
    params = PartitionParameters(
        files=file_obj,
        strategy=strategy,
        coordinates=True,
        languages=languages,
        chunking_strategy=None,
        extract_image_block_types=extract_image_block_types,
        extract_image_block_to_payload=extract_image_block_to_payload,
    )
    request = PartitionRequest(partition_parameters=params, unstructured_api_key=api_key)
    resp = client.general.partition(request=request)
    if resp.status_code and resp.status_code >= 400:
        raise SystemExit(f"Partition API failed ({resp.status_code})")
    elements = resp.elements or []
    normalized: List[Dict[str, Any]] = []
    for raw in elements:
        if not isinstance(raw, dict):
            continue
        md = raw.get("metadata") or {}
        page_num = md.get("page_number") or (md.get("page_numbers") or [None])[0]
        coords = _normalize_coordinates(md)
        if coords:
            md["coordinates"] = coords
        entry: Dict[str, Any] = {
            "type": raw.get("type") or raw.get("category") or "Unknown",
            "text": raw.get("text") or "",
            "metadata": md,
        }
        if page_num is not None:
            entry["page_number"] = page_num
        ensure_stable_element_id(entry)
        normalized.append(entry)
    return normalized


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Run Unstructured Partition API (elements only)")
    parser.add_argument("--input", required=True, help="Path to input PDF")
    parser.add_argument("--pages", required=True, help="Page ranges, e.g., 1-3 or 2,4")
    parser.add_argument("--trimmed-out", required=True, help="Path to write trimmed PDF slice")
    parser.add_argument("--chunk-output", required=True, help="Path to write elements JSONL (UI expects *.chunks.jsonl)")
    parser.add_argument(
        "--strategy",
        choices=["auto", "fast", "hi_res", "ocr_only", "vlm"],
        default="auto",
        help="Partition strategy",
    )
    parser.add_argument("--languages", help="Comma-separated language hints (e.g., en,ar)")
    parser.add_argument("--partition-url", default=None, help="Override Partition API URL (defaults to UNSTRUCTURED_PARTITION_API_URL or UNSTRUCTURED_API_URL)")
    parser.add_argument("--api-key", default=None, help="Override Partition API key (defaults to UNSTRUCTURED_PARTITION_API_KEY or UNSTRUCTURED_API_KEY)")
    parser.add_argument("--run-metadata-out", help="Optional path to write run metadata JSON")
    parser.add_argument("--extract-image-block-types", help="Comma-separated list (e.g., Image,Table) to request extracted image blocks")
    parser.add_argument("--extract-image-block-to-payload", action="store_true", help="Embed extracted image blocks as base64 in the response payload")
    args = parser.parse_args(argv)

    pages = parse_pages(args.pages)
    trimmed_pdf = slice_pdf(args.input, pages, args.trimmed_out)
    api_url = args.partition_url or _default_api_url()
    api_key = args.api_key or _default_api_key()
    lang_list: Optional[List[str]] = None
    if args.languages:
        lang_list = [part.strip() for part in args.languages.split(",") if part.strip()]
    img_block_types: Optional[List[str]] = None
    if args.extract_image_block_types:
        img_block_types = [part.strip() for part in args.extract_image_block_types.split(",") if part.strip()]

    elements = partition_via_api(
        trimmed_pdf=trimmed_pdf,
        strategy=args.strategy,
        languages=lang_list,
        api_url=api_url,
        api_key=api_key,
        extract_image_block_types=img_block_types,
        extract_image_block_to_payload=True if args.extract_image_block_to_payload else None,
    )
    if not elements:
        raise SystemExit("Partition API returned no elements")

    write_jsonl(args.chunk_output, elements)

    run_config = {
        "provider": "unstructured-partition",
        "input": args.input,
        "trimmed_pdf": trimmed_pdf,
        "pages": args.pages,
        "strategy": args.strategy,
        "languages": lang_list,
        "partition_url": api_url,
        "extract_image_block_types": img_block_types,
        "extract_image_block_to_payload": bool(args.extract_image_block_to_payload),
    }
    write_run_metadata(args.run_metadata_out, run_config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
