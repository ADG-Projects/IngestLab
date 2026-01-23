/**
 * Images Tab Module (EXPERIMENTAL)
 *
 * Provides UI for inspecting figures extracted from PDF runs
 * and testing standalone images through the vision pipeline.
 */

/* global $, showToast, CURRENT_SLUG, CURRENT_PROVIDER */

// Module state
let IMAGES_MODE = 'pdf-figures'; // 'pdf-figures' or 'upload'
let IMAGES_FIGURE_LIST = [];
let IMAGES_CURRENT_FIGURE = null;
let IMAGES_STATS = null;
let CURRENT_UPLOAD_ID = null;
let CURRENT_UPLOAD_DATA_URI = null;

/**
 * Initialize the Images tab when it becomes active.
 */
function initImagesTab() {
  wireImagesModeTabs();
  wireImageUpload();
  wireFigureListEvents();
}

/**
 * Wire up mode tab switching (PDF Figures vs Upload).
 */
function wireImagesModeTabs() {
  const tabs = document.querySelectorAll('#imagesView .images-mode-tabs .mode-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      switchImagesMode(mode);
    });
  });
}

/**
 * Switch between PDF Figures and Upload modes.
 */
function switchImagesMode(mode) {
  IMAGES_MODE = mode;

  // Update tab styling
  const tabs = document.querySelectorAll('#imagesView .images-mode-tabs .mode-tab');
  tabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  });

  // Show/hide panels
  const pdfPanel = $('imagesPdfFiguresPanel');
  const uploadPanel = $('imagesUploadPanel');

  if (pdfPanel) pdfPanel.classList.toggle('hidden', mode !== 'pdf-figures');
  if (uploadPanel) uploadPanel.classList.toggle('hidden', mode !== 'upload');

  // Load data if switching to pdf-figures
  if (mode === 'pdf-figures' && CURRENT_SLUG) {
    loadFiguresForCurrentRun();
  }
}

/**
 * Called when the Images tab is activated.
 */
function onImagesTabActivated() {
  initImagesTab();
  if (IMAGES_MODE === 'pdf-figures' && CURRENT_SLUG) {
    loadFiguresForCurrentRun();
  }
}

/**
 * Load figures for the currently selected run.
 */
async function loadFiguresForCurrentRun() {
  if (!CURRENT_SLUG) {
    renderEmptyState('Select a run to view figures');
    return;
  }

  const listEl = $('imagesFigureList');
  const statsEl = $('imagesStats');

  if (listEl) listEl.innerHTML = '<div class="loading">Loading figures...</div>';

  try {
    // Fetch stats and figures in parallel
    const provider = CURRENT_PROVIDER || 'azure/document_intelligence';
    const [statsRes, figuresRes] = await Promise.all([
      fetch(`/api/figures/${encodeURIComponent(CURRENT_SLUG)}/stats?provider=${encodeURIComponent(provider)}`),
      fetch(`/api/figures/${encodeURIComponent(CURRENT_SLUG)}?provider=${encodeURIComponent(provider)}&limit=100`),
    ]);

    if (!statsRes.ok || !figuresRes.ok) {
      throw new Error('Failed to load figures');
    }

    IMAGES_STATS = await statsRes.json();
    const figuresData = await figuresRes.json();
    IMAGES_FIGURE_LIST = figuresData.figures || [];

    renderFiguresStats(IMAGES_STATS);
    renderFiguresList(IMAGES_FIGURE_LIST);
  } catch (err) {
    console.error('Failed to load figures:', err);
    renderEmptyState('Failed to load figures. This run may not have any figures.');
  }
}

/**
 * Render figures statistics.
 */
function renderFiguresStats(stats) {
  const el = $('imagesStats');
  if (!el) return;

  const total = stats.total || 0;
  const processed = stats.processed || 0;
  const pending = stats.pending || 0;
  const errorCount = stats.error || 0;

  const byType = stats.by_type || {};
  const typeBreakdown = Object.entries(byType)
    .map(([type, count]) => `<span class="stat-type">${type}: ${count}</span>`)
    .join(' ');

  el.innerHTML = `
    <div class="stat-row">
      <span class="stat-item"><span class="stat-label">Total:</span> <span class="stat-value">${total}</span></span>
      <span class="stat-item stat-processed"><span class="stat-label">Processed:</span> <span class="stat-value">${processed}</span></span>
      <span class="stat-item stat-pending"><span class="stat-label">Pending:</span> <span class="stat-value">${pending}</span></span>
      ${errorCount > 0 ? `<span class="stat-item stat-error"><span class="stat-label">Errors:</span> <span class="stat-value">${errorCount}</span></span>` : ''}
    </div>
    ${typeBreakdown ? `<div class="stat-types">${typeBreakdown}</div>` : ''}
  `;
}

