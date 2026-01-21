"""Standalone Azure Document Intelligence CLI script.

This script provides a simplified CLI for Azure DI analysis using the shared
azure_pipeline module. For most use cases, use the main module directly:

    uv run python -m chunking_pipeline.azure_pipeline --help

This script exists for backwards compatibility and simpler invocation.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from src.extractors.azure_di import (
    extract_analyze_result,
    normalize_elements,
    parse_pages,
    resolve_pages_in_document,
    slice_pdf,
)

from chunking_pipeline.azure_pipeline import (
    DEFAULT_DI_API_VERSION,
    DEFAULT_ENDPOINT_ENV,
    DEFAULT_KEY_ENV,
    ALT_ENDPOINT_ENVS,
    ALT_KEY_ENVS,
    _get_env_any,
    _load_local_env,
    run_di_analysis,
    write_jsonl,
)


def _parse_features(raw: Optional[str]) -> Optional[List[str]]:
    """Parse comma-separated features into a list."""
    if raw is None:
        return None
    if isinstance(raw, list):
        vals = raw
    else:
        vals = str(raw).split(",")
    cleaned = [v.strip() for v in vals if str(v).strip()]
    return cleaned or None


def _parse_fields(raw: Optional[str]) -> Optional[List[str]]:
    """Parse comma-separated fields into a list."""
    if raw is None:
        return None
    vals = str(raw).split(",")
    cleaned = [v.strip() for v in vals if v.strip()]
    return cleaned or None


def build_run_config(
    provider: str,
    args: argparse.Namespace,
    *,
    features: Optional[List[str]],
    endpoint: str,
) -> Dict[str, Any]:
    """Build run configuration metadata."""
    cfg: Dict[str, Any] = {
        "provider": provider,
        "model_id": args.model_id,
        "api_version": args.api_version,
        "primary_language": args.primary_language,
        "ocr_languages": args.ocr_languages,
        "languages": _parse_fields(args.languages) if args.languages else None,
        "features": features,
        "endpoint": endpoint,
        "match_source": "elements",
    }
    if args.locale:
        cfg["locale"] = args.locale
    if args.string_index_type:
        cfg["string_index_type"] = args.string_index_type
    if args.output_content_format:
        cfg["output_content_format"] = args.output_content_format
    if args.query_fields:
        cfg["query_fields"] = _parse_fields(args.query_fields)
    if args.analyzer_id:
        cfg["analyzer_id"] = args.analyzer_id
    return cfg


def main(argv: Optional[List[str]] = None) -> int:
    """Main entry point for Azure Document Intelligence analysis."""
    _load_local_env()

    parser = argparse.ArgumentParser(
        description="Run Azure Document Intelligence analysis"
    )
    parser.add_argument(
        "--provider",
        choices=["document_intelligence"],
        default="document_intelligence",
    )
    parser.add_argument("--input", required=True, help="Path to input PDF")
    parser.add_argument("--pages", required=True, help="Page ranges, e.g., 1-3 or 2,4")
    parser.add_argument("--output", required=True, help="Path to write elements JSONL")
    parser.add_argument("--trimmed-out", required=True, help="Path to write trimmed PDF")
    parser.add_argument("--emit-matches", required=True, help="Path to write matches JSON")
    parser.add_argument("--model-id", dest="model_id", required=False, help="Model id")
    parser.add_argument(
        "--api-version", dest="api_version", required=False, help="API version"
    )
    parser.add_argument("--features", help="Comma-separated feature list")
    parser.add_argument("--locale", help="Locale hint")
    parser.add_argument("--string-index-type", help="String index type")
    parser.add_argument("--output-content-format", help="Content format")
    parser.add_argument("--query-fields", help="Comma-separated query fields")
    parser.add_argument(
        "--primary-language", choices=["eng", "ara"], help="Primary language override"
    )
    parser.add_argument("--ocr-languages", default=None, help="OCR languages hint")
    parser.add_argument(
        "--languages", default=None, help="Comma-separated language hints"
    )
    parser.add_argument("--analyzer-id", dest="analyzer_id", help="Custom analyzer ID")
    parser.add_argument("--endpoint", help="Override endpoint")
    parser.add_argument("--key", help="Override API key")
    args = parser.parse_args(argv)

    pages = parse_pages(args.pages)
    valid_pages, dropped_pages, max_page = resolve_pages_in_document(args.input, pages)
    if not valid_pages:
        raise SystemExit(f"No valid pages requested; {args.input} has {max_page} pages.")
    if dropped_pages:
        sys.stderr.write(
            f"Warning: dropping out-of-range pages {dropped_pages}; "
            f"document has {max_page} pages.\n"
        )

    trimmed = slice_pdf(args.input, valid_pages, args.trimmed_out, warn_on_drop=False)
    args.pages = ",".join(str(p) for p in valid_pages)
    di_pages = list(range(1, len(valid_pages) + 1))

    endpoint = args.endpoint or _get_env_any([DEFAULT_ENDPOINT_ENV, *ALT_ENDPOINT_ENVS])
    key = args.key or _get_env_any([DEFAULT_KEY_ENV, *ALT_KEY_ENVS])
    if not endpoint or not key:
        raise SystemExit(
            "Document Intelligence requires endpoint/key env "
            "(AZURE_FT_ENDPOINT/AZURE_FT_KEY or "
            "DOCUMENTINTELLIGENCE_ENDPOINT/DOCUMENTINTELLIGENCE_API_KEY)"
        )

    model_id = args.model_id or "prebuilt-layout"
    api_version = args.api_version or DEFAULT_DI_API_VERSION
    features = _parse_features(args.features)

    result, _, _ = run_di_analysis(
        input_pdf=args.input,
        trimmed_pdf=trimmed,
        model_id=model_id,
        api_version=api_version,
        pages=di_pages,
        features=features,
        outputs=None,
        locale=args.locale,
        string_index_type=args.string_index_type,
        output_content_format=args.output_content_format,
        query_fields=_parse_fields(args.query_fields),
        endpoint=endpoint,
        key=key,
    )

    an_result = extract_analyze_result(result)
    elems = normalize_elements(an_result)

    run_provider = "azure/document_intelligence"
    args.api_version = api_version
    run_config = build_run_config(
        run_provider, args, features=features, endpoint=endpoint
    )

    write_jsonl(args.output, elems)

    matches_payload = {
        "matches": [],
        "overall": {},
        "run_config": run_config,
    }
    Path(args.emit_matches).parent.mkdir(parents=True, exist_ok=True)
    with open(args.emit_matches, "w", encoding="utf-8") as fh:
        json.dump(matches_payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
