# Data Notes

The project does not persist to a database yet. Instead, Unstructured parses each PDF into JSON documents stored under `outputs/`. Source PDFs are read from `res/` by default, but the server honors a `PDF_DIR` environment variable (set to `/data/res` on Fly.io) so uploaded files can live on a mounted volume.

## Document JSON layout
- `source_file`: Absolute path to the processed PDF.
- `generated_at`: ISO-8601 timestamp (UTC) for the run that created the JSON.
- `page_limit`: Page cap applied during extraction (null when all pages are included).
- `element_count`: Number of Unstructured elements returned.
- `elements`: Native `unstructured` element payloads serialized via `element.to_dict()`.

## Preview/Match artifacts

`scripts/preview_unstructured_pages.py` produces two additional files per run:

1. **Tables JSONL** (`outputs/unstructured/<doc>.pages<range>.tables.jsonl`)
   - Each line is a single Unstructured element with a deterministic `chunk-*` `element_id`.
   - `metadata.original_element_id` retains the vendor-provided ID for traceability.
   - The rest of the payload mirrors `element.to_dict()`.

2. **Matches JSON** (`outputs/unstructured/<doc>.matches.json`)
   - `matches`: array containing one entry per gold table:
     - `doc_id`, `gold_table_id`, `gold_title`, `gold_pages`, `expected_cols`
      - `selected_elements`: ordered list of chunks chosen to cover the gold rows (with trimmed/original page numbers plus individual `cohesion` values and `row_overlap`).
     - `coverage_ratio` / `coverage`: proportion of unique left-column terms from the gold table found across the selected elements (recall).
     - `cohesion`: `1 / selected_chunk_count` — maximized when the table is kept in a single chunk.
     - `selected_chunk_count`: number of distinct chunks selected to cover the gold table.
     - `chunker_f1`: single overall chunking quality metric. Defined as the harmonic mean of coverage and cohesion. Ranges in [0, 1] and peaks only when the table is fully covered in a single chunk.
      - `best_element_id`, `best_page_trimmed`, `best_page_original`, `best_cohesion`, `best_row_overlap`: convenience fields for the single best chunk.
    - `overall`: document-level summary across all matched tables
     - `tables`: number of tables matched
     - `avg_coverage`, `avg_cohesion`, `avg_chunker_f1`, `avg_selected_chunk_count`
     - `micro_coverage`: coverage weighted by gold-row counts
   - `run_config`: metadata about how the run was produced
     - `strategy`, `chunking`, `infer_table_structure`, `match_source`
     - `chunk_params`: the effective parameters supplied to Unstructured. Keys may include `max_characters`, `new_after_n_chars`, `combine_text_under_n_chars`, `overlap`, `include_orig_elements`, `overlap_all`, `multipage_sections`.
     - `chunk_summary`: quick stats about emitted chunks (`count`, `min_chars`, `max_chars`, `avg_chars`)
     - `form_snapshot` (UI-only): raw values entered in the New Run modal, including convenience fields like `max_tokens` and the original `pdf`, `pages`, and optional `tag`. The recap bar prefers these when available and falls back to `chunk_params`.

3. **Optional Chunks JSONL** (`outputs/unstructured/<doc>.pages<range>.chunks.jsonl`)
   - Emitted when the UI/API runs with `chunking=by_title`.
   - Each line is a chunk object returned by `unstructured.chunking.title.chunk_by_title(elements, ...)` with deterministic `chunk-*` IDs applied.
   - Tuning parameters include `max_characters`, `new_after_n_chars`, `combine_text_under_n_chars`, and `overlap`.

## Web UI consumption

The local web UI (served by `web/serve.py`) consumes the same artifacts:
- Tables JSONL for per-chunk coordinates (`metadata.coordinates.points`, `layout_width`, `layout_height`, `page_number`).
- Matches JSON for per-table `selected_elements` (with `page_trimmed`/`page_original`) and overall metrics.
 - Chunks JSONL is currently not visualized, but generation is available from the “New Run” card for tuning text chunking parameters.

No schema changes are introduced; these endpoints are thin wrappers over the files on disk.