/**
 * Render the list of figures as cards.
 */
function renderFiguresList(figures) {
  const el = $('imagesFigureList');
  if (!el) return;

  if (!figures || figures.length === 0) {
    el.innerHTML = '<div class="empty-state">No figures found in this run</div>';
    return;
  }

  const provider = CURRENT_PROVIDER || 'azure/document_intelligence';

  el.innerHTML = figures
    .map((fig) => {
      const statusClass = `status-${fig.status || 'pending'}`;
      const typeLabel = fig.figure_type || 'unknown';
      const confidence = fig.confidence != null ? `${Math.round(fig.confidence * 100)}%` : '-';

      return `
      <div class="figure-card ${statusClass}" data-element-id="${fig.element_id}">
        <div class="figure-thumbnail">
          <img src="/api/figures/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(fig.element_id)}/image/original?provider=${encodeURIComponent(provider)}"
               alt="Figure ${fig.element_id}"
               loading="lazy"
               onerror="this.parentElement.innerHTML='<span class=\\'no-image\\'>No image</span>'" />
        </div>
        <div class="figure-info">
          <div class="figure-id" title="${fig.element_id}">${truncateId(fig.element_id)}</div>
          <div class="figure-meta">
            <span class="figure-page">Page ${fig.page_number || '?'}</span>
            <span class="figure-status ${statusClass}">${fig.status}</span>
          </div>
          ${fig.status === 'processed' ? `
          <div class="figure-type">
            <span class="type-badge type-${typeLabel}">${typeLabel}</span>
            <span class="confidence">${confidence}</span>
          </div>
          ` : ''}
          ${fig.has_mermaid ? '<span class="mermaid-badge" title="Has Mermaid diagram">Mermaid</span>' : ''}
        </div>
      </div>
    `;
    })
    .join('');
}

/**
 * Truncate element ID for display.
 */
function truncateId(id) {
  if (!id) return '';
  if (id.length <= 20) return id;
  return id.slice(0, 8) + '...' + id.slice(-8);
}

/**
 * Render empty state message.
 */
function renderEmptyState(message) {
  const listEl = $('imagesFigureList');
  if (listEl) {
    listEl.innerHTML = `<div class="empty-state">${message}</div>`;
  }
  const statsEl = $('imagesStats');
  if (statsEl) {
    statsEl.innerHTML = '';
  }
}

/**
 * Wire up click events for figure cards.
 */
function wireFigureListEvents() {
  const listEl = $('imagesFigureList');
  if (!listEl) return;

  listEl.addEventListener('click', (e) => {
    const card = e.target.closest('.figure-card');
    if (!card) return;

    const elementId = card.dataset.elementId;
    if (elementId) {
      openFigureDetails(elementId);
    }
  });
}

/**
 * Open the details panel for a specific figure.
 */
async function openFigureDetails(elementId) {
  const detailsEl = $('imagesFigureDetails');
  if (!detailsEl) return;

  IMAGES_CURRENT_FIGURE = elementId;

  // Highlight selected card
  document.querySelectorAll('.figure-card').forEach((card) => {
    card.classList.toggle('selected', card.dataset.elementId === elementId);
  });

  // Show loading state
  detailsEl.classList.remove('hidden');
  detailsEl.innerHTML = '<div class="loading">Loading figure details...</div>';

  try {
    const provider = CURRENT_PROVIDER || 'azure/document_intelligence';
    const res = await fetch(
      `/api/figures/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(elementId)}?provider=${encodeURIComponent(provider)}`
    );

    if (!res.ok) throw new Error('Failed to load figure details');

    const figure = await res.json();
    renderFigurePipelineView(figure);
  } catch (err) {
    console.error('Failed to load figure details:', err);
    detailsEl.innerHTML = '<div class="error">Failed to load figure details</div>';
  }
}

/**
 * Render the pipeline breakdown view for a figure.
 */
