from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from openai import OpenAI

from .config import PROVIDERS, get_out_dir, relative_to_root
from .routes.reviews import _summarize_reviews


def _safe_slug_from_path(path: Path) -> str:
    name = path.name[:-len(".reviews.json")] if path.name.endswith(".reviews.json") else path.stem
    return re.sub(r"[^A-Za-z0-9._\\-]+", "-", name)


def _load_review_items(path: Path) -> Dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {}
    items = data.get("items")
    if not isinstance(items, dict):
        return {}
    return items


def _parse_run_metadata(provider: str, slug: str) -> Dict[str, Any]:
    out_dir = get_out_dir(provider)
    meta = {"pdf": None, "pages": None, "tag": None, "run_config": None, "pdf_file": None}
    candidates = [
        out_dir / f"{slug}.run.json",
        out_dir / f"{slug}.pdf",
    ]
    if ".pages" in slug:
        base, _, rest = slug.partition(".pages")
        candidates.insert(0, out_dir / f"{base}.pages{rest}.run.json")
        candidates.append(out_dir / f"{base}.pages{rest}.pdf")
    meta_path = next((p for p in candidates if p.name.endswith(".run.json") and p.exists()), None)
    pdf_path = next((p for p in candidates if p.name.endswith(".pdf") and p.exists()), None)
    if meta_path and meta_path.exists():
        try:
            with meta_path.open("r", encoding="utf-8") as fh:
                cfg = json.load(fh)
            if isinstance(cfg, dict):
                meta["run_config"] = cfg
                snap = cfg.get("form_snapshot") or cfg.get("ui_form") or {}
                meta["pdf"] = snap.get("pdf") or cfg.get("pdf")
                meta["pages"] = snap.get("pages") or cfg.get("pages")
                meta["tag"] = snap.get("tag") or snap.get("variant_tag") or cfg.get("tag") or cfg.get("variant_tag")
        except Exception:
            pass
    if pdf_path and pdf_path.exists():
        meta["pdf_file"] = relative_to_root(pdf_path)
    return meta


def _max_updated_at(items: Iterable[Dict[str, Any]]) -> Optional[str]:
    latest: Optional[datetime] = None
    for item in items:
        ts = item.get("updated_at")
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts)
        except ValueError:
            continue
        if latest is None or dt > latest:
            latest = dt
    return latest.isoformat() if latest else None


def _collect_reviews_for_provider(provider: str) -> List[Dict[str, Any]]:
    out_dir = get_out_dir(provider)
    reviews_dir = out_dir / "reviews"
    runs: List[Dict[str, Any]] = []
    if not reviews_dir.exists():
        return runs
    for path in sorted(reviews_dir.glob("*.reviews.json")):
        slug = _safe_slug_from_path(path)
        items_map = _load_review_items(path)
        items = [v for v in items_map.values() if isinstance(v, dict)]
        summary = _summarize_reviews(items)
        note_count = sum(1 for i in items if i.get("note"))
        last_updated = _max_updated_at(items) or datetime.utcfromtimestamp(path.stat().st_mtime).isoformat()
        meta = _parse_run_metadata(provider, slug)
        runs.append(
            {
                "slug": slug,
                "provider": provider,
                "summary": summary,
                "note_count": note_count,
                "last_updated": last_updated,
                "items": items,
                "pdf": meta.get("pdf"),
                "pages": meta.get("pages"),
                "tag": meta.get("tag"),
                "pdf_file": meta.get("pdf_file"),
            }
        )
    return runs


def collect_feedback_index(provider: Optional[str] = None, include_items: bool = False) -> Dict[str, Any]:
    providers = [provider] if provider else list(PROVIDERS.keys())
    runs: List[Dict[str, Any]] = []
    for prov in providers:
        runs.extend(_collect_reviews_for_provider(prov))
    aggregate = {
        "overall": {"good": 0, "bad": 0, "total": 0},
        "providers": {},
    }
    for run in runs:
        prov = run["provider"]
        aggregate["providers"].setdefault(prov, {"good": 0, "bad": 0, "total": 0, "note_count": 0})
        for key in ("good", "bad", "total"):
            aggregate["overall"][key] += run["summary"]["overall"].get(key, 0)
            aggregate["providers"][prov][key] += run["summary"]["overall"].get(key, 0)
        aggregate["providers"][prov]["note_count"] += run.get("note_count", 0)
        if not include_items:
            run = run.copy()
            run.pop("items", None)
    if not include_items:
        runs = [dict(r, items=None) for r in runs]
    return {"runs": runs, "aggregate": aggregate}


