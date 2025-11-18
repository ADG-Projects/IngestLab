async function loadElementTypes(slug) {
  try {
    const res = await fetchJSON(`/api/element_types/${encodeURIComponent(slug)}`);
    ELEMENT_TYPES = (res.types || []).map(t => ({ type: t.type, count: Number(t.count || 0) }));
  } catch (e) {
    ELEMENT_TYPES = [];
  }
}

function populateTypeSelectors() {
  const e = $('elementsTypeSelect');
  const opts = ['All', ...ELEMENT_TYPES.map(t => t.type)];
  if (e) {
    e.innerHTML = '';
    for (const t of opts) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t;
      e.appendChild(o);
    }
    e.value = CURRENT_TYPE_FILTER;
  }
  const list = $('typesList');
  if (list) {
    list.innerHTML = '';
    for (const t of ELEMENT_TYPES) {
      const div = document.createElement('div');
      div.textContent = `${t.type}: ${t.count}`;
      list.appendChild(div);
    }
  }
}

async function drawBoxesForCurrentPage() {
  if (!CURRENT_SLUG || !CURRENT_PAGE) return;
  const type = CURRENT_TYPE_FILTER;
  const param = type && type !== 'All' ? `&types=${encodeURIComponent(type)}` : '';
  try {
    const boxes = await fetchJSON(`/api/boxes/${encodeURIComponent(CURRENT_SLUG)}?page=${CURRENT_PAGE}${param}`) || {};
    CURRENT_PAGE_BOXES = boxes || {};
    const entries = sortElementEntries(Object.entries(CURRENT_PAGE_BOXES));
    const availableTypes = new Set();
    for (const [, entry] of entries) {
      if (entry && entry.type) availableTypes.add(entry.type);
    }
    refreshElementOverlaysForCurrentPage();
    renderElementsListForCurrentPage(boxes);
    if (!entries.length) {
      showToast('No boxes found on this page for the current run and filter.', 'err', 2000);
    }
    if (
      !HINTED_HIRES &&
      availableTypes.size === 1 &&
      availableTypes.has('Table') &&
      (!CURRENT_TYPE_FILTER || CURRENT_TYPE_FILTER === 'All' || CURRENT_TYPE_FILTER === 'Table')
    ) {
      showToast('Only Table boxes present. For overlays on other element types, run with strategy=hi_res.', 'ok', 5000);
      HINTED_HIRES = true;
    }
  } catch (e) {
    showToast(`Failed to load boxes: ${e.message}`, 'err');
  }
}

function sortElementEntries(entries) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  list.sort((a, b) => {
    const ea = a[1] || {};
    const eb = b[1] || {};
    const ta = (ea.type || '').localeCompare(eb.type || '');
    if (ta !== 0) return ta;
    const ya = Number(ea.y || 0) - Number(eb.y || 0);
    if (ya !== 0) return ya;
    return Number(ea.x || 0) - Number(eb.x || 0);
  });
  return list;
}

function filterElementEntriesByReview(entries) {
  const filtered = [];
  for (const [id, entry] of entries) {
    const review = getReview('element', id);
    if (!reviewMatchesFilter(review, CURRENT_ELEMENT_REVIEW_FILTER)) continue;
    filtered.push([id, entry, review]);
  }
  return filtered;
}

