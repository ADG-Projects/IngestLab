from __future__ import annotations

import json
import os
import re
from datetime import datetime
import logging
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from openai import OpenAI, OpenAIError

from .config import PROVIDERS, get_out_dir, relative_to_root
from .routes.reviews import _summarize_reviews
from .routes.elements import _ensure_index
from .file_utils import resolve_slug_file

logger = logging.getLogger("chunking.feedback")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("[feedback] %(asctime)s %(levelname)s: %(message)s"))
    logger.addHandler(handler)
logger.setLevel(logging.INFO)
logger.propagate = False


def _smoothed_good_rate(good: int, bad: int, prior_good: int = 3, prior_bad: int = 3) -> Optional[float]:
    total = (good or 0) + (bad or 0)
    denom = total + prior_good + prior_bad
    if denom <= 0:
        return None
    return (good + prior_good) / denom


def _score_from_counts(good: int, bad: int) -> Optional[int]:
    rate = _smoothed_good_rate(good, bad)
    if rate is None:
        return None
    return round(rate * 100)


def _confidence_label(total: int) -> str:
    if total >= 100:
        return "high"
    if total >= 20:
        return "medium"
    if total > 0:
        return "low"
    return "-"


def _looks_like_json_container(text: str) -> bool:
    if not isinstance(text, str):
        return False
    t = text.strip()
    return (t.startswith("{") and t.endswith("}")) or (t.startswith("[") and t.endswith("]"))