function renderFigurePipelineView(figure) {
  const detailsEl = $('imagesFigureDetails');
  if (!detailsEl) return;

  const processing = figure.processing || {};
  const stages = figure.stages || { segmented: false, extracted: false };
  const sam3 = figure.sam3 || {};
  const provider = CURRENT_PROVIDER || 'azure/document_intelligence';

  // Determine figure type and confidence from best available source
  const figureType = processing.figure_type || sam3.figure_type || 'unknown';
  const confidence = (processing.confidence ?? sam3.confidence) != null
    ? `${Math.round((processing.confidence ?? sam3.confidence) * 100)}%`
    : '-';

  // Build pipeline steps with states
  const classificationDone = stages.segmented || !!processing.figure_type;
  const segmentationDone = stages.segmented;
  const extractionDone = stages.extracted;

  // Timing info
  const classificationTime = sam3.classification_duration_ms
    ? `${sam3.classification_duration_ms}ms`
    : processing.step1_duration_ms
      ? `${processing.step1_duration_ms}ms`
      : '-';
  const sam3Time = sam3.sam3_duration_ms ? `${sam3.sam3_duration_ms}ms` : '-';
  const extractionTime = processing.step2_duration_ms ? `${processing.step2_duration_ms}ms` : '-';

  detailsEl.innerHTML = `
    <div class="figure-details-header">
      <h3>Figure: ${truncateId(figure.element_id)}</h3>
      <div class="figure-details-actions">
        <button class="btn btn-secondary" onclick="reprocessFigure('${figure.element_id}')" title="Run full pipeline">Reprocess</button>
        <a href="/api/figures/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(figure.element_id)}/viewer?provider=${encodeURIComponent(provider)}"
           target="_blank" class="btn btn-secondary">Open Viewer</a>
        <button class="btn btn-icon" onclick="closeFigureDetails()">×</button>
      </div>
    </div>

    <div class="pipeline-view">
      <div class="pipeline-step step-classification ${classificationDone ? 'step-complete' : 'step-pending'}">
        <div class="step-header">
          <span class="step-number">${classificationDone ? '✓' : '1'}</span>
          <span class="step-title">Classification</span>
          <span class="step-time">${classificationTime}</span>
        </div>
        <div class="step-content">
          ${classificationDone ? `
            <div class="step-result">
              <span class="type-badge type-${figureType}">${figureType}</span>
              <span class="confidence-label">Confidence: ${confidence}</span>
              ${sam3.direction ? `<span class="direction-label">Direction: ${sam3.direction}</span>` : ''}
            </div>
          ` : '<span class="no-data">Not yet classified</span>'}
        </div>
      </div>

      <div class="pipeline-step step-segmentation ${segmentationDone ? 'step-complete' : 'step-pending'}" id="step-segmentation">
        <div class="step-header">
          <span class="step-number">${segmentationDone ? '✓' : '2'}</span>
          <span class="step-title">SAM3 Segmentation</span>
          <span class="step-time">${sam3Time}</span>
          ${!segmentationDone ? `
            <button class="btn btn-sm btn-primary step-action" onclick="runSegmentation('${figure.element_id}')">Run SAM3</button>
          ` : `
            <button class="btn btn-sm btn-secondary step-action" onclick="runSegmentation('${figure.element_id}')" title="Re-run segmentation">Re-run</button>
          `}
        </div>
        <div class="step-content">
          ${segmentationDone ? `
            <div class="step-result">
              <span class="shape-count">${sam3.shape_count || 0} shapes detected</span>
            </div>
            ${figure.annotated_image_path ? `
              <img src="/api/figures/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(figure.element_id)}/image/annotated?provider=${encodeURIComponent(provider)}"
                   alt="SAM3 Annotated"
                   class="annotated-image zoomable-image"
                   onclick="openImageLightbox(this.src, 'SAM3 Annotated Image')"
                   onerror="this.parentElement.innerHTML='<span class=\\'no-image\\'>Annotated image not available</span>'" />
            ` : '<span class="no-data">Annotated image not available</span>'}
          ` : '<span class="no-data">Run SAM3 to detect shapes</span>'}
        </div>
      </div>

      <div class="pipeline-step step-mermaid ${extractionDone ? 'step-complete' : 'step-pending'}" id="step-mermaid">
        <div class="step-header">
          <span class="step-number">${extractionDone ? '✓' : '3'}</span>
          <span class="step-title">Mermaid Extraction</span>
          <span class="step-time">${extractionTime}</span>
          ${segmentationDone && !extractionDone ? `
            <button class="btn btn-sm btn-primary step-action" onclick="runMermaidExtraction('${figure.element_id}')">Extract Mermaid</button>
          ` : extractionDone ? `
            <button class="btn btn-sm btn-secondary step-action" onclick="runMermaidExtraction('${figure.element_id}')" title="Re-run extraction">Re-run</button>
          ` : `
            <button class="btn btn-sm btn-secondary step-action" disabled title="Run SAM3 first">Extract Mermaid</button>
          `}
        </div>
        <div class="step-content">
          ${extractionDone && processing.processed_content && figureType === 'flowchart' ? `
            ${processing.intermediate_nodes ? `
              <details>
                <summary>Nodes (${(processing.intermediate_nodes || []).length}) / Edges (${(processing.intermediate_edges || []).length})</summary>
                <div class="structure-preview">
                  <pre class="json-view">${JSON.stringify(processing.intermediate_nodes, null, 2)}</pre>
                  <pre class="json-view">${JSON.stringify(processing.intermediate_edges, null, 2)}</pre>
                </div>
              </details>
            ` : ''}
            <pre class="mermaid-code">${escapeHtml(processing.processed_content)}</pre>
          ` : extractionDone ? `
            <span class="no-data">Mermaid diagram not available (figure type: ${figureType})</span>
          ` : segmentationDone ? `
            <span class="no-data">Click "Extract Mermaid" to generate diagram</span>
          ` : `
            <span class="no-data">Complete SAM3 segmentation first</span>
          `}
        </div>
      </div>
    </div>

    <div class="figure-original">
      <h4>Original Image</h4>
      <img src="/api/figures/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(figure.element_id)}/image/original?provider=${encodeURIComponent(provider)}"
           alt="Original figure"
           class="original-image zoomable-image"
           onclick="openImageLightbox(this.src, 'Original Image')" />
    </div>

    ${processing.description ? `
    <div class="figure-description">
      <h4>Description</h4>
      <p>${escapeHtml(processing.description)}</p>
    </div>
    ` : ''}

    ${processing.processing_notes ? `
    <div class="figure-notes">
      <h4>Processing Notes</h4>
      <p>${escapeHtml(processing.processing_notes)}</p>
    </div>
    ` : ''}
  `;
}

