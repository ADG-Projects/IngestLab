# TODO

## Upcoming
- [ ] Compare output quality between Unstructured and the Azure Document Intelligence SDK.

## Completed
- [x] 2025-11-14 Remove the header Re-Run/cleanup controls (UI + API) and rename the Delete button to “Delete run” so the toolbar only exposes new-run + delete actions.
- [x] 2025-11-14 Default empty Pages to full document (UI + API): leaving Pages blank now processes `1-<num_pages>` automatically; tooltip/placeholder updated and README documents the behavior.
- [x] 2025-11-14 Add delete for uploaded PDFs (UI button + API `DELETE /api/pdfs/{name}`) and guard preview when a file is removed.
- [x] 2025-11-14 Add Primary Language toggle (English vs Arabic), wire OCR defaults, and right-align previews for Arabic documents.
- [x] 2025-11-13 Auto-upload PDFs on file selection and store them on Fly volume via `PDF_DIR`; removed separate Upload button and fixed file chooser/tooltip and checkbox UI quirks.
- [x] 2025-11-13 Enable Fly volume-backed PDF uploads: server honors `PDF_DIR`, Fly config mounts `/data`, UI uploads instantly without a button, and docs cover the flow.
- [x] 2025-11-13 Compact single-line settings recap with rich tooltips; add matching tooltips to the New Run modal.
- [x] 2025-11-13 Persist the New Run modal snapshot (PDF/pages/tag plus chunk flags like max_tokens) into matches.json so the recap bar always reflects every parameter.
- [x] 2025-11-13 Derive per-row table chunk boxes (server + UI) so multi-chunk tables highlight distinct slices instead of overlapping.
- [x] 2025-11-13 Add overlay tooltips (hover shows ID/type/page and chunk length) and switch overlay colors to fixed per-type CSS classes.
- [x] 2025-11-13 Elements list shows per-type colors and inline text preview; display original element IDs instead of internal stable IDs.
- [x] 2025-11-13 Simplify Inspect controls: tabs now drive overlays (Chunks vs Elements); removed redundant toggles and quick type filter.
- [x] 2025-11-13 Overlay interactions: clicking a box opens element/chunk details; chunk cards expand to show their source elements, and clicking those opens element details and focuses the overlay.
- [x] 2025-11-13 UX tweaks: chunk overlay click mirrors chunk card (expand/focus, no drawer); closing an element opened from a chunk returns to the same chunk list position.
- [x] 2025-11-13 Split UI into two top-level tabs (Metrics and Inspect); keep PDF visible in both; move overlay controls into Inspect and separate table metrics from chunk/element inspection.
- [x] 2025-11-13 Remove tables-only workflow: chunking (basic or by_title) is now mandatory and its parameters are fully driven from CLI, API, and UI.
- [x] 2025-11-13 Expose both Unstructured chunking strategies (basic/by_title) plus all advanced parameters (max tokens/chars, overlap, multipage, include_orig_elements) across CLI, API, and UI.
- [x] 2025-11-12 Add Elements tab with type filters and per-page box overlays; add quick toolbar (Show boxes + Type) above the PDF; add toast notifications for run/errors.
- [x] 2025-11-12 Support clone re-runs with variant tag to compare strategies on same slice; colorize per-chunk overlays for multi-chunk tables across pages.
- [x] 2025-11-12 Surface chunk-by-title outputs in UI: record run config/summary, add Chunks tab with summary + chunk list, and expose chunk metadata via new API endpoints.
- [x] 2025-11-12 Refactor UI: header run picker + New Run modal, tabbed right panel (Overview with metrics/chart, Tables with cards) for clearer separation and future element types.
- [x] 2025-11-12 Add on-demand Unstructured runs from the UI (PDF selection, page ranges via true PDF slicing, strategy toggle, infer-table checkbox, optional by-title chunking with advanced params).
- [x] 2025-11-12 Add FastAPI endpoints for new runs (`GET /api/pdfs`, `POST /api/run`) and wire to preview script via `uv run`.
- [x] 2025-11-12 Replace global highlight toggle with per-table buttons (Highlight all / Highlight best) for clearer intent.
- [x] 2025-11-12 Add per-chunk contribution display in Details (coverage, cohesion impact, solo-F1 vs table F1) and tags on chips.
- [x] 2025-11-12 Add drilldown UI to preview extracted Unstructured table HTML per chunk (best + selected).
- [x] 2025-11-12 Optimize web UI load time: lazy-fetch element boxes, cache minimal index server-side, and enable PDF.js worker.
- [x] 2025-11-12 Add web UI to visualize PDFs, table matches, and chunker performance (FastAPI + static UI).
- [x] 2025-11-12 Rename per-element similarity metric outputs to `cohesion` for consistency.
- [x] 2025-11-12 Add explicit coverage/cohesion per table and overall summary to matches JSON.
- [x] 2025-11-12 Add F1-like `chunker_f1` metric to matches output for overall table chunking quality.
- [x] 2025-11-12 Auto-match Unstructured table slices to `dataset/gold.jsonl` via the preview script.
- [x] 2025-10-23 Document local Unstructured PDF processing with optional page cap.
