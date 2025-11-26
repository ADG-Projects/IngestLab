function updateLegend(types) {
  const host = $('legend');
  if (!host) return;
  host.innerHTML = '';
  const use = (types && types.length) ? types : [];
  if (!use.length) { host.classList.add('hidden'); return; }
  for (const t of use.sort()) {
    const row = document.createElement('div');
    row.className = 'item';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    const color = typeBorderColor(t);
    sw.style.background = color;
    row.appendChild(sw);
    const label = document.createElement('span');
    label.textContent = t;
    row.appendChild(label);
    host.appendChild(row);
  }
  host.classList.remove('hidden');
}

function showToast(text, kind='ok', ms=3000) {
  const host = $('toast');
  if (!host) return;
  const item = document.createElement('div');
  item.className = `t ${kind}`;
  item.textContent = text;
  host.appendChild(item);
  setTimeout(() => { item.remove(); }, ms);
}

function typeBorderColor(t) {
  const cls = String(t || '').replace(/[^A-Za-z0-9_-]/g,'');
  if (!cls) return '#6bbcff';
  const fake = document.createElement('div');
  fake.className = `box type-${cls}`;
  document.body.appendChild(fake);
  const color = window.getComputedStyle(fake).borderColor;
  document.body.removeChild(fake);
  return color || '#6bbcff';
}

async function renderMarkdownSafe(text) {
  if (!text || !window.__mdReady) return null;
  try {
    const deps = await window.__mdReady;
    if (!deps || !deps.marked || !deps.DOMPurify) return null;
    const raw = deps.marked.parse(String(text));
    return deps.DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  } catch (e) {
    console.warn('Markdown render failed', e);
    return null;
  }
}

let DRAWER_CONDENSED = false;
const DRAWER_SCROLL_TARGETS = new Set();

function registerDrawerScrollTarget(el) {
  if (!el) return;
  const entry = { el, handler: () => updateDrawerCondensedState() };
  DRAWER_SCROLL_TARGETS.add(entry);
  el.addEventListener('scroll', entry.handler, { passive: true });
}

function clearDrawerScrollTargets() {
  for (const entry of DRAWER_SCROLL_TARGETS) {
    const { el, handler } = entry;
    if (el) el.removeEventListener('scroll', handler);
  }
  DRAWER_SCROLL_TARGETS.clear();
}

function currentDrawerScrollOffset() {
  let offset = 0;
  const preview = $('preview');
  if (preview) offset = preview.scrollTop || 0;
  for (const entry of Array.from(DRAWER_SCROLL_TARGETS)) {
    const { el, handler } = entry;
    if (!el || !el.isConnected) {
      if (el) el.removeEventListener('scroll', handler);
      DRAWER_SCROLL_TARGETS.delete(entry);
      continue;
    }
    if (el.scrollTop > offset) offset = el.scrollTop;
  }
  return offset;
}

function updateDrawerCondensedState() {
  const drawer = $('drawer');
  if (!drawer) return;
  const shouldCondense = currentDrawerScrollOffset() > 32;
  if (shouldCondense === DRAWER_CONDENSED) return;
  DRAWER_CONDENSED = shouldCondense;
  drawer.classList.toggle('drawer-condensed', shouldCondense);
}

function resetDrawerScrollState() {
  const drawer = $('drawer');
  const preview = $('preview');
  if (preview) preview.scrollTop = 0;
  clearDrawerScrollTargets();
  DRAWER_CONDENSED = false;
  if (drawer) drawer.classList.remove('drawer-condensed');
}

function clearDrawer() {
  resetDrawerScrollState();
  CURRENT_CHUNK_DRAWER_ID = null;
  CURRENT_ELEMENT_DRAWER_ID = null;
  CURRENT_INSPECT_ELEMENT_ID = null;
  CURRENT_ELEMENT_ID = null;
  RETURN_TO = null;
  const drawer = $('drawer');
  if (drawer) drawer.classList.add('hidden');
  document.body.classList.remove('drawer-open');
  const preview = $('preview');
  if (preview) preview.innerHTML = '';
  const title = $('drawerTitle');
  if (title) title.textContent = '';
  const meta = $('drawerMeta');
  if (meta) meta.innerHTML = '';
  const summary = $('drawerSummary');
  if (summary) summary.innerHTML = '';
  const picker = $('elementPicker');
  if (picker) picker.innerHTML = '';
}

function initDrawerAutoCondense() {
  const preview = $('preview');
  if (!preview) return;
  preview.addEventListener('scroll', () => {
    updateDrawerCondensedState();
  }, { passive: true });
}

// Chunks view condensing
let CHUNKS_VIEW_CONDENSED = false;

function updateChunksViewCondensedState() {
  const chunkList = $('chunkList');
  const chunksView = document.querySelector('.chunks-view');
  if (!chunkList || !chunksView) return;
  const shouldCondense = chunkList.scrollTop > 32;
  if (shouldCondense === CHUNKS_VIEW_CONDENSED) return;
  CHUNKS_VIEW_CONDENSED = shouldCondense;
  chunksView.classList.toggle('condensed', shouldCondense);
}

function initChunksViewAutoCondense() {
  const chunkList = $('chunkList');
  if (!chunkList) return;
  // Remove any existing listener first
  chunkList.removeEventListener('scroll', updateChunksViewCondensedState);
  chunkList.addEventListener('scroll', updateChunksViewCondensedState, { passive: true });
}

// Elements view condensing
let ELEMENTS_VIEW_CONDENSED = false;

function updateElementsViewCondensedState() {
  const elementsList = $('elementsList');
  const elementsView = document.querySelector('.elements-view');
  if (!elementsList || !elementsView) return;
  const shouldCondense = elementsList.scrollTop > 32;
  if (shouldCondense === ELEMENTS_VIEW_CONDENSED) return;
  ELEMENTS_VIEW_CONDENSED = shouldCondense;
  elementsView.classList.toggle('condensed', shouldCondense);
}

function initElementsViewAutoCondense() {
  const elementsList = $('elementsList');
  if (!elementsList) return;
  // Remove any existing listener first
  elementsList.removeEventListener('scroll', updateElementsViewCondensedState);
  elementsList.addEventListener('scroll', updateElementsViewCondensedState, { passive: true });
}
