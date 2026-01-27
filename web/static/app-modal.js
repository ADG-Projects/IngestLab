/**
 * Modal management (run modal, chunker modal)
 * Extracted from app-runs.js for modularity
 */

function wireModal() {
  const openBtn = $('openRunModal');
  const deleteBtn = $('deleteRunBtn');
  const closeBtn = $('closeRunModal');
  const backdrop = $('runModalBackdrop');
  const modal = $('runModal');
  openBtn.addEventListener('click', () => {
    const s = $('pdfSelect');
    if (s) s.disabled = false;
    modal.classList.remove('hidden');
    modal.classList.remove('running');
    const status = $('runStatus');
    if (status) status.textContent = '';
  });
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!CURRENT_SLUG) return;
      const ok = confirm(`Delete run: ${CURRENT_SLUG}? This removes its matches, tables JSONL, and trimmed PDF.`);
      if (!ok) return;
      try {
        const r = await fetch(withProvider(`/api/run/${encodeURIComponent(CURRENT_SLUG)}`, CURRENT_PROVIDER), { method: 'DELETE' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await refreshRuns();
        showToast('Run deleted', 'ok', 2000);
      } catch (e) {
        showToast(`Failed to delete run: ${e.message}`, 'err');
      }
    });
  }
  const close = () => { $('runStatus').textContent = ''; modal.classList.add('hidden'); };
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
}

function closeRunModal() {
  const modal = $('runModal');
  if (modal) {
    const status = $('runStatus');
    if (status) status.textContent = '';
    modal.classList.add('hidden');
    modal.classList.remove('running');
  }
}

function wireChunkerModal() {
  const openBtn = $('openChunkerModal');
  const closeBtn = $('closeChunkerModal');
  const backdrop = $('chunkerModalBackdrop');
  const modal = $('chunkerModal');
  const runBtn = $('runChunkerBtn');
  const status = $('chunkerStatus');
  const sourceSelect = $('chunkerSourceRun');

  if (!openBtn || !modal) return;

  openBtn.addEventListener('click', async () => {
    // Populate source run dropdown from existing runs
    if (sourceSelect) {
      sourceSelect.innerHTML = '';
      let preselectValue = null;
      if (CURRENT_SLUG) {
        preselectValue = JSON.stringify({ slug: CURRENT_SLUG, provider: CURRENT_PROVIDER || 'unstructured/local' });
      }
      try {
        const runs = await fetchJSON('/api/runs');
        if (runs && runs.length > 0) {
          runs.forEach(run => {
            const opt = document.createElement('option');
            opt.value = JSON.stringify({ slug: run.slug, provider: run.provider });
            opt.textContent = `${run.slug} (${run.provider})`;
            sourceSelect.appendChild(opt);
          });
          if (preselectValue) {
            const existing = Array.from(sourceSelect.options).find(o => o.value === preselectValue);
            if (existing) sourceSelect.value = preselectValue;
          }
        } else {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'No runs available';
          sourceSelect.appendChild(opt);
        }
      } catch (e) {
        console.error('Failed to load runs for chunker:', e);
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Error loading runs';
        sourceSelect.appendChild(opt);
      }
    }
    modal.classList.remove('hidden');
    if (status) status.textContent = '';
  });

  const close = () => {
    modal.classList.add('hidden');
    if (status) status.textContent = '';
  };
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (backdrop) backdrop.addEventListener('click', close);

  if (runBtn) {
    runBtn.addEventListener('click', async () => {
      if (!sourceSelect || !sourceSelect.value) {
        if (status) status.textContent = 'Please select a source run';
        return;
      }

      let sourceData;
      try {
        sourceData = JSON.parse(sourceSelect.value);
      } catch {
        if (status) status.textContent = 'Invalid source run selection';
        return;
      }

      if (status) status.textContent = 'Running chunker...';
      runBtn.disabled = true;

      try {
        const payload = {
          source_slug: sourceData.slug,
          source_provider: sourceData.provider,
        };

        const r = await fetch('/api/chunk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const result = await r.json();

        if (!r.ok) {
          throw new Error(result?.detail || `HTTP ${r.status}`);
        }

        if (status) {
          status.textContent = `Done! ${result.summary?.count || 0} chunks created`;
        }
        showToast(`Chunker complete: ${result.summary?.count || 0} chunks`, 'ok', 3000);
        try {
          switchView('inspect', true);
          switchInspectTab('chunks', true);
          SHOW_ELEMENT_OVERLAYS = false;
          SHOW_CHUNK_OVERLAYS = true;
          await refreshRuns();
          await loadRun(sourceData.slug, sourceData.provider);
          await renderPage(CURRENT_PAGE); // force PDF+overlay refresh so new chunk boxes appear immediately
          // Ensure we leave element overlays and immediately draw chunk overlays
          if (typeof clearBoxes === 'function') clearBoxes();
          if (typeof drawChunksModeForPage === 'function') {
            drawChunksModeForPage(CURRENT_PAGE);
            // Draw again after the tick to catch any late-arriving chunk data
            setTimeout(() => {
              try { drawChunksModeForPage(CURRENT_PAGE); } catch (_) {}
            }, 0);
          } else {
            redrawOverlaysForCurrentContext();
          }
          closeChunkerModal();
        } catch (err) {
          console.warn('Failed to switch to chunks tab after chunking', err);
        }

      } catch (e) {
        console.error('Chunker failed:', e);
        if (status) status.textContent = `Error: ${e.message}`;
        showToast(`Chunker failed: ${e.message}`, 'err');
      } finally {
        runBtn.disabled = false;
      }
    });
  }
}

function closeChunkerModal() {
  const modal = $('chunkerModal');
  if (modal) {
    const status = $('chunkerStatus');
    if (status) status.textContent = '';
    modal.classList.add('hidden');
  }
}

// Window exports
window.wireModal = wireModal;
window.closeRunModal = closeRunModal;
window.wireChunkerModal = wireChunkerModal;
window.closeChunkerModal = closeChunkerModal;