/**
 * Run SAM3 segmentation on a figure (stage 1).
 */
async function runSegmentation(elementId) {
  const stepEl = document.getElementById('step-segmentation');
  if (stepEl) {
    stepEl.classList.remove('step-complete', 'step-pending');
    stepEl.classList.add('step-running');
    // Update button to show loading
    const btn = stepEl.querySelector('.step-action');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Running...';
    }
  }

  try {
    const provider = CURRENT_PROVIDER || 'azure/document_intelligence';
    const res = await fetch(
      `/api/figures/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(elementId)}/segment?provider=${encodeURIComponent(provider)}`,
      { method: 'POST' }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || 'Segmentation failed');
    }

    const data = await res.json();
    showToast(`SAM3 complete: ${data.shape_count} shapes detected`, 'success');

    // Refresh the figure details
    openFigureDetails(elementId);
    loadFiguresForCurrentRun();
  } catch (err) {
    console.error('Segmentation failed:', err);
    showToast(`Segmentation failed: ${err.message}`, 'error');

    // Reset step state
    if (stepEl) {
      stepEl.classList.remove('step-running');
      stepEl.classList.add('step-pending');
      const btn = stepEl.querySelector('.step-action');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Run SAM3';
      }
    }
  }
}

/**
 * Run mermaid extraction on a figure (stage 2).
 */
async function runMermaidExtraction(elementId) {
  const stepEl = document.getElementById('step-mermaid');
  if (stepEl) {
    stepEl.classList.remove('step-complete', 'step-pending');
    stepEl.classList.add('step-running');
    // Update button to show loading
    const btn = stepEl.querySelector('.step-action');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Extracting...';
    }
  }

  try {
    const provider = CURRENT_PROVIDER || 'azure/document_intelligence';
    const res = await fetch(
      `/api/figures/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(elementId)}/extract-mermaid?provider=${encodeURIComponent(provider)}`,
      { method: 'POST' }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || 'Extraction failed');
    }

    showToast('Mermaid extraction complete', 'success');

    // Refresh the figure details
    openFigureDetails(elementId);
    loadFiguresForCurrentRun();
  } catch (err) {
    console.error('Mermaid extraction failed:', err);
    showToast(`Extraction failed: ${err.message}`, 'error');

    // Reset step state
    if (stepEl) {
      stepEl.classList.remove('step-running');
      stepEl.classList.add('step-pending');
      const btn = stepEl.querySelector('.step-action');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Extract Mermaid';
      }
    }
  }
}

