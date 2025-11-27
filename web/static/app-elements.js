async function loadElementTypes(slug, provider = CURRENT_PROVIDER) {
  try {
    const res = await fetchJSON(withProvider(`/api/element_types/${encodeURIComponent(slug)}`, provider));
    ELEMENT_TYPES = (res.types || []).map(t => ({ type: t.type, count: Number(t.count || 0) }));
  } catch (e) {
    ELEMENT_TYPES = [];
  }
}

function isAzureProvider(provider = CURRENT_PROVIDER) {
  const p = provider || '';
  return p.startsWith('azure');
}

function outlineCollapseState(page) {
  const pageKey = String(page || CURRENT_PAGE || 1);
  const map = ELEMENT_OUTLINE_STATE?.collapsedByPage || {};
  return {
    get: () => !!map[pageKey],
    set: (v) => {
      ELEMENT_OUTLINE_STATE.collapsedByPage = { ...map, [pageKey]: !!v };
    },
  };
}

function outlineExpansionState(id) {
  const map = ELEMENT_OUTLINE_STATE?.expanded || {};
  return {
    get: () => (Object.prototype.hasOwnProperty.call(map, id) ? !!map[id] : null),
    set: (v) => {
      ELEMENT_OUTLINE_STATE.expanded = { ...map, [id]: !!v };
    },
  };
}

function setElementViewMode(mode) {
  const isAzure = isAzureProvider();
  CURRENT_ELEMENT_VIEW_MODE = (mode === 'outline' && isAzure) ? 'outline' : 'flat';
}

function syncElementViewToggle() {
  const host = $('elementViewToggle');
  if (!host) return;
  const isAzure = isAzureProvider();
  if (!isAzure && CURRENT_ELEMENT_VIEW_MODE !== 'flat') {
    CURRENT_ELEMENT_VIEW_MODE = 'flat';
  }
  const mode = isAzure ? CURRENT_ELEMENT_VIEW_MODE : 'flat';
  host.classList.toggle('hidden', !isAzure);
  const buttons = host.querySelectorAll('button[data-mode]');
  buttons.forEach((btn) => {
    const active = (btn.dataset.mode === mode);
    btn.classList.toggle('active', active);
  });
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
    const boxes = await fetchJSON(withProvider(`/api/boxes/${encodeURIComponent(CURRENT_SLUG)}?page=${CURRENT_PAGE}${param}`)) || {};
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
  syncElementViewToggle();

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
  const effectiveMode = isAzureProvider() ? CURRENT_ELEMENT_VIEW_MODE : 'flat';
  if (effectiveMode === 'outline') {
    renderElementOutline(host, filtered);
    updateReviewSummaryChip();
    initElementsViewAutoCondense();
    return;
  }
  for (const [id, entry, review] of filtered) {
    const card = buildElementCard(id, entry, review);
    host.appendChild(card);
  }
  updateReviewSummaryChip();
  initElementsViewAutoCondense();
}

function containerChildTypes(parentType) {
  const map = {
    Table: ['TableCell', 'Paragraph', 'Line', 'Word'],
    Paragraph: ['Line', 'Word'],
    pageHeader: ['Paragraph', 'Line', 'Word'],
    title: ['Paragraph', 'Line', 'Word'],
    sectionHeading: ['Paragraph', 'Line', 'Word'],
    pageNumber: ['Paragraph', 'Line', 'Word'],
    Line: ['Word'],
    Figure: ['sectionHeading', 'Paragraph', 'Line', 'Word'],
  };
  const vals = map[parentType || ''];
  return vals ? new Set(vals) : null;
}

