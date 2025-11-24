from __future__ import annotations

import json
import logging
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query

from ..config import (
    DATASET_DIR,
    DEFAULT_PROVIDER,
    PROVIDERS,
    RES_DIR,
    ROOT,
    env_true,
    get_out_dir,
    latest_by_mtime,
    relative_to_root,
    safe_pages_tag,
)
from ..run_jobs import RUN_JOB_MANAGER
from .elements import clear_index_cache
from .reviews import review_file_path

router = APIRouter()
logger = logging.getLogger("chunking.routes.runs")


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


def discover_runs(provider: Optional[str] = None) -> List[Dict[str, Any]]:
    runs: List[Dict[str, Any]] = []
    provider_keys = [provider] if provider else list(PROVIDERS.keys())
    for prov in provider_keys:
        out_dir = get_out_dir(prov)
        if not out_dir.exists():
            continue
        matches_files = sorted(out_dir.glob("*.matches.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for m in matches_files:
            meta = _parse_matches(m)
            ui_slug = meta["ui_slug"] or ""
            base_slug = meta["base_slug"] or ""
            page_tag = meta.get("page_tag")

            if page_tag:
                tables_path = out_dir / f"{base_slug}.pages{page_tag}.tables.jsonl"
                pdf_path = out_dir / f"{base_slug}.pages{page_tag}.pdf"
                if not tables_path.exists():
                    tables_path = None
                if not pdf_path.exists():
                    pdf_path = None
                page_range = (page_tag or "").replace("_", ",") or None
            else:
                tables = sorted(out_dir.glob(f"{base_slug}.pages*.tables.jsonl"))
                pdfs = sorted(out_dir.glob(f"{base_slug}.pages*.pdf"))
                tables_path = latest_by_mtime(tables)
                pdf_path = latest_by_mtime(pdfs)
                page_range = None

            chunk_path = out_dir / f"{ui_slug}.chunks.jsonl"
            if not chunk_path.exists() and page_tag:
                candidate = out_dir / f"{base_slug}.pages{page_tag}.chunks.jsonl"
                if candidate.exists():
                    chunk_path = candidate
            if not chunk_path.exists():
                chunk_path = None

            with m.open("r", encoding="utf-8") as f:
                matches_json = json.load(f)

            runs.append(
                {
                    "slug": ui_slug,
                    "provider": prov,
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


@router.get("/api/run-jobs")
def api_run_jobs() -> Dict[str, Any]:
    return {"jobs": RUN_JOB_MANAGER.list_jobs()}


@router.get("/api/run-jobs/{job_id}")
def api_run_job_detail(job_id: str) -> Dict[str, Any]:
    job = RUN_JOB_MANAGER.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/api/runs")
def api_runs(provider: Optional[str] = Query(default=None)) -> List[Dict[str, Any]]:
    return discover_runs(provider=provider)


@router.delete("/api/run/{slug}")
def api_delete_run(slug: str, provider: str = Query(default=DEFAULT_PROVIDER)) -> Dict[str, Any]:
    out_dir = get_out_dir(provider)
    removed: List[str] = []
    if ".pages" in slug:
        for suff in ["matches.json", "tables.jsonl", "pdf", "chunks.jsonl"]:
            p = out_dir / f"{slug}.{suff}"
            if p.exists():
                p.unlink()
                removed.append(relative_to_root(p))
    else:
        m = out_dir / f"{slug}.matches.json"
        if m.exists():
            m.unlink()
            removed.append(relative_to_root(m))
        for globpat in [f"{slug}.pages*.tables.jsonl", f"{slug}.pages*.pdf", f"{slug}.pages*.chunks.jsonl"]:
            for p in out_dir.glob(globpat):
                p.unlink()
                removed.append(relative_to_root(p))
    try:
        review_path = review_file_path(slug, provider=provider)
    except HTTPException:
        review_path = None
    if review_path and review_path.exists():
        review_path.unlink()
        removed.append(relative_to_root(review_path))
    clear_index_cache(slug, provider)
    return {"status": "ok", "removed": removed}


@router.post("/api/run")
def api_run(payload: Dict[str, Any]) -> Dict[str, Any]:
    provider = str(payload.get("provider") or DEFAULT_PROVIDER).strip() or DEFAULT_PROVIDER
    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")
    out_dir = get_out_dir(provider)

    pdf_name = str(payload.get("pdf") or payload.get("pdf_name") or "").strip()
    pages = str(payload.get("pages") or "").strip()
    if not pdf_name:
        raise HTTPException(status_code=400, detail="Field 'pdf' is required")

    is_unstructured = provider == "unstructured"
    is_azure_di = provider == "azure-di"
    is_azure_cu = provider == "azure-cu"

    strategy = str(payload.get("strategy") or "auto")
    if is_unstructured:
        if strategy not in {"auto", "fast", "hi_res"}:
            raise HTTPException(status_code=400, detail="strategy must be one of: auto, fast, hi_res")
        if env_true("DISABLE_HI_RES"):
            if strategy in {"auto", "hi_res"}:
                strategy = "fast"
    else:
        strategy = None

    infer_table_structure = bool(payload.get("infer_table_structure", True)) if is_unstructured else True
    chunking = str(payload.get("chunking") or "none") if is_unstructured else "none"
    if is_unstructured and chunking not in {"basic", "by_title", "none"}:
        raise HTTPException(status_code=400, detail="chunking must be one of: basic, by_title, none")

    chunk_max_tokens = payload.get("chunk_max_tokens") if is_unstructured else None
    chunk_max_characters = payload.get("chunk_max_characters") if is_unstructured else None
    chunk_new_after_n_chars = payload.get("chunk_new_after_n_chars") if is_unstructured else None
    chunk_combine_under_n_chars = payload.get("chunk_combine_under_n_chars") if is_unstructured else None
    chunk_overlap = payload.get("chunk_overlap") if is_unstructured else None
    ocr_languages = str(payload.get("ocr_languages") or "eng+ara").strip() or None
    languages_raw = payload.get("languages")
    primary_language = str(payload.get("primary_language") or "eng").strip().lower()
    if primary_language not in {"eng", "ara"}:
        primary_language = "eng"

    azure_model_id = str(payload.get("model_id") or ("prebuilt-layout" if is_azure_di else "prebuilt-documentSearch")).strip()
    azure_api_version = str(payload.get("api_version") or ("2024-11-30" if is_azure_di else "2025-11-01")).strip()
    azure_features_raw = payload.get("features")
    azure_locale = payload.get("locale")
    azure_string_index_type = payload.get("string_index_type")
    azure_output_content_format = payload.get("output_content_format")
    azure_query_fields = payload.get("query_fields")
    analyzer_id = payload.get("analyzer_id")

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

    chunk_include_orig_elements = _coerce_bool("chunk_include_orig_elements") if is_unstructured else None
    chunk_overlap_all = _coerce_bool("chunk_overlap_all") if is_unstructured else None
    chunk_multipage_sections = _coerce_bool("chunk_multipage_sections") if is_unstructured else None
    detect_language_per_element = _coerce_bool("detect_language_per_element") if is_unstructured else False
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

    logger.info("Received run request provider=%s pdf=%s pages=%s", provider, pdf_name, pages)

    slug = input_pdf.stem
    raw_tag = str(payload.get("tag") or "").strip()
    safe_tag = None
    if raw_tag:
        safe_tag = re.sub(r"[^A-Za-z0-9_\\-]+", "-", raw_tag)[:40].strip("-")
    run_slug = f"{slug}__{safe_tag}" if safe_tag else slug
    pages_tag = safe_pages_tag(pages)
    out_dir.mkdir(parents=True, exist_ok=True)

    form_snapshot: Dict[str, Any] = {
        "pdf": pdf_name,
        "pages": pages,
        "tag": raw_tag or None,
        "strategy": strategy,
        "infer_table_structure": infer_table_structure if is_unstructured else None,
        "chunking": chunking if is_unstructured else None,
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
        "provider": provider,
        "model_id": azure_model_id if not is_unstructured else None,
        "api_version": azure_api_version if not is_unstructured else None,
        "features": azure_features_raw,
        "locale": azure_locale,
        "string_index_type": azure_string_index_type,
        "output_content_format": azure_output_content_format,
        "query_fields": azure_query_fields,
        "analyzer_id": analyzer_id,
    }
    payload["form_snapshot"] = form_snapshot

    def build_paths(slug_val: str):
        return (
            out_dir / f"{slug_val}.{pages_tag}.tables.jsonl",
            out_dir / f"{slug_val}.{pages_tag}.matches.json",
            out_dir / f"{slug_val}.{pages_tag}.pdf",
            out_dir / f"{slug_val}.{pages_tag}.chunks.jsonl",
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

    if is_unstructured:
        cmd: List[str] = [
            sys.executable,
            "-m",
            "chunking_pipeline.run_chunking",
            "--input",
            str(input_pdf),
            "--pages",
            pages,
            "--strategy",
            strategy or "auto",
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
    else:
        azure_provider = "document_intelligence" if is_azure_di else "content_understanding"
        cmd = [
            sys.executable,
            "-m",
            "chunking_pipeline.azure_pipeline",
            "--provider",
            azure_provider,
            "--input",
            str(input_pdf),
            "--pages",
            pages,
            "--output",
            str(tables_out),
            "--trimmed-out",
            str(trimmed_out),
            "--emit-matches",
            str(matches_out),
            "--model-id",
            azure_model_id,
            "--api-version",
            azure_api_version,
        ]
        if azure_features_raw:
            if isinstance(azure_features_raw, str):
                cmd += ["--features", azure_features_raw]
            elif isinstance(azure_features_raw, list):
                cmd += ["--features", ",".join(str(x) for x in azure_features_raw)]
        if azure_locale:
            cmd += ["--locale", str(azure_locale)]
        if azure_string_index_type:
            cmd += ["--string-index-type", str(azure_string_index_type)]
        if azure_output_content_format:
            cmd += ["--output-content-format", str(azure_output_content_format)]
        if azure_query_fields:
            cmd += ["--query-fields", str(azure_query_fields)]
        if analyzer_id and is_azure_cu:
            cmd += ["--analyzer-id", str(analyzer_id)]
        if primary_language:
            cmd += ["--primary-language", primary_language]
        if ocr_languages:
            cmd += ["--ocr-languages", ocr_languages]
        if languages:
            cmd += ["--languages", ",".join(languages)]

    logger.info(
        "Submitting run slug=%s provider=%s command=%s",
        f"{run_slug}.{pages_tag}",
        provider,
        " ".join(cmd),
    )

    job_metadata = {
        "slug_with_pages": f"{run_slug}.{pages_tag}",
        "pages_tag": pages_tag,
        "pdf_name": pdf_name,
        "pages": pages,
        "safe_tag": safe_tag,
        "raw_tag": raw_tag,
        "primary_language": primary_language,
        "form_snapshot": payload.get("form_snapshot") or {},
        "tables_path": str(tables_out),
        "trimmed_path": str(trimmed_out),
        "chunk_path": str(chunk_out),
        "provider": provider,
    }
    job = RUN_JOB_MANAGER.enqueue(command=cmd, matches_path=matches_out, metadata=job_metadata)
    job_data = job.to_dict()
    logger.info(
        "Run queued job_id=%s slug=%s provider=%s",
        job_data.get("id"),
        job_metadata["slug_with_pages"],
        provider,
    )
    run_stub = {
        "slug": job_metadata["slug_with_pages"],
        "provider": provider,
        "page_tag": pages_tag,
        "tables_file": relative_to_root(tables_out) if tables_out.exists() else None,
        "pdf_file": relative_to_root(trimmed_out) if trimmed_out.exists() else None,
        "matches_file": relative_to_root(matches_out),
        "chunks_file": relative_to_root(chunk_out) if chunk_out.exists() else None,
    }
    return {"status": "queued", "job": job_data, "run": run_stub}
