from __future__ import annotations

import json
import re
from html import unescape
from html.parser import HTMLParser
import os
from pathlib import Path
import subprocess
from dataclasses import dataclass
from urllib.request import urlopen
from urllib.error import URLError
from typing import Any, Dict, List, Optional, Tuple

from chunking_pipeline.chunker import decode_orig_elements

from fastapi import FastAPI, HTTPException, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "outputs" / "unstructured"
DATASET_DIR = ROOT / "dataset"
# Allow overriding the PDF source directory via env (e.g., for Fly.io volume mounts)
RES_DIR = Path(os.environ.get("PDF_DIR") or (ROOT / "res"))
RES_DIR.mkdir(parents=True, exist_ok=True)
VENDOR_DIR = ROOT / "web" / "static" / "vendor" / "pdfjs"
PDFJS_VERSION = "3.11.174"
CHART_VENDOR_DIR = ROOT / "web" / "static" / "vendor" / "chartjs"
CHARTJS_VERSION = "4.4.1"


app = FastAPI(title="Chunking Visualizer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024)


def _latest_by_mtime(paths: List[Path]) -> Optional[Path]:
    if not paths:
        return None
    return max(paths, key=lambda p: p.stat().st_mtime)


def _relative_to_root(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def _parse_matches(p: Path) -> Dict[str, Optional[str]]:
    """Return {ui_slug, base_slug, page_tag} for a matches file.

    Supports legacy `<slug>.matches.json` and new `<slug>.pages<range>.matches.json`.
    ui_slug is the stem used by the UI and other endpoints (must match the matches stem).
    """
    stem = p.name[:-len(".json")] if p.name.endswith(".json") else p.stem
    m = re.match(r"^(?P<slug>.+?)\.pages(?P<range>[0-9_\-,]+)\.matches$", stem)
    if m:
        base = m.group("slug")
        tag = m.group("range")
        return {"ui_slug": f"{base}.pages{tag}", "base_slug": base, "page_tag": tag}
    # Legacy: `<slug>.matches.json`
    if stem.endswith(".matches"):
        stem = stem[:-len(".matches")]
    return {"ui_slug": stem, "base_slug": stem, "page_tag": None}


def discover_runs() -> List[Dict[str, Any]]:
    runs: List[Dict[str, Any]] = []
    if not OUT_DIR.exists():
        return runs

    for m in sorted(OUT_DIR.glob("*.matches.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        meta = _parse_matches(m)
        ui_slug = meta["ui_slug"] or ""
        base_slug = meta["base_slug"] or ""
        page_tag = meta.get("page_tag")

        if page_tag:
            tables_path = OUT_DIR / f"{base_slug}.pages{page_tag}.tables.jsonl"
            pdf_path = OUT_DIR / f"{base_slug}.pages{page_tag}.pdf"
            if not tables_path.exists():
                tables_path = None
            if not pdf_path.exists():
                pdf_path = None
            page_range = (page_tag or "").replace("_", ",") or None
        else:
            # Legacy: pick latest associated tables/pdf
            tables = sorted(OUT_DIR.glob(f"{base_slug}.pages*.tables.jsonl"))
            pdfs = sorted(OUT_DIR.glob(f"{base_slug}.pages*.pdf"))
            tables_path = _latest_by_mtime(tables)
            pdf_path = _latest_by_mtime(pdfs)
            page_range = None

        chunk_path = OUT_DIR / f"{ui_slug}.chunks.jsonl"
        if not chunk_path.exists() and page_tag:
            candidate = OUT_DIR / f"{base_slug}.pages{page_tag}.chunks.jsonl"
            if candidate.exists():
                chunk_path = candidate
        if not chunk_path.exists():
            chunk_path = None

        with m.open("r", encoding="utf-8") as f:
            matches_json = json.load(f)

        overall = matches_json.get("overall", {})
        chunk_summary = matches_json.get("chunk_summary")
        run_config = matches_json.get("run_config")

        runs.append(
            {
                "slug": ui_slug,
                "matches_file": str(m.relative_to(ROOT)),
                "tables_file": str(tables_path.relative_to(ROOT)) if tables_path else None,
                "pdf_file": str(pdf_path.relative_to(ROOT)) if pdf_path else None,
                "page_range": page_range,
                "overall": overall,
                "chunks_file": str(chunk_path.relative_to(ROOT)) if chunk_path else None,
                "chunk_summary": chunk_summary,
                "run_config": run_config,
            }
        )

    return runs


@app.get("/api/runs")
def api_runs() -> List[Dict[str, Any]]:
    return discover_runs()


def _managed_file_set() -> set:
    runs = discover_runs()
    keep: set = set()
    for r in runs:
        for key in ("matches_file", "tables_file", "pdf_file", "chunks_file"):
            val = r.get(key)
            if val:
                keep.add(str((ROOT / val).resolve()))
    return keep


def _is_managed_path(path: Path) -> bool:
    name = path.name
    if name.endswith(".matches.json") or name.endswith(".tables.jsonl") or name.endswith(".chunks.jsonl"):
        return True
    if name.endswith(".pdf") and ".pages" in name:
        return True
    return False


@app.post("/api/cleanup")
def api_cleanup() -> Dict[str, Any]:
    keep = _managed_file_set()
    removed: List[str] = []
    for path in OUT_DIR.glob("*"):
        if not path.is_file():
            continue
        if not _is_managed_path(path):
            continue
        if str(path.resolve()) in keep:
            continue
        path.unlink()
        removed.append(str(path.relative_to(ROOT)))
    return {"status": "ok", "removed": removed}


@app.delete("/api/run/{slug}")
def api_delete_run(slug: str) -> Dict[str, Any]:
    # slug is the UI slug (matches stem). Remove matches and associated artifacts.
    removed: List[str] = []
    if ".pages" in slug:
        # New style exact files
        for suff in ["matches.json", "tables.jsonl", "pdf", "chunks.jsonl"]:
            p = OUT_DIR / f"{slug}.{suff}"
            if p.exists():
                p.unlink()
                removed.append(str(p.relative_to(ROOT)))
    else:
        # Legacy style: matches file + any pages* artifacts
        m = OUT_DIR / f"{slug}.matches.json"
        if m.exists():
            m.unlink()
            removed.append(str(m.relative_to(ROOT)))
        for globpat in [f"{slug}.pages*.tables.jsonl", f"{slug}.pages*.pdf", f"{slug}.pages*.chunks.jsonl"]:
            for p in OUT_DIR.glob(globpat):
                p.unlink()
                removed.append(str(p.relative_to(ROOT)))
    # Clear cache entries
    _INDEX_CACHE.pop(slug, None)
    return {"status": "ok", "removed": removed}


@app.get("/api/pdfs")
def api_pdfs() -> List[Dict[str, Any]]:
    pdfs: List[Dict[str, Any]] = []
    if RES_DIR.exists():
        for p in sorted(RES_DIR.glob("*.pdf")):
            try:
                size = p.stat().st_size
            except OSError:
                size = None
            pdfs.append({
                "name": p.name,
                "slug": p.stem,
                "path": _relative_to_root(p),
                "size": size,
            })
    return pdfs


def _sanitize_pdf_filename(filename: str) -> str:
    base = Path(filename or "").name
    if not base:
        return ""
    if not base.lower().endswith(".pdf"):
        return ""
    stem = Path(base).stem
    safe_stem = re.sub(r"[^A-Za-z0-9_\-]+", "-", stem).strip("-_")
    if not safe_stem:
        safe_stem = "upload"
    return f"{safe_stem}.pdf"


@app.post("/api/pdfs")
async def api_upload_pdf(file: UploadFile = File(...)) -> Dict[str, Any]:
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="file is required")
    safe_name = _sanitize_pdf_filename(file.filename)
    if not safe_name:
        raise HTTPException(status_code=400, detail="Only .pdf files are accepted")
    dest = (RES_DIR / safe_name).resolve()
    if not str(dest).startswith(str(RES_DIR.resolve())):
        raise HTTPException(status_code=400, detail="Invalid destination path")
    if dest.exists():
        raise HTTPException(status_code=409, detail=f"PDF already exists: {safe_name}")
    try:
        with dest.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
    finally:
        await file.close()
    try:
        size = dest.stat().st_size
    except OSError:
        size = None
    return {
        "name": safe_name,
        "slug": dest.stem,
        "path": _relative_to_root(dest),
        "size": size,
    }


def _safe_pages_tag(pages: str) -> str:
    # Keep digits and dashes; replace others with underscore to stabilize filenames
    return "pages" + re.sub(r"[^0-9\-]+", "_", pages)


@dataclass
class RunRequest:
    pdf_name: str
    pages: str
    strategy: str = "auto"  # auto|fast|hi_res
    infer_table_structure: bool = True
    chunking: str = "by_title"  # basic|by_title
    chunk_max_tokens: Optional[int] = None
    chunk_max_characters: Optional[int] = None
    chunk_new_after_n_chars: Optional[int] = None
    chunk_combine_under_n_chars: Optional[int] = None
    chunk_overlap: Optional[int] = None
    chunk_include_orig_elements: Optional[bool] = None
    chunk_overlap_all: Optional[bool] = None
    chunk_multipage_sections: Optional[bool] = None
    tag: Optional[str] = None


@app.post("/api/run")
def api_run(payload: Dict[str, Any]) -> Dict[str, Any]:
    # Validate input
    pdf_name = str(payload.get("pdf") or payload.get("pdf_name") or "").strip()
    pages = str(payload.get("pages") or "").strip()
    if not pdf_name or not pages:
        raise HTTPException(status_code=400, detail="Fields 'pdf' and 'pages' are required")

    strategy = str(payload.get("strategy") or "auto")
    if strategy not in {"auto", "fast", "hi_res"}:
        raise HTTPException(status_code=400, detail="strategy must be one of: auto, fast, hi_res")

    infer_table_structure = bool(payload.get("infer_table_structure", True))

    chunking = str(payload.get("chunking") or "by_title")
    if chunking not in {"basic", "by_title"}:
        raise HTTPException(status_code=400, detail="chunking must be one of: basic, by_title")

    chunk_max_tokens = payload.get("chunk_max_tokens")
    chunk_max_characters = payload.get("chunk_max_characters")
    chunk_new_after_n_chars = payload.get("chunk_new_after_n_chars")
    chunk_combine_under_n_chars = payload.get("chunk_combine_under_n_chars")
    chunk_overlap = payload.get("chunk_overlap")
    ocr_languages = str(payload.get("ocr_languages") or "eng+ara").strip() or None
    languages_raw = payload.get("languages")
    primary_language = str(payload.get("primary_language") or "eng").strip().lower()
    if primary_language not in {"eng", "ara"}:
        primary_language = "eng"

    def _normalize_languages(value: Any) -> Optional[List[str]]:
        if value is None:
            return None
        items: List[str] = []
        if isinstance(value, str):
            parts = value.split(",")
        elif isinstance(value, (list, tuple, set)):
            parts = value
        else:
            raise HTTPException(status_code=400, detail="languages must be a list or comma-separated string")
        for part in parts:
            txt = str(part).strip()
            if txt:
                items.append(txt)
        return items or None

    languages = _normalize_languages(languages_raw)

    def _coerce_bool(name: str) -> Optional[bool]:
        val = payload.get(name)
        if val is None:
            return None
        if isinstance(val, bool):
            return val
        if isinstance(val, str):
            txt = val.strip().lower()
            if not txt:
                return None
            if txt in {"true", "1", "yes"}:
                return True
            if txt in {"false", "0", "no"}:
                return False
        raise HTTPException(status_code=400, detail=f"{name} must be a boolean")

    chunk_include_orig_elements = _coerce_bool("chunk_include_orig_elements")
    chunk_overlap_all = _coerce_bool("chunk_overlap_all")
    chunk_multipage_sections = _coerce_bool("chunk_multipage_sections")
    detect_language_per_element = _coerce_bool("detect_language_per_element")
    if detect_language_per_element is None:
        detect_language_per_element = False

    input_pdf = RES_DIR / pdf_name
    if not input_pdf.exists():
        raise HTTPException(status_code=404, detail=f"PDF not found: {pdf_name}")

    slug = input_pdf.stem
    # Optional variant tag to allow side-by-side comparisons
    raw_tag = str(payload.get("tag") or "").strip()
    safe_tag = None
    if raw_tag:
        safe_tag = re.sub(r"[^A-Za-z0-9_\-]+", "-", raw_tag)[:40].strip("-")
    run_slug = f"{slug}__{safe_tag}" if safe_tag else slug
    pages_tag = _safe_pages_tag(pages)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    form_snapshot: Dict[str, Any] = {
        "pdf": pdf_name,
        "pages": pages,
        "tag": raw_tag or None,
        "strategy": strategy,
        "infer_table_structure": infer_table_structure,
        "chunking": chunking,
        "max_tokens": chunk_max_tokens,
        "chunk_max_characters": chunk_max_characters,
        "chunk_new_after_n_chars": chunk_new_after_n_chars,
        "chunk_combine_under_n_chars": chunk_combine_under_n_chars,
        "chunk_overlap": chunk_overlap,
        "chunk_include_orig_elements": chunk_include_orig_elements,
        "chunk_overlap_all": chunk_overlap_all,
        "chunk_multipage_sections": chunk_multipage_sections,
        "ocr_languages": ocr_languages,
        "languages": languages,
        "detect_language_per_element": detect_language_per_element,
        "primary_language": primary_language,
    }
    payload["form_snapshot"] = form_snapshot

    def build_paths(slug_val: str):
        return (
            OUT_DIR / f"{slug_val}.{pages_tag}.tables.jsonl",
            OUT_DIR / f"{slug_val}.{pages_tag}.matches.json",
            OUT_DIR / f"{slug_val}.{pages_tag}.pdf",
            OUT_DIR / f"{slug_val}.{pages_tag}.chunks.jsonl",
        )

    tables_out, matches_out, trimmed_out, chunk_out = build_paths(run_slug)

    # Ensure we don't overwrite an existing run; append __rN when needed
    if matches_out.exists() or tables_out.exists() or trimmed_out.exists():
        n = 2
        base_variant = run_slug
        while True:
            candidate = f"{base_variant}__r{n}"
            t_out, m_out, p_out, c_out = build_paths(candidate)
            if not (m_out.exists() or t_out.exists() or p_out.exists()):
                run_slug = candidate
                tables_out, matches_out, trimmed_out, chunk_out = t_out, m_out, p_out, c_out
                break
            n += 1

    cmd: List[str] = [
        "uv", "run", "python", str(ROOT / "scripts" / "run_chunking_pipeline.py"),
        "--input", str(input_pdf),
        "--pages", pages,
        "--strategy", strategy,
        "--output", str(tables_out),
        "--trimmed-out", str(trimmed_out),
        "--gold", str(DATASET_DIR / "gold.jsonl"),
        "--emit-matches", str(matches_out),
    ]
    if not infer_table_structure:
        cmd.append("--no-infer-table-structure")

    cmd += ["--chunking", chunking, "--chunk-output", str(chunk_out)]
    if chunk_max_characters is not None:
        cmd += ["--chunk-max-characters", str(int(chunk_max_characters))]
    if chunk_new_after_n_chars is not None:
        cmd += ["--chunk-new-after-n-chars", str(int(chunk_new_after_n_chars))]
    if chunk_combine_under_n_chars is not None:
        cmd += ["--chunk-combine-under-n-chars", str(int(chunk_combine_under_n_chars))]
    if chunk_overlap is not None:
        cmd += ["--chunk-overlap", str(int(chunk_overlap))]
    if chunk_include_orig_elements is True:
        cmd.append("--chunk-include-orig-elements")
    elif chunk_include_orig_elements is False:
        cmd.append("--chunk-no-include-orig-elements")
    if chunk_overlap_all is True:
        cmd.append("--chunk-overlap-all")
    elif chunk_overlap_all is False:
        cmd.append("--chunk-no-overlap-all")
    if chunk_multipage_sections is True:
        cmd.append("--chunk-multipage-sections")
    elif chunk_multipage_sections is False:
        cmd.append("--chunk-no-multipage-sections")
    if ocr_languages:
        cmd += ["--ocr-languages", ocr_languages]
    if languages:
        cmd += ["--languages", ",".join(languages)]
    if detect_language_per_element:
        cmd.append("--detect-language-per-element")
    if primary_language:
        cmd += ["--primary-language", primary_language]

    try:
        r = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed starting run: {e}")

    if r.returncode != 0:
        # Include a short tail of stderr for debugging
        tail = (r.stderr or "").splitlines()[-20:]
        raise HTTPException(status_code=500, detail=f"Run failed ({r.returncode}):\n" + "\n".join(tail))

    # Post-process matches JSON to persist full form snapshot for the recap bar
    try:
        with matches_out.open("r", encoding="utf-8") as f:
            mobj = json.load(f)
    except Exception:
        mobj = None
    if isinstance(mobj, dict):
        rc = mobj.get("run_config") or {}
        snap = payload.get("form_snapshot") or {}
        rc["form_snapshot"] = snap
        rc["pdf"] = pdf_name
        rc["pages"] = pages
        if safe_tag:
            rc["tag"] = safe_tag
        if raw_tag:
            rc["variant_tag"] = raw_tag
        if primary_language:
            rc["primary_language"] = primary_language
        mobj["run_config"] = rc
        try:
            with matches_out.open("w", encoding="utf-8") as f:
                json.dump(mobj, f, ensure_ascii=False, indent=2)
                f.write("\n")
        except Exception:
            # Non-fatal: keep going if we can't rewrite
            pass

    # Return fresh run metadata
    run_info = {
        "slug": f"{run_slug}.{pages_tag}",
        "page_tag": pages_tag,
        "tables_file": str(tables_out.relative_to(ROOT)) if tables_out.exists() else None,
        "pdf_file": str(trimmed_out.relative_to(ROOT)) if trimmed_out.exists() else None,
        "matches_file": str(matches_out.relative_to(ROOT)) if matches_out.exists() else None,
        "chunks_file": str(chunk_out.relative_to(ROOT)) if chunk_out.exists() else None,
    }
    return {"status": "ok", "run": run_info}


def _resolve_slug_file(slug: str, pattern: str) -> Path:
    # Find latest file matching pattern for slug
    pat = pattern.format(slug=slug)
    # If caller provided a `.pages*` pattern but slug already contains `.pagesX-Y`,
    # strip the wildcard segment to avoid double `.pages` in the path.
    if ".pages*" in pat and ".pages" in slug:
        pat = pat.replace(".pages*", "")
    candidates = sorted(OUT_DIR.glob(pat))
    path = _latest_by_mtime(candidates)
    if not path:
        raise HTTPException(status_code=404, detail=f"No file found for {slug} with pattern {pattern}")
    return path


@app.get("/api/matches/{slug}")
def api_matches(slug: str) -> Dict[str, Any]:
    # slug is the UI slug (matches stem). Prefer new-style `<slug>.matches.json` where
    # slug may already include `.pages<range>`.
    path = OUT_DIR / f"{slug}.matches.json"
    if not path.exists():
        # Fallback for legacy `<base>.matches.json` with UI slug equal to base
        legacy = OUT_DIR / f"{slug}.matches.json"
        if not legacy.exists():
            raise HTTPException(status_code=404, detail=f"Matches not found for {slug}")
        path = legacy
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


@app.get("/api/tables/{slug}")
def api_tables(slug: str) -> List[Dict[str, Any]]:
    path = _resolve_slug_file(slug, "{slug}.pages*.tables.jsonl")
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                # Skip malformed lines gracefully
                continue
    return rows


# --- Minimal box index for faster UI loading ---
_INDEX_CACHE: Dict[str, Dict[str, Any]] = {}


def _ensure_index(slug: str) -> Dict[str, Any]:
    path = _resolve_slug_file(slug, "{slug}.pages*.tables.jsonl")
    mtime = path.stat().st_mtime
    cached = _INDEX_CACHE.get(slug)
    if cached and cached.get("mtime") == mtime and cached.get("path") == path:
        return cached

    by_id: Dict[str, Dict[str, Any]] = {}
    by_page: Dict[int, List[str]] = {}
    type_counts: Dict[str, int] = {}
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            element_id = obj.get("element_id")
            el_type = obj.get("type") or "Unknown"
            md = obj.get("metadata", {})
            coords = (md.get("coordinates") or {})
            pts = coords.get("points") or []
            if not element_id or not pts:
                continue
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            x = min(xs)
            y = min(ys)
            w = max(xs) - x
            h = max(ys) - y
            # page number is usually under metadata.page_number; fallback to list or top-level
            page_trimmed = (
                obj.get("page_number")
                or md.get("page_number")
                or (md.get("page_numbers") or [None])[0]
            )
            by_id[element_id] = {
                "page_trimmed": page_trimmed,
                "layout_w": coords.get("layout_width"),
                "layout_h": coords.get("layout_height"),
                "x": x,
                "y": y,
                "w": w,
                "h": h,
                "type": el_type,
                "orig_id": md.get("original_element_id"),
            }
            if isinstance(page_trimmed, int):
                by_page.setdefault(page_trimmed, []).append(element_id)
            type_counts[el_type] = type_counts.get(el_type, 0) + 1

    cached = {"mtime": mtime, "path": path, "by_id": by_id, "by_page": by_page, "type_counts": type_counts}
    _INDEX_CACHE[slug] = cached
    return cached


@app.get("/api/elements/{slug}")
def api_elements(slug: str, ids: str = Query(..., description="Comma-separated element IDs")) -> Dict[str, Any]:
    wanted = [s for s in (ids or "").split(",") if s]
    idx = _ensure_index(slug)["by_id"]
    return {i: idx.get(i) for i in wanted if i in idx}


@app.get("/api/element_types/{slug}")
def api_element_types(slug: str) -> Dict[str, Any]:
    idx = _ensure_index(slug)
    counts = idx.get("type_counts", {})
    items = sorted(([k, int(v)] for k, v in counts.items()), key=lambda t: (-t[1], t[0]))
    return {"types": [{"type": k, "count": v} for k, v in items]}


@app.get("/api/boxes/{slug}")
def api_boxes(slug: str, page: int = Query(..., ge=1), types: Optional[str] = Query(None, description="Comma-separated element types to include; omit for all")) -> Dict[str, Any]:
    cache = _ensure_index(slug)
    by_id = cache["by_id"]
    by_page = cache.get("by_page", {})
    ids = by_page.get(page, [])
    allowed: Optional[set] = None
    if types:
        allowed = {t.strip() for t in types.split(",") if t.strip()}
    result: Dict[str, Any] = {}
    for i in ids:
        entry = by_id.get(i)
        if not entry:
            continue
        if allowed and entry.get("type") not in allowed:
            continue
        result[i] = entry
    return result


def _scan_element(slug: str, element_id: str) -> Optional[Dict[str, Any]]:
    path = _resolve_slug_file(slug, "{slug}.pages*.tables.jsonl")
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("element_id") == element_id or ((obj.get("metadata") or {}).get("original_element_id") == element_id):
                return obj
    return None


def _resolve_chunk_file(slug: str) -> Path:
    path = OUT_DIR / f"{slug}.chunks.jsonl"
    if path.exists():
        return path
    base, sep, rest = slug.partition(".pages")
    if sep:
        candidate = OUT_DIR / f"{base}.pages{rest}.chunks.jsonl"
        if candidate.exists():
            return candidate
    raise HTTPException(status_code=404, detail=f"Chunk file not found for {slug}")


@app.get("/api/chunks/{slug}")
def api_chunks(slug: str) -> Dict[str, Any]:
    path = _resolve_chunk_file(slug)
    chunks: List[Dict[str, Any]] = []
    count = 0
    total = 0
    min_len: Optional[int] = None
    max_len: Optional[int] = None
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            text = obj.get("text") or ""
            length = len(text)
            count += 1
            total += length
            min_len = length if min_len is None else min(min_len, length)
            max_len = length if max_len is None else max(max_len, length)
            meta = obj.get("metadata") or {}
            orig_boxes: List[Dict[str, Any]] = []
            orig_table_html: Optional[str] = None
            orig_html_is_table = False
            try:
                decoded = decode_orig_elements(meta)
            except Exception:
                decoded = []
            for el in decoded:
                md = el.get("metadata") or {}
                coords = (md.get("coordinates") or {})
                pts = coords.get("points") or []
                if not pts:
                    continue
                xs = [p[0] for p in pts]
                ys = [p[1] for p in pts]
                x = min(xs)
                y = min(ys)
                w = max(xs) - x
                h = max(ys) - y
                page_trimmed = md.get("page_number") or (md.get("page_numbers") or [None])[0]
                box_entry = {
                    "page_trimmed": page_trimmed,
                    "layout_w": coords.get("layout_width"),
                    "layout_h": coords.get("layout_height"),
                    "x": x,
                    "y": y,
                    "w": w,
                    "h": h,
                    "type": el.get("type") or md.get("category"),
                    "element_id": el.get("element_id"),
                    "orig_id": md.get("original_element_id"),
                }
                orig_boxes.append(box_entry)
                html_candidate = md.get("text_as_html") or el.get("text_as_html")
                if html_candidate:
                    is_table = "table" in (el.get("type") or "").lower()
                    if not orig_table_html or (is_table and not orig_html_is_table):
                        orig_table_html = html_candidate
                        orig_html_is_table = is_table
            # Compute a simple bbox for the chunk itself from its coordinates (if present)
            bbox = None
            try:
                ccoords = (meta.get("coordinates") or {})
                pts = ccoords.get("points") or []
                if pts:
                    xs = [p[0] for p in pts]
                    ys = [p[1] for p in pts]
                    x = min(xs)
                    y = min(ys)
                    w = max(xs) - x
                    h = max(ys) - y
                    page_trimmed = meta.get("page_number") or (meta.get("page_numbers") or [None])[0]
                    bbox = {
                        "page_trimmed": page_trimmed,
                        "layout_w": ccoords.get("layout_width"),
                        "layout_h": ccoords.get("layout_height"),
                        "x": x,
                        "y": y,
                        "w": w,
                        "h": h,
                    }
            except Exception:
                bbox = None
            segment_bbox = None
            segment_span_info: Optional[Tuple[int, int, int]] = None
            if orig_table_html:
                reference_bbox = _pick_table_bbox(orig_boxes) or bbox
                seg_info = _compute_table_segment(meta, obj, orig_table_html, reference_bbox)
                if seg_info:
                    segment_bbox, span, total_rows = seg_info
                    segment_span_info = (span[0], span[1], total_rows)
                    if segment_bbox and reference_bbox and not segment_bbox.get("page_trimmed"):
                        segment_bbox["page_trimmed"] = reference_bbox.get("page_trimmed")
            chunk_entry: Dict[str, Any] = {
                "element_id": obj.get("element_id"),
                "text": text,
                "char_len": length,
                "type": obj.get("type"),
                "metadata": meta,
                "orig_boxes": orig_boxes,
                "bbox": bbox,
            }
            if segment_bbox:
                chunk_entry["segment_bbox"] = segment_bbox
                if segment_span_info:
                    start_idx, end_idx, total_rows = segment_span_info
                    chunk_entry["segment_row_span"] = {
                        "start": start_idx,
                        "end": end_idx,
                        "total": total_rows,
                    }
            chunks.append(chunk_entry)
    summary = {
        "count": count,
        "total_chars": total,
        "min_chars": min_len or 0,
        "max_chars": max_len or 0,
        "avg_chars": (total / count) if count else 0,
    }
    return {"summary": summary, "chunks": chunks}


class _TableHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.rows: List[List[str]] = []
        self._current_row: List[str] = []
        self._current_cell: List[str] = []
        self._in_cell = False

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        tag = tag.lower()
        if tag == "tr":
            self._current_row = []
        elif tag in {"td", "th"}:
            self._in_cell = True
            self._current_cell = []
        elif tag == "br" and self._in_cell:
            self._current_cell.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"td", "th"}:
            if self._in_cell:
                text = unescape("".join(self._current_cell))
                self._current_row.append(text)
            self._current_cell = []
            self._in_cell = False
        elif tag == "tr":
            if any((cell or "").strip() for cell in self._current_row):
                self.rows.append(self._current_row)
            self._current_row = []

    def handle_data(self, data: str) -> None:
        if self._in_cell and data:
            self._current_cell.append(data)

    def handle_entityref(self, name: str) -> None:
        if self._in_cell:
            self._current_cell.append(unescape(f"&{name};"))

    def handle_charref(self, name: str) -> None:
        if self._in_cell:
            try:
                codepoint = int(name, 16) if name.lower().startswith("x") else int(name)
                self._current_cell.append(chr(codepoint))
            except ValueError:
                pass


def _collect_table_rows(html_text: Optional[str]) -> List[str]:
    if not html_text:
        return []
    parser = _TableHTMLParser()
    try:
        parser.feed(html_text)
        parser.close()
    except Exception:
        return []
    rows: List[str] = []
    for cells in parser.rows:
        joined = " ".join((cell or "").strip() for cell in cells if (cell or "").strip())
        normalized = re.sub(r"\s+", " ", joined.replace("\xa0", " ")).strip()
        if normalized:
            rows.append(normalized)
    return rows


def _normalize_row(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").replace("\xa0", " ")).strip().lower()


def _rows_match(a: str, b: str) -> bool:
    if not a or not b:
        return False
    if a == b:
        return True
    return a in b or b in a


def _find_row_span(orig_rows: List[str], chunk_rows: List[str]) -> Optional[Tuple[int, int]]:
    if not orig_rows or not chunk_rows:
        return None
    haystack = [_normalize_row(r) for r in orig_rows]
    needle = [_normalize_row(r) for r in chunk_rows]
    n = len(needle)
    if n == 0 or len(haystack) < n:
        return None
    for start in range(len(haystack) - n + 1):
        matches = True
        for offset in range(n):
            if not _rows_match(haystack[start + offset], needle[offset]):
                matches = False
                break
        if matches:
            return start, start + n
    # Fallback: try to locate first and last row independently
    first = needle[0]
    last = needle[-1]
    start_idx = next((i for i, row in enumerate(haystack) if _rows_match(row, first)), None)
    if start_idx is None:
        return None
    if n == 1:
        return start_idx, start_idx + 1
    end_idx = next((i for i in range(start_idx + 1, len(haystack)) if _rows_match(haystack[i], last)), None)
    if end_idx is None:
        end_idx = min(len(haystack), start_idx + n)
    else:
        end_idx += 1
    if end_idx <= start_idx:
        return None
    return start_idx, min(len(haystack), end_idx)


def _slice_bbox(
    bbox: Optional[Dict[str, Any]],
    total_rows: int,
    row_span: Tuple[int, int],
    weights: Optional[List[float]] = None,
) -> Optional[Dict[str, Any]]:
    if not bbox or not total_rows:
        return None
    x = bbox.get("x")
    y = bbox.get("y")
    w = bbox.get("w")
    h = bbox.get("h")
    if any(val is None for val in (x, y, w, h)):
        return None
    start, end = row_span
    if start < 0 or end <= start or end > total_rows:
        return None
    seg_y = y
    seg_h = 0.0
    if weights and len(weights) == total_rows:
        total_weight = sum(weights)
        if total_weight <= 0:
            weights = None
    if weights and len(weights) == total_rows:
        acc = [0.0]
        running = 0.0
        for wgt in weights:
            running += max(float(wgt), 0.0)
            acc.append(running)
        total_weight = acc[-1] or 1.0
        start_w = acc[start]
        end_w = acc[end]
        seg_y = y + h * (start_w / total_weight)
        seg_h = h * max((end_w - start_w) / total_weight, 0.0)
    else:
        row_height = h / total_rows
        seg_y = y + row_height * start
        seg_h = row_height * (end - start)
    if seg_h <= 0:
        return None
    return {
        "page_trimmed": bbox.get("page_trimmed"),
        "layout_w": bbox.get("layout_w"),
        "layout_h": bbox.get("layout_h"),
        "x": x,
        "y": seg_y,
        "w": w,
        "h": seg_h,
    }


def _pick_table_bbox(orig_boxes: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for box in orig_boxes:
        t = (box.get("type") or "").lower()
        if "table" in t:
            return box
    return None


def _compute_table_segment(meta: Dict[str, Any], chunk: Dict[str, Any], table_html: Optional[str], reference_bbox: Optional[Dict[str, Any]]) -> Optional[Tuple[Dict[str, Any], Tuple[int, int], int]]:
    if not (table_html and reference_bbox):
        return None
    chunk_html = (meta.get("text_as_html") or chunk.get("text_as_html") or "")
    if "<table" not in chunk_html.lower():
        return None
    orig_rows = _collect_table_rows(table_html)
    row_weights = [max(len(r), 1) for r in orig_rows]
    chunk_rows = _collect_table_rows(chunk_html)
    if not orig_rows or not chunk_rows:
        return None
    span = _find_row_span(orig_rows, chunk_rows)
    if not span:
        return None
    sliced = _slice_bbox(reference_bbox, len(orig_rows), span, row_weights)
    if not sliced:
        return None
    return sliced, span, len(orig_rows)


@app.get("/api/element/{slug}/{element_id}")
def api_element(slug: str, element_id: str) -> Dict[str, Any]:
    obj = _scan_element(slug, element_id)
    if not obj:
        raise HTTPException(status_code=404, detail=f"Element {element_id} not found")
    # Return a trimmed payload focused on preview
    md = obj.get("metadata", {})
    # derive robust page number like the indexer does
    page_num = (
        obj.get("page_number")
        or md.get("page_number")
        or (md.get("page_numbers") or [None])[0]
    )
    return {
        "element_id": obj.get("element_id"),
        "type": obj.get("type"),
        "page_number": page_num,
        "text": obj.get("text"),
        "text_as_html": md.get("text_as_html"),
        "expected_cols": md.get("expected_cols"),
        "coordinates": (md.get("coordinates") or {}),
        "original_element_id": md.get("original_element_id"),
    }


@app.get("/api/gold")
def api_gold() -> List[Dict[str, Any]]:
    gold_path = DATASET_DIR / "gold.jsonl"
    if not gold_path.exists():
        raise HTTPException(status_code=404, detail="gold.jsonl not found")
    rows: List[Dict[str, Any]] = []
    with gold_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


@app.get("/pdf/{slug}")
def pdf_for_slug(slug: str):
    pdf_path = _resolve_slug_file(slug, "{slug}.pages*.pdf")
    return FileResponse(str(pdf_path))


@app.get("/res_pdf/{name}")
def pdf_from_res(name: str):
    # Serve a source PDF from res/ for preview in the New Run modal.
    # Prevent path traversal by resolving and checking parent.
    if not name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="name must be a .pdf")
    candidate = (RES_DIR / name).resolve()
    if not str(candidate).startswith(str(RES_DIR.resolve())):
        raise HTTPException(status_code=400, detail="invalid path")
    if not candidate.exists():
        raise HTTPException(status_code=404, detail=f"PDF not found: {name}")
    return FileResponse(str(candidate))


# Static UI (mounted last so API routes take precedence)
STATIC_DIR = ROOT / "web" / "static"
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="ui")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765, reload=False)
# Ensure local pdf.js assets are available so the UI can load without CDNs
def ensure_pdfjs_assets() -> None:
    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    files = ["pdf.min.js", "pdf.worker.min.js"]
    sources = [
        "https://cdn.jsdelivr.net/npm/pdfjs-dist@{ver}/build/{name}",
        "https://unpkg.com/pdfjs-dist@{ver}/build/{name}",
    ]
    for fname in files:
        dest = VENDOR_DIR / fname
        if dest.exists() and dest.stat().st_size > 50_000:
            continue
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


ensure_pdfjs_assets()


def ensure_chartjs_assets() -> None:
    """Cache Chart.js locally so the UI can initialize offline."""
    CHART_VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    dest = CHART_VENDOR_DIR / "chart.umd.min.js"
    if dest.exists() and dest.stat().st_size > 50_000:
        return
    sources = [
        f"https://cdnjs.cloudflare.com/ajax/libs/Chart.js/{CHARTJS_VERSION}/chart.umd.min.js",
        f"https://cdn.jsdelivr.net/npm/chart.js@{CHARTJS_VERSION}/dist/chart.umd.min.js",
        f"https://unpkg.com/chart.js@{CHARTJS_VERSION}/dist/chart.umd.min.js",
    ]
    for url in sources:
        try:
            with urlopen(url, timeout=10) as r:  # nosec - controlled URLs
                data = r.read()
            if not data:
                continue
            with dest.open("wb") as f:
                f.write(data)
            break
        except URLError:
            continue


ensure_chartjs_assets()
