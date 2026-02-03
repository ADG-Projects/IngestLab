/**
 * Extractions orchestration - main logic, init, view switching
 * Dependencies: app-pdf.js, app-extraction-jobs.js, app-extraction-preview.js, app-extraction-form.js, app-modal.js
 */

const LAST_EXTRACTION_KEY = 'chunking-visualizer-last-extraction';
const COLLAPSED_GROUPS_KEY = 'chunking-visualizer-collapsed-groups';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Legacy provider name aliases (pre-v5.0 compatibility)
const PROVIDER_ALIASES = {
  'unstructured': 'unstructured/local',
  'unstructured-partition': 'unstructured/partition',
  'azure-di': 'azure/document_intelligence',
};

function resolveProvider(provider) {
  return PROVIDER_ALIASES[provider] || provider;
}

function extractionKey(slug, provider = CURRENT_PROVIDER || 'unstructured/local') {
  const prov = (provider || 'unstructured/local').trim() || 'unstructured/local';
  return `${prov}:::${slug || ''}`;
}

function parseExtractionKey(key) {
  const raw = key || '';
  const sep = raw.indexOf(':::');
  if (sep === -1) return { slug: raw, provider: CURRENT_PROVIDER || 'unstructured/local' };
  const provider = resolveProvider(raw.slice(0, sep) || 'unstructured/local');
  const slug = raw.slice(sep + 3) || '';
  return { slug, provider };
}

function providerSupportsChunks(provider) {
  // All providers support chunks via the custom chunker
  return true;
}

function updateMainFormatBadge() {
  const badge = $('mainFormatBadge');
  if (!badge) return;

  // Get file type and name from run config (check multiple possible locations)
  const fileType = CURRENT_EXTRACTION_CONFIG?.file_type || CURRENT_EXTRACTION_CONFIG?.form_snapshot?.file_type;
  // Try form_snapshot.pdf first, then pdf field, then extract from input path
  let pdfName = CURRENT_EXTRACTION_CONFIG?.form_snapshot?.pdf || CURRENT_EXTRACTION_CONFIG?.pdf || '';
  if (!pdfName && CURRENT_EXTRACTION_CONFIG?.input) {
    // Extract filename from full path
    const input = CURRENT_EXTRACTION_CONFIG.input;
    pdfName = input.substring(input.lastIndexOf('/') + 1);
  }
  // Fallback: try to get from CURRENT_EXTRACTION's source_file or derive from slug
  if (!pdfName && CURRENT_EXTRACTION?.source_file) {
    pdfName = CURRENT_EXTRACTION.source_file;
  }
  if (!pdfName && CURRENT_EXTRACTION?.original_filename) {
    pdfName = CURRENT_EXTRACTION.original_filename;
  }
  // Last resort: if we have file_type from config, show that
  if (!pdfName && fileType) {
    badge.textContent = fileType.toUpperCase();
    badge.className = 'format-badge';
    if (fileType === 'pdf') badge.classList.add('format-pdf');
    else if (fileType === 'office') badge.classList.add('format-office');
    else if (fileType === 'image') badge.classList.add('format-image');
    badge.style.display = 'inline-block';
    return;
  }

  if (!pdfName) {
    badge.style.display = 'none';
    return;
  }

  // Extract extension from filename
  const ext = pdfName.toLowerCase().substring(pdfName.lastIndexOf('.'));
  const extDisplay = ext.replace('.', '').toUpperCase();

  badge.textContent = extDisplay;
  badge.className = 'format-badge';

  if (fileType === 'pdf' || ext === '.pdf') {
    badge.classList.add('format-pdf');
  } else if (fileType === 'office' || ['.docx', '.xlsx', '.pptx'].includes(ext)) {
    badge.classList.add('format-office');
  } else if (fileType === 'image' || ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.heif'].includes(ext)) {
    badge.classList.add('format-image');
  }

  badge.style.display = 'inline-block';
}