/**
 * Close the figure details panel.
 */
function closeFigureDetails() {
  const detailsEl = $('imagesFigureDetails');
  if (detailsEl) {
    detailsEl.classList.add('hidden');
    detailsEl.innerHTML = '';
  }
  IMAGES_CURRENT_FIGURE = null;

  // Deselect cards
  document.querySelectorAll('.figure-card.selected').forEach((card) => {
    card.classList.remove('selected');
  });
}

/**
 * Trigger reprocessing of a figure.
 */
async function reprocessFigure(elementId) {
  if (!confirm(`Reprocess figure ${truncateId(elementId)}?`)) return;

  try {
    const provider = CURRENT_PROVIDER || 'azure/document_intelligence';
    const res = await fetch(
      `/api/figures/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(elementId)}/reprocess?provider=${encodeURIComponent(provider)}`,
      { method: 'POST' }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || 'Reprocessing failed');
    }

    showToast('Figure reprocessed successfully', 'success');
    openFigureDetails(elementId);
    loadFiguresForCurrentRun();
  } catch (err) {
    console.error('Reprocess failed:', err);
    showToast(`Reprocess failed: ${err.message}`, 'error');
  }
}

/**
 * Wire up the image upload form.
 */
function wireImageUpload() {
  const form = $('imageUploadForm');
  const input = $('imageUploadInput');
  const dropZone = $('imageUploadZone');

  if (!form || !input) return;

  // File input change
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) {
      uploadImage(input.files[0]);
    }
  });

  // Drag and drop
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const files = e.dataTransfer?.files;
      if (files && files[0]) {
        uploadImage(files[0]);
      }
    });

    dropZone.addEventListener('click', () => {
      input.click();
    });
  }
}

/**
 * Upload an image (just saves it, doesn't process yet).
 */
async function uploadImage(file) {
  const resultEl = $('imageUploadResult');
  if (!resultEl) return;

  resultEl.innerHTML = '<div class="loading">Uploading image...</div>';

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/figures/upload', {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Upload failed' }));
      throw new Error(err.detail || 'Upload failed');
    }

    const data = await res.json();
    CURRENT_UPLOAD_ID = data.upload_id;
    CURRENT_UPLOAD_DATA_URI = data.original_image_data_uri;

    showToast('Image uploaded successfully', 'success');
    renderUploadPipelineView(data);
  } catch (err) {
    console.error('Upload failed:', err);
    resultEl.innerHTML = `<div class="error">Upload failed: ${escapeHtml(err.message)}</div>`;
    showToast(`Upload failed: ${err.message}`, 'error');
  }
}

/**
 * Fetch and refresh upload details.
 */
async function refreshUploadDetails(uploadId) {
  try {
    const res = await fetch(`/api/figures/upload/${encodeURIComponent(uploadId)}`);
    if (!res.ok) throw new Error('Failed to load upload details');

    const data = await res.json();
    data.original_image_data_uri = CURRENT_UPLOAD_DATA_URI;
    renderUploadPipelineView(data);
  } catch (err) {
    console.error('Failed to refresh upload:', err);
  }
}

/**
 * Render the pipeline view for an uploaded image.
 */
