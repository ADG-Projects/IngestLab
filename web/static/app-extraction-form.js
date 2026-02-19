/**
 * Extraction form wiring and validation
 * Extracted from app-extractions.js for modularity
 */

// Cached supported formats from API
let SUPPORTED_FORMATS = null;

/**
 * Fetch supported formats from the API and cache them.
 * Updates the file input accept attribute dynamically.
 */
async function fetchSupportedFormats() {
  if (SUPPORTED_FORMATS) return SUPPORTED_FORMATS;
  try {
    const resp = await fetch('/api/supported-formats');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    SUPPORTED_FORMATS = await resp.json();
    // Update file input accept attribute
    const input = $('pdfUploadInput');
    if (input && SUPPORTED_FORMATS.extensions) {
      input.accept = SUPPORTED_FORMATS.extensions.join(',');
    }
    return SUPPORTED_FORMATS;
  } catch (e) {
    console.error('Failed to fetch supported formats:', e);
    // Fallback to hardcoded values
    SUPPORTED_FORMATS = {
      extensions: ['.pdf', '.docx', '.pptx', '.xlsx', '.xls', '.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.heif'],
      categories: {
        pdf: ['.pdf'],
        image: ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.heif'],
        office: ['.docx', '.pptx'],
        spreadsheet: ['.xlsx', '.xls']
      }
    };
    return SUPPORTED_FORMATS;
  }
}

/**
 * Check if a filename has a supported extension.
 */
function isSupportedFile(filename) {
  if (!filename || !SUPPORTED_FORMATS) return false;
  const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
  return SUPPORTED_FORMATS.extensions.includes(ext);
}

/**
 * Get the file type category for a filename.
 */
function getFileType(filename) {
  if (!filename || !SUPPORTED_FORMATS) return null;
  const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
  for (const [cat, exts] of Object.entries(SUPPORTED_FORMATS.categories || {})) {
    if (exts.includes(ext)) return cat;
  }
  return null;
}

/* ---------- extraction prefs persistence ---------- */
const _EXTRACTION_STORAGE_KEY = 'ingestlab:extractionPrefs';

const _EXTRACTION_DEFAULTS = {
  azureOutputFormat: 'markdown',
  azureFigureImage: false,
  azureProcessFigures: true,
  azureBarcodes: false,
  azureLanguage: true,
  azureKvp: false,
  azureHighRes: false,
  azureStyleFont: false,
  azureFormulas: false,
  azureModelId: '',
  azureLocale: '',
  azureStringIndexType: '',
  azureQueryFields: '',
};

const _EXTRACTION_CHECK_IDS = ['azureFigureImage', 'azureProcessFigures', 'azureBarcodes', 'azureLanguage', 'azureKvp', 'azureHighRes', 'azureStyleFont', 'azureFormulas'];
const _EXTRACTION_TEXT_IDS = ['azureModelId', 'azureLocale', 'azureStringIndexType', 'azureQueryFields'];

function _extractionDefaultsHash() {
  const sig = JSON.stringify(_EXTRACTION_DEFAULTS);
  let h = 0;
  for (let i = 0; i < sig.length; i++) { h = ((h << 5) - h + sig.charCodeAt(i)) | 0; }
  return h;
}

function _resetExtractionToDefaults() {
  const mdRadio = document.querySelector('input[name="azureOutputFormat"][value="markdown"]');
  const textRadio = document.querySelector('input[name="azureOutputFormat"][value="text"]');
  if (mdRadio) mdRadio.checked = true;
  if (textRadio) textRadio.checked = false;
  for (const id of _EXTRACTION_CHECK_IDS) {
    const el = $(id);
    if (el) el.checked = _EXTRACTION_DEFAULTS[id];
  }
  for (const id of _EXTRACTION_TEXT_IDS) {
    const el = $(id);
    if (el) el.value = '';
  }
}

function _collectExtractionValues() {
  const vals = {};
  const fmt = document.querySelector('input[name="azureOutputFormat"]:checked');
  vals.azureOutputFormat = fmt ? fmt.value : 'markdown';
  for (const id of _EXTRACTION_CHECK_IDS) {
    const el = $(id);
    vals[id] = el ? el.checked : _EXTRACTION_DEFAULTS[id];
  }
  for (const id of _EXTRACTION_TEXT_IDS) {
    const el = $(id);
    vals[id] = el ? (el.value || '') : '';
  }
  return vals;
}

