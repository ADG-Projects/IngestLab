const RUN_JOB_POLL_INTERVAL_MS = 10000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadRun(slug) {
  CURRENT_SLUG = slug;
  CURRENT_RUN = (RUNS_CACHE || []).find(r => r.slug === slug) || null;
  CURRENT_RUN_HAS_CHUNKS = Boolean(CURRENT_RUN && CURRENT_RUN.chunks_file);
  CURRENT_CHUNK_LOOKUP = {};
  CURRENT_CHUNK_TYPE_FILTER = 'All';
  CURRENT_CHUNK_REVIEW_FILTER = 'All';
  CURRENT_ELEMENT_REVIEW_FILTER = 'All';
  BOX_INDEX = {};
  CURRENT_PAGE_BOXES = null;
  const pdfUrl = `/pdf/${encodeURIComponent(slug)}`;
  const loadingTask = window['pdfjsLib'].getDocument(pdfUrl);
  PDF_DOC = await loadingTask.promise;
  PAGE_COUNT = PDF_DOC.numPages;
  CURRENT_PAGE = 1;
  SCALE_IS_MANUAL = false;
  $('pageCount').textContent = PAGE_COUNT;
  await renderPage(CURRENT_PAGE);

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
  const elemReviewSel = $('elementsReviewSelect');
  if (elemReviewSel) elemReviewSel.value = CURRENT_ELEMENT_REVIEW_FILTER;
  await loadReviews(slug);
}

async function renderPage(num) {
  CURRENT_PAGE = num;
  const page = await PDF_DOC.getPage(num);
  const rotation = page.rotate || 0;
  const container = $('pdfContainer');
  const containerHeight = Math.max(0, (container?.clientHeight || 0) - 24);
  const baseViewport = page.getViewport({ scale: 1, rotation });
  const scaleToFit = containerHeight / baseViewport.height;
  if (!SCALE_IS_MANUAL) {
    SCALE = scaleToFit;
    const zoomInput = $('zoom');
    if (zoomInput) {
      let pct = Math.round(SCALE * 100);
      const min = zoomInput.min ? Number(zoomInput.min) : null;
      const max = zoomInput.max ? Number(zoomInput.max) : null;
      if (min !== null && pct < min) pct = min;
      if (max !== null && pct > max) pct = max;
      zoomInput.value = String(pct);
    }
  }
  const viewport = page.getViewport({ scale: SCALE, rotation });
  const canvas = $('pdfCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const deviceScale = window.devicePixelRatio || 1;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  canvas.width = Math.floor(viewport.width * deviceScale);
  canvas.height = Math.floor(viewport.height * deviceScale);
  const overlay = $('overlay');
  if (overlay) {
    overlay.style.width = `${viewport.width}px`;
    overlay.style.height = `${viewport.height}px`;
  }
  $('pageNum').textContent = num;
  const inflightTask = window.CURRENT_RENDER_TASK;
  if (inflightTask?.cancel) {
    try {
      inflightTask.cancel();
    } catch (err) {
      console.warn('Failed to cancel in-flight render', err);
    }
  }
  clearBoxes();
  const renderContext = { canvasContext: ctx, viewport };
  if (deviceScale !== 1) {
    renderContext.transform = [deviceScale, 0, 0, deviceScale, 0, 0];
  }
  const renderTask = page.render(renderContext);
  window.CURRENT_RENDER_TASK = renderTask;
  try {
    await renderTask.promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') throw err;
    return;
  } finally {
    if (window.CURRENT_RENDER_TASK === renderTask) {
      window.CURRENT_RENDER_TASK = null;
    }
  }
  if (CURRENT_VIEW === 'inspect' && INSPECT_TAB === 'chunks') {
    renderChunksTab();
  }
  redrawOverlaysForCurrentContext();
}

function resetPdfViewer() {
  PDF_DOC = null;
  PAGE_COUNT = 0;
  CURRENT_PAGE = 1;
  CURRENT_PAGE_BOXES = null;
  LAST_SELECTED_MATCH = null;
  const canvas = $('pdfCanvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const w = canvas.width || 0;
      const h = canvas.height || 0;
      ctx.clearRect(0, 0, w, h);
    }
    canvas.width = 0;
    canvas.height = 0;
  }
  const overlay = $('overlay');
  if (overlay) {
    overlay.style.width = '0px';
    overlay.style.height = '0px';
    overlay.innerHTML = '';
  }
  const pageNumEl = $('pageNum');
  if (pageNumEl) pageNumEl.textContent = '-';
  const pageCountEl = $('pageCount');
  if (pageCountEl) pageCountEl.textContent = '-';
}