function renderElementOutline(host, filtered) {
  const pageNum = Number(filtered[0]?.[1]?.page_trimmed || CURRENT_PAGE || 1);
  const collapse = outlineCollapseState(pageNum);
  const collapsed = collapse.get();
  const order = [
    { type: 'pageHeader', label: 'Page header' },
    { type: 'pageNumber', label: 'Page number' },
    { type: 'Table', label: 'Tables' },
    { type: 'Figure', label: 'Figures' },
    { type: 'Paragraph', label: 'Paragraphs' },
    { type: 'Line', label: 'Lines' },
  ];
  const byTypeCounts = {};
  const sorted = filtered.slice().sort((a, b) => {
    const ea = a[1] || {};
    const eb = b[1] || {};
    const ya = Number(ea.y || 0) - Number(eb.y || 0);
    if (ya !== 0) return ya;
    return Number(ea.x || 0) - Number(eb.x || 0);
  });
  const childMap = new Map();
  const childIds = new Set();
  for (const item of sorted) {
    const [id, entry] = item;
    if (!entry) continue;
    const allowedChildren = containerChildTypes(entry.type);
    if (!allowedChildren) continue;
    const children = findContainedElements(entry, sorted, allowedChildren);
    if (children.length) {
      childMap.set(id, children);
      children.forEach(([cid]) => childIds.add(cid));
    }
  }
  const wrap = document.createElement('div');
  wrap.className = 'elements-outline-page';
  const head = document.createElement('div');
  head.className = 'elements-outline-page-head';
  const title = document.createElement('div');
  title.className = 'elements-outline-title';
  title.textContent = `Page ${pageNum}`;
  head.appendChild(title);
  const counts = document.createElement('div');
  counts.className = 'elements-outline-counts';
  counts.textContent = order
    .map((o) => {
      const count = sorted.filter(([, entry]) => (entry?.type || '') === o.type).length;
      if (count) byTypeCounts[o.type] = count;
      return count ? `${o.label} ${count}` : null;
    })
    .filter(Boolean)
    .join(' · ');
  head.appendChild(counts);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'outline-toggle';
  toggle.textContent = collapsed ? 'Expand' : 'Collapse';
  toggle.addEventListener('click', () => {
    collapse.set(!collapsed);
    renderElementsListForCurrentPage(CURRENT_PAGE_BOXES);
  });
  head.appendChild(toggle);
  wrap.appendChild(head);
  const body = document.createElement('div');
  body.className = 'elements-outline-body';
  if (collapsed) body.classList.add('collapsed');
  const counters = {};
  const renderRows = (parentEl, nodes, depth = 0) => {
    for (const [id, entry, review] of nodes) {
      const t = entry?.type || 'Unknown';
      const orderMeta = order.find((o) => o.type === t);
      const label = orderMeta ? orderMeta.label : t;
      counters[t] = (counters[t] || 0) + 1;
      const row = document.createElement('div');
      row.className = 'elements-outline-row';
      const left = document.createElement('div');
      left.className = 'elements-outline-left';
      const badge = document.createElement('span');
      badge.className = 'outline-badge';
      badge.textContent = `${label} ${counters[t]}`;
      left.appendChild(badge);
      row.appendChild(left);
      const cardWrap = document.createElement('div');
      cardWrap.className = 'elements-outline-card';
      const card = buildElementCard(id, entry, review);
      const children = childMap.get(id) || [];
      if (children.length) {
        row.classList.add('outline-has-children');
        card.classList.add('has-children');
        const state = outlineExpansionState(id);
        const stored = state.get();
        const expanded = stored === null ? false : stored;
        if (expanded) card.classList.add('children-expanded');
        const summary = summarizeChildren(children);
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'outline-child-toggle';
        toggle.textContent = expanded
          ? summary ? `Hide children (${summary})` : 'Hide children'
          : summary ? `Show children (${summary})` : 'Show children';
        toggle.addEventListener('click', (ev) => {
          ev.stopPropagation();
          state.set(!expanded);
          renderElementsListForCurrentPage(CURRENT_PAGE_BOXES);
        });
        card.appendChild(toggle);
        cardWrap.appendChild(card);
        if (expanded) {
          const childWrap = document.createElement('div');
          childWrap.className = 'elements-outline-children';
          renderRows(childWrap, children, depth + 1);
          cardWrap.appendChild(childWrap);
        }
      } else {
        cardWrap.appendChild(card);
      }
      row.appendChild(cardWrap);
      parentEl.appendChild(row);
    }
  };
  const roots = sorted.filter(([id]) => !childIds.has(id));
  renderRows(body, roots, 0);
  if (!counts.textContent) counts.textContent = `${sorted.length} elements`;
  wrap.appendChild(body);
  host.appendChild(wrap);
}

function revealElementInList(elementId, retries = 12) {
  const list = document.getElementById('elementsList');
  if (!list) return;
  const sel = `[data-element-id="${(window.CSS && window.CSS.escape) ? window.CSS.escape(elementId) : elementId}"]`;
  const card = list.querySelector(sel);
  if (card) {
    list.querySelectorAll('.element-card.focused').forEach(el => el.classList.remove('focused'));
    card.classList.add('focused');
    try { card.scrollIntoView({ block: 'nearest' }); } catch (e) { }
    return;
  }
  if (retries > 0) setTimeout(() => revealElementInList(elementId, retries - 1), 80);
}

