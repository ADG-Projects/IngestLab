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
    loadExtractionPreviewForSelectedPdf();
    if (typeof loadExtractionPrefs === 'function') loadExtractionPrefs();
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

/* ---------- chunker prefs persistence ---------- */
const _CHUNKER_STORAGE_KEY = 'ingestlab:chunkerPrefs';

function _schemaDefaultsHash(schemas) {
  // Simple hash of all schema defaults — changes when upstream defaults change
  const sig = schemas.map(s => {
    const props = s.parameters?.properties || {};
    return Object.keys(props).sort().map(k => k + '=' + JSON.stringify(props[k].default)).join('|');
  }).join('||');
  let h = 0;
  for (let i = 0; i < sig.length; i++) { h = ((h << 5) - h + sig.charCodeAt(i)) | 0; }
  return h;
}

function _saveChunkerPrefs(strategy, config, schemas) {
  try {
    const hash = schemas ? _schemaDefaultsHash(schemas) : null;
    localStorage.setItem(_CHUNKER_STORAGE_KEY, JSON.stringify({ strategy, config, _v: hash }));
  } catch (_) { /* quota or private-browsing — silently ignore */ }
}

function _loadChunkerPrefs(schemas) {
  try {
    const raw = localStorage.getItem(_CHUNKER_STORAGE_KEY);
    if (!raw) return null;
    const prefs = JSON.parse(raw);
    if (!prefs || typeof prefs.strategy !== 'string') return null;
    // Invalidate stale prefs when upstream defaults change
    if (schemas && prefs._v !== _schemaDefaultsHash(schemas)) {
      localStorage.removeItem(_CHUNKER_STORAGE_KEY);
      return null;
    }
    return prefs;
  } catch (_) { /* corrupt data */ }
  return null;
}

/* ---------- chunker schema cache ---------- */
let _chunkerSchemasCache = null;

async function _fetchChunkerSchemas() {
  if (_chunkerSchemasCache) return _chunkerSchemasCache;
  try {
    _chunkerSchemasCache = await fetchJSON('/api/chunkers');
  } catch (e) {
    console.error('Failed to fetch chunker schemas:', e);
    _chunkerSchemasCache = [];
  }
  return _chunkerSchemasCache;
}

function _prettyLabel(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * Compute the set of property keys shared by ALL chunker strategies.
 * These are the inherited "base" fields from ChunkingConfig.
 */
async function _baseParamKeys() {
  const schemas = await _fetchChunkerSchemas();
  if (schemas.length === 0) return new Set();
  const sets = schemas.map(s => new Set(Object.keys(s.parameters?.properties || {})));
  const base = new Set(sets[0]);
  for (let i = 1; i < sets.length; i++) {
    for (const k of base) { if (!sets[i].has(k)) base.delete(k); }
  }
  return base;
}

function _buildParamRow(key, prop, savedConfig) {
  const hasSaved = savedConfig && key in savedConfig;
  const val = hasSaved ? savedConfig[key] : prop.default;
  const row = document.createElement('div');
  row.className = 'chunker-param-row';

  const label = document.createElement('label');
  label.textContent = _prettyLabel(key);
  label.setAttribute('for', `chunkerParam_${key}`);
  row.appendChild(label);

  let input;
  if (prop.type === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = val === true;
  } else if (prop.type === 'integer' || prop.type === 'number') {
    input = document.createElement('input');
    input.type = 'number';
    if (prop.type === 'number') input.step = 'any';
    if (val !== undefined) input.value = val;
    input.placeholder = prop.default !== undefined ? String(prop.default) : '';
  } else if (prop.type === 'array') {
    input = document.createElement('input');
    input.type = 'text';
    if (val !== undefined) input.value = (Array.isArray(val) ? val : []).join(', ');
    input.placeholder = 'comma-separated values';
  } else {
    input = document.createElement('input');
    input.type = 'text';
    if (val !== undefined) input.value = val;
  }
  input.id = `chunkerParam_${key}`;
  input.dataset.paramKey = key;
  input.dataset.paramType = prop.type || 'string';
  if (prop.default !== undefined) input.dataset.paramDefault = JSON.stringify(prop.default);
  row.appendChild(input);

  // Per-field modification indicator
  const checkModified = () => {
    if (prop.default === undefined) { row.classList.remove('pref-modified'); return; }
    let currentVal;
    if (prop.type === 'boolean') {
      currentVal = input.checked;
    } else if (prop.type === 'integer') {
      currentVal = input.value !== '' ? parseInt(input.value, 10) : undefined;
    } else if (prop.type === 'number') {
      currentVal = input.value !== '' ? parseFloat(input.value) : undefined;
    } else if (prop.type === 'array') {
      currentVal = input.value.trim() ? input.value.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    } else {
      currentVal = input.value || undefined;
    }
    const isModified = currentVal !== undefined && JSON.stringify(currentVal) !== JSON.stringify(prop.default);
    row.classList.toggle('pref-modified', isModified);
  };
  input.addEventListener(prop.type === 'boolean' ? 'change' : 'input', checkModified);
  checkModified();

  return row;
}

async function _buildAdvancedParams(schema, container, savedConfig) {
  const prevBaseOpen = container.querySelector('.chunker-base-params')?.open ?? false;
  _clearChildren(container);
  const props = schema.parameters?.properties || {};
  const hidden = new Set(['include_orig_elements']);
  const allKeys = Object.keys(props).filter(k => !hidden.has(k));
  if (allKeys.length === 0) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = 'No configurable parameters.';
    container.appendChild(span);
    return;
  }

  const baseKeys = await _baseParamKeys();
  const strategyKeys = allKeys.filter(k => !baseKeys.has(k));
  const sharedKeys = allKeys.filter(k => baseKeys.has(k));

  // Strategy-specific params first (the ones users typically tune)
  if (strategyKeys.length > 0) {
    const header = document.createElement('div');
    header.className = 'chunker-param-group-header';
    header.textContent = 'Strategy Settings';
    container.appendChild(header);
    strategyKeys.forEach(key => container.appendChild(_buildParamRow(key, props[key], savedConfig)));
  }

  // Base / shared params in a collapsible group
  if (sharedKeys.length > 0) {
    const details = document.createElement('details');
    details.className = 'chunker-base-params';
    details.open = prevBaseOpen;
    const summary = document.createElement('summary');
    summary.textContent = 'Preprocessing (shared by all strategies)';
    summary.title = 'Element filtering and section detection that runs BEFORE any chunker-specific logic. Both section_based and size_controlled chunkers inherit these settings.';
    details.appendChild(summary);
    sharedKeys.forEach(key => details.appendChild(_buildParamRow(key, props[key], savedConfig)));
    container.appendChild(details);
  }
}

