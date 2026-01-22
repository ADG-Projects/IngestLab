function updateRunConfigCard() {
  const cfg = CURRENT_RUN_CONFIG || CURRENT_RUN?.run_config;

  // Helper to check if a value should be hidden
  const shouldHide = (value) => {
    if (value === undefined || value === null) return true;
    if (value === '-') return true;
    if (value === 'n/a') return true;
    if (typeof value === 'string' && !value.trim()) return true;
    return false;
  };

  // Helper to get first non-empty value
  const preferValues = (...values) => {
    for (const val of values) {
      if (!shouldHide(val)) return val;
    }
    return null;
  };

  // Get banner containers
  const topRow = $('settingsBannerTop');
  const bottomRow = $('settingsBannerBottom');

  if (!topRow || !bottomRow) return;

  // Clear existing content (except pin button)
  topRow.innerHTML = '';

  // Clear bottom row but preserve pin button by removing it first
  const pinBtn = $('bannerPinBtn');
  const pinBtnParent = pinBtn ? pinBtn.parentNode : null;
  if (pinBtn && pinBtnParent) {
    pinBtnParent.removeChild(pinBtn);
  }
  bottomRow.innerHTML = '';
  if (pinBtn) {
    bottomRow.appendChild(pinBtn);
  }

  // If no config, show placeholder
  if (!cfg) {
    topRow.textContent = 'No run selected';
    CURRENT_DOC_LANGUAGE = 'eng';
    applyLanguageDirection();
    setupBannerInteractions();
    return;
  }

  const chunkParams = cfg.chunk_params || {};
  const snap = cfg.form_snapshot || cfg.ui_form || {};
  const provider = preferValues(cfg.provider, snap.provider, 'unstructured/local');
  const isAzure = provider && provider.includes('azure');
  const isUnstructured = provider && provider.includes('unstructured');

  // Build parameter list
  const topRowParams = [];
  const bottomRowParams = [];

  // Provider (always show)
  let providerDisplay = provider;
  if (provider === 'azure/document_intelligence') {
    providerDisplay = 'Azure Document Intelligence';
  } else if (provider === 'unstructured/local') {
    providerDisplay = 'Unstructured (Local) — Deprecated';
  } else if (provider === 'unstructured/partition') {
    providerDisplay = 'Unstructured Partition (API) — Deprecated';
  }
  topRowParams.push({ label: null, value: providerDisplay });

  // PDF (always show if available)
  const pdf = preferValues(snap.pdf, cfg.pdf);
  if (pdf) topRowParams.push({ label: 'PDF', value: pdf });

  // Pages (always show if available)
  const pages = preferValues(snap.pages, cfg.pages);
  if (pages) topRowParams.push({ label: 'Pages', value: pages });

  // Provider-specific top row params
  if (isAzure) {
    const model = preferValues(cfg.model_id, snap.model_id);
    if (model && model !== 'prebuilt-layout') {
      topRowParams.push({ label: 'Model', value: model });
    }
  } else if (isUnstructured) {
    const strategy = preferValues(cfg.strategy, snap.strategy);
    if (strategy && strategy !== 'auto') {
      topRowParams.push({ label: 'Strategy', value: strategy });
    }
  }

  // Bottom row: secondary params
  if (isAzure) {
    const featuresRaw = preferValues(cfg.features, snap.features);
    if (featuresRaw) {
      const featuresDisplay = Array.isArray(featuresRaw) ? featuresRaw.join(', ') : featuresRaw;
      if (featuresDisplay) bottomRowParams.push({ label: 'Features', value: featuresDisplay });
    }
  } else if (isUnstructured) {
    const inferTables = cfg.infer_table_structure !== false;
    if (!inferTables) {
      bottomRowParams.push({ label: 'Infer Tables', value: 'false' });
    }

    // Chunking params (if present)
    const maxChars = preferValues(
      chunkParams.max_characters,
      chunkParams.chunk_max_characters,
      snap.chunk_max_characters,
      snap.max_characters
    );
    if (maxChars) bottomRowParams.push({ label: 'Max chars', value: maxChars });

    const overlap = preferValues(
      chunkParams.overlap,
      chunkParams.chunk_overlap,
      snap.chunk_overlap,
      snap.overlap
    );
    if (overlap) bottomRowParams.push({ label: 'Overlap', value: overlap });
  }

  // Tag (always show in bottom row if present)
  const tag = preferValues(snap.tag, snap.variant_tag, cfg.tag, cfg.variant_tag);
  if (tag) bottomRowParams.push({ label: 'Tag', value: tag });

  // Language selector (always in bottom row)
  const lang = resolvePrimaryLanguage(cfg.run_config ?? cfg, snap);
  CURRENT_DOC_LANGUAGE = lang;

  // Render top row
  topRowParams.forEach((param, idx) => {
    if (idx > 0) {
      const sep = document.createElement('span');
      sep.className = 'banner-param-sep';
      sep.textContent = '·';
      topRow.appendChild(sep);
    }
    const paramEl = document.createElement('span');
    paramEl.className = 'banner-param';
    if (param.label) {
      const label = document.createElement('span');
      label.className = 'banner-param-label';
      label.textContent = param.label + ':';
      paramEl.appendChild(label);
    }
    const value = document.createElement('span');
    value.className = 'banner-param-value';
    value.textContent = param.value;
    value.title = param.label ? `${param.label}: ${param.value}` : param.value;
    paramEl.appendChild(value);
    topRow.appendChild(paramEl);
  });

  // Render bottom row (before pin button)
  bottomRowParams.forEach((param, idx) => {
    if (idx > 0) {
      const sep = document.createElement('span');
      sep.className = 'banner-param-sep';
      sep.textContent = '·';
      bottomRow.insertBefore(sep, pinBtn);
    }
    const paramEl = document.createElement('span');
    paramEl.className = 'banner-param';
    const label = document.createElement('span');
    label.className = 'banner-param-label';
    label.textContent = param.label + ':';
    paramEl.appendChild(label);
    const value = document.createElement('span');
    value.className = 'banner-param-value';
    value.textContent = param.value;
    value.title = `${param.label}: ${param.value}`;
    paramEl.appendChild(value);
    bottomRow.insertBefore(paramEl, pinBtn);
  });

  // Add language selector to bottom row
  if (bottomRowParams.length > 0) {
    const sep = document.createElement('span');
    sep.className = 'banner-param-sep';
    sep.textContent = '·';
    bottomRow.insertBefore(sep, pinBtn);
  }

  const langParam = document.createElement('span');
  langParam.className = 'banner-param';
  const langLabel = document.createElement('span');
  langLabel.className = 'banner-param-label';
  langLabel.textContent = 'Lang:';
  langParam.appendChild(langLabel);

  const langSelect = document.createElement('select');
  langSelect.id = 'settingPrimaryLang';
  langSelect.className = 'banner-lang-select';
  langSelect.setAttribute('aria-label', 'Primary document language');

  const engOption = document.createElement('option');
  engOption.value = 'eng';
  engOption.textContent = 'English (LTR)';
  langSelect.appendChild(engOption);

  const araOption = document.createElement('option');
  araOption.value = 'ara';
  araOption.textContent = 'Arabic (RTL)';
  langSelect.appendChild(araOption);

  langSelect.value = normalizeLangCode(lang) || 'eng';

  // Add change event listener
  langSelect.addEventListener('change', () => {
    const nextLang = normalizeLangCode(langSelect.value) || 'eng';
    if (CURRENT_DOC_LANGUAGE === nextLang) return;
    CURRENT_DOC_LANGUAGE = nextLang;
    applyLanguageDirection();
  });

  langParam.appendChild(langSelect);
  bottomRow.insertBefore(langParam, pinBtn);

  applyLanguageDirection();
  setupBannerInteractions();
}

