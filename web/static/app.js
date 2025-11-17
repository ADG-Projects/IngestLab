let PDF_DOC = null;
let CURRENT_PAGE = 1;
let PAGE_COUNT = 0;
let SCALE = 1.0; // Will be adjusted to fit viewport
let CURRENT_SLUG = null;
let BOX_INDEX = {}; // element_id -> {page_trimmed, layout_w,h, x,y,w,h}
let MATCHES = null;
let LAST_SELECTED_MATCH = null;
let CHART_INSTANCE = null;
let LAST_CHART_MATCHES = [];
let CURRENT_ELEMENT_ID = null;
let CHIP_META = {}; // element_id -> meta from /api/elements
let LAST_HIGHLIGHT_MODE = 'all'; // 'all' | 'best'
let KNOWN_PDFS = [];
let CURRENT_TAB = 'overview';
let ELEMENT_TYPES = [];
let CHUNK_TYPES = [];
let CURRENT_TYPE_FILTER = 'All';
let CURRENT_CHUNK_TYPE_FILTER = 'All';
let SHOW_UNMATCHED = false;
let RUNS_CACHE = [];
let CURRENT_RUN = null;
let CURRENT_RUN_CONFIG = null;
let CURRENT_RUN_HAS_CHUNKS = false;
let CURRENT_CHUNKS = null;
let CURRENT_CHUNK_LOOKUP = {};
let SHOW_CHUNK_OVERLAYS = true;
let SHOW_ELEMENT_OVERLAYS = true;
// Top-level view: 'metrics' or 'inspect'
let CURRENT_VIEW = 'metrics';
// Inspect sub-tab: 'chunks' or 'elements'
let INSPECT_TAB = 'elements';
let CURRENT_INSPECT_ELEMENT_ID = null; // selected element id in Inspect->Elements
let RUN_PREVIEW_DOC = null;
let RUN_PREVIEW_PAGE = 1;
let RUN_PREVIEW_COUNT = 0;
let RUN_RANGE_START = null;
let HINTED_HIRES = false;
let RETURN_TO = null; // navigation context for closing drawers
let CURRENT_DOC_LANGUAGE = 'eng';

const RTL_AWARE_ELEMENTS = new Set();

const $ = (id) => document.getElementById(id);

function isArabicDocument() {
  return CURRENT_DOC_LANGUAGE === 'ara';
}

function applyDirectionalText(element, options={}) {
  if (!element) return;
  const { align=true, bidi=true, attr=true, track=true } = options;
  const rtl = isArabicDocument();
  const dirValue = rtl ? 'rtl' : 'ltr';
  if (attr !== false) {
    try { element.setAttribute('dir', dirValue); } catch (_) {}
  }
  if (element.style) {
    element.style.direction = dirValue;
    if (align) element.style.textAlign = rtl ? 'right' : 'left';
    if (bidi) element.style.unicodeBidi = 'plaintext';
  }
  if (track) RTL_AWARE_ELEMENTS.add(element);
}

function refreshDirectionalElements() {
  for (const el of Array.from(RTL_AWARE_ELEMENTS)) {
    if (!el.isConnected) {
      RTL_AWARE_ELEMENTS.delete(el);
      continue;
    }
    applyDirectionalText(el, { track: false });
  }
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
  return r.json();
}

function applyLanguageDirection() {
  const body = document.body;
  const preview = $('preview');
  if (!body || !preview) return;
  const isArabic = isArabicDocument();
  console.log('[RTL Debug] applyLanguageDirection called:', {
    CURRENT_DOC_LANGUAGE,
    isArabic,
    hasBodyClass: body.classList.contains('rtl-preview'),
    hasPreviewClass: preview.classList.contains('rtl-preview')
  });
  body.classList.remove('rtl-preview');
  preview.classList.toggle('rtl-preview', isArabic);
  refreshDirectionalElements();
  console.log('[RTL Debug] After toggle:', {
    hasBodyClass: body.classList.contains('rtl-preview'),
    hasPreviewClass: preview.classList.contains('rtl-preview')
  });
}

function normalizeLangCode(value) {
  if (value === undefined || value === null) return null;
  const txt = String(value).trim().toLowerCase();
  if (!txt) return null;
  if (txt.startsWith('ar')) return 'ara';
  if (txt.startsWith('en')) return 'eng';
  return null;
}

function extractLangFromList(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const part of value) {
      const code = normalizeLangCode(part);
      if (code) return code;
    }
    return null;
  }
  if (typeof value === 'string') {
    const parts = value.split(/[\s,;+]+/);
    for (const part of parts) {
      const code = normalizeLangCode(part);
      if (code) return code;
    }
  }
  return null;
}

function resolvePrimaryLanguage(cfg, snap) {
  return (
    normalizeLangCode(snap?.primary_language) ||
    normalizeLangCode(cfg?.primary_language) ||
    extractLangFromList(snap?.languages) ||
    extractLangFromList(cfg?.languages) ||
    normalizeLangCode(snap?.ocr_languages) ||
    normalizeLangCode(cfg?.ocr_languages) ||
    'eng'
  );
}

function setMetric(idBase, value) {
  const pct = Math.round((value || 0) * 100);
  $(idBase).style.width = `${pct}%`;
  $(`${idBase}v`).textContent = `${(value || 0).toFixed(3)} (${pct}%)`;
}

function renderMetrics(overall) {
  setMetric('mcov', overall.avg_coverage);
  setMetric('mcoh', overall.avg_cohesion);
  setMetric('mf1', overall.avg_chunker_f1);
  setMetric('mmicro', overall.micro_coverage);
}

function buildChart(matches) {
  LAST_CHART_MATCHES = matches || [];
  const canvas = document.getElementById('chart');
  if (!canvas) return;
  if (!window.Chart) {
    const ready = window.__chartReady;
    if (ready && typeof ready.then === 'function' && !ready.__chunkVizChartHooked) {
      ready.__chunkVizChartHooked = true;
      ready.then(() => {
        if (window.Chart) buildChart(LAST_CHART_MATCHES);
      }).catch(() => {});
    }
    return;
  }
  const labels = LAST_CHART_MATCHES.map(m => m.gold_title || m.gold_table_id);
  const data = LAST_CHART_MATCHES.map(m => Number(m.chunker_f1 || 0));
  if (CHART_INSTANCE) {
    try { CHART_INSTANCE.destroy(); } catch (e) {}
    CHART_INSTANCE = null;
  }
  CHART_INSTANCE = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Chunker F1', data, backgroundColor: '#6bbcff' }]},
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 1 } } }
  });
}

function pxRect(points) {
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  return { x, y, w, h };
}

function clearBoxes() {
  const overlay = $('overlay');
  overlay.innerHTML = '';
}

function addBox(rect, layoutW, layoutH, isBest=false, type=null, color=null, variant='chunk', meta=null) {
  const overlay = $('overlay');
  const canvas = $('pdfCanvas');
  const scaleX = canvas.width / layoutW;
  const scaleY = canvas.height / layoutH;
  const el = document.createElement('div');
  const typeClass = type ? ` type-${String(type).replace(/[^A-Za-z0-9_-]/g,'')}` : '';
  el.className = 'box' + (isBest ? ' best' : '') + typeClass;
  if (variant === 'orig') {
    el.classList.add('orig');
  }
  // Colors are now hardcoded via CSS by type class; ignore dynamic color
  el.style.left = `${rect.x * scaleX}px`;
  el.style.top = `${rect.y * scaleY}px`;
  el.style.width = `${rect.w * scaleX}px`;
  el.style.height = `${rect.h * scaleY}px`;

  // Tooltip
  const info = meta || {};
  const kind = info.kind || (variant === 'orig' ? 'element' : 'chunk');
  const shortId = (info.id && String(info.id).length > 22) ? `${String(info.id).slice(0, 18)}…` : (info.id || null);
  const titleLines = [];
  if (shortId) titleLines.push(`${kind === 'chunk' ? 'Chunk' : 'Element'} ${shortId}`);
  if (info.type) titleLines.push(`type: ${info.type}`);
  if (Number.isFinite(info.page)) titleLines.push(`page: ${info.page}`);
  if (kind === 'chunk' && Number.isFinite(info.chars)) titleLines.push(`chars: ${info.chars}`);
  if (info.extra) titleLines.push(String(info.extra));
  const tipText = titleLines.join(' · ');
  if (tipText) el.title = tipText; // fallback native tooltip
  const tip = document.createElement('div');
  tip.className = 'box-tip';
  tip.textContent = tipText || (kind === 'chunk' ? 'Chunk' : 'Element');
  el.appendChild(tip);

  // Dataset + click handler to open details from overlay
  el.dataset.kind = kind;
  if (info && info.id) el.dataset.id = String(info.id);
  if (info && info.origId) el.dataset.origId = String(info.origId);
  if (Number.isFinite(info.page)) el.dataset.page = String(info.page);
  el.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const k = el.dataset.kind;
    if (k === 'chunk') {
      const cid = el.dataset.id;
      if (cid) {
        await focusChunkFromOverlay(cid);
        await openChunkDetails(cid);
      }
      return;
    }
    // Element overlay: prefer stable id; fallback to origId mapping
    const stableId = el.dataset.id;
    const page = Number(el.dataset.page || CURRENT_PAGE);
    let targetId = stableId;
    if (!targetId && el.dataset.origId) {
      targetId = await findStableIdByOrig(el.dataset.origId, page);
    }
    // If we click an element while in Chunks tab, remember to return here on close
    if (info && info.parentChunkId) {
      const listElRef = document.getElementById('chunkList');
      RETURN_TO = { kind: 'chunk', id: info.parentChunkId, scrollTop: (listElRef ? listElRef.scrollTop : 0) };
    }
    if (targetId) {
      if (page && page !== CURRENT_PAGE) await renderPage(page);
      switchView('inspect');
      switchInspectTab('elements');
      CURRENT_INSPECT_ELEMENT_ID = targetId;
      await drawBoxesForCurrentPage();
      revealElementInList(targetId);
      await openElementDetails(targetId);
    }
  });
  overlay.appendChild(el);
}