function _collectParamValues(onlyOverrides) {
  const container = $('chunkerAdvancedParams');
  if (!container) return {};
  const result = {};
  container.querySelectorAll('[data-param-key]').forEach(input => {
    const key = input.dataset.paramKey;
    const type = input.dataset.paramType;
    const defaultVal = input.dataset.paramDefault;

    let val;
    if (type === 'boolean') {
      val = input.checked;
    } else if (type === 'integer') {
      val = input.value !== '' ? parseInt(input.value, 10) : undefined;
    } else if (type === 'number') {
      val = input.value !== '' ? parseFloat(input.value) : undefined;
    } else if (type === 'array') {
      val = input.value.trim() ? input.value.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    } else {
      val = input.value || undefined;
    }

    if (onlyOverrides) {
      if (val !== undefined && JSON.stringify(val) !== defaultVal) result[key] = val;
    } else {
      if (val !== undefined) result[key] = val;
    }
  });
  return result;
}

function _collectConfigOverrides() {
  return _collectParamValues(true);
}

function wireChunkerModal() {
  const openBtn = $('openChunkerModal');
  const closeBtn = $('closeChunkerModal');
  const backdrop = $('chunkerModalBackdrop');
  const modal = $('chunkerModal');
  const runBtn = $('runChunkerBtn');
  const status = $('chunkerStatus');
  const sourceSelect = $('chunkerSourceExtraction');
  const strategySelect = $('chunkerStrategy');
  const strategyDesc = $('chunkerStrategyDesc');
  const advancedDetails = $('chunkerAdvanced');
  const advancedParams = $('chunkerAdvancedParams');

  if (!openBtn || !modal) return;

  // Strategy change handler
  async function onStrategyChange(savedConfig, keepOpen) {
    const schemas = await _fetchChunkerSchemas();
    const selected = schemas.find(s => s.name === strategySelect.value);
    if (!selected) return;
    if (strategyDesc) strategyDesc.textContent = selected.description || '';
    if (advancedParams) _buildAdvancedParams(selected, advancedParams, savedConfig);
    if (advancedDetails && !keepOpen) advancedDetails.open = false;
  }

  if (strategySelect) strategySelect.addEventListener('change', () => onStrategyChange());

  // Reset to defaults button
  const resetBtn = $('resetChunkerDefaults');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      localStorage.removeItem(_CHUNKER_STORAGE_KEY);
      await onStrategyChange(undefined, true);   // rebuild params, keep Advanced open
      showToast('Chunker options reset to defaults', 'ok', 2000);
    });
  }

  openBtn.addEventListener('click', async () => {
    // Populate source extraction dropdown from existing extractions
    if (sourceSelect) {
      _clearChildren(sourceSelect);
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

    // Populate strategy dropdown and restore saved prefs
    if (strategySelect) {
      const schemas = await _fetchChunkerSchemas();
      _clearChildren(strategySelect);
      schemas.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.name;
        opt.textContent = _prettyLabel(s.name);
        strategySelect.appendChild(opt);
      });

      const prefs = _loadChunkerPrefs(schemas);
      let savedConfig = null;
      if (prefs && schemas.find(s => s.name === prefs.strategy)) {
        strategySelect.value = prefs.strategy;
        savedConfig = prefs.config || null;
      } else {
        // Fallback defaults
        if (schemas.find(s => s.name === 'size_controlled')) strategySelect.value = 'size_controlled';
        else if (schemas.find(s => s.name === 'section_based')) strategySelect.value = 'section_based';
      }
      await onStrategyChange(savedConfig);
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
          chunker: strategySelect ? strategySelect.value : 'section_based',
          config: _collectConfigOverrides(),
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
        const schemas = await _fetchChunkerSchemas();
        _saveChunkerPrefs(strategySelect ? strategySelect.value : 'section_based', _collectConfigOverrides(), schemas);
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
