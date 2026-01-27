from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import fitz  # PyMuPDF
from fastapi import APIRouter, HTTPException, Query

from src.extractors.azure_di import (
    AzureDIConfig,
    AzureDIExtractor,
    parse_pages,
    resolve_pages_in_document,
    slice_pdf,
)

from ..config import (
    DEFAULT_PROVIDER,
    PROVIDERS,
    RES_DIR,
    get_out_dir,
    relative_to_root,
    safe_pages_tag,
)
from ..run_jobs import RUN_JOB_MANAGER
from .elements import clear_index_cache
from .reviews import review_file_path

router = APIRouter()
logger = logging.getLogger("chunking.routes.runs")


def _parse_slug_from_run_file(path: Path, suffix: str) -> Tuple[str, Optional[str]]:
    """Parse slug and page range from an elements or chunks file path."""
    stem = path.name[: -len(suffix)] if path.name.endswith(suffix) else path.stem
    m = re.match(r"^(?P<slug>.+?)\.pages(?P<range>[0-9_\-,]+)$", stem)
    if not m:
        return stem, None
    return f"{m.group('slug')}.pages{m.group('range')}", m.group("range")


def discover_runs(provider: Optional[str] = None) -> List[Dict[str, Any]]:
    runs: List[Dict[str, Any]] = []
    provider_keys = [provider] if provider else list(PROVIDERS.keys())
    for prov in provider_keys:
        out_dir = get_out_dir(prov)
        if not out_dir.exists():
            continue

        # Collect runs from both elements files (v5.0+) and chunks files (legacy)
        seen_stems: set = set()
        run_files: List[Tuple[Path, bool]] = []  # (path, is_elements)

        # Primary: elements files (v5.0+)
        for ef in out_dir.glob("*.elements.jsonl"):
            base_stem = ef.name[: -len(".elements.jsonl")]
            seen_stems.add(base_stem)
            run_files.append((ef, True))

        # Fallback: chunks files without corresponding elements (pre-v5.0 legacy)
        for cf in out_dir.glob("*.chunks.jsonl"):
            base_stem = cf.name[: -len(".chunks.jsonl")]
            if base_stem not in seen_stems:
                run_files.append((cf, False))

        # Sort by mtime, newest first
        run_files.sort(key=lambda x: x[0].stat().st_mtime, reverse=True)

        for run_file, is_elements in run_files:
            if is_elements:
                suffix = ".elements.jsonl"
            else:
                suffix = ".chunks.jsonl"
            base_stem = run_file.name[: -len(suffix)]
            ui_slug, page_tag = _parse_slug_from_run_file(run_file, suffix)
            pdf_path = out_dir / f"{base_stem}.pdf"
            meta_path = out_dir / f"{base_stem}.run.json"
            elements_path = out_dir / f"{base_stem}.elements.jsonl"
            chunks_path = out_dir / f"{base_stem}.chunks.jsonl"
            page_range = (page_tag or "").replace("_", ",") or None
            run_config: Dict[str, Any] = {}
            if meta_path.exists():
                try:
                    with meta_path.open("r", encoding="utf-8") as fh:
                        run_config = json.load(fh)
                except json.JSONDecodeError:
                    run_config = {}
            runs.append(
                {
                    "slug": ui_slug,
                    "provider": prov,
                    "pdf_file": relative_to_root(pdf_path) if pdf_path.exists() else None,
                    "page_range": page_range,
                    "elements_file": relative_to_root(elements_path) if elements_path.exists() else None,
                    "chunks_file": relative_to_root(chunks_path) if chunks_path.exists() else None,
                    "run_config": run_config or None,
                }
            )

    return runs


@router.get("/api/run-jobs")
def api_run_jobs() -> Dict[str, Any]:
    return {"jobs": RUN_JOB_MANAGER.list_jobs()}


@router.get("/api/run-jobs/{job_id}")
def api_run_job_detail(job_id: str) -> Dict[str, Any]:
    job = RUN_JOB_MANAGER.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/api/runs")
def api_runs(provider: Optional[str] = Query(default=None)) -> List[Dict[str, Any]]:
    return discover_runs(provider=provider)


