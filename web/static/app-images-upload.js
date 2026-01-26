/**
 * Image upload handling and upload pipeline view
 * Extracted from app-images.js for modularity
 */

/* global $, showToast, escapeHtml, initCytoscapeDiagram, openImageLightbox,
          runUploadFullPipeline, runUploadClassification, runUploadDirectionDetection,
          runUploadDescriptionGeneration, runUploadSegmentation, runUploadMermaidExtraction,
          refreshUploadDetails, CURRENT_UPLOAD_ID, CURRENT_UPLOAD_DATA_URI */

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
 * Upload an image and auto-run classification.
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
    window.CURRENT_UPLOAD_ID = data.upload_id;
    window.CURRENT_UPLOAD_DATA_URI = data.original_image_data_uri;
    window.CURRENT_UPLOAD_CLASSIFICATION = null;
    window.CURRENT_UPLOAD_DIRECTION = null;

    showToast('Image uploaded successfully', 'success');

    // Render initial view with pipeline starting
    renderUploadPipelineView(data, { classificationRunning: true });

    // Auto-run full pipeline: Classification → Direction → SAM3 → Mermaid
    runUploadFullPipeline(data.upload_id);

    // Reset file input to allow re-uploading the same file
    const input = $('imageUploadInput');
    if (input) input.value = '';

    // Refresh history to show new upload
    if (typeof loadUploadHistory === 'function') loadUploadHistory();
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
    data.original_image_data_uri = window.CURRENT_UPLOAD_DATA_URI;
    renderUploadPipelineView(data);
  } catch (err) {
    console.error('Failed to refresh upload:', err);
  }
}

/**
 * Render the pipeline view for an uploaded image.
 * @param {Object} data - Upload data from API
 * @param {Object} options - Render options (classificationRunning, directionRunning, descriptionRunning)
 */
