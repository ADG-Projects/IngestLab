# ChunkingTests

Local playground for document ingestion experiments. It now supports the open-source Unstructured chunker, the hosted Unstructured Partition API (elements-only), and Azure providers (Document Intelligence Layout; Content Understanding remains CLI-only and is disabled in the UI) so you can compare layout/ocr quality side by side.

Two helper scripts exist today:
- `process_unstructured.py`: interactive full-document runs against Unstructured.
- `scripts/preview_unstructured_pages.py`: fast page slicing + gold-table matching for targeted QA (Unstructured).
- `python -m chunking_pipeline.azure_pipeline`: run Azure Document Intelligence (`--provider document_intelligence`) or Content Understanding (`--provider content_understanding`) straight from the CLI.
- Azure Document Intelligence exports paragraph roles as element types (e.g., `pageHeader`, `pageNumber`, `title`) so the UI type filters mirror the service categorization.

## Prerequisites

- macOS or Linux with Python 3.10+.
- [uv](https://github.com/astral-sh/uv) for dependency management (already expected in this repo).

## Setup

```bash
uv sync
```

`uv sync` creates a `.venv` in the project root and installs all required packages, including `unstructured[pdf]` and `azure-ai-documentintelligence`.

### Unstructured Partition (API) credentials

Set the hosted Partition API base URL and key (elements-only provider) in your environment or `.env`:

```
UNSTRUCTURED_PARTITION_API_URL=https://api.unstructured.io/general/v0/general
UNSTRUCTURED_PARTITION_API_KEY=<your-key>
```

If you omit these, the Partition provider will fail fast in the worker.
The Partition provider uses the official SDK client, fetches coordinates, and emits elements-only artifacts (the UI hides the Chunks tab for this provider but still renders overlays from the returned elements). Strategies available: `auto`, `fast`, `hi_res`, `ocr_only`, and `vlm`.

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

## Azure runs (Document Intelligence + Content Understanding)

Set the Azure credentials before running either via CLI or the UI. You can drop them into a local `.env` (see `.env.example`) and they will be auto-loaded by the app and the CLI helpers. Foundry deployments use a single endpoint/key for both providers:
- `AZURE_FT_ENDPOINT` / `AZURE_FT_KEY`

When Azure language detection is enabled (e.g., including `languages` in the features), detected locales are captured in `run_config` (persisted from the pipeline output) so reloading a run flips previews to RTL automatically for Arabic-heavy documents.
When Azure returns markdown (e.g., `output_content_format=markdown`), the Inspect drawers render the formatted markdown directly and fall back to plain text only when no richer content is present; table HTML still prefers `text_as_html` for accurate column order.

Document Intelligence runs target `api-version=2024-11-30` (v4.0); older service versions are not supported.

CLI example (Document Intelligence layout):
```bash
AZURE_FT_ENDPOINT=<endpoint> AZURE_FT_KEY=<key> \
uv run python -m chunking_pipeline.azure_pipeline \
  --provider document_intelligence \
  --input res/V3.0_Reviewed_translation_EN_full\ 4.pdf \
  --pages 4-6 \
  --output outputs/azure/document_intelligence/V3_0_EN_4.pages4-6.tables.jsonl \
  --trimmed-out outputs/azure/document_intelligence/V3_0_EN_4.pages4-6.pdf \
  --emit-matches outputs/azure/document_intelligence/V3_0_EN_4.pages4-6.matches.json \
  --model-id prebuilt-layout \
  --features ocrHighResolution,keyValuePairs,barcodes,formulas \
  --api-version 2024-11-30
```

CLI example (Content Understanding Document Search):
```bash
AZURE_FT_ENDPOINT=<endpoint> AZURE_FT_KEY=<key> \
uv run python -m chunking_pipeline.azure_pipeline \
  --provider content_understanding \
  --input res/V3.0_Reviewed_translation_EN_full\ 4.pdf \
  --pages 1-2 \
  --output outputs/azure/content_understanding/V3_0_EN_4.pages1-2.tables.jsonl \
  --trimmed-out outputs/azure/content_understanding/V3_0_EN_4.pages1-2.pdf \
  --emit-matches outputs/azure/content_understanding/V3_0_EN_4.pages1-2.matches.json \
  --model-id prebuilt-documentSearch \
  --api-version 2025-11-01
```

Outputs for Azure runs live under `outputs/azure/document_intelligence/` or `outputs/azure/content_understanding/` with the same filename suffix pattern used by Unstructured.
Reviews are stored per-provider (e.g., `outputs/azure/document_intelligence/reviews/<slug>.reviews.json`).
If you ever see Azure `.tables.jsonl` files that are empty, rerun the slice: the helper now uses the SDK's `as_dict` output and scales polygons to PDF points so overlays render correctly.

## Next ideas

- Evaluate additional ingestion pipelines (Azure AI Document Intelligence, AWS Textract, etc.) as new experiments land in this sandbox.

## Release history

- **v4.0 (2025-11-25)** – Added the Unstructured Partition (hosted) provider for elements-only runs in the UI/API and switched the Docker base image to ECR Public to avoid Docker Hub rate limits.
  - Verification steps:
    1. `uv run uvicorn main:app --host 127.0.0.1 --port 8765`, start a New Run with provider `Unstructured Partition (API)`, and confirm the UI processes elements-only (chunks tab hidden) while overlays render from returned elements.
    2. Inspect the generated artifacts under `outputs/unstructured/partition_api/` to confirm the run JSON and elements JSONL are stored without chunk outputs.
    3. `docker build -t chunking-tests:4.0 .` and verify the base image pulls from ECR Public without Docker Hub rate limit warnings.
- **v3.2 (2025-11-25)** – Bundled markdown/DOMPurify assets locally with a favicon, persisted Azure detected-language metadata for RTL-aware reloads, and fixed Azure tooltip positioning.
  - Verification steps:
    1. `uv run uvicorn main:app --host 127.0.0.1 --port 8765`, load an Azure run with markdown drawers and verify markdown still renders via the bundled assets and favicon shows in the tab.
    2. Reload an Azure run that includes `detected_languages` and confirm the UI flips to RTL when Arabic is present; inspect the run JSON to see the persisted detection fields.
    3. Hover tooltips on Azure overlays and confirm the tooltip aligns with the box (no off-by-one drift).
- **v3.1 (2025-11-25)** – Azure Inspect outline now treats paragraphs as containers for lines/words, keeps table/header/section parents consistent, and defaults nested children to collapsed so opening a parent only reveals one level at a time.
  - Verification steps:
    1. `uv run uvicorn main:app --host 127.0.0.1 --port 8765`, load an Azure Document Intelligence run (e.g., `V3-0_Reviewed.pages1-8`), switch Elements to Outline, and confirm paragraphs nest lines while tables and headers preserve their children lists.
    2. Expand a parent (table/paragraph/header) and verify only its direct children show; deeper descendants stay collapsed until manually toggled, and per-node expansion state persists while navigating pages.

- **v3.0 (2025-11-24)** – Azure providers now render markdown in drawers, honor detected languages for RTL, expose outline grouping and Document Intelligence paragraph roles, and overlays stay aligned after switching to chunk-only artifacts (Metrics/tables pipeline removed).
  - Verification steps:
    1. `uv run uvicorn main:app --host 127.0.0.1 --port 8765`, load an Azure run, and confirm Inspect overlays line up with trimmed PDFs while pageHeader/pageNumber/title types appear in filters and the Elements outline toggle groups items per page.
    2. Open chunk/element drawers with markdown payloads to verify sanitized rendering and fallback to plain text where markdown is absent; check an Arabic-heavy document flips drawers and previews to RTL based on detected languages.
    3. Start a new run (any provider) via the UI and confirm outputs are trimmed PDFs, chunk JSONL, and run metadata only, with no Metrics tab or matches/table artifacts.

- **v2.1 (2025-11-18)** – Persist actual Unstructured chunking defaults (max_characters, new_after_n_chars, overlap, overlap_all, include_orig_elements, combine_text_under_n_chars, multipage_sections) in `run_config` so the header recap mirrors the values the chunker actually used, and keep drawer table previews in their original chunker column order while cell text alignment still follows the document direction.
  - Verification steps:
    1. `uv run python -m chunking_pipeline.run_chunking --input res/<pdf>.pdf --pages 4-6 --emit-matches outputs/unstructured/<slug>.matches.json` and confirm the generated `matches.json` `run_config.chunk_params` object lists the default values even when no chunking flags were passed.
    2. `uv run uvicorn main:app --reload --host 127.0.0.1 --port 8765`, open an Arabic table match under Metrics, and verify the drawer columns match the PDF layout while each RTL cell text remains right-aligned.

- **v2.0 (2025-11-17)** – Introduced chunk/element review workflows (Good/Bad ratings with notes, filters, and summary chips) while refactoring the frontend into modular scripts so overlays, metrics, and drawers stay in lockstep.
  - Verification steps:
    1. `uv run uvicorn main:app --reload --host 127.0.0.1 --port 8765` and confirm you can add/edit chunk + element reviews, filter by rating, see the header chip update instantly, and watch chunk overlays hide/show with the Inspect filters.
    2. `uv run python scripts/preview_unstructured_pages.py --input res/<pdf>.pdf --pages 4-6 --only-tables --output outputs/unstructured/<slug>.pagesX-Y.tables.jsonl --gold dataset/gold.jsonl --emit-matches outputs/unstructured/<slug>.matches.json` to ensure the backend chunk exports driving the UI remain unchanged.

- **v1.1 (2025-11-17)** – Polished chunk overlays and drawer interactions so Metrics highlights respect the selected chunk, drawer-close restores the same chunk context, and highlight-all/best redraws from a clean slate before rerunning.
  - Verification steps:
    1. `uv run python scripts/preview_unstructured_pages.py --input res/<pdf>.pdf --pages 4-6 --only-tables --output outputs/unstructured/<slug>.pagesX-Y.tables.jsonl --gold dataset/gold.jsonl --emit-matches outputs/unstructured/<slug>.matches.json`
    2. `uv run uvicorn main:app --reload --host 127.0.0.1 --port 8765` and walk through the Metrics + Inspect views to confirm overlay redraws track the drawer selections.

## Web UI (Chunking Visualizer)

Spin up a small local UI to inspect PDFs, table matching, and chunker performance without juggling multiple files. The server reads `PDF_DIR` to find a writable location for PDFs (defaults to `res/` locally). When deployed to Fly.io with a volume mounted at `/data`, set `PDF_DIR=/data/res` to persist uploads.

The UI assets are now composed from targeted modules (`app-state.js`, `app-ui.js`, `app-reviews.js`, `app-overlays.js`, `app-metrics.js`, `app-elements.js`, `app-chunks.js`, `app-runs.js`, and a thin `app.js` entry) so each concern (state, overlays, reviews, element/chunk panels, run wiring) can evolve independently while `index.html` pulls them in sequentially.
When you start a run, the “New Run” modal collapses into a compact Running state: the form and preview hide, a small status block shows the current PDF name plus a hint that the window will close on completion, and the header “New Run” button switches to `Running…` while the request is in flight. Parameters are still captured in the backend `form_snapshot` and reflected in the Settings Recap bar once the run completes.

Quickstart:

```bash
uv sync
uv run uvicorn main:app --host 127.0.0.1 --port 8765
# open http://127.0.0.1:8765/
```

What you get:
- Inspect view that keeps the PDF visible with overlay toggles and tabs for Chunks and Elements; the Metrics/table visuals are retired in favor of chunk-first inspection.
- Provider-aware runs: pick Unstructured (local), Unstructured Partition (API, elements-only), or Azure Document Intelligence (Layout) in the New Run modal. (Azure Content Understanding is disabled in the UI; use the CLI helper if needed.) Azure runs hide chunking controls and expose model id, API version, features, locale, string index type, content format, and query fields. Outputs live under `outputs/azure/...`.
- A compact single-line settings recap with rich tooltips for each parameter; the New Run modal mirrors the same tooltips so behavior is clear where you edit values.
- Overlay UX: hover for ID/type/page/tooltips; colors are fixed per element type; chunk overlays honor Type/Review filters and redraw immediately; Azure polygons stay scaled to PDF points; the Elements outline groups Azure pageHeader/pageNumber/Tables/Paragraphs/Lines by page order with breadcrumbs in drawers.
- Reviews: leave Good/Bad ratings with optional notes for any chunk or element, filter by rating, and use the header chip to jump into scored items.
- Inspect → Chunks: browse chunk summary + list; selecting a chunk jumps to its page, shows its overlays, and expands its source elements; cards size to the amount of text.
- Inspect → Elements: filter by type, toggle outline mode (Azure), see original element IDs and inline previews, and switch overlays between chunk and element modes based on the active tab.

Data sources used by the UI:
- `outputs/<provider>/<slug>.run.json` — run metadata for the settings recap and language direction hints.
- `outputs/<provider>/<slug>.pagesX-Y.chunks.jsonl` — chunk artifacts (with element metadata and coordinates for overlays).
- `outputs/<provider>/<slug>.pagesX-Y.pdf` — trimmed PDF for display.
- `outputs/<provider>/reviews/<slug>.reviews.json` — optional persisted reviews per run.

Endpoints (served by FastAPI):
- `GET /api/pdfs` — list PDFs available in `res/` (for new runs).
- `POST /api/pdfs` — upload a PDF to `PDF_DIR` (auto-saves on selection in the New Run modal).
- `DELETE /api/pdfs/{name}` — delete a source PDF from `PDF_DIR`.
- `GET /api/runs` — discover available runs (Unstructured + Azure).
- `DELETE /api/run/{slug}?provider=...` — delete a run by its UI slug.
- `GET /pdf/{slug}?provider=...` — stream the trimmed PDF.
- `GET /api/chunks/{slug}?provider=...` — chunk artifacts (summary + JSONL contents) for each run.
- `GET /api/element_types/{slug}?provider=...` — element type inventory for a run (counts by type).
- `GET /api/boxes/{slug}?provider=...&page=N&types=Table,Text` — minimal per-page box index for overlays (server-side indexed, avoids heavy scans).
- `GET /api/element/{slug}/{element_id}?provider=...` — fetch a single element payload (including markdown/text/html fields) from chunk JSONL.
- `GET /api/elements/{slug}?ids=...&provider=...` — batch lookup for element overlay metadata.
- `GET /api/reviews/{slug}?provider=...` — retrieve persisted reviews for chunks/elements.
- `POST /api/reviews/{slug}?provider=...` — write reviews for chunks/elements.
- `GET /api/run-jobs` — inspect the current queue of chunking jobs (status, timestamps, latest log tail).
- `GET /api/run-jobs/{job_id}` — poll a specific job for live status/log updates; used by the UI progress view.
- `POST /api/run` — execute a new run. Body:
  - `pdf` (string, required): filename under `res/`.
  - `pages` (string, optional): page list/range (e.g., `4-6`, `4,5,6`). If omitted or blank, the server processes the entire document (equivalent to `1-<num_pages>`). The server trims the PDF first and only processes those pages.
  - `provider` (`unstructured|unstructured-partition|azure-di|azure-cu`, default `unstructured`).
  - Unstructured: `strategy` (`auto|fast|hi_res`, default `auto`); `infer_table_structure` (bool, default `true`); `chunking` (`basic|by_title`, default `by_title`) plus the chunking knobs (`chunk_max_characters`, `chunk_new_after_n_chars`, `chunk_overlap`, `chunk_include_orig_elements`, `chunk_overlap_all`, `chunk_combine_under_n_chars`, `chunk_multipage_sections`).
  - Unstructured Partition (API): elements-only; honors `strategy` (`auto|fast|hi_res`) and optional `languages` while emitting raw element lines in `*.chunks.jsonl` (no local chunking is applied).
  - Azure: `model_id`, `api_version`, `features`, `locale`, `string_index_type`, `output_content_format`, `query_fields`, and (for Content Understanding) `analyzer_id`. Chunking flags are ignored for Azure providers.
  - Response: immediately returns a `job` payload (`id`, `status`, `command`, log tails) instead of blocking until the chunker finishes. Use `/api/run-jobs/{id}` to poll; the UI already handles this automatically.

Run on demand via the UI:
- In the right panel, use the “New Run” card to pick a PDF (or upload one — it uploads immediately after selection), set pages and strategy, choose `basic` or `by_title` chunking, tweak advanced parameters, then click Run.
- Leave the Pages field blank to chunk the entire PDF; the UI fills `1-<num_pages>` automatically when possible, and the server also falls back to the full range if the field is empty.
- Runs are now queued asynchronously. The modal switches into a compact “Running…” view that polls `/api/run-jobs/{id}`, streams stderr/stdout tails directly inside the dialog, and only closes once the chunker finishes successfully.
- The server slices the PDF, runs the selected provider, writes artifacts under `outputs/<provider>/`, and refreshes the run list. The latest run per slug is shown.
- The New Run modal includes a live PDF preview from `res` with prev/next controls and quick buttons to “Add page” or mark a start/end to append a page range to the Pages field. Advanced chunking controls now expose both `basic` and `by_title` strategies plus every Unstructured flag (including approximate `max_tokens`, `include_orig_elements`, `overlap_all`, and `multipage_sections`).
- Right next to the strategy dropdown, a Primary Language toggle lets you flag whether the document is predominantly English (default) or Arabic. Choosing Arabic prioritizes Arabic OCR (`ara+eng`), sets Unstructured’s `languages` hint to `["ar", "en"]`, enables per-element language detection, and makes the preview drawers render RTL so Arabic text stays readable.
- The Settings Recap bar mirrors all inputs from the New Run modal, including `max_tokens` (approximate), `max_characters`, `new_after_n_chars`, `combine_under_n_chars`, `overlap`, `include_orig_elements`, `overlap_all`, `multipage_sections`, and metadata like PDF, pages, and optional tag. New runs persist this snapshot under `run_config.form_snapshot`, while older runs fall back to whatever fields are available.
- Overlays use fixed per-type colors; the legend reflects element types present on the current page.

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
- `OUTPUT_DIR` or `OUT_DIR` — directory for run artifacts (trimmed PDFs, JSONL, reviews; preview scripts may also emit matches). If unset and `DATA_DIR` is set, defaults to `$DATA_DIR/outputs/unstructured`.
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
