from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from unstructured.partition.pdf import partition_pdf
from unstructured.chunking.basic import chunk_elements  # type: ignore
from unstructured.chunking.title import chunk_by_title  # type: ignore

from .pages import slice_pdf
from .chunker import ensure_stable_element_id, apply_coordinates_to_chunk
from .matcher import load_gold, compute_table_match_cohesion


def partition_document(input_pdf: str, pages: List[int], strategy: str, infer_table_structure: bool, trimmed_out: Optional[str]) -> Tuple[str, List[Any], List[Dict[str, Any]]]:
    trimmed = slice_pdf(input_pdf, pages, trimmed_out)
    elements = partition_pdf(
        filename=trimmed,
        strategy=strategy,
        include_page_breaks=False,
        infer_table_structure=infer_table_structure,
    )
    dict_elements = [el.to_dict() for el in elements]
    for el in dict_elements:
        ensure_stable_element_id(el)
    return trimmed, elements, dict_elements


def run_chunking(strategy: str, elements: List[Any], chunk_params: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    strategy_map = {
        "basic": (chunk_elements, {"include_orig_elements", "max_characters", "new_after_n_chars", "overlap", "overlap_all"}),
        "by_title": (
            chunk_by_title,
            {
                "include_orig_elements",
                "max_characters",
                "new_after_n_chars",
                "overlap",
                "overlap_all",
                "combine_text_under_n_chars",
                "multipage_sections",
            },
        ),
    }
    if strategy not in strategy_map:
        raise ValueError(f"Unsupported chunking strategy: {strategy}")
    chunk_fn, allowed_keys = strategy_map[strategy]
    chunk_kwargs = {k: v for k, v in chunk_params.items() if k in allowed_keys}
    chunks = chunk_fn(elements, **chunk_kwargs)
    chunk_dicts = [c.to_dict() for c in chunks]
    lengths = []
    for ch in chunk_dicts:
        ensure_stable_element_id(ch)
        apply_coordinates_to_chunk(ch)
        lengths.append(len(ch.get("text") or ""))
    summary = {}
    if lengths:
        summary = {
            "count": len(lengths),
            "total_chars": sum(lengths),
            "min_chars": min(lengths),
            "max_chars": max(lengths),
            "avg_chars": sum(lengths) / len(lengths),
        }
    return chunk_dicts, summary


def match_tables_to_gold(match_elements: List[Dict[str, Any]], pages: List[int], gold_path: Optional[str], input_pdf: str, doc_id: Optional[str]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    if not gold_path:
        return {}, []
    doc, gold_tables = load_gold(gold_path, input_pdf, doc_id)
    trimmed_to_orig = {i + 1: p for i, p in enumerate(pages)}
    matches: List[Dict[str, Any]] = []
    for g in gold_tables:
        expected_cols = len(g.get("header") or []) or None
        gold_pages = set(g.get("pages") or [])
        cand_details: List[Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]] = []
        for d in match_elements:
            md = d.get("metadata") or {}
            pnum = md.get("page_number")
            if pnum is None and md.get("page_numbers"):
                pnum = (md.get("page_numbers") or [None])[0]
            orig_page = trimmed_to_orig.get(pnum)
            if gold_pages and orig_page not in gold_pages:
                continue
            html = md.get("text_as_html") or d.get("text_as_html")
            if not html:
                text = d.get("text") or ""
                html = "<table><tbody>" + "".join(f"<tr><td>{line}</td></tr>" for line in text.splitlines()) + "</tbody></table>"
            det = compute_table_match_cohesion(g, html, expected_cols)
            cand_details.append((d, md, det))

        g_rows = [[str(c) for c in row] for row in (g.get("rows") or [])]
        g_left = set([row[0].lower() for row in g_rows if row])
        covered: set = set()
        selected: List[Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]] = []
        remaining = cand_details.copy()
        max_chunks = 4
        while remaining and len(selected) < max_chunks:
            best_idx = -1
            best_gain = 0
            for idx, (d, md, det) in enumerate(remaining):
                c_left = set(det.get("cand_left_sig") or [])
                gain = len((c_left & g_left) - covered)
                if gain > best_gain:
                    best_gain = gain
                    best_idx = idx
            if best_idx == -1 or best_gain <= 0:
                break
            chosen = remaining.pop(best_idx)
            selected.append(chosen)
            covered |= set(chosen[2].get("cand_left_sig") or []) & g_left

        covered_count = len(covered)
        gold_left_size = len(g_left)
        coverage_ratio = (covered_count / gold_left_size) if gold_left_size else 1.0
        chunk_count = len(selected)
        cohesion = (1.0 / chunk_count) if chunk_count > 0 else 0.0
        chunker_f1 = 0.0
        if coverage_ratio > 0.0 and cohesion > 0.0:
            chunker_f1 = 2.0 * coverage_ratio * cohesion / (coverage_ratio + cohesion)
        best_single = max(cand_details, key=lambda t: t[2].get("cohesion", 0.0), default=None)

        match_entry: Dict[str, Any] = {
            "doc_id": doc,
            "gold_table_id": g.get("table_id"),
            "gold_title": g.get("title"),
            "gold_pages": list(gold_pages),
            "expected_cols": expected_cols,
            "selected_elements": [
                {
                    "element_id": d.get("element_id"),
                    "page_trimmed": (md.get("page_number") or (md.get("page_numbers") or [None])[0]),
                    "page_original": trimmed_to_orig.get(md.get("page_number") or (md.get("page_numbers") or [None])[0]),
                    "cohesion": det.get("cohesion"),
                    "row_overlap": det.get("row_overlap"),
                }
                for (d, md, det) in selected
            ],
            "coverage_ratio": coverage_ratio,
            "coverage": coverage_ratio,
            "cohesion": cohesion,
            "selected_chunk_count": chunk_count,
            "gold_left_size": gold_left_size,
            "covered_count": covered_count,
            "chunker_f1": chunker_f1,
        }
        if best_single is not None:
            d, md, det = best_single
            pnum = md.get("page_number")
            if pnum is None and md.get("page_numbers"):
                pnum = (md.get("page_numbers") or [None])[0]
            match_entry.update(
                {
                    "best_element_id": d.get("element_id"),
                    "best_page_trimmed": pnum,
                    "best_page_original": trimmed_to_orig.get(pnum),
                    "best_cohesion": det.get("cohesion"),
                    "best_row_overlap": det.get("row_overlap"),
                }
            )
        matches.append(match_entry)

    overall: Dict[str, Any] = {"tables": len(matches)}
    if matches:
        avg_cov = sum(m.get("coverage", m.get("coverage_ratio", 0.0)) for m in matches) / len(matches)
        avg_coh = sum(m.get("cohesion", 0.0) for m in matches) / len(matches)
        avg_f1 = sum(m.get("chunker_f1", 0.0) for m in matches) / len(matches)
        avg_chunks = sum(m.get("selected_chunk_count", 0) for m in matches) / len(matches)
        total_gold = sum(m.get("gold_left_size", 0) for m in matches)
        total_covered = sum(m.get("covered_count", 0) for m in matches)
        micro_cov = (total_covered / total_gold) if total_gold else avg_cov
        overall.update(
            {
                "avg_coverage": avg_cov,
                "avg_cohesion": avg_coh,
                "avg_chunker_f1": avg_f1,
                "avg_selected_chunk_count": avg_chunks,
                "micro_coverage": micro_cov,
            }
        )

    return overall, matches