function saveExtractionPrefs() {
  try {
    const vals = _collectExtractionValues();
    const overrides = {};
    for (const [key, val] of Object.entries(vals)) {
      if (JSON.stringify(val) !== JSON.stringify(_EXTRACTION_DEFAULTS[key])) overrides[key] = val;
    }
    localStorage.setItem(_EXTRACTION_STORAGE_KEY, JSON.stringify({
      config: overrides, _v: _extractionDefaultsHash(),
    }));
  } catch (_) { /* quota or private-browsing */ }
}

function loadExtractionPrefs() {
  _resetExtractionToDefaults();
  try {
    const raw = localStorage.getItem(_EXTRACTION_STORAGE_KEY);
    if (!raw) { _updateExtractionModifiedIndicators(); return; }
    const prefs = JSON.parse(raw);
    if (!prefs || prefs._v !== _extractionDefaultsHash()) {
      localStorage.removeItem(_EXTRACTION_STORAGE_KEY);
      _updateExtractionModifiedIndicators();
      return;
    }
    const config = prefs.config || {};
    if (config.azureOutputFormat) {
      const radio = document.querySelector(`input[name="azureOutputFormat"][value="${config.azureOutputFormat}"]`);
      if (radio) radio.checked = true;
    }
    for (const id of _EXTRACTION_CHECK_IDS) {
      if (id in config) { const el = $(id); if (el) el.checked = config[id]; }
    }
    for (const id of _EXTRACTION_TEXT_IDS) {
      if (id in config) { const el = $(id); if (el) el.value = config[id]; }
    }
    _updateExtractionModifiedIndicators();
  } catch (_) {
    localStorage.removeItem(_EXTRACTION_STORAGE_KEY);
    _updateExtractionModifiedIndicators();
  }
}

function _updateExtractionModifiedIndicators() {
  const vals = _collectExtractionValues();
  // Radio: output format
  const fmtRadio = document.querySelector('input[name="azureOutputFormat"]');
  const fmtGroup = fmtRadio ? fmtRadio.closest('.opt-group') : null;
  if (fmtGroup) fmtGroup.classList.toggle('pref-modified', vals.azureOutputFormat !== _EXTRACTION_DEFAULTS.azureOutputFormat);
  // Checkboxes
  for (const id of _EXTRACTION_CHECK_IDS) {
    const el = $(id);
    if (!el) continue;
    const label = el.closest('label');
    if (label) label.classList.toggle('pref-modified', vals[id] !== _EXTRACTION_DEFAULTS[id]);
  }
  // Text fields
  for (const id of _EXTRACTION_TEXT_IDS) {
    const el = $(id);
    if (!el) continue;
    const label = el.closest('label');
    if (label) label.classList.toggle('pref-modified', (vals[id] || '') !== _EXTRACTION_DEFAULTS[id]);
  }
}

function _wireExtractionModifiedIndicators() {
  // Radio: output format
  document.querySelectorAll('input[name="azureOutputFormat"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const checked = document.querySelector('input[name="azureOutputFormat"]:checked');
      const isModified = checked && checked.value !== _EXTRACTION_DEFAULTS.azureOutputFormat;
      const group = radio.closest('.opt-group');
      if (group) group.classList.toggle('pref-modified', isModified);
    });
  });
  // Checkboxes
  for (const id of _EXTRACTION_CHECK_IDS) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('change', () => {
      const label = el.closest('label');
      if (label) label.classList.toggle('pref-modified', el.checked !== _EXTRACTION_DEFAULTS[id]);
    });
  }
  // Text fields
  for (const id of _EXTRACTION_TEXT_IDS) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('input', () => {
      const label = el.closest('label');
      if (label) label.classList.toggle('pref-modified', (el.value || '') !== _EXTRACTION_DEFAULTS[id]);
    });
  }
}