async function loadExtraction(slug, provider = CURRENT_PROVIDER) {
  const providerKey = (provider || CURRENT_PROVIDER || 'unstructured/local').trim() || 'unstructured/local';
  CURRENT_SLUG = slug;
  CURRENT_PROVIDER = providerKey;
  CURRENT_EXTRACTION = (EXTRACTIONS_CACHE || []).find(
    (r) => r.slug === slug && (r.provider || 'unstructured/local') === providerKey,
  ) || (EXTRACTIONS_CACHE || []).find((r) => r.slug === slug) || null;
  CURRENT_PROVIDER = (CURRENT_EXTRACTION && CURRENT_EXTRACTION.provider) || CURRENT_PROVIDER || 'unstructured/local';
  setChunksTabVisible(providerSupportsChunks(CURRENT_PROVIDER));
  const providerSel = $('providerSelect');
  if (providerSel) {
    providerSel.value = CURRENT_PROVIDER;
    providerSel.dispatchEvent(new Event('change'));
  }
  CURRENT_EXTRACTION_HAS_CHUNKS = providerSupportsChunks(CURRENT_PROVIDER) && Boolean(CURRENT_EXTRACTION && CURRENT_EXTRACTION.chunks_file);
  CURRENT_CHUNK_LOOKUP = {};
  CURRENT_CHUNK_TYPE_FILTER = 'All';
  CURRENT_CHUNK_REVIEW_FILTER = 'All';
  CURRENT_ELEMENT_REVIEW_FILTER = 'All';
  BOX_INDEX = {};
  CURRENT_PAGE_BOXES = null;
  const pdfUrl = withProvider(`/pdf/${encodeURIComponent(slug)}`, CURRENT_PROVIDER);
  const loadingTask = window['pdfjsLib'].getDocument(pdfUrl);
  PDF_DOC = await loadingTask.promise;
  PAGE_COUNT = PDF_DOC.numPages;
  CURRENT_PAGE = 1;
  SCALE_IS_MANUAL = false;
  $('pageCount').textContent = PAGE_COUNT;
  await renderPage(CURRENT_PAGE);

  CURRENT_EXTRACTION_CONFIG = CURRENT_EXTRACTION?.extraction_config || CURRENT_EXTRACTION?.run_config || null;
  CURRENT_CHUNK_SUMMARY = CURRENT_EXTRACTION?.chunk_summary || null;
  updateMainFormatBadge();
  if (CURRENT_EXTRACTION_HAS_CHUNKS) {
    await loadChunksForExtraction(slug, CURRENT_PROVIDER);
    redrawOverlaysForCurrentContext(); // ensure overlays update once chunks are available
  } else {
    CURRENT_CHUNKS = null;
    renderChunksTab();
  }
  await loadElementTypes(slug, CURRENT_PROVIDER);
  populateTypeSelectors();
  const elemReviewSel = $('elementsReviewSelect');
  if (elemReviewSel) elemReviewSel.value = CURRENT_ELEMENT_REVIEW_FILTER;
  await loadReviews(slug, CURRENT_PROVIDER);

  // Refresh images tab if currently active
  if (CURRENT_VIEW === 'images' && typeof loadFiguresForCurrentRun === 'function') {
    loadFiguresForCurrentRun();
  }
}

