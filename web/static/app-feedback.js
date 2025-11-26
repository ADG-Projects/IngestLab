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
  $('feedbackNoteCount').textContent = `${formatNumber(noteCount)} notes`;
  $('feedbackLatestRun').textContent = latest ? `${latest.slug} (${latest.provider})` : '-';
  $('feedbackLatestUpdated').textContent = latest ? formatDate(latest.last_updated) : '-';
  const breakdown = Object.entries(providers)
    .map(([prov, stats]) => `${prov}: ${formatNumber(stats.good)} / ${formatNumber(stats.bad)} (${formatNumber(stats.total)})`)
    .join(' · ');
  $('feedbackProviderBreakdown').textContent = breakdown || '-';
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
    renderFeedbackRuns(data.runs || [], $('feedbackSearch')?.value || '');
    if (status) status.textContent = '';
  } catch (e) {
    if (status) status.textContent = `Load failed: ${e.message}`;
  }
}

function renderFeedbackAnalysis(data) {
  const el = $('feedbackAnalysis');
  if (!el) return;
  let text = '';
  if (data?.comparison) {
    text = JSON.stringify(data.comparison, null, 2);
  } else if (data?.summary) {
    text = JSON.stringify(data.summary, null, 2);
  } else {
    text = JSON.stringify(data, null, 2);
  }
  el.textContent = text || 'No analysis yet.';
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
        body: JSON.stringify({ providers: ['unstructured', 'unstructured-partition', 'azure-di'] }),
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

function downloadFeedbackJson() {
  const data = FEEDBACK_INDEX || { runs: [] };
  downloadBlob(JSON.stringify(data, null, 2), 'feedback.json');
}

function downloadFeedbackHtml() {
  const data = FEEDBACK_INDEX || { runs: [] };
  const overall = data.aggregate?.overall || { good: 0, bad: 0, total: 0 };
  const providers = data.aggregate?.providers || {};
  const body = `
    <html><head><meta charset="utf-8"><title>Feedback Report</title>
    <style>
      body { font-family: Arial, sans-serif; background: #0e0f12; color: #e9eef3; padding: 16px; }
      h1 { margin-top: 0; }
      .card { border: 1px solid #22262d; padding: 12px; margin-bottom: 12px; border-radius: 10px; background: #16181d; }
      .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; border: 1px solid #2a2f38; margin-right: 6px; }
      .run { margin-bottom: 10px; }
      .notes { margin-top: 6px; }
    </style></head><body>
    <h1>Feedback Report</h1>
    <div class="card">
      <div>Overall: Good ${overall.good} / Bad ${overall.bad} / Total ${overall.total}</div>
      <div>Providers: ${Object.entries(providers).map(([k, v]) => `${k}: ${v.good}/${v.bad} (${v.total})`).join(' · ')}</div>
    </div>
    <div class="card">
      ${(data.runs || [])
        .map((run) => {
          const summary = run.summary?.overall || { good: 0, bad: 0, total: 0 };
          const notes = (run.items || []).filter((n) => n.note);
          return `
            <div class="run">
              <div><strong>${run.slug}</strong> <span class="pill">${run.provider}</span></div>
              <div>Good ${summary.good} / Bad ${summary.bad} / Total ${summary.total}</div>
              <div>PDF: ${run.pdf || '-'} · Pages: ${run.pages || '-'} · Tag: ${run.tag || '-'}</div>
              <div class="notes">
                ${notes
                  .map((n) => `<div><strong>${n.kind || ''} ${n.rating || ''}</strong> — ${n.note || ''}</div>`)
                  .join('') || '<div>No notes</div>'}
              </div>
            </div>
          `;
        })
        .join('')}
    </div>
    </body></html>
  `;
  downloadBlob(body, 'feedback.html', 'text/html');
}

async function jumpToRunFromFeedback(slug) {
  if (!slug) return;
  try {
    await refreshRuns();
    const sel = $('runSelect');
    if (sel) {
      sel.value = slug;
      sel.dispatchEvent(new Event('change'));
    }
    switchView('inspect');
    await loadRun(slug);
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
        jumpToRunFromFeedback(btn.dataset.slug);
      }
    });
  }
}

async function initFeedbackView() {
  wireFeedbackEvents();
  await refreshFeedbackIndex(($('feedbackProviderSelect')?.value) || 'all');
}
