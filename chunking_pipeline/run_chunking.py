from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

from .pages import parse_pages
from .pipeline import partition_document, run_chunking

CHUNK_DEFAULTS = {
    "max_characters": 500,
    "overlap": 0,
    "overlap_all": False,
    "include_orig_elements": True,
}
BY_TITLE_DEFAULTS = {
    "multipage_sections": True,
}


def write_jsonl(path: Optional[str], elements: List[Dict[str, Any]]) -> None:
    if not path:
        for el in elements:
            sys.stdout.write(json.dumps(el, ensure_ascii=False) + "\n")
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for el in elements:
            fh.write(json.dumps(el, ensure_ascii=False) + "\n")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Run Unstructured partitioning + optional chunking")
    parser.add_argument("--input", required=True, help="Path to the input PDF file")
    parser.add_argument("--pages", required=True, help="Comma/range pages, e.g. '4-6' or '4,5,6'")
    parser.add_argument("--only-tables", action="store_true", help="(Deprecated) no-op; kept for CLI compatibility")
    parser.add_argument("--strategy", default="auto", choices=["auto", "fast", "hi_res"], help="Unstructured PDF strategy")
    parser.add_argument("--trimmed-out", help="Optional path to save the trimmed PDF slice")
    parser.add_argument("--chunking", choices=["basic", "by_title", "none"], default="none", help="Chunking strategy (use 'none' to skip chunking and keep raw elements)")
    parser.add_argument("--elements-output", help="Path to write elements JSONL output")
    parser.add_argument("--chunk-output", help="(Deprecated) Alias for --elements-output for backward compatibility")
    parser.add_argument("--chunk-max-characters", type=int, help="Max characters per chunk")
    parser.add_argument("--chunk-new-after-n-chars", type=int, help="Force a new chunk after N chars")
    parser.add_argument("--chunk-combine-under-n-chars", type=int, help="Combine small sections under N chars")
    parser.add_argument("--chunk-overlap", type=int, help="Character overlap between consecutive chunks")
    parser.add_argument("--chunk-include-orig-elements", dest="chunk_include_orig_elements", action="store_true", default=None, help="Include orig_elements metadata on chunks")
    parser.add_argument("--chunk-no-include-orig-elements", dest="chunk_include_orig_elements", action="store_false", help="Disable orig_elements metadata on chunks")
    parser.add_argument("--chunk-overlap-all", dest="chunk_overlap_all", action="store_true", default=None, help="Apply overlap to every chunk")
    parser.add_argument("--chunk-no-overlap-all", dest="chunk_overlap_all", action="store_false", help="Only overlap when a chunk exceeds max characters")
    parser.add_argument("--chunk-multipage-sections", dest="chunk_multipage_sections", action="store_true", default=None, help="Allow chunks to span multiple pages (by_title only)")
    parser.add_argument("--chunk-no-multipage-sections", dest="chunk_multipage_sections", action="store_false", help="Force new chunk on page break (by_title only)")
    parser.add_argument("--ocr-languages", default="eng+ara", help="Languages passed to Tesseract OCR (e.g., 'eng+ara')")
    parser.add_argument("--languages", help="Comma-separated ISO language codes passed to partition_pdf (e.g., 'en,ar')")
    parser.add_argument("--detect-language-per-element", dest="detect_language_per_element", action="store_true", help="Enable language detection per element")
    parser.add_argument("--no-detect-language-per-element", dest="detect_language_per_element", action="store_false", help="Disable per-element language detection")
    parser.set_defaults(detect_language_per_element=False)
    parser.add_argument("--primary-language", choices=["eng", "ara"], help="Primary document language (metadata hint)")
    parser.add_argument("--no-infer-table-structure", dest="infer_table_structure", action="store_false", help="Disable Unstructured infer_table_structure flag")
    parser.set_defaults(infer_table_structure=True)
    args = parser.parse_args(argv)

    pages = parse_pages(args.pages)
    chunk_elements: Optional[List[Dict[str, Any]]] = None
    chunk_summary: Optional[Dict[str, Any]] = None
    raw_elements: Optional[List[Any]] = None

    chunk_params: Dict[str, Any] = {}
    if args.chunking != "none":
        if args.chunk_max_characters is not None:
            chunk_params["max_characters"] = args.chunk_max_characters
        if args.chunk_new_after_n_chars is not None:
            chunk_params["new_after_n_chars"] = args.chunk_new_after_n_chars
        if args.chunk_combine_under_n_chars is not None:
            chunk_params["combine_text_under_n_chars"] = args.chunk_combine_under_n_chars
        if args.chunk_overlap is not None:
            chunk_params["overlap"] = args.chunk_overlap
        if args.chunk_include_orig_elements is not None:
            chunk_params["include_orig_elements"] = args.chunk_include_orig_elements
        if args.chunk_overlap_all is not None:
            chunk_params["overlap_all"] = args.chunk_overlap_all
        if args.chunk_multipage_sections is not None:
            chunk_params["multipage_sections"] = args.chunk_multipage_sections

        final_max_characters = chunk_params.get("max_characters")
        if final_max_characters is None:
            final_max_characters = CHUNK_DEFAULTS["max_characters"]
            chunk_params["max_characters"] = final_max_characters

        if "new_after_n_chars" not in chunk_params:
            chunk_params["new_after_n_chars"] = final_max_characters

        for key in ("overlap", "overlap_all", "include_orig_elements"):
            if key not in chunk_params:
                chunk_params[key] = CHUNK_DEFAULTS[key]

        if args.chunking == "by_title":
            if "combine_text_under_n_chars" not in chunk_params:
                chunk_params["combine_text_under_n_chars"] = chunk_params["max_characters"]
            if "multipage_sections" not in chunk_params:
                chunk_params["multipage_sections"] = BY_TITLE_DEFAULTS["multipage_sections"]

    languages: Optional[List[str]] = None
    if args.languages:
        languages = [part.strip() for part in args.languages.split(",") if part.strip()]

    primary_language = args.primary_language

    trimmed, raw_elements, dict_elements = partition_document(
        input_pdf=args.input,
        pages=pages,
        strategy=args.strategy,
        infer_table_structure=args.infer_table_structure,
        trimmed_out=args.trimmed_out,
        ocr_languages=args.ocr_languages,
        languages=languages,
        detect_language_per_element=args.detect_language_per_element,
    )
    args.trimmed_out = trimmed

    base_elements: List[Dict[str, Any]] = dict_elements

    if not raw_elements:
        raise SystemExit("Chunking requires partitioning the PDF in this run (no --input-jsonl)")

    chunk_input = raw_elements
    if args.only_tables:
        chunk_input = [el for el in raw_elements if getattr(el, "category", "") == "Table" or el.__class__.__name__ == "Table"]
    if args.chunking != "none":
        chunk_elements, chunk_summary = run_chunking(args.chunking, chunk_input, chunk_params)
        if not chunk_elements:
            raise SystemExit("Chunking produced no elements")
        match_elements = chunk_elements
        resolved_source = "chunks"
    else:
        chunk_elements = dict_elements  # preserve overlays even when chunking is disabled
        lengths = [len(el.get("text") or "") for el in chunk_elements if isinstance(el, dict)]
        if lengths:
            chunk_summary = {
                "count": len(lengths),
                "total_chars": sum(lengths),
                "min_chars": min(lengths),
                "max_chars": max(lengths),
                "avg_chars": sum(lengths) / len(lengths),
            }
        match_elements = chunk_input
        resolved_source = "orig_elements"

    # Write elements output (--elements-output preferred, fall back to --chunk-output for backward compatibility)
    output_path = args.elements_output or args.chunk_output
    if output_path and chunk_elements:
        write_jsonl(output_path, chunk_elements)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
