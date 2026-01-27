/**
 * Runs orchestration - main logic, init, view switching
 * Dependencies: app-pdf.js, app-run-jobs.js, app-run-preview.js, app-run-form.js, app-modal.js
 */

const LAST_RUN_KEY = 'chunking-visualizer-last-run';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Legacy provider name aliases (pre-v5.0 compatibility)
const PROVIDER_ALIASES = {
  'unstructured': 'unstructured/local',
  'unstructured-partition': 'unstructured/partition',
  'azure-di': 'azure/document_intelligence',
};

function resolveProvider(provider) {
  return PROVIDER_ALIASES[provider] || provider;
}

function runKey(slug, provider = CURRENT_PROVIDER || 'unstructured/local') {
  const prov = (provider || 'unstructured/local').trim() || 'unstructured/local';
  return `${prov}:::${slug || ''}`;
}

function parseRunKey(key) {
  const raw = key || '';
  const sep = raw.indexOf(':::');
  if (sep === -1) return { slug: raw, provider: CURRENT_PROVIDER || 'unstructured/local' };
  const provider = resolveProvider(raw.slice(0, sep) || 'unstructured/local');
  const slug = raw.slice(sep + 3) || '';
  return { slug, provider };
}

function providerSupportsChunks(provider) {
  // All providers support chunks via the custom chunker
  return true;
}

async function loadRun(slug, provider = CURRENT_PROVIDER) {
  const providerKey = (provider || CURRENT_PROVIDER || 'unstructured/local').trim() || 'unstructured/local';
  CURRENT_SLUG = slug;
  CURRENT_PROVIDER = providerKey;
  CURRENT_RUN = (RUNS_CACHE || []).find(
    (r) => r.slug === slug && (r.provider || 'unstructured/local') === providerKey,
  ) || (RUNS_CACHE || []).find((r) => r.slug === slug) || null;
  CURRENT_PROVIDER = (CURRENT_RUN && CURRENT_RUN.provider) || CURRENT_PROVIDER || 'unstructured/local';
  setChunksTabVisible(providerSupportsChunks(CURRENT_PROVIDER));
  const providerSel = $('providerSelect');
  if (providerSel) {
    providerSel.value = CURRENT_PROVIDER;
    providerSel.dispatchEvent(new Event('change'));
  }
  CURRENT_RUN_HAS_CHUNKS = providerSupportsChunks(CURRENT_PROVIDER) && Boolean(CURRENT_RUN && CURRENT_RUN.chunks_file);
  CURRENT_CHUNK_LOOKUP = {};
  CURRENT_CHUNK_TYPE_FILTER = 'All';
  CURRENT_CHUNK_REVIEW_FILTER = 'All';
  CURRENT_ELEMENT_REVIEW_FILTER = 'All';
  BOX_INDEX = {};
  CURRENT_PAGE_BOXES = null;
  const pdfUrl = withProvider(`/pdf/${encodeURIComponent(slug)}`, CURRENT_PROVIDER);
  const loadingTask = window['pdfjsLib'].getDocument(pdfUrl);
  PDF_DOC = await loadingTask.promise;
  PAGE_COUNT = PDF_DOC.numPages;
  CURRENT_PAGE = 1;
  SCALE_IS_MANUAL = false;
  $('pageCount').textContent = PAGE_COUNT;
  await renderPage(CURRENT_PAGE);

  CURRENT_RUN_CONFIG = CURRENT_RUN?.run_config || null;
  CURRENT_CHUNK_SUMMARY = CURRENT_RUN?.chunk_summary || null;
  updateRunConfigCard();
  if (CURRENT_RUN_HAS_CHUNKS) {
    await loadChunksForRun(slug, CURRENT_PROVIDER);
    redrawOverlaysForCurrentContext(); // ensure overlays update once chunks are available
  } else {
    CURRENT_CHUNKS = null;
    renderChunksTab();
  }
  await loadElementTypes(slug, CURRENT_PROVIDER);
  populateTypeSelectors();
  const elemReviewSel = $('elementsReviewSelect');
  if (elemReviewSel) elemReviewSel.value = CURRENT_ELEMENT_REVIEW_FILTER;
  await loadReviews(slug, CURRENT_PROVIDER);

  // Refresh images tab if currently active
  if (CURRENT_VIEW === 'images' && typeof loadFiguresForCurrentRun === 'function') {
    loadFiguresForCurrentRun();
  }
}

