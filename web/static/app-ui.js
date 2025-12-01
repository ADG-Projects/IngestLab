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

function showToast(text, kind = 'ok', ms = 3000) {
  const host = $('toast');
  if (!host) return;
  const item = document.createElement('div');
  item.className = `t ${kind}`;
  item.textContent = text;
  host.appendChild(item);
  setTimeout(() => { item.remove(); }, ms);
}

function typeBorderColor(t, altIndex = null) {
  const cls = String(t || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!cls) return '#6bbcff';
  const fake = document.createElement('div');
  fake.className = `box type-${cls}`;
  if (altIndex !== null && altIndex > 0) {
    fake.classList.add(`alt-${altIndex % 4}`);
  }
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

function wireWhatsNewModal() {
  const badge = $('versionBadge');
  const modal = $('whatsNewModal');
  const closeBtn = $('closeWhatsNew');
  const backdrop = $('whatsNewBackdrop');

  if (!badge || !modal) return;

  badge.addEventListener('click', () => modal.classList.remove('hidden'));
  if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  if (backdrop) backdrop.addEventListener('click', () => modal.classList.add('hidden'));
}

// Right panel resize functionality
const DRAWER_RESIZE_KEY = 'drawer-width';
const DRAWER_MIN_WIDTH = 360;

function getDrawerMaxWidth() {
  // Max is 70% of window width (but at least min width)
  return Math.max(DRAWER_MIN_WIDTH, Math.round(window.innerWidth * 0.7));
}

function getDefaultDrawerWidth() {
  // Calculate a sensible default based on window size
  // Use ~35% of window width, clamped to min/max
  const preferred = Math.round(window.innerWidth * 0.35);
  return Math.max(DRAWER_MIN_WIDTH, Math.min(getDrawerMaxWidth(), preferred));
}

function updateDrawerWidth(width) {
  // Sync the fixed-position drawer overlay width with the right panel
  document.documentElement.style.setProperty('--drawer-width', `${width}px`);
}

function initDrawerResize() {
  const panelHandle = document.getElementById('drawer-resize-handle');
  const drawerHandle = document.getElementById('drawer-overlay-resize-handle');
  const shell = document.querySelector('.inspect-shell');
  if (!shell) return;

  let isDragging = false;
  let activeHandle = null;
  let currentWidth = null;

  // Restore saved width on load
  const savedWidth = localStorage.getItem(DRAWER_RESIZE_KEY);
  if (savedWidth) {
    const width = parseInt(savedWidth, 10);
    if (width >= DRAWER_MIN_WIDTH && width <= getDrawerMaxWidth()) {
      shell.style.gridTemplateColumns = `minmax(0, 1fr) ${width}px`;
      updateDrawerWidth(width);
      currentWidth = width;
    }
  } else {
    // No saved width - sync drawer with default panel width
    updateDrawerWidth(getDefaultDrawerWidth());
  }

  function startDrag(handle, e) {
    isDragging = true;
    activeHandle = handle;
    handle.classList.add('dragging');
    document.body.classList.add('resizing-drawer');
    e.preventDefault();
  }

  function resetToDefault() {
    const defaultWidth = getDefaultDrawerWidth();
    shell.style.gridTemplateColumns = `minmax(0, 1fr) ${defaultWidth}px`;
    updateDrawerWidth(defaultWidth);
    currentWidth = defaultWidth;
    localStorage.removeItem(DRAWER_RESIZE_KEY);
  }

  // Set up event listeners for both handles
  if (panelHandle) {
    panelHandle.addEventListener('mousedown', (e) => startDrag(panelHandle, e));
    panelHandle.addEventListener('dblclick', resetToDefault);
  }
  if (drawerHandle) {
    drawerHandle.addEventListener('mousedown', (e) => startDrag(drawerHandle, e));
    drawerHandle.addEventListener('dblclick', resetToDefault);
  }

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    // For drawer overlay, calculate width from right edge of viewport
    const newWidth = Math.max(DRAWER_MIN_WIDTH, Math.min(getDrawerMaxWidth(), window.innerWidth - e.clientX));
    shell.style.gridTemplateColumns = `minmax(0, 1fr) ${newWidth}px`;
    updateDrawerWidth(newWidth);
    currentWidth = newWidth;
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      if (activeHandle) {
        activeHandle.classList.remove('dragging');
      }
      activeHandle = null;
      document.body.classList.remove('resizing-drawer');
      // Save width to localStorage
      if (currentWidth !== null) {
        localStorage.setItem(DRAWER_RESIZE_KEY, String(currentWidth));
      }
    }
  });
}
