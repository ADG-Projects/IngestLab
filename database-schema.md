# Data Notes

The project does not persist to a database yet. Instead, artifacts are written to `outputs/`:
- `outputs/unstructured/` — Unstructured runs (**deprecated**).
- `outputs/unstructured/partition_api/` — Unstructured Partition (hosted API) runs (**deprecated**; elements-only; no local chunking).
- `outputs/azure/document_intelligence/` — Azure runs (Document Intelligence Layout). API endpoints accept an optional `provider` query parameter to resolve the correct directory.
- When Document Intelligence is invoked with `outputs=figures`, cropped figure PNGs are saved alongside the chunk JSONL as `<chunk_stem>.figures/<figure-id>.png`; element metadata references those files so the UI can preview them just like Unstructured image payloads.
- Azure Document Intelligence runs are elements-only in the UI; the Chunks tab stays hidden even if chunk-style JSONL artifacts are present.
- Custom chunker keeps section headings that fall inside Table/Figure bounding boxes attached to the container chunk so captions stay with their figure/table instead of starting new section chunks, and merges consecutive sectionHeading/title elements into a single section to avoid heading-only chunks when multiple headings stack without body content between them.
- Reviews are stored per provider under `<provider_out_dir>/reviews/<slug>.reviews.json`.
- Azure AnalyzeResult payloads are now coerced via the SDK `as_dict` helper and polygon coordinates are scaled to PDF points (72/in) so overlays line up; rerun any older Azure slices that produced empty `.tables.jsonl` files.

Source PDFs are read from a configurable directory:

- `PDF_DIR` environment variable points to where PDFs live. Locally it defaults to `res/`. In Fly deployments with a volume mounted at `/data`, use `PDF_DIR=/data/res` so uploads persist across deploys.
  - New UI runs now also record a compact "Running" state in the frontend only: while `/api/run` is processing, the New Run modal hides its fields and the header button reflects the in-flight status, but the persisted `run_config.form_snapshot` continues to store the full parameter set as before.
- `/api/run` enqueues work instead of blocking: the response contains a job descriptor (`id`, `status`, `slug`, `pdf`, `pages`, command preview, stdout/stderr tails). The UI polls `/api/run-jobs/{id}` until the chunker reports `succeeded` or `failed`, and job logs stay cached in memory until the server restarts.

## Version history

- **v5.0 (2025-12-01)** – Custom chunker improvements: section headings inside Table/Figure boxes stay attached to container, consecutive headings merge, paragraphs inside tables filtered, tables/figures included in parent sections. UI: element drawer hierarchy, resizable panels, centered PDF viewer, smart parameter banner, alternating chunk overlay colors, run persistence across reloads.
- **v4.4 (2025-11-28)** – Apple Liquid Glass UI redesign with frosted glass effects, dark/light theme toggle, Apple system color palette, smooth spring animations.
- **v4.3 (2025-11-27)** – Figure elements in Azure DI outline view, direct page jump input, What's New modal, RTL table fix, fixed PDF legend, Azure DI as default provider.
- **v4.2 (2025-11-26)** – Enhanced feedback analysis with provider-level comparisons, smoothed scoring formulas, multi-dimensional insights, and improved JSON/HTML exports with LLM analysis payloads.
- **v4.1 (2025-11-26)** – Azure Document Intelligence figure crops stored alongside run artifacts; Azure settings recap hides API version for non-Azure runs.
- **v4.0 (2025-11-25)** – Added Unstructured Partition (hosted) provider for elements-only runs; Docker base image to ECR Public.
- **v3.2 (2025-11-25)** – Bundled markdown/DOMPurify locally, stored Azure detected-language metadata for RTL-aware reloads.
- **v3.0 (2025-11-24)** – Azure markdown rendering, RTL support, paragraph roles, outline grouping; chunk-only artifacts.
- **v2.1 (2025-11-18)** – Persist chunking defaults in `run_config` for UI recap bars.
- **v2.0 (2025-11-17)** – Chunk/element review workflows; modularized frontend.
- **v1.1 (2025-11-17)** – Chunk overlay/drawer refinements.

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
   - `provider`: `unstructured/local`, `unstructured/partition`, or `azure/document_intelligence`. Azure runs also record `model_id`, `features`, `locale`, `string_index_type`, `output_content_format`, and `query_fields` when supplied.
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

### Feedback index and LLM analysis

- `GET /api/feedback/index` scans `outputs/*/reviews/*.reviews.json` across providers, returning per-run summaries, per-provider totals, and smoothed scores with confidence labels (score = `(good+3)/(good+bad+6)*100`; no note bodies unless `include_items=true`).
- `GET /api/feedback/export` returns the same summaries plus optional note bodies, a flattened `notes` list for downloads/LLM prompts (scores and confidence included), and the latest LLM analysis when it exists.
- `POST /api/feedback/analyze/provider` batches every review for a provider, enriches each reviewed item with element metadata (type + page), sends them to OpenAI (model/env driven by `FEEDBACK_LLM_API_KEY`, optional `FEEDBACK_LLM_MODEL`, `FEEDBACK_LLM_BASE`), summarizes each batch, and reduces to a concise provider JSON summary (treating reviewed units as elements).
- `POST /api/feedback/analyze/compare` reuses the provider summaries plus per-provider stats (good/bad totals, smoothed score, confidence, note counts) and asks the LLM to compare/rank providers with shared recommendations and a 1–10 “actionability” score per provider (how specific and usable the feedback is).
- Provider/comparison outputs include per-element suggestions (machine_note, issue_tags, severity, text_snippet), element-type findings, issue taxonomies (type/severity/evidence), review-gap callouts, and multi-dimensional 1–10 scores (overall/actionability/explanations/coverage).
- The Feedback UI tab visualizes the aggregated summaries (counts, per-provider chart, run cards) and exposes JSON/HTML exports alongside the LLM actions.