async function init() {
  await loadPdfs();
  wireRunForm();
  setupInspectTabs();
  wireModal();
  wireChunkerModal();
  document.querySelectorAll('.view-tabs .tab').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.view || 'inspect';
      switchView(target);
      if (target === 'feedback' && !FEEDBACK_INDEX) {
        await refreshFeedbackIndex(FEEDBACK_PROVIDER_FILTER);
      }
    });
  });
  await (async function waitForPdfjs(maxMs = 5000) {
    const start = performance.now();
    while (!window['pdfjsLib']) {
      if (performance.now() - start > maxMs) throw new Error('pdf.js failed to load');
      await new Promise(r => setTimeout(r, 50));
    }
  })();
  await refreshRuns();
  await loadPdfs();
  await ensurePdfjsReady();
  await loadRunPreviewForSelectedPdf();
  $('prevPage').addEventListener('click', async () => {
    if (!PDF_DOC) return;
    const n = Math.max(1, CURRENT_PAGE - 1);
    await renderPage(n);
  });
  $('nextPage').addEventListener('click', async () => {
    if (!PDF_DOC) return;
    const n = Math.min(PAGE_COUNT, CURRENT_PAGE + 1);
    await renderPage(n);
  });
  $('zoom').addEventListener('input', async (e) => {
    SCALE_IS_MANUAL = true;
    SCALE = Number(e.target.value) / 100;
    await renderPage(CURRENT_PAGE);
  });
  $('fitWidth').addEventListener('click', async () => {
    if (!PDF_DOC) return;
    const page = await PDF_DOC.getPage(CURRENT_PAGE);
    const rotation = page.rotate || 0;
    const container = $('pdfContainer');
    const rect = container.getBoundingClientRect();
    const style = getComputedStyle(container);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    const availableWidth = rect.width - paddingLeft - paddingRight;
    const baseViewport = page.getViewport({ scale: 1, rotation });
    SCALE = availableWidth / baseViewport.width;
    SCALE_IS_MANUAL = true;
    updateZoomSlider();
    await renderPage(CURRENT_PAGE);
  });
  $('fitHeight').addEventListener('click', async () => {
    if (!PDF_DOC) return;
    const page = await PDF_DOC.getPage(CURRENT_PAGE);
    const rotation = page.rotate || 0;
    const container = $('pdfContainer');
    const rect = container.getBoundingClientRect();
    const style = getComputedStyle(container);
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const availableHeight = rect.height - paddingTop - paddingBottom;
    const baseViewport = page.getViewport({ scale: 1, rotation });
    SCALE = availableHeight / baseViewport.height;
    SCALE_IS_MANUAL = true;
    updateZoomSlider();
    await renderPage(CURRENT_PAGE);
  });
  const pageNumInput = $('pageNum');
  const jumpToPage = async () => {
    if (!PDF_DOC) return;
    let n = parseInt(pageNumInput.value, 10);
    if (isNaN(n) || n < 1) n = 1;
    if (n > PAGE_COUNT) n = PAGE_COUNT;
    await renderPage(n);
  };
  pageNumInput.addEventListener('change', jumpToPage);
  pageNumInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await jumpToPage();
      pageNumInput.blur();
    }
  });
  setupReviewChipHandlers();
  $('drawerClose').addEventListener('click', async () => {
    CURRENT_CHUNK_DRAWER_ID = null;
    CURRENT_ELEMENT_DRAWER_ID = null;
    if (RETURN_TO && RETURN_TO.kind === 'chunk') {
      const chunkId = RETURN_TO.id;
      const scrollTop = RETURN_TO.scrollTop;
      RETURN_TO = null;
      if (chunkId) {
        CURRENT_INSPECT_ELEMENT_ID = chunkId;
      }
      switchView('inspect', true);
      switchInspectTab('chunks', true);
      const listEl = document.getElementById('chunkList');
      if (listEl && scrollTop != null) listEl.scrollTop = scrollTop;
      if (chunkId) {
        await openChunkDetailsDrawer(chunkId, null);
        drawChunksModeForPage(CURRENT_PAGE);
      }
    } else {
      RETURN_TO = null;
      $('drawer').classList.add('hidden');
      document.body.classList.remove('drawer-open');
      CURRENT_ELEMENT_ID = null;
      CURRENT_INSPECT_ELEMENT_ID = null;
      redrawOverlaysForCurrentContext();
    }
  });
  switchView('inspect', true);
}

