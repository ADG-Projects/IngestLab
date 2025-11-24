from __future__ import annotations

import os
import sys
import tempfile
from typing import List, Optional, Tuple


def _partition_pages(pages: List[int], max_page: int) -> Tuple[List[int], List[int]]:
    unique_pages = sorted(set(pages))
    valid = [p for p in unique_pages if 1 <= p <= max_page]
    dropped = [p for p in unique_pages if p < 1 or p > max_page]
    return valid, dropped


def resolve_pages_in_document(input_pdf: str, pages: List[int]) -> Tuple[List[int], List[int], int]:
    from pypdf import PdfReader

    reader = PdfReader(input_pdf)
    max_page = len(reader.pages)
    valid, dropped = _partition_pages(pages, max_page)
    return valid, dropped, max_page


def parse_pages(pages_arg: str) -> List[int]:
    pages: List[int] = []
    for part in pages_arg.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start_s, end_s = part.split("-", 1)
            start, end = int(start_s), int(end_s)
            pages.extend(range(start, end + 1))
        else:
            pages.append(int(part))
    return sorted(set(pages))


def slice_pdf(input_pdf: str, pages: List[int], output_pdf: Optional[str] = None, warn_on_drop: bool = True) -> str:
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(input_pdf)
    writer = PdfWriter()

    max_page = len(reader.pages)
    valid_pages, dropped = _partition_pages(pages, max_page)
    if not valid_pages:
        raise ValueError(f"No valid pages found in {input_pdf}; document has {max_page} pages.")
    if warn_on_drop and dropped:
        sys.stderr.write(f"Warning: dropping out-of-range pages {dropped}; document has {max_page} pages.\n")
    for p in valid_pages:
        writer.add_page(reader.pages[p - 1])

    if output_pdf is None:
        fd, tmp_path = tempfile.mkstemp(prefix="trimmed_", suffix=".pdf")
        os.close(fd)
        output_pdf = tmp_path
    else:
        parent = os.path.dirname(output_pdf)
        if parent:
            os.makedirs(parent, exist_ok=True)

    with open(output_pdf, "wb") as f:
        writer.write(f)

    return output_pdf
