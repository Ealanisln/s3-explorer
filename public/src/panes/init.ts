// Two-pane explorer wiring.
//
// The left pane is the static HTML in index.html. The right pane is a deep
// clone of that same DOM, attached at boot so every init*() function can
// be called for both panes uniformly. The right pane is hidden via the
// CSS `.pane[hidden]` rule until the user toggles dual-mode on.
//
// Click-to-activate: any click inside a pane sets State.activePane, which
// drives the Proxy on State so all subsequent State reads/writes target
// the focused pane.
//
// Mobile (≤ 900px): the dual-mode toggle is hidden by CSS and dualMode is
// forced off so the layout collapses back to a single pane. A resize
// listener flips dualMode off if the user crosses the breakpoint while in
// dual mode.

import { State, setActivePane, getPane, emit } from '../state.js';
import type { PaneId } from '../state.js';
import { $, paneRoot } from '../util/dom.js';

const MOBILE_MAX = 900;

function isMobile(): boolean {
  return window.matchMedia(`(max-width: ${MOBILE_MAX}px)`).matches;
}

// Boot the right-pane DOM as a clone of the left. Strips any `id` attributes
// from the clone so we don't collide with the left pane's ids; pane-scoped
// elements are addressed by data-el, not id, so the clone keeps working.
export function mountRightPane(): void {
  if (document.querySelector('.pane[data-pane="right"]')) return; // idempotent
  const left = document.querySelector<HTMLElement>('.pane[data-pane="left"]');
  const wrap = document.querySelector<HTMLElement>('#panes-wrap');
  if (!left || !wrap) throw new Error('[panes] missing left pane / wrap');
  const right = left.cloneNode(true) as HTMLElement;
  right.dataset.pane = 'right';
  right.classList.remove('active');
  right.hidden = true;
  // Strip ids from the clone so the few static ids inside (btn-menu,
  // btn-first-conn, btn-toggle-dual) don't get duplicated.
  right.querySelectorAll<HTMLElement>('[id]').forEach((el) => el.removeAttribute('id'));
  // Reset transient UI state on the clone so it starts clean.
  right.querySelectorAll<HTMLElement>('.info-panel').forEach((p) => p.classList.remove('open'));
  right.classList.remove('with-info');
  wrap.appendChild(right);
}

// Wire click-to-activate on both panes.
export function initActivation(): void {
  for (const p of ['left', 'right'] as PaneId[]) {
    const root = paneRoot(p);
    // Use mousedown so it fires before any click handlers that read activePane.
    root.addEventListener('mousedown', () => setActivePane(p), true);
    root.addEventListener('focusin', () => setActivePane(p));
  }
}

export function setDualMode(on: boolean): void {
  if (isMobile() && on) return; // mobile is single-pane only
  State.dualMode = on;
  const wrap = $('panes-wrap');
  wrap.classList.toggle('dual', on);
  const right = document.querySelector<HTMLElement>('.pane[data-pane="right"]');
  if (right) right.hidden = !on;
  if (!on) {
    // Collapse back to left: if active was right, restore to left.
    if (State.activePane === 'right') setActivePane('left');
  }
  syncActiveClass();
  emit('dualMode');
}

function syncActiveClass(): void {
  for (const p of ['left', 'right'] as PaneId[]) {
    const el = document.querySelector<HTMLElement>(`.pane[data-pane="${p}"]`);
    if (el) el.classList.toggle('active', State.activePane === p && State.dualMode);
  }
}

export function initDualToggle(): void {
  const btn = document.getElementById('btn-toggle-dual') as HTMLButtonElement | null;
  if (!btn) return;
  btn.onclick = (): void => setDualMode(!State.dualMode);

  // Mobile guard: if we cross into mobile while in dual mode, drop back to single.
  window.addEventListener('resize', () => {
    if (isMobile() && State.dualMode) setDualMode(false);
  });

  // Keep the visual border in sync as activePane changes.
  document.addEventListener('mousedown', syncActiveClass, true);
}

// When the right pane is mounted but never had a bucket/conn opened, render
// a friendly placeholder so it isn't just a blank column.
export function paintRightPanePlaceholder(): void {
  const pane = getPane('right');
  if (pane.activeConnId || pane.activeBucket) return;
  const empty = document.querySelector<HTMLElement>('.pane[data-pane="right"] [data-el="empty"]');
  if (!empty) return;
  empty.style.display = 'block';
  empty.innerHTML = '<h2>Panel derecho</h2><p>Selecciona una conexión y un bucket en la barra lateral. La selección se aplica al panel activo (haz clic en este panel primero).</p>';
}
