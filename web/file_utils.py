from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from .config import DEFAULT_PROVIDER, get_out_dir, latest_by_mtime


def resolve_slug_file(slug: str, pattern: str, provider: str = DEFAULT_PROVIDER) -> Path:
    out_dir = get_out_dir(provider)
    pat = pattern.format(slug=slug)
    if ".pages*" in pat and ".pages" in slug:
        pat = pat.replace(".pages*", "")
    candidates = sorted(out_dir.glob(pat))
    path = latest_by_mtime(candidates)
    if not path:
        raise HTTPException(status_code=404, detail=f"No file found for {slug} with pattern {pattern} (provider={provider})")
    return path
