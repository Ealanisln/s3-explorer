// Drag-to-resize for the left sidebar and the right info-panel.
//
// The layout exposes two CSS custom properties — `--sidebar-w` and `--info-w`
// — that drive `#app` (grid template) and `.info-panel` (width). We mutate
// them on `<html>` via inline style so all consumers update at once. Width is
// clamped, persisted to localStorage, and restored at boot.
//
// Right-pane info panel: there's one `.info-panel` per pane (cloned at boot),
// so the handle inside each updates the SAME `--info-w` — both panels stay
// in sync, which matches user expectation.

const LS_SIDEBAR = 's3x-sidebar-w';
const LS_INFO = 's3x-info-w';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 520;
const INFO_MIN = 300;
const INFO_MAX = 720;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function applySidebarW(px: number): void {
  document.documentElement.style.setProperty('--sidebar-w', `${px}px`);
}
function applyInfoW(px: number): void {
  document.documentElement.style.setProperty('--info-w', `${px}px`);
}

function loadStoredWidths(): void {
  const sb = parseInt(localStorage.getItem(LS_SIDEBAR) || '', 10);
  if (Number.isFinite(sb)) applySidebarW(clamp(sb, SIDEBAR_MIN, SIDEBAR_MAX));
  const inf = parseInt(localStorage.getItem(LS_INFO) || '', 10);
  if (Number.isFinite(inf)) applyInfoW(clamp(inf, INFO_MIN, INFO_MAX));
}

// Apply persisted widths AS SOON AS this module is imported — before any
// DOM clone or first paint — so the layout doesn't flash from default values
// to the user's preferred size.
loadStoredWidths();

interface DragState {
  startX: number;
  startW: number;
  apply: (w: number) => void;
  min: number;
  max: number;
  storageKey: string;
  /** -1 → drag-right grows (sidebar). +1 → drag-left grows (info panel). */
  direction: 1 | -1;
}

let active: DragState | null = null;

function onMove(e: PointerEvent): void {
  if (!active) return;
  const delta = (e.clientX - active.startX) * active.direction;
  const next = clamp(active.startW + delta, active.min, active.max);
  active.apply(next);
}

function onUp(): void {
  if (!active) return;
  // Persist final value (read it back from the var to avoid drift).
  const final = parseInt(
    getComputedStyle(document.documentElement).getPropertyValue(
      active.apply === applySidebarW ? '--sidebar-w' : '--info-w',
    ),
    10,
  );
  if (Number.isFinite(final)) {
    try { localStorage.setItem(active.storageKey, String(final)); } catch { /* quota */ }
  }
  document.body.classList.remove('is-resizing');
  document.querySelectorAll<HTMLElement>('.resize-handle.dragging')
    .forEach((el) => el.classList.remove('dragging'));
  active = null;
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
}

function startDrag(handle: HTMLElement, e: PointerEvent): void {
  e.preventDefault();
  const which = handle.dataset.resize;
  if (which !== 'sidebar' && which !== 'info') return;

  // Read current widths from the live computed value of the css var so the
  // drag starts from whatever the user already had (incl. restored value).
  const root = getComputedStyle(document.documentElement);
  const currentSidebar = parseInt(root.getPropertyValue('--sidebar-w'), 10) || 260;
  const currentInfo = parseInt(root.getPropertyValue('--info-w'), 10) || 360;

  if (which === 'sidebar') {
    active = {
      startX: e.clientX,
      startW: currentSidebar,
      apply: applySidebarW,
      min: SIDEBAR_MIN, max: SIDEBAR_MAX,
      storageKey: LS_SIDEBAR,
      direction: 1,  // drag right → grow
    };
  } else {
    active = {
      startX: e.clientX,
      startW: currentInfo,
      apply: applyInfoW,
      min: INFO_MIN, max: INFO_MAX,
      storageKey: LS_INFO,
      direction: -1,  // info panel sits on the right; drag LEFT → grow
    };
  }

  document.body.classList.add('is-resizing');
  handle.classList.add('dragging');
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

export function initResizers(): void {
  // Delegated so we catch handles on both panes (the right pane is cloned
  // at runtime — listeners on cloned elements are NOT carried over, so we
  // attach at document level).
  document.addEventListener('pointerdown', (e: PointerEvent) => {
    const target = e.target as HTMLElement | null;
    const handle = target?.closest<HTMLElement>('.resize-handle');
    if (!handle) return;
    startDrag(handle, e);
  });
  // Double-click resets to default. Convenient escape hatch.
  document.addEventListener('dblclick', (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const handle = target?.closest<HTMLElement>('.resize-handle');
    if (!handle) return;
    if (handle.dataset.resize === 'sidebar') {
      applySidebarW(260);
      try { localStorage.removeItem(LS_SIDEBAR); } catch { /* ignore */ }
    } else if (handle.dataset.resize === 'info') {
      applyInfoW(360);
      try { localStorage.removeItem(LS_INFO); } catch { /* ignore */ }
    }
  });
}
