"""Azure Document Intelligence pipeline for ChunkingTests.

This module provides CLI and programmatic access to Azure Document Intelligence,
using the shared extractors from PolicyAsCode for element normalization.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.core.credentials import AzureKeyCredential

from src.extractors.azure_di import (
    ensure_stable_element_id,
    extract_analyze_result,
    extract_detected_languages,
    normalize_elements,
    parse_pages,
    pick_primary_detected_language,
    resolve_pages_in_document,
    slice_pdf,
)

DEFAULT_ENDPOINT_ENV = "AZURE_FT_ENDPOINT"
DEFAULT_KEY_ENV = "AZURE_FT_KEY"
ALT_ENDPOINT_ENVS = ("DOCUMENTINTELLIGENCE_ENDPOINT", "DI_ENDPOINT")
ALT_KEY_ENVS = ("DOCUMENTINTELLIGENCE_API_KEY", "DI_KEY")
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


def run_di_analysis(
    input_pdf: str,
    trimmed_pdf: str,
    model_id: str,
    api_version: str,
    pages: List[int],
    features: Optional[List[str]],
    outputs: Optional[List[str]],
    locale: Optional[str],
    string_index_type: Optional[str],
    output_content_format: Optional[str],
    query_fields: Optional[List[str]],
    endpoint: str,
    key: str,
) -> Tuple[Dict[str, Any], Optional[DocumentIntelligenceClient], Optional[str]]:
    """Run Azure Document Intelligence analysis on a PDF.

    Returns (result_dict, client, result_id) for figure download support.
    """
    client_kwargs: Dict[str, Any] = {"api_version": api_version}
    client = DocumentIntelligenceClient(
        endpoint=endpoint, credential=AzureKeyCredential(key), **client_kwargs
    )

    pages_arg: Optional[str] = None
    if pages:
        pages_arg = ",".join(str(p) for p in pages)

    with open(trimmed_pdf, "rb") as fh:
        poller = client.begin_analyze_document(
            model_id,
            body=fh,
            features=features or None,
            output=outputs or None,
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
            logger.info(f"DI analyze_document completed in {time.time() - start:.2f}s")

        result_id = None
        try:
            details = getattr(poller, "details", None)
            if details and isinstance(details, dict):
                result_id = details.get("operation_id")
        except Exception:
            result_id = None

        if hasattr(result, "as_dict"):
            return result.as_dict(), client, result_id
        if hasattr(result, "to_dict"):
            return result.to_dict(), client, result_id
        return result, client, result_id  # type: ignore[return-value]


def _sanitize_figure_filename(name: str) -> str:
    """Sanitize a figure ID for use as a filename."""
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", name or "")
    return cleaned or "figure"


def _download_di_figures(
    client: Optional[DocumentIntelligenceClient],
    model_id: str,
    result_id: Optional[str],
    figures: Optional[List[Dict[str, Any]]],
    chunk_output: Optional[str],
    trimmed_pdf: str,
) -> Tuple[Dict[str, Dict[str, Any]], Optional[Path]]:
    """Fetch cropped figure images and return per-figure metadata to attach to elements."""
    if not client or not result_id or not figures:
        return {}, None

    base_dir = Path(chunk_output).parent if chunk_output else Path(trimmed_pdf).parent
    stem = Path(chunk_output).stem if chunk_output else Path(trimmed_pdf).stem
    fig_dir = base_dir / f"{stem}.figures"
    fig_dir.mkdir(parents=True, exist_ok=True)

    meta: Dict[str, Dict[str, Any]] = {}
    for fig in figures:
        fig_id = fig.get("id")
        if not fig_id:
            continue
        try:
            content = b"".join(
                client.get_analyze_result_figure(
                    model_id=model_id, result_id=result_id, figure_id=fig_id
                )
            )
        except Exception as e:
            sys.stderr.write(f"Warning: failed to download figure {fig_id}: {e}\n")
            continue
        if not content:
            continue
        fname = _sanitize_figure_filename(fig_id) + ".png"
        dest = fig_dir / fname
        try:
            dest.write_bytes(content)
        except Exception as e:
            sys.stderr.write(f"Warning: failed to write figure {fig_id}: {e}\n")
            continue
        rel_path = dest.relative_to(base_dir)
        meta[fig_id] = {
            "image_path": str(rel_path),
            "image_mime_type": "image/png",
        }
    return meta, fig_dir


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
    features = _parse_csv_list(args.features)
    outputs = _parse_csv_list(args.outputs)
    want_figures = any((o or "").lower() == "figures" for o in (outputs or []))

    result_payload, di_client, di_result_id = run_di_analysis(
        input_pdf=args.input,
        trimmed_pdf=trimmed,
        model_id=model_id,
        api_version=api_version,
        pages=di_pages,
        features=features,
        outputs=outputs,
        locale=args.locale,
        string_index_type=args.string_index_type,
        output_content_format=args.output_content_format,
        query_fields=_parse_csv_list(args.query_fields),
        endpoint=endpoint,
        key=key,
    )

    an_result = extract_analyze_result(result_payload)

    figure_images: Dict[str, Dict[str, Any]] = {}
    figures_dir: Optional[Path] = None
    if want_figures:
        figure_images, figures_dir = _download_di_figures(
            client=di_client,
            model_id=model_id,
            result_id=di_result_id,
            figures=an_result.get("figures") if isinstance(an_result, dict) else None,
            chunk_output=args.output,
            trimmed_pdf=trimmed,
        )

    elems = normalize_elements(an_result, figure_images)

    run_provider = "azure/document_intelligence"
    args.api_version = api_version
    run_config = build_run_config(
        run_provider, args, features=features, outputs=outputs, endpoint=endpoint
    )

    if want_figures:
        run_config["figure_count"] = (
            len(an_result.get("figures") or []) if isinstance(an_result, dict) else 0
        )
        if figures_dir:
            run_config["figures_dir"] = str(figures_dir)

    detected_langs = extract_detected_languages(an_result)
    if detected_langs:
        run_config["detected_languages"] = detected_langs
        primary_detected = pick_primary_detected_language(detected_langs)
        if primary_detected:
            run_config["detected_primary_language"] = primary_detected

    write_run_metadata(args.run_metadata_out, run_config)

    if args.output:
        write_jsonl(args.output, elems)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
