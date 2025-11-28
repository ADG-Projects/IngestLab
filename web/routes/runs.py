from __future__ import annotations

import json
import logging
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Query

from ..config import (
    DEFAULT_PROVIDER,
    PROVIDERS,
    RES_DIR,
    get_out_dir,
    env_true,
    relative_to_root,
    safe_pages_tag,
)
from ..run_jobs import RUN_JOB_MANAGER
from .reviews import review_file_path
from .elements import clear_index_cache

router = APIRouter()
logger = logging.getLogger("chunking.routes.runs")


def _parse_slug_from_elements(path: Path) -> Tuple[str, Optional[str]]:
    """Parse slug and page range from an elements file path."""
    stem = path.name[:-len(".elements.jsonl")] if path.name.endswith(".elements.jsonl") else path.stem
    m = re.match(r"^(?P<slug>.+?)\.pages(?P<range>[0-9_\-,]+)$", stem)
    if not m:
        return stem, None
    return f"{m.group('slug')}.pages{m.group('range')}", m.group("range")


def discover_runs(provider: Optional[str] = None) -> List[Dict[str, Any]]:
    runs: List[Dict[str, Any]] = []
    provider_keys = [provider] if provider else list(PROVIDERS.keys())
    for prov in provider_keys:
        out_dir = get_out_dir(prov)
        if not out_dir.exists():
            continue
        elements_files = sorted(out_dir.glob("*.elements.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        for elements_file in elements_files:
            ui_slug, page_tag = _parse_slug_from_elements(elements_file)
            base_stem = elements_file.name[:-len(".elements.jsonl")]
            pdf_path = out_dir / f"{base_stem}.pdf"
            meta_path = out_dir / f"{base_stem}.run.json"
            chunks_path = out_dir / f"{base_stem}.chunks.jsonl"
            page_range = (page_tag or "").replace("_", ",") or None
            run_config: Dict[str, Any] = {}
            if meta_path.exists():
                try:
                    with meta_path.open("r", encoding="utf-8") as fh:
                        run_config = json.load(fh)
                except json.JSONDecodeError:
                    run_config = {}
            runs.append(
                {
                    "slug": ui_slug,
                    "provider": prov,
                    "pdf_file": relative_to_root(pdf_path) if pdf_path.exists() else None,
                    "page_range": page_range,
                    "elements_file": relative_to_root(elements_file),
                    "chunks_file": relative_to_root(chunks_path) if chunks_path.exists() else None,
                    "run_config": run_config or None,
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
    patterns = [f"{slug}.elements.jsonl", f"{slug}.chunks.jsonl", f"{slug}.pdf", f"{slug}.run.json"]
    if ".pages" in slug:
        base, _, rest = slug.partition(".pages")
        patterns.append(f"{base}.pages{rest}.elements.jsonl")
        patterns.append(f"{base}.pages{rest}.chunks.jsonl")
        patterns.append(f"{base}.pages{rest}.pdf")
        patterns.append(f"{base}.pages{rest}.run.json")
    for globpat in patterns:
        for p in out_dir.glob(globpat):
            if p.exists():
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
    is_unstructured_partition = provider == "unstructured-partition"
    is_azure_di = provider == "azure-di"

    strategy = str(payload.get("strategy") or "auto")
    allowed_partition_strategies = {"auto", "fast", "hi_res", "ocr_only", "vlm"}
    allowed_unstructured_strategies = {"auto", "fast", "hi_res"}
    if is_unstructured:
        if strategy not in allowed_unstructured_strategies:
            raise HTTPException(status_code=400, detail=f"strategy must be one of: {', '.join(sorted(allowed_unstructured_strategies))}")
        if env_true("DISABLE_HI_RES") and strategy in {"auto", "hi_res"}:
            strategy = "fast"
    elif is_unstructured_partition:
        if strategy not in allowed_partition_strategies:
            raise HTTPException(status_code=400, detail=f"strategy must be one of: {', '.join(sorted(allowed_partition_strategies))}")
        if env_true("DISABLE_HI_RES") and strategy in {"auto", "hi_res"}:
            strategy = "fast"
    else:
        strategy = None

    infer_table_structure = bool(payload.get("infer_table_structure", True)) if is_unstructured else True
    # All providers now output elements only; chunking is done via separate custom chunker
    chunking = "none"
    ocr_languages = str(payload.get("ocr_languages") or "eng+ara").strip() or None
    languages_raw = payload.get("languages")
    primary_language = str(payload.get("primary_language") or "eng").strip().lower()
    if primary_language not in {"eng", "ara"}:
        primary_language = "eng"

    azure_model_id: Optional[str] = None
    azure_features_raw = None
    azure_outputs_raw = None
    azure_locale = None
    azure_string_index_type = None
    azure_output_content_format = None
    azure_query_fields = None
    if is_azure_di:
        azure_model_id = str(payload.get("model_id") or "prebuilt-layout").strip()
        azure_features_raw = payload.get("features")
        azure_outputs_raw = payload.get("outputs")
        azure_locale = payload.get("locale")
        azure_string_index_type = payload.get("string_index_type")
        azure_output_content_format = payload.get("output_content_format")
        azure_query_fields = payload.get("query_fields")

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

    def _normalize_feature_list(value: Any) -> Optional[List[str]]:
        if value is None:
            return None
        items: List[str] = []
        if isinstance(value, str):
            parts = value.split(",")
        elif isinstance(value, (list, tuple, set)):
            parts = value
        else:
            raise HTTPException(status_code=400, detail="features/outputs must be a list or comma-separated string")
        for part in parts:
            txt = str(part).strip()
            if txt:
                items.append(txt)
        return items or None

    languages = _normalize_languages(languages_raw)
    features_list = _normalize_feature_list(azure_features_raw) or []
    outputs_list = _normalize_feature_list(azure_outputs_raw) or []
    for feat in features_list:
        if feat.lower() == "figures":
            outputs_list.append("figures")
    seen_feats: set = set()
    normalized_features: List[str] = []
    for feat in features_list:
        key = feat.lower()
        if key == "figures" or key in seen_feats:
            continue
        seen_feats.add(key)
        normalized_features.append(feat)
    seen_outputs: set = set()
    normalized_outputs: List[str] = []
    for out in outputs_list:
        key = out.lower()
        if key in seen_outputs:
            continue
        seen_outputs.add(key)
        normalized_outputs.append(out)

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

    detect_language_per_element = _coerce_bool("detect_language_per_element") if is_unstructured else False
    if detect_language_per_element is None:
        detect_language_per_element = False
    extract_image_block_types = _normalize_feature_list(payload.get("extract_image_block_types")) if is_unstructured_partition else None
    extract_image_block_to_payload = _coerce_bool("extract_image_block_to_payload") if is_unstructured_partition else None
    if is_unstructured_partition and extract_image_block_to_payload and not extract_image_block_types:
        extract_image_block_types = ["Image"]

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
        "ocr_languages": ocr_languages,
        "languages": languages,
        "detect_language_per_element": detect_language_per_element,
        "primary_language": primary_language,
        "provider": provider,
        "model_id": azure_model_id if is_azure_di else None,
        "features": (normalized_features or azure_features_raw) if is_azure_di else None,
        "outputs": (normalized_outputs or azure_outputs_raw) if is_azure_di else None,
        "locale": azure_locale if is_azure_di else None,
        "string_index_type": azure_string_index_type if is_azure_di else None,
        "output_content_format": azure_output_content_format if is_azure_di else None,
        "query_fields": azure_query_fields if is_azure_di else None,
        "analyzer_id": None,
        "extract_image_block_types": extract_image_block_types if is_unstructured_partition else None,
        "extract_image_block_to_payload": extract_image_block_to_payload if is_unstructured_partition else None,
    }
    payload["form_snapshot"] = form_snapshot

    def build_paths(slug_val: str):
        return (
            out_dir / f"{slug_val}.{pages_tag}.pdf",
            out_dir / f"{slug_val}.{pages_tag}.elements.jsonl",
            out_dir / f"{slug_val}.{pages_tag}.run.json",
        )

    trimmed_out, elements_out, meta_out = build_paths(run_slug)

    if trimmed_out.exists() or elements_out.exists():
        n = 2
        base_variant = run_slug
        while True:
            candidate = f"{base_variant}__r{n}"
            p_out, e_out, m_out = build_paths(candidate)
            if not (e_out.exists() or p_out.exists()):
                run_slug = candidate
                trimmed_out, elements_out, meta_out = p_out, e_out, m_out
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
            "--trimmed-out",
            str(trimmed_out),
            "--elements-output",
            str(elements_out),
        ]
        if not infer_table_structure:
            cmd.append("--no-infer-table-structure")
        # Always use --chunking none; custom chunking done separately
        cmd += ["--chunking", "none"]
        if ocr_languages:
            cmd += ["--ocr-languages", ocr_languages]
        if languages:
            cmd += ["--languages", ",".join(languages)]
        if detect_language_per_element:
            cmd.append("--detect-language-per-element")
        if primary_language:
            cmd += ["--primary-language", primary_language]
    elif is_unstructured_partition:
        cmd = [
            sys.executable,
            "-m",
            "chunking_pipeline.unstructured_partition_pipeline",
            "--input",
            str(input_pdf),
            "--pages",
            pages,
            "--strategy",
            strategy or "auto",
            "--trimmed-out",
            str(trimmed_out),
            "--elements-output",
            str(elements_out),
            "--run-metadata-out",
            str(meta_out),
        ]
        if languages:
            cmd += ["--languages", ",".join(languages)]
        if extract_image_block_types:
            cmd += ["--extract-image-block-types", ",".join(extract_image_block_types)]
        if extract_image_block_to_payload is True:
            cmd.append("--extract-image-block-to-payload")
    else:
        azure_provider = "document_intelligence"
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
            "--trimmed-out",
            str(trimmed_out),
            "--output",
            str(elements_out),
            "--model-id",
            azure_model_id,
        ]
        if normalized_features:
            cmd += ["--features", ",".join(normalized_features)]
        if normalized_outputs:
            cmd += ["--outputs", ",".join(normalized_outputs)]
        if azure_locale:
            cmd += ["--locale", str(azure_locale)]
        if azure_string_index_type:
            cmd += ["--string-index-type", str(azure_string_index_type)]
        if azure_output_content_format:
            cmd += ["--output-content-format", str(azure_output_content_format)]
        if azure_query_fields:
            if isinstance(azure_query_fields, (list, tuple)):
                cmd += ["--query-fields", ",".join(str(x) for x in azure_query_fields)]
            else:
                cmd += ["--query-fields", str(azure_query_fields)]
        cmd += ["--run-metadata-out", str(meta_out)]
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
        "trimmed_path": str(trimmed_out),
        "elements_path": str(elements_out),
        "meta_path": str(meta_out),
        "provider": provider,
    }
    job = RUN_JOB_MANAGER.enqueue(command=cmd, metadata=job_metadata)
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
        "pdf_file": relative_to_root(trimmed_out) if trimmed_out.exists() else None,
        "elements_file": relative_to_root(elements_out) if elements_out.exists() else None,
        "chunks_file": None,  # Chunks created separately by chunker
        "run_config": job_metadata.get("form_snapshot"),
    }
    return {"status": "queued", "job": job_data, "run": run_stub}
