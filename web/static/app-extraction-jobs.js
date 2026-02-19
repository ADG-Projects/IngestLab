/**
 * Extraction job polling and progress tracking
 * Extracted from app-extractions.js for modularity
 */

const EXTRACTION_JOB_POLL_INTERVAL_MS = 2000;  // Poll every 2 seconds for responsive progress updates

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

// Per-file-type pipeline stages (stage IDs match backend _report_progress calls)
const PIPELINES_BY_FILE_TYPE = {
  pdf: [
    { id: 'prepare', label: 'Prepare', aliases: [] },
    { id: 'azure', label: 'Azure DI', aliases: [] },
    { id: 'elements', label: 'Elements', aliases: [] },
    { id: 'figures', label: 'Figures', aliases: [] },
    { id: 'writing', label: 'Save', aliases: [] },
  ],
  office: [
    { id: 'convert', label: 'Convert', aliases: [] },
    { id: 'azure', label: 'Azure DI', aliases: [] },
    { id: 'elements', label: 'Elements', aliases: [] },
    { id: 'figures', label: 'Figures', aliases: [] },
    { id: 'writing', label: 'Save', aliases: [] },
  ],
  image: [
    { id: 'azure', label: 'Azure DI', aliases: [] },
    { id: 'elements', label: 'Elements', aliases: [] },
    { id: 'convert', label: 'Convert', aliases: [] },
    { id: 'writing', label: 'Save', aliases: [] },
  ],
  spreadsheet: [
    { id: 'convert', label: 'Convert', aliases: [] },
    { id: 'azure', label: 'Azure DI', aliases: [] },
    { id: 'elements', label: 'Elements', aliases: [] },
    { id: 'figures', label: 'Figures', aliases: [] },
    { id: 'writing', label: 'Save', aliases: [] },
  ],
};

// Active pipeline — default to pdf
let EXTRACTION_PIPELINE = PIPELINES_BY_FILE_TYPE.pdf;

/**
 * Select the pipeline matching a file type category.
 * Call this before starting extraction so the stepper shows correct stages.
 */
function setActivePipeline(fileType) {
  EXTRACTION_PIPELINE = PIPELINES_BY_FILE_TYPE[fileType] || PIPELINES_BY_FILE_TYPE.pdf;
}

// Track completed stages across polling updates
let completedStages = new Set();

function getStageIndex(stageId) {
  // Check direct match or alias
  for (let i = 0; i < EXTRACTION_PIPELINE.length; i++) {
    const s = EXTRACTION_PIPELINE[i];
    if (s.id === stageId || s.aliases.includes(stageId)) return i;
  }
  return -1;
}

function renderStagePipeline(currentStage) {
  const currentIdx = getStageIndex(currentStage);

  // Mark current and all previous stages as completed
  if (currentIdx >= 0) {
    for (let i = 0; i <= currentIdx; i++) {
      completedStages.add(EXTRACTION_PIPELINE[i].id);
    }
  }

  return EXTRACTION_PIPELINE.map((stage, idx) => {
    const isCompleted = completedStages.has(stage.id) && idx < currentIdx;
    const isCurrent = idx === currentIdx;
    const isPending = idx > currentIdx;

    let stateClass = 'pending';
    if (isCompleted) stateClass = 'completed';
    else if (isCurrent) stateClass = 'active';

    return `<div class="pipeline-stage ${stateClass}" data-stage="${stage.id}">
      <div class="stage-dot"></div>
      <span class="stage-label">${stage.label}</span>
    </div>`;
  }).join('<div class="pipeline-connector"></div>');
}

function resetStagePipeline() {
  completedStages = new Set();
}