function chunkBox(chunk) {
  if (!chunk) return null;
  if (chunk.segment_bbox) return chunk.segment_bbox;
  return chunk.bbox || null;
}

async function highlightForTable(tableMatch, bestOnly=false) {
  const targets = bestOnly
    ? [{ element_id: tableMatch.best_element_id, page_trimmed: tableMatch.best_page_trimmed }]
    : tableMatch.selected_elements;

  LAST_SELECTED_MATCH = tableMatch;
  LAST_HIGHLIGHT_MODE = bestOnly ? 'best' : 'all';

  // No longer fetch element boxes - we'll use chunk bboxes directly from CURRENT_CHUNK_LOOKUP

  const pages = new Set(targets.map(t => t.page_trimmed));
  const arr = [...pages];
  let pageToShow = CURRENT_PAGE;
  if (!pages.has(CURRENT_PAGE) && arr.length) {
    // Stay on current page if it contains the table; otherwise go to earliest page containing it
    pageToShow = Math.min(...arr);
  }
  if (pageToShow !== CURRENT_PAGE) {
    await renderPage(pageToShow);
  }
  drawTargetsOnPage(pageToShow, tableMatch, bestOnly);
}

function drawTargetsOnPage(pageNum, tableMatch, bestOnly=false) {
  clearBoxes();
  const targets = bestOnly
    ? [{ element_id: tableMatch.best_element_id, page_trimmed: tableMatch.best_page_trimmed }]
    : tableMatch.selected_elements;

  // Assign stable colors per chunk for this table
  const ids = Array.from(new Set(targets.map(t=>t.element_id).filter(Boolean)));
  const colorMap = {};
  ids.forEach((id) => { colorMap[id] = colorForId(id); });

  const chunkTypesPresent = new Set();
  const elementTypesPresent = new Set();

  for (const t of targets) {
    if (t.page_trimmed !== pageNum) continue;
    const ch = CURRENT_CHUNK_LOOKUP[t.element_id];
    const box = chunkBox(ch);
    if (!ch || !box) continue;
    if (box.page_trimmed !== pageNum) continue;
    const rect = { x: box.x, y: box.y, w: box.w, h: box.h };
    const isBest = bestOnly || t.element_id === tableMatch.best_element_id;
    if (SHOW_CHUNK_OVERLAYS) {
      const meta = {
        kind: 'chunk',
        id: t.element_id,
        type: ch.type,
        page: box.page_trimmed,
        chars: ch.char_len,
      };
      addBox(rect, box.layout_w, box.layout_h, isBest, ch.type, null, 'chunk', meta);
      if (ch.type) chunkTypesPresent.add(ch.type);
    }
    if (SHOW_ELEMENT_OVERLAYS) {
      drawOrigBoxesForChunk(t.element_id, pageNum, null);
      // Collect element types
      if (ch.orig_boxes) {
        for (const box of ch.orig_boxes) {
          if (box.page_trimmed === pageNum && box.type) {
            const t = String(box.type || '').toLowerCase();
            if (!t.includes('composite')) {
              elementTypesPresent.add(box.type);
            }
          }
        }
      }
    }
  }

  // Update legend - show both chunk and element types in metrics view
  const allTypes = new Set([...chunkTypesPresent, ...elementTypesPresent]);
  updateLegend(Array.from(allTypes));
}

function drawOrigBoxesForChunk(chunkId, pageNum, color) {
  if (!chunkId || !CURRENT_CHUNK_LOOKUP) return;
  const chunk = CURRENT_CHUNK_LOOKUP[chunkId];
  if (!chunk || !chunk.orig_boxes) return;
  const hasSegmentBox = Boolean(chunk.segment_bbox);
  for (const box of chunk.orig_boxes) {
    const t = String(box.type || '').toLowerCase();
    if (t.includes('composite')) continue; // avoid page-sized composite overlays
    if (hasSegmentBox && t.includes('table')) continue; // segment covers the table footprint already
    if (box.page_trimmed !== pageNum) continue;
    if (!(box.layout_w && box.layout_h)) continue;
    const rect = { x: box.x, y: box.y, w: box.w, h: box.h };
    const meta = { kind: 'element', id: null, origId: (box.orig_id || box.element_id || null), type: box.type, page: box.page_trimmed, parentChunkId: chunkId };
    addBox(rect, box.layout_w, box.layout_h, false, box.type, null, 'orig', meta);
  }
}

function drawChunksModeForPage(pageNum) {
  clearBoxes();
  const chunkTypesPresent = new Set();
  const elementTypesPresent = new Set();
  const selectedChunk = CURRENT_ELEMENT_ID ? CURRENT_CHUNK_LOOKUP[CURRENT_ELEMENT_ID] : null;
  if (SHOW_CHUNK_OVERLAYS && selectedChunk) {
    const box = chunkBox(selectedChunk);
    if (box && box.page_trimmed === pageNum) {
      const meta = { kind: 'chunk', id: selectedChunk.element_id, type: selectedChunk.type, page: box.page_trimmed, chars: selectedChunk.char_len };
      addBox({ x: box.x, y: box.y, w: box.w, h: box.h }, box.layout_w, box.layout_h, true, selectedChunk.type, null, 'chunk', meta);
      if (selectedChunk.type) chunkTypesPresent.add(selectedChunk.type);
    }
  }
  if (SHOW_ELEMENT_OVERLAYS && selectedChunk) {
    drawOrigBoxesForChunk(selectedChunk.element_id, pageNum, null);
    if (selectedChunk.orig_boxes) {
      for (const box of selectedChunk.orig_boxes) {
        if (box.page_trimmed === pageNum && box.type) {
          elementTypesPresent.add(box.type);
        }
      }
    }
  }
  // Update legend based on what's being shown
  const typesToShow = SHOW_ELEMENT_OVERLAYS && elementTypesPresent.size > 0
    ? Array.from(elementTypesPresent)
    : Array.from(chunkTypesPresent);
  updateLegend(typesToShow);
}

function redrawOverlaysForCurrentContext() {
  if (CURRENT_VIEW === 'inspect') {
    if (INSPECT_TAB === 'elements') {
      // Elements exploration: draw boxes for the current page and selected type
      drawBoxesForCurrentPage();
      return;
    }
    // Chunks exploration: show chunk bboxes and optional orig element boxes for selection
    drawChunksModeForPage(CURRENT_PAGE);
    return;
  }
  // Metrics view: only draw overlays for the selected table highlight; otherwise keep clean
  if (LAST_SELECTED_MATCH) {
    drawTargetsOnPage(CURRENT_PAGE, LAST_SELECTED_MATCH, LAST_HIGHLIGHT_MODE === 'best');
  } else {
    clearBoxes();
    updateLegend([]);
  }
}

