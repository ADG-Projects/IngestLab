# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ChunkingTests is a document ingestion sandbox that enables side-by-side comparison of layout extraction and OCR quality across multiple providers:

- **Unstructured** (local open-source chunker)
- **Unstructured Partition API** (hosted elements-only service)
- **Azure Document Intelligence** (Layout with OCR)

The project includes an interactive web visualizer for inspecting PDFs, evaluating chunking performance, and collecting structured feedback with LLM-powered analysis.

## Architecture

**Backend**: FastAPI server (`web/server.py`) with provider-specific pipelines:

- `chunking_pipeline/pipeline.py` — Unstructured partitioning + chunking
- `chunking_pipeline/azure_pipeline.py` — Azure Document Intelligence runner
- `chunking_pipeline/unstructured_partition_pipeline.py` — Hosted Partition API

**Frontend**: Vanilla JavaScript modules (`web/static/app-*.js`) with no build step. PDF.js renders documents while SVG overlays display element/chunk bounding boxes.

**Data flow**: PDF → provider SDK → elements/chunks JSONL → UI overlay. Artifacts stored under `outputs/<provider>/`.

## Build, Test, and Development Commands

Install dependencies:

```bash
uv sync
```

Run the visualizer locally:

```bash
uv run uvicorn main:app --reload --host 127.0.0.1 --port 8765
# open http://127.0.0.1:8765/
```

Targeted QA with gold-table matching:

```bash
uv run python scripts/preview_unstructured_pages.py \
  --input res/<pdf>.pdf --pages 4-6 --only-tables \
  --output outputs/unstructured/<slug>.pagesX-Y.tables.jsonl \
  --gold dataset/gold.jsonl \
  --emit-matches outputs/unstructured/<slug>.matches.json
```

Azure Document Intelligence CLI:

```bash
AZURE_FT_ENDPOINT=<endpoint> AZURE_FT_KEY=<key> \
uv run python -m chunking_pipeline.azure_pipeline \
  --provider document_intelligence \
  --input res/sample.pdf --pages 1-5 \
  --output outputs/azure/document_intelligence/sample.chunks.jsonl
```

Docker build and test:

```bash
docker build -t chunking-tests:latest .
docker run -d -p 8765:8000 chunking-tests:latest
curl http://localhost:8765/healthz
```

## Branching Strategy

- **`main`** — stable release branch; receives PRs from `dev` or feature branches.
- **`dev`** — active development branch; day-to-day work happens here.
- Feature branches are created from `dev` and merged back via PR to `main`.
- Feature branches are to be merged to `dev` directly (without a PR).
- Releases are tagged from `main` after merging.

## Project Structure

- `main.py` — FastAPI entry point (loads .env, starts Uvicorn)
- `web/` — Server and static UI assets
  - `server.py` — FastAPI app, middleware, routes
  - `routes/` — API endpoint routers (runs, pdfs, chunks, elements, reviews, feedback)
  - `static/` — Modular JS (`app-state.js`, `app-overlays.js`, `app-reviews.js`, etc.)
  - `static/vendor/pdfjs/` — vendor-pinned PDF.js (autofetched if missing)
- `chunking_pipeline/` — Core processing logic for each provider
- `scripts/` — CLI helpers for targeted QA
- `res/` — Source PDFs
- `dataset/` — Curated references (`gold.jsonl` for table matching)
- `outputs/` — Generated artifacts (not committed)

`README.md`, `TODO.md`, and `database-schema.md` must move in lockstep with any new capability.

## Coding Style & Conventions

- Python 3.10+, 4-space indentation, f-strings for all dynamic text
- Naming: `snake_case` for functions, `UPPER_SNAKE_CASE` for constants, `kebab-case` for output JSON artifacts
- No "test" in filenames unless they are true pytest modules
- Favor explicit helper functions over inlined comprehensions when parsing structured payloads

## Validation & Testing

Primary validation via preview script—capture JSONL outputs and inspect cohesion/coverage metrics before shipping changes. Compare against `dataset/gold.jsonl` using `--emit-matches` to spot regressions.

For UI changes, verify:

- PDF renders and overlays draw in the right place
- Details drawer shows chunk HTML and contribution metrics
- "Highlight all/best" behaves without jumping pages unnecessarily

## Web UI Contribution Notes

- Keep the UI dependency-free (no build/bundle). Add small libs only via `<script>` tags if necessary.
- Use existing endpoints; prefer `/api/elements/{slug}?ids=...` for box lookups rather than reading whole JSONL in browser.
- Server caches a minimal element index per slug—reuse it; do not add heavy per-request scans.
- PDF.js is vendor-pinned to `3.11.174`; if upgrading, update `ensure_pdfjs_assets()` and test Safari.
- Avoid committing large artifacts in `outputs/`—reference repro commands in PRs instead.

## Deployment Guide

New deployments have to be backwards compatible with existing data (for ex., we had a situation where old runs were not being discovered anymore because we were scanning for different files and provider names had changed).

1. Bump version in UI (header badge), code/metadata (pyproject.toml, uv.lock, README release history, database-schema notes, TODO).
2. Write release notes into the version "what's new" modal.
3. Commit the version bumps and any related changes.
4. Tag the release from that commit and push the tag and branch.
5. Open a PR with a clear, reviewer-friendly description of what changed and how to verify it.
6. Merge the PR into `main`.
7. Publish a GitHub release with a concise, accurate description of the changes.