function refreshElementOverlaysForCurrentPage() {
  clearBoxes();
  if (!CURRENT_PAGE_BOXES || !SHOW_ELEMENT_OVERLAYS) {
    updateLegend([]);
    return;
  }
  const entries = sortElementEntries(Object.entries(CURRENT_PAGE_BOXES));
  const filtered = filterElementEntriesByReview(entries);
  const filteredIds = new Set(filtered.map(([id]) => id));
  const typesPresent = new Set();
  const selectedId = CURRENT_INSPECT_ELEMENT_ID;
  if (selectedId && CURRENT_PAGE_BOXES[selectedId]) {
    const entry = CURRENT_PAGE_BOXES[selectedId];
    if (entry && entry.layout_w && entry.layout_h) {
      const rect = { x: entry.x, y: entry.y, w: entry.w, h: entry.h };
      const meta = { kind: 'element', id: selectedId, origId: entry.orig_id, type: entry.type, page: entry.page_trimmed };
      addBox(rect, entry.layout_w, entry.layout_h, true, entry.type, null, 'element', meta);
      if (entry.type) typesPresent.add(entry.type);
    }
  } else if (!selectedId) {
    for (const [id, entry] of entries) {
      if (!entry || !filteredIds.has(id)) continue;
      if (!(entry.layout_w && entry.layout_h)) continue;
      const rect = { x: entry.x, y: entry.y, w: entry.w, h: entry.h };
      const meta = { kind: 'element', id, origId: entry.orig_id, type: entry.type, page: entry.page_trimmed };
      addBox(rect, entry.layout_w, entry.layout_h, false, entry.type, null, 'element', meta);
      if (entry.type) typesPresent.add(entry.type);
    }
  }
  updateLegend(Array.from(typesPresent));
}