async function openElementDetails(elementId) {
  try {
    const data = await fetchJSON(withProvider(`/api/element/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(elementId)}`));
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
    const structure = document.createElement('div');
    structure.className = 'element-structure';
    const crumbs = [
      '<span class="crumb">Document</span>',
      `<span class="crumb">Page ${data.page_number ?? '-'}</span>`,
      `<span class="crumb">${data.type || 'Element'}</span>`,
    ];
    structure.innerHTML = crumbs.join(' › ');
    container.appendChild(structure);
    container.appendChild(buildDrawerReviewSection('element', elementId));
    const imageSection = buildElementImageSection(data);
    if (imageSection) {
      container.appendChild(imageSection);
    }
    const html = data.text_as_html;
    if (html) {
      const scroll = document.createElement('div');
      scroll.className = 'drawer-markdown';
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html;
      scroll.appendChild(wrapper);
      if (wrapper.querySelector('table')) {
        applyTablePreviewDirection(wrapper);
      }
      applyDirectionalText(scroll);
      container.appendChild(scroll);
    } else {
      const md = await renderMarkdownSafe(data.text);
      if (md) {
        const scroll = document.createElement('div');
        scroll.className = 'drawer-markdown';
        const body = document.createElement('div');
        body.className = 'markdown-body';
        body.innerHTML = md;
        scroll.appendChild(body);
        applyDirectionalText(body);
        container.appendChild(scroll);
      } else {
        const pre = document.createElement('pre');
        pre.textContent = data.text || '(no text)';
        applyDirectionalText(pre);
        container.appendChild(pre);
      }
    }
  } catch (e) {
    showToast(`Failed to load element: ${e.message}`, 'err');
  }
}

async function findStableIdByOrig(origId, page) {
  try {
    const boxes = await fetchJSON(withProvider(`/api/boxes/${encodeURIComponent(CURRENT_SLUG)}?page=${page}`));
    for (const [eid, entry] of Object.entries(boxes)) {
      if (entry.orig_id && entry.orig_id === origId) return eid;
    }
  } catch (e) { }
  return null;
}

function buildElementCard(id, entry, review, opts = {}) {
  const compact = !!opts.compact;
  const card = document.createElement('div');
  card.className = 'chunk-card element-card';
  if (compact) card.classList.add('element-card-compact');
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
  const short = dId.length > 16 ? `${dId.slice(0, 12)}…` : dId;
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
  (async () => {
    try {
      const data = await fetchJSON(withProvider(`/api/element/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(id)}`));
      let txt = data.text || '';
      if (!txt && data.text_as_html) {
        txt = String(data.text_as_html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      if (!txt) txt = '(no text)';
      pre.textContent = txt;
      const displayId = data.original_element_id || id;
      const shortId = displayId.length > 16 ? `${displayId.slice(0, 12)}…` : displayId;
      metaWrap.innerHTML = `<span>${data.type || entry.type || 'Element'}</span><span class="meta">${shortId}</span>`;
    } catch (e) {
      pre.textContent = `(failed to load preview: ${e.message})`;
    }
  })();
  return card;
}

function buildElementImageSection(data) {
  const mime = data.image_mime_type || 'image/png';
  const uri = data.image_data_uri || (data.image_base64 ? `data:${mime};base64,${data.image_base64}` : null);
  const fallbackUrl = data.image_url;
  if (!uri && !fallbackUrl) return null;
  const wrap = document.createElement('div');
  wrap.className = 'drawer-image';
  const title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = 'Extracted image';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = data.type ? `${data.type} image` : 'Extracted image';
  img.src = uri || fallbackUrl;
  wrap.appendChild(title);
  wrap.appendChild(img);
  return wrap;
}
function findContainedElements(parentEntry, items, allowedTypes) {
  if (!parentEntry || !(allowedTypes && allowedTypes.size)) return [];
  const px = Number(parentEntry.x || 0);
  const py = Number(parentEntry.y || 0);
  const pw = Number(parentEntry.w || 0);
  const ph = Number(parentEntry.h || 0);
  const pw2 = px + pw;
  const ph2 = py + ph;
  const page = parentEntry.page_trimmed || parentEntry.page || CURRENT_PAGE;
  if (!(pw && ph)) return [];
  const inside = [];
  for (const item of items) {
    const [id, entry, review] = item;
    if (!entry || entry === parentEntry) continue;
    if ((entry.page_trimmed || entry.page) !== page) continue;
    if (!allowedTypes.has(entry.type || '')) continue;
    const cx = Number(entry.x || 0);
    const cy = Number(entry.y || 0);
    const cw = Number(entry.w || 0);
    const ch = Number(entry.h || 0);
    if (!(cw && ch)) continue;
    const cx2 = cx + cw;
    const cy2 = cy + ch;
    const margin = 2;
    const fits =
      cx >= px - margin &&
      cy >= py - margin &&
      cx2 <= pw2 + margin &&
      cy2 <= ph2 + margin;
    if (!fits) continue;
    inside.push(item);
  }
  inside.sort((a, b) => {
    const ea = a[1] || {};
    const eb = b[1] || {};
    const ya = Number(ea.y || 0) - Number(eb.y || 0);
    if (ya !== 0) return ya;
    return Number(ea.x || 0) - Number(eb.x || 0);
  });
  return inside;
}

function summarizeChildren(children) {
  if (!children || !children.length) return '';
  const counts = {};
  for (const [, entry] of children) {
    const t = entry?.type || 'Element';
    counts[t] = (counts[t] || 0) + 1;
  }
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${t.toLowerCase()}${n > 1 ? 's' : ''}`);
  return parts.join(', ');
}