function colorForId(id, idx=0) {
  // Hash id to hue; fallback to index
  let h = 0;
  if (id) {
    for (let i=0;i<id.length;i++) h = (h*31 + id.charCodeAt(i)) % 360;
  }
  if (!Number.isFinite(h)) h = 180; // stable fallback
  const rgb = hslToRgb(h/360, 0.65, 0.50);
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function hslToRgb(h, s, l){
  let r, g, b;
  if(s === 0){ r = g = b = l; }
  else {
    const hue2rgb = function hue2rgb(p, q, t){
      if(t < 0) t += 1;
      if(t > 1) t -= 1;
      if(t < 1/6) return p + (q - p) * 6 * t;
      if(t < 1/2) return q;
      if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
}

function renderMatchList(matches) {
  const list = $('matchList');
  list.innerHTML = '';
  for (const m of matches) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <div class="top">
        <div>
          <div class="title">${m.gold_title || m.gold_table_id}</div>
          <div class="meta">Pages: ${m.gold_pages?.join(', ') ?? '-'}</div>
        </div>
        <div class="actions">
          <button class="btn" data-act="highlight-all" title="Overlay all selected chunks">Highlight all</button>
          <button class="btn" data-act="highlight-best" title="Overlay only the best chunk">Highlight best</button>
          <button class="btn" data-act="details">Details</button>
        </div>
      </div>
      <div class="row" style="margin-top:8px">
        <span class="chip">cov ${(m.coverage||0).toFixed(2)}</span>
        <span class="chip">coh ${(m.cohesion||0).toFixed(2)}</span>
        <span class="chip ${m.selected_chunk_count>1 ? 'bad':''}">chunks ${m.selected_chunk_count}</span>
        <span class="chip">f1 ${(m.chunker_f1||0).toFixed(2)}</span>
      </div>
    `;
    div.querySelector('[data-act="highlight-all"]').addEventListener('click', () => {
      highlightForTable(m, false);
    });
    div.querySelector('[data-act="highlight-best"]').addEventListener('click', () => {
      highlightForTable(m, true);
    });
    div.querySelector('[data-act="details"]').addEventListener('click', () => {
      openDetails(m);
    });
    list.appendChild(div);
  }
}

function filteredMatches() {
  const arr = (MATCHES?.matches || []);
  if (SHOW_UNMATCHED) return arr;
  return arr.filter(m => (m.selected_elements && m.selected_elements.length > 0) || (m.selected_chunk_count > 0));
}

function computeMetrics(ms) {
  const n = ms.length;
  const zero = { avg_coverage: 0, avg_cohesion: 0, avg_chunker_f1: 0, micro_coverage: 0 };
  if (!n) return zero;
  const avg_cov = ms.reduce((s,m)=>s+Number(m.coverage ?? m.coverage_ratio ?? 0),0)/n;
  const avg_coh = ms.reduce((s,m)=>s+Number(m.cohesion||0),0)/n;
  const avg_f1 = ms.reduce((s,m)=>s+Number(m.chunker_f1||0),0)/n;
  const total_gold = ms.reduce((s,m)=>s+Number(m.gold_left_size||0),0);
  const total_cov = ms.reduce((s,m)=>s+Number(m.covered_count||0),0);
  const micro_cov = total_gold ? (total_cov/total_gold) : avg_cov;
  return { avg_coverage: avg_cov, avg_cohesion: avg_coh, avg_chunker_f1: avg_f1, micro_coverage: micro_cov };
}

function refreshMatchesView() {
  const ms = filteredMatches();
  renderMetrics(computeMetrics(ms));
  renderMatchList(ms);
  buildChart(ms);
}

function updateRunConfigCard() {
  // Update settings recap bar
  const cfg = CURRENT_RUN_CONFIG || CURRENT_RUN?.run_config;
  const set = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value;
  };
  if (!cfg) {
    ['Strategy','InferTables','Chunking','PrimaryLang','MaxTokens','MaxChars','NewAfter','CombineUnder','Overlap','IncludeOrig','OverlapAll','Multipage','Pdf','Pages','Tag']
      .forEach(name => set(`setting${name}`, '-'));
    CURRENT_DOC_LANGUAGE = 'eng';
    applyLanguageDirection();
    return;
  }
  const chunkParams = cfg.chunk_params || {};
  const snap = cfg.form_snapshot || cfg.ui_form || {};
  const fallback = (value, def) => {
    if (value === undefined || value === null || value === '') return def;
    return value;
  };
  set('settingStrategy', cfg.strategy || 'auto');
  set('settingInferTables', String(cfg.infer_table_structure !== false));
  set('settingChunking', cfg.chunking || 'by_title');
  const maxCharsRaw = fallback(chunkParams.max_characters, snap.max_characters);
  const mtSource = fallback(snap.max_tokens, chunkParams.max_tokens);
  const inferredTokens = (maxCharsRaw != null && Number.isFinite(Number(maxCharsRaw))) ? Math.round(Number(maxCharsRaw) / 4) : null;
  const maxTokens = (mtSource != null && Number.isFinite(Number(mtSource))) ? Number(mtSource) : inferredTokens;
  set('settingMaxTokens', maxTokens != null ? String(maxTokens) : '-');
  set('settingMaxChars', maxCharsRaw != null ? String(maxCharsRaw) : '500');
  set('settingNewAfter', fallback(chunkParams.new_after_n_chars, snap.new_after_n_chars) ?? '500');
  const combineVal = fallback(
    chunkParams.combine_under_n_chars,
    fallback(chunkParams.combine_text_under_n_chars, snap.combine_under_n_chars),
  );
  set('settingCombineUnder', combineVal ?? '500');
  const overlapVal = fallback(chunkParams.overlap, snap.overlap);
  set('settingOverlap', overlapVal ?? '0');
  const includeOrig = fallback(chunkParams.include_orig_elements, snap.include_orig_elements);
  set('settingIncludeOrig', String(includeOrig !== false));
  const overlapAll = fallback(chunkParams.overlap_all, snap.overlap_all);
  set('settingOverlapAll', String(Boolean(overlapAll)));
  const multipage = fallback(chunkParams.multipage_sections, snap.multipage_sections);
  set('settingMultipage', String(multipage !== false));
  const pages = CURRENT_RUN?.page_range || cfg.pages || snap.pages;
  set('settingPages', pages || '-');
  set('settingPdf', cfg.pdf || snap.pdf || (CURRENT_RUN?.slug?.split('.pages')[0] ?? '-'));
  set('settingTag', cfg.tag || snap.tag || snap.variant_tag || '-');
  const primaryLang = resolvePrimaryLanguage(cfg, snap);
  console.log('[RTL Debug] updateRunConfigCard:', { cfg, snap, primaryLang });
  CURRENT_DOC_LANGUAGE = primaryLang;
  set('settingPrimaryLang', primaryLang === 'ara' ? 'Arabic' : 'English');
  applyLanguageDirection();
}

async function openDetails(tableMatch) {
  LAST_SELECTED_MATCH = tableMatch;
  const title = tableMatch.gold_title || tableMatch.gold_table_id;
  $('drawerTitle').textContent = 'Unstructured Chunks';
  $('drawerMeta').innerHTML = `${title} · Source: Unstructured <span class="chip-tag">chunks ${tableMatch.selected_chunk_count}</span>`;
  // Build pretty summary bars for table-level metrics
  const sum = document.getElementById('drawerSummary');
  sum.innerHTML = '';
  const addRow = (label, val, tip) => {
    const row = document.createElement('div');
    row.className = 'mini-metric';
    row.innerHTML = `<div class="label">${label}${tip?` <span class=\"info\" tabindex=\"0\">i</span><div class=\"tip\">${tip}</div>`:''}</div><div class="bar"><div class="fill" style="width:${Math.round((val||0)*100)}%"></div></div><div class="value">${(val||0).toFixed(3)}</div>`;
    sum.appendChild(row);
  };
  addRow('Table coverage', Number(tableMatch.coverage ?? tableMatch.coverage_ratio ?? 0), 'Share of gold rows covered across the table\'s selected chunks.');
  addRow('Table cohesion', Number(tableMatch.cohesion || 0), '1 / selected_chunk_count — higher when the table stays in one chunk.');
  addRow('Table F1', Number(tableMatch.chunker_f1 || 0), 'Harmonic mean of table coverage and table cohesion.');
  const picker = $('elementPicker');
  picker.innerHTML = '';
  const bestId = tableMatch.best_element_id;
  const items = (tableMatch.selected_elements || []).map(s => s.element_id);
  const unique = Array.from(new Set([bestId, ...items].filter(Boolean)));
  if (unique.length) {
    CHIP_META = await fetchJSON(`/api/elements/${encodeURIComponent(CURRENT_SLUG)}?ids=${encodeURIComponent(unique.join(','))}`);
  } else {
    CHIP_META = {};
  }
  for (const id of unique) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const short = id.replace('chunk-', '…');
    const meta = CHIP_META[id] || {};
    const selInfo = (tableMatch.selected_elements || []).find(x => x.element_id === id) || {};
    const pTrim = selInfo.page_trimmed || meta.page_trimmed || '-';
    const cov = selInfo.row_overlap ?? selInfo.cohesion;
    const covTag = cov != null ? ` <span class=\"chip-tag\">cov ${(Number(cov)||0).toFixed(2)}</span>` : '';
    const bestTag = id===bestId? ' <span class=\"chip-tag best\">best</span>' : '';
    chip.innerHTML = `${short} <span class=\"chip-tag\">p${pTrim}</span>${covTag}${bestTag}`;
    chip.title = `Unstructured chunk: ${id}\npage_trimmed=${pTrim}${selInfo.page_original?`, page_original=${selInfo.page_original}`:''}${selInfo.cohesion!=null?`, cohesion=${selInfo.cohesion.toFixed(3)}`:''}${selInfo.row_overlap!=null?`, row_overlap=${selInfo.row_overlap.toFixed(3)}`:''}`;
    chip.addEventListener('click', async () => {
      for (const n of picker.querySelectorAll('.chip')) n.classList.remove('active');
      chip.classList.add('active');
      CURRENT_ELEMENT_ID = id;
      await loadElementPreview(id);
    });
    picker.appendChild(chip);
  }
  $('drawer').classList.remove('hidden');
  $('preview').innerHTML = '<div class="placeholder">Loading…</div>';
  if (bestId) {
    CURRENT_ELEMENT_ID = bestId;
    const firstChip = picker.querySelector('.chip');
    if (firstChip) firstChip.classList.add('active');
    loadElementPreview(bestId);
  }
}

async function loadElementPreview(elementId) {
  try {
    const data = await fetchJSON(`/api/element/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(elementId)}`);
    const html = data.text_as_html;
    const container = $('preview');
    container.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'preview-meta';
    const meta = CHIP_META[elementId] || {};
    const selInfo = (LAST_SELECTED_MATCH?.selected_elements || []).find(x => x.element_id === elementId) || {};
    head.innerHTML = `
      <span class="badge">Unstructured</span>
      <span>chunk: <code>${elementId}</code></span>
      <span>page: ${selInfo.page_original ?? selInfo.page_trimmed ?? meta.page_trimmed ?? '-'}</span>
      ${data.expected_cols ? `<span>expected_cols: ${data.expected_cols}</span>` : ''}
    `;
    container.appendChild(head);
    // Per-chunk contribution summary
    const mm = document.createElement('div');
    mm.className = 'mini-metrics';
    const chunkCov = Number(selInfo.row_overlap ?? selInfo.cohesion ?? 0);
    const chunkSoloF1 = chunkCov > 0 ? (2 * chunkCov) / (chunkCov + 1) : 0; // F1 if this chunk alone
    // table cohesion is already shown in the table summary above
    const tableCoh = (LAST_SELECTED_MATCH && LAST_SELECTED_MATCH.selected_chunk_count)
      ? (1 / LAST_SELECTED_MATCH.selected_chunk_count)
      : 0;
    const addRow = (label, val, tip) => {
      const row = document.createElement('div');
      row.className = 'mini-metric';
      row.innerHTML = `<div class="label">${label}${tip?` <span class=\"info\" tabindex=\"0\">i</span><div class=\"tip\">${tip}</div>`:''}</div><div class="bar"><div class="fill" style="width:${Math.round((val||0)*100)}%"></div></div><div class="value">${(val||0).toFixed(3)}</div>`;
      mm.appendChild(row);
    };
    addRow('Chunk coverage', chunkCov, 'Share of gold rows this single Unstructured chunk covers (row_overlap).');
    // omit table cohesion here to avoid duplication with the summary band
    addRow('Chunk F1 (solo)', chunkSoloF1, 'Harmonic mean of this chunk’s coverage and perfect cohesion (1.0) — how strong it would be on its own.');
    container.appendChild(mm);
    if (html) {
      // Safe enough for our local dataset; we still wrap and style
      const scroll = document.createElement('div');
      scroll.className = 'scrollbox';
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html;
      scroll.appendChild(wrapper);
      applyDirectionalText(scroll);
      container.appendChild(scroll);
    } else {
      const pre = document.createElement('pre');
      pre.textContent = data.text || '(no text)';
      applyDirectionalText(pre);
      container.appendChild(pre);
    }
  } catch (e) {
    $('preview').innerHTML = `<div class="placeholder">Failed to load element: ${e.message}</div>`;
  }
}

async function loadRun(slug) {
  CURRENT_SLUG = slug;
  CURRENT_RUN = (RUNS_CACHE || []).find(r => r.slug === slug) || null;
  CURRENT_RUN_HAS_CHUNKS = Boolean(CURRENT_RUN && CURRENT_RUN.chunks_file);
  CURRENT_CHUNK_LOOKUP = {};
  CURRENT_CHUNK_TYPE_FILTER = 'All';
  BOX_INDEX = {};
  // Load PDF
  const pdfUrl = `/pdf/${encodeURIComponent(slug)}`;
  const loadingTask = window['pdfjsLib'].getDocument(pdfUrl);
  PDF_DOC = await loadingTask.promise;
  PAGE_COUNT = PDF_DOC.numPages;
  CURRENT_PAGE = 1;
  $('pageCount').textContent = PAGE_COUNT;
  await renderPage(CURRENT_PAGE);

  // Load matches only (boxes are fetched on demand per table)
  const matches = await fetchJSON(`/api/matches/${encodeURIComponent(slug)}`);
  MATCHES = matches;
  CURRENT_RUN_CONFIG = matches.run_config || CURRENT_RUN?.run_config || null;
  CURRENT_CHUNK_SUMMARY = matches.chunk_summary || CURRENT_RUN?.chunk_summary || null;
  if (!CURRENT_RUN_HAS_CHUNKS) {
    CURRENT_RUN_HAS_CHUNKS = Boolean(CURRENT_CHUNK_SUMMARY);
  }
  refreshMatchesView();
  updateRunConfigCard();
  if (CURRENT_RUN_HAS_CHUNKS) {
    await loadChunksForRun(slug);
  } else {
    CURRENT_CHUNKS = null;
    renderChunksTab();
  }
  const showUnmatchedCb = $('showUnmatched');
  if (showUnmatchedCb && !showUnmatchedCb._wired) {
    showUnmatchedCb._wired = true;
    showUnmatchedCb.addEventListener('change', () => { SHOW_UNMATCHED = showUnmatchedCb.checked; refreshMatchesView(); });
  }
  await loadElementTypes(slug);
  populateTypeSelectors();
}

async function renderPage(num) {
  CURRENT_PAGE = num;
  const page = await PDF_DOC.getPage(num);
  const rotation = page.rotate || 0;

  // Calculate scale to fit viewport height
  const container = $('pdfContainer');
  const containerHeight = container.clientHeight - 24; // subtract padding
  const baseViewport = page.getViewport({ scale: 1, rotation });
  const scaleToFit = containerHeight / baseViewport.height;
  const finalScale = Math.min(scaleToFit, SCALE); // Use smaller of fit-to-height or user scale

  const viewport = page.getViewport({ scale: finalScale, rotation });
  const canvas = $('pdfCanvas');
  const ctx = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  $('overlay').style.width = `${viewport.width}px`;
  $('overlay').style.height = `${viewport.height}px`;

  $('pageNum').textContent = num;
  clearBoxes();
  await page.render({ canvasContext: ctx, viewport }).promise;
  redrawOverlaysForCurrentContext();
  // Update chunks list if in chunks view
  if (CURRENT_VIEW === 'inspect' && INSPECT_TAB === 'chunks') {
    renderChunksTab();
  }
}

async function init() {
  // Populate PDFs and wire form early so New Run works even if pdf.js is slow
  await loadPdfs();
  wireRunForm();
  setupViewTabs();
  setupInspectTabs();
  wireModal();

  // Wait for pdf.js to be available (Safari + module load race safety)
  await (async function waitForPdfjs(maxMs = 5000) {
    const start = performance.now();
    while (!window['pdfjsLib']) {
      if (performance.now() - start > maxMs) throw new Error('pdf.js failed to load');
      await new Promise(r => setTimeout(r, 50));
    }
  })();
  await refreshRuns();
  // Re-populate PDFs once more in case the server changed while loading
  await loadPdfs();
  // Prepare preview for currently selected PDF (if any)
  await ensurePdfjsReady();
  await loadRunPreviewForSelectedPdf();

  $('prevPage').addEventListener('click', async () => {
    if (!PDF_DOC) return;
    const n = Math.max(1, CURRENT_PAGE - 1);
    await renderPage(n);
    if (LAST_SELECTED_MATCH) drawTargetsOnPage(n, LAST_SELECTED_MATCH, LAST_HIGHLIGHT_MODE === 'best');
  });
  $('nextPage').addEventListener('click', async () => {
    if (!PDF_DOC) return;
    const n = Math.min(PAGE_COUNT, CURRENT_PAGE + 1);
    await renderPage(n);
    if (LAST_SELECTED_MATCH) drawTargetsOnPage(n, LAST_SELECTED_MATCH, LAST_HIGHLIGHT_MODE === 'best');
  });
  $('zoom').addEventListener('input', async (e) => {
    SCALE = Number(e.target.value) / 100;
    await renderPage(CURRENT_PAGE);
    if (LAST_SELECTED_MATCH) drawTargetsOnPage(CURRENT_PAGE, LAST_SELECTED_MATCH, LAST_HIGHLIGHT_MODE === 'best');
  });
  $('drawerClose').addEventListener('click', async () => {
    // If we came here from a chunk's element, restore that chunk drawer
    if (RETURN_TO && RETURN_TO.kind === 'chunk') {
      const chunkId = RETURN_TO.id;
      const scrollTop = RETURN_TO.scrollTop;
      RETURN_TO = null;
      switchView('inspect');
      switchInspectTab('chunks');
      const listEl = document.getElementById('chunkList');
      if (listEl && scrollTop != null) listEl.scrollTop = scrollTop;
      if (chunkId) {
        await openChunkDetailsDrawer(chunkId, null);
      }
    } else {
      $('drawer').classList.add('hidden');
    }
  });

  // Overlays now follow the active Inspect tab; no toggles here
  // Ensure initial view
  switchView(CURRENT_VIEW);
}

init().catch(err => {
  console.error(err);
  alert(`Failed to initialize UI: ${err.message}`);
});

async function refreshRuns() {
  const runs = await fetchJSON('/api/runs');
  RUNS_CACHE = runs;
  const sel = $('runSelect');
  sel.innerHTML = '';
  for (const r of runs) {
    const opt = document.createElement('option');
    opt.value = r.slug;
    const tag = r.page_range ? ` · pages ${r.page_range}` : '';
    opt.textContent = `${r.slug}${tag}`;
    sel.appendChild(opt);
  }
  if (runs.length) {
    const exists = runs.find(r => r.slug === CURRENT_SLUG);
    const chosen = exists ? CURRENT_SLUG : runs[0].slug;
    CURRENT_SLUG = chosen;
    sel.value = chosen;
    await loadRun(chosen);
  } else {
    CURRENT_SLUG = null;
    CURRENT_RUN = null;
    CURRENT_RUN_CONFIG = null;
    CURRENT_RUN_HAS_CHUNKS = false;
    CURRENT_CHUNKS = null;
    CURRENT_CHUNK_SUMMARY = null;
    CURRENT_CHUNK_LOOKUP = {};
    // Clear UI basics when no runs
    const ctx = document.getElementById('chart')?.getContext?.('2d');
    if (CHART_INSTANCE) { try { CHART_INSTANCE.destroy(); } catch(e){} CHART_INSTANCE=null; }
    document.getElementById('matchList').innerHTML = '';
    renderMetrics({ avg_coverage:0, avg_cohesion:0, avg_chunker_f1:0, micro_coverage:0 });
    clearBoxes();
    updateRunConfigCard();
    renderChunksTab();
  }
  sel.onchange = async () => {
    await loadRun(sel.value);
  };
}

async function loadPdfs(preferredName = null) {
  try {
    KNOWN_PDFS = await fetchJSON('/api/pdfs');
  } catch (e) { KNOWN_PDFS = []; }
  const sel = $('pdfSelect');
  if (!sel) return;
  const prevSelection = sel.value;
  sel.innerHTML = '';
  if (KNOWN_PDFS.length) {
    for (const p of KNOWN_PDFS) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = `${p.name}`;
      sel.appendChild(opt);
    }
    let target = null;
    if (preferredName && KNOWN_PDFS.some(p => p.name === preferredName)) {
      target = preferredName;
    } else if (prevSelection && KNOWN_PDFS.some(p => p.name === prevSelection)) {
      target = prevSelection;
    } else {
      target = KNOWN_PDFS[0].name;
    }
    sel.value = target;
  } else {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(upload a PDF to begin)';
    opt.disabled = true;
    opt.selected = true;
    sel.appendChild(opt);
  }
}

function wireRunForm() {
  const chunkSel = $('chunkingSelect');
  const combineRow = $('chunkCombineRow');
  const multipageRow = $('chunkMultipageRow');
  const toggleAdv = () => {
    const isByTitle = chunkSel.value === 'by_title';
    if (combineRow) combineRow.classList.toggle('hidden', !isByTitle);
    if (multipageRow) multipageRow.classList.toggle('hidden', !isByTitle);
  };
  chunkSel.addEventListener('change', toggleAdv);
  toggleAdv();

  const uploadInput = $('pdfUploadInput');
  const uploadStatus = $('pdfUploadStatus');
  const uploadBtn = $('pdfUploadBtn');
  if (uploadInput) {
    let uploading = false;
    const setStatus = (msg) => { if (uploadStatus) uploadStatus.textContent = msg || ''; };
    const setUploadingState = (flag) => {
      uploading = flag;
      if (uploadBtn) {
        uploadBtn.disabled = flag;
        uploadBtn.textContent = flag ? 'Uploading…' : 'Upload';
      }
    };
    const handleUpload = async () => {
      if (uploading) return;
      if (!uploadInput.files || !uploadInput.files.length) return;
      const file = uploadInput.files[0];
      if (!file || !file.name || !file.name.toLowerCase().endsWith('.pdf')) {
        setStatus('File must be a .pdf');
        uploadInput.value = '';
        return;
      }
      const form = new FormData();
      form.append('file', file);
      setUploadingState(true);
      setStatus(`Uploading ${file.name}…`);
      try {
        const resp = await fetch('/api/pdfs', { method: 'POST', body: form });
        let data = null;
        try { data = await resp.json(); } catch (err) { data = null; }
        if (!resp.ok) throw new Error((data && data.detail) || `HTTP ${resp.status}`);
        setStatus(`Uploaded ${data.name}`);
        uploadInput.value = '';
        await loadPdfs(data?.name || null);
        try {
          await loadRunPreviewForSelectedPdf();
        } catch (err) {
          console.error('Failed to refresh preview after upload', err);
        }
      } catch (e) {
        setStatus(`Upload failed: ${e.message}`);
      } finally {
        setUploadingState(false);
      }
    };
    const requestUpload = async () => {
      if (!uploadInput.files || !uploadInput.files.length) return;
      await handleUpload();
    };
    uploadInput.addEventListener('change', requestUpload);
    uploadInput.addEventListener('input', requestUpload);
    if (uploadBtn) uploadBtn.addEventListener('click', requestUpload);
    setUploadingState(false);
  }

  $('runBtn').addEventListener('click', async () => {
    const status = $('runStatus');
    status.textContent = '';
    const payload = {
      pdf: $('pdfSelect').value,
      pages: $('pagesInput').value.trim(),
      strategy: $('strategySelect').value,
      infer_table_structure: $('inferTables').checked,
      chunking: $('chunkingSelect').value,
    };
    const langSel = $('docLanguage');
    const docLang = langSel ? (langSel.value || 'eng') : 'eng';
    payload.primary_language = docLang;
    if (docLang === 'ara') {
      payload.ocr_languages = 'ara+eng';
      payload.languages = 'ar,en';
      payload.detect_language_per_element = true;
    } else {
      payload.ocr_languages = 'eng+ara';
      payload.languages = 'en,ar';
      payload.detect_language_per_element = false;
    }
    const tagVal = $('variantTag')?.value?.trim();
    if (tagVal) payload.tag = tagVal;
    if (!payload.pages) { status.textContent = 'Enter pages (e.g., 4-6)'; return; }
    const parseNumber = (id) => {
      const input = $(id);
      if (!input) return null;
      const raw = input.value.trim();
      if (!raw) return null;
      const num = Number(raw);
      return Number.isFinite(num) ? num : null;
    };
    const parseBoolSelect = (id) => {
      const el = $(id);
      if (!el) return null;
      const val = el.value;
      if (val === '') return null;
      return val === 'true';
    };
    const maxTokens = parseNumber('chunkMaxTokens');
    const maxChars = parseNumber('chunkMaxChars');
    if (maxTokens != null) {
      payload.chunk_max_tokens = maxTokens;
      payload.chunk_max_characters = Math.max(1, Math.round(maxTokens * 4));
    } else if (maxChars != null) {
      payload.chunk_max_characters = maxChars;
    }
    const newAfter = parseNumber('chunkNewAfter');
    if (newAfter != null) payload.chunk_new_after_n_chars = newAfter;
    const overlap = parseNumber('chunkOverlap');
    if (overlap != null) payload.chunk_overlap = overlap;
    const includeOrig = parseBoolSelect('chunkIncludeOrig');
    if (includeOrig != null) payload.chunk_include_orig_elements = includeOrig;
    const overlapAll = parseBoolSelect('chunkOverlapAll');
    if (overlapAll != null) payload.chunk_overlap_all = overlapAll;
    if (payload.chunking === 'by_title') {
      const combine = parseNumber('chunkCombineUnder');
      if (combine != null) payload.chunk_combine_under_n_chars = combine;
      const multipage = parseBoolSelect('chunkMultipage');
      if (multipage != null) payload.chunk_multipage_sections = multipage;
    }
    // Include a raw snapshot of modal values so the recap can display
    payload.form_snapshot = {
      pdf: payload.pdf,
      pages: payload.pages,
      strategy: payload.strategy,
      infer_table_structure: payload.infer_table_structure,
      chunking: payload.chunking,
      tag: tagVal || null,
      max_tokens: parseNumber('chunkMaxTokens'),
      max_characters: parseNumber('chunkMaxChars'),
      new_after_n_chars: parseNumber('chunkNewAfter'),
      combine_under_n_chars: parseNumber('chunkCombineUnder'),
      overlap: parseNumber('chunkOverlap'),
      include_orig_elements: parseBoolSelect('chunkIncludeOrig'),
      overlap_all: parseBoolSelect('chunkOverlapAll'),
      multipage_sections: parseBoolSelect('chunkMultipage'),
      primary_language: docLang,
      ocr_languages: payload.ocr_languages,
      languages: payload.languages,
      detect_language_per_element: payload.detect_language_per_element,
    };
    const btn = $('runBtn');
    btn.disabled = true; btn.textContent = 'Running…';
    try {
      const r = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.detail || `HTTP ${r.status}`);
      await refreshRuns();
      if (data?.run?.slug) {
        const sel = $('runSelect');
        sel.value = data.run.slug;
        await loadRun(data.run.slug);
      }
      status.textContent = 'Completed';
      const tagInput = $('variantTag');
      if (tagInput) tagInput.value = '';
      closeRunModal();
    } catch (e) {
      status.textContent = `Failed: ${e.message}`;
    } finally {
      btn.disabled = false; btn.textContent = 'Run';
    }
  });

  const cancelBtn = $('cancelRunBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      const status = $('runStatus');
      if (status) status.textContent = '';
      closeRunModal();
    });
  }

  // Modal PDF preview wiring
  const pdfSel = $('pdfSelect');
  if (pdfSel) {
    pdfSel.addEventListener('change', async () => {
      await loadRunPreviewForSelectedPdf();
    });
  }
  const prev = $('runPrev');
  const next = $('runNext');
  const addPageBtn = $('addPageBtn');
  const markStartBtn = $('markStartBtn');
  const markEndBtn = $('markEndBtn');
  if (prev) prev.addEventListener('click', async () => { if (!RUN_PREVIEW_DOC) return; RUN_PREVIEW_PAGE = Math.max(1, RUN_PREVIEW_PAGE - 1); await renderRunPreviewPage(); });
  if (next) next.addEventListener('click', async () => { if (!RUN_PREVIEW_DOC) return; RUN_PREVIEW_PAGE = Math.min(RUN_PREVIEW_COUNT, RUN_PREVIEW_PAGE + 1); await renderRunPreviewPage(); });
  if (addPageBtn) addPageBtn.addEventListener('click', () => { addPageToInput(RUN_PREVIEW_PAGE); });
  if (markStartBtn) markStartBtn.addEventListener('click', () => { RUN_RANGE_START = RUN_PREVIEW_PAGE; updateRangeHint(); });
  if (markEndBtn) markEndBtn.addEventListener('click', () => { if (RUN_RANGE_START != null) { const a = Math.min(RUN_RANGE_START, RUN_PREVIEW_PAGE); const b = Math.max(RUN_RANGE_START, RUN_PREVIEW_PAGE); addRangeToInput(a, b); RUN_RANGE_START = null; updateRangeHint(); } });
}

