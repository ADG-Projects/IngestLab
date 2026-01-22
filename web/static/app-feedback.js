function formatNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  if (n >= 1000) return `${Math.round(n).toLocaleString()}`;
  return String(Math.round(n));
}

function formatDate(value) {
  if (!value) return '-';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString();
  } catch (e) {
    return '-';
  }
}

function formatScore(score, confidence) {
  if (score === null || score === undefined) return '-';
  return confidence ? `${score} (${confidence})` : String(score);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function feedbackProviderParam(provider) {
  if (!provider || provider === 'all') return '';
  if (provider === 'compare') return '';
  return `?provider=${encodeURIComponent(provider)}`;
}

function renderFeedbackCards(data) {
  const overall = data?.aggregate?.overall || { good: 0, bad: 0, total: 0 };
  const providers = data?.aggregate?.providers || {};
  const noteCount = (data?.runs || []).reduce((acc, run) => acc + (run.note_count || 0), 0);
  const latest = [...(data?.runs || [])].sort((a, b) => (b.last_updated || '').localeCompare(a.last_updated || ''))[0];
  $('feedbackOverallGood').textContent = formatNumber(overall.good);
  $('feedbackOverallBad').textContent = formatNumber(overall.bad);
  $('feedbackOverallTotal').textContent = formatNumber(overall.total);
  $('feedbackOverallScoreValue').textContent = formatScore(overall.score, overall.confidence);
  $('feedbackNoteCount').textContent = `${formatNumber(noteCount)} notes`;
  $('feedbackLatestRun').textContent = latest ? `${latest.slug} (${latest.provider})` : '-';
  $('feedbackLatestUpdated').textContent = latest ? formatDate(latest.last_updated) : '-';
  const breakdown = Object.entries(providers)
    .map(([prov, stats]) => `${prov}: ${formatNumber(stats.good)} / ${formatNumber(stats.bad)} (${formatNumber(stats.total)})`)
    .join(' · ');
  $('feedbackProviderBreakdown').textContent = breakdown || '-';
  const scores = Object.entries(providers)
    .map(([prov, stats]) => `${prov}: ${formatScore(stats.score, stats.confidence)}`)
    .join(' · ');
  $('feedbackProviderScoresValue').textContent = scores || '-';
}

function renderFeedbackChart(data) {
  const ctx = document.getElementById('feedbackChart');
  if (!ctx) return;
  const providers = data?.aggregate?.providers || {};
  const labels = Object.keys(providers);
  const goods = labels.map((k) => providers[k].good || 0);
  const bads = labels.map((k) => providers[k].bad || 0);
  if (FEEDBACK_CHART) {
    FEEDBACK_CHART.destroy();
  }
  if (!labels.length || typeof Chart === 'undefined') {
    $('feedbackChartHint').textContent = labels.length ? 'Chart unavailable' : 'No feedback yet';
    return;
  }
  $('feedbackChartHint').textContent = '';
  FEEDBACK_CHART = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Good', data: goods, backgroundColor: '#19d18e' },
        { label: 'Bad', data: bads, backgroundColor: '#ff6b6b' },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom', labels: { color: '#e9eef3' } } },
      scales: {
        x: { ticks: { color: '#e9eef3' }, grid: { color: '#22262d' } },
        y: { ticks: { color: '#e9eef3' }, grid: { color: '#22262d' }, beginAtZero: true },
      },
    },
  });
}

function renderFeedbackScoreChart(data) {
  const ctx = document.getElementById('feedbackScoreChart');
  if (!ctx) return;
  const providers = data?.aggregate?.providers || {};
  const entries = Object.entries(providers).filter(([, stats]) => stats && stats.score !== null && stats.score !== undefined);
  const labels = entries.map(([prov]) => prov);
  const scores = entries.map(([, stats]) => Math.max(0, Math.min(100, Number(stats.score) || 0)));
  const confidences = entries.map(([, stats]) => stats.confidence || '-');
  const totals = entries.map(([, stats]) => stats.total || 0);
  if (FEEDBACK_SCORE_CHART) {
    FEEDBACK_SCORE_CHART.destroy();
  }
  if (!labels.length || typeof Chart === 'undefined') {
    $('feedbackScoreChartHint').textContent = labels.length ? 'Chart unavailable' : 'No scores yet';
    return;
  }
  $('feedbackScoreChartHint').textContent = '';
  FEEDBACK_SCORE_CHART = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Score',
          data: scores,
          backgroundColor: '#4dabf7',
        },
      ],
    },
    options: {
      responsive: true,
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => {
              const i = context.dataIndex;
              return `Score ${context.raw} (${confidences[i]} confidence, ${totals[i]} feedbacks)`;
            },
          },
        },
      },
      scales: {
        x: { min: 0, max: 100, ticks: { color: '#e9eef3' }, grid: { color: '#22262d' } },
        y: { ticks: { color: '#e9eef3' }, grid: { color: '#22262d' } },
      },
    },
  });
}

