from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple


def _norm_text(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"\s+", " ", s)
    s = s.replace("—", "-").replace("–", "-").replace("“", '"').replace("”", '"').replace("’", "'")
    s = re.sub(r"[^a-z0-9 \-\'\"/]+", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _try_bs4_parse_table(html: str) -> Tuple[List[str], List[List[str]]]:
    from bs4 import BeautifulSoup  # type: ignore

    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table") or soup
    header: List[str] = []
    rows: List[List[str]] = []
    thead = table.find("thead") if table else None
    if thead:
        ths = thead.find_all("th")
        if ths:
            header = [th.get_text(separator=" ", strip=True) for th in ths]
    body = table.find("tbody") if table else None
    trs = (body.find_all("tr") if body else table.find_all("tr")) if table else []
    for tr in trs:
        cells = tr.find_all(["td", "th"])
        if not cells:
            continue
        row = [c.get_text(separator=" ", strip=True) for c in cells]
        if header and row == header:
            continue
        rows.append(row)
    return header, rows


def _regex_parse_table(html: str) -> Tuple[List[str], List[List[str]]]:
    header: List[str] = []
    rows: List[List[str]] = []
    h = re.sub(r"\s+", " ", html)
    for i, tr in enumerate(re.split(r"(?i)</?tr[^>]*>", h)):
        tr = tr.strip()
        if not tr:
            continue
        cells = re.findall(r"(?i)<t[dh][^>]*>(.*?)</t[dh]>", tr)
        if not cells:
            continue
        def strip_tags(x: str) -> str:
            return re.sub(r"(?s)<[^>]+>", " ", x).strip()
        row = [re.sub(r"\s+", " ", strip_tags(c)) for c in cells]
        if i == 0 and not header:
            header = row
        else:
            rows.append(row)
    return header, rows


def parse_html_table_to_grid(html: str) -> Tuple[List[str], List[List[str]]]:
    try:
        return _try_bs4_parse_table(html)
    except Exception:
        return _regex_parse_table(html)


def left_col_signature(rows: List[List[str]]) -> List[str]:
    sig: List[str] = []
    for r in rows:
        if not r:
            continue
        sig.append(_norm_text(r[0]))
    return sig


def jaccard_overlap(a: List[str], b: List[str]) -> float:
    sa, sb = set(a), set(b)
    if not sa and not sb:
        return 1.0
    if not sa or not sb:
        return 0.0
    inter = len(sa & sb)
    union = len(sa | sb)
    return inter / union if union else 0.0


def load_gold(gold_path: str, input_source: str, doc_id: Optional[str]) -> Tuple[str, List[Dict[str, Any]]]:
    matched_doc_id: Optional[str] = None
    tables: List[Dict[str, Any]] = []
    with open(gold_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if rec.get("type") == "doc":
                if doc_id and rec.get("doc_id") == doc_id:
                    matched_doc_id = rec["doc_id"]
                elif not doc_id and rec.get("source") == input_source:
                    matched_doc_id = rec.get("doc_id")
            elif rec.get("type") == "table":
                if matched_doc_id and rec.get("doc_id") == matched_doc_id:
                    tables.append(rec)
    if not matched_doc_id:
        with open(gold_path, "r", encoding="utf-8") as fh:
            for line in fh:
                rec = json.loads(line)
                if rec.get("type") == "doc":
                    src = rec.get("source", "")
                    if src and input_source.endswith(src):
                        matched_doc_id = rec.get("doc_id")
                        break
        if matched_doc_id:
            with open(gold_path, "r", encoding="utf-8") as fh:
                tables = [json.loads(l) for l in fh if json.loads(l).get("type") == "table" and json.loads(l).get("doc_id") == matched_doc_id]
    return matched_doc_id or "", tables


def compute_table_match_cohesion(gold_table: Dict[str, Any], cand_html: str, expected_cols: Optional[int]) -> Dict[str, Any]:
    g_header: List[str] = [str(x) for x in (gold_table.get("header") or [])]
    g_rows: List[List[str]] = [[str(c) for c in row] for row in (gold_table.get("rows") or [])]
    g_left = left_col_signature(g_rows)

    c_header, c_rows = parse_html_table_to_grid(cand_html)
    c_left = left_col_signature(c_rows)

    s_rows = jaccard_overlap(g_left, c_left)

    col_penalty = 0.0
    if expected_cols:
        c_cols = max((len(r) for r in c_rows), default=0)
        col_penalty = -abs(c_cols - expected_cols) * 0.05

    cohesion = max(0.0, min(1.0, s_rows + col_penalty))

    gold_to_cand: List[Tuple[int, Optional[int], float]] = []
    for i, grow in enumerate(g_rows):
        gkey = _norm_text(grow[0]) if grow else ""
        if not gkey:
            gold_to_cand.append((i, None, 0.0))
            continue
        best_j, best_sim = None, 0.0
        for j, crow in enumerate(c_rows):
            if not crow:
                continue
            ckey = _norm_text(crow[0])
            if not ckey:
                continue
            if gkey == ckey:
                sim = 1.0
            elif gkey in ckey or ckey in gkey:
                sim = 0.7
            else:
                sim = jaccard_overlap(gkey.split(), ckey.split())
            if sim > best_sim:
                best_sim, best_j = sim, j
        gold_to_cand.append((i, best_j, best_sim))

    return {
        "cohesion": cohesion,
        "row_overlap": s_rows,
        "gold_to_cand": gold_to_cand,
        "cand_header": c_header,
        "cand_rows": c_rows,
        "cand_left_sig": c_left,
    }