function renderUploadPipelineView(data) {
  const resultEl = $('imageUploadResult');
  if (!resultEl) return;

  const stages = data.stages || { uploaded: true, segmented: false, extracted: false };
  const sam3 = data.sam3 || {};
  const processing = data.processing || {};
  const uploadId = data.upload_id;

  // Determine figure type and confidence
  const figureType = processing.figure_type || sam3.figure_type || 'unknown';
  const confidence = (processing.confidence ?? sam3.confidence) != null
    ? `${Math.round((processing.confidence ?? sam3.confidence) * 100)}%`
    : '-';

  // Step states
  const uploadDone = stages.uploaded !== false;
  const segmentationDone = stages.segmented;
  const extractionDone = stages.extracted;

  // Timing info
  const classificationTime = sam3.classification_duration_ms ? `${sam3.classification_duration_ms}ms` : '-';
  const sam3Time = sam3.sam3_duration_ms ? `${sam3.sam3_duration_ms}ms` : '-';

  resultEl.innerHTML = `
    <div class="upload-pipeline-view">
      <div class="upload-header">
        <h4>Uploaded Image</h4>
        <span class="upload-id">ID: ${uploadId}</span>
        <button class="btn btn-icon" onclick="clearUpload()">×</button>
      </div>

      <div class="upload-content">
        <div class="upload-image-preview">
          <img src="${data.original_image_data_uri || `/api/figures/upload/${uploadId}/image/original`}"
               alt="Original image" class="original-image zoomable-image"
               onclick="openImageLightbox(this.src, 'Original Image')" />
        </div>

        <div class="pipeline-view">
          <div class="pipeline-step step-classification ${segmentationDone ? 'step-complete' : 'step-pending'}">
            <div class="step-header">
              <span class="step-number">${segmentationDone ? '✓' : '1'}</span>
              <span class="step-title">Classification</span>
              <span class="step-time">${classificationTime}</span>
            </div>
            <div class="step-content">
              ${segmentationDone ? `
                <div class="step-result">
                  <span class="type-badge type-${figureType}">${figureType}</span>
                  <span class="confidence-label">Confidence: ${confidence}</span>
                  ${sam3.direction ? `<span class="direction-label">Direction: ${sam3.direction}</span>` : ''}
                </div>
              ` : '<span class="no-data">Run SAM3 to classify</span>'}
            </div>
          </div>

          <div class="pipeline-step step-segmentation ${segmentationDone ? 'step-complete' : 'step-pending'}" id="upload-step-segmentation">
            <div class="step-header">
              <span class="step-number">${segmentationDone ? '✓' : '2'}</span>
              <span class="step-title">SAM3 Segmentation</span>
              <span class="step-time">${sam3Time}</span>
              ${!segmentationDone ? `
                <button class="btn btn-sm btn-primary step-action" onclick="runUploadSegmentation('${uploadId}')">Run SAM3</button>
              ` : `
                <button class="btn btn-sm btn-secondary step-action" onclick="runUploadSegmentation('${uploadId}')" title="Re-run segmentation">Re-run</button>
              `}
            </div>
            <div class="step-content">
              ${segmentationDone ? `
                <div class="step-result">
                  <span class="shape-count">${sam3.shape_count || 0} shapes detected</span>
                </div>
                ${data.has_annotated_image ? `
                  <img src="/api/figures/upload/${uploadId}/image/annotated"
                       alt="SAM3 Annotated"
                       class="annotated-image zoomable-image"
                       onclick="openImageLightbox(this.src, 'SAM3 Annotated Image')"
                       onerror="this.style.display='none'" />
                ` : ''}
              ` : '<span class="no-data">Run SAM3 to detect shapes</span>'}
            </div>
          </div>

          <div class="pipeline-step step-mermaid ${extractionDone ? 'step-complete' : 'step-pending'}" id="upload-step-mermaid">
            <div class="step-header">
              <span class="step-number">${extractionDone ? '✓' : '3'}</span>
              <span class="step-title">Mermaid Extraction</span>
              ${segmentationDone && !extractionDone ? `
                <button class="btn btn-sm btn-primary step-action" onclick="runUploadMermaidExtraction('${uploadId}')">Extract Mermaid</button>
              ` : extractionDone ? `
                <button class="btn btn-sm btn-secondary step-action" onclick="runUploadMermaidExtraction('${uploadId}')" title="Re-run extraction">Re-run</button>
              ` : `
                <button class="btn btn-sm btn-secondary step-action" disabled title="Run SAM3 first">Extract Mermaid</button>
              `}
            </div>
            <div class="step-content">
              ${extractionDone && processing.processed_content && figureType === 'flowchart' ? `
                ${processing.intermediate_nodes ? `
                  <details>
                    <summary>Nodes (${(processing.intermediate_nodes || []).length}) / Edges (${(processing.intermediate_edges || []).length})</summary>
                    <div class="structure-preview">
                      <pre class="json-view">${JSON.stringify(processing.intermediate_nodes, null, 2)}</pre>
                      <pre class="json-view">${JSON.stringify(processing.intermediate_edges, null, 2)}</pre>
                    </div>
                  </details>
                ` : ''}
                <pre class="mermaid-code">${escapeHtml(processing.processed_content)}</pre>
              ` : extractionDone ? `
                <span class="no-data">Mermaid diagram not available (figure type: ${figureType})</span>
              ` : segmentationDone ? `
                <span class="no-data">Click "Extract Mermaid" to generate diagram</span>
              ` : `
                <span class="no-data">Complete SAM3 segmentation first</span>
              `}
            </div>
          </div>
        </div>
      </div>

      ${processing.description ? `
      <div class="upload-result-description">
        <h5>Description</h5>
        <p>${escapeHtml(processing.description)}</p>
      </div>
      ` : ''}
    </div>
  `;
}

