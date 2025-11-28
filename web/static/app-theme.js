/**
 * Theme management for Chunking Visualizer
 * Supports system preference detection with manual override
 */

const THEME_KEY = 'chunking-visualizer-theme';

/**
 * Get the preferred theme - checks localStorage first, falls back to system preference
 * @returns {'dark' | 'light' | 'system'}
 */
function getStoredTheme() {
  return localStorage.getItem(THEME_KEY);
}

/**
 * Get the effective theme based on system preference
 * @returns {'dark' | 'light'}
 */
function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * Get the current effective theme
 * @returns {'dark' | 'light'}
 */
function getEffectiveTheme() {
  const stored = getStoredTheme();
  if (stored === 'dark' || stored === 'light') {
    return stored;
  }
  return getSystemTheme();
}

/**
 * Apply theme to the document
 * @param {'dark' | 'light'} theme
 */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeIcon(theme);
  updateChartColors(theme);
}

/**
 * Set and persist theme preference
 * @param {'dark' | 'light' | 'system'} theme
 */
function setTheme(theme) {
  if (theme === 'system') {
    localStorage.removeItem(THEME_KEY);
    applyTheme(getSystemTheme());
  } else {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  }
}

/**
 * Toggle between dark and light themes
 */
function toggleTheme() {
  const current = getEffectiveTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  setTheme(next);
}

/**
 * Update the theme toggle button icon
 * @param {'dark' | 'light'} theme
 */
function updateThemeIcon(theme) {
  const sunIcon = document.getElementById('themeIconSun');
  const moonIcon = document.getElementById('themeIconMoon');
  if (sunIcon && moonIcon) {
    // Show sun when in dark mode (click to go light)
    // Show moon when in light mode (click to go dark)
    sunIcon.style.display = theme === 'dark' ? 'block' : 'none';
    moonIcon.style.display = theme === 'light' ? 'block' : 'none';
  }
}

/**
 * Update Chart.js colors when theme changes
 * @param {'dark' | 'light'} theme
 */
function updateChartColors(theme) {
  // Charts will pick up CSS variables on next render
  // Trigger a refresh if charts exist
  if (typeof window.refreshFeedbackCharts === 'function') {
    window.refreshFeedbackCharts();
  }
}

/**
 * Initialize theme system
 */
function initTheme() {
  // Apply theme immediately to prevent flash
  const theme = getEffectiveTheme();
  applyTheme(theme);

  // Set up toggle button
  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.addEventListener('click', toggleTheme);
  }

  // Listen for system theme changes
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', (e) => {
    // Only auto-switch if user hasn't set a manual preference
    if (!getStoredTheme()) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTheme);
} else {
  initTheme();
}

// Export for other modules
window.getEffectiveTheme = getEffectiveTheme;
window.setTheme = setTheme;
window.toggleTheme = toggleTheme;
