/**
 * Run job polling and progress tracking
 * Extracted from app-runs.js for modularity
 */

const RUN_JOB_POLL_INTERVAL_MS = 10000;

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
  if (status === 'failed') return detail?.error || 'Run failed';
  return 'Preparing run…';
}

function updateRunJobProgress(detail) {
  CURRENT_RUN_JOB_STATUS = detail;
  const status = detail?.status || 'queued';
  const pdfName = detail?.pdf || '';
  const pages = detail?.pages || '';
  const providerName = (detail?.provider || detail?.result?.provider || CURRENT_PROVIDER || 'provider').trim() || 'provider';
  const titleEl = $('runProgressTitle');
  const hint = $('runProgressHint');
  const statusEl = $('runProgressStatus');
  const logsEl = $('runProgressLogs');
  if (titleEl) {
    if (status === 'running') titleEl.textContent = `${providerName} is running…`;
    else if (status === 'queued') titleEl.textContent = 'Queued…';
    else if (status === 'failed') titleEl.textContent = 'Run failed';
    else if (status === 'succeeded') titleEl.textContent = 'Run completed';
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
      const msg = err?.message || String(err || '');
      if (msg.includes('404')) {
        if (statusSpan) statusSpan.textContent = 'Job not found (assuming finished)';
        try { await refreshRuns(); } catch (_) {}
        setRunInProgress(false);
        closeRunModal();
        CURRENT_RUN_JOB_ID = null;
        return;
      }
      if (statusSpan) statusSpan.textContent = `Polling job… ${msg}`;
      await sleep(RUN_JOB_POLL_INTERVAL_MS);
      continue;
    }
    updateRunJobProgress(detail);
    const status = detail?.status;
    if (status === 'succeeded') {
      if (statusSpan) statusSpan.textContent = 'Completed';
      const slug = detail?.result?.slug;
      const provider = detail?.provider || detail?.result?.provider || CURRENT_PROVIDER || 'unstructured/local';
      if (provider) CURRENT_PROVIDER = provider;
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
      setRunInProgress(false);
      if (statusSpan) statusSpan.textContent = `Failed: ${errMsg}`;
      if (cancelBtn) cancelBtn.disabled = false;
      if (openBtn) {
        openBtn.disabled = false;
        openBtn.textContent = 'New Run';
      }
      showToast(`Run failed: ${errMsg}`, 'err', 3500);
      CURRENT_RUN_JOB_ID = null;
      return;
    }
    await sleep(RUN_JOB_POLL_INTERVAL_MS);
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

  const providerName = (context.provider || $('providerSelect')?.value || CURRENT_PROVIDER || '').trim() || 'provider';

  if (isRunning) {
    modal.classList.add('running');
    if (formGrid) formGrid.style.display = 'none';
    if (previewPane) previewPane.style.display = 'none';
    if (progressPane) progressPane.style.display = 'block';
    runBtn.disabled = true;
    runBtn.textContent = `Running (${providerName})…`;
    if (cancelBtn) cancelBtn.disabled = true;
    if (openBtn) {
      openBtn.disabled = true;
      openBtn.textContent = `Running (${providerName})…`;
    }
    const pdfName = context.pdf || $('pdfSelect')?.value || '';
    if (hint) {
      hint.textContent = pdfName
        ? `Processing ${pdfName} via ${providerName}. This window will close when the run finishes.`
        : `Processing PDF via ${providerName}. This window will close when the run finishes.`;
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

// Window exports
window.describeJobStatus = describeJobStatus;
window.updateRunJobProgress = updateRunJobProgress;
window.pollRunJob = pollRunJob;
window.setRunInProgress = setRunInProgress;