function setupInspectTabs() {
  const tabs = document.querySelectorAll('.inspect-tabs .tab');
  for (const t of tabs) {
    t.addEventListener('click', () => switchInspectTab(t.dataset.inspect));
  }

  // Wire Delete Selected PDF
  const deleteBtn = $('pdfDeleteBtn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async (ev) => {
      // Prevent label/select focus quirks from swallowing the click
      try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
      const sel = $('pdfSelect');
      const name = sel && sel.value;
      if (!name) { showToast('No PDF selected', 'err', 2000); return; }
      // Ensure runs cache is fresh before prompting
      try { await refreshRuns(); } catch (_) {}
      // Identify associated runs that used this PDF
      const stem = name.replace(/\.pdf$/i, '');
      const runs = (RUNS_CACHE || []).filter(r => {
        const cfg = r.run_config || {};
        const pdfFromCfg = cfg.pdf || (cfg.form_snapshot && cfg.form_snapshot.pdf) || null;
        if (pdfFromCfg && pdfFromCfg === name) return true;
        // Fallback: match by base slug prefix
        let base = r.slug || '';
        if (base.includes('.pages')) base = base.split('.pages')[0];
        if (base.includes('__')) base = base.split('__')[0];
        return base === stem;
      });

      // Confirm deletion strategy depending on association
      let deleteRunsToo = false;
      if (runs.length > 0) {
        const listPreview = runs.slice(0, 5).map(r => `- ${r.slug}`).join('\n');
        const more = runs.length > 5 ? `\n…and ${runs.length - 5} more` : '';
        const msg = `Found ${runs.length} run(s) referencing ${name}:\n${listPreview}${more}\n\nDelete the PDF and ALL associated runs?`;
        deleteRunsToo = !!confirm(msg);
        if (!deleteRunsToo) {
          const onlyPdf = confirm(`Delete the PDF only and keep ${runs.length} run(s)?`);
          if (!onlyPdf) return; // abort
        }
      } else {
        const ok = confirm(`Delete PDF: ${name}? This removes it from server storage; runs remain intact.`);
        if (!ok) return;
      }

      try {
        // Optionally delete associated runs first
        if (deleteRunsToo && runs.length > 0) {
          let okCount = 0, failCount = 0;
          for (const rr of runs) {
            try {
              const dr = await fetch(`/api/run/${encodeURIComponent(rr.slug)}`, { method: 'DELETE' });
              if (!dr.ok) failCount++; else okCount++;
            } catch (_) {
              failCount++;
            }
          }
          await refreshRuns();
          showToast(`Deleted runs: ${okCount} ok, ${failCount} failed`, failCount ? 'err' : 'ok', 3000);
        }

        // Now delete the PDF itself
        const r = await fetch(`/api/pdfs/${encodeURIComponent(name)}`, { method: 'DELETE' });
        let data = null; try { data = await r.json(); } catch (e) { data = null; }
        if (!r.ok) throw new Error((data && data.detail) || `HTTP ${r.status}`);
        showToast(`Deleted ${name}`, 'ok', 2000);
        await loadPdfs();
        // If nothing left, clear preview; otherwise reload preview for new selection
        if (!KNOWN_PDFS || KNOWN_PDFS.length === 0) {
          try {
            RUN_PREVIEW_DOC = null; RUN_PREVIEW_COUNT = 0; RUN_PREVIEW_PAGE = 1;
            const canvas = $('runPdfCanvas');
            if (canvas) { const ctx = canvas.getContext('2d'); ctx && ctx.clearRect(0,0,canvas.width,canvas.height); }
            const numEl = $('runPageNum'); const cntEl = $('runPageCount');
            if (numEl) numEl.textContent = '-'; if (cntEl) cntEl.textContent = '-';
          } catch (e) {}
        } else {
          try { await loadRunPreviewForSelectedPdf(); } catch (e) {}
        }
      } catch (e) {
        showToast(`Delete failed: ${e.message}`, 'err');
      }
    });
  }
}

