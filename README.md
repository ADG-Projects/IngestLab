# ChunkingTests

Local playground for document ingestion experiments. The first iteration focuses on using the open-source Unstructured library to break PDFs into structured JSON.

Two helper scripts exist today:
- `process_unstructured.py`: interactive full-document runs (see below).
- `scripts/preview_unstructured_pages.py`: fast page slicing + gold-table matching for targeted QA.

## Prerequisites

- macOS or Linux with Python 3.10+.
- [uv](https://github.com/astral-sh/uv) for dependency management (already expected in this repo).

## Setup

```bash
uv sync
```

`uv sync` creates a `.venv` in the project root and installs all required packages, including `unstructured[pdf]`.

## Process a PDF

```bash
uv run python process_unstructured.py
```

The script:
- Lists PDFs from `res/`.
- Prompts you to pick a file.
- Offers an optional toggle to limit how many pages are processed (handy for quick spot checks).
- Writes a structured JSON export to `outputs/<pdf-name>.json`.

Each JSON document includes the source path, timestamp, optional page limit, element count, and the raw Unstructured element payloads.

## Preview specific pages & compare to gold tables

When you just need a few pages (or want to evaluate table extraction quality), use the preview helper:

```bash
uv run python scripts/preview_unstructured_pages.py \
  --input res/V3.0_Reviewed_translation_EN_full\ 4.pdf \
  --pages 4-6 \
  --only-tables \
  --output outputs/unstructured/V3_0_EN_4.pages4-6.tables.jsonl \
  --gold dataset/gold.jsonl \
  --emit-matches outputs/unstructured/V3_0_EN_4.matches.json
```

What it does:
- Trims the PDF to the requested pages and runs Unstructured once.
- Emits the resulting elements (tables-only if requested) with deterministic `chunk-*` IDs.
- Parses each `text_as_html` payload into rows and auto-matches them to the curated `dataset/gold.jsonl` tables (multi-chunk coverage supported).
- Writes a `matches.json` summary showing per-table metrics and an overall section:
  - Per-table: `coverage` (recall), `cohesion` (`1 / selected_chunk_count`), `chunker_f1` (harmonic mean), plus the selected elements and the best single chunk.
  - Overall: macro averages across tables (`avg_coverage`, `avg_cohesion`, `avg_chunker_f1`, `avg_selected_chunk_count`) and `micro_coverage` weighted by gold rows.
  - Note: `cohesion` on each selected element is the row-overlap similarity (with a light column-count penalty) and differs from the table-level `cohesion` metric reported alongside coverage.

Use `--input-jsonl` when you want to re-evaluate matches from a previously saved JSONL without reprocessing the PDF, and `--trimmed-out` if you want to keep the sliced PDF for debugging.

## Next ideas

- Evaluate additional ingestion pipelines (Azure AI Document Intelligence, AWS Textract, etc.) as new experiments land in this sandbox.

## Web UI (Chunking Visualizer)

Spin up a small local UI to inspect PDFs, table matching, and chunker performance without juggling multiple files.

Quickstart:

```bash
uv sync
uv run python web/serve.py
# then open http://127.0.0.1:8765/
```

What you get:
- Two top-level views while keeping the PDF visible:
  - Metrics: run config, overall metrics bars, F1 chart, and table match cards with per-table actions (Highlight all/best, Details).
  - Inspect: focused tools for chunk and element inspection, with overlay toggles and type filter, plus sub-tabs for Chunks and Elements.
- Per-table cards with coverage, cohesion, F1, and chunk count, and one-click highlighting on the PDF from Metrics.
- Overlay UX improvements:
  - Hover any overlay to see a tooltip with ID, type, page, and for chunks the character length.
  - Overlay colors are hardcoded per element type (consistent across views and runs).
  - Table chunks derive per-row bounding boxes from their source tables, so multi-chunk highlights no longer stack on top of each other.
- Drilldown: click "Details" on any table to preview the extracted HTML table for the best chunk (and switch among all selected chunks).
- Inspect → Chunks: review chunk output (summary + list); selecting a chunk jumps to its page and shows its boxes.
- Inspect → Elements: browse element types and overlay boxes for the current page; filter by type.
  - Elements list shows colored cards per type and an inline text preview; cards display the source element’s original ID for clarity.
  - Overlays now follow the active Inspect tab: select Chunks to show chunk overlays, or Elements to show element overlays. The redundant quick controls were removed.
  - Interactions: click an overlay on the PDF to open its details (element or chunk). In Chunks, clicking a chunk expands a sublist of its elements; clicking an element there opens its details and focuses its overlay.
  - Overlay parity: clicking a chunk overlay behaves like clicking the chunk card — it focuses the chunk on the same page and expands its element list without opening a separate chunk drawer. Closing an element opened from that sublist returns you to the chunk view and preserves scroll.

Data sources used by the UI:
- `outputs/unstructured/<slug>.matches.json`
- `outputs/unstructured/<slug>.pagesX-Y.tables.jsonl`
- `outputs/unstructured/<slug>.pagesX-Y.pdf`

Endpoints (served by FastAPI):
 - `GET /api/pdfs` — list PDFs available in `res/` (for new runs).
 - `GET /api/runs` — discover available runs under `outputs/unstructured/`.
 - `DELETE /api/run/{slug}` — delete a run by its UI slug.
 - `GET /api/matches/{slug}` — load the matches JSON.
 - `GET /api/tables/{slug}` — load and parse the tables JSONL.
 - `GET /pdf/{slug}` — stream the trimmed PDF.
 - `GET /api/element_types/{slug}` — element type inventory for a run (counts by type).
 - `GET /api/boxes/{slug}?page=N&types=Table,Text` — minimal per-page box index for overlays (server-side indexed, avoids heavy scans).
 - `GET /api/chunks/{slug}` — chunk artifacts (summary + JSONL contents) for each run.
 - `POST /api/cleanup` — remove orphaned outputs (matches/tables/pdf/chunks not referenced by any run).
 - `POST /api/run` — execute a new run. Body:
   - `pdf` (string, required): filename under `res/`.
   - `pages` (string, required): page list/range (e.g., `4-6`, `4,5,6`). The server trims the PDF first and only processes those pages.
   - `strategy` (`auto|fast|hi_res`, default `auto`).
   - `infer_table_structure` (bool, default `true`).
  - `chunking` (`basic|by_title`, default `by_title`). Additional knobs:
    - Shared: `chunk_max_characters`, `chunk_new_after_n_chars`, `chunk_overlap`, `chunk_include_orig_elements`, `chunk_overlap_all`.
    - Extra for `by_title`: `chunk_combine_under_n_chars`, `chunk_multipage_sections`.

Run on demand via the UI:
- In the right panel, use the “New Run” card to pick a PDF, set pages and strategy, choose `basic` or `by_title` chunking, tweak advanced parameters, then click Run.
- The server slices the PDF, runs Unstructured, writes artifacts in `outputs/unstructured/`, and refreshes the run list. The latest run per slug is shown.
 - The New Run modal includes a live PDF preview from `res` with prev/next controls and quick buttons to “Add page” or mark a start/end to append a page range to the Pages field. Advanced chunking controls now expose both `basic` and `by_title` strategies plus every Unstructured flag (including approximate `max_tokens`, `include_orig_elements`, `overlap_all`, and `multipage_sections`).
 - To compare strategies on the same slice, click “Re-Run (clone)” in the header. It pre-fills the same PDF and pages; add an optional Variant tag (e.g., `hires-2k`) to keep results side-by-side. Artifacts are saved under a variant slug like `<slug>__hires-2k`.
 - Per-table highlighting uses distinct colors per selected chunk so multi-page/multi-chunk tables are easy to see; the overlay legend reflects element types present on the current page.
 - Use the header “Cleanup outputs” button (or `POST /api/cleanup`) to remove orphaned files under `outputs/unstructured/` that are no longer referenced by runs.
