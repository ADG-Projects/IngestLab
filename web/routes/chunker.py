"""API routes for custom chunker operations."""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request

from chunking_pipeline.custom_chunker import (
    ChunkingConfig,
    chunk_elements,
    get_chunk_summary,
)

from ..config import DEFAULT_PROVIDER, PROVIDERS, get_out_dir
from ..run_jobs import RUN_JOB_MANAGER

logger = logging.getLogger("chunking.routes.chunker")
router = APIRouter()


def _resolve_elements_file(slug: str, provider: str) -> Path:
    """Find the elements JSONL file for a given slug and provider."""
    out_dir = get_out_dir(provider)

    # Try exact match first
    path = out_dir / f"{slug}.elements.jsonl"
    if path.exists():
        return path

    # Try with pages suffix pattern
    base, sep, rest = slug.partition(".pages")
    if sep:
        candidate = out_dir / f"{base}.pages{rest}.elements.jsonl"
        if candidate.exists():
            return candidate

    raise HTTPException(status_code=404, detail=f"Elements file not found for {slug}")


def _load_elements(path: Path) -> List[Dict[str, Any]]:
    """Load elements from a JSONL file."""
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


def _save_chunks(chunks: List[Dict[str, Any]], path: Path) -> None:
    """Save chunks to a JSONL file."""
    with path.open("w", encoding="utf-8") as f:
        for chunk in chunks:
            f.write(json.dumps(chunk, ensure_ascii=False) + "\n")


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

    # Find and load source elements
    try:
        elements_path = _resolve_elements_file(source_slug, source_provider)
    except HTTPException:
        raise HTTPException(
            status_code=404,
            detail=f"Source elements not found for {source_slug} ({source_provider})",
        )

    logger.info(f"Loading elements from {elements_path}")
    elements = _load_elements(elements_path)

    if not elements:
        raise HTTPException(
            status_code=400,
            detail="Source file contains no elements",
        )

    logger.info(f"Loaded {len(elements)} elements, running chunker")

    # Run chunker
    chunks = chunk_elements(elements, config)
    summary = get_chunk_summary(chunks)

    logger.info(
        f"Generated {summary['count']} chunks "
        f"(avg {summary['avg_chars']} chars)"
    )

    # Save chunks to output file
    # Output goes to same directory as source elements, with .chunks.jsonl suffix
    out_dir = get_out_dir(source_provider)
    output_stem = elements_path.stem.replace(".elements", "")
    output_path = out_dir / f"{output_stem}.chunks.jsonl"

    logger.info(f"Saving chunks to {output_path}")
    _save_chunks(chunks, output_path)

    return {
        "success": True,
        "chunks_file": str(output_path),
        "source_elements": len(elements),
        "summary": summary,
    }
