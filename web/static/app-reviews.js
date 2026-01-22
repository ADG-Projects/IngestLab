function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function reviewKey(kind, itemId) {
  return `${kind}:${itemId}`;
}

function reviewDraftKey(kind, itemId, slug = CURRENT_SLUG) {
  const safeSlug = slug || CURRENT_SLUG || 'global';
  return `${safeSlug}:${reviewKey(kind, itemId)}`;
}

function getReviewDraft(kind, itemId, slug = CURRENT_SLUG) {
  const key = reviewDraftKey(kind, itemId, slug);
  return Object.prototype.hasOwnProperty.call(REVIEW_NOTE_DRAFTS, key)
    ? REVIEW_NOTE_DRAFTS[key]
    : null;
}

function setReviewDraft(kind, itemId, value, slug = CURRENT_SLUG) {
  const key = reviewDraftKey(kind, itemId, slug);
  if (value === null) {
    delete REVIEW_NOTE_DRAFTS[key];
    return;
  }
  REVIEW_NOTE_DRAFTS[key] = value;
}

function getReview(kind, itemId) {
  return REVIEW_LOOKUP[reviewKey(kind, itemId)] || null;
}

function chunkHasReviewedElements(chunk) {
  if (!chunk) return false;
  const boxes = Array.isArray(chunk.orig_boxes) ? chunk.orig_boxes : [];
  for (const box of boxes) {
    const review = getReview('element', box.orig_id || box.element_id);
    if (review && review.rating) return true;
  }
  return false;
}

function _emptyReviewState(slug = CURRENT_SLUG) {
  return {
    slug,
    items: [],
    summary: {
      overall: { good: 0, bad: 0, total: 0 },
      chunks: { good: 0, bad: 0, total: 0 },
      elements: { good: 0, bad: 0, total: 0 },
    },
  };
}

function setReviewState(payload) {
  const prevSlug = CURRENT_REVIEWS?.slug || null;
  const base = (payload && Array.isArray(payload.items)) ? payload : _emptyReviewState(payload?.slug || CURRENT_SLUG);
  const nextSlug = base.slug || CURRENT_SLUG || null;
  CURRENT_REVIEWS = {
    slug: nextSlug,
    items: Array.isArray(base.items) ? base.items : [],
    summary: {
      overall: base.summary?.overall || { good: 0, bad: 0, total: 0 },
      chunks: base.summary?.chunks || { good: 0, bad: 0, total: 0 },
      elements: base.summary?.elements || { good: 0, bad: 0, total: 0 },
    },
  };
  if (prevSlug !== nextSlug) {
    REVIEW_NOTE_DRAFTS = {};
  }
  REVIEW_LOOKUP = {};
  (CURRENT_REVIEWS.items || []).forEach((item) => {
    if (!item || !item.kind || !item.item_id) return;
    REVIEW_LOOKUP[reviewKey(item.kind, item.item_id)] = item;
  });
}

function updateReviewSummaryChip() {
  const chip = $('reviewSummaryChip');
  if (!chip) return;
  const chunks = CURRENT_REVIEWS?.summary?.chunks || { good: 0, bad: 0, total: 0 };
  const elements = CURRENT_REVIEWS?.summary?.elements || { good: 0, bad: 0, total: 0 };
  const chunksGood = Number(chunks.good || 0);
  const chunksBad = Number(chunks.bad || 0);
  const elementsGood = Number(elements.good || 0);
  const elementsBad = Number(elements.bad || 0);
  chip.innerHTML = `
    <span class="review-chip-line ${elements.total ? 'segment-enabled' : 'segment-disabled'}" data-kind="elements">
      <span class="review-chip-label">Elements</span>
      <span class="review-chip-counts">
        <span class="review-chip-good">${elementsGood}</span>
        <span>-</span>
        <span class="review-chip-bad">${elementsBad}</span>
      </span>
    </span>
    <span class="review-chip-sep">|</span>
    <span class="review-chip-line ${chunks.total ? 'segment-enabled' : 'segment-disabled'}" data-kind="chunks">
      <span class="review-chip-label">Chunks</span>
      <span class="review-chip-counts">
        <span class="review-chip-good">${chunksGood}</span>
        <span>-</span>
        <span class="review-chip-bad">${chunksBad}</span>
      </span>
    </span>
  `;
  const anyTotal = (chunks.total || 0) + (elements.total || 0);
  chip.classList.toggle('disabled', !anyTotal);
  const chunksActive = CURRENT_VIEW === 'inspect' && INSPECT_TAB === 'chunks' && CURRENT_CHUNK_REVIEW_FILTER === 'Reviewed';
  const elementsActive = CURRENT_VIEW === 'inspect' && INSPECT_TAB === 'elements' && CURRENT_ELEMENT_REVIEW_FILTER === 'Reviewed';
  const lines = chip.querySelectorAll('.review-chip-line');
  lines.forEach((line) => {
    const kind = line.dataset.kind;
    const isActive = kind === 'chunks' ? chunksActive : elementsActive;
    line.classList.toggle('active', isActive);
  });
  chip.classList.toggle('active', chunksActive || elementsActive);
}

async function loadReviews(slug, provider = CURRENT_PROVIDER) {
  try {
    const data = await fetchJSON(withProvider(`/api/reviews/${encodeURIComponent(slug)}`, provider));
    setReviewState(data);
  } catch (e) {
    setReviewState(_emptyReviewState(slug));
  }
  updateReviewSummaryChip();
  if (CURRENT_RUN_HAS_CHUNKS) renderChunksTab();
  if (CURRENT_PAGE_BOXES) {
    renderElementsListForCurrentPage(CURRENT_PAGE_BOXES);
    refreshElementOverlaysForCurrentPage();
  }
}