function switchInspectTab(name) {
  INSPECT_TAB = (name === 'elements') ? 'elements' : 'chunks';
  document.querySelectorAll('.inspect-tabs .tab').forEach(el => el.classList.toggle('active', el.dataset.inspect === INSPECT_TAB));
  document.querySelectorAll('#right-inspect .pane').forEach(el => el.classList.toggle('active', el.id === `pane-inspect-${INSPECT_TAB}`));
  // Overlays reflect the active tab: only one kind at a time
  SHOW_CHUNK_OVERLAYS = (INSPECT_TAB === 'chunks');
  SHOW_ELEMENT_OVERLAYS = (INSPECT_TAB === 'elements');
  // On switching to Elements, render page boxes; to Chunks, render chunk bboxes
  redrawOverlaysForCurrentContext();
}

function setupViewTabs() {
  const m = $('viewTabMetrics');
  const i = $('viewTabInspect');
  if (m) m.addEventListener('click', () => switchView('metrics'));
  if (i) i.addEventListener('click', () => switchView('inspect'));
}

function switchView(view) {
  CURRENT_VIEW = (view === 'inspect') ? 'inspect' : 'metrics';
  const m = $('viewTabMetrics');
  const i = $('viewTabInspect');
  if (m) m.classList.toggle('active', CURRENT_VIEW === 'metrics');
  if (i) i.classList.toggle('active', CURRENT_VIEW === 'inspect');
  const rightMetrics = $('right-metrics');
  const rightInspect = $('right-inspect');
  if (rightMetrics) rightMetrics.classList.toggle('hidden', CURRENT_VIEW !== 'metrics');
  if (rightInspect) rightInspect.classList.toggle('hidden', CURRENT_VIEW !== 'inspect');
  if (CURRENT_VIEW === 'metrics') {
    // In Metrics, show both chunk and element overlays for highlights
    SHOW_CHUNK_OVERLAYS = true;
    SHOW_ELEMENT_OVERLAYS = true;
  } else {
    // In Inspect, overlays match the active sub-tab
    SHOW_CHUNK_OVERLAYS = (INSPECT_TAB === 'chunks');
    SHOW_ELEMENT_OVERLAYS = (INSPECT_TAB === 'elements');
  }
  redrawOverlaysForCurrentContext();
}