async function init() {
  await loadPdfs();
  wireExtractionForm();
  setupInspectTabs();
  wireModal();
  wireChunkerModal();
  setupExtractionDropdown();
  document.querySelectorAll('.view-tabs .tab').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.view || 'inspect';
      switchView(target);
      if (target === 'feedback' && !FEEDBACK_INDEX) {
        await refreshFeedbackIndex(FEEDBACK_PROVIDER_FILTER);
      }
    });
  });
  await (async function waitForPdfjs(maxMs = 5000) {
    const start = performance.now();
    while (!window['pdfjsLib']) {
      if (performance.now() - start > maxMs) throw new Error('pdf.js failed to load');
      await new Promise(r => setTimeout(r, 50));
    }
  })();
  await refreshExtractions();
  await loadPdfs();
  await ensurePdfjsReady();
  await loadExtractionPreviewForSelectedPdf();
  $('prevPage').addEventListener('click', async () => {
    if (!PDF_DOC) return;
    const n = Math.max(1, CURRENT_PAGE - 1);
    await renderPage(n);
  });
  $('nextPage').addEventListener('click', async () => {
    if (!PDF_DOC) return;
    const n = Math.min(PAGE_COUNT, CURRENT_PAGE + 1);
    await renderPage(n);
  });
  $('zoom').addEventListener('input', async (e) => {
    SCALE_IS_MANUAL = true;
    SCALE = Number(e.target.value) / 100;
    await renderPage(CURRENT_PAGE);
  });
  $('fitWidth').addEventListener('click', async () => {
    if (!PDF_DOC) return;
    const page = await PDF_DOC.getPage(CURRENT_PAGE);
    const rotation = page.rotate || 0;
    const container = $('pdfContainer');
    const rect = container.getBoundingClientRect();
    const style = getComputedStyle(container);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    const availableWidth = rect.width - paddingLeft - paddingRight;
    const baseViewport = page.getViewport({ scale: 1, rotation });
    SCALE = availableWidth / baseViewport.width;
    SCALE_IS_MANUAL = true;
    updateZoomSlider();
    await renderPage(CURRENT_PAGE);
  });
  $('fitHeight').addEventListener('click', async () => {
    if (!PDF_DOC) return;
    const page = await PDF_DOC.getPage(CURRENT_PAGE);
    const rotation = page.rotate || 0;
    const container = $('pdfContainer');
    const rect = container.getBoundingClientRect();
    const style = getComputedStyle(container);
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const availableHeight = rect.height - paddingTop - paddingBottom;
    const baseViewport = page.getViewport({ scale: 1, rotation });
    SCALE = availableHeight / baseViewport.height;
    SCALE_IS_MANUAL = true;
    updateZoomSlider();
    await renderPage(CURRENT_PAGE);
  });
  const pageNumInput = $('pageNum');
  const jumpToPage = async () => {
    if (!PDF_DOC) return;
    let n = parseInt(pageNumInput.value, 10);
    if (isNaN(n) || n < 1) n = 1;
    if (n > PAGE_COUNT) n = PAGE_COUNT;
    await renderPage(n);
  };
  pageNumInput.addEventListener('change', jumpToPage);
  pageNumInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await jumpToPage();
      pageNumInput.blur();
    }
  });
  setupReviewChipHandlers();
  $('drawerClose').addEventListener('click', async () => {
    CURRENT_CHUNK_DRAWER_ID = null;
    CURRENT_ELEMENT_DRAWER_ID = null;
    if (RETURN_TO && RETURN_TO.kind === 'chunk') {
      const chunkId = RETURN_TO.id;
      const scrollTop = RETURN_TO.scrollTop;
      RETURN_TO = null;
      if (chunkId) {
        CURRENT_INSPECT_ELEMENT_ID = chunkId;
      }
      switchView('inspect', true);
      switchInspectTab('chunks', true);
      const listEl = document.getElementById('chunkList');
      if (listEl && scrollTop != null) listEl.scrollTop = scrollTop;
      if (chunkId) {
        await openChunkDetailsDrawer(chunkId, null);
        drawChunksModeForPage(CURRENT_PAGE);
      }
    } else {
      RETURN_TO = null;
      $('drawer').classList.add('hidden');
      document.body.classList.remove('drawer-open');
      CURRENT_ELEMENT_ID = null;
      CURRENT_INSPECT_ELEMENT_ID = null;
      redrawOverlaysForCurrentContext();
    }
  });
  switchView('inspect', true);
}

// --- Extraction Dropdown Helpers ---

function getCollapsedGroups() {
  try {
    const stored = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch (e) {
    return {};
  }
}

function setCollapsedGroups(groups) {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(groups));
  } catch (e) {}
}

function toggleGroupCollapsed(groupKey) {
  const groups = getCollapsedGroups();
  groups[groupKey] = !groups[groupKey];
  setCollapsedGroups(groups);
  return groups[groupKey];
}

function groupExtractionsByTag(extractions) {
  const groups = {};
  for (const r of extractions) {
    const tag = r.tag || '(Untagged)';
    if (!groups[tag]) {
      groups[tag] = [];
    }
    groups[tag].push(r);
  }
  // Sort groups: tagged groups alphabetically first, then (Untagged) last
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    if (a === '(Untagged)') return 1;
    if (b === '(Untagged)') return -1;
    return a.localeCompare(b);
  });
  const sortedGroups = {};
  for (const key of sortedKeys) {
    sortedGroups[key] = groups[key];
  }
  return sortedGroups;
}

