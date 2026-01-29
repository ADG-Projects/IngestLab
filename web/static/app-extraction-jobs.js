/**
 * Extraction job polling and progress tracking
 * Extracted from app-extractions.js for modularity
 */

const EXTRACTION_JOB_POLL_INTERVAL_MS = 10000;

function describeJobStatus(detail, providerName = 'provider') {
  const status = detail?.status || 'queued';
  const nowSec = Date.now() / 1000;
  if (status === 'running') {
    if (detail?.started_at) {
      const secs = Math.max(1, Math.round(nowSec - detail.started_at));
      return `${providerName} is running (${secs}s elapsed)`;
    }
    return `${providerName} is running…`;
  }
  if (status === 'queued') {
    if (detail?.created_at) {
      const secs = Math.max(1, Math.round(nowSec - detail.created_at));
      return `Queued for ${secs}s (waiting for worker)`;
    }
    return 'Queued – waiting for worker…';
  }
  if (status === 'succeeded') return 'Completed';
  if (status === 'failed') return detail?.error || 'Extraction failed';
  return 'Preparing extraction…';
}

function updateExtractionJobProgress(detail) {
  CURRENT_EXTRACTION_JOB_STATUS = detail;
  const status = detail?.status || 'queued';
  const pdfName = detail?.pdf || '';
  const pages = detail?.pages || '';
  const providerName = (detail?.provider || detail?.result?.provider || CURRENT_PROVIDER || 'provider').trim() || 'provider';
  const titleEl = $('extractionProgressTitle');
  const hint = $('extractionProgressHint');
  const statusEl = $('extractionProgressStatus');
  const logsEl = $('extractionProgressLogs');
  if (titleEl) {
    if (status === 'running') titleEl.textContent = `${providerName} is extracting…`;
    else if (status === 'queued') titleEl.textContent = 'Queued…';
    else if (status === 'failed') titleEl.textContent = 'Extraction failed';
    else if (status === 'succeeded') titleEl.textContent = 'Extraction completed';
    else titleEl.textContent = 'Working…';
  }
  if (hint) {
    const suffix = pages ? `pages ${pages}` : 'all pages';
    hint.textContent = pdfName ? `Processing ${pdfName} (${suffix}) via ${providerName}` : `Processing PDF via ${providerName}`;
  }
  if (statusEl) {
    statusEl.textContent = describeJobStatus(detail, providerName);
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

async function pollExtractionJob(jobId) {
  CURRENT_EXTRACTION_JOB_ID = jobId;
  const statusSpan = $('extractionStatus');
  const openBtn = $('openExtractionModal');
  const cancelBtn = $('cancelExtractionBtn');
  while (CURRENT_EXTRACTION_JOB_ID === jobId) {
    let detail = null;
    try {
      detail = await fetchJSON(`/api/extraction-jobs/${encodeURIComponent(jobId)}`);
    } catch (err) {
      const msg = err?.message || String(err || '');
      if (msg.includes('404')) {
        if (statusSpan) statusSpan.textContent = 'Job not found (assuming finished)';
        try { await refreshExtractions(); } catch (_) {}
        setExtractionInProgress(false);
        closeExtractionModal();
        CURRENT_EXTRACTION_JOB_ID = null;
        return;
      }
      if (statusSpan) statusSpan.textContent = `Polling job… ${msg}`;
      await sleep(EXTRACTION_JOB_POLL_INTERVAL_MS);
      continue;
    }
    updateExtractionJobProgress(detail);
    const status = detail?.status;
    if (status === 'succeeded') {
      if (statusSpan) statusSpan.textContent = 'Completed';
      const slug = detail?.result?.slug;
      const provider = detail?.provider || detail?.result?.provider || CURRENT_PROVIDER || 'unstructured/local';
      if (provider) CURRENT_PROVIDER = provider;
      if (slug) CURRENT_SLUG = slug;
      try {
        await refreshExtractions();
      } catch (err) {
        console.warn('Failed to refresh extractions after job completion', err);
      }
      setExtractionInProgress(false);
      closeExtractionModal();
      showToast('Extraction completed', 'ok', 2500);
      CURRENT_EXTRACTION_JOB_ID = null;
      return;
    }
    if (status === 'failed') {
      const errMsg = detail?.error || 'Extraction failed';
      setExtractionInProgress(false);
      if (statusSpan) statusSpan.textContent = `Failed: ${errMsg}`;
      if (cancelBtn) cancelBtn.disabled = false;
      if (openBtn) {
        openBtn.disabled = false;
        openBtn.textContent = 'New Extraction';
      }
      showToast(`Extraction failed: ${errMsg}`, 'err', 3500);
      CURRENT_EXTRACTION_JOB_ID = null;
      return;
    }
    await sleep(EXTRACTION_JOB_POLL_INTERVAL_MS);
  }
}

function setExtractionInProgress(isRunning, context = {}) {
  const modal = $('extractionModal');
  const extractionBtn = $('extractionBtn');
  const cancelBtn = $('cancelExtractionBtn');
  const openBtn = $('openExtractionModal');
  const status = $('extractionStatus');
  const hint = $('extractionProgressHint');
  const formGrid = $('extractionFormGrid');
  const previewPane = $('extractionPreviewPane');
  const progressPane = $('extractionProgressPane');
  const progressTitle = $('extractionProgressTitle');
  const progressStatus = $('extractionProgressStatus');
  const logs = $('extractionProgressLogs');
  if (!modal || !extractionBtn || !status) return;

  const providerName = (context.provider || $('providerSelect')?.value || CURRENT_PROVIDER || '').trim() || 'provider';

  if (isRunning) {
    modal.classList.add('extracting');
    if (formGrid) formGrid.style.display = 'none';
    if (previewPane) previewPane.style.display = 'none';
    if (progressPane) progressPane.style.display = 'block';
    extractionBtn.disabled = true;
    extractionBtn.textContent = `Extracting (${providerName})…`;
    if (cancelBtn) cancelBtn.disabled = true;
    if (openBtn) {
      openBtn.disabled = true;
      openBtn.textContent = `Extracting (${providerName})…`;
    }
    const pdfName = context.pdf || $('pdfSelect')?.value || '';
    if (hint) {
      hint.textContent = pdfName
        ? `Processing ${pdfName} via ${providerName}. This window will close when extraction finishes.`
        : `Processing PDF via ${providerName}. This window will close when extraction finishes.`;
    }
    if (progressTitle) progressTitle.textContent = 'Queued…';
    if (progressStatus) progressStatus.textContent = 'Waiting for worker…';
    if (logs) { logs.textContent = ''; logs.style.display = 'none'; }
    status.textContent = '';
  } else {
    modal.classList.remove('extracting');
    if (formGrid) formGrid.style.display = '';
    if (previewPane) previewPane.style.display = '';
    if (progressPane) progressPane.style.display = '';
    extractionBtn.disabled = false;
    extractionBtn.textContent = 'Extract';
    if (cancelBtn) cancelBtn.disabled = false;
    if (openBtn) {
      openBtn.disabled = false;
      openBtn.textContent = 'New Extraction';
    }
    if (progressTitle) progressTitle.textContent = 'Extraction ready';
    if (progressStatus) progressStatus.textContent = '';
    if (logs) { logs.textContent = ''; logs.style.display = 'none'; }
    if (hint) hint.textContent = '';
    CURRENT_EXTRACTION_JOB_ID = null;
    CURRENT_EXTRACTION_JOB_STATUS = null;
  }
}

// Window exports
window.describeJobStatus = describeJobStatus;
window.updateExtractionJobProgress = updateExtractionJobProgress;
window.pollExtractionJob = pollExtractionJob;
window.setExtractionInProgress = setExtractionInProgress;
