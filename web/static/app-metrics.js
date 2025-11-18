function setMetric(idBase, value) {
  const pct = Math.round((value || 0) * 100);
  $(idBase).style.width = `${pct}%`;
  $(`${idBase}v`).textContent = `${(value || 0).toFixed(3)} (${pct}%)`;
}

function renderMetrics(overall) {
  setMetric('mcov', overall.avg_coverage);
  setMetric('mcoh', overall.avg_cohesion);
  setMetric('mf1', overall.avg_chunker_f1);
  setMetric('mmicro', overall.micro_coverage);
}

function setLanguageControl(langCode) {
  const select = $('settingPrimaryLang');
  if (!select) return;
  const normalized = normalizeLangCode(langCode) || 'eng';
  select.value = normalized;
}

function buildChart(matches) {
  LAST_CHART_MATCHES = matches || [];
  const canvas = document.getElementById('chart');
  if (!canvas) return;
  if (!window.Chart) {
    const ready = window.__chartReady;
    if (ready && typeof ready.then === 'function' && !ready.__chunkVizChartHooked) {
      ready.__chunkVizChartHooked = true;
      ready.then(() => {
        if (window.Chart) buildChart(LAST_CHART_MATCHES);
      }).catch(() => {});
    }
    return;
  }
  const labels = LAST_CHART_MATCHES.map(m => m.gold_title || m.gold_table_id);
  const data = LAST_CHART_MATCHES.map(m => Number(m.chunker_f1 || 0));
  if (CHART_INSTANCE) {
    try { CHART_INSTANCE.destroy(); } catch (e) {}
    CHART_INSTANCE = null;
  }
  CHART_INSTANCE = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Chunker F1', data, backgroundColor: '#6bbcff' }]},
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 1 } } }
  });
}

function renderMatchList(matches) {
  const list = $('matchList');
  list.innerHTML = '';
  for (const m of matches) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <div class="top">
        <div>
          <div class="title">${m.gold_title || m.gold_table_id}</div>
          <div class="meta">Pages: ${m.gold_pages?.join(', ') ?? '-'}</div>
        </div>
        <div class="actions">
          <button class="btn" data-act="highlight-all" title="Overlay all selected chunks">Highlight all</button>
          <button class="btn" data-act="highlight-best" title="Overlay only the best chunk">Highlight best</button>
          <button class="btn" data-act="details">Details</button>
        </div>
      </div>
      <div class="row" style="margin-top:8px">
        <span class="chip">cov ${(m.coverage||0).toFixed(2)}</span>
        <span class="chip">coh ${(m.cohesion||0).toFixed(2)}</span>
        <span class="chip ${m.selected_chunk_count>1 ? 'bad':''}">chunks ${m.selected_chunk_count}</span>
        <span class="chip">f1 ${(m.chunker_f1||0).toFixed(2)}</span>
      </div>
    `;
    div.querySelector('[data-act="highlight-all"]').addEventListener('click', () => {
      highlightForTable(m, false);
    });
    div.querySelector('[data-act="highlight-best"]').addEventListener('click', () => {
      highlightForTable(m, true);
    });
    div.querySelector('[data-act="details"]').addEventListener('click', () => {
      openDetails(m);
    });
    list.appendChild(div);
  }
}

function filteredMatches() {
  const arr = (MATCHES?.matches || []);
  if (SHOW_UNMATCHED) return arr;
  return arr.filter(m => (m.selected_elements && m.selected_elements.length > 0) || (m.selected_chunk_count > 0));
}

function computeMetrics(ms) {
  const n = ms.length;
  const zero = { avg_coverage: 0, avg_cohesion: 0, avg_chunker_f1: 0, micro_coverage: 0 };
  if (!n) return zero;
  const avg_cov = ms.reduce((s,m)=>s+Number(m.coverage ?? m.coverage_ratio ?? 0),0)/n;
  const avg_coh = ms.reduce((s,m)=>s+Number(m.cohesion||0),0)/n;
  const avg_f1 = ms.reduce((s,m)=>s+Number(m.chunker_f1||0),0)/n;
  const total_gold = ms.reduce((s,m)=>s+Number(m.gold_left_size||0),0);
  const total_cov = ms.reduce((s,m)=>s+Number(m.covered_count||0),0);
  const micro_cov = total_gold ? (total_cov/total_gold) : avg_cov;
  return { avg_coverage: avg_cov, avg_cohesion: avg_coh, avg_chunker_f1: avg_f1, micro_coverage: micro_cov };
}

function refreshMatchesView() {
  const ms = filteredMatches();
  renderMetrics(computeMetrics(ms));
  renderMatchList(ms);
  buildChart(ms);
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
  if (!cfg) {
    ['Strategy','InferTables','Chunking','MaxTokens','MaxChars','NewAfter','CombineUnder','Overlap','IncludeOrig','OverlapAll','Multipage','Pdf','Pages','Tag']
      .forEach(name => set(`setting${name}`, '-'));
    setLanguageControl('eng');
    CURRENT_DOC_LANGUAGE = 'eng';
    applyLanguageDirection();
    return;
  }
  const chunkParams = cfg.chunk_params || {};
  const snap = cfg.form_snapshot || cfg.ui_form || {};
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
  set('settingPdf', preferValues(snap.pdf, cfg.pdf) ?? '-');
  set('settingPages', preferValues(snap.pages, cfg.pages) ?? '-');
  set('settingTag', preferValues(snap.tag, snap.variant_tag, cfg.tag, cfg.variant_tag) ?? '-');
  const lang = resolvePrimaryLanguage(cfg.run_config ?? cfg, snap);
  setLanguageControl(lang);
  CURRENT_DOC_LANGUAGE = lang;
  applyLanguageDirection();
}

async function openDetails(tableMatch) {
  resetDrawerScrollState();
  $('drawerTitle').textContent = tableMatch.gold_title || tableMatch.gold_table_id || 'Details';
  $('drawerMeta').textContent = `Rows ${tableMatch.gold_rows?.join(', ') || '-'}`;
  $('drawerSummary').innerHTML = `
    <span class="chip">cov ${(tableMatch.coverage||0).toFixed(2)}</span>
    <span class="chip">coh ${(tableMatch.cohesion||0).toFixed(2)}</span>
    <span class="chip ${tableMatch.selected_chunk_count>1? 'bad': ''}">chunks ${tableMatch.selected_chunk_count}</span>
    <span class="chip">f1 ${(tableMatch.chunker_f1||0).toFixed(2)}</span>
  `;
  const preview = $('preview');
  preview.innerHTML = '';
  preview.appendChild(buildDrawerReviewSection('table', tableMatch.gold_table_id));
  const tableSection = document.createElement('div');
  tableSection.className = 'table-preview';
  if (tableMatch.table_html) {
    tableSection.innerHTML = tableMatch.table_html;
    applyTablePreviewDirection(tableSection);
  } else {
    tableSection.textContent = 'No preview available';
  }
  preview.appendChild(tableSection);
  $('drawer').classList.remove('hidden');
  document.body.classList.add('drawer-open');
}

async function loadElementPreview(elementId) {
  try {
    const payload = await fetchJSON(`/api/element/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(elementId)}`);
    return payload;
  } catch (e) {
    showToast(`Failed to load element preview: ${e.message}`, 'err');
    return null;
  }
}