def _maybe_unstringify(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _maybe_unstringify(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_maybe_unstringify(v) for v in obj]
    if isinstance(obj, str) and _looks_like_json_container(obj):
        try:
            parsed = json.loads(obj)
        except Exception:
            return obj
        return _maybe_unstringify(parsed)
    return obj


def _parse_llm_json(raw: str) -> Optional[Dict[str, Any]]:
    try:
        parsed = json.loads(raw)
    except Exception:
        return None
    if isinstance(parsed, str) and _looks_like_json_container(parsed):
        try:
            parsed = json.loads(parsed)
        except Exception:
            return None
    if isinstance(parsed, dict):
        return _maybe_unstringify(parsed)
    return None


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


def _enrich_runs_with_element_metadata(provider: str, runs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    enriched: List[Dict[str, Any]] = []
    for run in runs:
        slug = run.get("slug") or ""
        items = run.get("items") or []
        by_id: Dict[str, Dict[str, Any]] = {}
        try:
            idx = _ensure_index(slug, provider)
            by_id = idx.get("by_id", {})
        except Exception:
            by_id = {}
        wanted_ids = [item.get("item_id") for item in items if item.get("item_id")]
        snippets = _load_element_snippets(slug, provider, wanted_ids)
        run_copy = dict(run)
        enriched_items: List[Dict[str, Any]] = []
        for item in items:
            meta = by_id.get(item.get("item_id")) or {}
            enriched_items.append(
                {
                    **item,
                    "element_type": meta.get("type"),
                    "page": meta.get("page_trimmed"),
                    "text_snippet": snippets.get(item.get("item_id")),
                }
            )
        run_copy["items"] = enriched_items
        enriched.append(run_copy)
    return enriched


def _normalize_text_snippet(text: str, max_len: int = 220) -> str:
    if not text:
        return ""
    snippet = re.sub(r"\s+", " ", text).strip()
    if len(snippet) > max_len:
        snippet = snippet[: max_len - 1].rstrip() + "…"
    return snippet


def _load_element_snippets(slug: str, provider: str, item_ids: List[str]) -> Dict[str, str]:
    wanted = {i for i in item_ids if i}
    if not wanted:
        return {}
    snippets: Dict[str, str] = {}
    try:
        path = resolve_slug_file(slug, "{slug}.pages*.elements.jsonl", provider=provider)
    except Exception:
        return {}
    try:
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
                md = obj.get("metadata") or {}
                if element_id not in wanted and md.get("original_element_id") not in wanted:
                    continue
                text = obj.get("text") or md.get("text") or ""
                if not text:
                    html = md.get("text_as_html") or ""
                    if html:
                        text = re.sub(r"<[^>]+>", " ", html)
                snippet = _normalize_text_snippet(text)
                target_id = element_id if element_id in wanted else md.get("original_element_id")
                if target_id:
                    snippets[target_id] = snippet
                if snippets.keys() >= wanted:
                    break
    except Exception:
        return snippets
    return snippets


def collect_feedback_index(provider: Optional[str] = None, include_items: bool = False) -> Dict[str, Any]:
    providers = [provider] if provider else list(PROVIDERS.keys())
    runs: List[Dict[str, Any]] = []
    for prov in providers:
        runs.extend(_collect_reviews_for_provider(prov))
    aggregate = {
        "overall": {"good": 0, "bad": 0, "total": 0, "score": None, "confidence": "-"},
        "providers": {},
    }
    for run in runs:
        prov = run["provider"]
        aggregate["providers"].setdefault(
            prov, {"good": 0, "bad": 0, "total": 0, "note_count": 0, "score": None, "confidence": "-"}
        )
        for key in ("good", "bad", "total"):
            aggregate["overall"][key] += run["summary"]["overall"].get(key, 0)
            aggregate["providers"][prov][key] += run["summary"]["overall"].get(key, 0)
        aggregate["providers"][prov]["note_count"] += run.get("note_count", 0)
        if not include_items:
            run = run.copy()
            run.pop("items", None)
    for prov, stats in aggregate["providers"].items():
        stats["score"] = _score_from_counts(stats.get("good", 0), stats.get("bad", 0))
        stats["confidence"] = _confidence_label(stats.get("total", 0))
    aggregate["overall"]["score"] = _score_from_counts(aggregate["overall"]["good"], aggregate["overall"]["bad"])
    aggregate["overall"]["confidence"] = _confidence_label(aggregate["overall"]["total"])
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


def _provider_stats_from_runs(runs: List[Dict[str, Any]]) -> Dict[str, Any]:
    stats = {"good": 0, "bad": 0, "total": 0, "note_count": 0, "score": None, "confidence": "-"}
    for run in runs:
        summary = (run.get("summary") or {}).get("overall") or {}
        stats["good"] += summary.get("good", 0)
        stats["bad"] += summary.get("bad", 0)
        stats["total"] += summary.get("total", 0)
        stats["note_count"] += run.get("note_count", 0)
    stats["score"] = _score_from_counts(stats["good"], stats["bad"])
    stats["confidence"] = _confidence_label(stats["total"])
    return stats


def _llm_client() -> Tuple[OpenAI, str]:
    api_key = os.environ.get("FEEDBACK_LLM_API_KEY") or os.environ.get("OPENAI_API_KEY")
    model = os.environ.get("FEEDBACK_LLM_MODEL") or os.environ.get("OPENAI_MODEL") or "gpt-5-nano"
    base_url = os.environ.get("FEEDBACK_LLM_BASE") or os.environ.get("OPENAI_BASE_URL")
    if not api_key:
        raise RuntimeError("FEEDBACK_LLM_API_KEY is not configured")
    if str(api_key).lower().startswith("gpt-"):
        raise RuntimeError("FEEDBACK_LLM_API_KEY looks like a model name; set the actual API key and put the model in FEEDBACK_LLM_MODEL")
    client = OpenAI(api_key=api_key, base_url=base_url)
    return client, model


def _run_chat(messages: List[Dict[str, str]], max_tokens: int = 800) -> str:
    client, model = _llm_client()
    use_responses_api = model.startswith(("gpt-5", "gpt-4.1"))

    def _extract_response_text(resp: Any) -> str:
        try:
            txt = getattr(resp, "output_text", None)
            if isinstance(txt, str) and txt.strip():
                return txt
        except Exception:
            pass

        outputs = None
        if hasattr(resp, "output"):
            outputs = getattr(resp, "output")
        elif isinstance(resp, dict):
            outputs = resp.get("output")

        texts: List[str] = []

        def _maybe_add(val: Optional[str]) -> None:
            if val:
                texts.append(val)

        def _extract_text_from_item(item: Any) -> None:
            item_type = getattr(item, "type", None) if not isinstance(item, dict) else item.get("type")
            if item_type == "message":
                content = getattr(item, "content", None) if not isinstance(item, dict) else item.get("content")
                if not content:
                    return
                for block in content:
                    block_type = getattr(block, "type", None) if not isinstance(block, dict) else block.get("type")
                    if block_type in {"output_text", "text"}:
                        _maybe_add(getattr(block, "text", None) if not isinstance(block, dict) else block.get("text"))
                    elif block_type == "refusal":
                        reason = getattr(block, "refusal", None) if not isinstance(block, dict) else block.get("refusal") or block.get("text")
                        if reason:
                            _maybe_add(f"Refusal: {reason}")
            elif item_type == "reasoning":
                summary = getattr(item, "summary", None) if not isinstance(item, dict) else item.get("summary")
                if summary:
                    for s in summary:
                        _maybe_add(getattr(s, "text", None) if not isinstance(s, dict) else s.get("text"))
                content = getattr(item, "content", None) if not isinstance(item, dict) else item.get("content")
                if content:
                    for c in content:
                        _maybe_add(getattr(c, "text", None) if not isinstance(c, dict) else c.get("text"))

        if outputs:
            try:
                for item in outputs:
                    _extract_text_from_item(item)
            except Exception:
                pass

        if texts:
            return "".join(texts)

        if isinstance(resp, dict):
            fallback = resp.get("output_text") or resp.get("text")
            if isinstance(fallback, str) and fallback.strip():
                return fallback
        return ""

    def _to_response_input(msgs: List[Dict[str, str]]) -> List[Dict[str, Any]]:
        formatted: List[Dict[str, Any]] = []
        for m in msgs:
            role = m.get("role", "user")
            content = m.get("content", "")
            if isinstance(content, str):
                content_blocks = [{"type": "input_text", "text": content}]
            elif isinstance(content, list):
                # Pass through with type adjustments if needed
                content_blocks = []
                for part in content:
                    if isinstance(part, dict):
                        ctype = part.get("type") or "input_text"
                        text_val = part.get("text") or ""
                        if ctype == "text":
                            ctype = "input_text"
                        content_blocks.append({"type": ctype, "text": text_val})
                    else:
                        content_blocks.append({"type": "input_text", "text": str(part)})
            else:
                content_blocks = [{"type": "input_text", "text": str(content)}]
            formatted.append({"role": role, "content": content_blocks})
        return formatted

    try:
        if use_responses_api:
            logger.info("LLM request (responses API)", extra={"model": model, "messages": len(messages)})
            resp = client.responses.create(
                model=model,
                input=_to_response_input(messages),
                max_output_tokens=max_tokens,
                reasoning={"effort": "low"},
            )
            text = _extract_response_text(resp)
            if text:
                return text
            status = getattr(resp, "status", None)
            logger.error("LLM responses API returned empty text", extra={"model": model, "status": status})
            raise RuntimeError("LLM returned empty response")
        logger.info("LLM request (chat completions)", extra={"model": model, "messages": len(messages), "max_tokens": max_tokens})
        params: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": 0.2,
        }
        if model.startswith(("gpt-4.1", "gpt-5")):
            params["max_completion_tokens"] = max_tokens
        else:
            params["max_tokens"] = max_tokens
        resp = client.chat.completions.create(**params)
    except OpenAIError as e:
        logger.error("LLM call failed", exc_info=e)
        raise RuntimeError(f"LLM call failed: {e}") from e
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
        "Each run has review items with ratings (good/bad), element_type (table/paragraph/header/etc.), page number, optional notes, and a text_snippet. "
        "Refer to reviewed units as elements (even when kind is 'chunk'). "
        "Only use information that is explicitly present in the notes or text_snippet; do not guess technical root causes (like OCR/encoding issues) unless they are clearly mentioned. "
        "Respond with a single JSON object with keys: batch_summary (1-2 sentences) and runs (array). "
        "Each runs[i] object MUST include: slug (string), key_findings (list of strings), action_items (list of strings). "
        "You MAY also include optional fields on runs[i]: "
        "element_type_findings (list of {type, strengths, weaknesses}), "
        "bad_element_suggestions (list of {item_id, element_type, page, text_snippet, machine_note, issue_tags, severity}), "
        "issue_taxonomy (list of {type, severity, evidence}), review_gaps (list of strings). "
        "Severity is low/medium/high. issue_tags are short codes like missing_headers, split_sentences, ocr_noise, boundary_cutoff. "
        "Machine_note should be concise, ready-to-paste guidance for that element. "
        "If the reason for a bad rating is unclear from the data, say so explicitly and add a review_gaps entry instead of inventing an explanation."
    )
    logger.info(
        "Summarizing feedback batch",
        extra={"provider": provider, "run_count": len(runs), "item_count": sum(len(r.get('items') or []) for r in runs)},
    )
    enriched_runs = _enrich_runs_with_element_metadata(provider, runs)
    content = json.dumps(enriched_runs, ensure_ascii=False)
    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": f"Provider: {provider}\nRuns JSON:\n{content}"},
    ]
    raw = _run_chat(messages, max_tokens=600)
    parsed = _parse_llm_json(raw)
    if isinstance(parsed, dict):
        return parsed
    return {"batch_summary": raw, "runs": []}


