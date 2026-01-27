/**
 * PDF rendering and zoom controls
 * Extracted from app-runs.js for modularity
 */

function updateZoomSlider() {
  const zoomInput = $('zoom');
  if (!zoomInput) return;
  let pct = Math.round(SCALE * 100);
  const min = Number(zoomInput.min) || 50;
  const max = Number(zoomInput.max) || 200;
  pct = Math.max(min, Math.min(max, pct));
  zoomInput.value = String(pct);
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
  $('pageNum').value = num;
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
  if (pageNumEl) pageNumEl.value = '';
  const pageCountEl = $('pageCount');
  if (pageCountEl) pageCountEl.textContent = '-';
}

// Window exports
window.updateZoomSlider = updateZoomSlider;
window.renderPage = renderPage;
window.resetPdfViewer = resetPdfViewer;
