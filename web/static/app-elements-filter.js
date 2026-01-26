/**
 * Element type loading, filtering, and view mode management
 * Extracted from app-elements.js for modularity
 */

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

// Window exports
window.loadElementTypes = loadElementTypes;
window.isAzureProvider = isAzureProvider;
window.outlineCollapseState = outlineCollapseState;
window.outlineExpansionState = outlineExpansionState;
window.setElementViewMode = setElementViewMode;
window.syncElementViewToggle = syncElementViewToggle;
window.populateTypeSelectors = populateTypeSelectors;
window.sortElementEntries = sortElementEntries;
window.filterElementEntriesByReview = filterElementEntriesByReview;
