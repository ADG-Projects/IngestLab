/**
 * Extraction preview helpers and page range utilities
 * Extracted from app-extractions.js for modularity
 */

async function ensurePdfjsReady(maxMs = 5000) {
  const start = performance.now();
  while (!window['pdfjsLib']) {
    if (performance.now() - start > maxMs) throw new Error('pdf.js failed to load');
    await new Promise(r => setTimeout(r, 50));
  }
}

async function loadExtractionPreviewForSelectedPdf() {
  const name = $('pdfSelect')?.value;
  if (!name) return;

  const canvas = $('extractionPdfCanvas');
  const previewMsg = $('extractionPreviewMessage');
  const formatBadge = $('extractionFormatBadge');

  // Check if this is a non-PDF file (Office doc or image)
  const ext = name.toLowerCase().substring(name.lastIndexOf('.'));
  const isPdf = ext === '.pdf';
  const isImage = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.heif'].includes(ext);
  const isOffice = ['.docx', '.xlsx', '.pptx'].includes(ext);

  // Update format badge
  if (formatBadge) {
    const extDisplay = ext.replace('.', '').toUpperCase();
    formatBadge.textContent = extDisplay;
    formatBadge.className = 'format-badge';
    if (isPdf) formatBadge.classList.add('format-pdf');
    else if (isOffice) formatBadge.classList.add('format-office');
    else if (isImage) formatBadge.classList.add('format-image');
    formatBadge.style.display = 'inline-block';
  }

  // Show/hide preview message
  if (previewMsg) {
    if (isOffice) {
      previewMsg.textContent = 'Preview available after extraction (Office documents are converted to PDF)';
      previewMsg.style.display = 'block';
    } else if (isImage) {
      previewMsg.textContent = '';
      previewMsg.style.display = 'none';
    } else {
      previewMsg.textContent = '';
      previewMsg.style.display = 'none';
    }
  }

  // For images, show the image directly
  if (isImage) {
    EXTRACTION_PREVIEW_DOC = null;
    EXTRACTION_PREVIEW_COUNT = 1;
    EXTRACTION_PREVIEW_PAGE = 1;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      const img = new Image();
      img.onload = () => {
        const maxW = 400, maxH = 500;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      img.src = `/res_pdf/${encodeURIComponent(name)}`;
    }
    $('extractionPageNum').textContent = '1';
    $('extractionPageCount').textContent = '1';
    return;
  }

  // For Office docs, check if a converted PDF exists from a previous run
  if (isOffice) {
    try {
      // Try to load converted PDF from previous extraction
      const checkResp = await fetch(`/api/converted-pdf/${encodeURIComponent(name)}`, { method: 'HEAD' });
      if (checkResp.ok) {
        // Converted PDF exists - load it with PDF.js
        if (previewMsg) previewMsg.style.display = 'none';
        await ensurePdfjsReady();
        const url = `/api/converted-pdf/${encodeURIComponent(name)}`;
        const task = window['pdfjsLib'].getDocument(url);
        EXTRACTION_PREVIEW_DOC = await task.promise;
        EXTRACTION_PREVIEW_COUNT = EXTRACTION_PREVIEW_DOC.numPages;
        EXTRACTION_PREVIEW_PAGE = 1;
        $('extractionPageCount').textContent = EXTRACTION_PREVIEW_COUNT;
        await renderExtractionPreviewPage();
        return;
      }
    } catch (e) {
      // No converted PDF available, show placeholder
    }

    // No converted PDF - show placeholder message
    EXTRACTION_PREVIEW_DOC = null;
    EXTRACTION_PREVIEW_COUNT = 0;
    EXTRACTION_PREVIEW_PAGE = 1;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    $('extractionPageNum').textContent = '-';
    $('extractionPageCount').textContent = '-';
    return;
  }

  // For PDFs, use PDF.js
  try {
    await ensurePdfjsReady();
    const url = `/res_pdf/${encodeURIComponent(name)}`;
    const task = window['pdfjsLib'].getDocument(url);
    EXTRACTION_PREVIEW_DOC = await task.promise;
    EXTRACTION_PREVIEW_COUNT = EXTRACTION_PREVIEW_DOC.numPages;
    EXTRACTION_PREVIEW_PAGE = 1;
    $('extractionPageCount').textContent = EXTRACTION_PREVIEW_COUNT;
    await renderExtractionPreviewPage();
  } catch (e) {
    EXTRACTION_PREVIEW_DOC = null;
    EXTRACTION_PREVIEW_COUNT = 0;
    EXTRACTION_PREVIEW_PAGE = 1;
    if (canvas) { const ctx = canvas.getContext('2d'); ctx && ctx.clearRect(0,0,canvas.width,canvas.height); }
    const numEl = $('extractionPageNum'); const cntEl = $('extractionPageCount');
    if (numEl) numEl.textContent = '-'; if (cntEl) cntEl.textContent = '-';
  }
}

async function renderExtractionPreviewPage() {
  if (!EXTRACTION_PREVIEW_DOC) return;
  const page = await EXTRACTION_PREVIEW_DOC.getPage(EXTRACTION_PREVIEW_PAGE);
  const canvas = $('extractionPdfCanvas');
  const ctx = canvas.getContext('2d');
  const viewport = page.getViewport({ scale: 0.8 });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  $('extractionPageNum').textContent = EXTRACTION_PREVIEW_PAGE;
  await page.render({ canvasContext: ctx, viewport }).promise;
}

function updateRangeHint() {
  const el = $('rangeHint');
  if (!el) return;
  if (EXTRACTION_RANGE_START != null) el.textContent = `range start: ${EXTRACTION_RANGE_START}`; else el.textContent = '';
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
window.loadExtractionPreviewForSelectedPdf = loadExtractionPreviewForSelectedPdf;
window.renderExtractionPreviewPage = renderExtractionPreviewPage;
window.updateRangeHint = updateRangeHint;
window.parsePagesString = parsePagesString;
window.encodePagesSet = encodePagesSet;
window.addPageToInput = addPageToInput;
window.addRangeToInput = addRangeToInput;
