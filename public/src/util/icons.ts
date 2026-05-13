// SVG line-icon catalogue + runtime hydrator.
//
// Markup author writes `<i data-icon="lock"></i>` (optional
// `data-icon-size="18"`); at runtime `mountIcons(root)` swaps it for the
// matching inline <svg>. Stroke is `currentColor` so the icon inherits its
// container's color — no per-icon color tokens.
//
// Why a runtime swap instead of inline <svg> in the HTML:
//   - `index.html` stays short and grep-able; one source of truth for each
//     icon path lives here.
//   - Pane cloning (panes/init.ts:mountRightPane) clones the left pane DOM
//     to make the right pane; if the icons were already <svg> at HTML-author
//     time, fine — but if a feature module injects `<i data-icon>` into a
//     dynamic row, the same hydrator runs on that subtree and Just Works.
//
// Idempotent: <svg> elements don't match `i[data-icon]`, so calling
// `mountIcons` twice on the same root is a no-op the second pass.

const ICONS: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6l-12 12"/>',
  check: '<path d="M5 12.5l4 4 10-10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  chevron_right: '<path d="M9 6l6 6-6 6"/>',
  chevron_down: '<path d="M6 9l6 6 6-6"/>',
  chevron_up: '<path d="M6 15l6-6 6 6"/>',
  chevron_left: '<path d="M15 6l-6 6 6 6"/>',
  arrow_up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrow_down: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  arrow_right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  download: '<path d="M12 4v12M6 10l6 6 6-6"/><path d="M4 18v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
  folder_plus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M12 11v6M9 14h6"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/>',
  reindex: '<path d="M3 12a9 9 0 0 1 9-9c2.5 0 4.7 1 6.4 2.6L21 8"/><path d="M21 3v5h-5"/><circle cx="12" cy="14" r="2"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M10 11v6M14 11v6"/>',
  edit: '<path d="M4 20h4l11-11-4-4L4 16v4z"/><path d="M14 6l4 4"/>',
  rename: '<path d="M4 7v10"/><path d="M4 12h16"/><path d="M20 7v10"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  eye_off: '<path d="M3 3l18 18"/><path d="M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.3 4"/><path d="M6.7 7.8A17 17 0 0 0 2 12s3.5 6 10 6c1.4 0 2.7-.2 3.9-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7-2.7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.3 3.1-6 7-6s7 2.7 7 6"/><path d="M16 4a3.5 3.5 0 0 1 0 7"/><path d="M22 20c0-2.7-2-5-5-5.5"/>',
  shield: '<path d="M12 3l8 3v5c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-3z"/>',
  shield_check: '<path d="M12 3l8 3v5c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
  logout: '<path d="M10 17l-5-5 5-5"/><path d="M5 12h13"/><path d="M16 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/>',
  power: '<path d="M12 4v8"/><path d="M16.2 6.8a7 7 0 1 1-8.4 0"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
  moon: '<path d="M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10z"/>',
  dots_h: '<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>',
  dots_v: '<circle cx="12" cy="5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>',
  warn: '<path d="M12 3l10 17H2L12 3z"/><path d="M12 10v5M12 18v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-.6-9.9 6 6 0 0 1 11.6 1.4A4 4 0 0 1 18 18H7z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9"/><path d="M16 7l3 3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.8 3 4.2 6 4.2 9s-1.4 6-4.2 9c-2.8-3-4.2-6-4.2-9s1.4-6 4.2-9z"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3M20 14v3M14 17v4M17 17h4M17 20h-3"/>',
  drag: '<circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
  sliders: '<path d="M4 6h6M14 6h6"/><circle cx="12" cy="6" r="2"/><path d="M4 12h2M10 12h10"/><circle cx="8" cy="12" r="2"/><path d="M4 18h10M18 18h2"/><circle cx="16" cy="18" r="2"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  bucket: '<path d="M5 7l1.5 13a2 2 0 0 0 2 1.7h7a2 2 0 0 0 2-1.7L19 7"/><path d="M4 7h16"/><path d="M8 7c0-2 1.8-4 4-4s4 2 4 4"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4L4 5z"/>',
};

/**
 * Walk `root` and replace every `<i data-icon="X">` with the matching
 * inline SVG. Unknown names are left as-is (the empty `<i>` will be
 * visually blank — easier to spot than a silent failure).
 */
export function mountIcons(root: ParentNode = document): void {
  const els = root.querySelectorAll<HTMLElement>('i[data-icon]');
  els.forEach((el) => {
    const name = el.dataset.icon;
    if (!name) return;
    const paths = ICONS[name];
    if (!paths) return;
    const size = el.dataset.iconSize ?? '16';
    // outerHTML is fine here — `i[data-icon]` carries no listeners or refs
    // we need to preserve. The replacement <svg> matches the same flow box
    // (inline) so layout doesn't shift.
    el.outerHTML =
      `<svg width="${size}" height="${size}" viewBox="0 0 24 24" ` +
      `fill="none" stroke="currentColor" stroke-width="1.5" ` +
      `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
      paths + `</svg>`;
  });
}

/** Exposed for tests / dev tools. Not used by the runtime. */
export const __ICONS_FOR_TEST = ICONS;
