"""Custom chunker for combining elements into chunks.

This module provides a configurable chunker that can combine elements from any provider
(Azure DI, Unstructured, etc.) into chunks according to customizable rules.
"""

from __future__ import annotations

import base64
import json
import zlib
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from chunking_pipeline.chunker import ensure_stable_element_id, merge_coordinates


@dataclass
class ChunkingConfig:
    """Configuration for the custom chunker."""

    max_characters: int = 1000
    soft_max_characters: int = 800
    overlap_characters: int = 0
    respect_page_boundaries: bool = True
    include_orig_elements: bool = True
    standalone_types: List[str] = field(
        default_factory=lambda: ["Table", "Figure"]
    )
    heading_types: List[str] = field(
        default_factory=lambda: ["title", "sectionHeading", "pageHeader"]
    )


def encode_orig_elements(elements: List[Dict[str, Any]]) -> str:
    """Encode a list of elements as a compressed base64 string.

    This format is compatible with the UI's decode_orig_elements().
    """
    raw = json.dumps(elements, ensure_ascii=False).encode("utf-8")
    compressed = zlib.compress(raw)
    return base64.b64encode(compressed).decode("ascii")


def chunk_elements(
    elements: List[Dict[str, Any]],
    config: Optional[ChunkingConfig] = None,
) -> List[Dict[str, Any]]:
    """Combine elements into chunks according to the provided configuration.

    This is currently a placeholder implementation that returns elements unchanged.
    Actual chunking rules will be implemented later.

    Args:
        elements: List of elements from any provider (Azure DI, Unstructured, etc.)
        config: Chunking configuration. If None, uses defaults.

    Returns:
        List of chunks. Each chunk has the same structure as elements but may
        include an 'orig_elements' field in metadata containing the source elements.
    """
    if config is None:
        config = ChunkingConfig()

    # Placeholder implementation: return elements as-is
    # TODO: Implement actual chunking logic:
    # - Combine sequential text elements until size limit
    # - Keep tables/figures as standalone chunks
    # - Break before headings to create semantic sections
    # - Handle page boundaries
    # - Add overlap between chunks

    chunks: List[Dict[str, Any]] = []
    for element in elements:
        # Create a copy to avoid modifying the original
        chunk = {
            "type": element.get("type") or "Unknown",
            "text": element.get("text") or "",
            "metadata": dict(element.get("metadata") or {}),
        }

        # If include_orig_elements is True, encode the source element
        if config.include_orig_elements:
            chunk["metadata"]["orig_elements"] = encode_orig_elements([element])

        # Merge coordinates (single element, so just copy)
        merged_coords = merge_coordinates([element])
        if merged_coords:
            chunk["metadata"]["coordinates"] = merged_coords

        # Ensure stable element ID
        ensure_stable_element_id(chunk)

        chunks.append(chunk)

    return chunks


def get_chunk_summary(chunks: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Generate summary statistics for a list of chunks."""
    if not chunks:
        return {
            "count": 0,
            "total_chars": 0,
            "min_chars": 0,
            "max_chars": 0,
            "avg_chars": 0,
        }

    char_counts = [len(c.get("text") or "") for c in chunks]
    return {
        "count": len(chunks),
        "total_chars": sum(char_counts),
        "min_chars": min(char_counts),
        "max_chars": max(char_counts),
        "avg_chars": sum(char_counts) // len(char_counts) if char_counts else 0,
    }