def flatten_notes(runs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    notes: List[Dict[str, Any]] = []
    for run in runs:
        slug = run.get("slug")
        provider = run.get("provider")
        for item in run.get("items") or []:
            if not item:
                continue
            entry = {
                "slug": slug,
                "provider": provider,
                "kind": item.get("kind"),
                "rating": item.get("rating"),
                "note": item.get("note") or "",
                "updated_at": item.get("updated_at"),
                "item_id": item.get("item_id"),
            }
            notes.append(entry)
    return notes


def _llm_client() -> Tuple[OpenAI, str]:
    api_key = os.environ.get("FEEDBACK_LLM_API_KEY") or os.environ.get("OPENAI_API_KEY")
    model = os.environ.get("FEEDBACK_LLM_MODEL") or os.environ.get("OPENAI_MODEL") or "gpt-5-nano"
    base_url = os.environ.get("FEEDBACK_LLM_BASE") or os.environ.get("OPENAI_BASE_URL")
    if not api_key:
        raise RuntimeError("FEEDBACK_LLM_API_KEY is not configured")
    client = OpenAI(api_key=api_key, base_url=base_url)
    return client, model


def _run_chat(messages: List[Dict[str, str]], max_tokens: int = 800) -> str:
    client, model = _llm_client()
    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.2,
        max_tokens=max_tokens,
    )
    return resp.choices[0].message.content or ""


def _chunk_runs_for_llm(runs: List[Dict[str, Any]], max_chars: int = 12_000) -> List[List[Dict[str, Any]]]:
    batches: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    size = 0
    for run in runs:
        payload = json.dumps(run, ensure_ascii=False)
        payload_len = len(payload)
        if current and size + payload_len > max_chars:
            batches.append(current)
            current = []
            size = 0
        current.append(run)
        size += payload_len
    if current:
        batches.append(current)
    return batches


def _summarize_batch(provider: str, runs: List[Dict[str, Any]]) -> Dict[str, Any]:
    prompt = (
        "You are summarizing review feedback for a document chunking tool. "
        "Each run has review items with ratings (good/bad) and optional notes. "
        "Return JSON only with keys: batch_summary (1-2 sentences), runs (array of {slug, key_findings, action_items})."
    )
    content = json.dumps(runs, ensure_ascii=False)
    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": f"Provider: {provider}\nRuns JSON:\n{content}"},
    ]
    raw = _run_chat(messages, max_tokens=600)
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {"batch_summary": raw, "runs": []}


def _summarize_provider(provider: str, runs: List[Dict[str, Any]]) -> Dict[str, Any]:
    batches = _chunk_runs_for_llm(runs)
    batch_summaries: List[Dict[str, Any]] = []
    for batch in batches:
        batch_summaries.append(_summarize_batch(provider, batch))
    aggregate = {
        "provider": provider,
        "runs": [r.get("slug") for r in runs],
        "batches": batch_summaries,
    }
    reducer_prompt = (
        "You received multiple batch summaries for reviews. Combine them into a concise provider summary.\n"
        "Return JSON with keys: provider, overview (2-3 sentences), top_issues (list of strings), recommendations (list of strings)."
    )
    messages = [
        {"role": "system", "content": reducer_prompt},
        {"role": "user", "content": json.dumps(aggregate, ensure_ascii=False)},
    ]
    raw = _run_chat(messages, max_tokens=500)
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {"provider": provider, "overview": raw, "top_issues": [], "recommendations": []}


def analyze_provider_feedback(provider: str, runs: List[Dict[str, Any]]) -> Dict[str, Any]:
    summarized = _summarize_provider(provider, runs)
    return {"provider": provider, "summary": summarized}


def compare_providers(feedback_summaries: List[Dict[str, Any]]) -> Dict[str, Any]:
    reducer_prompt = (
        "Compare provider summaries for a document review system. "
        "Return JSON with keys: comparison (2-3 sentences), rankings (list of {provider, position, rationale}), shared_recos (list of strings)."
    )
    messages = [
        {"role": "system", "content": reducer_prompt},
        {"role": "user", "content": json.dumps(feedback_summaries, ensure_ascii=False)},
    ]
    raw = _run_chat(messages, max_tokens=500)
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {"comparison": raw, "rankings": [], "shared_recos": []}
