async function loadChunksForRun(slug, provider = CURRENT_PROVIDER) {
  try {
    const data = await fetchJSON(withProvider(`/api/chunks/${encodeURIComponent(slug)}`, provider));
    CURRENT_CHUNKS = data;
  } catch (e) {
    CURRENT_CHUNKS = { error: e.message, summary: null, chunks: [] };
  }
  CURRENT_CHUNK_LOOKUP = {};
  const chunkList = (CURRENT_CHUNKS && CURRENT_CHUNKS.chunks) || [];
  chunkList.forEach((chunk, idx) => {
    if (!chunk) return;
    if (chunk.element_id) {
      CURRENT_CHUNK_LOOKUP[chunk.element_id] = chunk;
      return;
    }
    const fallbackId = `chunk-${idx}`;
    CURRENT_CHUNK_LOOKUP[fallbackId] = chunk;
  });
  renderChunksTab();
  if (CURRENT_VIEW === 'inspect' && INSPECT_TAB === 'chunks') {
    // Ensure overlays reflect freshly loaded chunks without needing a page change
    redrawOverlaysForCurrentContext();
  }
}

function getChunksForCurrentPage() {
  const allChunks = CURRENT_CHUNKS?.chunks || [];
  return allChunks.map((chunk, idx) => ({ chunk, id: chunk.element_id || `chunk-${idx}` }));
}

function getFilteredChunksForCurrentPage(page = CURRENT_PAGE) {
  const baseChunks = getChunksForCurrentPage();
  return filterChunksForCurrentPage(baseChunks, page);
}

function chunkMatchesTypeFilter(chunk) {
  if (!CURRENT_CHUNK_TYPE_FILTER || CURRENT_CHUNK_TYPE_FILTER === 'All') return true;
  return chunk.type === CURRENT_CHUNK_TYPE_FILTER;
}

function chunkMatchesReviewFilter(chunk, id) {
  if (!CURRENT_CHUNK_REVIEW_FILTER || CURRENT_CHUNK_REVIEW_FILTER === 'All') return true;
  const directReview = getReview('chunk', id);
  if (CURRENT_CHUNK_REVIEW_FILTER === 'Reviewed') {
    if (reviewMatchesFilter(directReview, 'Reviewed')) return true;
    return chunkHasReviewedElements(chunk);
  }
  return reviewMatchesFilter(directReview, CURRENT_CHUNK_REVIEW_FILTER);
}

function filterChunksForCurrentPage(chunks, page = CURRENT_PAGE) {
  return chunks.filter(({ chunk, id }) => {
    // Check if chunk appears on this page (supports multi-page chunks)
    const pages = chunkPages(chunk);
    const onPage = pages.includes(page);
    if (!onPage) {
      // Fallback to single bbox check for backwards compatibility
      const b = chunkBox(chunk);
      if (!b || !Number.isFinite(b.page_trimmed) || b.page_trimmed !== page) {
        return false;
      }
    }
    if (!chunkMatchesTypeFilter(chunk)) return false;
    if (!chunkMatchesReviewFilter(chunk, id)) return false;
    return true;
  });
}