function setupBannerInteractions() {
  const banner = $('settingsBanner');
  const bottomRow = $('settingsBannerBottom');
  const pinBtn = $('bannerPinBtn');

  if (!banner || !bottomRow || !pinBtn) return;

  // Apply pinned state
  if (SETTINGS_BANNER_PINNED) {
    banner.classList.add('pinned');
  } else {
    banner.classList.remove('pinned');
  }

  // Pin button click handler (using onclick to avoid duplicates)
  pinBtn.onclick = () => {
    SETTINGS_BANNER_PINNED = !SETTINGS_BANNER_PINNED;
    localStorage.setItem('settings_banner_pinned', String(SETTINGS_BANNER_PINNED));
    if (SETTINGS_BANNER_PINNED) {
      banner.classList.add('pinned');
      bottomRow.classList.remove('hidden');
      if (SETTINGS_BANNER_TIMER) {
        clearTimeout(SETTINGS_BANNER_TIMER);
        SETTINGS_BANNER_TIMER = null;
      }
    } else {
      banner.classList.remove('pinned');
      setupAutoHide();
    }
  };

  // Auto-hide setup
  if (!SETTINGS_BANNER_PINNED) {
    setupAutoHide();
  }

  // Hover handlers (using onmouseenter/onmouseleave to avoid duplicates)
  banner.onmouseenter = () => {
    if (SETTINGS_BANNER_TIMER) {
      clearTimeout(SETTINGS_BANNER_TIMER);
      SETTINGS_BANNER_TIMER = null;
    }
    bottomRow.classList.remove('hidden');
  };

  banner.onmouseleave = () => {
    if (!SETTINGS_BANNER_PINNED) {
      setupAutoHide();
    }
  };
}

function setupAutoHide() {
  const bottomRow = $('settingsBannerBottom');
  if (!bottomRow) return;

  if (SETTINGS_BANNER_TIMER) {
    clearTimeout(SETTINGS_BANNER_TIMER);
  }

  SETTINGS_BANNER_TIMER = setTimeout(() => {
    bottomRow.classList.add('hidden');
  }, 3000);
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
