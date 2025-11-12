import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from typing import Any, Dict, List, Optional, Tuple


def parse_pages(pages_arg: str) -> List[int]:
    pages: List[int] = []
    for part in pages_arg.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start_s, end_s = part.split("-", 1)
            start, end = int(start_s), int(end_s)
            pages.extend(range(start, end + 1))
        else:
            pages.append(int(part))
    return sorted(set(pages))


def _norm_text(s: str) -> str:
    s = s.strip().lower()
    # Collapse whitespace
    s = re.sub(r"\s+", " ", s)
    # Normalize dashes and quotes
    s = s.replace("—", "-").replace("–", "-").replace("“", '"').replace("”", '"').replace("’", "'")
    # Remove most punctuation except alnum, space, dash, slash, apostrophe
    s = re.sub(r'[^a-z0-9 \-\'"/]+', "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _try_bs4_parse_table(html: str) -> Tuple[List[str], List[List[str]]]:
    try:
        from bs4 import BeautifulSoup  # type: ignore
    except Exception:
        raise
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table") or soup
    header: List[str] = []
    rows: List[List[str]] = []
    # Collect header from thead or the first row with <th>
    thead = table.find("thead") if table else None
    if thead:
        ths = thead.find_all("th")
        if ths:
            header = [th.get_text(separator=" ", strip=True) for th in ths]
    # Collect rows from tbody or all trs
    body = table.find("tbody") if table else None
    trs = (body.find_all("tr") if body else table.find_all("tr")) if table else []
    for tr in trs:
        cells = tr.find_all(["td", "th"])  # include th if thead missing/misused
        if not cells:
            continue
        row = [c.get_text(separator=" ", strip=True) for c in cells]
        # Skip header duplicates if exactly equals header
        if header and [c.get_text(separator=" ", strip=True) for c in cells] == header:
            continue
        rows.append(row)
    return header, rows


def _regex_parse_table(html: str) -> Tuple[List[str], List[List[str]]]:
    # Very lightweight fallback: split on <tr>, extract <th>/<td>
    header: List[str] = []
    rows: List[List[str]] = []
    # Normalize for simpler regex
    h = re.sub(r"\s+", " ", html)
    for i, tr in enumerate(re.split(r"(?i)</?tr[^>]*>", h)):
        tr = tr.strip()
        if not tr:
            continue
        cells = re.findall(r"(?i)<t[dh][^>]*>(.*?)</t[dh]>", tr)
        if not cells:
            continue
        # Strip tags from inner content
        def strip_tags(x: str) -> str:
            return re.sub(r"(?s)<[^>]+>", " ", x).strip()
        row = [re.sub(r"\s+", " ", strip_tags(c)) for c in cells]
        if i == 0 and not header:
            header = row
        else:
            rows.append(row)
    return header, rows


def parse_html_table_to_grid(html: str) -> Tuple[List[str], List[List[str]]]:
    # Prefer BeautifulSoup when available; fallback to regex parser
    try:
        return _try_bs4_parse_table(html)
    except Exception:
        return _regex_parse_table(html)


def ensure_stable_element_id(element: Dict[str, Any]) -> None:
    """Derive a deterministic element_id based on content so runs stay consistent."""

    meta = element.get("metadata") or {}
    payload = {
        "type": element.get("type"),
        "text": element.get("text"),
        "text_as_html": meta.get("text_as_html"),
        "page_number": meta.get("page_number") or (meta.get("page_numbers") or [None])[0],
        "coordinates": meta.get("coordinates"),
    }
    serialized = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    digest = hashlib.sha1(serialized).hexdigest()[:16]
    stable_id = f"chunk-{digest}"

    original_id = element.get("element_id")
    if original_id and original_id != stable_id:
        meta = dict(meta)
        meta.setdefault("original_element_id", original_id)
        element["metadata"] = meta
    element["element_id"] = stable_id




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
        # Second pass: if doc_id not found via exact match, try endswith on source
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

    # Column count proximity: prefer candidates whose column count matches gold
    col_penalty = 0.0
    if expected_cols:
        c_cols = max((len(r) for r in c_rows), default=0)
        col_penalty = -abs(c_cols - expected_cols) * 0.05  # light penalty per extra/missing col

    cohesion = max(0.0, min(1.0, s_rows + col_penalty))

    # Build per-row containment stats (left column containment)
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
            # Simple containment / equality based similarity
            if gkey == ckey:
                sim = 1.0
            elif gkey in ckey or ckey in gkey:
                sim = 0.7
            else:
                # token overlap as fallback
                sim = jaccard_overlap(gkey.split(), ckey.split())
            if sim > best_sim:
                best_sim, best_j = sim, j
        gold_to_cand.append((i, best_j, best_sim))

    return {
        "cohesion": cohesion,
        "row_overlap": s_rows,
        "gold_left_size": len(g_left),
        "cand_left_size": len(c_left),
        "col_penalty": col_penalty,
        "gold_to_cand": gold_to_cand,
        "cand_header": c_header,
        "cand_rows": c_rows,
        "cand_left_sig": c_left,
    }


def slice_pdf(input_pdf: str, pages: List[int], output_pdf: Optional[str] = None) -> str:
    """Create a new PDF containing only the specified 1-based pages.

    Returns the path to the trimmed PDF.
    """
    # Lazy import to avoid hard dependency unless used
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(input_pdf)
    writer = PdfWriter()

    max_page = len(reader.pages)
    for p in sorted(set(pages)):
        if p < 1 or p > max_page:
            continue
        writer.add_page(reader.pages[p - 1])

    if output_pdf is None:
        fd, tmp_path = tempfile.mkstemp(prefix="trimmed_", suffix=".pdf")
        os.close(fd)
        output_pdf = tmp_path
    else:
        parent = os.path.dirname(output_pdf)
        if parent:
            os.makedirs(parent, exist_ok=True)

    with open(output_pdf, "wb") as f:
        writer.write(f)

    return output_pdf


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Preview Unstructured partitioned elements for specific PDF pages")
    parser.add_argument("--input", required=True, help="Path to the input PDF file")
    parser.add_argument("--pages", required=True, help="Comma/range pages, e.g. '4,5,6' or '4-6'")
    parser.add_argument("--only-tables", action="store_true", help="Emit only elements of type Table")
    parser.add_argument("--strategy", default="auto", choices=["auto", "fast", "hi_res"], help="Unstructured PDF strategy")
    parser.add_argument("--output", help="Optional JSONL output path. Defaults to stdout if omitted")
    parser.add_argument("--trimmed-out", help="Optional path to save the trimmed PDF (for debugging)")
    parser.add_argument("--input-jsonl", help="Reuse an existing JSONL of elements instead of partitioning")
    parser.add_argument("--gold", help="Path to gold JSONL for table comparison")
    parser.add_argument("--doc-id", help="Optional doc_id in gold; defaults to matching by source path")
    parser.add_argument("--emit-matches", help="Optional path to write matching results JSON")
    args = parser.parse_args(argv)

    pages = parse_pages(args.pages)

    dict_elements: List[Dict[str, Any]] = []
    trimmed_path: Optional[str] = None
    if args.input_jsonl:
        # Reuse an existing elements JSONL; do NOT partition again
        with open(args.input_jsonl, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("Total output lines:"):
                    continue
                dict_elements.append(json.loads(line))
    else:
        # Create a trimmed PDF first for speed and simpler parsing
        trimmed_path = slice_pdf(args.input, pages, args.trimmed_out)

        # Lazy import so that argparse --help is fast if unstructured isn't available
        from unstructured.partition.pdf import partition_pdf

        elements = partition_pdf(
            filename=trimmed_path,
            strategy=args.strategy,
            include_page_breaks=False,
            infer_table_structure=True,
        )
        dict_elements = [el.to_dict() for el in elements]

    # Ensure deterministic element_ids so downstream artifacts stay in sync across runs
    for element in dict_elements:
        ensure_stable_element_id(element)

    out_fh = None
    try:
        if args.output:
            os.makedirs(os.path.dirname(args.output), exist_ok=True)
            out_fh = open(args.output, "w", encoding="utf-8")

        def emit(line: str) -> None:
            if out_fh is not None:
                out_fh.write(line + "\n")
            else:
                sys.stdout.write(line + "\n")

        # Build mapping from trimmed page numbers -> original page numbers
        trimmed_to_orig = {i + 1: p for i, p in enumerate(pages)}

        # Emit partitioned elements (optionally tables-only)
        table_elements: List[Dict[str, Any]] = []
        for d in dict_elements:
            if args.only_tables and d.get("type") != "Table":
                continue
            emit(json.dumps(d, ensure_ascii=False))
            if d.get("type") == "Table":
                table_elements.append(d)

        # If gold provided, compute automatic best matches per gold table
        if args.gold:
            gold_doc_id, gold_tables = load_gold(args.gold, args.input, args.doc_id)
            matches: List[Dict[str, Any]] = []
            for g in gold_tables:
                expected_cols = len(g.get("header") or []) or None
                gold_pages = set(g.get("pages") or [])
                # Narrow candidates by page intersection (map trimmed page -> original)
                cand_subset: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
                for d in table_elements:
                    md = d.get("metadata") or {}
                    pnum = md.get("page_number")
                    if pnum is None and md.get("page_numbers"):
                        pnum = (md.get("page_numbers") or [None])[0]
                    orig_page = trimmed_to_orig.get(pnum)
                    if gold_pages and orig_page not in gold_pages:
                        continue
                    cand_subset.append((d, md))

                # Pre-compute details for each candidate
                cand_details: List[Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]] = []
                for d, md in cand_subset:
                    html = (md.get("text_as_html") or "") if isinstance(md, dict) else ""
                    if not html:
                        # fallback to plain text: wrap as one-cell table
                        html = f"<table><tbody><tr><td>{d.get('text','')}</td></tr></tbody></table>"
                    det = compute_table_match_cohesion(g, html, expected_cols)
                    cand_details.append((d, md, det))

                # Greedy selection of multiple chunks to maximize coverage of gold left column
                g_rows = [[str(c) for c in row] for row in (g.get("rows") or [])]
                g_left = set(left_col_signature(g_rows))
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

                # Coverage and cohesion metrics
                covered_count = len(covered)
                gold_left_size = len(g_left)
                coverage_ratio = (covered_count / gold_left_size) if gold_left_size else 1.0
                # Single overall quality metric akin to F1: harmonic mean of
                # coverage (recall) and cohesion (1 / number of selected chunks).
                chunk_count = len(selected)
                cohesion = (1.0 / chunk_count) if chunk_count > 0 else 0.0
                if coverage_ratio > 0.0 and cohesion > 0.0:
                    chunker_f1 = 2.0 * coverage_ratio * cohesion / (coverage_ratio + cohesion)
                else:
                    chunker_f1 = 0.0
                # Also keep the single best by cohesion for reference
                best_single = max(cand_details, key=lambda t: t[2].get("cohesion", 0.0), default=None)

                match_entry: Dict[str, Any]
                match_entry = {
                    "doc_id": gold_doc_id,
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
                    # Explicit metrics
                    "coverage_ratio": coverage_ratio,
                    "coverage": coverage_ratio,
                    "cohesion": cohesion,
                    "selected_chunk_count": chunk_count,
                    # Debug counts
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

            # Compute overall metrics across all tables (macro averages)
            overall: Dict[str, Any] = {"tables": len(matches)}
            if matches:
                avg_cov = sum(m.get("coverage", m.get("coverage_ratio", 0.0)) for m in matches) / len(matches)
                avg_coh = sum(m.get("cohesion", 0.0) for m in matches) / len(matches)
                avg_f1 = sum(m.get("chunker_f1", 0.0) for m in matches) / len(matches)
                avg_chunks = sum(m.get("selected_chunk_count", 0) for m in matches) / len(matches)
                # Micro coverage weighted by gold rows when available
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

            payload = {"matches": matches, "overall": overall}
            # Write matches out if requested
            if args.emit_matches:
                os.makedirs(os.path.dirname(args.emit_matches), exist_ok=True)
                with open(args.emit_matches, "w", encoding="utf-8") as mf:
                    json.dump(payload, mf, ensure_ascii=False, indent=2)
            else:
                emit(json.dumps(payload, ensure_ascii=False))
    finally:
        if out_fh is not None:
            out_fh.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
