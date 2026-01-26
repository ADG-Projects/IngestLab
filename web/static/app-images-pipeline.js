/**
 * Pipeline processing functions for SAM3 segmentation and Mermaid extraction
 * Extracted from app-images.js for modularity
 */

/**
 * Run SAM3 segmentation on a PDF figure (stage 1).
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
 * Run mermaid extraction on a PDF figure (stage 2).
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
 * Run classification only on uploaded image (auto step after upload).
 */
async function runUploadClassification(uploadId) {
  const stepEl = document.getElementById('upload-step-classification');
  if (stepEl) {
    stepEl.classList.remove('step-complete', 'step-pending', 'step-skipped');
    stepEl.classList.add('step-running');
  }

  try {
    const res = await fetch(`/api/figures/upload/${encodeURIComponent(uploadId)}/classify`, {
      method: 'POST',
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || 'Classification failed');
    }

    const data = await res.json();
    showToast(`Classified as ${data.figure_type} (${Math.round((data.confidence || 0) * 100)}%)`, 'success');

    // Store classification result for UI updates
    window.CURRENT_UPLOAD_CLASSIFICATION = data;

    // If flowchart, auto-run direction detection
    if (data.figure_type === 'flowchart') {
      await runUploadDirectionDetection(uploadId);
    } else {
      // Not a flowchart, mark direction as skipped and refresh
      window.CURRENT_UPLOAD_DIRECTION = { skipped: true };
      refreshUploadDetails(uploadId);
    }

    return data;
  } catch (err) {
    console.error('Classification failed:', err);
    showToast(`Classification failed: ${err.message}`, 'error');

    if (stepEl) {
      stepEl.classList.remove('step-running');
      stepEl.classList.add('step-pending');
    }
    throw err;
  }
}

/**
 * Run direction detection on uploaded image (auto step for flowcharts).
 */
async function runUploadDirectionDetection(uploadId) {
  const stepEl = document.getElementById('upload-step-direction');
  if (stepEl) {
    stepEl.classList.remove('step-complete', 'step-pending', 'step-skipped');
    stepEl.classList.add('step-running');
  }

  try {
    const res = await fetch(`/api/figures/upload/${encodeURIComponent(uploadId)}/detect-direction`, {
      method: 'POST',
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || 'Direction detection failed');
    }

    const data = await res.json();
    showToast(`Detected direction: ${data.direction}`, 'success');

    // Store direction result for UI updates
    window.CURRENT_UPLOAD_DIRECTION = data;

    // Refresh the view
    refreshUploadDetails(uploadId);

    return data;
  } catch (err) {
    console.error('Direction detection failed:', err);
    showToast(`Direction detection failed: ${err.message}`, 'error');

    if (stepEl) {
      stepEl.classList.remove('step-running');
      stepEl.classList.add('step-pending');
    }
    throw err;
  }
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
 * Render the Action Detection pipeline step showing detected edges/arrows.
 */
function renderActionDetectionStep(edges, extractionDone) {
  const edgeList = edges || [];
  const edgeCount = edgeList.length;
  const hasEdges = edgeCount > 0;

  return `
    <div class="pipeline-step step-action-detection ${extractionDone ? 'step-complete' : 'step-pending'}" id="step-action-detection">
      <div class="step-header">
        <span class="step-number">${extractionDone ? '✓' : '5'}</span>
        <span class="step-title">Action Detection</span>
        <span class="step-badge step-badge-auto">auto</span>
        ${hasEdges ? `<span class="edge-count">${edgeCount} edge${edgeCount !== 1 ? 's' : ''}</span>` : ''}
      </div>
      <div class="step-content">
        ${extractionDone ? (hasEdges ? `
          <details class="edge-details">
            <summary>Detected Edges (${edgeCount})</summary>
            <ul class="edge-list">
              ${edgeList.map((edge) => `
                <li class="edge-item">
                  <span class="edge-from">${escapeHtml(edge.from)}</span>
                  <span class="edge-arrow">→</span>
                  <span class="edge-to">${escapeHtml(edge.to)}</span>
                  ${edge.label ? `<span class="edge-label">"${escapeHtml(edge.label)}"</span>` : ''}
                </li>
              `).join('')}
            </ul>
          </details>
        ` : `
          <span class="no-data">No edges detected in this figure</span>
        `) : `
          <span class="no-data">Run Mermaid extraction to detect edges</span>
        `}
      </div>
    </div>
  `;
}

// Window exports
window.runSegmentation = runSegmentation;
window.runMermaidExtraction = runMermaidExtraction;
window.runUploadClassification = runUploadClassification;
window.runUploadDirectionDetection = runUploadDirectionDetection;
window.runUploadSegmentation = runUploadSegmentation;
window.runUploadMermaidExtraction = runUploadMermaidExtraction;
window.renderActionDetectionStep = renderActionDetectionStep;