function renderElementsListForCurrentPage(boxes) {
  const host = document.getElementById('elementsList');
  if (!host) return;
  host.innerHTML = '';
  const reviewSelect = $('elementsReviewSelect');
  if (reviewSelect) reviewSelect.value = CURRENT_ELEMENT_REVIEW_FILTER;

  // Update elements pagination
  const paginationEl = $('elementPagination');
  if (paginationEl) {
    const entries = sortElementEntries(Object.entries(boxes || {}));
    const filtered = filterElementEntriesByReview(entries);
    const totalElements = ELEMENT_TYPES.reduce((sum, t) => sum + t.count, 0);
    paginationEl.innerHTML = `<div><span class="lab">Elements (page ${CURRENT_PAGE})</span><span>${filtered.length} of ${totalElements}</span></div>`;
  }

  // Update elements review summary
  const reviewSummaryEl = $('elementsReviewSummary');
  if (reviewSummaryEl) {
    const counts = CURRENT_REVIEWS?.summary?.elements || { good: 0, bad: 0, total: 0 };
    const reviewText = counts.total ? `Reviewed: ${counts.good} Good · ${counts.bad} Bad` : 'Reviewed: none';
    reviewSummaryEl.innerHTML = `<div><span class="lab">Reviewed</span><span>${reviewText}</span></div>`;
  }

  const entries = sortElementEntries(Object.entries(boxes || {}));
  if (!entries.length) {
    const div = document.createElement('div');
    div.className = 'placeholder';
    div.textContent = 'No elements on this page for the selected filter.';
    host.appendChild(div);
    updateReviewSummaryChip();
    return;
  }
  const availableTypes = new Set();
  for (const [, entry] of entries) {
    if (entry && entry.type) availableTypes.add(entry.type);
  }
  const filtered = filterElementEntriesByReview(entries);
  if (!filtered.length) {
    const div = document.createElement('div');
    div.className = 'placeholder';
    div.textContent = 'No elements match the current review filter.';
    host.appendChild(div);
    updateReviewSummaryChip();
    return;
  }
  for (const [id, entry, review] of filtered) {
    const card = document.createElement('div');
    card.className = 'chunk-card element-card';
    if (review && review.rating) {
      card.classList.add('has-review');
      card.classList.add(review.rating === 'good' ? 'review-good' : 'review-bad');
    }
    card.dataset.elementId = id;
    const color = typeBorderColor(entry.type || '');
    card.style.borderLeft = `4px solid ${color}`;
    const header = document.createElement('div');
    header.className = 'header element-card-head';
    const metaWrap = document.createElement('div');
    metaWrap.className = 'element-card-meta';
    const dId = entry.orig_id || id;
    const short = dId.length > 16 ? `${dId.slice(0,12)}…` : dId;
    metaWrap.innerHTML = `<span>${entry.type || 'Unknown'}</span><span class="meta">${short}</span>`;
    header.appendChild(metaWrap);
    header.appendChild(buildReviewButtons('element', id, 'card'));
    const pre = document.createElement('pre');
    pre.textContent = 'Loading preview…';
    applyDirectionalText(pre);
    card.appendChild(header);
    const notePreview = buildNotePreview('element', id, 'mini');
    if (notePreview) {
      notePreview.title = 'Open element details to edit note';
      notePreview.addEventListener('click', (ev) => {
        ev.stopPropagation();
        card.click();
      });
      card.appendChild(notePreview);
    }
    card.appendChild(pre);
    if (id === CURRENT_INSPECT_ELEMENT_ID) card.classList.add('focused');
    card.addEventListener('click', async () => {
      CURRENT_INSPECT_ELEMENT_ID = id;
      const p = Number(entry.page_trimmed || CURRENT_PAGE);
      if (p && p !== CURRENT_PAGE) {
        await renderPage(p);
      }
      await drawBoxesForCurrentPage();
      openElementDetails(id);
    });
    host.appendChild(card);
    (async () => {
      try {
        const data = await fetchJSON(`/api/element/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(id)}`);
        let txt = data.text || '';
        if (!txt && data.text_as_html) {
          txt = String(data.text_as_html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
        if (!txt) txt = '(no text)';
        pre.textContent = txt;
        const displayId = data.original_element_id || id;
        const shortId = displayId.length > 16 ? `${displayId.slice(0,12)}…` : displayId;
        metaWrap.innerHTML = `<span>${data.type || entry.type || 'Element'}</span><span class="meta">${shortId}</span>`;
      } catch (e) {
        pre.textContent = `(failed to load preview: ${e.message})`;
      }
    })();
  }
  updateReviewSummaryChip();
  initElementsViewAutoCondense();
}

function revealElementInList(elementId, retries = 12) {
  const list = document.getElementById('elementsList');
  if (!list) return;
  const sel = `[data-element-id="${(window.CSS && window.CSS.escape) ? window.CSS.escape(elementId) : elementId}"]`;
  const card = list.querySelector(sel);
  if (card) {
    list.querySelectorAll('.element-card.focused').forEach(el => el.classList.remove('focused'));
    card.classList.add('focused');
    try { card.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    return;
  }
  if (retries > 0) setTimeout(() => revealElementInList(elementId, retries - 1), 80);
}

async function openElementDetails(elementId) {
  try {
    const data = await fetchJSON(`/api/element/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(elementId)}`);
    const container = $('preview');
    resetDrawerScrollState();
    CURRENT_ELEMENT_DRAWER_ID = elementId;
    CURRENT_CHUNK_DRAWER_ID = null;
    $('drawerTitle').textContent = 'Element';
    const displayId = data.original_element_id || elementId;
    $('drawerMeta').innerHTML = `<code>${displayId}</code> · <span class="chip-tag">${data.type || '-'}</span>`;
    $('drawerSummary').innerHTML = '';
    $('elementPicker').innerHTML = '';
    $('drawer').classList.remove('hidden');
    document.body.classList.add('drawer-open');
    container.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'preview-meta';
    head.innerHTML = `<span class="badge">Element</span><span>page: ${data.page_number ?? '-'}</span>`;
    container.appendChild(head);
    container.appendChild(buildDrawerReviewSection('element', elementId));
    const html = data.text_as_html;
    if (html) {
      const scroll = document.createElement('div');
      scroll.className = 'scrollbox';
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html;
      scroll.appendChild(wrapper);
      if (wrapper.querySelector('table')) {
        applyTablePreviewDirection(wrapper);
      }
      applyDirectionalText(scroll);
      registerDrawerScrollTarget(scroll);
      container.appendChild(scroll);
    } else {
      const pre = document.createElement('pre');
      pre.textContent = data.text || '(no text)';
      applyDirectionalText(pre);
      container.appendChild(pre);
    }
  } catch (e) {
    showToast(`Failed to load element: ${e.message}`, 'err');
  }
}

async function findStableIdByOrig(origId, page) {
  try {
    const boxes = await fetchJSON(`/api/boxes/${encodeURIComponent(CURRENT_SLUG)}?page=${page}`);
    for (const [eid, entry] of Object.entries(boxes)) {
      if (entry.orig_id && entry.orig_id === origId) return eid;
    }
  } catch (e) {}
  return null;
}