@router.delete("/api/run/{slug}")
def api_delete_run(slug: str, provider: str = Query(default=DEFAULT_PROVIDER)) -> Dict[str, Any]:
    out_dir = get_out_dir(provider)
    removed: List[str] = []
    patterns = [f"{slug}.elements.jsonl", f"{slug}.chunks.jsonl", f"{slug}.pdf", f"{slug}.run.json"]
    if ".pages" in slug:
        base, _, rest = slug.partition(".pages")
        patterns.append(f"{base}.pages{rest}.elements.jsonl")
        patterns.append(f"{base}.pages{rest}.chunks.jsonl")
        patterns.append(f"{base}.pages{rest}.pdf")
        patterns.append(f"{base}.pages{rest}.run.json")
    for globpat in patterns:
        for p in out_dir.glob(globpat):
            if p.exists():
                p.unlink()
                removed.append(relative_to_root(p))
    try:
        review_path = review_file_path(slug, provider=provider)
    except HTTPException:
        review_path = None
    if review_path and review_path.exists():
        review_path.unlink()
        removed.append(relative_to_root(review_path))
    clear_index_cache(slug, provider)
    return {"status": "ok", "removed": removed}


# Providers that support creating new runs (Unstructured is sunsetted)
RUNNABLE_PROVIDERS = {"azure/document_intelligence"}


def _write_elements_jsonl(path: Path, elements: List[Dict[str, Any]]) -> None:
    """Write elements to JSONL file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for el in elements:
            fh.write(json.dumps(el, ensure_ascii=False) + "\n")


def _write_run_metadata(path: Path, run_config: Dict[str, Any]) -> None:
    """Write run configuration metadata to JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(run_config, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def _extract_figure_from_pdf(
    pdf_path: Path,
    page_number: int,
    coordinates: Dict[str, Any],
    dpi: int = 150,
) -> Optional[bytes]:
    """Extract a figure region from a PDF page as PNG bytes.

    Args:
        pdf_path: Path to the PDF file
        page_number: 1-indexed page number
        coordinates: Dict with 'points' (4 corners) and layout dimensions
        dpi: Resolution for rendering (default 150)

    Returns:
        PNG image bytes or None if extraction fails
    """
    try:
        doc = fitz.open(pdf_path)
        page_idx = page_number - 1
        if page_idx < 0 or page_idx >= len(doc):
            logger.warning(f"Page {page_number} out of range for {pdf_path}")
            return None

        page = doc[page_idx]
        points = coordinates.get("points", [])
        if len(points) < 4:
            logger.warning(f"Invalid coordinates: {coordinates}")
            return None

        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        x0, y0 = min(xs), min(ys)
        x1, y1 = max(xs), max(ys)

        clip = fitz.Rect(x0, y0, x1, y1)
        zoom = dpi / 72.0
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, clip=clip)
        doc.close()
        return pix.tobytes("png")
    except Exception as e:
        logger.exception(f"Failed to extract figure from PDF: {e}")
        return None


