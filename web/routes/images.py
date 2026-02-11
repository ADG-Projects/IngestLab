"""Images/Figures routes for IngestLab.

Provides API endpoints for inspecting figures extracted from PDF runs
and uploading standalone images for processing through the vision pipeline.

EXPERIMENTAL: Depends on PolicyAsCode feature branch for full functionality.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import mimetypes
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import fitz  # PyMuPDF
from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image

from ..config import DEFAULT_PROVIDER, ROOT, get_out_dir
from ..file_utils import resolve_slug_file

router = APIRouter()
logger = logging.getLogger("chunking.routes.images")

# Directory for storing uploaded images (persisted for two-stage processing)
UPLOADS_DIR = ROOT / "outputs" / "uploads"


def _get_upload_dir(upload_id: str) -> Path:
    """Get the directory for an uploaded image."""
    return UPLOADS_DIR / upload_id


def _load_upload_metadata(upload_id: str) -> Optional[Dict[str, Any]]:
    """Load metadata for an uploaded image."""
    meta_path = _get_upload_dir(upload_id) / "metadata.json"
    if not meta_path.exists():
        return None
    try:
        with meta_path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, IOError):
        return None


def _resolve_pdf_file(slug: str, provider: str) -> Optional[Path]:
    """Resolve the trimmed PDF file for a given slug."""
    try:
        return resolve_slug_file(slug, "{slug}.pdf", provider=provider)
    except HTTPException:
        return None


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
        # Convert 1-indexed to 0-indexed
        page_idx = page_number - 1
        if page_idx < 0 or page_idx >= len(doc):
            logger.warning(f"Page {page_number} out of range for {pdf_path}")
            return None

        page = doc[page_idx]

        # Get coordinates - format is [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
        points = coordinates.get("points", [])
        if len(points) < 4:
            logger.warning(f"Invalid coordinates: {coordinates}")
            return None

        # Extract bounding box from corner points
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        x0, y0 = min(xs), min(ys)
        x1, y1 = max(xs), max(ys)

        # Create clip rectangle (coordinates are in PDF points)
        clip = fitz.Rect(x0, y0, x1, y1)

        # Render the clipped region
        zoom = dpi / 72.0  # PDF default is 72 dpi
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, clip=clip)

        doc.close()
        return pix.tobytes("png")

    except Exception as e:
        logger.exception(f"Failed to extract figure from PDF: {e}")
        return None


def _resolve_elements_file(slug: str, provider: str) -> Path:
    """Resolve elements JSONL file for a given slug."""
    try:
        return resolve_slug_file(slug, "{slug}.pages*.elements.jsonl", provider=provider)
    except HTTPException:
        pass
    try:
        return resolve_slug_file(slug, "{slug}.pages*.chunks.jsonl", provider=provider)
    except HTTPException:
        pass
    raise HTTPException(
        status_code=404,
        detail=f"No elements/chunks file found for {slug} (provider={provider})",
    )


def _load_figures_from_elements(elements_path: Path) -> List[Dict[str, Any]]:
    """Load figure elements from an elements JSONL file."""
    figures = []
    with elements_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                el = json.loads(line)
            except json.JSONDecodeError:
                continue
            if el.get("type", "").lower() == "figure":
                figures.append(el)
    return figures


def _get_figures_dir(elements_path: Path) -> Path:
    """Get the figures directory for a run (sibling .figures/ directory)."""
    base_stem = elements_path.stem.replace(".elements", "").replace(".chunks", "")
    return elements_path.parent / f"{base_stem}.figures"


def _load_figure_processing_result(figures_dir: Path, element_id: str) -> Optional[Dict[str, Any]]:
    """Load the processing result JSON for a figure if it exists."""
    json_path = figures_dir / f"{element_id}.json"
    if not json_path.exists():
        return None
    try:
        with json_path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, IOError):
        return None


def _load_sam3_result(figures_dir: Path, element_id: str) -> Optional[Dict[str, Any]]:
    """Load the SAM3 segmentation result for a figure if it exists."""
    sam3_path = figures_dir / f"{element_id}.sam3.json"
    if not sam3_path.exists():
        return None
    try:
        with sam3_path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, IOError):
        return None


def _load_all_elements(elements_path: Path) -> List[Dict[str, Any]]:
    """Load all elements from an elements JSONL file."""
    elements = []
    with elements_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                el = json.loads(line)
                elements.append(el)
            except json.JSONDecodeError:
                continue
    return elements


def _get_bbox_from_coordinates(coordinates: Dict[str, Any]) -> Optional[tuple]:
    """Extract bounding box (x0, y0, x1, y1) from coordinates dict.

    Coordinates format: {'points': [[x1,y1], [x2,y2], [x3,y3], [x4,y4]], ...}
    Returns: (min_x, min_y, max_x, max_y) or None if invalid.
    """
    points = coordinates.get("points", [])
    if len(points) < 4:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return (min(xs), min(ys), max(xs), max(ys))


def _boxes_overlap(
    coords1: Dict[str, Any],
    coords2: Dict[str, Any],
    margin: float = 10.0,
) -> bool:
    """Check if two coordinate boxes overlap or are within margin distance.

    Args:
        coords1: First coordinates dict with 'points'
        coords2: Second coordinates dict with 'points'
        margin: Extra margin to consider nearby boxes as overlapping

    Returns:
        True if boxes overlap or are within margin of each other.
    """
    bbox1 = _get_bbox_from_coordinates(coords1)
    bbox2 = _get_bbox_from_coordinates(coords2)
    if not bbox1 or not bbox2:
        return False

    x0_1, y0_1, x1_1, y1_1 = bbox1
    x0_2, y0_2, x1_2, y1_2 = bbox2

    # Expand first box by margin for proximity detection
    x0_1 -= margin
    y0_1 -= margin
    x1_1 += margin
    y1_1 += margin

    # Check for overlap
    if x1_1 < x0_2 or x1_2 < x0_1:
        return False
    if y1_1 < y0_2 or y1_2 < y0_1:
        return False
    return True


def _image_to_data_uri(image_path: Path) -> Optional[str]:
    """Convert an image file to a data URI."""
    if not image_path.exists():
        return None
    try:
        mime_type = mimetypes.guess_type(image_path.name)[0] or "image/png"
        data = image_path.read_bytes()
        b64 = base64.b64encode(data).decode("ascii")
        return f"data:{mime_type};base64,{b64}"
    except IOError:
        return None


# =============================================================================
# Upload Routes (must come BEFORE {slug} routes to avoid path conflicts)
# =============================================================================


@router.post("/api/figures/upload")
async def api_figure_upload(
    file: UploadFile = File(...),
) -> Dict[str, Any]:
    """Upload an image for processing through the vision pipeline.

    Returns upload_id for subsequent segment/extract-mermaid calls.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    # Validate file type
    allowed_types = {"image/png", "image/jpeg", "image/jpg", "image/webp"}
    content_type = file.content_type or mimetypes.guess_type(file.filename)[0]
    if content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type: {content_type}. Allowed: {', '.join(allowed_types)}",
        )

    # Create upload directory
    upload_id = str(uuid.uuid4())[:8]
    upload_dir = _get_upload_dir(upload_id)
    upload_dir.mkdir(parents=True, exist_ok=True)

    # Save the image
    suffix = Path(file.filename).suffix or ".png"
    image_path = upload_dir / f"original{suffix}"
    content = await file.read()
    image_path.write_bytes(content)

    # Extract image dimensions
    try:
        with Image.open(io.BytesIO(content)) as img:
            image_width, image_height = img.size
    except Exception:
        image_width, image_height = None, None

    # Save metadata
    metadata = {
        "upload_id": upload_id,
        "filename": file.filename,
        "content_type": content_type,
        "image_path": str(image_path),
        "image_width": image_width,
        "image_height": image_height,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }
    meta_path = upload_dir / "metadata.json"
    with meta_path.open("w", encoding="utf-8") as fh:
        json.dump(metadata, fh, ensure_ascii=False, indent=2)

    # Include base64 of original image for display
    b64 = base64.b64encode(content).decode("ascii")
    data_uri = f"data:{content_type};base64,{b64}"

    return {
        "status": "ok",
        "stage": "uploaded",
        "upload_id": upload_id,
        "filename": file.filename,
        "original_image_data_uri": data_uri,
    }


