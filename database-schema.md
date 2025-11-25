# Data Notes

The project does not persist to a database yet. Instead, artifacts are written to `outputs/`:
- `outputs/unstructured/` — Unstructured runs (existing behavior).
- `outputs/unstructured/partition_api/` — Unstructured Partition (hosted API) runs (elements-only; no local chunking).
- `outputs/azure/document_intelligence/` and `outputs/azure/content_understanding/` — Azure runs (Document Intelligence Layout and Content Understanding prebuilt analyzers). API endpoints accept an optional `provider` query parameter to resolve the correct directory.
- Reviews are stored per provider under `<provider_out_dir>/reviews/<slug>.reviews.json`.
- Azure AnalyzeResult payloads are now coerced via the SDK `as_dict` helper and polygon coordinates are scaled to PDF points (72/in) so overlays line up; rerun any older Azure slices that produced empty `.tables.jsonl` files.

Source PDFs are read from a configurable directory:

- **v4.0 (2025-11-25)** – Added Unstructured Partition (hosted API) support as elements-only runs alongside existing outputs, keeping chunk artifacts limited to local Unstructured/Azure providers.
- **v3.0 (2025-11-24)** – Azure outputs now render markdown safely, flip to RTL when detected, and expose paragraph roles plus outline grouping, while the pipeline ships only trimmed PDFs, chunks JSONL, and run metadata (no Metrics/tables artifacts).
- **v2.1 (2025-11-18)** – Persist chunking defaults in `run_config` so UI recap bars (and downstream checks) see the actual Unstructured parameters while the pipeline emits only chunk JSONL and trimmed PDFs (no table metrics or matches JSON).
- **v2.0 (2025-11-17)** – Chunk/element review workflows and the modularized frontend keep overlays/cards in sync while leaving stored outputs and API payloads focused on chunks and elements.
- **v1.1 (2025-11-17)** – Chunk overlay/drawer refinements; historic metrics view references are now deprecated.

- `PDF_DIR` environment variable points to where PDFs live. Locally it defaults to `res/`. In Fly deployments with a volume mounted at `/data`, use `PDF_DIR=/data/res` so uploads persist across deploys.
  - New UI runs now also record a compact “Running” state in the frontend only: while `/api/run` is processing, the New Run modal hides its fields and the header button reflects the in-flight status, but the persisted `run_config.form_snapshot` continues to store the full parameter set as before.
- `/api/run` enqueues work instead of blocking: the response contains a job descriptor (`id`, `status`, `slug`, `pdf`, `pages`, command preview, stdout/stderr tails). The UI polls `/api/run-jobs/{id}` until the chunker reports `succeeded` or `failed`, and job logs stay cached in memory until the server restarts.

- **v4.0 (2025-11-25)** – Added the Unstructured Partition (hosted) provider for elements-only runs (no local chunking) and moved the Docker base image to ECR Public to avoid Docker Hub rate limits.
- **v3.2 (2025-11-25)** – Bundled markdown/DOMPurify locally, stored Azure detected-language metadata for RTL-aware reloads, and tightened Azure tooltip alignment.
- **v3.0 (2025-11-24)** – Azure outputs now render markdown safely, flip to RTL when detected, and expose paragraph roles plus outline grouping, while the pipeline ships only trimmed PDFs, chunks JSONL, and run metadata (no Metrics/tables artifacts).
- **v2.1 (2025-11-18)** – Persist chunking defaults in `run_config` so UI recap bars (and downstream checks) see the actual Unstructured parameters while the pipeline emits only chunk JSONL and trimmed PDFs (no table metrics or matches JSON).
- **v2.0 (2025-11-17)** – Chunk/element review workflows and the modularized frontend keep overlays/cards in sync while leaving stored outputs and API payloads focused on chunks and elements.
- **v1.1 (2025-11-17)** – Chunk overlay/drawer refinements; historic metrics view references are now deprecated.

## Document JSON layout
- `source_file`: Absolute path to the processed PDF.
- `generated_at`: ISO-8601 timestamp (UTC) for the run that created the JSON.
- `page_limit`: Page cap applied during extraction (null when all pages are included).
- `element_count`: Number of Unstructured elements returned.
- `elements`: Native `unstructured` element payloads serialized via `element.to_dict()`.

## Chunk artifacts

`scripts/preview_unstructured_pages.py` (and the web `/api/run` pipeline) now focus on chunk outputs:

1. **Chunks JSONL** (`outputs/<provider>/<doc>.pages<range>.chunks.jsonl`)
   - Each line is a chunk object returned by the configured chunking strategy (e.g., `unstructured.chunking.title.chunk_by_title`) with deterministic `chunk-*` IDs applied.
   - Tuning parameters include `max_characters`, `new_after_n_chars`, `combine_text_under_n_chars`, `overlap`, `include_orig_elements`, `overlap_all`, and (for by-title) `multipage_sections`.
   - Chunks retain coordinates where available so overlays can be drawn directly from chunk metadata.

2. **Run config metadata** (`outputs/<provider>/<doc>.pages<range>.run.json`)
   - `strategy`, `chunking`, `infer_table_structure`
   - `provider`: `unstructured`, `azure-di`, or `azure-cu`. Azure runs also record `model_id`, `api_version`, `features`, `locale`, `string_index_type`, `output_content_format`, `query_fields`, and `analyzer_id` when supplied.
- Language hints mirrored from the UI: `primary_language` (`eng` or `ara`), `ocr_languages`, `languages`, and `detect_language_per_element`. Azure runs also persist `detected_languages` and `detected_primary_language` from the pipeline when detection is enabled, so reloads can auto-toggle RTL.
   - `chunk_params`: the effective parameters supplied to the chunker. Keys may include `max_characters`, `new_after_n_chars`, `combine_text_under_n_chars`, `overlap`, `include_orig_elements`, `overlap_all`, `multipage_sections`. This object is always populated (even when users rely on defaults), so the UI header can display the actual values used instead of `-`.
   - `form_snapshot` (UI-only): raw values entered in the New Run modal, including convenience fields like `max_tokens` and the original `pdf`, `pages`, and optional `tag`.

## Web UI consumption

The local web UI (served by `main.py`) consumes:
- Chunks JSONL for overlays and the Inspect → Chunks pane.
- Trimmed PDFs (`<doc>.pages<range>.pdf`) for page rendering.
- Run metadata JSON for the settings recap bar and language direction hints.

The static UI client now assembles behavior from modular scripts (`app-state.js`, `app-ui.js`, `app-reviews.js`, `app-overlays.js`, `app-metrics.js`, `app-elements.js`, `app-chunks.js`, `app-runs.js`, and the entry `app.js`) so state, overlays, reviews, elements, chunks, and run wiring stay focused.

## Review storage

Reviewer feedback stays on disk alongside run artifacts:

- `outputs/unstructured/reviews/<slug>.reviews.json` — JSON object persisted per UI slug.
  - `slug`: matches the run slug (e.g., `V3_0_EN_4.pages4-6`).
  - `items`: dictionary keyed by `<kind>:<item_id>` (`kind` is `chunk` or `element`).
    - Each entry includes `kind`, `item_id`, `rating` (`good` or `bad`), optional `note`, and `updated_at` (UTC ISO timestamp).
  - `summary`: cached counts `{ good, bad, total }` for quick header chips.

The FastAPI endpoints (`GET/POST /api/reviews/{slug}`) read/write these files atomically so the UI can show live filters, summary chips, and drawer editors without a database.