function renderChunksTab() {
  const summaryEl = $('chunkSummary');
  const listEl = $('chunkList');
  if (!summaryEl || !listEl) return;
  if (!CURRENT_RUN_HAS_CHUNKS) {
    summaryEl.innerHTML = '<div class="placeholder">Chunk data not available for this run.</div>';
    listEl.innerHTML = '';
    return;
  }
  if (!CURRENT_CHUNKS) {
    summaryEl.innerHTML = '<div class="placeholder">Loading chunk data…</div>';
    listEl.innerHTML = '';
    return;
  }
  if (CURRENT_CHUNKS.error) {
    summaryEl.innerHTML = `<div class="placeholder">Failed to load chunks: ${CURRENT_CHUNKS.error}</div>`;
    listEl.innerHTML = '';
    return;
  }
  const summary = CURRENT_CHUNKS.summary || {};
  const chunkReviewCounts = CURRENT_REVIEWS?.summary?.chunks || { good: 0, bad: 0, total: 0 };
  const chunkReviewText = chunkReviewCounts.total ? `${chunkReviewCounts.good} Good · ${chunkReviewCounts.bad} Bad` : 'none';
  CHUNK_TYPES = [];
  const typeCount = new Map();
  (CURRENT_CHUNKS.chunks || []).forEach(ch => {
    const type = ch.type || 'Unknown';
    typeCount.set(type, (typeCount.get(type) || 0) + 1);
  });
  CHUNK_TYPES = Array.from(typeCount.entries()).map(([type, count]) => ({ type, count }));
  const baseChunks = getChunksForCurrentPage();
  const chunks = filterChunksForCurrentPage(baseChunks);
  const reviewOpts = [
    { value: 'All', label: 'All' },
    { value: 'Reviewed', label: 'Reviewed' },
    { value: 'Good', label: 'Good only' },
    { value: 'Bad', label: 'Bad only' },
  ];
  const typeOpts = ['All', ...CHUNK_TYPES.map(t => t.type)];
  const typeOptsHtml = typeOpts.map(t => `<option value="${t}" ${t === CURRENT_CHUNK_TYPE_FILTER ? 'selected' : ''}>${t}</option>`).join('');
  const reviewOptsHtml = reviewOpts
    .map(opt => `<option value="${opt.value}" ${opt.value === CURRENT_CHUNK_REVIEW_FILTER ? 'selected' : ''}>${opt.label}</option>`)
    .join('');
  const typesListHtml = CHUNK_TYPES.map(t => `<div>${t.type}: ${t.count}</div>`).join('');
  summaryEl.innerHTML = `
    <div class="chunk-summary-row">
      <div class="row dual">
        <label>
          <span class="lab">Type</span>
          <select id="chunksTypeSelect">${typeOptsHtml}</select>
        </label>
        <label>
          <span class="lab">Review</span>
          <select id="chunkReviewFilter">${reviewOptsHtml}</select>
        </label>
      </div>
      <div class="chunk-pagination">
        <div><span class="lab">Chunks (page ${CURRENT_PAGE})</span><span>${chunks.length} of ${summary.count || 0}</span></div>
      </div>
      <div class="collapsible-stats">
        <div class="chunk-types">${typesListHtml}</div>
        <div class="chunk-stats">
          <div><span class="lab">Avg chars</span><span>${(summary.avg_chars || 0).toFixed(1)}</span></div>
          <div><span class="lab">Min chars</span><span>${summary.min_chars || 0}</span></div>
          <div><span class="lab">Max chars</span><span>${summary.max_chars || 0}</span></div>
          <div><span class="lab">Total chars</span><span>${summary.total_chars || 0}</span></div>
          <div><span class="lab">Reviewed</span><span>${chunkReviewText}</span></div>
        </div>
      </div>
    </div>
  `;
  const typeSelect = $('chunksTypeSelect');
  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      CURRENT_CHUNK_TYPE_FILTER = typeSelect.value || 'All';
      renderChunksTab();
      redrawOverlaysForCurrentContext();
    });
  }
  const reviewSelect = $('chunkReviewFilter');
  if (reviewSelect) {
    reviewSelect.addEventListener('change', () => {
      CURRENT_CHUNK_REVIEW_FILTER = reviewSelect.value || 'All';
      renderChunksTab();
      redrawOverlaysForCurrentContext();
    });
  }
  listEl.innerHTML = '';
  if (!chunks.length) {
    const empty = document.createElement('div');
    empty.className = 'placeholder';
    empty.textContent = 'No chunks match the current filters.';
    listEl.appendChild(empty);
    updateReviewSummaryChip();
    return;
  }
  chunks.forEach(({ chunk, id }, idx) => {
    const card = document.createElement('div');
    card.className = 'chunk-card';
    const chunkId = id || `chunk-${idx}`;
    card.dataset.chunkId = chunkId;
    const allChunks = CURRENT_CHUNKS?.chunks || [];
    const globalIndex = allChunks.indexOf(chunk);
    const color = typeBorderColor(chunk.type || '', globalIndex);
    card.style.borderLeft = `4px solid ${color}`;
    const chunkReview = getReview('chunk', chunkId);
    const derivedElementReview = chunkHasReviewedElements(chunk);
    if (chunkReview && chunkReview.rating) {
      card.classList.add('has-review');
      card.classList.add(chunkReview.rating === 'good' ? 'review-good' : 'review-bad');
    } else if (derivedElementReview) {
      card.classList.add('has-review');
      card.classList.add('review-indirect');
    }
    const header = document.createElement('div');
    header.className = 'header chunk-card-head';
    const metaWrap = document.createElement('div');
    metaWrap.className = 'chunk-header-meta';
    metaWrap.innerHTML = `<span>${chunk.element_id || '(no id)'}</span><span>${chunk.char_len || 0} chars</span>`;
    header.appendChild(metaWrap);
    header.appendChild(buildReviewButtons('chunk', chunkId, 'card'));
    const pre = document.createElement('pre');
    const text = chunk.text || '';
    pre.textContent = text || '(empty)';
    applyDirectionalText(pre);
    const sub = document.createElement('div');
    sub.className = 'elements-sublist hidden';
    const uniq = new Map();
    (chunk.orig_boxes || []).forEach((b, i2) => {
      const key = b.orig_id || b.element_id || `${b.page_trimmed}:${b.x}:${b.y}:${b.w}:${b.h}:${i2}`;
      if (!uniq.has(key)) uniq.set(key, b);
    });
    if (uniq.size) {
      const title = document.createElement('div');
      title.className = 'sublist-title';
      title.textContent = 'Elements';
      sub.appendChild(title);
      uniq.forEach((b) => {
        const row = document.createElement('div');
        row.className = 'element-row';
        const idDisp = (b.orig_id || b.element_id || '').toString();
        const short = idDisp.length > 16 ? `${idDisp.slice(0, 12)}…` : idDisp || '(no id)';
        row.innerHTML = `<span>${b.type || 'Element'} · p${b.page_trimmed ?? '?'}</span><span class="meta">${short}</span>`;
        row.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const listElRef = document.getElementById('chunkList');
          RETURN_TO = { kind: 'chunk', id: chunkId, scrollTop: (listElRef ? listElRef.scrollTop : 0) };
          const p = Number(b.page_trimmed || CURRENT_PAGE);
          let stable = await findStableIdByOrig(b.orig_id || b.element_id, p);
          if (p && p !== CURRENT_PAGE) await renderPage(p);
          switchView('inspect');
          switchInspectTab('elements');
          if (stable) {
            CURRENT_INSPECT_ELEMENT_ID = stable;
            await drawBoxesForCurrentPage();
            await openElementDetails(stable);
          } else if (b.orig_id) {
            CURRENT_INSPECT_ELEMENT_ID = null;
            await drawBoxesForCurrentPage();
            await openElementDetails(b.orig_id);
            stable = await findStableIdByOrig(b.orig_id, p);
            if (stable) { CURRENT_INSPECT_ELEMENT_ID = stable; await drawBoxesForCurrentPage(); }
          }
        });
        sub.appendChild(row);
      });
    }
    card.appendChild(header);
    const notePreview = buildNotePreview('chunk', chunkId, 'card');
    if (!chunkReview && derivedElementReview) {
      const hint = document.createElement('div');
      hint.className = 'review-hint';
      hint.textContent = 'Contains reviewed elements';
      card.appendChild(hint);
    }
    if (notePreview) {
      notePreview.title = 'Open chunk details to edit note';
      notePreview.addEventListener('click', (ev) => {
        ev.stopPropagation();
        card.click();
      });
      card.appendChild(notePreview);
    }
    card.appendChild(pre);
    card.addEventListener('click', async () => {
      CURRENT_INSPECT_ELEMENT_ID = chunk.element_id || null;
      const b = chunkBox(chunk);
      if (b && Number.isFinite(b.page_trimmed)) {
        const p = Number(b.page_trimmed);
        if (p && p !== CURRENT_PAGE) {
          await renderPage(p);
        } else {
          redrawOverlaysForCurrentContext();
        }
      } else {
        redrawOverlaysForCurrentContext();
      }
      await openChunkDetailsDrawer(chunkId, sub);
    });
    listEl.appendChild(card);
  });
  updateReviewSummaryChip();
  initChunksViewAutoCondense();
}