async function refreshRuns() {
  const runs = await fetchJSON('/api/runs');
  RUNS_CACHE = runs;
  const sel = $('runSelect');
  sel.innerHTML = '';
  for (const r of runs) {
    const opt = document.createElement('option');
    const prov = r.provider || 'unstructured/local';
    opt.value = runKey(r.slug, prov);
    opt.dataset.slug = r.slug;
    opt.dataset.provider = prov;
    const tag = r.page_range ? ` · pages ${r.page_range}` : '';
    const providerLabel = r.provider ? ` · ${r.provider}` : '';
    opt.textContent = `${r.slug}${providerLabel}${tag}`;
    sel.appendChild(opt);
  }
  if (runs.length) {
    // Try to restore last run from localStorage
    const lastRunKey = localStorage.getItem(LAST_RUN_KEY);
    let chosenRun = null;
    if (lastRunKey) {
      const { slug, provider } = parseRunKey(lastRunKey);
      chosenRun = runs.find(
        (r) => r.slug === slug && (r.provider || 'unstructured/local') === provider,
      );
    }
    // Fall back to existing selection or first run
    if (!chosenRun) {
      const existing = runs.find(
        (r) => r.slug === CURRENT_SLUG && (r.provider || 'unstructured/local') === (CURRENT_PROVIDER || 'unstructured/local'),
      );
      chosenRun = existing || runs[0];
    }
    CURRENT_SLUG = chosenRun.slug;
    CURRENT_PROVIDER = chosenRun.provider || 'unstructured/local';
    sel.value = runKey(CURRENT_SLUG, CURRENT_PROVIDER);
    await loadRun(CURRENT_SLUG, CURRENT_PROVIDER);
  } else {
    CURRENT_SLUG = null;
    CURRENT_RUN = null;
    CURRENT_RUN_CONFIG = null;
    CURRENT_RUN_HAS_CHUNKS = false;
    ELEMENT_TYPES = [];
    CHUNK_TYPES = [];
    CURRENT_CHUNKS = null;
    CURRENT_CHUNK_SUMMARY = null;
    CURRENT_CHUNK_LOOKUP = {};
    setReviewState(_emptyReviewState());
    resetPdfViewer();
    clearBoxes();
    updateLegend([]);
    clearDrawer();
    updateRunConfigCard();
    renderChunksTab();
    populateTypeSelectors();
    renderElementsListForCurrentPage(CURRENT_PAGE_BOXES);
    updateReviewSummaryChip();
  }
  sel.onchange = async () => {
    const { slug, provider } = parseRunKey(sel.value);
    CURRENT_SLUG = slug;
    CURRENT_PROVIDER = provider || 'unstructured/local';
    const selected = (RUNS_CACHE || []).find(
      (r) => r.slug === CURRENT_SLUG && (r.provider || 'unstructured/local') === CURRENT_PROVIDER,
    );
    if (selected && selected.provider) CURRENT_PROVIDER = selected.provider;
    localStorage.setItem(LAST_RUN_KEY, sel.value);
    await loadRun(CURRENT_SLUG, CURRENT_PROVIDER);
  };
}

