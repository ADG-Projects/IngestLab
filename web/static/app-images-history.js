/**
 * Upload history management
 * Extracted from app-images.js for modularity
 */

/* global $, showToast, escapeHtml, renderUploadPipelineView, CURRENT_UPLOAD_ID */

/**
 * Load upload history from the server.
 */
async function loadUploadHistory() {
  const historyEl = $('uploadHistoryList');
  if (!historyEl) return;

  historyEl.innerHTML = '<div class="loading">Loading history...</div>';

  try {
    const res = await fetch('/api/uploads');
    if (!res.ok) throw new Error('Failed to load upload history');

    const data = await res.json();
    renderUploadHistory(data.uploads || []);
  } catch (err) {
    console.error('Failed to load upload history:', err);
    historyEl.innerHTML = '<div class="empty-state">Failed to load history</div>';
  }
}

/**
 * Render upload history cards.
 */
function renderUploadHistory(uploads) {
  const historyEl = $('uploadHistoryList');
  if (!historyEl) return;

  if (!uploads || uploads.length === 0) {
    historyEl.innerHTML = '<div class="empty-state">No previous uploads</div>';
    return;
  }

  historyEl.innerHTML = uploads
    .map((upload) => {
      const isActive = upload.upload_id === window.CURRENT_UPLOAD_ID;
      const stageBadge = upload.stages?.extracted
        ? 'complete'
        : upload.stages?.segmented
          ? 'segmented'
          : 'uploaded';
      const stageLabel = stageBadge === 'complete' ? 'Complete' : stageBadge === 'segmented' ? 'Segmented' : 'Uploaded';
      const typeLabel = upload.figure_type || 'unknown';
      const confidence = upload.confidence != null ? `${Math.round(upload.confidence * 100)}%` : '';
      const uploadDate = upload.uploaded_at
        ? new Date(upload.uploaded_at).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '';

      return `
        <div class="upload-history-card ${isActive ? 'active' : ''}" data-upload-id="${upload.upload_id}">
          <div class="upload-history-thumbnail-wrapper">
            <div class="upload-history-thumbnail">
              <img src="/api/figures/upload/${encodeURIComponent(upload.upload_id)}/image/original"
                   alt="${upload.filename || 'Upload'}"
                   loading="lazy"
                   onerror="this.parentElement.innerHTML='<span class=\\'no-image\\'>?</span>'" />
            </div>
            <button class="delete-btn"
                    onclick="event.stopPropagation(); deleteUpload('${upload.upload_id}')"
                    title="Delete upload">
              ×
            </button>
          </div>
          <div class="upload-history-info">
            <div class="upload-history-filename" title="${upload.filename || upload.upload_id}">
              ${truncateFilename(upload.filename || upload.upload_id)}
            </div>
            <div class="upload-history-meta">
              <span class="upload-history-stage stage-${stageBadge}">${stageLabel}</span>
              ${upload.figure_type ? `<span class="upload-history-type type-${typeLabel}">${typeLabel}</span>` : ''}
              ${confidence ? `<span class="upload-history-confidence">${confidence}</span>` : ''}
            </div>
            <div class="upload-history-date">${uploadDate}</div>
          </div>
        </div>
      `;
    })
    .join('');

  // Wire click handlers
  historyEl.querySelectorAll('.upload-history-card').forEach((card) => {
    card.addEventListener('click', () => {
      const uploadId = card.dataset.uploadId;
      if (uploadId) {
        loadUploadById(uploadId);
      }
    });
  });
}

/**
 * Truncate filename for display.
 */
function truncateFilename(filename) {
  if (!filename) return '';
  if (filename.length <= 18) return filename;
  const ext = filename.lastIndexOf('.');
  if (ext > 0 && filename.length - ext <= 5) {
    return filename.slice(0, 12) + '…' + filename.slice(ext);
  }
  return filename.slice(0, 15) + '…';
}

/**
 * Load a previous upload by ID.
 */
async function loadUploadById(uploadId) {
  const resultEl = $('imageUploadResult');
  if (!resultEl) return;

  resultEl.innerHTML = '<div class="loading">Loading upload...</div>';

  try {
    const res = await fetch(`/api/figures/upload/${encodeURIComponent(uploadId)}`);
    if (!res.ok) throw new Error('Failed to load upload');

    const data = await res.json();
    window.CURRENT_UPLOAD_ID = uploadId;
    window.CURRENT_UPLOAD_DATA_URI = null; // Will fetch from server

    renderUploadPipelineView(data);

    // Update history selection
    document.querySelectorAll('.upload-history-card').forEach((card) => {
      card.classList.toggle('active', card.dataset.uploadId === uploadId);
    });

    showToast('Upload loaded', 'success');
  } catch (err) {
    console.error('Failed to load upload:', err);
    resultEl.innerHTML = `<div class="error">Failed to load upload: ${escapeHtml(err.message)}</div>`;
    showToast(`Failed to load upload: ${err.message}`, 'error');
  }
}

/**
 * Delete an upload and all associated files.
 */
async function deleteUpload(uploadId) {
  // Find upload for confirmation message
  const uploads = await fetch('/api/uploads').then(r => r.json());
  const upload = uploads.uploads?.find(u => u.upload_id === uploadId);
  const filename = upload?.filename || uploadId;

  // Confirm deletion
  const ok = confirm(
    `Delete upload: ${filename}?\nThis will permanently remove the upload and all processing results.`
  );
  if (!ok) return;

  try {
    // Show progress
    showToast('Deleting upload...', 'ok', 1000);

    // DELETE request
    const res = await fetch(`/api/figures/upload/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE'
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || 'Deletion failed');
    }

    // Clear pipeline view if we deleted the active upload
    if (window.CURRENT_UPLOAD_ID === uploadId) {
      clearUpload();
    }

    // Refresh history list
    await loadUploadHistory();

    showToast('Upload deleted successfully', 'ok', 2000);

  } catch (err) {
    console.error('Delete failed:', err);
    showToast(`Failed to delete upload: ${err.message}`, 'err', 4000);
  }
}

/**
 * Wire the refresh history button.
 */
function wireUploadHistoryRefresh() {
  const btn = $('refreshHistoryBtn');
  if (btn) {
    btn.addEventListener('click', loadUploadHistory);
  }
}

// Window exports
window.loadUploadHistory = loadUploadHistory;
window.renderUploadHistory = renderUploadHistory;
window.truncateFilename = truncateFilename;
window.loadUploadById = loadUploadById;
window.deleteUpload = deleteUpload;
window.wireUploadHistoryRefresh = wireUploadHistoryRefresh;
