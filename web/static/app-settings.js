/**
 * Settings modal for system configuration
 * Handles PolicyAsCode development mode updates
 */

/* global showToast */

/**
 * Open the settings modal and load current status
 */
async function openSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;

  modal.classList.remove('hidden');

  // Load PaC status
  await loadPacStatus();
}

/**
 * Close the settings modal
 */
function closeSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

/**
 * Load and display PolicyAsCode status
 */
async function loadPacStatus() {
  const statusContainer = document.getElementById('pacStatusContent');
  const updateBtn = document.getElementById('pacUpdateBtn');

  if (!statusContainer) return;

  statusContainer.innerHTML = '<div class="pac-loading">Loading status...</div>';

  try {
    const resp = await fetch('/api/admin/pac/status');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const status = await resp.json();
    renderPacStatus(status);

    // Enable/disable update button based on dev mode
    if (updateBtn) {
      updateBtn.disabled = !status.dev_mode_enabled;
      updateBtn.title = status.dev_mode_enabled
        ? 'Clone or pull latest PaC code'
        : 'Set PAC_DEV_MODE=1 to enable';
    }
  } catch (err) {
    statusContainer.innerHTML = `<div class="pac-error">Failed to load status: ${err.message}</div>`;
  }
}

/**
 * Render PaC status information
 */
function renderPacStatus(status) {
  const statusContainer = document.getElementById('pacStatusContent');
  if (!statusContainer) return;

  const modeLabel = status.dev_mode_enabled ? 'Development (Runtime Clone)' : 'Production (Installed Package)';
  const modeClass = status.dev_mode_enabled ? 'mode-dev' : 'mode-prod';

  let html = `
    <div class="pac-status-grid">
      <div class="pac-status-item">
        <span class="pac-label">Mode</span>
        <span class="pac-value ${modeClass}">${modeLabel}</span>
      </div>
  `;

  if (status.dev_mode_enabled) {
    html += `
      <div class="pac-status-item">
        <span class="pac-label">Path</span>
        <span class="pac-value pac-path">${status.path}</span>
      </div>
      <div class="pac-status-item">
        <span class="pac-label">Branch</span>
        <span class="pac-value">${status.branch}</span>
      </div>
      <div class="pac-status-item">
        <span class="pac-label">Auth</span>
        <span class="pac-value ${status.has_token ? 'pac-auth-ok' : 'pac-auth-missing'}">${status.has_token ? 'Token configured' : 'No token (public only)'}</span>
      </div>
      <div class="pac-status-item">
        <span class="pac-label">Status</span>
        <span class="pac-value">${status.path_exists ? (status.path_initialized ? 'Active' : 'Not initialized') : 'Not cloned'}</span>
      </div>
    `;

    if (status.commit) {
      html += `
        <div class="pac-status-item">
          <span class="pac-label">Commit</span>
          <span class="pac-value pac-commit">${status.commit}</span>
        </div>
      `;
    }

    if (status.current_branch && status.current_branch !== status.branch) {
      html += `
        <div class="pac-status-item">
          <span class="pac-label">Current Branch</span>
          <span class="pac-value pac-warning">${status.current_branch} (expected: ${status.branch})</span>
        </div>
      `;
    }

    if (status.last_updated) {
      const date = new Date(status.last_updated);
      html += `
        <div class="pac-status-item">
          <span class="pac-label">Last Updated</span>
          <span class="pac-value">${date.toLocaleString()}</span>
        </div>
      `;
    }
  } else {
    if (status.installed_version) {
      html += `
        <div class="pac-status-item">
          <span class="pac-label">Installed Version</span>
          <span class="pac-value">${status.installed_version}</span>
        </div>
      `;
    }

    html += `
      <div class="pac-status-hint">
        To enable development mode, set <code>PAC_DEV_MODE=1</code> in your environment.
      </div>
    `;
  }

  html += '</div>';
  statusContainer.innerHTML = html;
}

/**
 * Update PolicyAsCode (clone/pull and reload)
 */
async function updatePac() {
  const updateBtn = document.getElementById('pacUpdateBtn');
  const statusEl = document.getElementById('pacUpdateStatus');

  if (!updateBtn) return;

  // Show loading state
  updateBtn.disabled = true;
  updateBtn.textContent = 'Updating...';
  if (statusEl) statusEl.textContent = '';

  try {
    const resp = await fetch('/api/admin/pac/update', { method: 'POST' });
    const result = await resp.json();

    if (result.success) {
      const action = result.clone_result?.action || 'update';
      const commit = result.clone_result?.commit || 'unknown';
      const modulesCleared = result.reload_result?.modules_cleared || 0;

      if (typeof showToast === 'function') {
        showToast(`PaC ${action} complete: commit ${commit}`, 'ok');
      }

      if (statusEl) {
        statusEl.textContent = `${action === 'clone' ? 'Cloned' : 'Pulled'} commit ${commit}, cleared ${modulesCleared} modules`;
        statusEl.className = 'pac-update-status success';
      }

      // Reload status display
      await loadPacStatus();
    } else {
      const error = result.error || result.clone_result?.message || 'Unknown error';
      if (typeof showToast === 'function') {
        showToast(`PaC update failed: ${error}`, 'err');
      }
      if (statusEl) {
        statusEl.textContent = error;
        statusEl.className = 'pac-update-status error';
      }
    }
  } catch (err) {
    if (typeof showToast === 'function') {
      showToast(`PaC update failed: ${err.message}`, 'err');
    }
    if (statusEl) {
      statusEl.textContent = err.message;
      statusEl.className = 'pac-update-status error';
    }
  } finally {
    updateBtn.disabled = false;
    updateBtn.textContent = 'Update PaC';
  }
}

/**
 * Initialize settings modal event handlers
 */
function initSettingsModal() {
  // Settings button click
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', openSettingsModal);
  }

  // Close button
  const closeBtn = document.getElementById('closeSettingsModal');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeSettingsModal);
  }

  // Backdrop click to close
  const backdrop = document.getElementById('settingsModalBackdrop');
  if (backdrop) {
    backdrop.addEventListener('click', closeSettingsModal);
  }

  // Update button
  const updateBtn = document.getElementById('pacUpdateBtn');
  if (updateBtn) {
    updateBtn.addEventListener('click', updatePac);
  }

  // Escape key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('settingsModal');
      if (modal && !modal.classList.contains('hidden')) {
        closeSettingsModal();
      }
    }
  });
}

// Export functions for global access
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.initSettingsModal = initSettingsModal;
window.updatePac = updatePac;