async function init() {
  await loadPdfs();
  wireRunForm();
  setupViewTabs();
  setupInspectTabs();
  wireModal();
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
    if (LAST_SELECTED_MATCH) drawTargetsOnPage(n, LAST_SELECTED_MATCH, LAST_HIGHLIGHT_MODE === 'best');
  });
  $('nextPage').addEventListener('click', async () => {
    if (!PDF_DOC) return;
    const n = Math.min(PAGE_COUNT, CURRENT_PAGE + 1);
    await renderPage(n);
    if (LAST_SELECTED_MATCH) drawTargetsOnPage(n, LAST_SELECTED_MATCH, LAST_HIGHLIGHT_MODE === 'best');
  });
  $('zoom').addEventListener('input', async (e) => {
    SCALE_IS_MANUAL = true;
    SCALE = Number(e.target.value) / 100;
    await renderPage(CURRENT_PAGE);
    if (LAST_SELECTED_MATCH) drawTargetsOnPage(CURRENT_PAGE, LAST_SELECTED_MATCH, LAST_HIGHLIGHT_MODE === 'best');
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
  switchView(CURRENT_VIEW);
}

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
    resetPdfViewer();
    const ctx = document.getElementById('chart')?.getContext?.('2d');
    if (CHART_INSTANCE) { try { CHART_INSTANCE.destroy(); } catch(e){} CHART_INSTANCE=null; }
    document.getElementById('matchList').innerHTML = '';
    renderMetrics({ avg_coverage:0, avg_cohesion:0, avg_chunker_f1:0, micro_coverage:0 });
    clearBoxes();
    updateRunConfigCard();
    renderChunksTab();
    setReviewState(_emptyReviewState());
    updateReviewSummaryChip();
  }
  sel.onchange = async () => {
    CURRENT_SLUG = sel.value;
    await loadRun(CURRENT_SLUG);
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

function setRunInProgress(isRunning, context = {}) {
  const modal = $('runModal');
  const runBtn = $('runBtn');
  const cancelBtn = $('cancelRunBtn');
  const openBtn = $('openRunModal');
  const status = $('runStatus');
  const hint = $('runProgressHint');
  const formGrid = $('runFormGrid');
  const previewPane = $('runPreviewPane');
  const progressPane = $('runProgressPane');
  const progressTitle = $('runProgressTitle');
  const progressStatus = $('runProgressStatus');
  const logs = $('runProgressLogs');
  if (!modal || !runBtn || !status) return;

  if (isRunning) {
    modal.classList.add('running');
    if (formGrid) formGrid.style.display = 'none';
    if (previewPane) previewPane.style.display = 'none';
    if (progressPane) progressPane.style.display = 'block';
    runBtn.disabled = true;
    runBtn.textContent = 'Running…';
    if (cancelBtn) cancelBtn.disabled = true;
    if (openBtn) {
      openBtn.disabled = true;
      openBtn.textContent = 'Running…';
    }
    const pdfName = context.pdf || $('pdfSelect')?.value || '';
    if (hint) {
      hint.textContent = pdfName
        ? `Processing ${pdfName}. This window will close when the run finishes.`
        : 'Processing PDF. This window will close when the run finishes.';
    }
    if (progressTitle) progressTitle.textContent = 'Queued…';
    if (progressStatus) progressStatus.textContent = 'Waiting for worker…';
    if (logs) { logs.textContent = ''; logs.style.display = 'none'; }
    status.textContent = '';
  } else {
    modal.classList.remove('running');
    if (formGrid) formGrid.style.display = '';
    if (previewPane) previewPane.style.display = '';
    if (progressPane) progressPane.style.display = '';
    runBtn.disabled = false;
    runBtn.textContent = 'Run';
    if (cancelBtn) cancelBtn.disabled = false;
    if (openBtn) {
      openBtn.disabled = false;
      openBtn.textContent = 'New Run';
    }
    if (progressTitle) progressTitle.textContent = 'Run ready';
    if (progressStatus) progressStatus.textContent = '';
    if (logs) { logs.textContent = ''; logs.style.display = 'none'; }
    if (hint) hint.textContent = '';
    CURRENT_RUN_JOB_ID = null;
    CURRENT_RUN_JOB_STATUS = null;
  }
}

function describeJobStatus(detail) {
  const status = detail?.status || 'queued';
  const nowSec = Date.now() / 1000;
  if (status === 'running') {
    if (detail?.started_at) {
      const secs = Math.max(1, Math.round(nowSec - detail.started_at));
      return `Chunker is running (${secs}s elapsed)`;
    }
    return 'Chunker is running…';
  }
  if (status === 'queued') {
    if (detail?.created_at) {
      const secs = Math.max(1, Math.round(nowSec - detail.created_at));
      return `Queued for ${secs}s (waiting for worker)`;
    }
    return 'Queued – waiting for worker…';
  }
  if (status === 'succeeded') return 'Completed';
  if (status === 'failed') return detail?.error || 'Run failed';
  return 'Preparing run…';
}

function updateRunJobProgress(detail) {
  CURRENT_RUN_JOB_STATUS = detail;
  const status = detail?.status || 'queued';
  const pdfName = detail?.pdf || '';
  const pages = detail?.pages || '';
  const titleEl = $('runProgressTitle');
  const hint = $('runProgressHint');
  const statusEl = $('runProgressStatus');
  const logsEl = $('runProgressLogs');
  if (titleEl) {
    if (status === 'running') titleEl.textContent = 'Chunker is running…';
    else if (status === 'queued') titleEl.textContent = 'Queued…';
    else if (status === 'failed') titleEl.textContent = 'Run failed';
    else if (status === 'succeeded') titleEl.textContent = 'Run completed';
    else titleEl.textContent = 'Working…';
  }
  if (hint) {
    const suffix = pages ? `pages ${pages}` : 'all pages';
    hint.textContent = pdfName ? `Processing ${pdfName} (${suffix})` : 'Processing PDF';
  }
  if (statusEl) {
    statusEl.textContent = describeJobStatus(detail);
  }
  if (logsEl) {
    const logText = detail?.stderr_tail || detail?.stdout_tail || '';
    if (logText) {
      logsEl.textContent = logText;
      logsEl.style.display = 'block';
    } else if (status === 'failed' && detail?.error) {
      logsEl.textContent = detail.error;
      logsEl.style.display = 'block';
    } else {
      logsEl.textContent = '';
      logsEl.style.display = 'none';
    }
  }
}

async function pollRunJob(jobId) {
  CURRENT_RUN_JOB_ID = jobId;
  const statusSpan = $('runStatus');
  const openBtn = $('openRunModal');
  const cancelBtn = $('cancelRunBtn');
  while (CURRENT_RUN_JOB_ID === jobId) {
    let detail = null;
    try {
      detail = await fetchJSON(`/api/run-jobs/${encodeURIComponent(jobId)}`);
    } catch (err) {
      if (statusSpan) statusSpan.textContent = `Polling job… ${err?.message || err}`;
      await sleep(RUN_JOB_POLL_INTERVAL_MS);
      continue;
    }
    updateRunJobProgress(detail);
    const status = detail?.status;
    if (status === 'succeeded') {
      if (statusSpan) statusSpan.textContent = 'Completed';
      const slug = detail?.result?.slug;
      if (slug) CURRENT_SLUG = slug;
      try {
        await refreshRuns();
      } catch (err) {
        console.warn('Failed to refresh runs after job completion', err);
      }
      setRunInProgress(false);
      closeRunModal();
      showToast('Run completed', 'ok', 2500);
      CURRENT_RUN_JOB_ID = null;
      return;
    }
    if (status === 'failed') {
      const errMsg = detail?.error || 'Run failed';
      if (statusSpan) statusSpan.textContent = `Failed: ${errMsg}`;
      if (cancelBtn) cancelBtn.disabled = false;
      if (openBtn) {
        openBtn.disabled = false;
        openBtn.textContent = 'New Run';
      }
      const hint = $('runProgressHint');
      if (hint) hint.textContent = 'Run failed. Close this window to adjust parameters.';
      CURRENT_RUN_JOB_ID = null;
      return;
    }
    await sleep(RUN_JOB_POLL_INTERVAL_MS);
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
    setRunInProgress(true, { pdf: payload.pdf });
    let jobId = null;
    try {
      const r = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.detail || `HTTP ${r.status}`);
      jobId = data?.job?.id || null;
      if (!jobId) throw new Error('Server did not return a job id');
      if (status) status.textContent = 'Queued…';
      const tagInput = $('variantTag');
      if (tagInput) tagInput.value = '';
      await pollRunJob(jobId);
    } catch (e) {
      status.textContent = `Failed: ${e.message}`;
    } finally {
      if (!jobId) {
        setRunInProgress(false);
      }
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
              const dr = await fetch(`/api/run/${encodeURIComponent(rr.slug)}`, { method: 'DELETE' });
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

function setupViewTabs() {
  const m = $('viewTabMetrics');
  const i = $('viewTabInspect');
  if (m) m.addEventListener('click', () => switchView('metrics'));
  if (i) i.addEventListener('click', () => switchView('inspect'));
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
  if (CURRENT_VIEW !== 'inspect') return;
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
  CURRENT_VIEW = (view === 'inspect') ? 'inspect' : 'metrics';
  document.querySelectorAll('.view-tabs .tab').forEach(el => {
    el.classList.toggle('active', el.dataset.view === CURRENT_VIEW);
  });
  const metricsPane = document.getElementById('right-metrics');
  const inspectPane = document.getElementById('right-inspect');
  if (metricsPane) metricsPane.classList.toggle('hidden', CURRENT_VIEW !== 'metrics');
  if (inspectPane) inspectPane.classList.toggle('hidden', CURRENT_VIEW !== 'inspect');
  if (!skipRedraw) {
    redrawOverlaysForCurrentContext();
  }
}

function wireModal() {
  const openBtn = $('openRunModal');
  const deleteBtn = $('deleteRunBtn');
  const closeBtn = $('closeRunModal');
  const backdrop = $('runModalBackdrop');
  const modal = $('runModal');
  openBtn.addEventListener('click', () => {
    const s = $('pdfSelect');
    if (s) s.disabled = false;
    modal.classList.remove('hidden');
    modal.classList.remove('running');
    const status = $('runStatus');
    if (status) status.textContent = '';
  });
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
  if (modal) {
    const status = $('runStatus');
    if (status) status.textContent = '';
    modal.classList.add('hidden');
    modal.classList.remove('running');
  }
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
    RUN_PREVIEW_DOC = null;
    RUN_PREVIEW_COUNT = 0;
    RUN_PREVIEW_PAGE = 1;
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
