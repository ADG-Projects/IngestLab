# Repository Guidelines

## Project Structure & Module Organization
Repository root keeps runnable helpers alongside documentation for fast iteration.

- `scripts/preview_unstructured_pages.py` — fast page slicing + gold-table comparisons.
- `web/` — Chunking Visualizer (FastAPI + static UI):
  - `main.py` FastAPI app exposing JSON endpoints and serving the UI.
  - `web/static/` static assets (no bundler): `index.html`, `styles.css`, `app.js`.
  - `web/static/vendor/pdfjs/` vendor-pinned pdf.js (autofetched if missing).
- PDF fixtures live in `res/`, curated references in `dataset/`, and generated artifacts in `outputs/` (use `outputs/unstructured/` for JSONL runs).

`README.md`, `TODO.md`, and `database-schema.md` must move in lockstep with any new capability so contributors and evaluators stay aligned.

## Build, Test, and Development Commands
Install everything with `uv sync`; it resolves `unstructured[pdf]` and wires the local `.venv`.

Targeted QA of extraction/chunker:

```bash
uv run python scripts/preview_unstructured_pages.py \
  --input res/<pdf>.pdf --pages 4-6 --only-tables \
  --output outputs/unstructured/<slug>.pagesX-Y.tables.jsonl \
  --gold dataset/gold.jsonl \
  --emit-matches outputs/unstructured/<slug>.matches.json
```

Run the visualizer locally:

```bash
uv run uvicorn main:app --reload --host 127.0.0.1 --port 8765
# open http://127.0.0.1:8765/
```

Keep datasets small by pruning `outputs/` artifacts that are not needed in Git history.

## Coding Style & Naming Conventions
Stick to idiomatic Python 3.10+, 4-space indentation, and f-strings for any dynamic text (Loguru also expects them). Favor explicit helper functions over inlined comprehensions when parsing structured payloads. Keep filenames descriptive without “test” unless they are true test modules, and use snake_case for functions, UPPER_SNAKE_CASE for constants, and kebab-case for output JSON artifacts (e.g., `V3_0_EN_4.matches.json`).

## Testing Guidelines
Primary validation happens through the preview script: capture JSONL outputs and inspect the generated cohesion/coverage metrics before shipping changes. When modifying table parsing, compare against `dataset/gold.jsonl` using `--emit-matches outputs/unstructured/<slug>.matches.json` to spot regressions. Prefer crafting reproducible page slices over large PDFs so reviewers can run `uv run python scripts/preview_unstructured_pages.py --input-jsonl <file>` quickly.

For UI changes, sanity-check by running the visualizer and verifying:
- PDF renders and overlays draw in the right place.
- Details drawer shows chunk HTML and per-chunk contribution metrics.
- “Highlight all/best” behaves without jumping pages unnecessarily.

## Commit & Pull Request Guidelines
Write imperative, scope-focused commits (e.g., “Add Unstructured preview helper”). Push incremental changes rather than a single mega-commit, and document noteworthy behavior in `TODO.md` (newest completed items first, timestamped). PRs should summarize motivation, detail command-level verification steps, and mention any dataset or schema tweaks. Include screenshots or metric diffs whenever output structure changes, and confirm no stray artifacts remain in `outputs/` before requesting review.

## Web UI Contribution Notes
- Keep the UI dependency-free (no build/bundle). Add small libs only via `<script>` tags if absolutely necessary.
- Use the existing endpoints; prefer `/api/elements/{slug}?ids=...` for box lookups rather than reading whole JSONL in the browser.
- Server caches a minimal element index per slug — reuse it; do not add heavy per-request scans.
- pdf.js is vendor-pinned to `3.11.174`; if you upgrade, update `ensure_pdfjs_assets()` and test Safari.
- Avoid committing large artifacts in `outputs/` — reference repro commands in PRs instead.

## Deployment Guide
Follow this deployment pipeline end to end:
1. Bump version indicators in the UI (header badge/version text) and code/metadata (pyproject, uv.lock, README release history, database-schema notes, TODO, etc.).
2. Commit the version bumps and any related changes.
3. Tag the release from that commit and push the tag and branch.
4. Open a PR with a clear, reviewer-friendly description of what changed and how to verify it.
5. Merge the PR into `main`.
6. Publish a GitHub release with a concise, accurate description of the changes.
