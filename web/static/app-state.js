let PDF_DOC = null;
let CURRENT_PAGE = 1;
let PAGE_COUNT = 0;
let SCALE = 1.0; // Will be adjusted to fit viewport
let SCALE_IS_MANUAL = false;
let CURRENT_RENDER_TASK = null;
let CURRENT_SLUG = null;
let BOX_INDEX = {}; // element_id -> {page_trimmed, layout_w,h, x,y,w,h}
let CURRENT_ELEMENT_ID = null;
let CHIP_META = {}; // element_id -> meta from /api/elements
let KNOWN_PDFS = [];
let CURRENT_TAB = 'overview';
let ELEMENT_TYPES = [];
let CHUNK_TYPES = [];
let CURRENT_TYPE_FILTER = 'All';
let CURRENT_CHUNK_TYPE_FILTER = 'All';
let RUNS_CACHE = [];
let CURRENT_RUN = null;
let CURRENT_RUN_CONFIG = null;
let CURRENT_RUN_HAS_CHUNKS = false;
let CURRENT_CHUNKS = null;
let CURRENT_CHUNK_LOOKUP = {};
let CURRENT_CHUNK_SUMMARY = null;
let SHOW_CHUNK_OVERLAYS = true;
let SHOW_ELEMENT_OVERLAYS = true;
let CURRENT_VIEW = 'inspect';
let INSPECT_TAB = 'elements';
let CURRENT_INSPECT_ELEMENT_ID = null;
let RUN_PREVIEW_DOC = null;
let RUN_PREVIEW_PAGE = 1;
let RUN_PREVIEW_COUNT = 0;
let RUN_RANGE_START = null;
let HINTED_HIRES = false;
let RETURN_TO = null;
let CURRENT_DOC_LANGUAGE = 'eng';
let CURRENT_REVIEWS = {
  slug: null,
  items: [],
  summary: {
    overall: { good: 0, bad: 0, total: 0 },
    chunks: { good: 0, bad: 0, total: 0 },
    elements: { good: 0, bad: 0, total: 0 },
  },
};
let REVIEW_LOOKUP = {};
let REVIEW_NOTE_DRAFTS = {};
let CURRENT_CHUNK_REVIEW_FILTER = 'All';
let CURRENT_ELEMENT_REVIEW_FILTER = 'All';
let CURRENT_PAGE_BOXES = null;
let CURRENT_CHUNK_DRAWER_ID = null;
let CURRENT_ELEMENT_DRAWER_ID = null;
let CURRENT_RUN_JOB_ID = null;
let CURRENT_RUN_JOB_STATUS = null;
let CURRENT_PROVIDER = 'unstructured';
let CURRENT_ELEMENT_VIEW_MODE = 'flat'; // 'flat' | 'outline'
let ELEMENT_OUTLINE_STATE = { collapsedByPage: {}, expanded: {} };

const RTL_AWARE_ELEMENTS = new Set();
const TABLE_PREVIEW_ELEMENTS = new Set();

const $ = (id) => document.getElementById(id);

function isArabicDocument() {
  return CURRENT_DOC_LANGUAGE === 'ara';
}

function applyDirectionalText(element, options = {}) {
  if (!element) return;
  const { align = true, bidi = true, attr = true, track = true } = options;
  const rtl = isArabicDocument();
  const dirValue = rtl ? 'rtl' : 'ltr';
  if (attr !== false) {
    try {
      element.setAttribute('dir', dirValue);
    } catch (_) {}
  }
  if (element.style) {
    element.style.direction = dirValue;
    if (align) element.style.textAlign = rtl ? 'right' : 'left';
    if (bidi) element.style.unicodeBidi = 'plaintext';
  }
  if (track) RTL_AWARE_ELEMENTS.add(element);
}