def _summarize_provider(provider: str, runs: List[Dict[str, Any]]) -> Dict[str, Any]:
    logger.info(
        "Reducing provider feedback",
        extra={
            "provider": provider,
            "run_count": len(runs),
            "item_count": sum(len(r.get("items") or []) for r in runs),
        },
    )
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
        "You received multiple batch summaries for reviews. Combine them into a concise provider summary. "
        "Discuss patterns across elements (tables, paragraphs, headers, etc.). "
        "Respond with a single JSON object with keys: provider, overview (2-3 sentences), top_issues (list of strings), recommendations (list of strings). "
        "You MAY also include: element_type_findings (list of {type, strengths, weaknesses}), "
        "issue_taxonomy (list of {type, severity, evidence}), review_gaps (list of strings), "
        "scores (object with integer 1-10 fields: overall, actionability, explanations, coverage). "
        "Severity is low/medium/high. "
        "Do not infer specific technical root causes (like OCR/encoding misconfiguration) unless batch summaries or notes clearly describe them; "
        "when reasons are unclear, highlight missing reviewer detail in review_gaps instead of speculating. "
        "Keep content concise and actionable."
    )
    messages = [
        {"role": "system", "content": reducer_prompt},
        {"role": "user", "content": json.dumps(aggregate, ensure_ascii=False)},
    ]
    raw = _run_chat(messages, max_tokens=500)
    parsed = _parse_llm_json(raw)
    if isinstance(parsed, dict):
        return parsed
    return {"provider": provider, "overview": raw, "top_issues": [], "recommendations": []}


