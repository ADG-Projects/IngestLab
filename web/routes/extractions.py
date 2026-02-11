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
    AzureDIExtractOptions,
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
from ..file_utils import get_file_type
from ..extraction_jobs import EXTRACTION_JOB_MANAGER
from .elements import clear_index_cache
from .reviews import review_file_path

router = APIRouter()
logger = logging.getLogger("chunking.routes.extractions")


def _report_progress(
    metadata: Dict[str, Any],
    *,
    current: Optional[int] = None,
    total: Optional[int] = None,
    message: Optional[str] = None,
    stage: Optional[str] = None,
) -> None:
    """Report progress for the current extraction job."""
    job_id = metadata.get("_job_id")
    if job_id:
        EXTRACTION_JOB_MANAGER.update_progress(
            job_id, current=current, total=total, message=message, stage=stage
        )


def _parse_slug_from_extraction_file(path: Path, suffix: str) -> Tuple[str, Optional[str]]:
    """Parse slug and page range from an elements or chunks file path."""
    stem = path.name[: -len(suffix)] if path.name.endswith(suffix) else path.stem
    m = re.match(r"^(?P<slug>.+?)\.pages(?P<range>[0-9_\-,]+)$", stem)
    if not m:
        return stem, None
    return f"{m.group('slug')}.pages{m.group('range')}", m.group("range")


def discover_extractions(provider: Optional[str] = None) -> List[Dict[str, Any]]:
    extractions: List[Dict[str, Any]] = []
    provider_keys = [provider] if provider else list(PROVIDERS.keys())
    for prov in provider_keys:
        out_dir = get_out_dir(prov)
        if not out_dir.exists():
            continue

        # Collect extractions from both elements files (v5.0+) and chunks files (legacy)
        seen_stems: set = set()
        extraction_files: List[Tuple[Path, bool]] = []  # (path, is_elements)

        # Primary: elements files (v5.0+)
        for ef in out_dir.glob("*.elements.jsonl"):
            base_stem = ef.name[: -len(".elements.jsonl")]
            seen_stems.add(base_stem)
            extraction_files.append((ef, True))

        # Fallback: chunks files without corresponding elements (pre-v5.0 legacy)
        for cf in out_dir.glob("*.chunks.jsonl"):
            base_stem = cf.name[: -len(".chunks.jsonl")]
            if base_stem not in seen_stems:
                extraction_files.append((cf, False))

        # Sort by mtime, newest first
        extraction_files.sort(key=lambda x: x[0].stat().st_mtime, reverse=True)

        for extraction_file, is_elements in extraction_files:
            if is_elements:
                suffix = ".elements.jsonl"
            else:
                suffix = ".chunks.jsonl"
            base_stem = extraction_file.name[: -len(suffix)]
            ui_slug, page_tag = _parse_slug_from_extraction_file(extraction_file, suffix)
            pdf_path = out_dir / f"{base_stem}.pdf"
            meta_path = out_dir / f"{base_stem}.extraction.json"
            elements_path = out_dir / f"{base_stem}.elements.jsonl"
            chunks_path = out_dir / f"{base_stem}.chunks.jsonl"
            page_range = (page_tag or "").replace("_", ",") or None
            extraction_config: Dict[str, Any] = {}
            if meta_path.exists():
                try:
                    with meta_path.open("r", encoding="utf-8") as fh:
                        extraction_config = json.load(fh)
                except json.JSONDecodeError:
                    extraction_config = {}
            extractions.append(
                {
                    "slug": ui_slug,
                    "provider": prov,
                    "pdf_file": relative_to_root(pdf_path) if pdf_path.exists() else None,
                    "page_range": page_range,
                    "elements_file": relative_to_root(elements_path) if elements_path.exists() else None,
                    "chunks_file": relative_to_root(chunks_path) if chunks_path.exists() else None,
                    "extraction_config": extraction_config or None,
                    "tag": extraction_config.get("form_snapshot", {}).get("tag"),
                }
            )

    return extractions


@router.get("/api/extraction-jobs")
def api_extraction_jobs() -> Dict[str, Any]:
    return {"jobs": EXTRACTION_JOB_MANAGER.list_jobs()}


