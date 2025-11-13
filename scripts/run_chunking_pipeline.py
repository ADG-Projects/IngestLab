from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from chunking_pipeline.pages import parse_pages
from chunking_pipeline.pipeline import (
    partition_document,
    run_chunking,
    match_tables_to_gold,
)
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
    parser = argparse.ArgumentParser(description="Run Unstructured partitioning + optional chunking and gold matching")
    parser.add_argument("--input", required=True, help="Path to the input PDF file")
    parser.add_argument("--pages", required=True, help="Comma/range pages, e.g. '4-6' or '4,5,6'")
    parser.add_argument("--only-tables", action="store_true", help="Limit pipeline to elements of type Table")
    parser.add_argument("--strategy", default="auto", choices=["auto", "fast", "hi_res"], help="Unstructured PDF strategy")
    parser.add_argument("--output", help="JSONL output path for the primary elements (tables or chunks)")
    parser.add_argument("--trimmed-out", help="Optional path to save the trimmed PDF slice")
    parser.add_argument("--gold", help="Path to gold JSONL for table comparison")
    parser.add_argument("--doc-id", help="Optional doc_id in gold; defaults to matching by source path")
    parser.add_argument("--emit-matches", help="Path to write matching results JSON")
    parser.add_argument("--chunking", choices=["basic", "by_title"], default="by_title", help="Chunking strategy")
    parser.add_argument("--chunk-output", help="Optional JSONL output path for chunk elements (defaults to --output when chunking drives the match source)")
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
    parser.add_argument("--no-infer-table-structure", dest="infer_table_structure", action="store_false", help="Disable Unstructured infer_table_structure flag")
    parser.set_defaults(infer_table_structure=True)
    args = parser.parse_args(argv)

    pages = parse_pages(args.pages)
    chunk_elements: Optional[List[Dict[str, Any]]] = None
    chunk_summary: Optional[Dict[str, Any]] = None
    raw_elements: Optional[List[Any]] = None

    chunk_params: Dict[str, Any] = {}
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

    trimmed, raw_elements, dict_elements = partition_document(
        input_pdf=args.input,
        pages=pages,
        strategy=args.strategy,
        infer_table_structure=args.infer_table_structure,
        trimmed_out=args.trimmed_out,
    )
    args.trimmed_out = trimmed
    # Base partition elements (dict form) for UI overlays/types
    base_elements: List[Dict[str, Any]] = dict_elements

    if not raw_elements:
        raise SystemExit("Chunking requires partitioning the PDF in this run (no --input-jsonl)")
    chunk_input = raw_elements
    if args.only_tables:
        chunk_input = [el for el in raw_elements if getattr(el, "category", "") == "Table" or el.__class__.__name__ == "Table"]
    chunk_elements, chunk_summary = run_chunking(args.chunking, chunk_input, chunk_params)
    if not chunk_elements:
        raise SystemExit("Chunking produced no elements")
    match_elements = chunk_elements
    resolved_source = "chunks"

    run_config: Dict[str, Any] = {
        "strategy": args.strategy,
        "chunking": args.chunking,
        "match_source": resolved_source,
        "only_tables": args.only_tables,
        "infer_table_structure": args.infer_table_structure,
    }
    if chunk_params:
        run_config["chunk_params"] = chunk_params
    if chunk_summary:
        run_config["chunk_summary"] = chunk_summary

    # Persist base partition elements for UI element overlays/types
    if args.output:
        write_jsonl(args.output, base_elements)
    # Persist chunk elements separately when available
    if args.chunk_output and chunk_elements:
        write_jsonl(args.chunk_output, chunk_elements)

    overall: Dict[str, Any] = {}
    matches: List[Dict[str, Any]] = []
    if args.gold:
        overall, matches = match_tables_to_gold(match_elements, pages, args.gold, args.input, args.doc_id)

    payload = {"matches": matches, "overall": overall, "run_config": run_config}
    if args.emit_matches:
        os.makedirs(os.path.dirname(args.emit_matches), exist_ok=True)
        with open(args.emit_matches, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
    else:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
