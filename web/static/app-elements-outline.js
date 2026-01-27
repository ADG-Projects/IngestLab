/**
 * Element hierarchy building and outline rendering
 * Extracted from app-elements.js for modularity
 */

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

const ELEMENT_OUTLINE_ORDER = [
  { type: 'pageHeader', label: 'Page header' },
  { type: 'pageNumber', label: 'Page number' },
  { type: 'Table', label: 'Tables' },
  { type: 'Figure', label: 'Figures' },
  { type: 'Paragraph', label: 'Paragraphs' },
  { type: 'Line', label: 'Lines' },
];

function outlineLabelForType(type) {
  const meta = ELEMENT_OUTLINE_ORDER.find((o) => o.type === type);
  return meta ? meta.label : (type || 'Unknown');
}

function findContainedElements(parentEntry, items, allowedTypes, skipIds = null) {
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
    if (skipIds && skipIds.has(id)) continue;
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

function buildElementHierarchy(filteredEntries) {
  const sorted = Array.isArray(filteredEntries) ? filteredEntries.slice() : [];
  sorted.sort((a, b) => {
    const ea = a[1] || {};
    const eb = b[1] || {};
    const ya = Number(ea.y || 0) - Number(eb.y || 0);
    if (ya !== 0) return ya;
    return Number(ea.x || 0) - Number(eb.x || 0);
  });
  const childMap = new Map();
  const childIds = new Set();
  const byArea = sorted.slice().sort((a, b) => {
    const ea = a[1] || {};
    const eb = b[1] || {};
    const areaA = Number(ea.w || 0) * Number(ea.h || 0);
    const areaB = Number(eb.w || 0) * Number(eb.h || 0);
    if (areaA !== areaB) return areaA - areaB;
    const ya = Number(ea.y || 0) - Number(eb.y || 0);
    if (ya !== 0) return ya;
    return Number(ea.x || 0) - Number(eb.x || 0);
  });
  for (const item of byArea) {
    const [id, entry] = item;
    if (!entry) continue;
    const allowedChildren = containerChildTypes(entry.type);
    if (!allowedChildren) continue;
    const children = findContainedElements(entry, sorted, allowedChildren, childIds);
    if (children.length) {
      childMap.set(id, children);
      children.forEach(([cid]) => childIds.add(cid));
    }
  }
  const roots = sorted.filter(([id]) => !childIds.has(id));
  return { sorted, childMap, childIds, roots };
}

function outlineExpandedChildren(filteredEntries) {
  const effectiveMode = isAzureProvider() ? CURRENT_ELEMENT_VIEW_MODE : 'flat';
  if (effectiveMode !== 'outline') return null;
  const expandedMap = ELEMENT_OUTLINE_STATE?.expanded || {};
  const idsOnPage = new Set(filteredEntries.map(([id]) => id));
  const expandedIds = [];
  for (const [id, isExpanded] of Object.entries(expandedMap)) {
    if (isExpanded && idsOnPage.has(id)) expandedIds.push(id);
  }
  if (!expandedIds.length) return null;
  const { childMap } = buildElementHierarchy(filteredEntries);
  const expandedSet = new Set(expandedIds);
  const cache = new Map();
  const hasExpandedDescendant = (id) => {
    if (cache.has(id)) return cache.get(id);
    const children = childMap.get(id) || [];
    for (const [cid] of children) {
      if (expandedSet.has(cid)) {
        cache.set(id, true);
        return true;
      }
      if (hasExpandedDescendant(cid)) {
        cache.set(id, true);
        return true;
      }
    }
    cache.set(id, false);
    return false;
  };
  const deepestExpanded = expandedIds.filter(id => !hasExpandedDescendant(id));
  const allowed = new Set();

  const addDescendants = (parentId) => {
    const children = childMap.get(parentId) || [];
    for (const [cid] of children) {
      allowed.add(cid);
      addDescendants(cid);
    }
  };

  for (const id of deepestExpanded) {
    addDescendants(id);
  }
  return allowed;
}

function renderElementOutline(host, filtered) {
  const pageNum = Number(filtered[0]?.[1]?.page_trimmed || CURRENT_PAGE || 1);
  const collapse = outlineCollapseState(pageNum);
  const collapsed = collapse.get();
  const byTypeCounts = {};
  const { sorted, childMap, childIds } = buildElementHierarchy(filtered);
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
  counts.textContent = ELEMENT_OUTLINE_ORDER
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
    refreshElementOverlaysForCurrentPage();
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
      const label = outlineLabelForType(t);
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
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'outline-child-toggle';
        toggleBtn.textContent = expanded
          ? summary ? `Hide children (${summary})` : 'Hide children'
          : summary ? `Show children (${summary})` : 'Show children';
        toggleBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          state.set(!expanded);
          renderElementsListForCurrentPage(CURRENT_PAGE_BOXES);
          refreshElementOverlaysForCurrentPage();
        });
        card.appendChild(toggleBtn);
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

// Window exports
window.containerChildTypes = containerChildTypes;
window.ELEMENT_OUTLINE_ORDER = ELEMENT_OUTLINE_ORDER;
window.outlineLabelForType = outlineLabelForType;
window.findContainedElements = findContainedElements;
window.summarizeChildren = summarizeChildren;
window.buildElementHierarchy = buildElementHierarchy;
window.outlineExpandedChildren = outlineExpandedChildren;
window.renderElementOutline = renderElementOutline;