function reviewMatchesFilter(review, filter) {
  if (!filter || filter === 'All') return true;
  if (filter === 'Reviewed') return Boolean(review && review.rating);
  if (filter === 'Good') return Boolean(review && review.rating === 'good');
  if (filter === 'Bad') return Boolean(review && review.rating === 'bad');
  return true;
}

async function saveReview(kind, itemId, overrides = {}) {
  if (!CURRENT_SLUG) {
    showToast('Select a run before leaving reviews.', 'err');
    return;
  }
  const existing = getReview(kind, itemId);
  let rating = overrides.rating;
  if (rating === undefined) rating = existing ? existing.rating : null;
  let note = overrides.note;
  if (note === undefined) note = existing ? (existing.note || '') : '';
  note = String(note || '');
  if (rating === null) {
    note = '';
  }
  if (note && !rating) {
    showToast('Choose Good or Bad before saving a note.', 'err');
    return;
  }
  const payload = { kind, item_id: itemId, rating, note };
  try {
    const res = await fetch(withProvider(`/api/reviews/${encodeURIComponent(CURRENT_SLUG)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `HTTP ${res.status}`);
    }
    const data = await res.json();
    setReviewState(data.reviews);
    updateReviewSummaryChip();
    if (CURRENT_RUN_HAS_CHUNKS) {
      renderChunksTab();
    }
    renderElementsListForCurrentPage(CURRENT_PAGE_BOXES);
    if (SHOW_ELEMENT_OVERLAYS) {
      refreshElementOverlaysForCurrentPage();
    }
    if (kind === 'chunk' && CURRENT_VIEW === 'inspect' && INSPECT_TAB === 'chunks') {
      redrawOverlaysForCurrentContext();
    }
    if (kind === 'chunk' && CURRENT_CHUNK_DRAWER_ID === itemId) {
      await openChunkDetailsDrawer(itemId, null);
    }
    if (kind === 'element' && CURRENT_ELEMENT_DRAWER_ID === itemId) {
      await openElementDetails(itemId);
    }
    const summary = rating ? `${rating === 'good' ? 'Good' : 'Bad'} review saved` : 'Review removed';
    showToast(`${summary} for ${kind} ${itemId}`, 'ok', 2000);
  } catch (e) {
    showToast(`Failed to save review: ${e.message}`, 'err');
  }
}

function buildReviewButtons(kind, itemId, variant = 'card') {
  const wrap = document.createElement('div');
  wrap.className = `review-buttons review-${variant}`;
  const current = getReview(kind, itemId);
  ['good', 'bad'].forEach((rating) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `review-btn review-${rating} review-${variant}`;
    btn.textContent = rating === 'good' ? 'Good' : 'Bad';
    if (current && current.rating === rating) {
      btn.classList.add('active');
    }
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const existing = getReview(kind, itemId);
      const next = existing && existing.rating === rating ? null : rating;
      await saveReview(kind, itemId, { rating: next });
    });
    wrap.appendChild(btn);
  });
  return wrap;
}

function buildNotePreview(kind, itemId, variant = 'card') {
  const review = getReview(kind, itemId);
  if (!review || !review.note) return null;
  const div = document.createElement('div');
  div.className = `review-note-preview ${variant}`;
  const max = variant === 'mini' ? 80 : 160;
  const text = review.note.length > max ? `${review.note.slice(0, max)}…` : review.note;
  div.textContent = text;
  return div;
}

function buildDrawerReviewSection(kind, itemId) {
  const reviewSection = document.createElement('div');
  reviewSection.className = 'drawer-review-section';
  const head = document.createElement('div');
  head.className = 'drawer-review-head';
  const label = document.createElement('span');
  label.className = 'lab';
  label.textContent = 'Review';
  head.appendChild(label);
  head.appendChild(buildReviewButtons(kind, itemId, 'drawer'));
  reviewSection.appendChild(head);
  const noteWrap = document.createElement('div');
  noteWrap.className = 'drawer-review-note';
  const note = document.createElement('textarea');
  note.placeholder = 'Add reviewer notes (optional)…';
  const existing = getReview(kind, itemId);
  const draft = getReviewDraft(kind, itemId);
  if (draft !== null && draft !== undefined) {
    note.value = draft;
  } else {
    note.value = existing?.note || '';
  }
  const warning = document.createElement('div');
  warning.className = 'review-note-warning';
  warning.textContent = 'Select Good or Bad to save your note';
  const updateWarning = () => {
    const state = getReview(kind, itemId);
    const hasContent = note.value.trim().length > 0;
    const hasRating = Boolean(state?.rating);
    const showWarning = hasContent && !hasRating;
    warning.classList.toggle('visible', showWarning);
    note.classList.toggle('warning', showWarning);
  };
  const debouncedSave = debounce(async () => {
    const state = getReview(kind, itemId);
    if (state?.rating) {
      const trimmed = note.value.trim();
      await saveReview(kind, itemId, { note: trimmed });
    }
  }, 600);
  note.addEventListener('input', () => {
    setReviewDraft(kind, itemId, note.value);
    updateWarning();
    debouncedSave();
  });
  noteWrap.appendChild(note);
  noteWrap.appendChild(warning);
  reviewSection.appendChild(noteWrap);
  updateWarning();
  return reviewSection;
}
