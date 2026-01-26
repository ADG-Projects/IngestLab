/**
 * Elements orchestration - box drawing, list rendering, main entry points
 * Dependencies: app-elements-filter.js, app-elements-outline.js, app-elements-cards.js
 */

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

function refreshElementOverlaysForCurrentPage() {
  clearBoxes();
  if (!CURRENT_PAGE_BOXES || !SHOW_ELEMENT_OVERLAYS) {
    updateLegend([]);
    return;
  }
  const entries = sortElementEntries(Object.entries(CURRENT_PAGE_BOXES));
  const filtered = filterElementEntriesByReview(entries);
  const overlayAllowed = outlineExpandedChildren(filtered);
  const typesPresent = new Set();
  const selectedId = CURRENT_INSPECT_ELEMENT_ID;
  const drawList = [];
  if (overlayAllowed) {
    const allowedSet = new Set(overlayAllowed);
    if (selectedId && CURRENT_PAGE_BOXES[selectedId]) {
      allowedSet.add(selectedId);
    }
    for (const item of filtered) {
      const [id] = item;
      if (allowedSet.has(id)) drawList.push(item);
    }
  } else if (selectedId && CURRENT_PAGE_BOXES[selectedId]) {
    drawList.push([selectedId, CURRENT_PAGE_BOXES[selectedId], getReview('element', selectedId)]);
  } else if (!selectedId) {
    drawList.push(...filtered);
  }
  for (const [id, entry] of drawList) {
    if (!entry) continue;
    if (!(entry.layout_w && entry.layout_h)) continue;
    const rect = { x: entry.x, y: entry.y, w: entry.w, h: entry.h };
    const meta = { kind: 'element', id, origId: entry.orig_id, type: entry.type, page: entry.page_trimmed };
    const isBest = Boolean(selectedId && id === selectedId);
    addBox(rect, entry.layout_w, entry.layout_h, isBest, entry.type, null, 'element', meta);
    if (entry.type) typesPresent.add(entry.type);
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

// Window exports
window.drawBoxesForCurrentPage = drawBoxesForCurrentPage;
window.refreshElementOverlaysForCurrentPage = refreshElementOverlaysForCurrentPage;
window.renderElementsListForCurrentPage = renderElementsListForCurrentPage;
window.revealElementInList = revealElementInList;
