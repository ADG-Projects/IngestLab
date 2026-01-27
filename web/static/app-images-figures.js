/**
 * PDF figures loading, display, and pipeline view
 * Extracted from app-images.js for modularity
 */

/* global $, showToast, CURRENT_SLUG, CURRENT_PROVIDER, truncateId, renderEmptyState, escapeHtml,
          initCytoscapeDiagram, openImageLightbox,
          IMAGES_FIGURE_LIST, IMAGES_STATS, IMAGES_CURRENT_FIGURE */

/**
 * Load figures for the currently selected run.
 */
async function loadFiguresForCurrentRun() {
  if (!CURRENT_SLUG) {
    renderEmptyState('Select a run to view figures');
    return;
  }

  const listEl = $('imagesFigureList');

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

    window.IMAGES_STATS = await statsRes.json();
    const figuresData = await figuresRes.json();
    window.IMAGES_FIGURE_LIST = figuresData.figures || [];

    renderFiguresStats(window.IMAGES_STATS);
    renderFiguresList(window.IMAGES_FIGURE_LIST);
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

  window.IMAGES_CURRENT_FIGURE = elementId;

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

    // Initialize Cytoscape if extraction is done and it's a flowchart
    const processing = figure.processing || {};
    const stages = figure.stages || { extracted: false };
    const figureType = processing.figure_type || figure.sam3?.figure_type || 'unknown';
    const sam3 = figure.sam3 || {};

    if (stages.extracted && processing.processed_content && figureType === 'flowchart') {
      // Get shape positions from SAM3 data
      const shapePositions = sam3.shape_positions || [];
      const imageDimensions = {
        width: figure.image_width,
        height: figure.image_height
      };

      // Initialize Cytoscape after DOM update
      setTimeout(() => {
        initCytoscapeDiagram(
          `cytoscape-${figure.element_id}`,
          processing.processed_content,
          shapePositions,
          imageDimensions
        );
      }, 100);
    }
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
                   data-lightbox-title="SAM3 Annotated Image"
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
                  <div class="json-box">
                    <span class="json-label">Nodes</span>
                    <pre class="json-view">${JSON.stringify(processing.intermediate_nodes, null, 2)}</pre>
                  </div>
                  <div class="json-box">
                    <span class="json-label">Edges</span>
                    <pre class="json-view">${JSON.stringify(processing.intermediate_edges, null, 2)}</pre>
                  </div>
                </div>
              </details>
            ` : ''}
            ${processing.reasoning_trace ? `
              <details class="step-reasoning">
                <summary>Reasoning</summary>
                <p>${escapeHtml(processing.reasoning_trace)}</p>
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

    ${extractionDone && processing.processed_content && figureType === 'flowchart' ? `
    <div class="cytoscape-section">
      <div class="cytoscape-header">
        <h5>Interactive Graph</h5>
        <div class="cytoscape-controls">
          <button class="btn btn-icon" onclick="cytoscapeZoomIn()" title="Zoom in">+</button>
          <button class="btn btn-icon" onclick="cytoscapeZoomOut()" title="Zoom out">−</button>
          <button class="btn btn-icon" onclick="cytoscapeReset()" title="Reset view">⟲</button>
          <button class="btn btn-icon" onclick="cytoscapeFullscreen()" title="Fullscreen">⛶</button>
        </div>
      </div>
      <div class="cytoscape-container" id="cytoscape-${figure.element_id}"></div>
    </div>
    ` : ''}

    <div class="figure-original">
      <h4>Original Image</h4>
      <img src="/api/figures/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(figure.element_id)}/image/original?provider=${encodeURIComponent(provider)}"
           alt="Original figure"
           class="original-image zoomable-image"
           data-lightbox-title="Original Image" />
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

  // Add click handlers for zoomable images (CSP-safe approach)
  detailsEl.querySelectorAll('.zoomable-image').forEach(img => {
    img.addEventListener('click', function() {
      const title = this.getAttribute('data-lightbox-title') || this.alt || 'Image';
      openImageLightbox(this.src, title);
    });
  });
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
  window.IMAGES_CURRENT_FIGURE = null;

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

// Window exports
window.loadFiguresForCurrentRun = loadFiguresForCurrentRun;
window.renderFiguresStats = renderFiguresStats;
window.renderFiguresList = renderFiguresList;
window.wireFigureListEvents = wireFigureListEvents;
window.openFigureDetails = openFigureDetails;
window.renderFigurePipelineView = renderFigurePipelineView;
window.closeFigureDetails = closeFigureDetails;
window.reprocessFigure = reprocessFigure;