/**
 * Run SAM3 segmentation on uploaded image.
 */
async function runUploadSegmentation(uploadId) {
  const stepEl = document.getElementById('upload-step-segmentation');
  if (stepEl) {
    stepEl.classList.remove('step-complete', 'step-pending');
    stepEl.classList.add('step-running');
    const btn = stepEl.querySelector('.step-action');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Running...';
    }
  }

  try {
    const res = await fetch(`/api/figures/upload/${encodeURIComponent(uploadId)}/segment`, {
      method: 'POST',
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || 'Segmentation failed');
    }

    const data = await res.json();
    showToast(`SAM3 complete: ${data.shape_count} shapes detected`, 'success');
    refreshUploadDetails(uploadId);
  } catch (err) {
    console.error('Segmentation failed:', err);
    showToast(`Segmentation failed: ${err.message}`, 'error');

    if (stepEl) {
      stepEl.classList.remove('step-running');
      stepEl.classList.add('step-pending');
      const btn = stepEl.querySelector('.step-action');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Run SAM3';
      }
    }
  }
}

/**
 * Run mermaid extraction on uploaded image.
 */
async function runUploadMermaidExtraction(uploadId) {
  const stepEl = document.getElementById('upload-step-mermaid');
  if (stepEl) {
    stepEl.classList.remove('step-complete', 'step-pending');
    stepEl.classList.add('step-running');
    const btn = stepEl.querySelector('.step-action');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Extracting...';
    }
  }

  try {
    const res = await fetch(`/api/figures/upload/${encodeURIComponent(uploadId)}/extract-mermaid`, {
      method: 'POST',
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || 'Extraction failed');
    }

    showToast('Mermaid extraction complete', 'success');
    refreshUploadDetails(uploadId);
  } catch (err) {
    console.error('Mermaid extraction failed:', err);
    showToast(`Extraction failed: ${err.message}`, 'error');

    if (stepEl) {
      stepEl.classList.remove('step-running');
      stepEl.classList.add('step-pending');
      const btn = stepEl.querySelector('.step-action');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Extract Mermaid';
      }
    }
  }
}

/**
 * Clear the current upload and reset the upload panel.
 */
