/**
 * Run form wiring and validation
 * Extracted from app-runs.js for modularity
 */

function wireRunForm() {
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
      if (!file || !file.name || !file.name.toLowerCase().endsWith('.pdf')) {
        setStatus('File must be a .pdf');
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
          await loadRunPreviewForSelectedPdf();
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

  $('runBtn').addEventListener('click', async () => {
    const status = $('runStatus');
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
      payload.form_snapshot.output_content_format = payload.output_content_format;
      payload.form_snapshot.model_id = payload.model_id;
      payload.form_snapshot.locale = payload.locale;
      payload.form_snapshot.string_index_type = payload.string_index_type;
      payload.form_snapshot.query_fields = payload.query_fields;
    }
    setRunInProgress(true, { pdf: payload.pdf });
    let jobId = null;
    try {
      const r = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.detail || `HTTP ${r.status}`);
      jobId = data?.job?.id || null;
      if (!jobId) throw new Error('Server did not return a job id');
      if (status) status.textContent = 'Queued…';
      const tagInput = $('variantTag');
      if (tagInput) tagInput.value = '';
      await pollRunJob(jobId);
    } catch (e) {
      status.textContent = `Failed: ${e.message}`;
    } finally {
      if (!jobId) {
        setRunInProgress(false);
      }
    }
  });

  const cancelBtn = $('cancelRunBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      const status = $('runStatus');
      if (status) status.textContent = '';
      closeRunModal();
    });
  }

  const pdfSel = $('pdfSelect');
  if (pdfSel) {
    pdfSel.addEventListener('change', async () => {
      await loadRunPreviewForSelectedPdf();
    });
  }
  const prev = $('runPrev');
  const next = $('runNext');
  const addPageBtn = $('addPageBtn');
  const markStartBtn = $('markStartBtn');
  const markEndBtn = $('markEndBtn');
  if (prev) prev.addEventListener('click', async () => { if (!RUN_PREVIEW_DOC) return; RUN_PREVIEW_PAGE = Math.max(1, RUN_PREVIEW_PAGE - 1); await renderRunPreviewPage(); });
  if (next) next.addEventListener('click', async () => { if (!RUN_PREVIEW_DOC) return; RUN_PREVIEW_PAGE = Math.min(RUN_PREVIEW_COUNT, RUN_PREVIEW_PAGE + 1); await renderRunPreviewPage(); });
  if (addPageBtn) addPageBtn.addEventListener('click', () => { addPageToInput(RUN_PREVIEW_PAGE); });
  if (markStartBtn) markStartBtn.addEventListener('click', () => { RUN_RANGE_START = RUN_PREVIEW_PAGE; updateRangeHint(); });
  if (markEndBtn) markEndBtn.addEventListener('click', () => { if (RUN_RANGE_START != null) { const a = Math.min(RUN_RANGE_START, RUN_PREVIEW_PAGE); const b = Math.max(RUN_RANGE_START, RUN_PREVIEW_PAGE); addRangeToInput(a, b); RUN_RANGE_START = null; updateRangeHint(); } });
}

// Window exports
window.wireRunForm = wireRunForm;
