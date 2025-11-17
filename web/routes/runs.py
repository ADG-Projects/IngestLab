from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException

from ..config import (
    DATASET_DIR,
    OUT_DIR,
    RES_DIR,
    ROOT,
    env_true,
    latest_by_mtime,
    relative_to_root,
    safe_pages_tag,
)
from .elements import clear_index_cache
from .reviews import review_file_path

router = APIRouter()


def _parse_matches(p: Path) -> Dict[str, Optional[str]]:
    stem = p.name[:-len(".json")] if p.name.endswith(".json") else p.stem
    m = re.match(r"^(?P<slug>.+?)\.pages(?P<range>[0-9_\-,]+)\.matches$", stem)
    if m:
        base = m.group("slug")
        tag = m.group("range")
        return {"ui_slug": f"{base}.pages{tag}", "base_slug": base, "page_tag": tag}
    if stem.endswith(".matches"):
        stem = stem[:-len(".matches")]
    return {"ui_slug": stem, "base_slug": stem, "page_tag": None}


def discover_runs() -> List[Dict[str, Any]]:
    runs: List[Dict[str, Any]] = []
    if not OUT_DIR.exists():
        return runs

    matches_files = sorted(OUT_DIR.glob("*.matches.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for m in matches_files:
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
            tables = sorted(OUT_DIR.glob(f"{base_slug}.pages*.tables.jsonl"))
            pdfs = sorted(OUT_DIR.glob(f"{base_slug}.pages*.pdf"))
            tables_path = latest_by_mtime(tables)
            pdf_path = latest_by_mtime(pdfs)
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

        runs.append(
            {
                "slug": ui_slug,
                "matches_file": relative_to_root(m),
                "tables_file": relative_to_root(tables_path) if tables_path else None,
                "pdf_file": relative_to_root(pdf_path) if pdf_path else None,
                "page_range": page_range,
                "overall": matches_json.get("overall", {}),
                "chunks_file": relative_to_root(chunk_path) if chunk_path else None,
                "chunk_summary": matches_json.get("chunk_summary"),
                "run_config": matches_json.get("run_config"),
            }
        )

    return runs


@router.get("/api/runs")
def api_runs() -> List[Dict[str, Any]]:
    return discover_runs()


@router.delete("/api/run/{slug}")
def api_delete_run(slug: str) -> Dict[str, Any]:
    removed: List[str] = []
    if ".pages" in slug:
        for suff in ["matches.json", "tables.jsonl", "pdf", "chunks.jsonl"]:
            p = OUT_DIR / f"{slug}.{suff}"
            if p.exists():
                p.unlink()
                removed.append(relative_to_root(p))
    else:
        m = OUT_DIR / f"{slug}.matches.json"
        if m.exists():
            m.unlink()
            removed.append(relative_to_root(m))
        for globpat in [f"{slug}.pages*.tables.jsonl", f"{slug}.pages*.pdf", f"{slug}.pages*.chunks.jsonl"]:
            for p in OUT_DIR.glob(globpat):
                p.unlink()
                removed.append(relative_to_root(p))
    try:
        review_path = review_file_path(slug)
    except HTTPException:
        review_path = None
    if review_path and review_path.exists():
        review_path.unlink()
        removed.append(relative_to_root(review_path))
    clear_index_cache(slug)
    return {"status": "ok", "removed": removed}


@router.post("/api/run")
def api_run(payload: Dict[str, Any]) -> Dict[str, Any]:
    pdf_name = str(payload.get("pdf") or payload.get("pdf_name") or "").strip()
    pages = str(payload.get("pages") or "").strip()
    if not pdf_name:
        raise HTTPException(status_code=400, detail="Field 'pdf' is required")

    strategy = str(payload.get("strategy") or "auto")
    if strategy not in {"auto", "fast", "hi_res"}:
        raise HTTPException(status_code=400, detail="strategy must be one of: auto, fast, hi_res")
    if env_true("DISABLE_HI_RES"):
        if strategy in {"auto", "hi_res"}:
            strategy = "fast"

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

    if not pages:
        try:
            from pypdf import PdfReader  # type: ignore

            reader = PdfReader(str(input_pdf))
            total = len(reader.pages)
            if total <= 0:
                raise ValueError("empty PDF")
            pages = f"1-{total}"
        except Exception as e:  # pragma: no cover - defensive fallback
            raise HTTPException(status_code=400, detail=f"Could not infer page range: {e}")

    slug = input_pdf.stem
    raw_tag = str(payload.get("tag") or "").strip()
    safe_tag = None
    if raw_tag:
        safe_tag = re.sub(r"[^A-Za-z0-9_\-]+", "-", raw_tag)[:40].strip("-")
    run_slug = f"{slug}__{safe_tag}" if safe_tag else slug
    pages_tag = safe_pages_tag(pages)
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
        sys.executable,
        str(ROOT / "scripts" / "run_chunking_pipeline.py"),
        "--input",
        str(input_pdf),
        "--pages",
        pages,
        "--strategy",
        strategy,
        "--output",
        str(tables_out),
        "--trimmed-out",
        str(trimmed_out),
        "--gold",
        str(DATASET_DIR / "gold.jsonl"),
        "--emit-matches",
        str(matches_out),
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
        tail = (r.stderr or "").splitlines()[-20:]
        raise HTTPException(status_code=500, detail=f"Run failed ({r.returncode}):\n" + "\n".join(tail))

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
            pass

    run_info = {
        "slug": f"{run_slug}.{pages_tag}",
        "page_tag": pages_tag,
        "tables_file": relative_to_root(tables_out) if tables_out.exists() else None,
        "pdf_file": relative_to_root(trimmed_out) if trimmed_out.exists() else None,
        "matches_file": relative_to_root(matches_out) if matches_out.exists() else None,
        "chunks_file": relative_to_root(chunk_out) if chunk_out.exists() else None,
    }
    return {"status": "ok", "run": run_info}