function wireModal() {
  const modal = $('runModal');
  const openBtn = $('openRunModal');
  const deleteBtn = $('deleteRunBtn');
  const closeBtn = $('closeRunModal');
  const backdrop = $('runModalBackdrop');
  openBtn.addEventListener('click', () => { const s=$('pdfSelect'); if(s) s.disabled=false; modal.classList.remove('hidden'); });
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!CURRENT_SLUG) return;
      const ok = confirm(`Delete run: ${CURRENT_SLUG}? This removes its matches, tables JSONL, and trimmed PDF.`);
      if (!ok) return;
      try {
        const r = await fetch(`/api/run/${encodeURIComponent(CURRENT_SLUG)}`, { method: 'DELETE' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await refreshRuns();
        showToast('Run deleted', 'ok', 2000);
      } catch (e) {
        showToast(`Failed to delete run: ${e.message}`, 'err');
      }
    });
  }
  const close = () => { $('runStatus').textContent = ''; modal.classList.add('hidden'); };
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
}

function closeRunModal() {
  const modal = $('runModal');
  if (modal) modal.classList.add('hidden');
}

async function ensurePdfjsReady(maxMs = 5000) {
  const start = performance.now();
  while (!window['pdfjsLib']) {
    if (performance.now() - start > maxMs) throw new Error('pdf.js failed to load');
    await new Promise(r => setTimeout(r, 50));
  }
}

async function loadRunPreviewForSelectedPdf() {
  const name = $('pdfSelect')?.value;
  if (!name) return;
  try {
    await ensurePdfjsReady();
    const url = `/res_pdf/${encodeURIComponent(name)}`;
    const task = window['pdfjsLib'].getDocument(url);
    RUN_PREVIEW_DOC = await task.promise;
    RUN_PREVIEW_COUNT = RUN_PREVIEW_DOC.numPages;
    RUN_PREVIEW_PAGE = 1;
    $('runPageCount').textContent = RUN_PREVIEW_COUNT;
    await renderRunPreviewPage();
  } catch (e) {
    // File may have been removed; clear preview state gracefully
    RUN_PREVIEW_DOC = null; RUN_PREVIEW_COUNT = 0; RUN_PREVIEW_PAGE = 1;
    const canvas = $('runPdfCanvas');
    if (canvas) { const ctx = canvas.getContext('2d'); ctx && ctx.clearRect(0,0,canvas.width,canvas.height); }
    const numEl = $('runPageNum'); const cntEl = $('runPageCount');
    if (numEl) numEl.textContent = '-'; if (cntEl) cntEl.textContent = '-';
  }
}

async function renderRunPreviewPage() {
  if (!RUN_PREVIEW_DOC) return;
  const page = await RUN_PREVIEW_DOC.getPage(RUN_PREVIEW_PAGE);
  const canvas = $('runPdfCanvas');
  const ctx = canvas.getContext('2d');
  const viewport = page.getViewport({ scale: 0.8 });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  $('runPageNum').textContent = RUN_PREVIEW_PAGE;
  await page.render({ canvasContext: ctx, viewport }).promise;
}

function updateRangeHint() {
  const el = $('rangeHint');
  if (!el) return;
  if (RUN_RANGE_START != null) el.textContent = `range start: ${RUN_RANGE_START}`; else el.textContent = '';
}

function parsePagesString(s) {
  const set = new Set();
  for (const part of (s || '').split(',')) {
    const t = part.trim(); if (!t) continue;
    if (t.includes('-')) {
      const [a,b] = t.split('-',1).concat(t.split('-').slice(1)).map(x=>parseInt(x,10));
      const start = Math.min(a,b); const end = Math.max(a,b);
      for (let i=start;i<=end;i++) set.add(i);
    } else {
      const n = parseInt(t,10); if (!isNaN(n)) set.add(n);
    }
  }
  return set;
}

function encodePagesSet(set) {
  const arr = Array.from(set).filter(n=>Number.isInteger(n)).sort((a,b)=>a-b);
  const ranges = [];
  let i=0;
  while (i < arr.length) {
    const start = arr[i];
    let end = start; i++;
    while (i < arr.length && arr[i] === end + 1) { end = arr[i]; i++; }
    ranges.push(start===end ? `${start}` : `${start}-${end}`);
  }
  return ranges.join(',');
}

function addPageToInput(n) {
  const el = $('pagesInput'); if (!el) return;
  const set = parsePagesString(el.value);
  set.add(n);
  el.value = encodePagesSet(set);
}

function addRangeToInput(a,b) {
  const el = $('pagesInput'); if (!el) return;
  const set = parsePagesString(el.value);
  for (let i=a;i<=b;i++) set.add(i);
  el.value = encodePagesSet(set);
}

async function loadElementTypes(slug) {
  try {
    const res = await fetchJSON(`/api/element_types/${encodeURIComponent(slug)}`);
    ELEMENT_TYPES = (res.types || []).map(t => ({ type: t.type, count: Number(t.count || 0) }));
  } catch (e) {
    ELEMENT_TYPES = [];
  }
}

function populateTypeSelectors() {
  const e = $('elementsTypeSelect');
  const opts = ['All', ...ELEMENT_TYPES.map(t => t.type)];
  if (e) {
    e.innerHTML = '';
    for (const t of opts) {
      const o = document.createElement('option');
      o.value = t; o.textContent = t;
      e.appendChild(o);
    }
    e.value = CURRENT_TYPE_FILTER;
  }
  const list = $('typesList');
  if (list) {
    list.innerHTML = '';
    for (const t of ELEMENT_TYPES) {
      const div = document.createElement('div');
      div.textContent = `${t.type}: ${t.count}`;
      list.appendChild(div);
    }
  }
}

async function drawBoxesForCurrentPage() {
  if (!CURRENT_SLUG || !CURRENT_PAGE) return;
  const type = CURRENT_TYPE_FILTER;
  const param = type && type !== 'All' ? `&types=${encodeURIComponent(type)}` : '';
  try {
    const boxes = await fetchJSON(`/api/boxes/${encodeURIComponent(CURRENT_SLUG)}?page=${CURRENT_PAGE}${param}`);
    clearBoxes();
    const typesPresent = new Set();
    for (const [id, entry] of Object.entries(boxes)) {
      const rect = { x: entry.x, y: entry.y, w: entry.w, h: entry.h };
      const isSelected = (id === CURRENT_INSPECT_ELEMENT_ID);
      if (SHOW_ELEMENT_OVERLAYS) {
        const meta = { kind: 'element', id: id, origId: entry.orig_id, type: entry.type, page: entry.page_trimmed };
        addBox(rect, entry.layout_w, entry.layout_h, isSelected, entry.type, null, 'element', meta);
      }
      if (entry.type) typesPresent.add(entry.type);
    }
    const present = Array.from(typesPresent.values());
    updateLegend(SHOW_ELEMENT_OVERLAYS ? present : []);
    renderElementsListForCurrentPage(boxes);
    if (present.length === 0) {
      showToast('No boxes found on this page for the current run and filter.', 'err', 2000);
    }
    if (!HINTED_HIRES && present.length === 1 && present[0] === 'Table' && (!CURRENT_TYPE_FILTER || CURRENT_TYPE_FILTER === 'All' || CURRENT_TYPE_FILTER === 'Table')) {
      showToast('Only Table boxes present. For overlays on other element types, run with strategy=hi_res.', 'ok', 5000);
      HINTED_HIRES = true;
    }
  } catch (e) {
    showToast(`Failed to load boxes: ${e.message}`, 'err');
  }
}

