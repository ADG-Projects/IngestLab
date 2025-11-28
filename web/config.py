from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Iterable, Optional
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
DATASET_DIR = ROOT / "dataset"

_DATA_DIR = os.environ.get("DATA_DIR")
_OUT_DIR_ENV = os.environ.get("OUTPUT_DIR") or os.environ.get("OUT_DIR")
if _OUT_DIR_ENV:
    OUT_DIR = Path(_OUT_DIR_ENV)
elif _DATA_DIR:
    OUT_DIR = Path(_DATA_DIR) / "outputs" / "unstructured"
else:
    OUT_DIR = ROOT / "outputs" / "unstructured"
REVIEWS_DIR = OUT_DIR / "reviews"

AZURE_OUT_DIR = (
    Path(os.environ.get("AZURE_OUTPUT_DIR"))
    if os.environ.get("AZURE_OUTPUT_DIR")
    else (Path(_DATA_DIR) / "outputs" / "azure" if _DATA_DIR else ROOT / "outputs" / "azure")
)

_PDF_DIR_ENV = os.environ.get("PDF_DIR")
if _PDF_DIR_ENV:
    RES_DIR = Path(_PDF_DIR_ENV)
elif _DATA_DIR:
    RES_DIR = Path(_DATA_DIR) / "pdfs"
else:
    RES_DIR = ROOT / "res"

STATIC_DIR = ROOT / "web" / "static"
VENDOR_DIR = STATIC_DIR / "vendor" / "pdfjs"
DOMPURIFY_VENDOR_DIR = STATIC_DIR / "vendor" / "dompurify"
MARKED_VENDOR_DIR = STATIC_DIR / "vendor" / "marked"
PDFJS_VERSION = "3.11.174"
DOMPURIFY_VERSION = "3.1.6"
MARKED_VERSION = "12.0.2"
CHART_VENDOR_DIR = STATIC_DIR / "vendor" / "chartjs"
CHARTJS_VERSION = "4.4.1"

PROVIDERS = {
    "unstructured/local": {
        "id": "unstructured/local",
        "label": "Unstructured (Local)",
        "out_dir": OUT_DIR,
    },
    "unstructured/partition": {
        "id": "unstructured/partition",
        "label": "Unstructured Partition (API)",
        "out_dir": OUT_DIR / "partition_api",
    },
    "azure/document_intelligence": {
        "id": "azure/document_intelligence",
        "label": "Azure Document Intelligence",
        "out_dir": AZURE_OUT_DIR / "document_intelligence",
    },
}
DEFAULT_PROVIDER = "azure/document_intelligence"


def ensure_dirs() -> None:
    RES_DIR.mkdir(parents=True, exist_ok=True)
    REVIEWS_DIR.mkdir(parents=True, exist_ok=True)
    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    DOMPURIFY_VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    MARKED_VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    CHART_VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    AZURE_OUT_DIR.mkdir(parents=True, exist_ok=True)
    for cfg in PROVIDERS.values():
        cfg["out_dir"].mkdir(parents=True, exist_ok=True)


def env_true(name: str) -> bool:
    v = os.environ.get(name)
    if v is None:
        return False
    return str(v).strip().lower() in {"1", "true", "yes", "on"}


def latest_by_mtime(paths: Iterable[Path]) -> Optional[Path]:
    if not paths:
        return None
    return max(paths, key=lambda p: p.stat().st_mtime)


def relative_to_root(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def get_out_dir(provider: str) -> Path:
    cfg = PROVIDERS.get(provider)
    if not cfg:
        raise ValueError(f"Unknown provider: {provider}")
    return cfg["out_dir"]


def safe_pages_tag(pages: str) -> str:
    return "pages" + re.sub(r"[^0-9\-]+", "_", pages)


def sanitize_pdf_filename(filename: str) -> str:
    base = Path(filename or "").name
    if not base:
        return ""
    if not base.lower().endswith(".pdf"):
        return ""
    stem = Path(base).stem
    safe_stem = re.sub(r"[^A-Za-z0-9_\\-]+", "-", stem).strip("-_")
    if not safe_stem:
        safe_stem = "upload"
    return f"{safe_stem}.pdf"


def ensure_pdfjs_assets() -> None:
    files = ["pdf.min.js", "pdf.worker.min.js"]
    sources = [
        "https://cdn.jsdelivr.net/npm/pdfjs-dist@{ver}/build/{name}",
        "https://unpkg.com/pdfjs-dist@{ver}/build/{name}",
    ]
    for fname in files:
        dest = VENDOR_DIR / fname
        if dest.exists() and dest.stat().st_size > 50_000:
            continue
        VENDOR_DIR.mkdir(parents=True, exist_ok=True)
        for tmpl in sources:
            url = tmpl.format(ver=PDFJS_VERSION, name=fname)
            try:
                with urlopen(url, timeout=10) as r:  # nosec - controlled URL
                    data = r.read()
                if not data:
                    continue
                with dest.open("wb") as f:
                    f.write(data)
                break
            except URLError:
                continue


def ensure_chartjs_assets() -> None:
    dest = CHART_VENDOR_DIR / "chart.umd.min.js"
    if dest.exists() and dest.stat().st_size > 50_000:
        return
    CHART_VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    sources = [
        f"https://cdnjs.cloudflare.com/ajax/libs/Chart.js/{CHARTJS_VERSION}/chart.umd.min.js",
        f"https://cdn.jsdelivr.net/npm/chart.js@{CHARTJS_VERSION}/dist/chart.umd.min.js",
        f"https://unpkg.com/chart.js@{CHARTJS_VERSION}/dist/chart.umd.min.js",
    ]
    for url in sources:
        try:
            with urlopen(url, timeout=10) as r:  # nosec - controlled URL
                data = r.read()
            if not data:
                continue
            with dest.open("wb") as f:
                f.write(data)
            break
        except URLError:
            continue


def _ensure_single_file(dest: Path, sources: list[str], min_size: int) -> None:
    if dest.exists() and dest.stat().st_size > min_size:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    for url in sources:
        try:
            with urlopen(url, timeout=10) as r:  # nosec - controlled URL
                data = r.read()
            if not data:
                continue
            with dest.open("wb") as f:
                f.write(data)
            break
        except URLError:
            continue


def ensure_markdown_assets() -> None:
    dompurify_dest = DOMPURIFY_VENDOR_DIR / "purify.min.js"
    dompurify_sources = [
        f"https://cdn.jsdelivr.net/npm/dompurify@{DOMPURIFY_VERSION}/dist/purify.min.js",
        f"https://unpkg.com/dompurify@{DOMPURIFY_VERSION}/dist/purify.min.js",
    ]
    marked_dest = MARKED_VENDOR_DIR / "marked.min.js"
    marked_sources = [
        f"https://cdn.jsdelivr.net/npm/marked@{MARKED_VERSION}/marked.min.js",
        f"https://unpkg.com/marked@{MARKED_VERSION}/marked.min.js",
    ]
    _ensure_single_file(dompurify_dest, dompurify_sources, min_size=10_000)
    _ensure_single_file(marked_dest, marked_sources, min_size=20_000)
