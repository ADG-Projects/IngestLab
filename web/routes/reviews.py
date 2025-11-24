from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query

from ..config import DEFAULT_PROVIDER, get_out_dir

router = APIRouter()


def review_file_path(slug: str, provider: str = DEFAULT_PROVIDER) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._\\-]+", "-", slug or "").strip(".-_")
    if not safe:
        raise HTTPException(status_code=400, detail="Invalid slug for reviews")
    base = get_out_dir(provider) / "reviews"
    base.mkdir(parents=True, exist_ok=True)
    return base / f"{safe}.reviews.json"


def _load_reviews(slug: str, provider: str) -> Dict[str, Dict[str, Any]]:
    path = review_file_path(slug, provider=provider)
    if not path.exists():
        return {"slug": slug, "items": {}, "provider": provider}
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {"slug": slug, "items": {}, "provider": provider}
    items = data.get("items")
    if not isinstance(items, dict):
        items = {}
    return {"slug": slug, "items": items, "provider": provider}


def _save_reviews(slug: str, items: Dict[str, Any], provider: str) -> None:
    path = review_file_path(slug, provider=provider)
    payload = {"slug": slug, "items": items, "provider": provider}
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    tmp.replace(path)


def _summarize_reviews(items: List[Dict[str, Any]]) -> Dict[str, Dict[str, int]]:
    summary = {
        "overall": {"good": 0, "bad": 0, "total": 0},
        "chunks": {"good": 0, "bad": 0, "total": 0},
        "elements": {"good": 0, "bad": 0, "total": 0},
    }
    for item in items:
        if not item:
            continue
        rating = (item.get("rating") or "").lower()
        kind = (item.get("kind") or "").lower()
        if rating not in {"good", "bad"}:
            continue
        summary["overall"][rating] += 1
        summary["overall"]["total"] += 1
        target = summary["chunks" if kind == "chunk" else "elements"]
        target[rating] += 1
        target["total"] += 1
    return summary


def _format_reviews(slug: str, items_map: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    items = list(items_map.values())
    return {"slug": slug, "items": items, "summary": _summarize_reviews(items)}


def _normalize_kind(value: Any) -> str:
    txt = str(value or "").strip().lower()
    if txt not in {"chunk", "element"}:
        raise HTTPException(status_code=400, detail="kind must be 'chunk' or 'element'")
    return txt


def _normalize_rating(value: Any) -> Optional[str]:
    if value is None:
        return None
    txt = str(value).strip().lower()
    if not txt:
        return None
    if txt not in {"good", "bad"}:
        raise HTTPException(status_code=400, detail="rating must be 'good' or 'bad'")
    return txt


def _normalize_note(value: Any) -> str:
    if value is None:
        return ""
    txt = str(value).strip()
    if len(txt) > 2000:
        raise HTTPException(status_code=400, detail="note must be 2000 characters or fewer")
    return txt


@router.get("/api/reviews/{slug}")
def api_get_reviews(slug: str, provider: str = Query(default=None)) -> Dict[str, Any]:
    stored = _load_reviews(slug, provider or DEFAULT_PROVIDER)
    return _format_reviews(slug, stored.get("items") or {})


@router.post("/api/reviews/{slug}")
def api_update_review(slug: str, payload: Dict[str, Any], provider: str = Query(default=None)) -> Dict[str, Any]:
    provider_key = provider or DEFAULT_PROVIDER
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")
    stored = _load_reviews(slug, provider_key)
    items = stored.get("items") or {}

    kind = _normalize_kind(payload.get("kind"))
    item_id = str(payload.get("item_id") or "").strip()
    if not item_id:
        raise HTTPException(status_code=400, detail="item_id is required")
    rating = _normalize_rating(payload.get("rating"))
    note = _normalize_note(payload.get("note"))
    if rating is None and note:
        raise HTTPException(status_code=400, detail="rating is required when providing a note")

    key = f"{kind}:{item_id}"
    if rating is None:
        items.pop(key, None)
        if items:
            _save_reviews(slug, items, provider_key)
        else:
            path = review_file_path(slug, provider_key)
            if path.exists():
                try:
                    path.unlink()
                except OSError:
                    pass
        return {"status": "ok", "review": None, "reviews": _format_reviews(slug, items)}

    review = {
        "slug": slug,
        "kind": kind,
        "item_id": item_id,
        "rating": rating,
        "note": note,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    items[key] = review
    _save_reviews(slug, items, provider_key)
    return {"status": "ok", "review": review, "reviews": _format_reviews(slug, items)}