@router.get("/api/extraction-jobs/{job_id}")
def api_extraction_job_detail(job_id: str) -> Dict[str, Any]:
    job = EXTRACTION_JOB_MANAGER.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/api/extractions")
def api_extractions(provider: Optional[str] = Query(default=None)) -> List[Dict[str, Any]]:
    return discover_extractions(provider=provider)


@router.delete("/api/extraction/{slug}")
def api_delete_extraction(slug: str, provider: str = Query(default=DEFAULT_PROVIDER)) -> Dict[str, Any]:
    out_dir = get_out_dir(provider)
    removed: List[str] = []
    patterns = [f"{slug}.elements.jsonl", f"{slug}.chunks.jsonl", f"{slug}.pdf", f"{slug}.extraction.json"]
    if ".pages" in slug:
        base, _, rest = slug.partition(".pages")
        patterns.append(f"{base}.pages{rest}.elements.jsonl")
        patterns.append(f"{base}.pages{rest}.chunks.jsonl")
        patterns.append(f"{base}.pages{rest}.pdf")
        patterns.append(f"{base}.pages{rest}.extraction.json")
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


@router.patch("/api/extraction/{slug}")
def api_update_extraction(
    slug: str,
    payload: Dict[str, Any],
    provider: str = Query(default=DEFAULT_PROVIDER),
) -> Dict[str, Any]:
    """Update extraction metadata (e.g., tag).

    Payload can contain:
      - tag: New tag value (string or null to remove)
    """
    out_dir = get_out_dir(provider)

    # Find the extraction.json file for this slug
    # Handle both with and without .pages suffix
    meta_patterns = [f"{slug}.extraction.json"]
    if ".pages" in slug:
        base, _, rest = slug.partition(".pages")
        meta_patterns.append(f"{base}.pages{rest}.extraction.json")

    meta_path: Optional[Path] = None
    for pat in meta_patterns:
        for p in out_dir.glob(pat):
            if p.exists():
                meta_path = p
                break
        if meta_path:
            break

    if not meta_path or not meta_path.exists():
        raise HTTPException(status_code=404, detail=f"Extraction metadata not found for {slug}")

    # Load existing metadata
    try:
        with meta_path.open("r", encoding="utf-8") as fh:
            extraction_config = json.load(fh)
    except json.JSONDecodeError:
        extraction_config = {}

    # Update tag if provided
    if "tag" in payload:
        new_tag = payload.get("tag")
        # Ensure form_snapshot exists
        if "form_snapshot" not in extraction_config:
            extraction_config["form_snapshot"] = {}
        # Set or remove tag
        if new_tag:
            extraction_config["form_snapshot"]["tag"] = str(new_tag).strip()
        else:
            extraction_config["form_snapshot"].pop("tag", None)

    # Write updated metadata
    with meta_path.open("w", encoding="utf-8") as fh:
        json.dump(extraction_config, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    logger.info(f"Updated extraction metadata for {slug}: tag={payload.get('tag')}")

    return {
        "status": "ok",
        "slug": slug,
        "provider": provider,
        "tag": extraction_config.get("form_snapshot", {}).get("tag"),
    }


# Providers that support creating new extractions (Unstructured is sunsetted)
EXTRACTABLE_PROVIDERS = {"azure/document_intelligence"}


def _write_elements_jsonl(path: Path, elements: List[Dict[str, Any]]) -> None:
    """Write elements to JSONL file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for el in elements:
            fh.write(json.dumps(el, ensure_ascii=False) + "\n")


def _write_extraction_metadata(path: Path, extraction_config: Dict[str, Any]) -> None:
    """Write extraction configuration metadata to JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(extraction_config, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def _extract_figure_from_pdf(
    pdf_path: Path,
    page_number: int,
    coordinates: Dict[str, Any],
    dpi: int = 300,
) -> Optional[bytes]:
    """Extract a figure region from a PDF page as PNG bytes.

    Args:
        pdf_path: Path to the PDF file
        page_number: 1-indexed page number
        coordinates: Dict with 'points' (4 corners) and layout dimensions
        dpi: Resolution for rendering (default 300)

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

        # Handle PixelSpace coordinate system (used for images converted to PDF)
        # Azure DI returns coordinates in pixels, but fitz creates PDFs in points
        # (at 72 DPI). High-DPI images (e.g., Retina screenshots at 144 DPI) result
        # in a PDF that's half the pixel dimensions. We need to scale coordinates.
        coord_system = coordinates.get("system", "")
        layout_width = coordinates.get("layout_width")
        layout_height = coordinates.get("layout_height")

        if coord_system == "PixelSpace" and layout_width and layout_height:
            # Scale coordinates from pixel space to PDF point space
            scale_x = page.rect.width / layout_width
            scale_y = page.rect.height / layout_height
            x0, y0 = x0 * scale_x, y0 * scale_y
            x1, y1 = x1 * scale_x, y1 * scale_y
            logger.debug(
                f"Scaled PixelSpace coords: scale=({scale_x:.3f}, {scale_y:.3f}), "
                f"rect=({x0:.1f}, {y0:.1f}, {x1:.1f}, {y1:.1f})"
            )

        clip = fitz.Rect(x0, y0, x1, y1)
        zoom = dpi / 72.0
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, clip=clip)
        doc.close()
        return pix.tobytes("png")
    except Exception as e:
        logger.exception(f"Failed to extract figure from PDF: {e}")
        return None


def _convert_image_to_pdf(image_path: Path, out_dir: Path, slug_with_pages: str) -> Path:
    """Convert an image to a single-page PDF for viewing in the UI.

    Args:
        image_path: Path to the source image file
        out_dir: Output directory for the PDF
        slug_with_pages: Base name for the output file (e.g., "myimage.pages_1")

    Returns:
        Path to the created PDF file
    """
    pdf_path = out_dir / f"{slug_with_pages}.pdf"

    # Open source image to get dimensions (in pixels)
    img_doc = fitz.open(str(image_path))
    img_rect = img_doc[0].rect
    img_width = img_rect.width
    img_height = img_rect.height

    # Scale to fit within reasonable page bounds (max 792 points = 11 inches)
    # This ensures the viewer's fit-to-height produces a comfortable zoom level
    # PyMuPDF reports image dimensions in pixels, but PDF uses points (1/72 inch)
    # Without scaling, a 2000x3000 pixel image would create a 28"x42" page
    MAX_DIMENSION = 792.0
    scale = min(MAX_DIMENSION / img_width, MAX_DIMENSION / img_height, 1.0)

    page_width = img_width * scale
    page_height = img_height * scale

    # Create PDF with scaled dimensions
    pdf_doc = fitz.open()
    page = pdf_doc.new_page(width=page_width, height=page_height)
    page.insert_image(fitz.Rect(0, 0, page_width, page_height), filename=str(image_path))

    pdf_doc.save(str(pdf_path))
    pdf_doc.close()
    img_doc.close()

    logger.info(f"Converted image to PDF: {pdf_path} ({page_width:.0f}x{page_height:.0f} pts)")
    return pdf_path


def _process_figures_after_extraction(
    elements: List[Dict[str, Any]],
    pdf_path: Path,
    figures_dir: Path,
    run_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    run_vision_pipeline: bool = True,
) -> List[Dict[str, Any]]:
    """Process figures through vision pipeline after extraction.

    Extracts figure images from PDF using bounding boxes and processes
    them through the PolicyAsCode vision pipeline if available.

    Args:
        elements: List of extracted elements
        pdf_path: Path to the trimmed PDF
        figures_dir: Directory to save extracted figure images
        run_id: Optional run identifier
        metadata: Job metadata for progress reporting
        run_vision_pipeline: If True (default), run AI vision analysis on figures.
            If False, only extract figure images without AI processing.

    Returns:
        Updated elements list with figure_processing added to figure elements
    """
    metadata = metadata or {}

    # Check for figures (case-insensitive)
    figures = [el for el in elements if el.get("type", "").lower() == "figure"]
    if not figures:
        return elements

    total_figures = len(figures)
    logger.info(f"Found {total_figures} figures to process")
    _report_progress(metadata, stage="figures", total=total_figures, message=f"Processing {total_figures} figure{'s' if total_figures > 1 else ''}...")

    # Try to import the vision processor (unless explicitly disabled)
    if not run_vision_pipeline:
        processor = None
        vision_available = False
        logger.info("Vision pipeline disabled by user - extracting images only")
        _report_progress(metadata, stage="figures", total=total_figures, message=f"Extracting {total_figures} figure image{'s' if total_figures > 1 else ''} (AI analysis disabled)...")
    else:
        try:
            from chunking_pipeline.figure_processor import get_processor
            processor = get_processor()
            vision_available = True
            logger.info("Vision pipeline available for figure processing")
            _report_progress(metadata, stage="figures", total=total_figures, message=f"Vision pipeline ready, processing {total_figures} figure{'s' if total_figures > 1 else ''}...")
        except ImportError:
            processor = None
            vision_available = False
            logger.info("Vision pipeline not available - extracting images only")
            _report_progress(metadata, stage="figures", total=total_figures, message=f"Extracting {total_figures} figure image{'s' if total_figures > 1 else ''} (no vision pipeline)...")

    # Ensure figures directory exists
    figures_dir.mkdir(parents=True, exist_ok=True)

    figure_index = 0
    for el in elements:
        if el.get("type", "").lower() != "figure":
            continue

        figure_index += 1
        _report_progress(
            metadata,
            current=figure_index,
            total=total_figures,
            message="Extracting from PDF...",
            stage="figures",
        )

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

        # Process through vision pipeline if available (two-step: segment then mermaid)
        if vision_available and processor:
            try:
                ocr_text = el.get("content", "") or el.get("text", "")
                # Extract text positions from image using Azure DI (same as upload flow)
                _report_progress(
                    metadata,
                    current=figure_index,
                    total=total_figures,
                    message="Extracting text positions...",
                    stage="figures",
                )
                text_positions = processor.extract_text_positions_from_image(image_path)
                if text_positions:
                    logger.debug(
                        f"Extracted {len(text_positions)} text positions for {element_id}"
                    )

                # Step 1: SAM3 segmentation (creates .sam3.json + .annotated.png)
                _report_progress(
                    metadata,
                    current=figure_index,
                    total=total_figures,
                    message="Running SAM3 segmentation...",
                    stage="figures",
                )
                sam3_result = processor.segment_and_save(
                    image_path=image_path,
                    output_dir=figures_dir,
                    element_id=element_id,
                    ocr_text=ocr_text,
                    run_id=run_id,
                    text_positions=text_positions if text_positions else None,
                )

                # Step 2: Mermaid extraction (creates .json)
                _report_progress(
                    metadata,
                    current=figure_index,
                    total=total_figures,
                    message="Analyzing figure type...",
                    stage="figures",
                )
                result = processor.extract_mermaid_and_save(
                    image_path=image_path,
                    output_dir=figures_dir,
                    element_id=element_id,
                    ocr_text=ocr_text,
                    run_id=run_id,
                    text_positions=text_positions if text_positions else None,
                )

                # Get the figure type for display
                figure_type_raw = result.get("figure_type")
                # Handle both enum and string values
                if hasattr(figure_type_raw, "value"):
                    figure_type = figure_type_raw.value.lower()
                elif figure_type_raw:
                    figure_type = str(figure_type_raw).replace("FigureType.", "").lower()
                else:
                    figure_type = "unknown"

                el["figure_processing"] = {
                    "figure_type": result.get("figure_type"),
                    "confidence": result.get("confidence"),
                    "processed_content": result.get("processed_content"),
                    "description": result.get("description"),
                    "step1_duration_ms": result.get("step1_duration_ms"),
                    "step2_duration_ms": result.get("step2_duration_ms"),
                }
                # Update element text with formatted figure understanding
                # This ensures the chunk text includes the figure description
                formatted_text = processor.format_understanding(result)
                if formatted_text:
                    el["text"] = formatted_text
                    el["content"] = formatted_text

                # Report completion with figure type (just the type, counter shown separately)
                _report_progress(
                    metadata,
                    current=figure_index,
                    total=total_figures,
                    message=figure_type,
                    stage="figures",
                )
                logger.info(f"Processed figure {element_id}: {result.get('figure_type')}")
            except Exception as e:
                logger.error(f"Vision processing failed for {element_id}: {e}")
                el["figure_processing"] = {"error": str(e)}

    return elements


def _execute_extraction(metadata: Dict[str, Any]) -> None:
    """Worker function for Azure DI extraction.

    Called by the job manager with metadata containing all extraction parameters.
    Handles PDFs (with page slicing), Office documents (converted to PDF via Gotenberg),
    and images (processed directly).
    """
    input_file = Path(metadata["input_pdf"])  # Can be PDF, Office doc, or image
    trimmed_path = Path(metadata["trimmed_path"])
    elements_path = Path(metadata["elements_path"])
    meta_path = Path(metadata["meta_path"])
    pages_str = metadata["pages"]
    file_type = metadata.get("file_type") or get_file_type(input_file.name)

    # Determine if figures should be downloaded
    outputs = metadata.get("outputs") or []
    want_figures = any((o or "").lower() == "figures" for o in outputs)

    # Filter out internal flags (process_figures) before passing to Azure DI
    # Azure only accepts: Pdf, Figures
    azure_outputs = [o for o in outputs if (o or "").lower() != "process_figures"]

    # Build extractor config
    config = AzureDIConfig(
        model_id=metadata.get("model_id", "prebuilt-layout"),
        api_version=metadata.get("api_version", "2024-11-30"),
        features=metadata.get("features"),
        outputs=azure_outputs or None,
        locale=metadata.get("locale"),
        download_figures=want_figures,
    )

    # Determine figures output directory
    figures_output_dir = elements_path.parent if want_figures else None

    # Run extraction using PolicyAsCode's AzureDIExtractor
    extractor = AzureDIExtractor(config)

    # Handle different file types
    if file_type == "pdf":
        # PDFs: Parse pages, slice to requested range, then extract
        _report_progress(metadata, stage="prepare", message="Preparing PDF pages...")
        page_list = parse_pages(pages_str)
        valid_pages, dropped_pages, max_page = resolve_pages_in_document(str(input_file), page_list)
        if not valid_pages:
            raise ValueError(f"No valid pages requested; {input_file} has {max_page} pages.")
        if dropped_pages:
            logger.warning(f"Dropping out-of-range pages {dropped_pages}; document has {max_page} pages.")

        # Slice PDF to requested pages (creates the trimmed PDF artifact)
        slice_pdf(str(input_file), valid_pages, str(trimmed_path), warn_on_drop=False)
        _report_progress(metadata, stage="azure", message="Sending to Azure Document Intelligence...")

        # Extract from the sliced PDF
        extract_options = AzureDIExtractOptions(figures_output_dir=figures_output_dir)
        result = extractor.extract(str(trimmed_path), options=extract_options)
        pages_for_config = ",".join(str(p) for p in valid_pages)

    elif file_type == "office":
        # Office documents (DOCX, XLSX, PPTX): Gotenberg converts to PDF, then extract
        # PaC handles conversion internally; we save the converted PDF for UI display
        _report_progress(metadata, stage="convert", message="Converting Office document...")
        logger.info(f"Processing Office document: {input_file.name}")
        _report_progress(metadata, stage="azure", message="Sending to Azure Document Intelligence...")
        extract_options = AzureDIExtractOptions(
            figures_output_dir=figures_output_dir,
            save_converted_pdf=trimmed_path,  # Save converted PDF for UI viewing
        )
        result = extractor.extract(str(input_file), options=extract_options)
        # Office docs process all pages (no page selection)
        pages_for_config = "all"

    elif file_type == "image":
        # Images: Process directly, then convert to PDF for UI viewing
        _report_progress(metadata, stage="azure", message="Sending image to Azure Document Intelligence...")
        logger.info(f"Processing image: {input_file.name}")
        extract_options = AzureDIExtractOptions(figures_output_dir=figures_output_dir)
        result = extractor.extract(str(input_file), options=extract_options)
        # Images are single-page
        pages_for_config = "1"
        # Convert image to PDF for UI viewing
        _report_progress(metadata, stage="convert", message="Converting image to PDF...")
        slug_with_pages = metadata.get("slug_with_pages", "image")
        out_dir = elements_path.parent
        trimmed_path = _convert_image_to_pdf(input_file, out_dir, slug_with_pages)

    else:
        raise ValueError(f"Unsupported file type: {file_type} for {input_file}")

    # Convert elements to dict format for JSONL
    elems = [el.to_dict() for el in result.elements]

    # Count element types for progress reporting
    type_counts: Dict[str, int] = {}
    for el in elems:
        el_type = el.get("type", "unknown").lower()
        type_counts[el_type] = type_counts.get(el_type, 0) + 1

    # Build summary of what was found
    summary_parts = []
    if type_counts.get("paragraph", 0) + type_counts.get("text", 0) > 0:
        text_count = type_counts.get("paragraph", 0) + type_counts.get("text", 0)
        summary_parts.append(f"{text_count} text")
    if type_counts.get("table", 0) > 0:
        summary_parts.append(f"{type_counts['table']} table{'s' if type_counts['table'] > 1 else ''}")
    if type_counts.get("figure", 0) > 0:
        summary_parts.append(f"{type_counts['figure']} figure{'s' if type_counts['figure'] > 1 else ''}")

    summary = ", ".join(summary_parts) if summary_parts else "elements"
    _report_progress(metadata, stage="elements", message=f"Found {len(elems)} elements ({summary})")

    # Build extraction configuration metadata
    extraction_config: Dict[str, Any] = {
        "provider": "azure/document_intelligence",
        "input": str(input_file),
        "file_type": file_type,
        "pages": pages_for_config,
        "model_id": config.model_id,
        "api_version": config.api_version,
        "features": config.features or [],
    }
    if config.outputs:
        extraction_config["outputs"] = config.outputs
    if config.locale:
        extraction_config["locale"] = config.locale
    if metadata.get("primary_language"):
        extraction_config["primary_language"] = metadata["primary_language"]
    if metadata.get("ocr_languages"):
        extraction_config["ocr_languages"] = metadata["ocr_languages"]
    if metadata.get("languages"):
        extraction_config["languages"] = metadata["languages"]

    # Merge extraction metadata (detected languages, element count, etc.)
    # Serialize Pydantic models (like DetectedLanguage) to dicts for JSON compatibility
    for key, val in result.metadata.items():
        if isinstance(val, list):
            extraction_config[key] = [
                item.model_dump() if hasattr(item, "model_dump") else item for item in val
            ]
        elif hasattr(val, "model_dump"):
            extraction_config[key] = val.model_dump()
        else:
            extraction_config[key] = val

    # Process figures: extract images from PDF and run vision pipeline if enabled
    # Only process if we have a PDF (trimmed_path exists)
    if trimmed_path and trimmed_path.exists():
        figures_dir = elements_path.parent / f"{elements_path.stem.replace('.elements', '')}.figures"
        slug_with_pages = metadata.get("slug_with_pages")
        # Check if vision pipeline should run (process_figures in outputs list)
        run_vision_pipeline = any(
            (o or "").lower() == "process_figures"
            for o in (metadata.get("outputs") or [])
        )
        elems = _process_figures_after_extraction(
            elems, trimmed_path, figures_dir,
            run_id=slug_with_pages,
            metadata=metadata,
            run_vision_pipeline=run_vision_pipeline,
        )

    # Write outputs
    _report_progress(metadata, stage="writing", message="Writing extraction results...")
    _write_elements_jsonl(elements_path, elems)
    _write_extraction_metadata(meta_path, extraction_config)

    logger.info(f"Extraction complete: {len(elems)} elements written to {elements_path}")


@router.post("/api/extraction")
def api_extraction(payload: Dict[str, Any]) -> Dict[str, Any]:
    provider = str(payload.get("provider") or DEFAULT_PROVIDER).strip() or DEFAULT_PROVIDER
    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")
    if provider not in EXTRACTABLE_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=f"Provider '{provider}' is no longer supported for new extractions. "
            "Use 'azure/document_intelligence' instead.",
        )
    out_dir = get_out_dir(provider)

    # Accept 'pdf' field for backwards compatibility (now supports all document types)
    doc_name = str(payload.get("pdf") or payload.get("pdf_name") or "").strip()
    pages = str(payload.get("pages") or "").strip()
    if not doc_name:
        raise HTTPException(status_code=400, detail="Field 'pdf' is required")

    # Detect file type early
    file_type = get_file_type(doc_name)
    if not file_type:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {doc_name}")

    # All providers now output elements only; chunking is done via separate chunker
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

    input_file = RES_DIR / doc_name
    if not input_file.exists():
        raise HTTPException(status_code=404, detail=f"Document not found: {doc_name}")

    # Handle pages based on file type
    if file_type == "pdf":
        # PDFs: infer page range if not specified
        if not pages:
            try:
                from pypdf import PdfReader  # type: ignore

                reader = PdfReader(str(input_file))
                total = len(reader.pages)
                if total <= 0:
                    raise ValueError("empty PDF")
                pages = f"1-{total}"
            except Exception as e:  # pragma: no cover - defensive fallback
                raise HTTPException(status_code=400, detail=f"Could not infer page range: {e}")
    elif file_type == "office":
        # Office documents: process all pages (Gotenberg converts entire doc)
        pages = "all"
    elif file_type == "image":
        # Images: single page
        pages = "1"

    logger.info("Received extraction request provider=%s doc=%s type=%s pages=%s", provider, doc_name, file_type, pages)

    slug = input_file.stem
    raw_tag = str(payload.get("tag") or "").strip()
    safe_tag = None
    if raw_tag:
        safe_tag = re.sub(r"[^A-Za-z0-9_\\-]+", "-", raw_tag)[:40].strip("-")
    extraction_slug = f"{slug}__{safe_tag}" if safe_tag else slug
    pages_tag = safe_pages_tag(pages)
    out_dir.mkdir(parents=True, exist_ok=True)

    form_snapshot: Dict[str, Any] = {
        "pdf": doc_name,  # Keep 'pdf' key for backwards compatibility
        "file_type": file_type,
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
            out_dir / f"{slug_val}.{pages_tag}.extraction.json",
        )

    trimmed_out, elements_out, meta_out = build_paths(extraction_slug)

    if trimmed_out.exists() or elements_out.exists():
        n = 2
        base_variant = extraction_slug
        while True:
            candidate = f"{base_variant}__r{n}"
            p_out, e_out, m_out = build_paths(candidate)
            if not (e_out.exists() or p_out.exists()):
                extraction_slug = candidate
                trimmed_out, elements_out, meta_out = p_out, e_out, m_out
                break
            n += 1

    logger.info(
        "Submitting extraction slug=%s provider=%s",
        f"{extraction_slug}.{pages_tag}",
        provider,
    )

    # Build job metadata with all extraction parameters
    job_metadata = {
        # Job tracking fields
        "slug_with_pages": f"{extraction_slug}.{pages_tag}",
        "pages_tag": pages_tag,
        "doc_name": doc_name,
        "file_type": file_type,
        "pages": pages,
        "safe_tag": safe_tag,
        "raw_tag": raw_tag,
        "form_snapshot": payload.get("form_snapshot") or {},
        "provider": provider,
        # Output paths (input_pdf key kept for backwards compatibility in _run_extraction)
        "input_pdf": str(input_file),
        "trimmed_path": str(trimmed_out),
        "elements_path": str(elements_out),
        "meta_path": str(meta_out),
        # Extraction parameters for _execute_extraction()
        "model_id": azure_model_id,
        "features": normalized_features or None,
        "outputs": normalized_outputs or None,
        "locale": azure_locale,
        "primary_language": primary_language,
        "ocr_languages": ocr_languages,
        "languages": languages,
    }
    job = EXTRACTION_JOB_MANAGER.enqueue_callable(callable_fn=_execute_extraction, metadata=job_metadata)
    job_data = job.to_dict()
    logger.info(
        "Extraction queued job_id=%s slug=%s provider=%s",
        job_data.get("id"),
        job_metadata["slug_with_pages"],
        provider,
    )
    extraction_stub = {
        "slug": job_metadata["slug_with_pages"],
        "provider": provider,
        "file_type": file_type,
        "page_tag": pages_tag,
        "pdf_file": relative_to_root(trimmed_out) if trimmed_out.exists() else None,
        "elements_file": relative_to_root(elements_out) if elements_out.exists() else None,
        "chunks_file": None,  # Chunks created separately by chunker
        "extraction_config": job_metadata.get("form_snapshot"),
    }
    return {"status": "queued", "job": job_data, "extraction": extraction_stub}