function renderFeedbackRuns(runs, query = '') {
  const host = $('feedbackRuns');
  if (!host) return;
  const q = (query || '').toLowerCase();
  host.innerHTML = '';
  const filtered = (runs || []).filter((r) => {
    if (!q) return true;
    return (
      (r.slug || '').toLowerCase().includes(q) ||
      (r.pdf || '').toLowerCase().includes(q) ||
      (r.pdf_file || '').toLowerCase().includes(q)
    );
  });
  if (!filtered.length) {
    host.innerHTML = '<div class="muted">No feedback found.</div>';
    return;
  }
  filtered.forEach((run) => {
    const item = document.createElement('div');
    item.className = 'feedback-run';
    const summary = run.summary || { overall: { good: 0, bad: 0, total: 0 } };
    const items = Array.isArray(run.items) ? run.items : [];
    const notes = items.filter((n) => n && n.note).slice(0, 3);
    item.innerHTML = `
      <div class="slug">${run.slug}</div>
      <div class="meta">
        <span class="pill">${run.provider}</span>
        ${run.pages ? `<span class="pill">pages ${run.pages}</span>` : ''}
        ${run.tag ? `<span class="pill">tag: ${run.tag}</span>` : ''}
        ${run.pdf ? `<span class="pill">pdf: ${run.pdf}</span>` : ''}
      </div>
      <div class="counts">
        <span class="stat-good">Good ${formatNumber(summary.overall.good)}</span>
        <span class="stat-bad">Bad ${formatNumber(summary.overall.bad)}</span>
        <span class="pill">${formatNumber(run.note_count || 0)} notes</span>
        <span class="pill">${formatDate(run.last_updated)}</span>
      </div>
      <div class="notes">
        ${notes.map((n) => `<div class="note"><strong>${n.kind || ''} ${n.rating || ''}</strong> — ${(n.note || '').slice(0, 280)}</div>`).join('')}
        ${notes.length === 0 ? '<div class="muted">No notes yet.</div>' : ''}
      </div>
      <div class="actions">
        <button class="btn btn-secondary feedback-inspect-btn" data-slug="${run.slug}" data-provider="${run.provider}">Inspect</button>
      </div>
    `;
    host.appendChild(item);
  });
}

async function refreshFeedbackIndex(provider = FEEDBACK_PROVIDER_FILTER) {
  FEEDBACK_PROVIDER_FILTER = provider || 'all';
  const status = $('feedbackStatus');
  if (status) status.textContent = 'Loading…';
  try {
    const params = feedbackProviderParam(FEEDBACK_PROVIDER_FILTER);
    const data = await fetchJSON(`/api/feedback/export${params}${params ? '&' : '?'}include_items=true`);
    FEEDBACK_INDEX = data;
    renderFeedbackCards(data);
    renderFeedbackChart(data);
    renderFeedbackScoreChart(data);
    renderFeedbackRuns(data.runs || [], $('feedbackSearch')?.value || '');
    if (status) status.textContent = '';
  } catch (e) {
    if (status) status.textContent = `Load failed: ${e.message}`;
  }
}

function renderFeedbackAnalysis(data) {
  const el = $('feedbackAnalysis');
  if (!el) return;
  const parseMaybeJson = (val) => {
    if (typeof val !== 'string') return val;
    try {
      return JSON.parse(val);
    } catch (_) {
      return val;
    }
  };
  const normalize = (val) => {
    const parsed = parseMaybeJson(val);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out = {};
      for (const [k, v] of Object.entries(parsed)) {
        out[k] = parseMaybeJson(v);
      }
      return out;
    }
    return parsed;
  };
  let payload = data?.comparison ?? data?.summary ?? data;
  payload = normalize(payload);
  el.textContent =
    typeof payload === 'string' ? payload : JSON.stringify(payload || 'No analysis yet.', null, 2);
}

