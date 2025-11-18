document.addEventListener('DOMContentLoaded', () => {
  applyLanguageDirection();
  initDrawerAutoCondense();
  const sel = $('elementsTypeSelect');
  if (sel) sel.addEventListener('change', async () => {
    CURRENT_TYPE_FILTER = sel.value || 'All';
    populateTypeSelectors();
    if (LAST_SELECTED_MATCH && CURRENT_VIEW === 'metrics') {
      drawTargetsOnPage(CURRENT_PAGE, LAST_SELECTED_MATCH, LAST_HIGHLIGHT_MODE === 'best');
    }
    await drawBoxesForCurrentPage();
  });
  const reviewSel = $('elementsReviewSelect');
  if (reviewSel) reviewSel.addEventListener('change', () => {
    CURRENT_ELEMENT_REVIEW_FILTER = reviewSel.value || 'All';
    renderElementsListForCurrentPage(CURRENT_PAGE_BOXES);
    refreshElementOverlaysForCurrentPage();
  });
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
