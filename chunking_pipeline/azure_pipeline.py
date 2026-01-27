"""Azure Document Intelligence pipeline for ChunkingTests.

This module provides CLI access to Azure Document Intelligence,
using AzureDIExtractor from PolicyAsCode for all extraction logic.

When --outputs includes 'figures', extracted figure images are processed
through the PolicyAsCode vision pipeline for classification and structure
extraction (EXPERIMENTAL - requires feature branch).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from loguru import logger

from src.extractors.azure_di import (
    AzureDIConfig,
    AzureDIExtractor,
    parse_pages,
    resolve_pages_in_document,
    slice_pdf,
)

# Environment variable names (in priority order)
# PolicyAsCode uses AZURE_DOCUMENTINTELLIGENCE_* but we also support legacy names
ENDPOINT_ENVS = (
    "AZURE_DOCUMENTINTELLIGENCE_ENDPOINT",  # PolicyAsCode standard
    "AZURE_FT_ENDPOINT",  # ChunkingTests legacy
    "DOCUMENTINTELLIGENCE_ENDPOINT",
    "DI_ENDPOINT",
)
KEY_ENVS = (
    "AZURE_DOCUMENTINTELLIGENCE_KEY",  # PolicyAsCode standard
    "AZURE_FT_KEY",  # ChunkingTests legacy
    "DOCUMENTINTELLIGENCE_API_KEY",
    "DI_KEY",
)
DEFAULT_DI_API_VERSION = "2024-11-30"


def _load_local_env() -> None:
    """Load .env files from the project root."""
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
    """Get the first non-empty environment variable from a list of names."""
    for name in names:
        val = os.environ.get(name)
        if val:
            return val
    return ""


def write_jsonl(path: Optional[str], elements: List[Dict[str, Any]]) -> None:
    """Write elements to JSONL file or stdout."""
    if not path:
        for el in elements:
            sys.stdout.write(json.dumps(el, ensure_ascii=False) + "\n")
        return
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for el in elements:
            fh.write(json.dumps(el, ensure_ascii=False) + "\n")


def write_run_metadata(path: Optional[str], run_config: Dict[str, Any]) -> None:
    """Write run configuration metadata to JSON file."""
    if not path:
        return
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8") as fh:
        json.dump(run_config, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def _parse_csv_list(raw: Optional[str]) -> Optional[List[str]]:
    """Parse a comma-separated string into a list."""
    if not raw:
        return None
    return [part.strip() for part in raw.split(",") if part.strip()]


def build_run_config(
    provider: str,
    args: argparse.Namespace,
    features: Optional[List[str]],
    outputs: Optional[List[str]],
    endpoint: str,
) -> Dict[str, Any]:
    """Build run configuration metadata for storage."""
    cfg: Dict[str, Any] = {
        "provider": provider,
        "input": args.input,
        "pages": args.pages,
        "endpoint": endpoint,
        "model_id": args.model_id,
        "api_version": args.api_version,
    }
    cfg["features"] = features or []
    if outputs:
        cfg["outputs"] = outputs
    if args.locale:
        cfg["locale"] = args.locale
    if args.string_index_type:
        cfg["string_index_type"] = args.string_index_type
    if args.output_content_format:
        cfg["output_content_format"] = args.output_content_format
    if args.query_fields:
        cfg["query_fields"] = args.query_fields
    if args.primary_language:
        cfg["primary_language"] = args.primary_language
    if args.ocr_languages:
        cfg["ocr_languages"] = args.ocr_languages
    if args.languages:
        cfg["languages"] = args.languages
    return cfg


def main(argv: Optional[List[str]] = None) -> int:
    """CLI entry point for Azure Document Intelligence analysis."""
    parser = argparse.ArgumentParser(description="Run Azure Document Intelligence")
    parser.add_argument(
        "--provider",
        choices=["document_intelligence"],
        default="document_intelligence",
        help="Azure provider to use",
    )
    parser.add_argument("--input", required=True, help="Path to input PDF")
    parser.add_argument("--pages", required=True, help="Page ranges, e.g., 1-3 or 2,4")
    parser.add_argument(
        "--output", help="Path to write elements JSONL (optional; omit to skip)"
    )
    parser.add_argument("--trimmed-out", required=True, help="Path to write trimmed PDF")
    parser.add_argument("--emit-matches", help="(Deprecated) Path to write matches JSON")
    parser.add_argument("--model-id", dest="model_id", required=False, help="Model id")
    parser.add_argument(
        "--api-version", dest="api_version", required=False, help="API version"
    )
    parser.add_argument("--features", help="Comma-separated feature list")
    parser.add_argument(
        "--outputs", help="Comma-separated outputs list (e.g., figures)"
    )
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
    parser.add_argument(
        "--run-metadata-out",
        default=None,
        help="Optional path to write run metadata with detected languages",
    )
    parser.add_argument("--endpoint", help="Override endpoint")
    parser.add_argument("--key", help="Override API key")
    args = parser.parse_args(argv)

    # Parse and validate pages
    pages = parse_pages(args.pages)
    valid_pages, dropped_pages, max_page = resolve_pages_in_document(args.input, pages)
    if not valid_pages:
        raise SystemExit(f"No valid pages requested; {args.input} has {max_page} pages.")
    if dropped_pages:
        sys.stderr.write(
            f"Warning: dropping out-of-range pages {dropped_pages}; "
            f"document has {max_page} pages.\n"
        )

    # Slice PDF to requested pages (creates the trimmed PDF artifact)
    trimmed = slice_pdf(args.input, valid_pages, args.trimmed_out, warn_on_drop=False)
    args.pages = ",".join(str(p) for p in valid_pages)

    # Resolve endpoint/key from args or environment
    endpoint = args.endpoint or _get_env_any(list(ENDPOINT_ENVS))
    key = args.key or _get_env_any(list(KEY_ENVS))
    if not endpoint or not key:
        raise SystemExit(
            "Document Intelligence requires endpoint/key env "
            f"({' or '.join(ENDPOINT_ENVS[:2])}/{' or '.join(KEY_ENVS[:2])})"
        )

    # Parse CLI options
    model_id = args.model_id or "prebuilt-layout"
    api_version = args.api_version or DEFAULT_DI_API_VERSION
    features = _parse_csv_list(args.features)
    outputs = _parse_csv_list(args.outputs)
    want_figures = any((o or "").lower() == "figures" for o in (outputs or []))

    # Build extractor config
    config = AzureDIConfig(
        endpoint=endpoint,
        api_key=key,
        model_id=model_id,
        api_version=api_version,
        features=features,
        outputs=outputs,
        locale=args.locale,
        download_figures=want_figures,
    )

    # Determine figures output directory
    figures_output_dir = None
    if want_figures and args.output:
        figures_output_dir = Path(args.output).parent

    # Run extraction using PolicyAsCode's AzureDIExtractor
    extractor = AzureDIExtractor(config)
    result = extractor.extract(
        trimmed,
        figures_output_dir=figures_output_dir,
    )

    # Convert elements to dict format for JSONL
    elems = [el.to_dict() for el in result.elements]

    # Process figures through vision pipeline if requested (EXPERIMENTAL)
    process_figures = any((o or "").lower() == "process_figures" for o in (outputs or []))
    if process_figures and figures_output_dir:
        try:
            from chunking_pipeline.figure_processor import get_processor

            processor = get_processor()
            logger.info(f"Processing {sum(1 for e in elems if e.get('type') == 'figure')} figures through vision pipeline")
            elems = processor.process_elements_batch(
                elems,
                figures_output_dir,
                run_id=Path(args.input).stem if args.input else None,
            )
        except ImportError as e:
            logger.warning(f"Figure processing not available - import error: {e}")
        except Exception as e:
            logger.error(f"Figure processing failed: {e}")

    # Build run configuration metadata
    run_provider = "azure/document_intelligence"
    args.api_version = api_version
    args.model_id = model_id
    run_config = build_run_config(
        run_provider, args, features=features, outputs=outputs, endpoint=endpoint
    )

    # Merge extraction metadata into run config
    run_config.update(result.metadata)

    # Write outputs
    write_run_metadata(args.run_metadata_out, run_config)

    if args.output:
        write_jsonl(args.output, elems)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
