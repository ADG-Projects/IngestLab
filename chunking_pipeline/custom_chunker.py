"""Custom chunker for combining elements into chunks.

This module provides a configurable chunker that can combine elements from any provider
(Azure DI, Unstructured, etc.) into chunks according to customizable rules.

The chunker implements section-based grouping:
- Everything between section headings goes into one chunk
- Tables and Figures are never split (they become standalone chunks)
- Noise elements (pageHeader, pageFooter, pageNumber) are filtered out
- Section headings are included at the start of the chunk they introduce
"""

from __future__ import annotations

import base64
import json
import zlib
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from chunking_pipeline.chunker import ensure_stable_element_id, merge_coordinates


@dataclass
class ChunkingConfig:
    """Configuration for the custom chunker."""

    include_orig_elements: bool = True
    noise_types: List[str] = field(
        default_factory=lambda: ["pageHeader", "pageFooter", "pageNumber"]
    )
    section_break_types: List[str] = field(
        default_factory=lambda: ["title", "sectionHeading"]
    )
    standalone_types: List[str] = field(
        default_factory=lambda: ["Table", "Figure"]
    )


def encode_orig_elements(elements: List[Dict[str, Any]]) -> str:
    """Encode a list of elements as a compressed base64 string.

    This format is compatible with the UI's decode_orig_elements().
    """
    raw = json.dumps(elements, ensure_ascii=False).encode("utf-8")
    compressed = zlib.compress(raw)
    return base64.b64encode(compressed).decode("ascii")


def _get_element_type(element: Dict[str, Any]) -> str:
    """Get the effective type of an element.

    Checks both the top-level 'type' field and 'metadata.role' field,
    since Azure DI uses 'role' for semantic classification.
    """
    el_type = element.get("type") or ""
    meta = element.get("metadata") or {}
    role = meta.get("role") or ""
    # Prefer role if it's more specific (e.g., "sectionHeading" vs "Paragraph")
    return role if role else el_type


def _filter_noise(
    elements: List[Dict[str, Any]], noise_types: List[str]
) -> List[Dict[str, Any]]:
    """Remove noise elements like page headers, footers, and page numbers."""
    result = []
    for el in elements:
        el_type = _get_element_type(el)
        if el_type not in noise_types:
            result.append(el)
    return result


def _classify_element(element: Dict[str, Any], config: ChunkingConfig) -> str:
    """Classify an element as 'section_break', 'standalone', or 'content'.

    Returns:
        'section_break' for title/sectionHeading elements
        'standalone' for Table/Figure elements
        'content' for everything else
    """
    el_type = _get_element_type(element)
    top_type = element.get("type") or ""

    # Check standalone types (Table, Figure) - check both type and role
    if el_type in config.standalone_types or top_type in config.standalone_types:
        return "standalone"

    # Check section break types (title, sectionHeading)
    if el_type in config.section_break_types:
        return "section_break"

    return "content"


def _group_elements_by_page(
    elements: List[Dict[str, Any]],
) -> Dict[int, List[Dict[str, Any]]]:
    """Group elements by their page number."""
    pages: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for el in elements:
        meta = el.get("metadata") or {}
        page = meta.get("page_number") or 1
        pages[page].append(el)
    return dict(pages)


