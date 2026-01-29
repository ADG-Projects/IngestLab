async function loadElementPreview(elementId) {
  try {
    const payload = await fetchJSON(withProvider(`/api/element/${encodeURIComponent(CURRENT_SLUG)}/${encodeURIComponent(elementId)}`));
    return payload;
  } catch (e) {
    showToast(`Failed to load element preview: ${e.message}`, 'err');
    return null;
  }
}

// Window exports
window.loadElementPreview = loadElementPreview;
