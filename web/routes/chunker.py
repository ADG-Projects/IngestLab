"""API routes for custom chunker operations."""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request

from src.extractors.custom_chunker import (
    ChunkingConfig,
    chunk_elements,
    decode_orig_elements,
    get_chunk_statistics,
)
from src.models.elements import Element

from ..config import DEFAULT_PROVIDER, PROVIDERS, get_out_dir
from ..run_jobs import RUN_JOB_MANAGER

logger = logging.getLogger("chunking.routes.chunker")
router = APIRouter()


def _resolve_elements_or_chunks_file(slug: str, provider: str) -> Tuple[Path, bool]:
    """Find elements or chunks JSONL file for a given slug and provider.

    Returns (path, is_elements) where is_elements indicates file type.
    """
    out_dir = get_out_dir(provider)

    # Try elements file first (v5.0+)
    path = out_dir / f"{slug}.elements.jsonl"
    if path.exists():
        return path, True

    # Try with pages suffix pattern for elements
    base, sep, rest = slug.partition(".pages")
    if sep:
        candidate = out_dir / f"{base}.pages{rest}.elements.jsonl"
        if candidate.exists():
            return candidate, True

    # Fall back to chunks file (legacy pre-v5.0)
    path = out_dir / f"{slug}.chunks.jsonl"
    if path.exists():
        return path, False

    if sep:
        candidate = out_dir / f"{base}.pages{rest}.chunks.jsonl"
        if candidate.exists():
            return candidate, False

    raise HTTPException(status_code=404, detail=f"No elements or chunks file found for {slug}")


def _load_elements_from_elements_file(path: Path) -> List[Dict[str, Any]]:
    """Load elements from a v5.0+ elements JSONL file."""
    elements = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    elements.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return elements


def _load_elements_from_chunks_file(path: Path) -> List[Dict[str, Any]]:
    """Extract elements from a legacy chunks JSONL file.

    Handles two formats:
    1. Chunks with embedded orig_elements (Unstructured chunker output)
    2. Direct element-style chunks (Azure DI legacy output)
    """
    elements = []
    seen_ids: set = set()

    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                chunk = json.loads(line)
            except json.JSONDecodeError:
                continue

            meta = chunk.get("metadata") or {}

            # Try to decode orig_elements first (Unstructured chunker format)
            try:
                orig_elements = decode_orig_elements(meta)
            except Exception:
                orig_elements = []

            if orig_elements:
                # Extract embedded original elements
                for el in orig_elements:
                    element_id = el.get("element_id")
                    if element_id and element_id not in seen_ids:
                        seen_ids.add(element_id)
                        elements.append(el)
            else:
                # Treat chunk as a direct element (Azure DI legacy format)
                element_id = chunk.get("element_id")
                if element_id and element_id not in seen_ids:
                    seen_ids.add(element_id)
                    elements.append(chunk)

    return elements


def _save_chunks(chunks: List[Any], path: Path) -> None:
    """Save chunks to a JSONL file."""
    with path.open("w", encoding="utf-8") as f:
        for chunk in chunks:
            # Convert Pydantic models to dicts if needed
            data = chunk.model_dump() if hasattr(chunk, "model_dump") else chunk
            f.write(json.dumps(data, ensure_ascii=False) + "\n")


@router.post("/api/chunk")
async def api_chunk(request: Request) -> Dict[str, Any]:
    """Run custom chunker on an existing run's elements.

    Request body:
    {
        "source_slug": "...",       # Slug of the source run
        "source_provider": "...",   # Provider of the source run
        "config": {                 # Optional chunking configuration
            "include_orig_elements": true
        }                           # Other sizing knobs are ignored by the custom chunker
    }

    Returns:
    {
        "success": true,
        "chunks_file": "...",
        "summary": {
            "count": ...,
            "total_chars": ...,
            ...
        }
    }
    """
    try:
        payload = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {e}") from e

    source_slug = payload.get("source_slug")
    if not source_slug:
        raise HTTPException(status_code=400, detail="source_slug is required")

    source_provider = payload.get("source_provider") or DEFAULT_PROVIDER
    if source_provider not in PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown provider: {source_provider}",
        )

    # Build chunking config from payload
    config_dict = payload.get("config") or {}
    config_kwargs: Dict[str, Any] = {}
    if "include_orig_elements" in config_dict:
        config_kwargs["include_orig_elements"] = bool(
            config_dict.get("include_orig_elements")
        )
    config = ChunkingConfig(**config_kwargs)

    # Find and load source elements (supports both v5.0+ and legacy formats)
    try:
        source_path, is_elements = _resolve_elements_or_chunks_file(source_slug, source_provider)
    except HTTPException:
        raise HTTPException(
            status_code=404,
            detail=f"Source elements not found for {source_slug} ({source_provider})",
        )

    logger.info(f"Loading elements from {source_path} (is_elements={is_elements})")
    if is_elements:
        elements = _load_elements_from_elements_file(source_path)
    else:
        elements = _load_elements_from_chunks_file(source_path)

    if not elements:
        raise HTTPException(
            status_code=400,
            detail="Source file contains no elements",
        )

    logger.info(f"Loaded {len(elements)} elements, running chunker")

    # Convert dicts to Element models (chunk_elements expects Pydantic models)
    element_models = [Element.model_validate(el) for el in elements]

    # Run chunker
    chunks = chunk_elements(element_models, config)
    stats = get_chunk_statistics(chunks)
    summary = stats.model_dump()

    logger.info(
        f"Generated {summary['count']} chunks "
        f"(avg {summary['avg_chars']} chars)"
    )

    # Save chunks to output file
    # Output goes to same directory as source file, with .chunks.jsonl suffix
    out_dir = get_out_dir(source_provider)
    # Strip both .elements and .chunks suffixes from stem for output naming
    output_stem = source_path.stem.replace(".elements", "").replace(".chunks", "")
    output_path = out_dir / f"{output_stem}.chunks.jsonl"

    logger.info(f"Saving chunks to {output_path}")
    _save_chunks(chunks, output_path)

    return {
        "success": True,
        "chunks_file": str(output_path),
        "source_elements": len(elements),
        "summary": summary,
    }