function renderExtractionDropdown(extractions, currentKey) {
  const menu = $('extractionMenu');
  const label = $('extractionLabel');
  if (!menu || !label) return;

  menu.innerHTML = '';

  if (!extractions || extractions.length === 0) {
    label.textContent = 'No extractions';
    return;
  }

  const groups = groupExtractionsByTag(extractions);
  const collapsedState = getCollapsedGroups();

  // Update label with current selection
  const current = extractions.find(r => extractionKey(r.slug, r.provider || 'unstructured/local') === currentKey);
  if (current) {
    const providerShort = (current.provider || '').replace('document_intelligence', 'document_intell...');
    const pageInfo = current.page_range ? ` · pages ${current.page_range}` : '';
    label.textContent = `${current.slug} · ${providerShort}${pageInfo}`;
  } else {
    label.textContent = 'Select extraction...';
  }

  for (const [tag, items] of Object.entries(groups)) {
    const groupEl = document.createElement('div');
    groupEl.className = 'extraction-group';
    if (collapsedState[tag]) {
      groupEl.classList.add('collapsed');
    }
    groupEl.dataset.tag = tag;

    // Group header
    const headerEl = document.createElement('div');
    headerEl.className = 'extraction-group-header';
    headerEl.innerHTML = `
      <span class="group-chevron">▼</span>
      <span class="group-name">${escapeHtml(tag)}</span>
      <span class="group-count">(${items.length})</span>
    `;
    headerEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const isCollapsed = toggleGroupCollapsed(tag);
      groupEl.classList.toggle('collapsed', isCollapsed);
    });
    groupEl.appendChild(headerEl);

    // Group items
    const itemsEl = document.createElement('div');
    itemsEl.className = 'extraction-group-items';

    for (const r of items) {
      const prov = r.provider || 'unstructured/local';
      const key = extractionKey(r.slug, prov);
      const itemEl = document.createElement('div');
      itemEl.className = 'extraction-item';
      if (key === currentKey) {
        itemEl.classList.add('selected');
      }
      itemEl.dataset.key = key;
      itemEl.dataset.slug = r.slug;
      itemEl.dataset.provider = prov;

      const providerShort = prov.replace('document_intelligence', 'document_intell...');
      const pageInfo = r.page_range ? `pages ${r.page_range}` : '';

      itemEl.innerHTML = `
        <span class="item-prefix">├─</span>
        <span class="item-name">${escapeHtml(r.slug)}</span>
        <span class="item-provider">${escapeHtml(providerShort)}</span>
        ${pageInfo ? `<span class="item-pages">${escapeHtml(pageInfo)}</span>` : ''}
        <span class="item-check">✓</span>
        <button type="button" class="item-tag-btn" title="Edit tag">✎</button>
      `;

      // Main click selects the extraction
      itemEl.addEventListener('click', async (e) => {
        // Don't trigger selection if clicking the tag button
        if (e.target.classList.contains('item-tag-btn')) return;
        e.stopPropagation();
        await selectExtraction(r.slug, prov);
      });

      // Tag edit button click
      const tagBtn = itemEl.querySelector('.item-tag-btn');
      if (tagBtn) {
        tagBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await editExtractionTag(r.slug, prov, r.tag);
        });
      }

      itemsEl.appendChild(itemEl);
    }

    groupEl.appendChild(itemsEl);
    menu.appendChild(groupEl);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

async function selectExtraction(slug, provider) {
  const prov = provider || 'unstructured/local';
  const key = extractionKey(slug, prov);

  // Update selection state
  CURRENT_SLUG = slug;
  CURRENT_PROVIDER = prov;

  // Update localStorage
  localStorage.setItem(LAST_EXTRACTION_KEY, key);

  // Close dropdown
  closeExtractionDropdown();

  // Update visual selection in menu
  const menu = $('extractionMenu');
  if (menu) {
    menu.querySelectorAll('.extraction-item').forEach(el => {
      el.classList.toggle('selected', el.dataset.key === key);
    });
  }

  // Update label
  const label = $('extractionLabel');
  const current = (EXTRACTIONS_CACHE || []).find(r => r.slug === slug && (r.provider || 'unstructured/local') === prov);
  if (label && current) {
    const providerShort = prov.replace('document_intelligence', 'document_intell...');
    const pageInfo = current.page_range ? ` · pages ${current.page_range}` : '';
    label.textContent = `${current.slug} · ${providerShort}${pageInfo}`;
  }

  // Load extraction
  await loadExtraction(slug, prov);
}

