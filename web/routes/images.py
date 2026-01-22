"""Images/Figures routes for ChunkingTests.

Provides API endpoints for inspecting figures extracted from PDF runs
and uploading standalone images for processing through the vision pipeline.

EXPERIMENTAL: Depends on PolicyAsCode feature branch for full functionality.
"""

from __future__ import annotations

import base64
import json
import logging
import mimetypes
import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse

from ..config import DEFAULT_PROVIDER, get_out_dir
from ..file_utils import resolve_slug_file

router = APIRouter()
logger = logging.getLogger("chunking.routes.images")


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
            if el.get("type") == "figure":
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
                (proc_result or {}).get("processed_content")
                or figure_processing.get("processed_content")
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

    # Find the figure element
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

    # Load processing result
    proc_result = _load_figure_processing_result(figures_dir, element_id)
    figure_processing = target.get("figure_processing", {})

    # Build response
    result: Dict[str, Any] = {
        "element_id": element_id,
        "page_number": target.get("page_number") or md.get("page_number"),
        "content": target.get("content") or target.get("text", ""),
        "coordinates": md.get("coordinates", {}),
    }

    # Add image paths
    if figure_image:
        original_path = figures_dir.parent / figure_image
        if not original_path.exists():
            original_path = figures_dir / figure_image
        result["original_image_path"] = str(original_path) if original_path.exists() else None

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
        }
    elif figure_processing:
        result["processing"] = figure_processing
    else:
        result["processing"] = None

    return result


@router.get("/api/figures/{slug}/{element_id}/image/original")
def api_figure_image_original(
    slug: str,
    element_id: str,
    provider: str = Query(default=None),
) -> FileResponse:
    """Serve the original figure image."""
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

    if not figure_image:
        raise HTTPException(status_code=404, detail="Figure has no associated image")

    # Try multiple locations
    candidates = [
        figures_dir.parent / figure_image,
        figures_dir / figure_image,
        elements_path.parent / figure_image,
    ]

    for path in candidates:
        if path.exists():
            return FileResponse(path, media_type=mimetypes.guess_type(path.name)[0] or "image/png")

    raise HTTPException(status_code=404, detail=f"Image file not found: {figure_image}")


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


@router.get("/api/figures/{slug}/{element_id}/viewer", response_class=HTMLResponse)
def api_figure_viewer(
    slug: str,
    element_id: str,
    provider: str = Query(default=None),
) -> str:
    """Return an interactive HTML viewer for the figure."""
    provider_key = provider or DEFAULT_PROVIDER
    elements_path = _resolve_elements_file(slug, provider_key)
    figures_dir = _get_figures_dir(elements_path)

    # Load processing result
    proc_result = _load_figure_processing_result(figures_dir, element_id)

    # Build Mermaid content if available
    mermaid_code = ""
    figure_type = "unknown"
    if proc_result:
        figure_type = proc_result.get("figure_type", "unknown")
        mermaid_code = proc_result.get("processed_content", "")

    # Generate simple HTML viewer
    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Figure Viewer - {element_id}</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
    <style>
        body {{ font-family: system-ui, sans-serif; margin: 20px; background: #f5f5f5; }}
        .container {{ max-width: 1200px; margin: 0 auto; }}
        h1 {{ font-size: 1.5rem; color: #333; }}
        .badge {{ display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; }}
        .badge-flowchart {{ background: #4CAF50; color: white; }}
        .badge-other {{ background: #9E9E9E; color: white; }}
        .panel {{ background: white; border-radius: 8px; padding: 20px; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }}
        .mermaid {{ text-align: center; }}
        pre {{ background: #f0f0f0; padding: 15px; border-radius: 4px; overflow-x: auto; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>Figure: {element_id}</h1>
        <span class="badge badge-{figure_type}">{figure_type}</span>

        <div class="panel">
            <h2>Original Image</h2>
            <img src="/api/figures/{slug}/{element_id}/image/original?provider={provider_key}"
                 style="max-width: 100%; height: auto;" alt="Original figure">
        </div>
"""

    if mermaid_code and figure_type == "flowchart":
        escaped_code = mermaid_code.replace("`", "\\`")
        html += f"""
        <div class="panel">
            <h2>Generated Diagram</h2>
            <div class="mermaid">
{mermaid_code}
            </div>
        </div>

        <div class="panel">
            <h2>Mermaid Code</h2>
            <pre>{mermaid_code}</pre>
        </div>
"""

    html += """
    </div>
    <script>
        mermaid.initialize({ startOnLoad: true, theme: 'default' });
    </script>
</body>
</html>"""

    return html


@router.post("/api/figures/{slug}/{element_id}/reprocess")
def api_figure_reprocess(
    slug: str,
    element_id: str,
    provider: str = Query(default=None),
) -> Dict[str, Any]:
    """Trigger reprocessing of a figure through the vision pipeline."""
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
        result = processor.process_and_save(
            image_path=image_path,
            output_dir=figures_dir,
            element_id=element_id,
            ocr_text=ocr_text,
            run_id=slug,
        )
        return {"status": "ok", "result": result}
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="Figure processing not available - PolicyAsCode feature branch required",
        )
    except Exception as e:
        logger.exception(f"Failed to reprocess figure {element_id}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/figures/upload")
async def api_figure_upload(
    file: UploadFile = File(...),
) -> Dict[str, Any]:
    """Upload and process a standalone image through the vision pipeline."""
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

    # Save to temp file
    suffix = Path(file.filename).suffix or ".png"
    upload_id = str(uuid.uuid4())[:8]

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = Path(tmp.name)

    try:
        from chunking_pipeline.figure_processor import get_processor

        processor = get_processor()
        result = processor.process_figure(tmp_path, ocr_text="", run_id=f"upload-{upload_id}")

        # Include base64 of original image for display
        b64 = base64.b64encode(content).decode("ascii")
        data_uri = f"data:{content_type};base64,{b64}"

        return {
            "status": "ok",
            "upload_id": upload_id,
            "filename": file.filename,
            "original_image_data_uri": data_uri,
            "result": result,
        }
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="Figure processing not available - PolicyAsCode feature branch required",
        )
    except Exception as e:
        logger.exception(f"Failed to process uploaded image {file.filename}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Cleanup temp file
        try:
            tmp_path.unlink()
        except OSError:
            pass
