function clearBoxes() {
  const overlay = $('overlay');
  overlay.innerHTML = '';
}

function addBox(rect, layoutW, layoutH, isBest = false, type = null, color = null, variant = 'chunk', meta = null) {
  const overlay = $('overlay');
  const canvas = $('pdfCanvas');
  if (!overlay || !canvas || !layoutW || !layoutH) return;
  const overlayWidth = overlay.clientWidth || overlay.offsetWidth || parseFloat(overlay.style.width) || canvas.width;
  const overlayHeight = overlay.clientHeight || overlay.offsetHeight || parseFloat(overlay.style.height) || canvas.height;
  const scaleX = overlayWidth / layoutW;
  const scaleY = overlayHeight / layoutH;
  const el = document.createElement('div');
  const typeClass = type ? ` type-${String(type).replace(/[^A-Za-z0-9_-]/g, '')}` : '';
  el.className = 'box' + (isBest ? ' best' : '') + typeClass;
  if (variant === 'orig') {
    el.classList.add('orig');
  }
  el.style.left = `${rect.x * scaleX}px`;
  el.style.top = `${rect.y * scaleY}px`;
  el.style.width = `${rect.w * scaleX}px`;
  el.style.height = `${rect.h * scaleY}px`;

  const info = meta || {};
  const kind = info.kind || (variant === 'orig' ? 'element' : 'chunk');
  const shortId = (info.id && String(info.id).length > 22) ? `${String(info.id).slice(0, 18)}…` : (info.id || null);
  const titleLines = [];
  if (shortId) titleLines.push(`${kind === 'chunk' ? 'Chunk' : 'Element'} ${shortId}`);
  if (info.type) titleLines.push(`type: ${info.type}`);
  if (Number.isFinite(info.page)) titleLines.push(`page: ${info.page}`);
  if (kind === 'chunk' && Number.isFinite(info.chars)) titleLines.push(`chars: ${info.chars}`);
  if (info.extra) titleLines.push(String(info.extra));
  const tipText = titleLines.join(' · ');
  if (tipText) el.title = tipText;
  const tip = document.createElement('div');
  tip.className = 'box-tip';
  tip.textContent = tipText || (kind === 'chunk' ? 'Chunk' : 'Element');
  el.appendChild(tip);

  el.dataset.kind = kind;
  if (info && info.id) el.dataset.id = String(info.id);
  if (info && info.origId) el.dataset.origId = String(info.origId);
  if (Number.isFinite(info.page)) el.dataset.page = String(info.page);
  el.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const k = el.dataset.kind;
    if (k === 'chunk') {
      const cid = el.dataset.id;
      if (cid) {
        await focusChunkFromOverlay(cid);
        await openChunkDetails(cid);
      }
      return;
    }
    const stableId = el.dataset.id;
    const page = Number(el.dataset.page || CURRENT_PAGE);
    let targetId = stableId;
    if (!targetId && el.dataset.origId) {
      targetId = await findStableIdByOrig(el.dataset.origId, page);
    }
    if (info && info.parentChunkId) {
      const listElRef = document.getElementById('chunkList');
      RETURN_TO = { kind: 'chunk', id: info.parentChunkId, scrollTop: (listElRef ? listElRef.scrollTop : 0) };
    }
    if (targetId) {
      if (page && page !== CURRENT_PAGE) await renderPage(page);
      switchView('inspect');
      switchInspectTab('elements');
      CURRENT_INSPECT_ELEMENT_ID = targetId;
      await drawBoxesForCurrentPage();
      revealElementInList(targetId);
      await openElementDetails(targetId);
    }
  });
  overlay.appendChild(el);
}

function chunkBox(chunk) {
  if (!chunk) return null;
  if (chunk.segment_bbox) return chunk.segment_bbox;
  return chunk.bbox || null;
}

function drawOrigBoxesForChunk(chunkId, pageNum, color) {
  if (!chunkId || !CURRENT_CHUNK_LOOKUP) return;
  const chunk = CURRENT_CHUNK_LOOKUP[chunkId];
  if (!chunk || !chunk.orig_boxes) return;
  const hasSegmentBox = Boolean(chunk.segment_bbox);
  for (const box of chunk.orig_boxes) {
    const t = String(box.type || '').toLowerCase();
    if (t.includes('composite')) continue;
    if (hasSegmentBox && t.includes('table')) continue;
    if (box.page_trimmed !== pageNum) continue;
    if (!(box.layout_w && box.layout_h)) continue;
    const rect = { x: box.x, y: box.y, w: box.w, h: box.h };
    const meta = { kind: 'element', id: null, origId: (box.orig_id || box.element_id || null), type: box.type, page: box.page_trimmed, parentChunkId: chunkId };
    addBox(rect, box.layout_w, box.layout_h, false, box.type, null, 'orig', meta);
  }
}

