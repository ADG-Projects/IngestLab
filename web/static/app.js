document.addEventListener('DOMContentLoaded', () => {
  applyLanguageDirection();
  initDrawerAutoCondense();
  const sel = $('elementsTypeSelect');
  if (sel) sel.addEventListener('change', async () => {
    CURRENT_TYPE_FILTER = sel.value || 'All';
    populateTypeSelectors();
    await drawBoxesForCurrentPage();
  });
  const reviewSel = $('elementsReviewSelect');
  if (reviewSel) reviewSel.addEventListener('change', () => {
    CURRENT_ELEMENT_REVIEW_FILTER = reviewSel.value || 'All';
    renderElementsListForCurrentPage(CURRENT_PAGE_BOXES);
    refreshElementOverlaysForCurrentPage();
  });
  const elementViewToggle = $('elementViewToggle');
  if (elementViewToggle) {
    elementViewToggle.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-mode]');
      if (!btn) return;
      const mode = btn.dataset.mode === 'outline' ? 'outline' : 'flat';
      setElementViewMode(mode);
      syncElementViewToggle();
      renderElementsListForCurrentPage(CURRENT_PAGE_BOXES);
    });
  }
  const langSel = $('settingPrimaryLang');
  if (langSel) langSel.addEventListener('change', () => {
    const nextLang = normalizeLangCode(langSel.value) || 'eng';
    if (CURRENT_DOC_LANGUAGE === nextLang) return;
    CURRENT_DOC_LANGUAGE = nextLang;
    applyLanguageDirection();
  });
  init().catch(err => {
    console.error(err);
    alert(`Failed to initialize UI: ${err.message}`);
  });
});
