"""CLI entry point for the custom chunker.

Usage:
    uv run python -m chunking_pipeline.run_custom_chunker \
        --input existing.chunks.jsonl \
        --output chunked.chunks.jsonl
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from chunking_pipeline.custom_chunker import (
    ChunkingConfig,
    chunk_elements,
    get_chunk_summary,
)

logger = logging.getLogger(__name__)


def load_elements(path: Path) -> List[Dict[str, Any]]:
    """Load elements from a JSONL file."""
    elements = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                elements.append(json.loads(line))
    return elements


def save_chunks(chunks: List[Dict[str, Any]], path: Path) -> None:
    """Save chunks to a JSONL file."""
    with path.open("w", encoding="utf-8") as f:
        for chunk in chunks:
            f.write(json.dumps(chunk, ensure_ascii=False) + "\n")


def main(argv: Optional[List[str]] = None) -> int:
    """Main entry point for the custom chunker CLI."""
    parser = argparse.ArgumentParser(
        description="Run custom chunker on element files",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    # Input/output
    parser.add_argument(
        "--input",
        type=Path,
        required=True,
        help="Path to input elements JSONL file",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Path to output chunks JSONL file",
    )

    # Chunking configuration
    parser.add_argument(
        "--no-include-orig-elements",
        action="store_true",
        help="Do not include original elements in chunk metadata",
    )

    args = parser.parse_args(argv)

    # Validate input file
    if not args.input.exists():
        logger.error(f"Input file not found: {args.input}")
        return 1

    # Build configuration
    config = ChunkingConfig(include_orig_elements=not args.no_include_orig_elements)

    logger.info(f"Loading elements from {args.input}")
    elements = load_elements(args.input)
    logger.info(f"Loaded {len(elements)} elements")

    logger.info("Running chunker...")
    chunks = chunk_elements(elements, config)

    summary = get_chunk_summary(chunks)
    logger.info(
        f"Generated {summary['count']} chunks "
        f"(avg {summary['avg_chars']} chars, "
        f"min {summary['min_chars']}, max {summary['max_chars']})"
    )

    # Ensure output directory exists
    args.output.parent.mkdir(parents=True, exist_ok=True)

    logger.info(f"Saving chunks to {args.output}")
    save_chunks(chunks, args.output)

    logger.info("Chunking complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