function drawChunksModeForPage(pageNum) {
  clearBoxes();
  const chunkTypesPresent = new Set();
  const elementTypesPresent = new Set();
  if (!CURRENT_CHUNKS) {
    updateLegend([]);
    return;
  }
  const filteredChunks = getFilteredChunksForCurrentPage(pageNum);
  const selectedChunkId = CURRENT_INSPECT_ELEMENT_ID;
  const selectedChunk = selectedChunkId ? CURRENT_CHUNK_LOOKUP[selectedChunkId] : null;
  const selectedChunkVisible = Boolean(selectedChunk && filteredChunks.some(({ id }) => id === selectedChunkId));

  if (selectedChunk && selectedChunkVisible) {
    if (SHOW_CHUNK_OVERLAYS) {
      const box = chunkBox(selectedChunk);
      if (box && box.page_trimmed === pageNum) {
        const meta = { kind: 'chunk', id: selectedChunk.element_id, type: selectedChunk.type, page: box.page_trimmed, chars: selectedChunk.char_len };
        addBox({ x: box.x, y: box.y, w: box.w, h: box.h }, box.layout_w, box.layout_h, true, selectedChunk.type, null, 'chunk', meta);
        if (selectedChunk.type) chunkTypesPresent.add(selectedChunk.type);
      }
    }
    if (SHOW_ELEMENT_OVERLAYS) {
      drawOrigBoxesForChunk(selectedChunk.element_id, pageNum, null);
      if (selectedChunk.orig_boxes) {
        for (const box of selectedChunk.orig_boxes) {
          if (box.page_trimmed === pageNum && box.type) {
            elementTypesPresent.add(box.type);
          }
        }
      }
    }
  } else {
    if (SHOW_CHUNK_OVERLAYS) {
      for (const { chunk } of filteredChunks) {
        if (!chunk) continue;
        const box = chunkBox(chunk);
        if (box && box.page_trimmed === pageNum) {
          const meta = { kind: 'chunk', id: chunk.element_id, type: chunk.type, page: box.page_trimmed, chars: chunk.char_len };
          addBox({ x: box.x, y: box.y, w: box.w, h: box.h }, box.layout_w, box.layout_h, false, chunk.type, null, 'chunk', meta);
          if (chunk.type) chunkTypesPresent.add(chunk.type);
        }
      }
    }
    if (SHOW_ELEMENT_OVERLAYS) {
      for (const { chunk } of filteredChunks) {
        if (!chunk || !chunk.element_id) continue;
        const box = chunkBox(chunk);
        if (box && box.page_trimmed === pageNum) {
          drawOrigBoxesForChunk(chunk.element_id, pageNum, null);
          if (chunk.orig_boxes) {
            for (const origBox of chunk.orig_boxes) {
              if (origBox.page_trimmed === pageNum && origBox.type) {
                elementTypesPresent.add(origBox.type);
              }
            }
          }
        }
      }
    }
  }

  const typesToShow = SHOW_ELEMENT_OVERLAYS && elementTypesPresent.size > 0
    ? Array.from(elementTypesPresent)
    : Array.from(chunkTypesPresent);
  updateLegend(typesToShow);
}

function drawChunkOverlayForId(chunkId, pageNum) {
  if (!chunkId || !CURRENT_CHUNK_LOOKUP) return;
  const chunk = CURRENT_CHUNK_LOOKUP[chunkId];
  if (!chunk) return;
  const box = chunkBox(chunk);
  if (!box || box.page_trimmed !== pageNum) return;
  clearBoxes();
  const meta = {
    kind: 'chunk',
    id: chunk.element_id,
    type: chunk.type,
    page: box.page_trimmed,
    chars: chunk.char_len,
  };
  addBox({ x: box.x, y: box.y, w: box.w, h: box.h }, box.layout_w, box.layout_h, true, chunk.type, null, 'chunk', meta);
  const typesToShow = chunk.type ? [chunk.type] : [];
  updateLegend(typesToShow);
}

function redrawOverlaysForCurrentContext() {
  if (INSPECT_TAB === 'elements') {
    drawBoxesForCurrentPage();
    return;
  }
  drawChunksModeForPage(CURRENT_PAGE);
}

function colorForId(id, idx = 0) {
  let h = 0;
  if (id) {
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  }
  if (!Number.isFinite(h)) h = 180;
  const rgb = hslToRgb(h / 360, 0.65, 0.50);
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
