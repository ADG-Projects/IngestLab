function setLanguageControl(langCode) {
  const select = $('settingPrimaryLang');
  if (!select) return;
  const normalized = normalizeLangCode(langCode) || 'eng';
  select.value = normalized;
}

function updateRunConfigCard() {
  const cfg = CURRENT_RUN_CONFIG || CURRENT_RUN?.run_config;
  const ensureDisplay = (value) => {
    if (value === undefined || value === null) return '-';
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed ? trimmed : '-';
    }
    return value;
  };
  const preferValues = (...values) => {
    for (const val of values) {
      if (val === undefined || val === null) continue;
      if (typeof val === 'string' && !val.trim()) continue;
      return val;
    }
    return null;
  };
  const set = (id, value) => {
    const el = $(id);
    if (el) el.textContent = ensureDisplay(value);
  };
  const toggle = (id, show) => {
    const el = $(id);
    if (el) el.classList.toggle('hidden', !show);
  };
  if (!cfg) {
    ['Provider','Model','Features','Strategy','InferTables','Chunking','MaxTokens','MaxChars','NewAfter','CombineUnder','Overlap','IncludeOrig','OverlapAll','Multipage','Pdf','Pages','Tag']
      .forEach(name => set(`setting${name}`, '-'));
    setLanguageControl('eng');
    CURRENT_DOC_LANGUAGE = 'eng';
    applyLanguageDirection();
    return;
  }
  const chunkParams = cfg.chunk_params || {};
  const snap = cfg.form_snapshot || cfg.ui_form || {};
  const provider = preferValues(cfg.provider, snap.provider, 'unstructured');
  set('settingProvider', provider);
  const featuresRaw = preferValues(cfg.features, snap.features);
  const featuresDisplay = Array.isArray(featuresRaw) ? featuresRaw.join(', ') : featuresRaw;
  const isAzure = provider && provider.startsWith('azure');
  toggle('settingModelItem', !!isAzure);
  if (isAzure) {
    set('settingModel', preferValues(cfg.model_id, snap.model_id, provider === 'azure-cu' ? 'prebuilt-documentSearch' : 'prebuilt-layout'));
  } else {
    set('settingModel', null);
  }
  set('settingFeatures', featuresDisplay);
  if (provider === 'unstructured') {
    set('settingStrategy', cfg.strategy || 'auto');
    set('settingInferTables', String(cfg.infer_table_structure !== false));
    set('settingChunking', cfg.chunking || 'by_title');
    const maxCharsRaw = preferValues(
      chunkParams.max_characters,
      chunkParams.chunk_max_characters,
      snap.chunk_max_characters,
      snap.max_characters
    );
    const mtSource = preferValues(
      snap.max_tokens,
      snap.chunk_max_tokens,
      chunkParams.max_tokens
    );
    const inferredTokens =
      mtSource == null && maxCharsRaw != null && Number.isFinite(Number(maxCharsRaw))
        ? Math.round(Number(maxCharsRaw) / 4)
        : null;
    const tokensDisplay = preferValues(mtSource, inferredTokens);
    set('settingMaxTokens', tokensDisplay ?? '-');
    set('settingMaxChars', maxCharsRaw ?? '-');
    set('settingNewAfter', preferValues(
      chunkParams.new_after_n_chars,
      chunkParams.chunk_new_after_n_chars,
      snap.chunk_new_after_n_chars,
      snap.new_after_n_chars
    ) ?? '-');
    set('settingCombineUnder', preferValues(
      chunkParams.combine_text_under_n_chars,
      chunkParams.chunk_combine_under_n_chars,
      snap.chunk_combine_under_n_chars,
      snap.combine_under_n_chars
    ) ?? '-');
    set('settingOverlap', preferValues(
      chunkParams.overlap,
      chunkParams.chunk_overlap,
      snap.chunk_overlap,
      snap.overlap
    ) ?? '-');
    set('settingIncludeOrig', preferValues(
      chunkParams.include_orig_elements,
      chunkParams.chunk_include_orig_elements,
      snap.chunk_include_orig_elements,
      snap.include_orig_elements
    ) ?? '-');
    set('settingOverlapAll', preferValues(
      chunkParams.overlap_all,
      chunkParams.chunk_overlap_all,
      snap.chunk_overlap_all,
      snap.overlap_all
    ) ?? '-');
    set('settingMultipage', preferValues(
      chunkParams.multipage_sections,
      chunkParams.chunk_multipage_sections,
      snap.chunk_multipage_sections,
      snap.multipage_sections,
      snap.chunk_multipage
    ) ?? '-');
  } else {
    ['Strategy','InferTables','Chunking','MaxTokens','MaxChars','NewAfter','CombineUnder','Overlap','IncludeOrig','OverlapAll','Multipage']
      .forEach(name => set(`setting${name}`, 'n/a'));
  }
  set('settingPdf', preferValues(snap.pdf, cfg.pdf) ?? '-');
  set('settingPages', preferValues(snap.pages, cfg.pages) ?? '-');
  set('settingTag', preferValues(snap.tag, snap.variant_tag, cfg.tag, cfg.variant_tag) ?? '-');
  const lang = resolvePrimaryLanguage(cfg.run_config ?? cfg, snap);
  setLanguageControl(lang);
  CURRENT_DOC_LANGUAGE = lang;
  applyLanguageDirection();
}

async function loadElementPreview(elementId) {
  try {
    const payload = await fetchJSON(withProvider(`/api/element/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(elementId)}`));
    return payload;
  } catch (e) {
    showToast(`Failed to load element preview: ${e.message}`, 'err');
    return null;
  }
}
