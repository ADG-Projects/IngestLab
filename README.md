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

Spin up a small local UI to inspect PDFs, table matching, and chunker performance without juggling multiple files. The server reads `PDF_DIR` to find a writable location for PDFs (defaults to `res/` locally). When deployed to Fly.io with a volume mounted at `/data`, set `PDF_DIR=/data/res` to persist uploads.

Quickstart:

```bash
uv sync
uv run uvicorn main:app --host 127.0.0.1 --port 8765
# open http://127.0.0.1:8765/
```

What you get:
- Two top-level views while keeping the PDF visible:
  - Metrics: run config, overall metrics bars, F1 chart, and table match cards with per-table actions (Highlight all/best, Details).
  - Inspect: focused tools for chunk and element inspection, with overlay toggles and type filter, plus sub-tabs for Chunks and Elements.
- Per-table cards with coverage, cohesion, F1, and chunk count, and one-click highlighting on the PDF from Metrics.
- A compact single-line settings recap with rich tooltips for each parameter; the New Run modal mirrors the same tooltips so behavior is clear where you edit values.
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
 - `POST /api/pdfs` — upload a PDF to `PDF_DIR` (auto-saves on selection in the New Run modal).
 - `GET /api/runs` — discover available runs under `outputs/unstructured/`.
 - `DELETE /api/run/{slug}` — delete a run by its UI slug.
 - `GET /api/matches/{slug}` — load the matches JSON.
 - `GET /api/tables/{slug}` — load and parse the tables JSONL.
 - `GET /pdf/{slug}` — stream the trimmed PDF.
- `GET /api/element_types/{slug}` — element type inventory for a run (counts by type).
- `GET /api/boxes/{slug}?page=N&types=Table,Text` — minimal per-page box index for overlays (server-side indexed, avoids heavy scans).
- `GET /api/chunks/{slug}` — chunk artifacts (summary + JSONL contents) for each run.
- `POST /api/run` — execute a new run. Body:
  - `pdf` (string, required): filename under `res/`.
  - `pages` (string, optional): page list/range (e.g., `4-6`, `4,5,6`). If omitted or blank, the server processes the entire document (equivalent to `1-<num_pages>`). The server trims the PDF first and only processes those pages.
  - `strategy` (`auto|fast|hi_res`, default `auto`).
  - `infer_table_structure` (bool, default `true`).
  - `chunking` (`basic|by_title`, default `by_title`). Additional knobs:
    - Shared: `chunk_max_characters`, `chunk_new_after_n_chars`, `chunk_overlap`, `chunk_include_orig_elements`, `chunk_overlap_all`.
    - Extra for `by_title`: `chunk_combine_under_n_chars`, `chunk_multipage_sections`.

Run on demand via the UI:
- In the right panel, use the “New Run” card to pick a PDF (or upload one — it uploads immediately after selection), set pages and strategy, choose `basic` or `by_title` chunking, tweak advanced parameters, then click Run.
- Leave the Pages field blank to chunk the entire PDF; the UI fills `1-<num_pages>` automatically when possible, and the server also falls back to the full range if the field is empty.
- The server slices the PDF, runs Unstructured, writes artifacts in `outputs/unstructured/`, and refreshes the run list. The latest run per slug is shown.
- The New Run modal includes a live PDF preview from `res` with prev/next controls and quick buttons to “Add page” or mark a start/end to append a page range to the Pages field. Advanced chunking controls now expose both `basic` and `by_title` strategies plus every Unstructured flag (including approximate `max_tokens`, `include_orig_elements`, `overlap_all`, and `multipage_sections`).
- Right next to the strategy dropdown, a Primary Language toggle lets you flag whether the document is predominantly English (default) or Arabic. Choosing Arabic prioritizes Arabic OCR (`ara+eng`), sets Unstructured’s `languages` hint to `["ar", "en"]`, enables per-element language detection, and makes the preview drawers render RTL so Arabic text stays readable.
- The Settings Recap bar mirrors all inputs from the New Run modal, including `max_tokens` (approximate), `max_characters`, `new_after_n_chars`, `combine_under_n_chars`, `overlap`, `include_orig_elements`, `overlap_all`, `multipage_sections`, and metadata like PDF, pages, and optional tag. New runs persist this snapshot under `run_config.form_snapshot`, while older runs fall back to whatever fields are available.
- Per-table highlighting uses distinct colors per selected chunk so multi-page/multi-chunk tables are easy to see; the overlay legend reflects element types present on the current page.

### Manage uploaded PDFs

- Delete a source PDF: in the New Run modal, use the Delete button next to the PDF selector to remove the selected file from the server’s `PDF_DIR` (defaults to `res/`). If any runs reference that PDF, you’ll be prompted to optionally delete all of them along with the PDF. Existing runs can be kept; they remain viewable because they reference trimmed copies in `outputs/unstructured/`.
- API: `DELETE /api/pdfs/{name}` removes a single `.pdf` from `PDF_DIR`.