function wireExtractionForm() {
  // Fetch supported formats from API (non-blocking)
  fetchSupportedFormats().catch(e => console.warn('Could not fetch supported formats:', e));

  const providerSel = $('providerSelect');
  const unstructuredBlocks = document.querySelectorAll('.unstructured-only');
  const azureHideables = document.querySelectorAll('.azure-hidden');
  const azureSettings = $('azureSettings');
  const updateStrategyOptions = (provider) => {
    const sel = $('strategySelect');
    if (!sel) return;
    const allowedUnstructured = new Set(['auto', 'fast', 'hi_res']);
    const allowedPartition = new Set(['auto', 'fast', 'hi_res', 'ocr_only', 'vlm']);
    const allowed = provider === 'unstructured/local'
      ? allowedUnstructured
      : (provider === 'unstructured/partition' ? allowedPartition : allowedUnstructured);
    let current = sel.value;
    for (const opt of sel.options) {
      const ok = allowed.has(opt.value);
      opt.disabled = !ok;
    }
    if (!allowed.has(current)) {
      const first = sel.querySelector('option:not([disabled])');
      if (first) {
        sel.value = first.value;
      }
    }
  };
  const handleProviderChange = () => {
    const val = providerSel ? providerSel.value : 'unstructured/local';
    CURRENT_PROVIDER = val || 'unstructured/local';
    const isUnstructured = val === 'unstructured/local';
    const isPartition = val === 'unstructured/partition';
    const isUnstructuredFamily = isUnstructured || isPartition;
    const isAzure = val.startsWith('azure');
    unstructuredBlocks.forEach((el) => { if (el) el.classList.toggle('hidden', !isUnstructuredFamily); });
    if (azureSettings) azureSettings.classList.toggle('hidden', isUnstructuredFamily);
    azureHideables.forEach((el) => { if (el) el.classList.toggle('hidden', isAzure); });
    setChunksTabVisible(providerSupportsChunks(CURRENT_PROVIDER));
    updateStrategyOptions(CURRENT_PROVIDER);
  };
  if (providerSel) {
    providerSel.value = CURRENT_PROVIDER;
    providerSel.addEventListener('change', handleProviderChange);
  }
  handleProviderChange();

  const uploadInput = $('pdfUploadInput');
  const uploadStatus = $('pdfUploadStatus');
  const uploadBtn = $('pdfUploadBtn');
  if (uploadInput) {
    let uploading = false;
    const setStatus = (msg) => { if (uploadStatus) uploadStatus.textContent = msg || ''; };
    const setUploadingState = (flag) => {
      uploading = flag;
      if (uploadBtn) {
        uploadBtn.disabled = flag;
        uploadBtn.textContent = flag ? 'Uploading…' : 'Upload';
      }
    };
    const handleUpload = async () => {
      if (uploading) return;
      if (!uploadInput.files || !uploadInput.files.length) return;
      const file = uploadInput.files[0];
      if (!file || !file.name || !isSupportedFile(file.name)) {
        const exts = SUPPORTED_FORMATS?.extensions?.join(', ') || '.pdf';
        setStatus(`Unsupported file type. Accepted: ${exts}`);
        uploadInput.value = '';
        return;
      }
      const form = new FormData();
      form.append('file', file);
      setUploadingState(true);
      setStatus(`Uploading ${file.name}…`);
      try {
        const resp = await fetch('/api/pdfs', { method: 'POST', body: form });
        let data = null;
        try { data = await resp.json(); } catch (err) { data = null; }
        if (!resp.ok) throw new Error((data && data.detail) || `HTTP ${resp.status}`);
        setStatus(`Uploaded ${data.name}`);
        uploadInput.value = '';
        await loadPdfs(data?.name || null);
        try {
          await loadExtractionPreviewForSelectedPdf();
        } catch (err) {
          console.error('Failed to refresh preview after upload', err);
        }
      } catch (e) {
        setStatus(`Upload failed: ${e.message}`);
      } finally {
        setUploadingState(false);
      }
    };
    const requestUpload = async () => {
      if (!uploadInput.files || !uploadInput.files.length) return;
      await handleUpload();
    };
    uploadInput.addEventListener('change', requestUpload);
    uploadInput.addEventListener('input', requestUpload);
    if (uploadBtn) uploadBtn.addEventListener('click', requestUpload);
    setUploadingState(false);
  }

  $('extractionBtn').addEventListener('click', async () => {
    const status = $('extractionStatus');
    status.textContent = '';
    const provider = (providerSel ? providerSel.value : 'unstructured/local') || 'unstructured/local';
    const isAzure = provider.startsWith('azure');
    const isPartition = provider === 'unstructured/partition';
    const isUnstructured = provider === 'unstructured/local';
    const isUnstructuredFamily = isUnstructured || isPartition;
    const payload = {
      provider,
      pdf: $('pdfSelect').value,
      pages: $('pagesInput').value.trim(),
    };
    const langSel = $('docLanguage');
    const docLang = langSel ? (langSel.value || 'eng') : 'eng';
    if (!isAzure) {
      payload.primary_language = docLang;
      if (docLang === 'ara') {
        payload.ocr_languages = 'ara+eng';
        payload.languages = 'ar,en';
        payload.detect_language_per_element = true;
      } else {
        payload.ocr_languages = 'eng+ara';
        payload.languages = 'en,ar';
        payload.detect_language_per_element = false;
      }
    } else {
      payload.primary_language = docLang;
      payload.ocr_languages = null;
      payload.languages = null;
      payload.detect_language_per_element = false;
    }
    const tagVal = $('variantTag')?.value?.trim();
    if (tagVal) payload.tag = tagVal;
    const parseNumber = (id) => {
      const input = $(id);
      if (!input) return null;
      const raw = input.value.trim();
      if (!raw) return null;
      const num = Number(raw);
      return Number.isFinite(num) ? num : null;
    };
    const parseBoolSelect = (id) => {
      const el = $(id);
      if (!el) return null;
      const val = el.value;
      if (val === '') return null;
      return val === 'true';
    };
    if (isUnstructuredFamily) {
      payload.strategy = $('strategySelect').value;
      const rawImgTypes = $('extractImageBlockTypes')?.value?.trim() || '';
      const embedImages = $('extractImageToPayload')?.checked;
      const imgTypesVal = rawImgTypes || (embedImages ? 'Image' : '');
      if (imgTypesVal) payload.extract_image_block_types = imgTypesVal;
      if (embedImages) payload.extract_image_block_to_payload = true;
      if (isUnstructured) {
        payload.infer_table_structure = $('inferTables').checked;
      }
      // All providers now output elements only; chunking is done separately
      payload.chunking = 'none';
    } else {
      const azureFeatures = [];
      const azureOutputs = [];
      const pushIf = (el, val) => { if (el && el.checked) azureFeatures.push(val); };
      const pushOutputIf = (el, val) => { if (el && el.checked) azureOutputs.push(val); };
      pushOutputIf($('azureFigureImage'), 'figures');
      pushOutputIf($('azureProcessFigures'), 'process_figures');
      pushIf($('azureBarcodes'), 'barcodes');
      pushIf($('azureLanguage'), 'languages');
      pushIf($('azureKvp'), 'keyValuePairs');
      pushIf($('azureHighRes'), 'ocrHighResolution');
      pushIf($('azureStyleFont'), 'styleFont');
      pushIf($('azureFormulas'), 'formulas');
      payload.features = azureFeatures.join(','); // Azure detection on by default via "languages"
      payload.outputs = azureOutputs.join(',');
      const fmt = document.querySelector('input[name="azureOutputFormat"]:checked');
      payload.output_content_format = fmt ? fmt.value : 'markdown';
      payload.model_id = ($('azureModelId')?.value || '').trim();
      payload.locale = ($('azureLocale')?.value || '').trim();
      payload.string_index_type = ($('azureStringIndexType')?.value || '').trim();
      payload.query_fields = ($('azureQueryFields')?.value || '').trim();
    }
    payload.form_snapshot = {
      pdf: payload.pdf,
      pages: payload.pages,
      tag: tagVal || null,
      primary_language: docLang,
      ocr_languages: payload.ocr_languages,
      languages: payload.languages,
      detect_language_per_element: payload.detect_language_per_element,
      provider: payload.provider,
    };
    if (payload.provider === 'unstructured/local') {
      payload.form_snapshot.strategy = payload.strategy;
      payload.form_snapshot.infer_table_structure = payload.infer_table_structure;
      {
        const rawImgTypes = $('extractImageBlockTypes')?.value?.trim() || '';
        const embedImages = $('extractImageToPayload')?.checked;
        const imgTypesVal = rawImgTypes || (embedImages ? 'Image' : '');
        payload.form_snapshot.extract_image_block_types = imgTypesVal || null;
        payload.form_snapshot.extract_image_block_to_payload = embedImages || null;
      }
    } else if (isPartition) {
      payload.form_snapshot.strategy = payload.strategy;
      payload.form_snapshot.provider = payload.provider;
      {
        const rawImgTypes = $('extractImageBlockTypes')?.value?.trim() || '';
        const embedImages = $('extractImageToPayload')?.checked;
        const imgTypesVal = rawImgTypes || (embedImages ? 'Image' : '');
        payload.form_snapshot.extract_image_block_types = imgTypesVal || null;
        payload.form_snapshot.extract_image_block_to_payload = embedImages || null;
      }
    } else {
      payload.form_snapshot.features = payload.features;
      payload.form_snapshot.outputs = payload.outputs;
      payload.form_snapshot.process_figures = $('azureProcessFigures')?.checked ?? true;
      payload.form_snapshot.output_content_format = payload.output_content_format;
      payload.form_snapshot.model_id = payload.model_id;
      payload.form_snapshot.locale = payload.locale;
      payload.form_snapshot.string_index_type = payload.string_index_type;
      payload.form_snapshot.query_fields = payload.query_fields;
    }
    // Select the correct pipeline stages for this file type
    const selectedFile = $('pdfSelect')?.value || '';
    const selectedFileType = getFileType(selectedFile) || 'pdf';
    if (typeof setActivePipeline === 'function') {
      setActivePipeline(selectedFileType);
    }
    setExtractionInProgress(true, { pdf: payload.pdf });
    let jobId = null;
    try {
      const r = await fetch('/api/extraction', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.detail || `HTTP ${r.status}`);
      jobId = data?.job?.id || null;
      if (!jobId) throw new Error('Server did not return a job id');
      saveExtractionPrefs();
      if (status) status.textContent = 'Queued…';
      const tagInput = $('variantTag');
      if (tagInput) tagInput.value = '';
      await pollExtractionJob(jobId);
    } catch (e) {
      status.textContent = `Failed: ${e.message}`;
    } finally {
      if (!jobId) {
        setExtractionInProgress(false);
      }
    }
  });

  // Reset extraction form to defaults
  const resetExtrBtn = $('resetExtractionDefaults');
  if (resetExtrBtn) {
    resetExtrBtn.addEventListener('click', () => {
      _resetExtractionToDefaults();
      localStorage.removeItem(_EXTRACTION_STORAGE_KEY);
      _updateExtractionModifiedIndicators();
      showToast('Extraction options reset to defaults', 'ok', 2000);
    });
  }

  const cancelBtn = $('cancelExtractionBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      const status = $('extractionStatus');
      if (status) status.textContent = '';
      closeExtractionModal();
    });
  }

  const pdfSel = $('pdfSelect');
  if (pdfSel) {
    pdfSel.addEventListener('change', async () => {
      await loadExtractionPreviewForSelectedPdf();
    });
  }
  const prev = $('extractionPrev');
  const next = $('extractionNext');
  const addPageBtn = $('addPageBtn');
  const markStartBtn = $('markStartBtn');
  const markEndBtn = $('markEndBtn');
  if (prev) prev.addEventListener('click', async () => { if (!EXTRACTION_PREVIEW_DOC) return; EXTRACTION_PREVIEW_PAGE = Math.max(1, EXTRACTION_PREVIEW_PAGE - 1); await renderExtractionPreviewPage(); });
  if (next) next.addEventListener('click', async () => { if (!EXTRACTION_PREVIEW_DOC) return; EXTRACTION_PREVIEW_PAGE = Math.min(EXTRACTION_PREVIEW_COUNT, EXTRACTION_PREVIEW_PAGE + 1); await renderExtractionPreviewPage(); });
  if (addPageBtn) addPageBtn.addEventListener('click', () => { addPageToInput(EXTRACTION_PREVIEW_PAGE); });
  if (markStartBtn) markStartBtn.addEventListener('click', () => { EXTRACTION_RANGE_START = EXTRACTION_PREVIEW_PAGE; updateRangeHint(); });
  if (markEndBtn) markEndBtn.addEventListener('click', () => { if (EXTRACTION_RANGE_START != null) { const a = Math.min(EXTRACTION_RANGE_START, EXTRACTION_PREVIEW_PAGE); const b = Math.max(EXTRACTION_RANGE_START, EXTRACTION_PREVIEW_PAGE); addRangeToInput(a, b); EXTRACTION_RANGE_START = null; updateRangeHint(); } });

  _wireExtractionModifiedIndicators();
}

/**
 * Enable/disable form sections that don't apply to a given file type.
 * Spreadsheets use native openpyxl extraction — Azure settings are
 * irrelevant, but pages input stays enabled for sheet selection.
 */
function updateFormForFileType(fileType) {
  const azureSettings = $('azureSettings');
  if (!azureSettings) return;
  const isSpreadsheet = fileType === 'spreadsheet';

  azureSettings.classList.remove('disabled');
  azureSettings.querySelectorAll('.opt-group').forEach(group => {
    const keep = group.querySelector('#azureProcessFigures');
    group.classList.toggle('disabled', isSpreadsheet && !keep);
  });
}

// Window exports
window.wireExtractionForm = wireExtractionForm;
window.fetchSupportedFormats = fetchSupportedFormats;
window.isSupportedFile = isSupportedFile;
window.getFileType = getFileType;
window.updateFormForFileType = updateFormForFileType;
window.saveExtractionPrefs = saveExtractionPrefs;
window.loadExtractionPrefs = loadExtractionPrefs;
