/**
 * Modal management (extraction modal, chunker modal)
 * Extracted from app-extractions.js for modularity
 */

function wireModal() {
  const openBtn = $('openExtractionModal');
  const deleteBtn = $('deleteExtractionBtn');
  const closeBtn = $('closeExtractionModal');
  const backdrop = $('extractionModalBackdrop');
  const modal = $('extractionModal');
  openBtn.addEventListener('click', () => {
    const s = $('pdfSelect');
    if (s) s.disabled = false;
    modal.classList.remove('hidden');
    modal.classList.remove('extracting');
    const status = $('extractionStatus');
    if (status) status.textContent = '';
    populateExistingTagsDropdown();
  });

  // Wire up existing tag dropdown to populate the text input
  const existingTagSelect = $('existingTagSelect');
  const variantTagInput = $('variantTag');
  if (existingTagSelect && variantTagInput) {
    existingTagSelect.addEventListener('change', () => {
      if (existingTagSelect.value) {
        variantTagInput.value = existingTagSelect.value;
      }
    });
    // Clear dropdown selection when user types a new tag
    variantTagInput.addEventListener('input', () => {
      existingTagSelect.value = '';
    });
  }
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!CURRENT_SLUG) return;
      const ok = await showConfirm({
        title: 'Delete Extraction',
        message: `Delete extraction: ${CURRENT_SLUG}?\n\nThis removes its matches, tables JSONL, and trimmed PDF.`,
        confirmText: 'Delete',
        cancelText: 'Cancel',
        destructive: true
      });
      if (!ok) return;
      try {
        const r = await fetch(withProvider(`/api/extraction/${encodeURIComponent(CURRENT_SLUG)}`, CURRENT_PROVIDER), { method: 'DELETE' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await refreshExtractions();
        if (typeof clearImagesFiguresState === 'function') {
          clearImagesFiguresState();
        }
        showToast('Extraction deleted', 'ok', 2000);
      } catch (e) {
        showToast(`Failed to delete extraction: ${e.message}`, 'err');
      }
    });
  }
  const close = () => { $('extractionStatus').textContent = ''; modal.classList.add('hidden'); };
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
}

function closeExtractionModal() {
  const modal = $('extractionModal');
  if (modal) {
    const status = $('extractionStatus');
    if (status) status.textContent = '';
    modal.classList.add('hidden');
    modal.classList.remove('extracting');
  }
}

function wireChunkerModal() {
  const openBtn = $('openChunkerModal');
  const closeBtn = $('closeChunkerModal');
  const backdrop = $('chunkerModalBackdrop');
  const modal = $('chunkerModal');
  const runBtn = $('runChunkerBtn');
  const status = $('chunkerStatus');
  const sourceSelect = $('chunkerSourceExtraction');

  if (!openBtn || !modal) return;

  openBtn.addEventListener('click', async () => {
    // Populate source extraction dropdown from existing extractions
    if (sourceSelect) {
      sourceSelect.innerHTML = '';
      let preselectValue = null;
      if (CURRENT_SLUG) {
        preselectValue = JSON.stringify({ slug: CURRENT_SLUG, provider: CURRENT_PROVIDER || 'unstructured/local' });
      }
      try {
        const extractions = await fetchJSON('/api/extractions');
        if (extractions && extractions.length > 0) {
          extractions.forEach(extraction => {
            const opt = document.createElement('option');
            opt.value = JSON.stringify({ slug: extraction.slug, provider: extraction.provider });
            opt.textContent = `${extraction.slug} (${extraction.provider})`;
            sourceSelect.appendChild(opt);
          });
          if (preselectValue) {
            const existing = Array.from(sourceSelect.options).find(o => o.value === preselectValue);
            if (existing) sourceSelect.value = preselectValue;
          }
        } else {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'No extractions available';
          sourceSelect.appendChild(opt);
        }
      } catch (e) {
        console.error('Failed to load extractions for chunker:', e);
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Error loading extractions';
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
        if (status) status.textContent = 'Please select a source extraction';
        return;
      }

      let sourceData;
      try {
        sourceData = JSON.parse(sourceSelect.value);
      } catch {
        if (status) status.textContent = 'Invalid source extraction selection';
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
          await refreshExtractions();
          await loadExtraction(sourceData.slug, sourceData.provider);
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

/**
 * Populate the existing tags dropdown from cached extractions
 */
function populateExistingTagsDropdown() {
  const select = document.getElementById('existingTagSelect');
  if (!select) return;

  // Clear existing options except the placeholder
  select.innerHTML = '<option value="">Select existing tag...</option>';

  const tags = new Set();
  if (typeof EXTRACTIONS_CACHE !== 'undefined' && Array.isArray(EXTRACTIONS_CACHE)) {
    for (const extraction of EXTRACTIONS_CACHE) {
      if (extraction.tag) {
        tags.add(extraction.tag);
      }
    }
  }

  // Sort and add options
  Array.from(tags).sort((a, b) => a.localeCompare(b)).forEach(tag => {
    const option = document.createElement('option');
    option.value = tag;
    option.textContent = tag;
    select.appendChild(option);
  });

  // Hide dropdown if no existing tags
  const wrapper = select.closest('.variant-tag-inputs');
  if (wrapper) {
    const orSpan = wrapper.querySelector('.variant-tag-or');
    if (tags.size === 0) {
      select.style.display = 'none';
      if (orSpan) orSpan.style.display = 'none';
    } else {
      select.style.display = '';
      if (orSpan) orSpan.style.display = '';
    }
  }
}

// Window exports
window.wireModal = wireModal;
window.closeExtractionModal = closeExtractionModal;
window.wireChunkerModal = wireChunkerModal;
window.closeChunkerModal = closeChunkerModal;
window.populateExistingTagsDropdown = populateExistingTagsDropdown;