function renderElementsListForCurrentPage(boxes) {
  const host = document.getElementById('elementsList');
  if (!host) return;
  host.innerHTML = '';
  const entries = Object.entries(boxes || {});
  if (!entries.length) {
    const div = document.createElement('div');
    div.className = 'placeholder';
    div.textContent = 'No elements on this page for the selected filter.';
    host.appendChild(div);
    return;
  }
  // Sort by type then by Y then X for a stable order
  entries.sort((a,b) => {
    const ea = a[1]||{}; const eb = b[1]||{};
    const ta = (ea.type||'').localeCompare(eb.type||'');
    if (ta !== 0) return ta;
    const ya = Number(ea.y||0) - Number(eb.y||0);
    if (ya !== 0) return ya;
    return Number(ea.x||0) - Number(eb.x||0);
  });
  for (const [id, entry] of entries) {
    const card = document.createElement('div');
    card.className = 'chunk-card element-card';
    card.dataset.elementId = id;
    const color = typeBorderColor(entry.type || '');
    card.style.borderLeft = `4px solid ${color}`;
    const header = document.createElement('div');
    header.className = 'header';
    const dId = entry.orig_id || id;
    const short = dId.length > 16 ? `${dId.slice(0,12)}…` : dId;
    header.innerHTML = `<span>${entry.type || 'Unknown'}</span><span class="meta">${short}</span>`;
    const pre = document.createElement('pre');
    pre.textContent = 'Loading preview…';
    applyDirectionalText(pre);
    card.appendChild(header);
    card.appendChild(pre);
    // add focus class if it matches current selection
    if (id === CURRENT_INSPECT_ELEMENT_ID) card.classList.add('focused');
    card.addEventListener('click', async () => {
      CURRENT_INSPECT_ELEMENT_ID = id;
      const p = Number(entry.page_trimmed || CURRENT_PAGE);
      if (p && p !== CURRENT_PAGE) {
        await renderPage(p);
      }
      await drawBoxesForCurrentPage();
      openElementDetails(id);
    });
    host.appendChild(card);
    // fetch preview text + original id asynchronously
    (async () => {
      try {
        const data = await fetchJSON(`/api/element/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(id)}`);
        let txt = data.text || '';
        if (!txt && data.text_as_html) {
          // strip tags for a compact preview
          txt = String(data.text_as_html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
        if (!txt) txt = '(no text)';
        pre.textContent = txt;
        const displayId = data.original_element_id || id;
        const shortId = displayId.length > 16 ? `${displayId.slice(0,12)}…` : displayId;
        header.innerHTML = `<span>${data.type || entry.type || 'Element'}</span><span class="meta">${shortId}</span>`;
      } catch (e) {
        pre.textContent = `(failed to load preview: ${e.message})`;
      }
    })();
  }
}

function revealElementInList(elementId, retries=12) {
  const list = document.getElementById('elementsList');
  if (!list) return;
  const sel = `[data-element-id="${(window.CSS && window.CSS.escape) ? window.CSS.escape(elementId) : elementId}"]`;
  const card = list.querySelector(sel);
  if (card) {
    list.querySelectorAll('.element-card.focused').forEach(el => el.classList.remove('focused'));
    card.classList.add('focused');
    try { card.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    return;
  }
  if (retries > 0) setTimeout(() => revealElementInList(elementId, retries-1), 80);
}

async function openElementDetails(elementId) {
  try {
    const data = await fetchJSON(`/api/element/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(elementId)}`);
    const container = $('preview');
    $('drawerTitle').textContent = 'Element';
    const displayId = data.original_element_id || elementId;
    $('drawerMeta').innerHTML = `<code>${displayId}</code> · <span class="chip-tag">${data.type || '-'}</span>`;
    $('drawerSummary').innerHTML = '';
    $('elementPicker').innerHTML = '';
    $('drawer').classList.remove('hidden');
    container.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'preview-meta';
    head.innerHTML = `<span class="badge">Element</span><span>page: ${data.page_number ?? '-'}</span>`;
    container.appendChild(head);
    const html = data.text_as_html;
    if (html) {
      const scroll = document.createElement('div');
      scroll.className = 'scrollbox';
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html;
      scroll.appendChild(wrapper);
      applyDirectionalText(scroll);
      container.appendChild(scroll);
    } else {
      const pre = document.createElement('pre');
      pre.textContent = data.text || '(no text)';
      applyDirectionalText(pre);
      container.appendChild(pre);
    }
  } catch (e) {
    showToast(`Failed to load element: ${e.message}`, 'err');
  }
}

function updateLegend(types) {
  const host = $('legend');
  if (!host) return;
  host.innerHTML = '';
  const use = (types && types.length) ? types : [];
  if (!use.length) { host.classList.add('hidden'); return; }
  for (const t of use.sort()) {
    const row = document.createElement('div');
    row.className = 'item';
    const sw = document.createElement('span'); sw.className = 'swatch';
    const color = typeBorderColor(t);
    sw.style.background = color;
    row.appendChild(sw);
    const label = document.createElement('span'); label.textContent = t; row.appendChild(label);
    host.appendChild(row);
  }
  host.classList.remove('hidden');
}

function showToast(text, kind='ok', ms=3000) {
  const host = $('toast');
  if (!host) return;
  const item = document.createElement('div');
  item.className = `t ${kind}`;
  item.textContent = text;
  host.appendChild(item);
  setTimeout(() => { item.remove(); }, ms);
}

function typeBorderColor(t) {
  const cls = String(t || '').replace(/[^A-Za-z0-9_-]/g,'');
  if (!cls) return '#6bbcff';
  const fake = document.createElement('div');
  fake.className = `box type-${cls}`;
  document.body.appendChild(fake);
  const color = window.getComputedStyle(fake).borderColor;
  document.body.removeChild(fake);
  return color || '#6bbcff';
}

// Elements tab: type filter mirrors the quickbar's CURRENT_TYPE_FILTER
document.addEventListener('DOMContentLoaded', () => {
  applyLanguageDirection();
  const sel = $('elementsTypeSelect');
  if (sel) sel.addEventListener('change', async () => {
    CURRENT_TYPE_FILTER = sel.value || 'All';
    populateTypeSelectors();
    if (LAST_SELECTED_MATCH && CURRENT_VIEW === 'metrics') {
      drawTargetsOnPage(CURRENT_PAGE, LAST_SELECTED_MATCH, LAST_HIGHLIGHT_MODE === 'best');
    }
    await drawBoxesForCurrentPage();
  });
});

async function loadChunksForRun(slug) {
  try {
    const data = await fetchJSON(`/api/chunks/${encodeURIComponent(slug)}`);
    CURRENT_CHUNKS = data;
  } catch (e) {
    CURRENT_CHUNKS = { error: e.message, summary: null, chunks: [] };
  }
  CURRENT_CHUNK_LOOKUP = {};
  const chunkList = (CURRENT_CHUNKS && CURRENT_CHUNKS.chunks) || [];
  chunkList.forEach((chunk, idx) => {
    if (!chunk) return;
    if (chunk.element_id) {
      CURRENT_CHUNK_LOOKUP[chunk.element_id] = chunk;
      return;
    }
    const fallbackId = `chunk-${idx}`;
    CURRENT_CHUNK_LOOKUP[fallbackId] = chunk;
  });
  renderChunksTab();
}

function renderChunksTab() {
  const summaryEl = $('chunkSummary');
  const listEl = $('chunkList');
  if (!summaryEl || !listEl) return;
  if (!CURRENT_RUN_HAS_CHUNKS) {
    summaryEl.innerHTML = '<div class="placeholder">Chunk data not available for this run.</div>';
    listEl.innerHTML = '';
    return;
  }
  if (!CURRENT_CHUNKS) {
    summaryEl.innerHTML = '<div class="placeholder">Loading chunk data…</div>';
    listEl.innerHTML = '';
    return;
  }
  if (CURRENT_CHUNKS.error) {
    summaryEl.innerHTML = `<div class="placeholder">Failed to load chunks: ${CURRENT_CHUNKS.error}</div>`;
    listEl.innerHTML = '';
    return;
  }
  const summary = CURRENT_CHUNKS.summary || {};
  const allChunks = CURRENT_CHUNKS.chunks || [];

  // Compute chunk types from all chunks
  const typeCount = new Map();
  allChunks.forEach(ch => {
    const type = ch.type || 'Unknown';
    typeCount.set(type, (typeCount.get(type) || 0) + 1);
  });
  CHUNK_TYPES = Array.from(typeCount.entries()).map(([type, count]) => ({ type, count }));

  // Filter chunks by current page and type
  let chunks = allChunks.filter(ch => {
    const b = chunkBox(ch);
    return b && Number.isFinite(b.page_trimmed) && b.page_trimmed === CURRENT_PAGE;
  });

  if (CURRENT_CHUNK_TYPE_FILTER && CURRENT_CHUNK_TYPE_FILTER !== 'All') {
    chunks = chunks.filter(ch => ch.type === CURRENT_CHUNK_TYPE_FILTER);
  }

  // Build type dropdown options
  const typeOpts = ['All', ...CHUNK_TYPES.map(t => t.type)];
  const typeOptsHtml = typeOpts.map(t => `<option value="${t}" ${t === CURRENT_CHUNK_TYPE_FILTER ? 'selected' : ''}>${t}</option>`).join('');

  // Build types list
  const typesListHtml = CHUNK_TYPES.map(t => `<div>${t.type}: ${t.count}</div>`).join('');

  summaryEl.innerHTML = `
    <div class="chunk-summary-row">
      <div class="row">
        <label>
          <span class="lab">Type</span>
          <select id="chunksTypeSelect">${typeOptsHtml}</select>
        </label>
      </div>
      <div class="chunk-types">${typesListHtml}</div>
      <div class="chunk-stats">
        <div><span class="lab">Chunks (page ${CURRENT_PAGE})</span><span>${chunks.length} of ${summary.count || 0}</span></div>
        <div><span class="lab">Avg chars</span><span>${(summary.avg_chars || 0).toFixed(1)}</span></div>
        <div><span class="lab">Min chars</span><span>${summary.min_chars || 0}</span></div>
        <div><span class="lab">Max chars</span><span>${summary.max_chars || 0}</span></div>
        <div><span class="lab">Total chars</span><span>${summary.total_chars || 0}</span></div>
      </div>
    </div>
  `;

  // Wire up the type filter (element is recreated each time via innerHTML, so add listener each time)
  const typeSelect = $('chunksTypeSelect');
  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      CURRENT_CHUNK_TYPE_FILTER = typeSelect.value || 'All';
      renderChunksTab();
      redrawOverlaysForCurrentContext();
    });
  }

  listEl.innerHTML = '';
  chunks.forEach((chunk, idx) => {
    const card = document.createElement('div');
    card.className = 'chunk-card';
    const chunkId = chunk.element_id || `chunk-${idx}`;
    card.dataset.chunkId = chunkId;
    const color = typeBorderColor(chunk.type || '');
    card.style.borderLeft = `4px solid ${color}`;
    const header = document.createElement('div');
    header.className = 'header';
    header.innerHTML = `<span>${chunk.element_id || '(no id)'}</span><span>${chunk.char_len || 0} chars</span>`;
    const pre = document.createElement('pre');
    const text = chunk.text || '';
    pre.textContent = text || '(empty)';
    applyDirectionalText(pre);
    // Elements sublist (collapsed by default)
    const sub = document.createElement('div');
    sub.className = 'elements-sublist hidden';
    // Build unique element list from orig_boxes using orig_id/element_id
    const uniq = new Map();
    (chunk.orig_boxes || []).forEach((b, i2) => {
      const key = b.orig_id || b.element_id || `${b.page_trimmed}:${b.x}:${b.y}:${b.w}:${b.h}:${i2}`;
      if (!uniq.has(key)) uniq.set(key, b);
    });
    if (uniq.size) {
      const title = document.createElement('div');
      title.className = 'sublist-title';
      title.textContent = 'Elements';
      sub.appendChild(title);
      uniq.forEach((b) => {
        const row = document.createElement('div');
        row.className = 'element-row';
        const idDisp = (b.orig_id || b.element_id || '').toString();
        const short = idDisp.length > 16 ? `${idDisp.slice(0,12)}…` : idDisp || '(no id)';
        row.innerHTML = `<span>${b.type || 'Element'} · p${b.page_trimmed ?? '?'}</span><span class="meta">${short}</span>`;
        row.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const p = Number(b.page_trimmed || CURRENT_PAGE);
          // Try to map original id to stable id by reading page boxes
          let stable = await findStableIdByOrig(b.orig_id || b.element_id, p);
          if (p && p !== CURRENT_PAGE) await renderPage(p);
          switchView('inspect');
          switchInspectTab('elements');
          if (stable) {
            CURRENT_INSPECT_ELEMENT_ID = stable;
            await drawBoxesForCurrentPage();
            openElementDetails(stable);
          } else if (b.orig_id) {
            CURRENT_INSPECT_ELEMENT_ID = null;
            await drawBoxesForCurrentPage();
            openElementDetails(b.orig_id);
            // After details open, try mapping again and focus
            stable = await findStableIdByOrig(b.orig_id, p);
            if (stable) { CURRENT_INSPECT_ELEMENT_ID = stable; await drawBoxesForCurrentPage(); }
          }
        });
        sub.appendChild(row);
      });
    }
    card.appendChild(header);
    card.appendChild(pre);
    card.addEventListener('click', async () => {
      // Open chunk details in drawer
      CURRENT_ELEMENT_ID = chunk.element_id || null;
      const b = chunkBox(chunk);
      if (b && Number.isFinite(b.page_trimmed)) {
        const p = Number(b.page_trimmed);
        if (p && p !== CURRENT_PAGE) {
          await renderPage(p);
        } else {
          redrawOverlaysForCurrentContext();
        }
      } else {
        redrawOverlaysForCurrentContext();
      }
      await openChunkDetailsDrawer(chunkId, sub);
    });
    listEl.appendChild(card);
  });
}