async function loadPdfs(preferredName = null) {
  try {
    const list = await fetchJSON('/api/pdfs');
    KNOWN_PDFS = Array.isArray(list)
      ? list
        .map((item) => {
          if (item && typeof item === 'object') {
            return item.name || item.slug || null;
          }
          return item;
        })
        .filter((name) => name)
      : [];
  } catch (e) {
    KNOWN_PDFS = [];
  }
  const select = $('pdfSelect');
  if (!select) return;
  select.innerHTML = '';
  for (const name of KNOWN_PDFS) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  if (preferredName && KNOWN_PDFS.includes(preferredName)) {
    select.value = preferredName;
  }
}

function setChunksTabVisible(show) {
  const tab = document.querySelector('.inspect-tabs .tab[data-inspect=\"chunks\"]');
  const pane = document.getElementById('pane-inspect-chunks');
  if (tab) tab.classList.toggle('hidden', !show);
  if (pane) pane.classList.toggle('hidden', !show);
  if (!show && INSPECT_TAB === 'chunks') {
    switchInspectTab('elements', true);
  }
}

function setupInspectTabs() {
  const tabs = document.querySelectorAll('.inspect-tabs .tab');
  for (const t of tabs) {
    t.addEventListener('click', () => switchInspectTab(t.dataset.inspect));
  }
  const deleteBtn = $('pdfDeleteBtn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async (ev) => {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
      const sel = $('pdfSelect');
      const name = sel && sel.value;
      if (!name) { showToast('No PDF selected', 'err', 2000); return; }
      try { await refreshRuns(); } catch (_) {}
      const stem = name.replace(/\.pdf$/i, '');
      const runs = (RUNS_CACHE || []).filter(r => {
        const cfg = r.run_config || {};
        const pdfFromCfg = cfg.pdf || (cfg.form_snapshot && cfg.form_snapshot.pdf) || null;
        if (pdfFromCfg && pdfFromCfg === name) return true;
        let base = r.slug || '';
        if (base.includes('.pages')) base = base.split('.pages')[0];
        if (base.includes('__')) base = base.split('__')[0];
        return base === stem;
      });
      let deleteRunsToo = false;
      if (runs.length > 0) {
        const listPreview = runs.slice(0, 5).map(r => `- ${r.slug}`).join('\n');
        const more = runs.length > 5 ? `\n…and ${runs.length - 5} more` : '';
        const msg = `Found ${runs.length} run(s) referencing ${name}:\n${listPreview}${more}\n\nDelete the PDF and ALL associated runs?`;
        deleteRunsToo = !!confirm(msg);
        if (!deleteRunsToo) {
          const onlyPdf = confirm(`Delete the PDF only and keep ${runs.length} run(s)?`);
          if (!onlyPdf) return;
        }
      } else {
        const ok = confirm(`Delete PDF: ${name}? This removes it from server storage; runs remain intact.`);
        if (!ok) return;
      }
      try {
        if (deleteRunsToo && runs.length > 0) {
          let okCount = 0, failCount = 0;
          for (const rr of runs) {
            try {
              const dr = await fetch(withProvider(`/api/run/${encodeURIComponent(rr.slug)}`, rr.provider || CURRENT_PROVIDER), { method: 'DELETE' });
              if (!dr.ok) failCount++; else okCount++;
            } catch (_) {
              failCount++;
            }
          }
          await refreshRuns();
          showToast(`Deleted runs: ${okCount} ok, ${failCount} failed`, failCount ? 'err' : 'ok', 3000);
        }
        const r = await fetch(`/api/pdfs/${encodeURIComponent(name)}`, { method: 'DELETE' });
        let data = null; try { data = await r.json(); } catch (e) { data = null; }
        if (!r.ok) throw new Error((data && data.detail) || `HTTP ${r.status}`);
        showToast(`Deleted ${name}`, 'ok', 2000);
        await loadPdfs();
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

function switchInspectTab(name, skipRedraw = false) {
  INSPECT_TAB = (name === 'elements') ? 'elements' : 'chunks';
  document.querySelectorAll('.inspect-tabs .tab').forEach(el => el.classList.toggle('active', el.dataset.inspect === INSPECT_TAB));
  document.querySelectorAll('#right-inspect .pane').forEach(el => el.classList.toggle('active', el.id === `pane-inspect-${INSPECT_TAB}`));
  SHOW_CHUNK_OVERLAYS = (INSPECT_TAB === 'chunks');
  SHOW_ELEMENT_OVERLAYS = (INSPECT_TAB === 'elements');
  if (!skipRedraw) {
    redrawOverlaysForCurrentContext();
  }
  updateReviewSummaryChip();
}

function setupReviewChipHandlers() {
  const chip = $('reviewSummaryChip');
  if (!chip) return;
  chip.addEventListener('click', (ev) => {
    const line = ev.target.closest('.review-chip-line');
    if (!line || !line.dataset.kind) return;
    handleReviewChipClick(line.dataset.kind);
  });
}

function handleReviewChipClick(kind) {
  if (kind === 'chunks') {
    CURRENT_CHUNK_REVIEW_FILTER = 'Reviewed';
    renderChunksTab();
    switchInspectTab('chunks');
  }
  if (kind === 'elements') {
    CURRENT_ELEMENT_REVIEW_FILTER = 'Reviewed';
    renderElementsListForCurrentPage(CURRENT_PAGE_BOXES);
    refreshElementOverlaysForCurrentPage();
    switchInspectTab('elements');
  }
}

function switchView(view, skipRedraw = false) {
  const next = view === 'feedback' ? 'feedback' : (view === 'images' ? 'images' : 'inspect');
  CURRENT_VIEW = next;
  document.querySelectorAll('.view-tabs .tab').forEach(el => {
    const active = el.dataset.view === CURRENT_VIEW;
    el.classList.toggle('active', active);
    try { el.setAttribute('aria-selected', active ? 'true' : 'false'); } catch (_) {}
  });
  const inspectShell = $('inspectShell');
  if (inspectShell) inspectShell.classList.toggle('hidden', CURRENT_VIEW !== 'inspect');
  const inspectPane = document.getElementById('right-inspect');
  if (inspectPane) inspectPane.classList.toggle('hidden', CURRENT_VIEW !== 'inspect');
  const feedbackPane = $('feedbackView');
  if (feedbackPane) feedbackPane.classList.toggle('hidden', CURRENT_VIEW !== 'feedback');
  const imagesPane = $('imagesView');
  if (imagesPane) imagesPane.classList.toggle('hidden', CURRENT_VIEW !== 'images');
  if (CURRENT_VIEW === 'feedback' || CURRENT_VIEW === 'images') {
    SHOW_CHUNK_OVERLAYS = false;
    SHOW_ELEMENT_OVERLAYS = false;
    clearDrawer();
  } else {
    SHOW_CHUNK_OVERLAYS = (INSPECT_TAB === 'chunks');
    SHOW_ELEMENT_OVERLAYS = (INSPECT_TAB === 'elements');
  }
  if (CURRENT_VIEW === 'inspect' && !skipRedraw) {
    redrawOverlaysForCurrentContext();
  }
  if (CURRENT_VIEW === 'images' && typeof onImagesTabActivated === 'function') {
    onImagesTabActivated();
  }
}

// Window exports
window.resolveProvider = resolveProvider;
window.runKey = runKey;
window.parseRunKey = parseRunKey;
window.providerSupportsChunks = providerSupportsChunks;
window.loadRun = loadRun;
window.init = init;
window.refreshRuns = refreshRuns;
window.loadPdfs = loadPdfs;
window.setChunksTabVisible = setChunksTabVisible;
window.setupInspectTabs = setupInspectTabs;
window.switchInspectTab = switchInspectTab;
window.setupReviewChipHandlers = setupReviewChipHandlers;
window.handleReviewChipClick = handleReviewChipClick;
window.switchView = switchView;
window.sleep = sleep;