def _process_figures_after_extraction(
    elements: List[Dict[str, Any]],
    pdf_path: Path,
    figures_dir: Path,
    run_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Process figures through vision pipeline after extraction.

    Extracts figure images from PDF using bounding boxes and processes
    them through the PolicyAsCode vision pipeline if available.

    Args:
        elements: List of extracted elements
        pdf_path: Path to the trimmed PDF
        figures_dir: Directory to save extracted figure images
        run_id: Optional run identifier

    Returns:
        Updated elements list with figure_processing added to figure elements
    """
    # Check for figures (case-insensitive)
    figures = [el for el in elements if el.get("type", "").lower() == "figure"]
    if not figures:
        return elements

    logger.info(f"Found {len(figures)} figures to process")

    # Try to import the vision processor
    try:
        from chunking_pipeline.figure_processor import get_processor
        processor = get_processor()
        vision_available = True
        logger.info("Vision pipeline available for figure processing")
    except ImportError:
        processor = None
        vision_available = False
        logger.info("Vision pipeline not available - extracting images only")

    # Ensure figures directory exists
    figures_dir.mkdir(parents=True, exist_ok=True)

    for el in elements:
        if el.get("type", "").lower() != "figure":
            continue

        element_id = el.get("element_id", "")
        md = el.get("metadata", {})
        page_number = el.get("page_number") or md.get("page_number")
        coordinates = md.get("coordinates", {})

        if not page_number or not coordinates.get("points"):
            logger.warning(f"Figure {element_id} missing page/coordinates, skipping")
            continue

        # Extract figure from PDF
        png_bytes = _extract_figure_from_pdf(pdf_path, page_number, coordinates)
        if not png_bytes:
            logger.warning(f"Failed to extract figure {element_id} from PDF")
            continue

        # Save extracted image
        image_path = figures_dir / f"{element_id}.png"
        image_path.write_bytes(png_bytes)

        # Update element with image filename
        if "metadata" not in el:
            el["metadata"] = {}
        el["metadata"]["figure_image_filename"] = image_path.name
        logger.debug(f"Extracted figure {element_id} to {image_path}")

        # Process through vision pipeline if available
        if vision_available and processor:
            try:
                ocr_text = el.get("content", "") or el.get("text", "")
                result = processor.process_and_save(
                    image_path=image_path,
                    output_dir=figures_dir,
                    element_id=element_id,
                    ocr_text=ocr_text,
                    run_id=run_id,
                )
                el["figure_processing"] = {
                    "figure_type": result.get("figure_type"),
                    "confidence": result.get("confidence"),
                    "processed_content": result.get("processed_content"),
                    "description": result.get("description"),
                    "step1_duration_ms": result.get("step1_duration_ms"),
                    "step2_duration_ms": result.get("step2_duration_ms"),
                }
                logger.info(f"Processed figure {element_id}: {result.get('figure_type')}")
            except Exception as e:
                logger.error(f"Vision processing failed for {element_id}: {e}")
                el["figure_processing"] = {"error": str(e)}

    return elements


def _run_extraction(metadata: Dict[str, Any]) -> None:
    """Worker function for Azure DI extraction.

    Called by the job manager with metadata containing all extraction parameters.
    Performs PDF slicing, extraction, and writes outputs.
    """
    input_pdf = Path(metadata["input_pdf"])
    trimmed_path = Path(metadata["trimmed_path"])
    elements_path = Path(metadata["elements_path"])
    meta_path = Path(metadata["meta_path"])
    pages_str = metadata["pages"]

    # Parse and validate pages
    page_list = parse_pages(pages_str)
    valid_pages, dropped_pages, max_page = resolve_pages_in_document(str(input_pdf), page_list)
    if not valid_pages:
        raise ValueError(f"No valid pages requested; {input_pdf} has {max_page} pages.")
    if dropped_pages:
        logger.warning(f"Dropping out-of-range pages {dropped_pages}; document has {max_page} pages.")

    # Slice PDF to requested pages (creates the trimmed PDF artifact)
    slice_pdf(str(input_pdf), valid_pages, str(trimmed_path), warn_on_drop=False)

    # Determine if figures should be downloaded
    outputs = metadata.get("outputs") or []
    want_figures = any((o or "").lower() == "figures" for o in outputs)

    # Build extractor config
    config = AzureDIConfig(
        model_id=metadata.get("model_id", "prebuilt-layout"),
        api_version=metadata.get("api_version", "2024-11-30"),
        features=metadata.get("features"),
        outputs=outputs or None,
        locale=metadata.get("locale"),
        download_figures=want_figures,
    )

    # Determine figures output directory
    figures_output_dir = elements_path.parent if want_figures else None

    # Run extraction using PolicyAsCode's AzureDIExtractor
    extractor = AzureDIExtractor(config)
    result = extractor.extract(
        str(trimmed_path),
        figures_output_dir=figures_output_dir,
    )

    # Convert elements to dict format for JSONL
    elems = [el.to_dict() for el in result.elements]

    # Build run configuration metadata
    run_config: Dict[str, Any] = {
        "provider": "azure/document_intelligence",
        "input": str(input_pdf),
        "pages": ",".join(str(p) for p in valid_pages),
        "model_id": config.model_id,
        "api_version": config.api_version,
        "features": config.features or [],
    }
    if config.outputs:
        run_config["outputs"] = config.outputs
    if config.locale:
        run_config["locale"] = config.locale
    if metadata.get("primary_language"):
        run_config["primary_language"] = metadata["primary_language"]
    if metadata.get("ocr_languages"):
        run_config["ocr_languages"] = metadata["ocr_languages"]
    if metadata.get("languages"):
        run_config["languages"] = metadata["languages"]

    # Merge extraction metadata (detected languages, element count, etc.)
    # Serialize Pydantic models (like DetectedLanguage) to dicts for JSON compatibility
    for key, val in result.metadata.items():
        if isinstance(val, list):
            run_config[key] = [
                item.model_dump() if hasattr(item, "model_dump") else item for item in val
            ]
        elif hasattr(val, "model_dump"):
            run_config[key] = val.model_dump()
        else:
            run_config[key] = val

    # Process figures: extract images from PDF and run vision pipeline if available
    figures_dir = elements_path.parent / f"{elements_path.stem.replace('.elements', '')}.figures"
    slug_with_pages = metadata.get("slug_with_pages")
    elems = _process_figures_after_extraction(
        elems, trimmed_path, figures_dir, run_id=slug_with_pages
    )

    # Write outputs
    _write_elements_jsonl(elements_path, elems)
    _write_run_metadata(meta_path, run_config)

    logger.info(f"Extraction complete: {len(elems)} elements written to {elements_path}")


@router.post("/api/run")
def api_run(payload: Dict[str, Any]) -> Dict[str, Any]:
    provider = str(payload.get("provider") or DEFAULT_PROVIDER).strip() or DEFAULT_PROVIDER
    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")
    if provider not in RUNNABLE_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=f"Provider '{provider}' is no longer supported for new runs. "
            "Use 'azure/document_intelligence' instead.",
        )
    out_dir = get_out_dir(provider)

    pdf_name = str(payload.get("pdf") or payload.get("pdf_name") or "").strip()
    pages = str(payload.get("pages") or "").strip()
    if not pdf_name:
        raise HTTPException(status_code=400, detail="Field 'pdf' is required")

    # All providers now output elements only; chunking is done via separate custom chunker
    ocr_languages = str(payload.get("ocr_languages") or "eng+ara").strip() or None
    languages_raw = payload.get("languages")
    primary_language = str(payload.get("primary_language") or "eng").strip().lower()
    if primary_language not in {"eng", "ara"}:
        primary_language = "eng"

    # Azure Document Intelligence specific options
    azure_model_id = str(payload.get("model_id") or "prebuilt-layout").strip()
    azure_features_raw = payload.get("features")
    azure_outputs_raw = payload.get("outputs")
    azure_locale = payload.get("locale")
    azure_string_index_type = payload.get("string_index_type")
    azure_output_content_format = payload.get("output_content_format")
    azure_query_fields = payload.get("query_fields")

    def _normalize_languages(value: Any) -> Optional[List[str]]:
        if value is None:
            return None
        items: List[str] = []
        if isinstance(value, str):
            parts = value.split(",")
        elif isinstance(value, (list, tuple, set)):
            parts = value
        else:
            raise HTTPException(status_code=400, detail="languages must be a list or comma-separated string")
        for part in parts:
            txt = str(part).strip()
            if txt:
                items.append(txt)
        return items or None

    def _normalize_feature_list(value: Any) -> Optional[List[str]]:
        if value is None:
            return None
        items: List[str] = []
        if isinstance(value, str):
            parts = value.split(",")
        elif isinstance(value, (list, tuple, set)):
            parts = value
        else:
            raise HTTPException(status_code=400, detail="features/outputs must be a list or comma-separated string")
        for part in parts:
            txt = str(part).strip()
            if txt:
                items.append(txt)
        return items or None

    languages = _normalize_languages(languages_raw)
    features_list = _normalize_feature_list(azure_features_raw) or []
    outputs_list = _normalize_feature_list(azure_outputs_raw) or []
    for feat in features_list:
        if feat.lower() == "figures":
            outputs_list.append("figures")
    seen_feats: set = set()
    normalized_features: List[str] = []
    for feat in features_list:
        key = feat.lower()
        if key == "figures" or key in seen_feats:
            continue
        seen_feats.add(key)
        normalized_features.append(feat)
    seen_outputs: set = set()
    normalized_outputs: List[str] = []
    for out in outputs_list:
        key = out.lower()
        if key in seen_outputs:
            continue
        seen_outputs.add(key)
        normalized_outputs.append(out)

    input_pdf = RES_DIR / pdf_name
    if not input_pdf.exists():
        raise HTTPException(status_code=404, detail=f"PDF not found: {pdf_name}")

    if not pages:
        try:
            from pypdf import PdfReader  # type: ignore

            reader = PdfReader(str(input_pdf))
            total = len(reader.pages)
            if total <= 0:
                raise ValueError("empty PDF")
            pages = f"1-{total}"
        except Exception as e:  # pragma: no cover - defensive fallback
            raise HTTPException(status_code=400, detail=f"Could not infer page range: {e}")

    logger.info("Received run request provider=%s pdf=%s pages=%s", provider, pdf_name, pages)

    slug = input_pdf.stem
    raw_tag = str(payload.get("tag") or "").strip()
    safe_tag = None
    if raw_tag:
        safe_tag = re.sub(r"[^A-Za-z0-9_\\-]+", "-", raw_tag)[:40].strip("-")
    run_slug = f"{slug}__{safe_tag}" if safe_tag else slug
    pages_tag = safe_pages_tag(pages)
    out_dir.mkdir(parents=True, exist_ok=True)

    form_snapshot: Dict[str, Any] = {
        "pdf": pdf_name,
        "pages": pages,
        "tag": raw_tag or None,
        "ocr_languages": ocr_languages,
        "languages": languages,
        "primary_language": primary_language,
        "provider": provider,
        "model_id": azure_model_id,
        "features": normalized_features or azure_features_raw,
        "outputs": normalized_outputs or azure_outputs_raw,
        "locale": azure_locale,
        "string_index_type": azure_string_index_type,
        "output_content_format": azure_output_content_format,
        "query_fields": azure_query_fields,
    }
    payload["form_snapshot"] = form_snapshot

    def build_paths(slug_val: str):
        return (
            out_dir / f"{slug_val}.{pages_tag}.pdf",
            out_dir / f"{slug_val}.{pages_tag}.elements.jsonl",
            out_dir / f"{slug_val}.{pages_tag}.run.json",
        )

    trimmed_out, elements_out, meta_out = build_paths(run_slug)

    if trimmed_out.exists() or elements_out.exists():
        n = 2
        base_variant = run_slug
        while True:
            candidate = f"{base_variant}__r{n}"
            p_out, e_out, m_out = build_paths(candidate)
            if not (e_out.exists() or p_out.exists()):
                run_slug = candidate
                trimmed_out, elements_out, meta_out = p_out, e_out, m_out
                break
            n += 1

    logger.info(
        "Submitting run slug=%s provider=%s",
        f"{run_slug}.{pages_tag}",
        provider,
    )

    # Build job metadata with all extraction parameters
    job_metadata = {
        # Job tracking fields
        "slug_with_pages": f"{run_slug}.{pages_tag}",
        "pages_tag": pages_tag,
        "pdf_name": pdf_name,
        "pages": pages,
        "safe_tag": safe_tag,
        "raw_tag": raw_tag,
        "form_snapshot": payload.get("form_snapshot") or {},
        "provider": provider,
        # Output paths
        "input_pdf": str(input_pdf),
        "trimmed_path": str(trimmed_out),
        "elements_path": str(elements_out),
        "meta_path": str(meta_out),
        # Extraction parameters for _run_extraction()
        "model_id": azure_model_id,
        "features": normalized_features or None,
        "outputs": normalized_outputs or None,
        "locale": azure_locale,
        "primary_language": primary_language,
        "ocr_languages": ocr_languages,
        "languages": languages,
    }
    job = RUN_JOB_MANAGER.enqueue_callable(callable_fn=_run_extraction, metadata=job_metadata)
    job_data = job.to_dict()
    logger.info(
        "Run queued job_id=%s slug=%s provider=%s",
        job_data.get("id"),
        job_metadata["slug_with_pages"],
        provider,
    )
    run_stub = {
        "slug": job_metadata["slug_with_pages"],
        "provider": provider,
        "page_tag": pages_tag,
        "pdf_file": relative_to_root(trimmed_out) if trimmed_out.exists() else None,
        "elements_file": relative_to_root(elements_out) if elements_out.exists() else None,
        "chunks_file": None,  # Chunks created separately by chunker
        "run_config": job_metadata.get("form_snapshot"),
    }
    return {"status": "queued", "job": job_data, "run": run_stub}
