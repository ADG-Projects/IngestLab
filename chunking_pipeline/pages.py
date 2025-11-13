from __future__ import annotations

import os
import tempfile
from typing import List, Optional


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


def slice_pdf(input_pdf: str, pages: List[int], output_pdf: Optional[str] = None) -> str:
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(input_pdf)
    writer = PdfWriter()

    max_page = len(reader.pages)
    for p in sorted(set(pages)):
        if p < 1 or p > max_page:
            continue
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