def _compute_page_bboxes(
    elements: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Compute bounding boxes for each page in a set of elements.

    Returns a list of dicts with 'page_number' and 'coordinates' keys,
    sorted by page number.
    """
    pages = _group_elements_by_page(elements)
    result = []
    for page_num in sorted(pages.keys()):
        page_elements = pages[page_num]
        coords = merge_coordinates(page_elements)
        if coords:
            result.append({"page_number": page_num, "coordinates": coords})
    return result


def _combine_text(elements: List[Dict[str, Any]]) -> str:
    """Combine text from multiple elements with newlines."""
    texts = []
    for el in elements:
        text = el.get("text") or ""
        if text.strip():
            texts.append(text)
    return "\n\n".join(texts)


def _get_table_html(elements: List[Dict[str, Any]]) -> Optional[str]:
    """Extract text_as_html from the first Table element if present."""
    for el in elements:
        meta = el.get("metadata") or {}
        html = meta.get("text_as_html")
        if html:
            return html
    return None


def _determine_chunk_type(
    elements: List[Dict[str, Any]], config: ChunkingConfig, is_preamble: bool
) -> str:
    """Determine the chunk type based on its elements.

    Returns:
        'preamble' - content before first section heading
        'standalone' - single Table or Figure
        'section' - section with heading and content
    """
    if is_preamble:
        return "preamble"

    if len(elements) == 1:
        classification = _classify_element(elements[0], config)
        if classification == "standalone":
            return "standalone"

    return "section"


def _create_chunk(
    elements: List[Dict[str, Any]],
    config: ChunkingConfig,
    is_preamble: bool = False,
) -> Dict[str, Any]:
    """Create a chunk from a list of elements.

    Handles multi-page elements by storing per-page bboxes.
    """
    if not elements:
        raise ValueError("Cannot create chunk from empty element list")

    # Determine chunk type
    chunk_type = _determine_chunk_type(elements, config, is_preamble)

    # For standalone elements, use their original type; otherwise CompositeElement
    if chunk_type == "standalone":
        el_type = elements[0].get("type") or "Unknown"
    else:
        el_type = "CompositeElement"

    # Combine text
    text = _combine_text(elements)

    # Compute per-page bboxes
    page_bboxes = _compute_page_bboxes(elements)

    # Get first page info for backwards compatibility
    first_page = page_bboxes[0] if page_bboxes else None
    first_page_num = first_page["page_number"] if first_page else 1
    first_coords = first_page["coordinates"] if first_page else None

    # Build metadata
    metadata: Dict[str, Any] = {
        "page_number": first_page_num,
        "chunk_type": chunk_type,
    }

    if first_coords:
        metadata["coordinates"] = first_coords

    # Store all page bboxes if multi-page
    if len(page_bboxes) > 1:
        metadata["page_bboxes"] = page_bboxes

    # Preserve table HTML
    table_html = _get_table_html(elements)
    if table_html:
        metadata["text_as_html"] = table_html

    # Encode original elements
    if config.include_orig_elements:
        metadata["orig_elements"] = encode_orig_elements(elements)

    # Build chunk
    chunk: Dict[str, Any] = {
        "type": el_type,
        "text": text,
        "metadata": metadata,
    }

    # Generate stable ID
    ensure_stable_element_id(chunk)

    return chunk


def chunk_elements(
    elements: List[Dict[str, Any]],
    config: Optional[ChunkingConfig] = None,
) -> List[Dict[str, Any]]:
    """Combine elements into chunks using section-based grouping.

    Groups elements between section headings into single chunks. Tables and
    Figures become standalone chunks. Noise elements are filtered out.

    Args:
        elements: List of elements from any provider (Azure DI, Unstructured, etc.)
        config: Chunking configuration. If None, uses defaults.

    Returns:
        List of chunks with combined text and per-page bounding boxes.
    """
    if config is None:
        config = ChunkingConfig()

    # Filter noise elements
    filtered = _filter_noise(elements, config.noise_types)

    if not filtered:
        return []

    chunks: List[Dict[str, Any]] = []
    current_section: List[Dict[str, Any]] = []
    seen_section_break = False

    for element in filtered:
        classification = _classify_element(element, config)

        if classification == "standalone":
            # Flush current section first
            if current_section:
                chunks.append(
                    _create_chunk(
                        current_section, config, is_preamble=not seen_section_break
                    )
                )
                current_section = []
            # Add standalone as its own chunk
            chunks.append(_create_chunk([element], config))

        elif classification == "section_break":
            # Flush current section
            if current_section:
                chunks.append(
                    _create_chunk(
                        current_section, config, is_preamble=not seen_section_break
                    )
                )
                current_section = []
            # Start new section WITH the heading
            current_section = [element]
            seen_section_break = True

        else:  # content
            current_section.append(element)

    # Flush final section
    if current_section:
        chunks.append(
            _create_chunk(current_section, config, is_preamble=not seen_section_break)
        )

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