@router.get("/api/uploads")
def api_uploads_list() -> Dict[str, Any]:
    """List all uploaded images with their processing status.

    Returns uploads sorted by date (newest first).
    """
    uploads = []

    if not UPLOADS_DIR.exists():
        return {"uploads": [], "total": 0}

    for upload_dir in UPLOADS_DIR.iterdir():
        if not upload_dir.is_dir():
            continue

        upload_id = upload_dir.name
        metadata = _load_upload_metadata(upload_id)
        if not metadata:
            continue

        # Load classification result if available
        classification_result = None
        classification_path = upload_dir / "classification.json"
        if classification_path.exists():
            try:
                with classification_path.open("r", encoding="utf-8") as fh:
                    classification_result = json.load(fh)
            except (json.JSONDecodeError, IOError):
                pass

        # Load direction result if available
        direction_result = None
        direction_path = upload_dir / "direction.json"
        if direction_path.exists():
            try:
                with direction_path.open("r", encoding="utf-8") as fh:
                    direction_result = json.load(fh)
            except (json.JSONDecodeError, IOError):
                pass

        # Load description result if available
        description_result = None
        description_path = upload_dir / "description.json"
        if description_path.exists():
            try:
                with description_path.open("r", encoding="utf-8") as fh:
                    description_result = json.load(fh)
            except (json.JSONDecodeError, IOError):
                pass

        # Load processing results if available
        sam3_result = None
        sam3_path = upload_dir / "sam3.json"
        if sam3_path.exists():
            try:
                with sam3_path.open("r", encoding="utf-8") as fh:
                    sam3_result = json.load(fh)
            except (json.JSONDecodeError, IOError):
                pass

        proc_result = None
        proc_path = upload_dir / "result.json"
        if proc_path.exists():
            try:
                with proc_path.open("r", encoding="utf-8") as fh:
                    proc_result = json.load(fh)
            except (json.JSONDecodeError, IOError):
                pass

        # Determine figure type and confidence (prefer latest result)
        figure_type = None
        confidence = None
        if proc_result:
            figure_type = proc_result.get("figure_type")
            confidence = proc_result.get("confidence")
        elif sam3_result:
            figure_type = sam3_result.get("figure_type")
            confidence = sam3_result.get("confidence")
        elif classification_result:
            figure_type = classification_result.get("figure_type")
            confidence = classification_result.get("confidence")

        # Get direction
        direction = None
        if direction_result:
            direction = direction_result.get("direction")
        elif sam3_result:
            direction = sam3_result.get("direction")

        # Determine stages
        stages = {
            "uploaded": True,
            "classified": classification_result is not None,
            "described": description_result is not None,
            "direction_detected": direction_result is not None,
            "segmented": sam3_result is not None,
            "extracted": proc_result is not None,
        }

        uploads.append({
            "upload_id": upload_id,
            "filename": metadata.get("filename"),
            "uploaded_at": metadata.get("uploaded_at"),
            "figure_type": figure_type,
            "confidence": confidence,
            "direction": direction,
            "stages": stages,
        })

    # Sort by upload date (newest first)
    uploads.sort(key=lambda x: x.get("uploaded_at") or "", reverse=True)

    return {"uploads": uploads, "total": len(uploads)}


@router.delete("/api/figures/upload/{upload_id}")
def api_delete_upload(upload_id: str) -> Dict[str, Any]:
    """Delete an upload and all associated files."""
    upload_dir = _get_upload_dir(upload_id)

    if not upload_dir.exists():
        raise HTTPException(status_code=404, detail=f"Upload {upload_id} not found")

    try:
        removed_files = []
        for file_path in upload_dir.rglob("*"):
            if file_path.is_file():
                # Use relative path from root for cleaner output
                try:
                    rel_path = file_path.relative_to(ROOT)
                    removed_files.append(str(rel_path))
                except ValueError:
                    removed_files.append(str(file_path))

        shutil.rmtree(upload_dir)

        return {
            "status": "ok",
            "upload_id": upload_id,
            "removed": removed_files,
        }
    except Exception as e:
        logger.error(f"Failed to delete upload {upload_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete upload files")