function renderUploadPipelineView(data, options = {}) {
  const resultEl = $('imageUploadResult');
  if (!resultEl) return;

  const stages = data.stages || {
    uploaded: true,
    classified: false,
    described: false,
    direction_detected: false,
    segmented: false,
    extracted: false,
  };
  const classification = data.classification || {};
  const direction = data.direction || {};
  const descriptionData = data.description || {};
  const sam3 = data.sam3 || {};
  const processing = data.processing || {};
  const uploadId = data.upload_id;

  // Determine figure type and confidence from best available source
  const figureType = processing.figure_type || sam3.figure_type || classification.figure_type || 'unknown';
  const confidence = (processing.confidence ?? sam3.confidence ?? classification.confidence) != null
    ? `${Math.round((processing.confidence ?? sam3.confidence ?? classification.confidence) * 100)}%`
    : '-';

  // Get direction from best available source
  const directionValue = direction.direction || sam3.direction || null;
  const isFlowchart = figureType === 'flowchart';
  const isOther = figureType === 'other';

  // Step states
  const classificationDone = stages.classified;
  const descriptionDone = stages.described;
  const directionDone = stages.direction_detected;
  const segmentationDone = stages.segmented;
  const extractionDone = stages.extracted;

  // Running states from options (for initial render)
  const classificationRunning = options.classificationRunning || false;
  const directionRunning = options.directionRunning || false;
  const descriptionRunning = options.descriptionRunning || false;

  // Timing info
  const classificationTime = classification.classification_duration_ms
    ? `${classification.classification_duration_ms}ms`
    : sam3.classification_duration_ms
      ? `${sam3.classification_duration_ms}ms`
      : '-';
  const directionTime = direction.direction_duration_ms ? `${direction.direction_duration_ms}ms` : '-';
  const descriptionTime = descriptionData.description_duration_ms ? `${descriptionData.description_duration_ms}ms` : '-';
  const sam3Time = sam3.sam3_duration_ms ? `${sam3.sam3_duration_ms}ms` : '-';

  // Get description text (prefer descriptionData, fall back to processing)
  const descriptionText = descriptionData.description || processing.description || null;

  // Direction step state
  const directionStepClass = directionDone
    ? 'step-complete'
    : directionRunning
      ? 'step-running'
      : 'step-pending';

  // Build pipeline steps HTML incrementally based on what we know
  // Only show steps that are relevant to the current state
  let pipelineStepsHtml = '';

  // Step 1: Classification (always shown)
  pipelineStepsHtml += `
    <div class="pipeline-step step-classification ${classificationDone ? 'step-complete' : classificationRunning ? 'step-running' : 'step-pending'}" id="upload-step-classification">
      <div class="step-header">
        <span class="step-number">${classificationDone ? '✓' : '1'}</span>
        <span class="step-title">Classification</span>
        <span class="step-badge step-badge-auto">auto</span>
        ${classificationTime !== '-' ? `<span class="step-time">${classificationTime}</span>` : ''}
      </div>
      <div class="step-content">
        ${classificationDone ? `
          <div class="step-result">
            <span class="type-badge type-${figureType}">${figureType}</span>
            <span class="confidence-label">Confidence: ${confidence}</span>
          </div>
          ${classification.reasoning ? `
            <details class="step-reasoning">
              <summary>Reasoning</summary>
              <p>${escapeHtml(classification.reasoning)}</p>
            </details>
          ` : ''}
        ` : classificationRunning ? `
          <span class="no-data">Classifying image...</span>
        ` : `
          <span class="no-data">Waiting for classification</span>
        `}
      </div>
    </div>
  `;

  // Only show subsequent steps after classification is done
  if (classificationDone) {
    // For OTHER images: show Description step only
    if (isOther || !isFlowchart) {
      const descStepClass = descriptionDone
        ? 'step-complete'
        : descriptionRunning
          ? 'step-running'
          : 'step-pending';

      pipelineStepsHtml += `
        <div class="pipeline-step step-description ${descStepClass}" id="upload-step-description">
          <div class="step-header">
            <span class="step-number">${descriptionDone ? '✓' : '2'}</span>
            <span class="step-title">Description</span>
            <span class="step-badge step-badge-auto">auto</span>
            ${descriptionTime !== '-' ? `<span class="step-time">${descriptionTime}</span>` : ''}
          </div>
          <div class="step-content">
            ${descriptionDone && descriptionText ? `
              <div class="step-result description-result">
                <p class="description-text">${escapeHtml(descriptionText)}</p>
              </div>
            ` : descriptionRunning ? `
              <span class="no-data">Generating description...</span>
            ` : `
              <span class="no-data">Waiting...</span>
            `}
          </div>
        </div>
      `;
    } else {
      // For flowcharts: show the full pipeline

      // Step 2: Direction Detection
      pipelineStepsHtml += `
        <div class="pipeline-step step-direction ${directionStepClass}" id="upload-step-direction">
          <div class="step-header">
            <span class="step-number">${directionDone ? '✓' : '2'}</span>
            <span class="step-title">Direction Detection</span>
            <span class="step-badge step-badge-auto">auto</span>
            ${directionDone ? `<span class="step-time">${directionTime}</span>` : ''}
          </div>
          <div class="step-content">
            ${directionDone ? `
              <div class="step-result">
                <span class="direction-badge direction-${directionValue}">${directionValue}</span>
                <span class="direction-description">${getDirectionDescription(directionValue)}</span>
              </div>
            ` : directionRunning ? `
              <span class="no-data">Detecting flow direction...</span>
            ` : `
              <span class="no-data">Waiting...</span>
            `}
          </div>
        </div>
      `;

      // Step 3: SAM3 Segmentation
      pipelineStepsHtml += `
        <div class="pipeline-step step-segmentation ${segmentationDone ? 'step-complete' : 'step-pending'}" id="upload-step-segmentation">
          <div class="step-header">
            <span class="step-number">${segmentationDone ? '✓' : '3'}</span>
            <span class="step-title">SAM3 Segmentation</span>
            <span class="step-badge step-badge-auto">auto</span>
            ${sam3Time !== '-' ? `<span class="step-time">${sam3Time}</span>` : ''}
            ${segmentationDone ? `
              <button class="btn btn-sm btn-secondary step-action" onclick="runUploadSegmentation('${uploadId}')" title="Re-run segmentation">Re-run</button>
            ` : ''}
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
                     data-lightbox-title="SAM3 Annotated Image"
                     onerror="this.style.display='none'" />
              ` : ''}
            ` : `
              <span class="no-data">Waiting...</span>
            `}
          </div>
        </div>
      `;

      // Step 4: Mermaid Extraction
      pipelineStepsHtml += `
        <div class="pipeline-step step-mermaid ${extractionDone ? 'step-complete' : 'step-pending'}" id="upload-step-mermaid">
          <div class="step-header">
            <span class="step-number">${extractionDone ? '✓' : '4'}</span>
            <span class="step-title">Mermaid Extraction</span>
            <span class="step-badge step-badge-auto">auto</span>
            ${extractionDone ? `
              <button class="btn btn-sm btn-secondary step-action" onclick="runUploadMermaidExtraction('${uploadId}')" title="Re-run extraction">Re-run</button>
            ` : ''}
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
            ` : `
              <span class="no-data">Waiting...</span>
            `}
          </div>
        </div>
      `;
    }
  }

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
               data-lightbox-title="Original Image" />
        </div>

        <div class="pipeline-view">
          ${pipelineStepsHtml}
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
        <div class="cytoscape-container" id="cytoscape-upload-${uploadId}"></div>
      </div>
      ` : ''}

      ${!isOther && processing.description ? `
      <div class="upload-result-description">
        <h5>Description</h5>
        <p>${escapeHtml(processing.description)}</p>
      </div>
      ` : ''}
    </div>
  `;

  // Add click handlers for zoomable images (CSP-safe approach)
  resultEl.querySelectorAll('.zoomable-image').forEach(img => {
    img.addEventListener('click', function() {
      const title = this.getAttribute('data-lightbox-title') || this.alt || 'Image';
      openImageLightbox(this.src, title);
    });
  });

  // Initialize Cytoscape if extraction is done and it's a flowchart
  if (extractionDone && processing.processed_content && figureType === 'flowchart') {
    const shapePositions = sam3.shape_positions || [];
    setTimeout(() => {
      initCytoscapeDiagram(
        `cytoscape-upload-${uploadId}`,
        processing.processed_content,
        shapePositions
      );
    }, 100);
  }
}

/**
 * Get human-readable description for flow direction.
 */
function getDirectionDescription(direction) {
  const descriptions = {
    'LR': 'Left to Right',
    'RL': 'Right to Left',
    'TB': 'Top to Bottom',
    'BT': 'Bottom to Top',
  };
  return descriptions[direction] || direction || 'Unknown';
}

/**
 * Clear the current upload and reset the upload panel.
 */
function clearUpload() {
  window.CURRENT_UPLOAD_ID = null;
  window.CURRENT_UPLOAD_DATA_URI = null;
  const resultEl = $('imageUploadResult');
  if (resultEl) {
    resultEl.innerHTML = '';
  }
  // Reset file input to allow re-uploading the same file
  const input = $('imageUploadInput');
  if (input) input.value = '';
}

// Window exports
window.wireImageUpload = wireImageUpload;
window.uploadImage = uploadImage;
window.refreshUploadDetails = refreshUploadDetails;
window.renderUploadPipelineView = renderUploadPipelineView;
window.clearUpload = clearUpload;
window.getDirectionDescription = getDirectionDescription;