function clearUpload() {
  CURRENT_UPLOAD_ID = null;
  CURRENT_UPLOAD_DATA_URI = null;
  const resultEl = $('imageUploadResult');
  if (resultEl) {
    resultEl.innerHTML = '';
  }
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// =============================================================================
// Image Lightbox
// =============================================================================

let lightboxZoom = 1;
let lightboxPanX = 0;
let lightboxPanY = 0;
let lightboxDragging = false;
let lightboxDragStart = { x: 0, y: 0 };

/**
 * Open an image in the lightbox modal.
 */
function openImageLightbox(src, alt) {
  // Create lightbox if it doesn't exist
  let lightbox = document.getElementById('imageLightbox');
  if (!lightbox) {
    lightbox = document.createElement('div');
    lightbox.id = 'imageLightbox';
    lightbox.className = 'image-lightbox';
    lightbox.innerHTML = `
      <div class="lightbox-overlay" onclick="closeImageLightbox()"></div>
      <div class="lightbox-content">
        <div class="lightbox-header">
          <span class="lightbox-title"></span>
          <div class="lightbox-controls">
            <button class="btn btn-icon" onclick="lightboxZoomIn()" title="Zoom in">+</button>
            <button class="btn btn-icon" onclick="lightboxZoomOut()" title="Zoom out">−</button>
            <button class="btn btn-icon" onclick="lightboxResetZoom()" title="Reset zoom">⟲</button>
            <button class="btn btn-icon lightbox-close" onclick="closeImageLightbox()" title="Close">×</button>
          </div>
        </div>
        <div class="lightbox-image-container">
          <img class="lightbox-image" draggable="false" />
        </div>
        <div class="lightbox-footer">
          <span class="lightbox-zoom-level">100%</span>
        </div>
      </div>
    `;
    document.body.appendChild(lightbox);

    // Add wheel zoom
    const container = lightbox.querySelector('.lightbox-image-container');
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        lightboxZoomIn();
      } else {
        lightboxZoomOut();
      }
    });

    // Add pan support
    const img = lightbox.querySelector('.lightbox-image');
    container.addEventListener('mousedown', (e) => {
      if (lightboxZoom > 1) {
        lightboxDragging = true;
        lightboxDragStart = { x: e.clientX - lightboxPanX, y: e.clientY - lightboxPanY };
        container.style.cursor = 'grabbing';
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (lightboxDragging) {
        lightboxPanX = e.clientX - lightboxDragStart.x;
        lightboxPanY = e.clientY - lightboxDragStart.y;
        updateLightboxTransform();
      }
    });
    document.addEventListener('mouseup', () => {
      lightboxDragging = false;
      const container = document.querySelector('.lightbox-image-container');
      if (container) container.style.cursor = lightboxZoom > 1 ? 'grab' : 'default';
    });

    // Close on escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lightbox.classList.contains('active')) {
        closeImageLightbox();
      }
    });
  }

  // Reset zoom/pan
  lightboxZoom = 1;
  lightboxPanX = 0;
  lightboxPanY = 0;

  // Set image
  const img = lightbox.querySelector('.lightbox-image');
  img.src = src;
  img.alt = alt || 'Image preview';
  lightbox.querySelector('.lightbox-title').textContent = alt || 'Image Preview';
  updateLightboxTransform();

  // Show lightbox
  lightbox.classList.add('active');
  document.body.style.overflow = 'hidden';
}

/**
 * Close the image lightbox.
 */
function closeImageLightbox() {
  const lightbox = document.getElementById('imageLightbox');
  if (lightbox) {
    lightbox.classList.remove('active');
    document.body.style.overflow = '';
  }
}

/**
 * Zoom in the lightbox image.
 */
function lightboxZoomIn() {
  lightboxZoom = Math.min(lightboxZoom * 1.25, 5);
  updateLightboxTransform();
}

/**
 * Zoom out the lightbox image.
 */
function lightboxZoomOut() {
  lightboxZoom = Math.max(lightboxZoom / 1.25, 0.5);
  if (lightboxZoom <= 1) {
    lightboxPanX = 0;
    lightboxPanY = 0;
  }
  updateLightboxTransform();
}

/**
 * Reset lightbox zoom to 100%.
 */
function lightboxResetZoom() {
  lightboxZoom = 1;
  lightboxPanX = 0;
  lightboxPanY = 0;
  updateLightboxTransform();
}

/**
 * Update the lightbox image transform.
 */
function updateLightboxTransform() {
  const lightbox = document.getElementById('imageLightbox');
  if (!lightbox) return;

  const img = lightbox.querySelector('.lightbox-image');
  const container = lightbox.querySelector('.lightbox-image-container');
  const zoomLabel = lightbox.querySelector('.lightbox-zoom-level');

  img.style.transform = `translate(${lightboxPanX}px, ${lightboxPanY}px) scale(${lightboxZoom})`;
  container.style.cursor = lightboxZoom > 1 ? 'grab' : 'default';
  zoomLabel.textContent = `${Math.round(lightboxZoom * 100)}%`;
}

// Export for use by other modules
window.initImagesTab = initImagesTab;
window.onImagesTabActivated = onImagesTabActivated;
window.loadFiguresForCurrentRun = loadFiguresForCurrentRun;
window.closeFigureDetails = closeFigureDetails;
window.reprocessFigure = reprocessFigure;
window.runSegmentation = runSegmentation;
window.runMermaidExtraction = runMermaidExtraction;
window.runUploadSegmentation = runUploadSegmentation;
window.runUploadMermaidExtraction = runUploadMermaidExtraction;
window.clearUpload = clearUpload;
window.openImageLightbox = openImageLightbox;
window.closeImageLightbox = closeImageLightbox;
window.lightboxZoomIn = lightboxZoomIn;
window.lightboxZoomOut = lightboxZoomOut;
window.lightboxResetZoom = lightboxResetZoom;
