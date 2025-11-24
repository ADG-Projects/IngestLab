# Data Notes

The project does not persist to a database yet. Instead, artifacts are written to `outputs/`:
- `outputs/unstructured/` — Unstructured runs (existing behavior).
- `outputs/azure/document_intelligence/` and `outputs/azure/content_understanding/` — Azure runs (Document Intelligence Layout and Content Understanding prebuilt analyzers). API endpoints accept an optional `provider` query parameter to resolve the correct directory.
- Reviews are stored per provider under `<provider_out_dir>/reviews/<slug>.reviews.json`.

Source PDFs are read from a configurable directory:

- **v2.1 (2025-11-18)** – Persist chunking defaults in `run_config` so UI recap bars (and downstream checks) see the actual Unstructured parameters, and keep drawer table previews aligned with the chunker’s column order while still right-aligning RTL cell text per document direction.
- **v2.0 (2025-11-17)** – Chunk/element review workflows and the modularized frontend keep overlays/cards in sync while leaving stored outputs and API payloads untouched.
- **v1.1 (2025-11-17)** – Chunk overlay/drawer refinements and Metrics view redraws introduced here leave the stored JSON layout unchanged.

- `PDF_DIR` environment variable points to where PDFs live. Locally it defaults to `res/`. In Fly deployments with a volume mounted at `/data`, use `PDF_DIR=/data/res` so uploads persist across deploys.
  - New UI runs now also record a compact “Running” state in the frontend only: while `/api/run` is processing, the New Run modal hides its fields and the header button reflects the in-flight status, but the persisted `run_config.form_snapshot` continues to store the full parameter set as before.
- `/api/run` enqueues work instead of blocking: the response contains a job descriptor (`id`, `status`, `slug`, `pdf`, `pages`, command preview, stdout/stderr tails). The UI polls `/api/run-jobs/{id}` until the chunker reports `succeeded` or `failed`, and job logs stay cached in memory until the server restarts. Successful jobs still rewrite their `matches.json` payloads to persist `form_snapshot`, PDF/page metadata, and language hints.

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
     - `provider`: `unstructured`, `azure-di`, or `azure-cu`. Azure runs also record `model_id`, `api_version`, `features`, `locale`, `string_index_type`, `output_content_format`, `query_fields`, and `analyzer_id`.
     - Language hints mirrored from the UI: `primary_language` (`eng` or `ara`), `ocr_languages` (string passed to Tesseract, e.g., `ara+eng`), `languages` (comma list or array of ISO codes forwarded to Unstructured), and `detect_language_per_element` (bool). These help downstream consumers right-align RTL previews when the document is Arabic-heavy.
     - `chunk_params`: the effective parameters supplied to Unstructured. Keys may include `max_characters`, `new_after_n_chars`, `combine_text_under_n_chars`, `overlap`, `include_orig_elements`, `overlap_all`, `multipage_sections`. The pipeline now always populates this object (even when users rely on defaults), so the UI header can display the actual values used instead of `-`.
     - `chunk_summary`: quick stats about emitted chunks (`count`, `min_chars`, `max_chars`, `avg_chars`)
     - `form_snapshot` (UI-only): raw values entered in the New Run modal, including convenience fields like `max_tokens` and the original `pdf`, `pages`, and optional `tag`. The recap bar prefers these when available and falls back to `chunk_params`.

3. **Optional Chunks JSONL** (`outputs/unstructured/<doc>.pages<range>.chunks.jsonl`)
   - Emitted when the UI/API runs with `chunking=by_title`.
   - Each line is a chunk object returned by `unstructured.chunking.title.chunk_by_title(elements, ...)` with deterministic `chunk-*` IDs applied.
   - Tuning parameters include `max_characters`, `new_after_n_chars`, `combine_text_under_n_chars`, and `overlap`.

## Web UI consumption

The local web UI (served by `main.py`) consumes the same artifacts:
- Tables JSONL for per-chunk coordinates (`metadata.coordinates.points`, `layout_width`, `layout_height`, `page_number`).
- Matches JSON for per-table `selected_elements` (with `page_trimmed`/`page_original`) and overall metrics.
- Chunks JSONL is currently not visualized, but generation is available from the “New Run” card for tuning text chunking parameters.
- The Inspect → Chunks panel now sizes each list card to match its text and keeps chunk overlays filtered by the same type/review selectors so the PDF view mirrors the list.

No schema changes are introduced; these endpoints are thin wrappers over the files on disk.

The static UI client now assembles behavior from modular scripts (`app-state.js`, `app-ui.js`, `app-reviews.js`, `app-overlays.js`, `app-metrics.js`, `app-elements.js`, `app-chunks.js`, `app-runs.js`, and the entry `app.js`) so state, overlays, reviews, elements, chunks, metrics, and run wiring stay focused.

## Review storage

Reviewer feedback stays on disk alongside run artifacts:

- `outputs/unstructured/reviews/<slug>.reviews.json` — JSON object persisted per UI slug.
  - `slug`: matches the run slug (e.g., `V3_0_EN_4.pages4-6`).
  - `items`: dictionary keyed by `<kind>:<item_id>` (`kind` is `chunk` or `element`).
    - Each entry includes `kind`, `item_id`, `rating` (`good` or `bad`), optional `note`, and `updated_at` (UTC ISO timestamp).
  - `summary`: cached counts `{ good, bad, total }` for quick header chips.

The FastAPI endpoints (`GET/POST /api/reviews/{slug}`) read/write these files atomically so the UI can show live filters, summary chips, and drawer editors without a database.
