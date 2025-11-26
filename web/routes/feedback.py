from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query

from ..config import PROVIDERS
from ..feedback import (
    analyze_provider_feedback,
    collect_feedback_index,
    compare_providers,
    flatten_notes,
    _provider_stats_from_runs,
)
from ..feedback import _collect_reviews_for_provider  # noqa: PLC2701 - internal helper reuse

router = APIRouter()


@router.get("/api/feedback/index")
def api_feedback_index(provider: Optional[str] = Query(default=None), include_items: bool = Query(default=False)) -> Dict[str, Any]:
    if provider and provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail="Unknown provider")
    return collect_feedback_index(provider=provider, include_items=include_items)


@router.get("/api/feedback/runs/{provider}")
def api_feedback_runs(provider: str, include_items: bool = Query(default=True)) -> Dict[str, Any]:
    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail="Unknown provider")
    runs = _collect_reviews_for_provider(provider)
    payload = {"provider": provider, "runs": runs}
    if not include_items:
        payload["runs"] = [dict(r, items=None) for r in runs]
    payload["note_count"] = sum(r.get("note_count", 0) for r in runs)
    return payload


@router.post("/api/feedback/analyze/provider")
def api_feedback_analyze_provider(payload: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")
    provider = str(payload.get("provider") or "").strip()
    if not provider:
        raise HTTPException(status_code=400, detail="provider is required")
    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail="Unknown provider")
    runs = _collect_reviews_for_provider(provider)
    if not runs:
        raise HTTPException(status_code=404, detail="No reviews for provider")
    try:
        summary = analyze_provider_feedback(provider, runs)
    except RuntimeError as e:  # missing key/model
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "provider": provider,
        "run_count": len(runs),
        "note_count": sum(r.get("note_count", 0) for r in runs),
        "summary": summary,
    }


@router.post("/api/feedback/analyze/compare")
def api_feedback_compare(payload: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")
    providers = payload.get("providers")
    provider_list: List[str]
    if providers is None:
        provider_list = list(PROVIDERS.keys())
    elif isinstance(providers, str):
        provider_list = [providers]
    elif isinstance(providers, (list, tuple)):
        provider_list = [str(p) for p in providers]
    else:
        raise HTTPException(status_code=400, detail="providers must be a list or string")
    for prov in provider_list:
        if prov not in PROVIDERS:
            raise HTTPException(status_code=400, detail=f"Unknown provider: {prov}")

    provider_entries: List[Dict[str, Any]] = []
    total_runs = 0
    total_notes = 0
    try:
        for prov in provider_list:
            runs = _collect_reviews_for_provider(prov)
            total_runs += len(runs)
            total_notes += sum(r.get("note_count", 0) for r in runs)
            if not runs:
                continue
            stats = _provider_stats_from_runs(runs)
            provider_summary = analyze_provider_feedback(prov, runs)
            entry = {
                "provider": prov,
                "summary": provider_summary.get("summary") if isinstance(provider_summary, dict) else provider_summary,
                "stats": stats,
            }
            provider_entries.append(entry)
        if provider_entries:
            comparison = compare_providers(provider_entries)
        else:
            comparison = {"comparison": "No providers with feedback to compare", "rankings": [], "shared_recos": []}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "providers": provider_list,
        "run_count": total_runs,
        "note_count": total_notes,
        "summaries": provider_entries,
        "comparison": comparison,
    }


@router.get("/api/feedback/export")
def api_feedback_export(
    provider: Optional[str] = Query(default=None),
    include_items: bool = Query(default=True),
) -> Dict[str, Any]:
    if provider and provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail="Unknown provider")
    data = collect_feedback_index(provider=provider, include_items=include_items)
    data["notes"] = flatten_notes(data.get("runs") or [])
    return data