function openExtractionDropdown() {
  const dropdown = $('extractionDropdown');
  const menu = $('extractionMenu');
  if (!dropdown || !menu) return;
  dropdown.classList.add('open');
  menu.classList.remove('hidden');
}

function closeExtractionDropdown() {
  const dropdown = $('extractionDropdown');
  const menu = $('extractionMenu');
  if (!dropdown || !menu) return;
  dropdown.classList.remove('open');
  menu.classList.add('hidden');
}

function toggleExtractionDropdown() {
  const dropdown = $('extractionDropdown');
  if (!dropdown) return;
  if (dropdown.classList.contains('open')) {
    closeExtractionDropdown();
  } else {
    openExtractionDropdown();
  }
}

async function editExtractionTag(slug, provider, currentTag) {
  const modal = document.getElementById('tagEditorModal');
  const backdrop = document.getElementById('tagEditorModalBackdrop');
  const existingSelect = document.getElementById('tagEditorExistingSelect');
  const newInput = document.getElementById('tagEditorNewInput');
  const saveBtn = document.getElementById('tagEditorSaveBtn');
  const removeBtn = document.getElementById('tagEditorRemoveBtn');
  const cancelBtn = document.getElementById('tagEditorCancelBtn');

  if (!modal) return;

  // Populate existing tags dropdown
  existingSelect.innerHTML = '<option value="">Select existing tag...</option>';
  const tags = new Set();
  if (typeof EXTRACTIONS_CACHE !== 'undefined' && Array.isArray(EXTRACTIONS_CACHE)) {
    for (const extraction of EXTRACTIONS_CACHE) {
      if (extraction.tag) {
        tags.add(extraction.tag);
      }
    }
  }
  Array.from(tags).sort((a, b) => a.localeCompare(b)).forEach(tag => {
    const option = document.createElement('option');
    option.value = tag;
    option.textContent = tag;
    existingSelect.appendChild(option);
  });

  // Hide dropdown if no existing tags
  if (tags.size === 0) {
    existingSelect.style.display = 'none';
    existingSelect.previousElementSibling?.style && (existingSelect.closest('.variant-tag-inputs').querySelector('.variant-tag-or').style.display = 'none');
  } else {
    existingSelect.style.display = '';
    const orSpan = existingSelect.closest('.variant-tag-inputs')?.querySelector('.variant-tag-or');
    if (orSpan) orSpan.style.display = '';
  }

  // Pre-fill with current tag
  if (currentTag && tags.has(currentTag)) {
    existingSelect.value = currentTag;
    newInput.value = '';
  } else {
    existingSelect.value = '';
    newInput.value = currentTag || '';
  }

  // Wire up interactions
  existingSelect.onchange = () => {
    if (existingSelect.value) {
      newInput.value = '';
    }
  };
  newInput.oninput = () => {
    existingSelect.value = '';
  };

  modal.classList.remove('hidden');

  return new Promise((resolve) => {
    const cleanup = () => {
      modal.classList.add('hidden');
      saveBtn.onclick = null;
      removeBtn.onclick = null;
      cancelBtn.onclick = null;
      backdrop.onclick = null;
    };

    const save = async (tagValue) => {
      cleanup();
      try {
        const response = await fetch(
          `/api/extraction/${encodeURIComponent(slug)}?provider=${encodeURIComponent(provider)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag: tagValue }),
          }
        );

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.detail || `HTTP ${response.status}`);
        }

        showToast(`Tag ${tagValue ? 'updated' : 'removed'}`, 'ok', 2000);
        await refreshExtractions();
        resolve(true);
      } catch (e) {
        showToast(`Failed to update tag: ${e.message}`, 'err', 3000);
        resolve(false);
      }
    };

    saveBtn.onclick = () => {
      const tag = newInput.value.trim() || existingSelect.value || null;
      save(tag);
    };

    removeBtn.onclick = () => {
      save(null);
    };

    cancelBtn.onclick = () => {
      cleanup();
      resolve(false);
    };

    backdrop.onclick = () => {
      cleanup();
      resolve(false);
    };
  });
}

function setupExtractionDropdown() {
  const toggle = $('extractionToggle');
  const dropdown = $('extractionDropdown');

  if (toggle) {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExtractionDropdown();
    });
  }

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (dropdown && !dropdown.contains(e.target)) {
      closeExtractionDropdown();
    }
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeExtractionDropdown();
    }
  });
}

async function refreshExtractions(options = {}) {
  const extractions = await fetchJSON('/api/extractions');
  EXTRACTIONS_CACHE = extractions;

  let chosenKey = null;

  if (extractions.length) {
    let chosenExtraction = null;

    // If explicit selection requested (e.g., after job completion), use it
    if (options.slug && options.provider) {
      chosenExtraction = extractions.find(
        (r) => r.slug === options.slug && (r.provider || 'unstructured/local') === options.provider,
      );
    }

    // Otherwise try to restore from localStorage
    if (!chosenExtraction) {
      const lastExtractionKey = localStorage.getItem(LAST_EXTRACTION_KEY);
      if (lastExtractionKey) {
        const { slug, provider } = parseExtractionKey(lastExtractionKey);
        chosenExtraction = extractions.find(
          (r) => r.slug === slug && (r.provider || 'unstructured/local') === provider,
        );
      }
    }

    // Fall back to existing selection or first extraction
    if (!chosenExtraction) {
      const existing = extractions.find(
        (r) => r.slug === CURRENT_SLUG && (r.provider || 'unstructured/local') === (CURRENT_PROVIDER || 'unstructured/local'),
      );
      chosenExtraction = existing || extractions[0];
    }
    CURRENT_SLUG = chosenExtraction.slug;
    CURRENT_PROVIDER = chosenExtraction.provider || 'unstructured/local';
    chosenKey = extractionKey(CURRENT_SLUG, CURRENT_PROVIDER);

    // Render the dropdown
    renderExtractionDropdown(extractions, chosenKey);

    await loadExtraction(CURRENT_SLUG, CURRENT_PROVIDER);
  } else {
    CURRENT_SLUG = null;
    CURRENT_EXTRACTION = null;
    CURRENT_EXTRACTION_CONFIG = null;
    CURRENT_EXTRACTION_HAS_CHUNKS = false;
    ELEMENT_TYPES = [];
    CHUNK_TYPES = [];
    CURRENT_CHUNKS = null;
    CURRENT_CHUNK_SUMMARY = null;
    CURRENT_CHUNK_LOOKUP = {};
    setReviewState(_emptyReviewState());
    resetPdfViewer();
    clearBoxes();
    updateLegend([]);
    clearDrawer();
    renderChunksTab();
    populateTypeSelectors();
    renderElementsListForCurrentPage(CURRENT_PAGE_BOXES);
    updateReviewSummaryChip();

    // Update label for empty state
    const label = $('extractionLabel');
    if (label) label.textContent = 'No extractions';
  }
}

async function loadPdfs(preferredName = null) {
  try {
    const list = await fetchJSON('/api/pdfs');
    KNOWN_PDFS = Array.isArray(list)
      ? list
        .map((item) => {
          if (item && typeof item === 'object') {
            return item.name || item.slug || null;
          }
          return item;
        })
        .filter((name) => name)
      : [];
  } catch (e) {
    KNOWN_PDFS = [];
  }
  const select = $('pdfSelect');
  if (!select) return;
  select.innerHTML = '';
  for (const name of KNOWN_PDFS) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  if (preferredName && KNOWN_PDFS.includes(preferredName)) {
    select.value = preferredName;
  }
}

function setChunksTabVisible(show) {
  const tab = document.querySelector('.inspect-tabs .tab[data-inspect=\"chunks\"]');
  const pane = document.getElementById('pane-inspect-chunks');
  if (tab) tab.classList.toggle('hidden', !show);
  if (pane) pane.classList.toggle('hidden', !show);
  if (!show && INSPECT_TAB === 'chunks') {
    switchInspectTab('elements', true);
  }
}

function setupInspectTabs() {
  const tabs = document.querySelectorAll('.inspect-tabs .tab');
  for (const t of tabs) {
    t.addEventListener('click', () => switchInspectTab(t.dataset.inspect));
  }
  const deleteBtn = $('pdfDeleteBtn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async (ev) => {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
      const sel = $('pdfSelect');
      const name = sel && sel.value;
      if (!name) { showToast('No PDF selected', 'err', 2000); return; }
      try { await refreshExtractions(); } catch (_) {}
      const stem = name.replace(/\.pdf$/i, '');
      const runs = (EXTRACTIONS_CACHE || []).filter(r => {
        const cfg = r.extraction_config || r.run_config || {};
        const pdfFromCfg = cfg.pdf || (cfg.form_snapshot && cfg.form_snapshot.pdf) || null;
        if (pdfFromCfg && pdfFromCfg === name) return true;
        let base = r.slug || '';
        if (base.includes('.pages')) base = base.split('.pages')[0];
        if (base.includes('__')) base = base.split('__')[0];
        return base === stem;
      });
      let deleteRunsToo = false;
      if (runs.length > 0) {
        const listPreview = runs.slice(0, 5).map(r => `- ${r.slug}`).join('\n');
        const more = runs.length > 5 ? `\n…and ${runs.length - 5} more` : '';
        const msg = `Found ${runs.length} run(s) referencing ${name}:\n${listPreview}${more}\n\nDelete the PDF and ALL associated runs?`;
        deleteRunsToo = await showConfirm({
          title: 'Delete PDF & Runs',
          message: msg,
          confirmText: 'Delete All',
          cancelText: 'Cancel',
          destructive: true
        });
        if (!deleteRunsToo) {
          const onlyPdf = await showConfirm({
            title: 'Delete PDF Only',
            message: `Delete the PDF only and keep ${runs.length} run(s)?`,
            confirmText: 'Delete PDF',
            cancelText: 'Cancel',
            destructive: true
          });
          if (!onlyPdf) return;
        }
      } else {
        const ok = await showConfirm({
          title: 'Delete PDF',
          message: `Delete PDF: ${name}?\n\nThis removes it from server storage; runs remain intact.`,
          confirmText: 'Delete',
          cancelText: 'Cancel',
          destructive: true
        });
        if (!ok) return;
      }
      try {
        if (deleteRunsToo && runs.length > 0) {
          let okCount = 0, failCount = 0;
          for (const rr of runs) {
            try {
              const dr = await fetch(withProvider(`/api/extraction/${encodeURIComponent(rr.slug)}`, rr.provider || CURRENT_PROVIDER), { method: 'DELETE' });
              if (!dr.ok) failCount++; else okCount++;
            } catch (_) {
              failCount++;
            }
          }
          await refreshExtractions();
          showToast(`Deleted runs: ${okCount} ok, ${failCount} failed`, failCount ? 'err' : 'ok', 3000);
        }
        const r = await fetch(`/api/pdfs/${encodeURIComponent(name)}`, { method: 'DELETE' });
        let data = null; try { data = await r.json(); } catch (e) { data = null; }
        if (!r.ok) throw new Error((data && data.detail) || `HTTP ${r.status}`);
        showToast(`Deleted ${name}`, 'ok', 2000);
        await loadPdfs();
        if (!KNOWN_PDFS || KNOWN_PDFS.length === 0) {
          try {
            EXTRACTION_PREVIEW_DOC = null; EXTRACTION_PREVIEW_COUNT = 0; EXTRACTION_PREVIEW_PAGE = 1;
            const canvas = $('extractionPdfCanvas');
            if (canvas) { const ctx = canvas.getContext('2d'); ctx && ctx.clearRect(0,0,canvas.width,canvas.height); }
            const numEl = $('extractionPageNum'); const cntEl = $('extractionPageCount');
            if (numEl) numEl.textContent = '-'; if (cntEl) cntEl.textContent = '-';
          } catch (e) {}
        } else {
          try { await loadExtractionPreviewForSelectedPdf(); } catch (e) {}
        }
      } catch (e) {
        showToast(`Delete failed: ${e.message}`, 'err');
      }
    });
  }
}

function switchInspectTab(name, skipRedraw = false) {
  INSPECT_TAB = (name === 'elements') ? 'elements' : 'chunks';
  document.querySelectorAll('.inspect-tabs .tab').forEach(el => el.classList.toggle('active', el.dataset.inspect === INSPECT_TAB));
  document.querySelectorAll('#right-inspect .pane').forEach(el => el.classList.toggle('active', el.id === `pane-inspect-${INSPECT_TAB}`));
  SHOW_CHUNK_OVERLAYS = (INSPECT_TAB === 'chunks');
  SHOW_ELEMENT_OVERLAYS = (INSPECT_TAB === 'elements');
  if (!skipRedraw) {
    redrawOverlaysForCurrentContext();
  }
  updateReviewSummaryChip();
}

function setupReviewChipHandlers() {
  const chip = $('reviewSummaryChip');
  if (!chip) return;
  chip.addEventListener('click', (ev) => {
    const line = ev.target.closest('.review-chip-line');
    if (!line || !line.dataset.kind) return;
    handleReviewChipClick(line.dataset.kind);
  });
}

function handleReviewChipClick(kind) {
  if (kind === 'chunks') {
    CURRENT_CHUNK_REVIEW_FILTER = 'Reviewed';
    renderChunksTab();
    switchInspectTab('chunks');
  }
  if (kind === 'elements') {
    CURRENT_ELEMENT_REVIEW_FILTER = 'Reviewed';
    renderElementsListForCurrentPage(CURRENT_PAGE_BOXES);
    refreshElementOverlaysForCurrentPage();
    switchInspectTab('elements');
  }
}

function switchView(view, skipRedraw = false) {
  const next = view === 'feedback' ? 'feedback' : (view === 'images' ? 'images' : 'inspect');
  CURRENT_VIEW = next;
  document.querySelectorAll('.view-tabs .tab').forEach(el => {
    const active = el.dataset.view === CURRENT_VIEW;
    el.classList.toggle('active', active);
    try { el.setAttribute('aria-selected', active ? 'true' : 'false'); } catch (_) {}
  });
  const inspectShell = $('inspectShell');
  if (inspectShell) inspectShell.classList.toggle('hidden', CURRENT_VIEW !== 'inspect');
  const inspectPane = document.getElementById('right-inspect');
  if (inspectPane) inspectPane.classList.toggle('hidden', CURRENT_VIEW !== 'inspect');
  const feedbackPane = $('feedbackView');
  if (feedbackPane) feedbackPane.classList.toggle('hidden', CURRENT_VIEW !== 'feedback');
  const imagesPane = $('imagesView');
  if (imagesPane) imagesPane.classList.toggle('hidden', CURRENT_VIEW !== 'images');
  if (CURRENT_VIEW === 'feedback' || CURRENT_VIEW === 'images') {
    SHOW_CHUNK_OVERLAYS = false;
    SHOW_ELEMENT_OVERLAYS = false;
    clearDrawer();
  } else {
    SHOW_CHUNK_OVERLAYS = (INSPECT_TAB === 'chunks');
    SHOW_ELEMENT_OVERLAYS = (INSPECT_TAB === 'elements');
  }
  if (CURRENT_VIEW === 'inspect' && !skipRedraw) {
    // Always re-render PDF when switching to inspect view to ensure correct sizing
    // The PDF may have been rendered while the container was hidden (resulting in 0 dimensions)
    if (typeof PDF_DOC !== 'undefined' && PDF_DOC) {
      // Use setTimeout to ensure layout has fully reflowed after unhiding
      // This is more reliable than requestAnimationFrame for flexbox layouts
      setTimeout(() => {
        SCALE_IS_MANUAL = false;
        renderPage(CURRENT_PAGE);
      }, 50);
    } else {
      redrawOverlaysForCurrentContext();
    }
  }
  if (CURRENT_VIEW === 'images' && typeof onImagesTabActivated === 'function') {
    onImagesTabActivated();
  }
}

// Window exports
window.resolveProvider = resolveProvider;
window.extractionKey = extractionKey;
window.parseExtractionKey = parseExtractionKey;
window.providerSupportsChunks = providerSupportsChunks;
window.loadExtraction = loadExtraction;
window.init = init;
window.refreshExtractions = refreshExtractions;
window.loadPdfs = loadPdfs;
window.setChunksTabVisible = setChunksTabVisible;
window.setupInspectTabs = setupInspectTabs;
window.switchInspectTab = switchInspectTab;
window.setupReviewChipHandlers = setupReviewChipHandlers;
window.handleReviewChipClick = handleReviewChipClick;
window.switchView = switchView;
window.sleep = sleep;
window.setupExtractionDropdown = setupExtractionDropdown;
window.renderExtractionDropdown = renderExtractionDropdown;
window.selectExtraction = selectExtraction;
window.openExtractionDropdown = openExtractionDropdown;
window.closeExtractionDropdown = closeExtractionDropdown;
window.editExtractionTag = editExtractionTag;
