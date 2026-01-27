/**
 * Run preview helpers and page range utilities
 * Extracted from app-runs.js for modularity
 */

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

// Window exports
window.ensurePdfjsReady = ensurePdfjsReady;
window.loadRunPreviewForSelectedPdf = loadRunPreviewForSelectedPdf;
window.renderRunPreviewPage = renderRunPreviewPage;
window.updateRangeHint = updateRangeHint;
window.parsePagesString = parsePagesString;
window.encodePagesSet = encodePagesSet;
window.addPageToInput = addPageToInput;
window.addRangeToInput = addRangeToInput;