function applyTablePreviewDirection(element, options = {}) {
  if (!element) return;
  const { track = true } = options;
  const rtl = isArabicDocument();
  try {
    element.setAttribute('dir', 'ltr');
  } catch (_) {}
  if (element.style) {
    element.style.direction = 'ltr';
    element.style.unicodeBidi = 'plaintext';
  }
  const cells = element.querySelectorAll('td, th');
  if (cells.length) {
    cells.forEach((cell) => {
      if (cell.style) {
        cell.style.direction = rtl ? 'rtl' : 'ltr';
        cell.style.textAlign = rtl ? 'right' : 'left';
        cell.style.unicodeBidi = 'plaintext';
      }
      try {
        cell.setAttribute('dir', rtl ? 'rtl' : 'ltr');
      } catch (_) {}
    });
  }
  if (track) TABLE_PREVIEW_ELEMENTS.add(element);
}

function refreshTablePreviewDirections() {
  for (const tableEl of Array.from(TABLE_PREVIEW_ELEMENTS)) {
    if (!tableEl.isConnected) {
      TABLE_PREVIEW_ELEMENTS.delete(tableEl);
      continue;
    }
    applyTablePreviewDirection(tableEl, { track: false });
  }
}

function refreshDirectionalElements() {
  for (const el of Array.from(RTL_AWARE_ELEMENTS)) {
    if (!el.isConnected) {
      RTL_AWARE_ELEMENTS.delete(el);
      continue;
    }
    applyDirectionalText(el, { track: false });
  }
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
  return r.json();
}

function applyLanguageDirection() {
  const isArabic = isArabicDocument();
  console.log('[RTL Debug] applyLanguageDirection called:', {
    CURRENT_DOC_LANGUAGE,
    isArabic,
  });
  refreshDirectionalElements();
  refreshTablePreviewDirections();
  console.log('[RTL Debug] After toggle:', {
    CURRENT_DOC_LANGUAGE,
    isArabic,
  });
}

function normalizeLangCode(value) {
  if (value === undefined || value === null) return null;
  const txt = String(value).trim().toLowerCase();
  if (!txt) return null;
  if (txt.startsWith('ar')) return 'ara';
  if (txt.startsWith('en')) return 'eng';
  return null;
}

function extractLangFromList(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    let fallback = null;
    for (const part of value) {
      if (part && typeof part === 'object') {
        const candidate =
          part.locale ||
          part.language ||
          part.language_code ||
          part.languageCode ||
          part.code;
        const code = normalizeLangCode(candidate);
        if (code === 'ara') return 'ara';
        if (!fallback && code) fallback = code;
      } else {
        const code = normalizeLangCode(part);
        if (code === 'ara') return 'ara';
        if (!fallback && code) fallback = code;
      }
    }
    return fallback;
  }
  if (typeof value === 'string') {
    const parts = value.split(/[\s,;+]+/);
    let fallback = null;
    for (const part of parts) {
      const code = normalizeLangCode(part);
      if (code === 'ara') return 'ara';
      if (!fallback && code) fallback = code;
    }
    if (fallback) return fallback;
  }
  if (value && typeof value === 'object') {
    const code = normalizeLangCode(
      value.locale ||
      value.language ||
      value.language_code ||
      value.languageCode ||
      value.code,
    );
    if (code === 'ara') return 'ara';
    if (code) return code;
  }
  return null;
}

function resolvePrimaryLanguage(cfg, snap) {
  return (
    normalizeLangCode(cfg?.detected_primary_language) ||
    normalizeLangCode(snap?.detected_primary_language) ||
    extractLangFromList(cfg?.detected_languages) ||
    extractLangFromList(snap?.detected_languages) ||
    normalizeLangCode(snap?.primary_language) ||
    normalizeLangCode(cfg?.primary_language) ||
    extractLangFromList(snap?.languages) ||
    extractLangFromList(cfg?.languages) ||
    normalizeLangCode(snap?.ocr_languages) ||
    normalizeLangCode(cfg?.ocr_languages) ||
    'eng'
  );
}

function providerParam(provider = CURRENT_PROVIDER || 'unstructured') {
  const p = provider || 'unstructured';
  return `provider=${encodeURIComponent(p)}`;
}

function withProvider(url, provider = CURRENT_PROVIDER || 'unstructured') {
  const param = providerParam(provider);
  return url.includes('?') ? `${url}&${param}` : `${url}?${param}`;
}

function pxRect(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  return { x, y, w, h };
}