@router.get("/api/figures/upload/{upload_id}")
def api_upload_detail(upload_id: str) -> Dict[str, Any]:
    """Get details for an uploaded image including processing status."""
    metadata = _load_upload_metadata(upload_id)
    if not metadata:
        raise HTTPException(status_code=404, detail=f"Upload {upload_id} not found")

    upload_dir = _get_upload_dir(upload_id)

    # Load classification result if available
    classification_result = None
    classification_path = upload_dir / "classification.json"
    if classification_path.exists():
        try:
            with classification_path.open("r", encoding="utf-8") as fh:
                classification_result = json.load(fh)
        except (json.JSONDecodeError, IOError):
            pass

    # Load direction result if available
    direction_result = None
    direction_path = upload_dir / "direction.json"
    if direction_path.exists():
        try:
            with direction_path.open("r", encoding="utf-8") as fh:
                direction_result = json.load(fh)
        except (json.JSONDecodeError, IOError):
            pass

    # Load description result if available (for OTHER type images)
    description_result = None
    description_path = upload_dir / "description.json"
    if description_path.exists():
        try:
            with description_path.open("r", encoding="utf-8") as fh:
                description_result = json.load(fh)
        except (json.JSONDecodeError, IOError):
            pass

    # Check processing stages
    sam3_result = None
    sam3_path = upload_dir / "sam3.json"
    if sam3_path.exists():
        with sam3_path.open("r", encoding="utf-8") as fh:
            sam3_result = json.load(fh)

    proc_result = None
    proc_path = upload_dir / "result.json"
    if proc_path.exists():
        with proc_path.open("r", encoding="utf-8") as fh:
            proc_result = json.load(fh)

    # Determine stages
    stages = {
        "uploaded": True,
        "classified": classification_result is not None,
        "described": description_result is not None,
        "direction_detected": direction_result is not None,
        "segmented": sam3_result is not None,
        "extracted": proc_result is not None,
    }

    # Build response
    result: Dict[str, Any] = {
        "upload_id": upload_id,
        "filename": metadata.get("filename"),
        "image_width": metadata.get("image_width"),
        "image_height": metadata.get("image_height"),
        "stages": stages,
    }

    if classification_result:
        result["classification"] = {
            "figure_type": classification_result.get("figure_type"),
            "confidence": classification_result.get("confidence"),
            "reasoning": classification_result.get("reasoning"),
            "classification_duration_ms": classification_result.get("classification_duration_ms"),
        }

    if direction_result:
        result["direction"] = {
            "direction": direction_result.get("direction"),
            "direction_duration_ms": direction_result.get("direction_duration_ms"),
        }

    if description_result:
        result["description"] = {
            "description": description_result.get("description"),
            "processed_content": description_result.get("processed_content"),
            "description_duration_ms": description_result.get("description_duration_ms"),
        }

    if sam3_result:
        result["sam3"] = {
            "figure_type": sam3_result.get("figure_type"),
            "confidence": sam3_result.get("confidence"),
            "direction": sam3_result.get("direction"),
            "shape_count": len(sam3_result.get("shape_positions") or []),
            "shape_positions": sam3_result.get("shape_positions"),
            "classification_duration_ms": sam3_result.get("classification_duration_ms"),
            "sam3_duration_ms": sam3_result.get("sam3_duration_ms"),
        }

    if proc_result:
        result["processing"] = {
            "figure_type": proc_result.get("figure_type"),
            "confidence": proc_result.get("confidence"),
            "processed_content": proc_result.get("processed_content"),
            "description": proc_result.get("description"),
            "intermediate_nodes": proc_result.get("intermediate_nodes"),
            "intermediate_edges": proc_result.get("intermediate_edges"),
            "reasoning_trace": proc_result.get("reasoning_trace"),
        }

    # Check for annotated image
    annotated_path = upload_dir / "annotated.png"
    result["has_annotated_image"] = annotated_path.exists()

    return result


@router.get("/api/figures/upload/{upload_id}/image/original")
def api_upload_image_original(upload_id: str) -> FileResponse:
    """Serve the original uploaded image."""
    metadata = _load_upload_metadata(upload_id)
    if not metadata:
        raise HTTPException(status_code=404, detail=f"Upload {upload_id} not found")

    image_path = Path(metadata["image_path"])
    if not image_path.exists():
        raise HTTPException(status_code=404, detail="Image file not found")

    return FileResponse(image_path, media_type=metadata.get("content_type", "image/png"))


@router.get("/api/figures/upload/{upload_id}/image/annotated")
def api_upload_image_annotated(upload_id: str) -> FileResponse:
    """Serve the SAM3-annotated uploaded image."""
    upload_dir = _get_upload_dir(upload_id)
    if not upload_dir.exists():
        raise HTTPException(status_code=404, detail=f"Upload {upload_id} not found")

    annotated_path = upload_dir / "annotated.png"
    if not annotated_path.exists():
        raise HTTPException(status_code=404, detail="Annotated image not available")

    return FileResponse(annotated_path, media_type="image/png")


@router.post("/api/figures/upload/{upload_id}/classify")
def api_upload_classify(upload_id: str) -> Dict[str, Any]:
    """Run classification only on an uploaded image (fast, automatic step).

    This is called automatically after upload to quickly determine the figure type
    without running the expensive SAM3 segmentation.
    """
    metadata = _load_upload_metadata(upload_id)
    if not metadata:
        raise HTTPException(status_code=404, detail=f"Upload {upload_id} not found")

    image_path = Path(metadata["image_path"])
    if not image_path.exists():
        raise HTTPException(status_code=404, detail="Image file not found")

    upload_dir = _get_upload_dir(upload_id)

    try:
        from chunking_pipeline.figure_processor import get_processor

        processor = get_processor()
        result = processor.classify_only(image_path, ocr_text="", run_id=f"upload-{upload_id}")

        # Save classification results
        classification_data = {
            "figure_type": result.get("figure_type"),
            "confidence": result.get("confidence"),
            "reasoning": result.get("reasoning"),
            "classification_duration_ms": result.get("classification_duration_ms"),
            "classified_at": datetime.now(timezone.utc).isoformat(),
        }
        classification_path = upload_dir / "classification.json"
        with classification_path.open("w", encoding="utf-8") as fh:
            json.dump(classification_data, fh, ensure_ascii=False, indent=2)

        return {
            "status": "ok",
            "stage": "classified",
            "upload_id": upload_id,
            "figure_type": result.get("figure_type"),
            "confidence": result.get("confidence"),
            "reasoning": result.get("reasoning"),
            "classification_duration_ms": result.get("classification_duration_ms"),
        }
    except ImportError as e:
        logger.exception(f"Import error during classification: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Figure processing import error: {e}",
        )
    except Exception as e:
        logger.exception(f"Failed to classify upload {upload_id}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/figures/upload/{upload_id}/describe")
def api_upload_describe(upload_id: str) -> Dict[str, Any]:
    """Generate LLM description for non-flowchart images (auto step for OTHER type).

    This is called automatically after classification if the figure is classified
    as OTHER. It generates a description directly without SAM3/Mermaid processing.
    """
    metadata = _load_upload_metadata(upload_id)
    if not metadata:
        raise HTTPException(status_code=404, detail=f"Upload {upload_id} not found")

    image_path = Path(metadata["image_path"])
    if not image_path.exists():
        raise HTTPException(status_code=404, detail="Image file not found")

    upload_dir = _get_upload_dir(upload_id)

    try:
        from chunking_pipeline.figure_processor import get_processor

        processor = get_processor()
        result = processor.describe_only(image_path, ocr_text="", run_id=f"upload-{upload_id}")

        # Save description results
        description_data = {
            "figure_type": result.get("figure_type"),
            "description": result.get("description"),
            "processed_content": result.get("processed_content"),
            "description_duration_ms": result.get("description_duration_ms"),
            "described_at": datetime.now(timezone.utc).isoformat(),
        }
        description_path = upload_dir / "description.json"
        with description_path.open("w", encoding="utf-8") as fh:
            json.dump(description_data, fh, ensure_ascii=False, indent=2)

        return {
            "status": "ok",
            "stage": "described",
            "upload_id": upload_id,
            "figure_type": result.get("figure_type"),
            "description": result.get("description"),
            "processed_content": result.get("processed_content"),
            "description_duration_ms": result.get("description_duration_ms"),
        }
    except ImportError as e:
        logger.exception(f"Import error during description generation: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Figure processing import error: {e}",
        )
    except Exception as e:
        logger.exception(f"Failed to describe upload {upload_id}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/figures/upload/{upload_id}/detect-direction")