def analyze_provider_feedback(provider: str, runs: List[Dict[str, Any]]) -> Dict[str, Any]:
    summarized = _summarize_provider(provider, runs)
    return {"provider": provider, "summary": summarized}


def compare_providers(providers_payload: List[Dict[str, Any]]) -> Dict[str, Any]:
    reducer_prompt = (
        "Compare provider feedback for a document review system. Input includes per-provider stats "
        "(good/bad/total counts, smoothed score 0-100, confidence label, note_count) and their summaries. "
        "Respond with a single JSON object with keys: comparison (2-3 sentences), rankings (list), shared_recos (list of strings), review_gaps (list of strings). "
        "Each rankings[i] object MUST include: provider (string), position (1=best, then 2,3,...), overall_score (integer 1-10), rationale (string). "
        "You MAY also include on rankings[i]: scores (object with integer 1-10 fields actionability, explanations, coverage) and dominant_issue_types (short list of issue code strings). "
        "overall_score reflects how actionable and specific the feedback is (not the smoothed score). "
        "Favor providers with clearer explanations, actionable notes, and helpful context; use stats to break ties. "
        "Do not invent technical failure modes (like encoding/OCR bugs) that are not clearly supported by the summaries; "
        "when information is missing, say that it is uncertain rather than guessing."
    )
    messages = [
        {"role": "system", "content": reducer_prompt},
        {"role": "user", "content": json.dumps(providers_payload, ensure_ascii=False)},
    ]
    raw = _run_chat(messages, max_tokens=500)
    parsed = _parse_llm_json(raw)
    if isinstance(parsed, dict):
        return parsed
    return {"comparison": raw, "rankings": [], "shared_recos": []}