function updateExtractionJobProgress(detail) {
  CURRENT_EXTRACTION_JOB_STATUS = detail;
  const status = detail?.status || 'queued';
  const pdfName = detail?.pdf || '';
  const providerName = (detail?.provider || detail?.result?.provider || CURRENT_PROVIDER || 'provider').trim() || 'provider';
  const titleEl = $('extractionProgressTitle');
  const statusEl = $('extractionProgressStatus');
  const hintEl = $('extractionProgressHint');
  const spinnerEl = $('extractionSpinner');
  const logsEl = $('extractionProgressLogs');
  const progressBarWrap = $('extractionProgressBarWrap');
  const progressDetail = $('extractionProgressDetail');

  // Handle detailed progress display
  const hasProgress = detail?.progress_message || detail?.progress_stage;
  const stage = detail?.progress_stage;

  if (status === 'running' && hasProgress) {
    // Hide spinner and old status elements when we have detailed progress
    if (spinnerEl) spinnerEl.style.display = 'none';
    if (titleEl) titleEl.style.display = 'none';
    if (statusEl) statusEl.style.display = 'none';
    if (hintEl) hintEl.style.display = 'none';

    if (progressBarWrap && progressDetail) {
      progressBarWrap.style.display = 'flex';

      let message = detail?.progress_message || '';

      // Check if message IS a figure type (shown as badge instead of text)
      let figureTypeBadge = '';
      const figureTypes = ['flowchart', 'diagram', 'chart', 'other', 'unknown', 'table', 'infographic', 'screenshot'];
      const messageLower = message.toLowerCase().trim();
      if (figureTypes.includes(messageLower)) {
        figureTypeBadge = `<span class="type-badge type-${messageLower}">${messageLower.toUpperCase()}</span>`;
        message = '';  // Badge replaces the message
      }

      // Build counter for figures
      let counterHtml = '';
      if (detail?.progress_current != null && detail?.progress_total != null && detail.progress_total > 0) {
        counterHtml = `<span class="progress-counter">${detail.progress_current} / ${detail.progress_total}</span>`;
      }

      // Build the stage pipeline visualization
      const pipelineHtml = renderStagePipeline(stage);

      progressDetail.innerHTML = `
        <div class="progress-pipeline">${pipelineHtml}</div>
        <div class="progress-detail-row">
          ${counterHtml}
          ${figureTypeBadge}
        </div>
        <div class="progress-message">${message}</div>
      `;
    }
  } else {
    // Show spinner and standard status info when no detailed progress
    if (spinnerEl) spinnerEl.style.display = '';
    if (titleEl) {
      titleEl.style.display = '';
      if (status === 'running') titleEl.textContent = `${providerName} is extracting…`;
      else if (status === 'queued') titleEl.textContent = 'Queued…';
      else if (status === 'failed') titleEl.textContent = 'Extraction failed';
      else if (status === 'succeeded') titleEl.textContent = 'Extraction completed';
      else titleEl.textContent = 'Working…';
    }
    if (statusEl) {
      statusEl.style.display = '';
      statusEl.textContent = describeJobStatus(detail, providerName);
    }
    if (hintEl) {
      hintEl.style.display = '';
      hintEl.textContent = pdfName ? `Processing ${pdfName}` : '';
    }
    if (progressBarWrap) progressBarWrap.style.display = 'none';
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
        await refreshExtractions({ slug, provider });
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
  const progressBarWrap = $('extractionProgressBarWrap');
  const progressDetail = $('extractionProgressDetail');
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
    // Hide old UI elements immediately - pipeline will show when progress arrives
    const spinner = $('extractionSpinner');
    if (spinner) spinner.style.display = 'none';
    if (progressTitle) { progressTitle.textContent = ''; progressTitle.style.display = 'none'; }
    if (progressStatus) { progressStatus.textContent = ''; progressStatus.style.display = 'none'; }
    if (hint) hint.style.display = 'none';
    if (logs) { logs.textContent = ''; logs.style.display = 'none'; }
    // Show pipeline immediately with no active stage
    resetStagePipeline();
    if (progressBarWrap && progressDetail) {
      progressBarWrap.style.display = 'flex';
      progressDetail.innerHTML = `
        <div class="progress-pipeline">${renderStagePipeline(null)}</div>
        <div class="progress-detail-row"></div>
        <div class="progress-message">Starting extraction...</div>
      `;
    }
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
    // Restore visibility of spinner/title/status/hint
    const spinner = $('extractionSpinner');
    if (spinner) spinner.style.display = '';
    if (progressTitle) { progressTitle.textContent = 'Extraction ready'; progressTitle.style.display = ''; }
    if (progressStatus) { progressStatus.textContent = ''; progressStatus.style.display = ''; }
    if (logs) { logs.textContent = ''; logs.style.display = 'none'; }
    if (hint) { hint.textContent = ''; hint.style.display = ''; }
    // Reset progress state
    if (progressBarWrap) progressBarWrap.style.display = 'none';
    if (progressDetail) progressDetail.innerHTML = '';
    resetStagePipeline();
    CURRENT_EXTRACTION_JOB_ID = null;
    CURRENT_EXTRACTION_JOB_STATUS = null;
  }
}

// Window exports
window.describeJobStatus = describeJobStatus;
window.setActivePipeline = setActivePipeline;
window.renderStagePipeline = renderStagePipeline;
window.resetStagePipeline = resetStagePipeline;
window.updateExtractionJobProgress = updateExtractionJobProgress;
window.pollExtractionJob = pollExtractionJob;
window.setExtractionInProgress = setExtractionInProgress;