def api_upload_detect_direction(upload_id: str) -> Dict[str, Any]:
    """Detect flow direction for flowcharts (auto step after classification).

    This is called automatically after classification if the figure is a flowchart.
    """
    metadata = _load_upload_metadata(upload_id)
    if not metadata:
        raise HTTPException(status_code=404, detail=f"Upload {upload_id} not found")

    image_path = Path(metadata["image_path"])
    if not image_path.exists():
        raise HTTPException(status_code=404, detail="Image file not found")

    upload_dir = _get_upload_dir(upload_id)

    try:
        from chunking_pipeline.figure_processor import get_processor

        processor = get_processor()
        result = processor.detect_direction_only(image_path, run_id=f"upload-{upload_id}")

        # Save direction results
        direction_data = {
            "direction": result.get("direction"),
            "direction_duration_ms": result.get("direction_duration_ms"),
            "detected_at": datetime.now(timezone.utc).isoformat(),
        }
        direction_path = upload_dir / "direction.json"
        with direction_path.open("w", encoding="utf-8") as fh:
            json.dump(direction_data, fh, ensure_ascii=False, indent=2)

        return {
            "status": "ok",
            "stage": "direction_detected",
            "upload_id": upload_id,
            "direction": result.get("direction"),
            "direction_duration_ms": result.get("direction_duration_ms"),
        }
    except ImportError as e:
        logger.exception(f"Import error during direction detection: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Figure processing import error: {e}",
        )
    except Exception as e:
        logger.exception(f"Failed to detect direction for upload {upload_id}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/figures/upload/{upload_id}/segment")
def api_upload_segment(upload_id: str) -> Dict[str, Any]:
    """Run SAM3 segmentation on an uploaded image (stage 1)."""
    metadata = _load_upload_metadata(upload_id)
    if not metadata:
        raise HTTPException(status_code=404, detail=f"Upload {upload_id} not found")

    image_path = Path(metadata["image_path"])
    if not image_path.exists():
        raise HTTPException(status_code=404, detail="Image file not found")

    upload_dir = _get_upload_dir(upload_id)

    try:
        from chunking_pipeline.figure_processor import get_processor

        processor = get_processor()

        # Extract text positions from image using Azure DI
        text_positions = processor.extract_text_positions_from_image(image_path)
        logger.info(f"Extracted {len(text_positions)} text positions for segmentation")

        result = processor.segment_only(
            image_path,
            ocr_text="",
            run_id=f"upload-{upload_id}",
            text_positions=text_positions,
        )

        # Copy annotated image if generated
        if result.get("annotated_path"):
            src_annotated = Path(result["annotated_path"])
            if src_annotated.exists():
                dst_annotated = upload_dir / "annotated.png"
                shutil.copy2(src_annotated, dst_annotated)
                result["annotated_path"] = str(dst_annotated)

        # Save SAM3 results (including text_positions for Mermaid extraction)
        sam3_data = {
            "figure_type": result.get("figure_type"),
            "confidence": result.get("confidence"),
            "reasoning": result.get("reasoning"),
            "direction": result.get("direction"),
            "classification_duration_ms": result.get("classification_duration_ms"),
            "sam3_duration_ms": result.get("sam3_duration_ms"),
            "shape_positions": result.get("shape_positions"),
            "text_positions": result.get("text_positions"),
            "segmented_at": datetime.now(timezone.utc).isoformat(),
        }
        sam3_path = upload_dir / "sam3.json"
        with sam3_path.open("w", encoding="utf-8") as fh:
            json.dump(sam3_data, fh, ensure_ascii=False, indent=2)

        return {
            "status": "ok",
            "stage": "segmented",
            "upload_id": upload_id,
            "figure_type": result.get("figure_type"),
            "confidence": result.get("confidence"),
            "direction": result.get("direction"),
            "shape_count": len(result.get("shape_positions") or []),
            "classification_duration_ms": result.get("classification_duration_ms"),
            "sam3_duration_ms": result.get("sam3_duration_ms"),
        }
    except ImportError as e:
        logger.exception(f"Import error during segmentation: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Figure processing import error: {e}",
        )
    except Exception as e:
        logger.exception(f"Failed to segment upload {upload_id}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/figures/upload/{upload_id}/extract-mermaid")