async function analyzeFeedbackSelection() {
  const target = $('feedbackProviderSelect')?.value || 'all';
  const status = $('feedbackStatus');
  if (status) status.textContent = 'Sending to LLM…';
  try {
    let res;
    if (target === 'compare' || target === 'all') {
      res = await fetch('/api/feedback/analyze/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: ['unstructured/local', 'unstructured/partition', 'azure/document_intelligence'] }),
      });
    } else {
      res = await fetch('/api/feedback/analyze/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: target }),
      });
    }
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `HTTP ${res.status}`);
    }
    const data = await res.json();
    FEEDBACK_ANALYSIS = data;
    renderFeedbackAnalysis(data);
    if (status) status.textContent = 'LLM response ready.';
  } catch (e) {
    if (status) status.textContent = `LLM error: ${e.message}`;
  }
}

function downloadBlob(data, filename, type = 'application/json') {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildFeedbackExportPayload() {
  const base = FEEDBACK_INDEX || { runs: [] };
  const scope = FEEDBACK_PROVIDER_FILTER || 'all';
  const analysis = FEEDBACK_ANALYSIS
    ? {
        scope,
        generated_at: new Date().toISOString(),
        payload: FEEDBACK_ANALYSIS,
      }
    : null;
  return { ...base, llm_analysis: analysis };
}

function downloadFeedbackJson() {
  const data = buildFeedbackExportPayload();
  downloadBlob(JSON.stringify(data, null, 2), 'feedback.json');
}

function formatAnalysisHtml(analysis) {
  if (!analysis) {
    return '<div class="muted">No LLM analysis yet. Click “Send to LLM” before exporting.</div>';
  }
  const pretty = escapeHtml(JSON.stringify(analysis, null, 2));
  return `<pre class="analysis-block">${pretty}</pre>`;
}

function chartToDataUrl(chart) {
  try {
    if (chart?.toBase64Image) return chart.toBase64Image('image/png', 1);
    const canvas = chart?.canvas || chart?.ctx?.canvas;
    if (canvas?.toDataURL) return canvas.toDataURL('image/png');
  } catch (e) {}
  return null;
}

function downloadFeedbackHtml() {
  const data = FEEDBACK_INDEX || { runs: [] };
  const overall = data.aggregate?.overall || { good: 0, bad: 0, total: 0 };
  const providers = data.aggregate?.providers || {};
  const overallScore = formatScore(overall.score, overall.confidence);
  const providerLine = Object.entries(providers)
    .map(([k, v]) => `${k}: ${v.good}/${v.bad} (${v.total}) · score ${formatScore(v.score, v.confidence)}`)
    .join(' · ');
  const scoreNote = 'Scores use smoothed good rate: (good+3)/(good+bad+6) scaled to 0-100. Confidence is based on feedback volume.';
  const latest = [...(data.runs || [])].sort((a, b) => (b.last_updated || '').localeCompare(a.last_updated || ''))[0];
  const noteCount = (data.notes && Array.isArray(data.notes) ? data.notes.length : (data.runs || []).reduce((acc, run) => {
    const items = Array.isArray(run.items) ? run.items : [];
    return acc + items.filter((n) => n && n.note).length;
  }, 0)) || 0;
  const scopeMap = {
    all: 'All providers',
    'unstructured/local': 'Unstructured (Local) — Deprecated',
    'unstructured/partition': 'Unstructured Partition (API) — Deprecated',
    'azure/document_intelligence': 'Azure Document Intelligence',
    compare: 'All providers (compare)',
  };
  const scopeLabel = scopeMap[FEEDBACK_PROVIDER_FILTER || 'all'] || 'All providers';
  const chartImage = chartToDataUrl(FEEDBACK_CHART);
  const scoreChartImage = chartToDataUrl(FEEDBACK_SCORE_CHART);
  const analysisHtml = formatAnalysisHtml(FEEDBACK_ANALYSIS);
  const runCards =
    (data.runs || [])
      .map((run) => {
        const summary = run.summary?.overall || { good: 0, bad: 0, total: 0 };
        const notes = (run.items || []).filter((n) => n && n.note).slice(0, 4);
        const pills = [
          run.provider ? `<span class="pill">${escapeHtml(run.provider)}</span>` : '',
          run.pages ? `<span class="pill">pages ${escapeHtml(run.pages)}</span>` : '',
          run.tag ? `<span class="pill">tag ${escapeHtml(run.tag)}</span>` : '',
          run.pdf ? `<span class="pill">pdf ${escapeHtml(run.pdf)}</span>` : '',
        ]
          .filter(Boolean)
          .join('');
        const noteHtml =
          notes.length > 0
            ? notes
                .map(
                  (n) =>
                    `<div class="note"><strong>${escapeHtml(n.kind || '')} ${escapeHtml(n.rating || '')}</strong> — ${escapeHtml(n.note || '')}</div>`,
                )
                .join('')
            : '<div class="muted">No notes yet.</div>';
        return `
          <div class="run-card">
            <div class="run-head">
              <div class="slug">${escapeHtml(run.slug || '')}</div>
              <div class="run-meta">${pills}</div>
            </div>
            <div class="run-counts">
              <span class="stat-good">Good ${formatNumber(summary.good)}</span>
              <span class="stat-bad">Bad ${formatNumber(summary.bad)}</span>
              <span class="pill">${formatNumber(run.note_count || 0)} notes</span>
              <span class="pill">${formatDate(run.last_updated)}</span>
            </div>
            <div class="run-sub">${escapeHtml(run.pdf_file || '')}</div>
            <div class="notes-block">${noteHtml}</div>
          </div>
        `;
      })
      .join('') || '<div class="muted">No runs with feedback yet.</div>';
  const styles = `
    :root {
      --bg: #0e0f12;
      --panel: #16181d;
      --text: #e9eef3;
      --muted: #aab3bd;
      --border: #22262d;
      --pill: #2a2f38;
      --ok: #19d18e;
      --danger: #ff6b6b;
      --accent: #6bbcff;
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; background: var(--bg); color: var(--text); font-family: 'Segoe UI', -apple-system, system-ui, sans-serif; }
    .container { max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
    .page-title { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .eyebrow { color: var(--muted); letter-spacing: 0.06em; font-size: 12px; text-transform: uppercase; }
    h1 { margin: 6px 0; font-size: 26px; }
    .muted { color: var(--muted); }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
    .grid { display: grid; gap: 12px; }
    .grid.stats { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .stat-label { font-size: 12px; color: var(--muted); letter-spacing: 0.04em; text-transform: uppercase; }
    .stat-value { font-size: 22px; display: flex; align-items: baseline; gap: 6px; }
    .stat-sub { color: var(--muted); font-size: 13px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .stat-good { color: var(--ok); }
    .stat-bad { color: var(--danger); }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--pill); color: var(--muted); font-size: 12px; }
    .charts { display: flex; flex-direction: column; gap: 12px; }
    .chart-card { display: flex; flex-direction: column; gap: 8px; width: 100%; }
    .chart-card img { width: 100%; border-radius: 8px; border: 1px solid var(--border); background: #0f1014; }
    .chart-fallback { color: var(--muted); font-style: italic; }
    .runs-card { display: flex; flex-direction: column; gap: 10px; }
    .run-card { border: 1px solid var(--border); border-radius: 10px; padding: 10px; background: #1b1d23; display: flex; flex-direction: column; gap: 6px; }
    .run-head { display: flex; flex-direction: column; gap: 6px; }
    .run-head .slug { font-weight: 700; font-size: 15px; }
    .run-meta { display: flex; gap: 8px; flex-wrap: wrap; }
    .run-counts { display: flex; gap: 8px; align-items: center; font-size: 13px; flex-wrap: wrap; }
    .run-sub { color: var(--muted); font-size: 12px; }
    .notes-block { background: #16181d; border: 1px solid var(--border); border-radius: 8px; padding: 8px; font-size: 12px; color: var(--text); }
    .note { padding-bottom: 6px; margin-bottom: 6px; border-bottom: 1px solid #1f2229; }
    .note:last-child { border-bottom: 0; margin-bottom: 0; padding-bottom: 0; }
    .footer { color: var(--muted); font-size: 12px; }
    .analysis-card { display: flex; flex-direction: column; gap: 8px; }
    .analysis-block { background: #0f1014; border: 1px solid var(--border); border-radius: 8px; padding: 10px; color: var(--text); white-space: pre-wrap; overflow: auto; }
  `;
  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Feedback Report</title>
        <style>${styles}</style>
      </head>
      <body>
        <div class="container">
          <div class="page-title">
            <div>
              <div class="eyebrow">Chunking Visualizer</div>
              <h1>Feedback Report</h1>
              <div class="muted">Generated ${escapeHtml(new Date().toLocaleString())} · ${formatNumber((data.runs || []).length)} runs · ${formatNumber(noteCount)} notes</div>
            </div>
            <div class="pill">Scope: ${escapeHtml(scopeLabel)}</div>
          </div>

          <div class="grid stats">
            <div class="card">
              <div class="stat-label">Overall</div>
              <div class="stat-value"><span class="stat-good">${formatNumber(overall.good)}</span>/<span class="stat-bad">${formatNumber(overall.bad)}</span> <span class="muted">${formatNumber(overall.total)}</span></div>
              <div class="stat-sub"><span>Score ${overallScore}</span><span class="pill">${scoreNote}</span></div>
            </div>
            <div class="card">
              <div class="stat-label">Latest</div>
              <div class="stat-value">${escapeHtml(latest?.slug || '-')}</div>
              <div class="stat-sub">${escapeHtml(latest ? formatDate(latest.last_updated) : '-')}</div>
            </div>
            <div class="card">
              <div class="stat-label">Providers</div>
              <div class="stat-sub">${providerLine || '-'}</div>
              <div class="stat-sub">${Object.entries(providers).map(([k, v]) => `${k}: ${formatScore(v.score, v.confidence)}`).join(' · ') || '-'}</div>
            </div>
          </div>

          <div class="charts">
            <div class="card chart-card">
              <div class="stat-label">Good vs Bad by provider</div>
              ${chartImage ? `<img src="${chartImage}" alt="Good vs Bad by provider" />` : '<div class="chart-fallback">Chart unavailable</div>'}
            </div>
            <div class="card chart-card">
              <div class="stat-label">Provider scores (0-100)</div>
              ${scoreChartImage ? `<img src="${scoreChartImage}" alt="Provider scores chart" />` : '<div class="chart-fallback">Chart unavailable</div>'}
            </div>
          </div>

          <div class="card runs-card">
            <div class="stat-label">Runs with feedback</div>
            ${runCards}
          </div>

          <div class="card analysis-card">
            <div class="stat-label">LLM analysis</div>
            ${analysisHtml}
          </div>

          <div class="footer">Exported from the Feedback tab. ${scoreNote}</div>
        </div>
      </body>
    </html>
  `;
  downloadBlob(html, 'feedback.html', 'text/html');
}

async function jumpToRunFromFeedback(slug, provider) {
  if (!slug) return;
  const providerKey = (provider || 'unstructured/local').trim() || 'unstructured/local';
  try {
    await refreshRuns();
    const sel = $('runSelect');
    if (sel) {
      const targetKey = runKey(slug, providerKey);
      const exists = Array.from(sel.options || []).some((opt) => opt.value === targetKey);
      sel.value = exists ? targetKey : sel.value;
      sel.dispatchEvent(new Event('change'));
    }
    switchView('inspect');
    await loadRun(slug, providerKey);
  } catch (e) {
    showToast(`Failed to open run: ${e.message}`, 'err', 2500);
  }
}

function wireFeedbackEvents() {
  const providerSel = $('feedbackProviderSelect');
  if (providerSel) {
    providerSel.addEventListener('change', () => {
      const val = providerSel.value || 'all';
      refreshFeedbackIndex(val);
    });
  }
  const searchInput = $('feedbackSearch');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderFeedbackRuns(FEEDBACK_INDEX?.runs || [], searchInput.value);
    });
  }
  const analyzeBtn = $('feedbackAnalyzeBtn');
  if (analyzeBtn) analyzeBtn.addEventListener('click', analyzeFeedbackSelection);
  const copyBtn = $('feedbackCopyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const el = $('feedbackAnalysis');
      if (!el) return;
      try {
        await navigator.clipboard.writeText(el.textContent || '');
        showToast('Analysis copied', 'ok', 1500);
      } catch (e) {
        showToast('Copy failed', 'err', 1500);
      }
    });
  }
  const exportJsonBtn = $('feedbackExportJson');
  if (exportJsonBtn) exportJsonBtn.addEventListener('click', downloadFeedbackJson);
  const exportHtmlBtn = $('feedbackExportHtml');
  if (exportHtmlBtn) exportHtmlBtn.addEventListener('click', downloadFeedbackHtml);
  const runsHost = $('feedbackRuns');
  if (runsHost) {
    runsHost.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.feedback-inspect-btn');
      if (btn && btn.dataset.slug) {
        jumpToRunFromFeedback(btn.dataset.slug, btn.dataset.provider);
      }
    });
  }
}

async function initFeedbackView() {
  wireFeedbackEvents();
  await refreshFeedbackIndex(($('feedbackProviderSelect')?.value) || 'all');
}