### Fly.io deployment & persistent PDF uploads

The web server now reads a `PDF_DIR` environment variable to decide where uploads live. Locally it defaults to `res/`, but Fly deployments can mount a volume for shared storage:

```toml
# fly.toml
[env]
  PDF_DIR = "/data/res"

[mounts]
  source = "data"
  destination = "/data"
```

Provision the volume in the same region as your machine(s):

```bash
fly launch --no-deploy  # creates app + fly.toml if missing; pick region (e.g., fra)
fly volumes create data -r <region> --size 3  # persistent storage
fly deploy

Verify the mount and uploads directory in a shell on the machine:

```bash
fly ssh console -C 'ls -la /data && mkdir -p /data/res && ls -la /data/res'
```

Quick upload and verify via API (bypass the UI):

```bash
# Replace APP with your Fly app name
BASE=https://APP.fly.dev
curl -f -X POST -F file=@res/sample.pdf "$BASE/api/pdfs"
curl -f "$BASE/api/pdfs" | jq
```

Notes:
- The server creates `PDF_DIR` on startup if it doesn’t exist.
- `internal_port` is `8000` (set in `fly.toml`); Uvicorn binds to `0.0.0.0:8000` in the container.
- UI auto-fetches vendor `pdf.js` and `Chart.js` on first run if the local copies are missing; no CDN is required after that.
- The default install now includes `unstructured-inference` so hi_res layout is available when the platform provides the needed system libraries. On lightweight builders (Railpack/Nixpacks), if you see `ImportError: libGL.so.1` or OCR errors, either switch to the provided Dockerfile (recommended) or add the runtime packages `libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 tesseract-ocr`.

In the New Run modal, the “Upload PDF” row streams the chosen file straight into `PDF_DIR`. The file list refreshes immediately, and the preview loads from `/res_pdf/{name}` pointing at the mounted directory.

### Docker image (hi_res ready)

Use the included `Dockerfile` when you need hi_res chunking on platforms like Railway. It installs the native libraries (`libgl1`, `libglib2.0-0`, `libsm6`, `libxext6`, `libxrender1`, `tesseract-ocr`, `poppler-utils`, `libheif1`) and uses `uv sync --frozen` so the bundled `.venv` always matches `uv.lock`.

Build and test locally:

```bash
docker build -t chunking-tests:latest .
docker run -d --name chunking-tests-local -p 8765:8000 chunking-tests:latest
curl -sf http://localhost:8765/healthz
docker stop chunking-tests-local && docker rm chunking-tests-local
```

Hi_res is enabled by default inside the container. To produce a slimmed-down fast-only image, pass the build args exposed in the Dockerfile:

```bash
docker build -t chunking-tests:min \
  --build-arg WITH_HIRES=0 \
  --build-arg DISABLE_HI_RES=1 .
```

At runtime you can still set `DISABLE_HI_RES=1` to force the `strategy=fast` path without rebuilding the image.

### Railway deployment & volumes

Railway mounts a persistent directory into the container. This app looks for the following env vars to place files onto that volume:

- `PDF_DIR` — directory for source PDFs (uploads). If unset and `DATA_DIR` is set, defaults to `$DATA_DIR/pdfs`.
- `OUTPUT_DIR` or `OUT_DIR` — directory for run artifacts (trimmed PDFs, JSONL, matches). If unset and `DATA_DIR` is set, defaults to `$DATA_DIR/outputs/unstructured`.
- `PORT` — the port Uvicorn binds to (Railway sets this automatically).

Recommended setup in the Railway service:

1. Add a Volume and mount it at `/data`.
2. Set env vars:
   - `DATA_DIR=/data`
   - (optional) override `PDF_DIR` or `OUTPUT_DIR` explicitly if you prefer different subfolders.
3. Deploy using this repo’s Dockerfile so the hi_res dependencies (libGL/Tesseract/Poppler) ship with the image. Set Railway’s service to Docker, point it at the repository, and it will build with the same `docker build` invocation as above. If you must stick with the Python/Nixpacks builder, set Start Command to `uvicorn main:app --host 0.0.0.0 --port $PORT` and ensure the apt packages match those listed in the Dockerfile, or flip `DISABLE_HI_RES=1` to force the lightweight path.

If you deploy with Railway’s default Nixpacks builder and still hit an OpenCV error like `ImportError: libGL.so.1`, use `nixpacks.toml`. It replaces `opencv-python` with `opencv-python-headless` during the install phase so no system `libGL` is required, but hi_res will remain unavailable unless you install the rest of the native dependencies manually.

Operational notes:
- The server creates missing directories on startup/use.
- Volumes are per‑instance; for shared state across instances, use object storage.