async function openChunkDetailsDrawer(chunkId, elementsSublist) {
  const ch = CURRENT_CHUNK_LOOKUP ? CURRENT_CHUNK_LOOKUP[chunkId] : null;
  if (!ch) return;
  CURRENT_CHUNK_DRAWER_ID = chunkId;
  CURRENT_ELEMENT_DRAWER_ID = null;
  resetDrawerScrollState();
  $('drawerTitle').textContent = 'Chunk Details';
  $('drawerMeta').innerHTML = `<code>${chunkId}</code> · <span class="chip-tag">${ch.type || '-'}</span> · <span class="chip-tag">${ch.char_len || 0} chars</span>`;
  $('drawerSummary').innerHTML = '';
  $('elementPicker').innerHTML = '';
  const container = $('preview');
  container.innerHTML = '';
  container.appendChild(buildDrawerReviewSection('chunk', chunkId));
  const textSection = document.createElement('div');
  textSection.className = 'chunk-text-section';
  const textHeader = document.createElement('h3');
  textHeader.textContent = 'Chunk Text';
  textHeader.style.marginTop = '0';
  textHeader.style.marginBottom = '12px';
  textHeader.style.fontSize = '14px';
  textHeader.style.fontWeight = '600';
  textSection.appendChild(textHeader);
  const md = await renderMarkdownSafe(ch.text);
  if (md) {
    const scroll = document.createElement('div');
    scroll.className = 'scrollbox drawer-markdown';
    scroll.style.maxHeight = '240px';
    const body = document.createElement('div');
    body.className = 'markdown-body';
    body.innerHTML = md;
    scroll.appendChild(body);
    applyDirectionalText(body);
    registerDrawerScrollTarget(scroll);
    textSection.appendChild(scroll);
  } else {
    const pre = document.createElement('pre');
    pre.style.maxHeight = '200px';
    pre.style.overflow = 'auto';
    pre.textContent = ch.text || '(empty)';
    applyDirectionalText(pre);
    registerDrawerScrollTarget(pre);
    textSection.appendChild(pre);
  }
  container.appendChild(textSection);
  const uniq = new Map();
  (ch.orig_boxes || []).forEach((b, i2) => {
    const key = b.orig_id || b.element_id || `${b.page_trimmed}:${b.x}:${b.y}:${b.w}:${b.h}:${i2}`;
    if (!uniq.has(key)) uniq.set(key, b);
  });
  if (uniq.size > 0) {
    const elemSection = document.createElement('div');
    elemSection.className = 'chunk-elements-section';
    elemSection.style.marginTop = '24px';
    const elemHeader = document.createElement('h3');
    elemHeader.textContent = `Elements (${uniq.size})`;
    elemHeader.style.marginTop = '0';
    elemHeader.style.marginBottom = '12px';
    elemHeader.style.fontSize = '14px';
    elemHeader.style.fontWeight = '600';
    elemSection.appendChild(elemHeader);
    const elemList = document.createElement('div');
    elemList.className = 'drawer-element-list';
    elemList.style.display = 'flex';
    elemList.style.flexDirection = 'column';
    elemList.style.gap = '8px';
    uniq.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'drawer-element-row';
      row.style.padding = '12px';
      row.style.border = '1px solid #ddd';
      row.style.borderRadius = '4px';
      row.style.cursor = 'pointer';
      row.style.transition = 'background 0.2s';
      const idDisp = (b.orig_id || b.element_id || '').toString();
      const short = idDisp.length > 30 ? `${idDisp.slice(0, 26)}…` : idDisp || '(no id)';
      row.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div style="font-weight: 600; margin-bottom: 4px;">${b.type || 'Element'}</div>
            <div style="font-size: 12px; color: #666;">Page ${b.page_trimmed ?? '?'} · ${short}</div>
          </div>
          <div style="font-size: 20px; color: #999;">›</div>
        </div>
      `;
      row.addEventListener('mouseenter', () => { row.style.background = '#f5f5f5'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
      row.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const listElRef = document.getElementById('chunkList');
        RETURN_TO = { kind: 'chunk', id: chunkId, scrollTop: (listElRef ? listElRef.scrollTop : 0) };
        const p = Number(b.page_trimmed || CURRENT_PAGE);
        let stable = await findStableIdByOrig(b.orig_id || b.element_id, p);
        if (p && p !== CURRENT_PAGE) await renderPage(p);
        switchView('inspect');
        switchInspectTab('elements');
        if (stable) {
          CURRENT_INSPECT_ELEMENT_ID = stable;
          await drawBoxesForCurrentPage();
          await openElementDetails(stable);
        } else if (b.orig_id) {
          CURRENT_INSPECT_ELEMENT_ID = null;
          await drawBoxesForCurrentPage();
          await openElementDetails(b.orig_id);
          stable = await findStableIdByOrig(b.orig_id, p);
          if (stable) { CURRENT_INSPECT_ELEMENT_ID = stable; await drawBoxesForCurrentPage(); }
        } else if (b.element_id) {
          CURRENT_INSPECT_ELEMENT_ID = null;
          await drawBoxesForCurrentPage();
          await openElementDetails(b.element_id);
        }
      });
      elemList.appendChild(row);
    });
    elemSection.appendChild(elemList);
    container.appendChild(elemSection);
  }
  $('drawer').classList.remove('hidden');
  document.body.classList.add('drawer-open');
}

async function openChunkDetails(chunkId) {
  await openChunkDetailsDrawer(chunkId, null);
}

async function focusChunkFromOverlay(chunkId) {
  switchView('inspect');
  switchInspectTab('chunks');
  CURRENT_ELEMENT_ID = chunkId;
  const ch = CURRENT_CHUNK_LOOKUP ? CURRENT_CHUNK_LOOKUP[chunkId] : null;
  const b = chunkBox(ch);
  if (b && Number.isFinite(b.page_trimmed)) {
    const p = Number(b.page_trimmed);
    if (p && p !== CURRENT_PAGE) await renderPage(p);
  }
  revealChunkInList(chunkId, true);
  redrawOverlaysForCurrentContext();
}

function revealChunkInList(chunkId, expand = true) {
  const list = document.getElementById('chunkList');
  if (!list) return;
  const sel = `[data-chunk-id="${(window.CSS && window.CSS.escape) ? window.CSS.escape(chunkId) : chunkId}"]`;
  const card = list.querySelector(sel);
  if (!card) { setTimeout(() => revealChunkInList(chunkId, expand), 80); return; }
  if (expand) {
    const sub = card.querySelector('.elements-sublist');
    if (sub) sub.classList.remove('hidden');
  }
  try { card.scrollIntoView({ block: 'nearest' }); } catch (e) { }
}