def api_upload_extract_mermaid(upload_id: str) -> Dict[str, Any]:
    """Run mermaid extraction on an uploaded image (stage 2).

    Prerequisite: /segment must have been called first.
    """
    metadata = _load_upload_metadata(upload_id)
    if not metadata:
        raise HTTPException(status_code=404, detail=f"Upload {upload_id} not found")

    upload_dir = _get_upload_dir(upload_id)

    # Check SAM3 results exist
    sam3_path = upload_dir / "sam3.json"
    if not sam3_path.exists():
        raise HTTPException(
            status_code=400,
            detail="SAM3 segmentation not found. Run /segment first.",
        )

    with sam3_path.open("r", encoding="utf-8") as fh:
        sam3_result = json.load(fh)

    image_path = Path(metadata["image_path"])
    if not image_path.exists():
        raise HTTPException(status_code=404, detail="Image file not found")

    # Use annotated image if available
    annotated_path = upload_dir / "annotated.png"
    if annotated_path.exists():
        sam3_result["annotated_path"] = str(annotated_path)

    try:
        from chunking_pipeline.figure_processor import get_processor

        processor = get_processor()
        result = processor.extract_mermaid_from_sam3(
            image_path, sam3_result, ocr_text="", run_id=f"upload-{upload_id}"
        )

        # Save full results
        result_path = upload_dir / "result.json"
        with result_path.open("w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)

        return {
            "status": "ok",
            "stage": "complete",
            "upload_id": upload_id,
            "figure_type": result.get("figure_type"),
            "processed_content": result.get("processed_content"),
            "description": result.get("description"),
            "intermediate_nodes": result.get("intermediate_nodes"),
            "intermediate_edges": result.get("intermediate_edges"),
            "step1_duration_ms": result.get("step1_duration_ms"),
            "step2_duration_ms": result.get("step2_duration_ms"),
        }
    except ImportError as e:
        logger.exception(f"Import error during mermaid extraction: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Figure processing import error: {e}",
        )
    except Exception as e:
        logger.exception(f"Failed to extract mermaid for upload {upload_id}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/figures/upload/{upload_id}/reprocess")
def api_upload_reprocess(
    upload_id: str,
    force_type: Optional[str] = Query(default=None, description="Force figure type: 'flowchart' or 'other'. If not provided, runs auto-classification."),
) -> Dict[str, Any]:
    """Reprocess an uploaded image with optional forced type.

    When force_type is provided:
    - "flowchart": Runs Direction Detection → SAM3 → Mermaid Extraction (skips classification)
    - "other": Runs Description generation (skips classification, SAM3, Mermaid)

    When force_type is not provided, runs the full auto-detection pipeline.
    """
    metadata = _load_upload_metadata(upload_id)
    if not metadata:
        raise HTTPException(status_code=404, detail=f"Upload {upload_id} not found")

    image_path = Path(metadata["image_path"])
    if not image_path.exists():
        raise HTTPException(status_code=404, detail="Image file not found")

    upload_dir = _get_upload_dir(upload_id)

    try:
        from chunking_pipeline.figure_processor import get_processor

        processor = get_processor()

        if force_type == "flowchart":
            # Forced flowchart pipeline: Direction → SAM3 → Mermaid
            # Save forced classification
            classification_data = {
                "figure_type": "flowchart",
                "confidence": 1.0,
                "reasoning": "Type forced to flowchart by user",
                "classified_at": datetime.now(timezone.utc).isoformat(),
            }
            classification_path = upload_dir / "classification.json"
            with classification_path.open("w", encoding="utf-8") as fh:
                json.dump(classification_data, fh, ensure_ascii=False, indent=2)

            # Run direction detection
            direction_result = processor.detect_direction_only(image_path, run_id=f"upload-{upload_id}")
            direction_data = {
                "direction": direction_result.get("direction"),
                "direction_duration_ms": direction_result.get("direction_duration_ms"),
                "detected_at": datetime.now(timezone.utc).isoformat(),
            }
            direction_path = upload_dir / "direction.json"
            with direction_path.open("w", encoding="utf-8") as fh:
                json.dump(direction_data, fh, ensure_ascii=False, indent=2)

            # Extract text positions
            text_positions = processor.extract_text_positions_from_image(image_path)

            # Run SAM3 segmentation with forced flowchart type
            # Run SAM3 with forced direction
            try:
                annotated_path, shape_positions, annotated_text_positions = processor._get_processor().segment_and_annotate(
                    image_path,
                    text_positions=text_positions,
                    direction=direction_result.get("direction", "LR"),
                )
            except RuntimeError as e:
                # SAM3 found no shapes - this is a user-facing error when forcing flowchart
                error_msg = str(e)
                if "no shapes" in error_msg.lower():
                    raise HTTPException(
                        status_code=400,
                        detail="SAM3 found no shapes in this image. This image may not be a flowchart. Try 'Auto-detect' or 'Force Other' instead.",
                    )
                raise

            # Copy annotated image if generated
            if annotated_path:
                src_annotated = Path(annotated_path)
                if src_annotated.exists():
                    dst_annotated = upload_dir / "annotated.png"
                    shutil.copy2(src_annotated, dst_annotated)

            # Save SAM3 results
            sam3_data = {
                "figure_type": "flowchart",
                "confidence": 1.0,
                "reasoning": "Type forced to flowchart by user",
                "direction": direction_result.get("direction"),
                "shape_positions": shape_positions,
                "text_positions": annotated_text_positions or text_positions,
                "segmented_at": datetime.now(timezone.utc).isoformat(),
            }
            sam3_path = upload_dir / "sam3.json"
            with sam3_path.open("w", encoding="utf-8") as fh:
                json.dump(sam3_data, fh, ensure_ascii=False, indent=2)

            # Run Mermaid extraction
            sam3_result = sam3_data.copy()
            if (upload_dir / "annotated.png").exists():
                sam3_result["annotated_path"] = str(upload_dir / "annotated.png")

            mermaid_result = processor.extract_mermaid_from_sam3(
                image_path, sam3_result, ocr_text="", run_id=f"upload-{upload_id}"
            )

            # Save full results
            result_path = upload_dir / "result.json"
            with result_path.open("w", encoding="utf-8") as fh:
                json.dump(mermaid_result, fh, ensure_ascii=False, indent=2)

            return {
                "status": "ok",
                "stage": "complete",
                "force_type": force_type,
                "upload_id": upload_id,
                "figure_type": "flowchart",
                "processed_content": mermaid_result.get("processed_content"),
            }

        elif force_type == "other":
            # Forced OTHER pipeline: Just generate description
            # Save forced classification
            classification_data = {
                "figure_type": "other",
                "confidence": 1.0,
                "reasoning": "Type forced to other by user",
                "classified_at": datetime.now(timezone.utc).isoformat(),
            }
            classification_path = upload_dir / "classification.json"
            with classification_path.open("w", encoding="utf-8") as fh:
                json.dump(classification_data, fh, ensure_ascii=False, indent=2)

            # Run description generation
            description_result = processor.describe_only(image_path, ocr_text="", run_id=f"upload-{upload_id}")

            # Save description results
            description_data = {
                "figure_type": "other",
                "description": description_result.get("description"),
                "processed_content": description_result.get("processed_content"),
                "description_duration_ms": description_result.get("description_duration_ms"),
                "described_at": datetime.now(timezone.utc).isoformat(),
            }
            description_path = upload_dir / "description.json"
            with description_path.open("w", encoding="utf-8") as fh:
                json.dump(description_data, fh, ensure_ascii=False, indent=2)

            return {
                "status": "ok",
                "stage": "described",
                "force_type": force_type,
                "upload_id": upload_id,
                "figure_type": "other",
                "description": description_result.get("description"),
            }

        else:
            # No force_type - run full auto-detection pipeline
            # This is equivalent to what runUploadFullPipeline does on frontend
            # but as a single endpoint for convenience

            # Step 1: Classification
            classification_result = processor.classify_only(image_path, ocr_text="", run_id=f"upload-{upload_id}")

            classification_data = {
                "figure_type": classification_result.get("figure_type"),
                "confidence": classification_result.get("confidence"),
                "reasoning": classification_result.get("reasoning"),
                "classification_duration_ms": classification_result.get("classification_duration_ms"),
                "classified_at": datetime.now(timezone.utc).isoformat(),
            }
            classification_path = upload_dir / "classification.json"
            with classification_path.open("w", encoding="utf-8") as fh:
                json.dump(classification_data, fh, ensure_ascii=False, indent=2)

            figure_type = classification_result.get("figure_type")

            if figure_type == "flowchart":
                # Flowchart pipeline
                direction_result = processor.detect_direction_only(image_path, run_id=f"upload-{upload_id}")
                direction_data = {
                    "direction": direction_result.get("direction"),
                    "direction_duration_ms": direction_result.get("direction_duration_ms"),
                    "detected_at": datetime.now(timezone.utc).isoformat(),
                }
                direction_path = upload_dir / "direction.json"
                with direction_path.open("w", encoding="utf-8") as fh:
                    json.dump(direction_data, fh, ensure_ascii=False, indent=2)

                # SAM3 segmentation
                text_positions = processor.extract_text_positions_from_image(image_path)
                segment_result = processor.segment_only(
                    image_path, ocr_text="", run_id=f"upload-{upload_id}",
                    text_positions=text_positions
                )

                if segment_result.get("annotated_path"):
                    src_annotated = Path(segment_result["annotated_path"])
                    if src_annotated.exists():
                        dst_annotated = upload_dir / "annotated.png"
                        shutil.copy2(src_annotated, dst_annotated)
                        segment_result["annotated_path"] = str(dst_annotated)

                sam3_data = {
                    "figure_type": segment_result.get("figure_type"),
                    "confidence": segment_result.get("confidence"),
                    "reasoning": segment_result.get("reasoning"),
                    "direction": segment_result.get("direction"),
                    "shape_positions": segment_result.get("shape_positions"),
                    "text_positions": segment_result.get("text_positions"),
                    "sam3_duration_ms": segment_result.get("sam3_duration_ms"),
                    "segmented_at": datetime.now(timezone.utc).isoformat(),
                }
                sam3_path = upload_dir / "sam3.json"
                with sam3_path.open("w", encoding="utf-8") as fh:
                    json.dump(sam3_data, fh, ensure_ascii=False, indent=2)

                # Mermaid extraction
                sam3_result = sam3_data.copy()
                if (upload_dir / "annotated.png").exists():
                    sam3_result["annotated_path"] = str(upload_dir / "annotated.png")

                mermaid_result = processor.extract_mermaid_from_sam3(
                    image_path, sam3_result, ocr_text="", run_id=f"upload-{upload_id}"
                )

                result_path = upload_dir / "result.json"
                with result_path.open("w", encoding="utf-8") as fh:
                    json.dump(mermaid_result, fh, ensure_ascii=False, indent=2)

                return {
                    "status": "ok",
                    "stage": "complete",
                    "upload_id": upload_id,
                    "figure_type": "flowchart",
                    "processed_content": mermaid_result.get("processed_content"),
                }
            else:
                # OTHER pipeline
                description_result = processor.describe_only(image_path, ocr_text="", run_id=f"upload-{upload_id}")

                description_data = {
                    "figure_type": "other",
                    "description": description_result.get("description"),
                    "processed_content": description_result.get("processed_content"),
                    "description_duration_ms": description_result.get("description_duration_ms"),
                    "described_at": datetime.now(timezone.utc).isoformat(),
                }
                description_path = upload_dir / "description.json"
                with description_path.open("w", encoding="utf-8") as fh:
                    json.dump(description_data, fh, ensure_ascii=False, indent=2)

                return {
                    "status": "ok",
                    "stage": "described",
                    "upload_id": upload_id,
                    "figure_type": "other",
                    "description": description_result.get("description"),
                }

    except ImportError as e:
        logger.exception(f"Import error during upload reprocess: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Figure processing import error: {e}",
        )
    except Exception as e:
        logger.exception(f"Failed to reprocess upload {upload_id}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# PDF Figure Routes (with {slug} path parameters)
# =============================================================================


@router.get("/api/figures/{slug}")
def api_figures_list(
    slug: str,
    provider: str = Query(default=None),
    status: Optional[str] = Query(default=None, description="Filter by status: processed, pending, error"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
) -> Dict[str, Any]:
    """List figures from a run with pagination and status filtering."""
    provider_key = provider or DEFAULT_PROVIDER
    elements_path = _resolve_elements_file(slug, provider_key)
    figures_dir = _get_figures_dir(elements_path)

    all_figures = _load_figures_from_elements(elements_path)

    # Enrich with processing status
    enriched = []
    for fig in all_figures:
        element_id = fig.get("element_id", "")
        md = fig.get("metadata", {})
        figure_image = md.get("figure_image_filename") or fig.get("figure_image_filename")

        # Check processing result
        proc_result = _load_figure_processing_result(figures_dir, element_id)
        figure_processing = fig.get("figure_processing", {})

        if proc_result:
            proc_status = "processed"
            figure_type = proc_result.get("figure_type")
            confidence = proc_result.get("confidence")
        elif figure_processing.get("error"):
            proc_status = "error"
            figure_type = None
            confidence = None
        elif figure_processing.get("figure_type"):
            proc_status = "processed"
            figure_type = figure_processing.get("figure_type")
            confidence = figure_processing.get("confidence")
        else:
            proc_status = "pending"
            figure_type = None
            confidence = None

        enriched.append({
            "element_id": element_id,
            "page_number": fig.get("page_number") or md.get("page_number"),
            "figure_image": figure_image,
            "status": proc_status,
            "figure_type": figure_type,
            "confidence": confidence,
            "has_mermaid": bool(
                figure_type == "flowchart"
                and (
                    (proc_result or {}).get("processed_content")
                    or figure_processing.get("processed_content")
                )
            ),
        })

    # Apply status filter
    if status:
        enriched = [f for f in enriched if f["status"] == status]

    # Pagination
    total = len(enriched)
    start = (page - 1) * limit
    end = start + limit
    paginated = enriched[start:end]

    return {
        "figures": paginated,
        "total": total,
        "page": page,
        "limit": limit,
        "has_more": end < total,
    }


@router.get("/api/figures/{slug}/stats")
def api_figures_stats(
    slug: str,
    provider: str = Query(default=None),
) -> Dict[str, Any]:
    """Get processing statistics for figures in a run."""
    provider_key = provider or DEFAULT_PROVIDER
    elements_path = _resolve_elements_file(slug, provider_key)
    figures_dir = _get_figures_dir(elements_path)

    figures = _load_figures_from_elements(elements_path)

    stats = {
        "total": len(figures),
        "processed": 0,
        "pending": 0,
        "error": 0,
        "by_type": {},
    }

    for fig in figures:
        element_id = fig.get("element_id", "")
        figure_processing = fig.get("figure_processing", {})
        proc_result = _load_figure_processing_result(figures_dir, element_id)

        if proc_result or figure_processing.get("figure_type"):
            stats["processed"] += 1
            fig_type = (proc_result or figure_processing).get("figure_type", "unknown")
            stats["by_type"][fig_type] = stats["by_type"].get(fig_type, 0) + 1
        elif figure_processing.get("error"):
            stats["error"] += 1
        else:
            stats["pending"] += 1

    return stats


@router.get("/api/figures/{slug}/{element_id}")
def api_figure_detail(
    slug: str,
    element_id: str,
    provider: str = Query(default=None),
) -> Dict[str, Any]:
    """Get detailed information for a specific figure."""
    provider_key = provider or DEFAULT_PROVIDER
    elements_path = _resolve_elements_file(slug, provider_key)
    figures_dir = _get_figures_dir(elements_path)

    # Find the figure element (search by element_id first, then by original_element_id)
    figures = _load_figures_from_elements(elements_path)
    target = None
    resolved_element_id = element_id
    for fig in figures:
        if fig.get("element_id") == element_id:
            target = fig
            break
        # Also check original_element_id in metadata
        fig_md = fig.get("metadata", {})
        if fig_md.get("original_element_id") == element_id:
            target = fig
            resolved_element_id = fig.get("element_id", element_id)
            break

    if not target:
        raise HTTPException(status_code=404, detail=f"Figure {element_id} not found")

    md = target.get("metadata", {})
    figure_image = md.get("figure_image_filename") or target.get("figure_image_filename")

    # Load processing results (use resolved_element_id for file lookups)
    proc_result = _load_figure_processing_result(figures_dir, resolved_element_id)
    sam3_result = _load_sam3_result(figures_dir, resolved_element_id)
    figure_processing = target.get("figure_processing", {})

    # Build response
    result: Dict[str, Any] = {
        "element_id": element_id,
        "page_number": target.get("page_number") or md.get("page_number"),
        "content": target.get("content") or target.get("text", ""),
        "coordinates": md.get("coordinates", {}),
    }

    # Add image paths and dimensions
    if figure_image:
        original_path = figures_dir.parent / figure_image
        if not original_path.exists():
            original_path = figures_dir / figure_image
        result["original_image_path"] = str(original_path) if original_path.exists() else None

        # Get image dimensions
        if original_path.exists():
            try:
                with Image.open(original_path) as img:
                    result["image_width"], result["image_height"] = img.size
            except Exception:
                result["image_width"], result["image_height"] = None, None
        else:
            result["image_width"], result["image_height"] = None, None

        annotated_path = figures_dir / f"{element_id}.annotated.png"
        result["annotated_image_path"] = str(annotated_path) if annotated_path.exists() else None

    # Add processing results (prefer JSON file over embedded metadata)
    if proc_result:
        result["processing"] = {
            "figure_type": proc_result.get("figure_type"),
            "confidence": proc_result.get("confidence"),
            "processed_content": proc_result.get("processed_content"),
            "description": proc_result.get("description"),
            "raw_ocr_text": proc_result.get("raw_ocr_text"),
            "processing_notes": proc_result.get("processing_notes"),
            "step1_duration_ms": proc_result.get("step1_duration_ms"),
            "step2_duration_ms": proc_result.get("step2_duration_ms"),
            "intermediate_nodes": proc_result.get("intermediate_nodes"),
            "intermediate_edges": proc_result.get("intermediate_edges"),
            "reasoning_trace": proc_result.get("reasoning_trace"),
        }
        # Add formatted understanding for display
        try:
            from chunking_pipeline.figure_processor import get_processor

            processor = get_processor()
            result["formatted_understanding"] = processor.format_understanding(proc_result)
        except (ImportError, Exception) as e:
            logger.warning(f"Could not format figure understanding: {e}")
            result["formatted_understanding"] = None
    elif figure_processing:
        result["processing"] = figure_processing
        # Add formatted understanding for embedded figure_processing
        try:
            from chunking_pipeline.figure_processor import get_processor

            processor = get_processor()
            result["formatted_understanding"] = processor.format_understanding(figure_processing)
        except (ImportError, Exception) as e:
            logger.warning(f"Could not format figure understanding: {e}")
            result["formatted_understanding"] = None
    else:
        result["processing"] = None
        result["formatted_understanding"] = None

    # Add two-stage pipeline status
    stages = {
        "segmented": False,
        "extracted": False,
    }
    sam3_info = None

    if sam3_result:
        stages["segmented"] = True
        stages["extracted"] = sam3_result.get("stage") == "complete"
        sam3_info = {
            "shape_count": len(sam3_result.get("shape_positions") or []),
            "shape_positions": sam3_result.get("shape_positions"),
            "direction": sam3_result.get("direction"),
            "figure_type": sam3_result.get("figure_type"),
            "confidence": sam3_result.get("confidence"),
            "classification_duration_ms": sam3_result.get("classification_duration_ms"),
            "direction_duration_ms": sam3_result.get("direction_duration_ms"),
            "sam3_duration_ms": sam3_result.get("sam3_duration_ms"),
        }
    elif proc_result:
        # Full processing was done (legacy or reprocess)
        stages["segmented"] = True
        stages["extracted"] = True

    result["stages"] = stages
    result["sam3"] = sam3_info

    return result


@router.get("/api/figures/{slug}/{element_id}/image/original")
def api_figure_image_original(
    slug: str,
    element_id: str,
    provider: str = Query(default=None),
) -> Response:
    """Serve the original figure image.

    First tries to find a pre-extracted image file. If not available,
    falls back to extracting the figure region from the PDF using
    bounding box coordinates.
    """
    provider_key = provider or DEFAULT_PROVIDER
    elements_path = _resolve_elements_file(slug, provider_key)
    figures_dir = _get_figures_dir(elements_path)

    # Find figure to get image filename
    figures = _load_figures_from_elements(elements_path)
    target = None
    for fig in figures:
        if fig.get("element_id") == element_id:
            target = fig
            break

    if not target:
        raise HTTPException(status_code=404, detail=f"Figure {element_id} not found")

    md = target.get("metadata", {})
    figure_image = md.get("figure_image_filename") or target.get("figure_image_filename")

    # Try to find pre-extracted image file
    if figure_image:
        candidates = [
            figures_dir.parent / figure_image,
            figures_dir / figure_image,
            elements_path.parent / figure_image,
        ]
        for path in candidates:
            if path.exists():
                return FileResponse(path, media_type=mimetypes.guess_type(path.name)[0] or "image/png")

    # Fallback: extract from PDF using bounding box coordinates
    coordinates = md.get("coordinates", {})
    page_number = target.get("page_number") or md.get("page_number")

    if not coordinates.get("points") or not page_number:
        raise HTTPException(
            status_code=404,
            detail="Figure has no associated image and no coordinates for extraction",
        )

    pdf_path = _resolve_pdf_file(slug, provider_key)
    if not pdf_path:
        raise HTTPException(
            status_code=404,
            detail="Figure has no associated image and PDF not found for extraction",
        )

    png_bytes = _extract_figure_from_pdf(pdf_path, page_number, coordinates)
    if not png_bytes:
        raise HTTPException(
            status_code=500,
            detail="Failed to extract figure from PDF",
        )

    return Response(content=png_bytes, media_type="image/png")


@router.get("/api/figures/{slug}/{element_id}/image/annotated")
def api_figure_image_annotated(
    slug: str,
    element_id: str,
    provider: str = Query(default=None),
) -> FileResponse:
    """Serve the SAM3-annotated figure image."""
    provider_key = provider or DEFAULT_PROVIDER
    elements_path = _resolve_elements_file(slug, provider_key)
    figures_dir = _get_figures_dir(elements_path)

    annotated_path = figures_dir / f"{element_id}.annotated.png"
    if not annotated_path.exists():
        raise HTTPException(status_code=404, detail="Annotated image not available")

    return FileResponse(annotated_path, media_type="image/png")


@router.post("/api/figures/{slug}/{element_id}/reprocess")
def api_figure_reprocess(
    slug: str,
    element_id: str,
    provider: str = Query(default=None),
    force_type: Optional[str] = Query(default=None, description="Force figure type: 'flowchart' or 'other'. If not provided, runs auto-classification."),
) -> Dict[str, Any]:
    """Trigger reprocessing of a figure through the vision pipeline.

    Args:
        slug: The run slug
        element_id: The figure element ID
        provider: Optional provider override
        force_type: Optional forced figure type. When provided, skips classification
            and processes as the specified type ('flowchart' or 'other').
    """
    provider_key = provider or DEFAULT_PROVIDER
    elements_path = _resolve_elements_file(slug, provider_key)
    figures_dir = _get_figures_dir(elements_path)

    # Find the figure
    figures = _load_figures_from_elements(elements_path)
    target = None
    for fig in figures:
        if fig.get("element_id") == element_id:
            target = fig
            break

    if not target:
        raise HTTPException(status_code=404, detail=f"Figure {element_id} not found")

    md = target.get("metadata", {})
    figure_image = md.get("figure_image_filename") or target.get("figure_image_filename")

    if not figure_image:
        raise HTTPException(status_code=400, detail="Figure has no associated image")

    # Find the image
    image_path = None
    for candidate in [figures_dir.parent / figure_image, figures_dir / figure_image]:
        if candidate.exists():
            image_path = candidate
            break

    if not image_path:
        raise HTTPException(status_code=404, detail="Image file not found")

    # Process through FigureProcessor
    try:
        from chunking_pipeline.figure_processor import get_processor

        processor = get_processor()
        ocr_text = target.get("content", "") or target.get("text", "")
        # Extract text positions from image using Azure DI (same as upload flow)
        text_positions = processor.extract_text_positions_from_image(image_path)
        if text_positions:
            logger.info(
                f"Extracted {len(text_positions)} text positions for reprocessing {element_id}"
            )
        result = processor.process_and_save(
            image_path=image_path,
            output_dir=figures_dir,
            element_id=element_id,
            ocr_text=ocr_text,
            run_id=slug,
            text_positions=text_positions if text_positions else None,
            force_type=force_type,
        )
        return {"status": "ok", "result": result, "force_type": force_type}
    except ImportError as e:
        logger.exception(f"Import error during figure reprocessing: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Figure processing import error: {e}",
        )
    except Exception as e:
        logger.exception(f"Failed to reprocess figure {element_id}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/figures/{slug}/{element_id}/segment")
def api_figure_segment(
    slug: str,
    element_id: str,
    provider: str = Query(default=None),
) -> Dict[str, Any]:
    """Run SAM3 segmentation on a figure (stage 1 of two-stage pipeline).

    This performs classification and shape detection without mermaid extraction,
    allowing visual inspection of the segmentation before proceeding.
    """
    provider_key = provider or DEFAULT_PROVIDER
    elements_path = _resolve_elements_file(slug, provider_key)
    figures_dir = _get_figures_dir(elements_path)

    # Find the figure
    figures = _load_figures_from_elements(elements_path)
    target = None
    for fig in figures:
        if fig.get("element_id") == element_id:
            target = fig
            break

    if not target:
        raise HTTPException(status_code=404, detail=f"Figure {element_id} not found")

    md = target.get("metadata", {})
    figure_image = md.get("figure_image_filename") or target.get("figure_image_filename")

    if not figure_image:
        raise HTTPException(status_code=400, detail="Figure has no associated image")

    # Find the image
    image_path = None
    for candidate in [figures_dir.parent / figure_image, figures_dir / figure_image]:
        if candidate.exists():
            image_path = candidate
            break

    if not image_path:
        raise HTTPException(status_code=404, detail="Image file not found")

    # Run segmentation
    try:
        from chunking_pipeline.figure_processor import get_processor

        processor = get_processor()
        ocr_text = target.get("content", "") or target.get("text", "")

        # Extract text positions from figure image using Azure DI (same as upload flow)
        # This replaces the overlapping-element approach which had wrong coordinate format
        text_positions = processor.extract_text_positions_from_image(image_path)
        if text_positions:
            logger.info(
                f"Extracted {len(text_positions)} text positions from figure image {element_id}"
            )

        result = processor.segment_and_save(
            image_path=image_path,
            output_dir=figures_dir,
            element_id=element_id,
            ocr_text=ocr_text,
            run_id=slug,
            text_positions=text_positions if text_positions else None,
        )
        return {
            "status": "ok",
            "stage": "segmented",
            "figure_type": result.get("figure_type"),
            "confidence": result.get("confidence"),
            "direction": result.get("direction"),
            "shape_count": len(result.get("shape_positions") or []),
            "classification_duration_ms": result.get("classification_duration_ms"),
            "sam3_duration_ms": result.get("sam3_duration_ms"),
        }
    except ImportError as e:
        logger.exception(f"Import error during segmentation: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Figure processing import error: {e}",
        )
    except Exception as e:
        logger.exception(f"Failed to segment figure {element_id}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/figures/{slug}/{element_id}/extract-mermaid")
def api_figure_extract_mermaid(
    slug: str,
    element_id: str,
    provider: str = Query(default=None),
) -> Dict[str, Any]:
    """Run mermaid extraction using pre-computed SAM3 results (stage 2).

    Prerequisite: /segment must have been called first.
    """
    provider_key = provider or DEFAULT_PROVIDER
    elements_path = _resolve_elements_file(slug, provider_key)
    figures_dir = _get_figures_dir(elements_path)

    # Check SAM3 results exist
    sam3_result = _load_sam3_result(figures_dir, element_id)
    if not sam3_result:
        raise HTTPException(
            status_code=400,
            detail="SAM3 segmentation not found. Run /segment first.",
        )

    # Find the figure
    figures = _load_figures_from_elements(elements_path)
    target = None
    for fig in figures:
        if fig.get("element_id") == element_id:
            target = fig
            break

    if not target:
        raise HTTPException(status_code=404, detail=f"Figure {element_id} not found")

    md = target.get("metadata", {})
    figure_image = md.get("figure_image_filename") or target.get("figure_image_filename")

    if not figure_image:
        raise HTTPException(status_code=400, detail="Figure has no associated image")

    # Find the image
    image_path = None
    for candidate in [figures_dir.parent / figure_image, figures_dir / figure_image]:
        if candidate.exists():
            image_path = candidate
            break

    if not image_path:
        raise HTTPException(status_code=404, detail="Image file not found")

    # Run mermaid extraction
    try:
        from chunking_pipeline.figure_processor import get_processor

        processor = get_processor()
        ocr_text = target.get("content", "") or target.get("text", "")

        # Try to get text_positions from SAM3 result (from prior segment call)
        text_positions = sam3_result.get("text_positions")
        if text_positions:
            logger.info(
                f"Using {len(text_positions)} text positions from SAM3 result for {element_id}"
            )
        else:
            # Fall back to Azure DI extraction (same as upload flow)
            text_positions = processor.extract_text_positions_from_image(image_path)
            if text_positions:
                logger.info(
                    f"Extracted {len(text_positions)} text positions from figure image {element_id}"
                )

        result = processor.extract_mermaid_and_save(
            image_path=image_path,
            output_dir=figures_dir,
            element_id=element_id,
            ocr_text=ocr_text,
            run_id=slug,
            text_positions=text_positions if text_positions else None,
        )
        return {
            "status": "ok",
            "stage": "complete",
            "figure_type": result.get("figure_type"),
            "processed_content": result.get("processed_content"),
            "description": result.get("description"),
            "intermediate_nodes": result.get("intermediate_nodes"),
            "intermediate_edges": result.get("intermediate_edges"),
            "step1_duration_ms": result.get("step1_duration_ms"),
            "step2_duration_ms": result.get("step2_duration_ms"),
        }
    except ImportError as e:
        logger.exception(f"Import error during mermaid extraction: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Figure processing import error: {e}",
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"Failed to extract mermaid for figure {element_id}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/figures/{slug}/{element_id}/sam3")
def api_figure_sam3(
    slug: str,
    element_id: str,
    provider: str = Query(default=None),
) -> Dict[str, Any]:
    """Get SAM3 segmentation results for a figure."""
    provider_key = provider or DEFAULT_PROVIDER
    elements_path = _resolve_elements_file(slug, provider_key)
    figures_dir = _get_figures_dir(elements_path)

    sam3_result = _load_sam3_result(figures_dir, element_id)
    if not sam3_result:
        raise HTTPException(status_code=404, detail="SAM3 results not found")

    return sam3_result
