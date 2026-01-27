/**
 * Images Tab Orchestration Module
 * Dependencies: app-lightbox.js, app-cytoscape.js, app-images-pipeline.js,
 *               app-images-figures.js, app-images-upload.js, app-images-history.js
 */

/* global $, CURRENT_SLUG, wireImageUpload, wireFigureListEvents, wireUploadHistoryRefresh,
          loadFiguresForCurrentRun, loadUploadHistory */

// Module state (shared across images modules via window.*)
window.IMAGES_MODE = 'pdf-figures'; // 'pdf-figures' or 'upload'
window.IMAGES_FIGURE_LIST = [];
window.IMAGES_CURRENT_FIGURE = null;
window.IMAGES_STATS = null;
window.CURRENT_UPLOAD_ID = null;
window.CURRENT_UPLOAD_DATA_URI = null;

/**
 * Initialize the Images tab when it becomes active.
 */
function initImagesTab() {
  wireImagesModeTabs();
  wireImageUpload();
  wireFigureListEvents();
  wireUploadHistoryRefresh();
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
  window.IMAGES_MODE = mode;

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

  // Load data based on mode
  if (mode === 'pdf-figures' && CURRENT_SLUG) {
    loadFiguresForCurrentRun();
  } else if (mode === 'upload') {
    loadUploadHistory();
  }
}

/**
 * Called when the Images tab is activated.
 */
function onImagesTabActivated() {
  initImagesTab();
  if (window.IMAGES_MODE === 'pdf-figures' && CURRENT_SLUG) {
    loadFiguresForCurrentRun();
  }
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
 * Escape HTML special characters.
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Window exports
window.initImagesTab = initImagesTab;
window.wireImagesModeTabs = wireImagesModeTabs;
window.switchImagesMode = switchImagesMode;
window.onImagesTabActivated = onImagesTabActivated;
window.truncateId = truncateId;
window.renderEmptyState = renderEmptyState;
window.escapeHtml = escapeHtml;