async function openChunkDetailsDrawer(chunkId, elementsSublist) {
  const ch = CURRENT_CHUNK_LOOKUP ? CURRENT_CHUNK_LOOKUP[chunkId] : null;
  if (!ch) return;

  // Populate drawer with chunk content
  $('drawerTitle').textContent = 'Chunk Details';
  $('drawerMeta').innerHTML = `<code>${chunkId}</code> · <span class="chip-tag">${ch.type || '-'}</span> · <span class="chip-tag">${ch.char_len || 0} chars</span>`;
  $('drawerSummary').innerHTML = '';
  $('elementPicker').innerHTML = '';

  const container = $('preview');
  container.innerHTML = '';

  // Add chunk text
  const textSection = document.createElement('div');
  textSection.className = 'chunk-text-section';
  const textHeader = document.createElement('h3');
  textHeader.textContent = 'Chunk Text';
  textHeader.style.marginTop = '0';
  textHeader.style.marginBottom = '12px';
  textHeader.style.fontSize = '14px';
  textHeader.style.fontWeight = '600';
  textSection.appendChild(textHeader);

  const pre = document.createElement('pre');
  pre.style.maxHeight = '200px';
  pre.style.overflow = 'auto';
  pre.textContent = ch.text || '(empty)';
  applyDirectionalText(pre);
  textSection.appendChild(pre);
  container.appendChild(textSection);

  // Add elements list
  const uniq = new Map();
  (ch.orig_boxes || []).forEach((b, i2) => {
    const key = b.orig_id || b.element_id || `${b.page_trimmed}:${b.x}:${b.y}:${b.w}:${b.h}:${i2}`;
    if (!uniq.has(key)) uniq.set(key, b);
  });

  if (uniq.size > 0) {
    const elemSection = document.createElement('div');
    elemSection.className = 'chunk-elements-section';
    elemSection.style.marginTop = '24px';

    const elemHeader = document.createElement('h3');
    elemHeader.textContent = `Elements (${uniq.size})`;
    elemHeader.style.marginTop = '0';
    elemHeader.style.marginBottom = '12px';
    elemHeader.style.fontSize = '14px';
    elemHeader.style.fontWeight = '600';
    elemSection.appendChild(elemHeader);

    const elemList = document.createElement('div');
    elemList.className = 'drawer-element-list';
    elemList.style.display = 'flex';
    elemList.style.flexDirection = 'column';
    elemList.style.gap = '8px';

    uniq.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'drawer-element-row';
      row.style.padding = '12px';
      row.style.border = '1px solid #ddd';
      row.style.borderRadius = '4px';
      row.style.cursor = 'pointer';
      row.style.transition = 'background 0.2s';

      const idDisp = (b.orig_id || b.element_id || '').toString();
      const short = idDisp.length > 30 ? `${idDisp.slice(0, 26)}…` : idDisp || '(no id)';

      row.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div style="font-weight: 600; margin-bottom: 4px;">${b.type || 'Element'}</div>
            <div style="font-size: 12px; color: #666;">Page ${b.page_trimmed ?? '?'} · ${short}</div>
          </div>
          <div style="font-size: 20px; color: #999;">›</div>
        </div>
      `;

      row.addEventListener('mouseenter', () => { row.style.background = '#f5f5f5'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
      row.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        // Remember we came from chunk details to return here on close
        RETURN_TO = { kind: 'chunk', id: chunkId };
        const p = Number(b.page_trimmed || CURRENT_PAGE);
        let stable = await findStableIdByOrig(b.orig_id || b.element_id, p);
        if (p && p !== CURRENT_PAGE) await renderPage(p);
        switchView('inspect');
        switchInspectTab('elements');
        if (stable) {
          CURRENT_INSPECT_ELEMENT_ID = stable;
          await drawBoxesForCurrentPage();
          await openElementDetails(stable);
        } else if (b.orig_id) {
          CURRENT_INSPECT_ELEMENT_ID = null;
          await drawBoxesForCurrentPage();
          await openElementDetails(b.orig_id);
          stable = await findStableIdByOrig(b.orig_id, p);
          if (stable) { CURRENT_INSPECT_ELEMENT_ID = stable; await drawBoxesForCurrentPage(); }
        }
      });
      elemList.appendChild(row);
    });

    elemSection.appendChild(elemList);
    container.appendChild(elemSection);
  }

  $('drawer').classList.remove('hidden');
}

async function openChunkDetails(chunkId) {
  await openChunkDetailsDrawer(chunkId, null);
}

async function focusChunkFromOverlay(chunkId) {
  switchView('inspect');
  switchInspectTab('chunks');
  CURRENT_ELEMENT_ID = chunkId;
  const ch = CURRENT_CHUNK_LOOKUP ? CURRENT_CHUNK_LOOKUP[chunkId] : null;
  const b = chunkBox(ch);
  if (b && Number.isFinite(b.page_trimmed)) {
    const p = Number(b.page_trimmed);
    if (p && p !== CURRENT_PAGE) await renderPage(p);
  }
  revealChunkInList(chunkId, true);
  redrawOverlaysForCurrentContext();
}

function revealChunkInList(chunkId, expand=true) {
  const list = document.getElementById('chunkList');
  if (!list) return;
  const sel = `[data-chunk-id="${(window.CSS && window.CSS.escape) ? window.CSS.escape(chunkId) : chunkId}"]`;
  const card = list.querySelector(sel);
  if (!card) { setTimeout(() => revealChunkInList(chunkId, expand), 80); return; }
  if (expand) {
    const sub = card.querySelector('.elements-sublist');
    if (sub) sub.classList.remove('hidden');
  }
  try { card.scrollIntoView({ block: 'nearest' }); } catch(e) {}
}

async function findStableIdByOrig(origId, page) {
  try {
    const boxes = await fetchJSON(`/api/boxes/${encodeURIComponent(CURRENT_SLUG)}?page=${page}`);
    for (const [eid, entry] of Object.entries(boxes)) {
      if (entry.orig_id && entry.orig_id === origId) return eid;
    }
  } catch (e) {}
  return null;
}
