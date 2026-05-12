// Light/dark theme manager.
//
// Three preference states:
//   - 'system'  → follows prefers-color-scheme; live-updates if OS flips.
//   - 'light'   → forces light, ignores OS.
//   - 'dark'    → forces dark, ignores OS.
//
// Storage: a single localStorage key. Reads happen on boot; writes on toggle.
// The FOUC (flash of unstyled colour) is prevented by an inline <script> in
// index.html that sets `<html data-theme="...">` BEFORE the body renders —
// this module owns the same logic but at the runtime level (toggle, live
// system-pref listener, button state).

export type ThemePref = 'system' | 'light' | 'dark';
type Effective = 'light' | 'dark';

const STORAGE_KEY = 's3-explorer-theme-v1';

const mql = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null;

export function loadTheme(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* localStorage may be blocked */ }
  return 'system';
}

export function saveTheme(pref: ThemePref): void {
  try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* ignore */ }
}

function effective(pref: ThemePref): Effective {
  if (pref === 'system') return mql && mql.matches ? 'light' : 'dark';
  return pref;
}

export function applyTheme(pref: ThemePref): void {
  document.documentElement.dataset.theme = effective(pref);
  updateToggleIcon(pref);
}

// Cycle order on click: system → light → dark → system. The icon shows the
// preference (not the effective mode), so the user sees their own choice
// reflected.
const NEXT: Record<ThemePref, ThemePref> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

const ICONS: Record<ThemePref, { glyph: string; title: string }> = {
  system: { glyph: '🌓', title: 'Tema: automático (sigue al sistema)' },
  light: { glyph: '☀️', title: 'Tema: claro' },
  dark: { glyph: '🌙', title: 'Tema: oscuro' },
};

function updateToggleIcon(pref: ThemePref): void {
  const btn = document.getElementById('btn-theme');
  if (!btn) return;
  const cfg = ICONS[pref];
  btn.textContent = cfg.glyph;
  btn.title = cfg.title;
}

export function initThemeToggle(): void {
  const btn = document.getElementById('btn-theme');
  if (!btn) return;
  btn.onclick = (): void => {
    const current = loadTheme();
    const next = NEXT[current];
    saveTheme(next);
    applyTheme(next);
  };

  // Live update if the OS preference flips while we're in 'system' mode.
  if (mql) {
    const handler = (): void => {
      if (loadTheme() === 'system') applyTheme('system');
    };
    if ('addEventListener' in mql) mql.addEventListener('change', handler);
    else (mql as MediaQueryList & { addListener: (h: () => void) => void }).addListener(handler);
  }
}
