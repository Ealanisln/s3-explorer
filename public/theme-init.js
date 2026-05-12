// Synchronous, tiny, runs BEFORE the stylesheet paints to prevent the
// flash-of-wrong-theme on cold load. Reads the same localStorage key as
// public/src/util/theme.ts (the runtime module that owns the toggle).
//
// Kept in /public/ (not /public/src/) because it's pre-compiled JS, not
// a TS-source module — it has to ship as-is and run before any imports
// resolve.
//
// CSP-friendly: served same-origin, picked up by `script-src 'self'`.
(function () {
  try {
    var k = 's3-explorer-theme-v1';
    var pref = localStorage.getItem(k);
    if (pref !== 'light' && pref !== 'dark' && pref !== 'system') pref = 'system';
    var effective = pref === 'system'
      ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : pref;
    document.documentElement.dataset.theme = effective;
  } catch (e) { /* localStorage blocked or no matchMedia — default dark */ }
})();
