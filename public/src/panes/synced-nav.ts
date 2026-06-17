// Synchronized navigation across the two panes (FileZilla-style).
//
// When enabled, navigating into a folder on one side captures a delta
// relative to that pane's ANCHOR (the prefix where sync was switched on)
// and applies the same delta to the other pane's anchor. So if Left starts
// at `/projects/v2/` and Right at `/backup/2026/v2/`, clicking `src/` on
// Left moves Right to `/backup/2026/v2/src/` — both stay in lock-step,
// even across different buckets / connections.
//
// Anchors re-set when:
//   • The user toggles sync OFF then ON again.
//   • The user switches bucket or connection on either pane (silent
//     re-anchor with a leve toast).
//   • The user submits a brand-new path via the breadcrumb edit (explicit
//     baseline reset).
//   • The user picks "Abrir en segundo panel" (that action is itself a
//     baseline reset — sync auto-disables).
//
// Back / forward buttons do NOT propagate — per-pane history stays
// independent so the stacks don't get tangled.

import { State, getPane, setActivePane } from '../state.js';
import type { PaneId } from '../state.js';
import { $, paneEl } from '../util/dom.js';
import { toast } from '../util/toast.js';
import { mountIcons } from '../util/icons.js';

const LS_KEY = 's3x-synced-nav';

// Re-entrancy guard so a sync-driven loadObjects doesn't trigger another
// syncNav from the deeper pane (which would then call loadObjects again).
let syncingInFlight = false;

// Late-bound dependency: the grid module owns loadObjects and we want to
// call it from here without creating a circular import that grid.ts would
// pick up first. Wired from main.ts via setSyncNavDeps().
let loadObjectsFn: (paneId: PaneId) => Promise<void> = async () => undefined;
export function setSyncNavDeps(deps: {
  loadObjects: (paneId: PaneId) => Promise<void>;
}): void {
  loadObjectsFn = deps.loadObjects;
}

function otherPane(paneId: PaneId): PaneId {
  return paneId === 'left' ? 'right' : 'left';
}

function applyEnabledClass(): void {
  document.body.classList.toggle('synced-nav', State.syncNav.enabled);
  const chip = document.getElementById('synced-nav-chip');
  if (chip) chip.style.display = State.syncNav.enabled ? 'inline-flex' : 'none';
  // Both pane toolbars carry a clone of the toggle button (data-el). Refresh
  // the active class + tooltip on every one.
  for (const p of ['left', 'right'] as PaneId[]) {
    const btn = paneEl('btn-sync-nav', p) as HTMLButtonElement | null;
    if (!btn) continue;
    btn.classList.toggle('active', State.syncNav.enabled);
    btn.title = State.syncNav.enabled
      ? `Navegación sincronizada ON · anclajes: ${State.syncNav.leftAnchor || '/'} ↔ ${State.syncNav.rightAnchor || '/'}`
      : 'Activar navegación sincronizada';
  }
}

// Public toggle — called by the button onclick and by `cancelSyncNav` from
// other modules (e.g. openFolderInOtherPane).
export function setSyncNav(enabled: boolean): void {
  if (enabled === State.syncNav.enabled) return;
  if (enabled) {
    // Capture anchors at the current prefixes.
    State.syncNav.leftAnchor = getPane('left').prefix;
    State.syncNav.rightAnchor = getPane('right').prefix;
  }
  State.syncNav.enabled = enabled;
  try { localStorage.setItem(LS_KEY, enabled ? '1' : '0'); } catch { /* quota */ }
  applyEnabledClass();
  if (enabled) {
    toast(`Sync ON · anclajes: ${State.syncNav.leftAnchor || '/'} ↔ ${State.syncNav.rightAnchor || '/'}`, 'success', 4000);
  } else {
    toast('Sync OFF', 'info', 2000);
  }
}

// Convenience for modules that just want "stop syncing" without flipping
// any state diff logic.
export function cancelSyncNav(reason?: string): void {
  if (!State.syncNav.enabled) return;
  State.syncNav.enabled = false;
  try { localStorage.setItem(LS_KEY, '0'); } catch { /* ignore */ }
  applyEnabledClass();
  if (reason) toast(`Sync OFF · ${reason}`, 'info', 3000);
}

// Re-anchor at the current pane prefixes without disabling sync. Called when
// the user switches bucket / connection (the path semantics changed) or when
// they explicitly type a new path via the breadcrumb edit.
export function reanchorSyncNav(silent = false): void {
  if (!State.syncNav.enabled) return;
  State.syncNav.leftAnchor = getPane('left').prefix;
  State.syncNav.rightAnchor = getPane('right').prefix;
  applyEnabledClass();
  if (!silent) {
    toast(`Anclajes actualizados: ${State.syncNav.leftAnchor || '/'} ↔ ${State.syncNav.rightAnchor || '/'}`, 'info', 3500);
  }
}

// The core: given a NEW prefix for one pane, compute what the OTHER pane's
// prefix should be and trigger a load. Skips itself if sync is off, if the
// other pane isn't ready, or if we're already mid-sync (re-entrancy guard).
export function syncNav(sourcePaneId: PaneId, newSourcePrefix: string): void {
  if (!State.syncNav.enabled || syncingInFlight) return;
  if (!State.dualMode) return;
  const targetPaneId = otherPane(sourcePaneId);
  const targetPane = getPane(targetPaneId);
  // Other pane needs to be set up — sync silently no-ops otherwise so the
  // source pane's nav still happens.
  if (!targetPane.activeConnId || !targetPane.activeBucket) return;

  const sourceAnchor = sourcePaneId === 'left' ? State.syncNav.leftAnchor : State.syncNav.rightAnchor;
  const targetAnchor = sourcePaneId === 'left' ? State.syncNav.rightAnchor : State.syncNav.leftAnchor;

  let newTargetPrefix: string;
  if (newSourcePrefix.startsWith(sourceAnchor)) {
    // Going INTO the anchor's subtree — apply the same suffix to the
    // target's anchor.
    const rel = newSourcePrefix.slice(sourceAnchor.length);
    newTargetPrefix = targetAnchor + rel;
  } else if (sourceAnchor.startsWith(newSourcePrefix)) {
    // Going ABOVE the anchor — climb the same number of "/" segments on
    // the target and clamp at empty (bucket root).
    const climbed = sourceAnchor.slice(newSourcePrefix.length);
    // Count how many path segments the user climbed past the anchor.
    const climbCount = climbed.split('/').filter(Boolean).length;
    const targetSegs = targetAnchor.split('/').filter(Boolean);
    const remaining = targetSegs.slice(0, Math.max(0, targetSegs.length - climbCount));
    newTargetPrefix = remaining.length ? remaining.join('/') + '/' : '';
    // Update anchors so future navigation continues relative to the new
    // baseline — otherwise the relative math breaks once you're outside.
    if (sourcePaneId === 'left') {
      State.syncNav.leftAnchor = newSourcePrefix;
      State.syncNav.rightAnchor = newTargetPrefix;
    } else {
      State.syncNav.rightAnchor = newSourcePrefix;
      State.syncNav.leftAnchor = newTargetPrefix;
    }
  } else {
    // Source jumped to something that's neither a descendant nor an
    // ancestor of its anchor (typical of breadcrumb-edit). Re-anchor
    // silently: caller is expected to call reanchorSyncNav() explicitly
    // for the breadcrumb-edit path, so just leave the target alone here.
    return;
  }

  if (newTargetPrefix === targetPane.prefix) return; // already there

  syncingInFlight = true;
  targetPane.prefix = newTargetPrefix;
  void loadObjectsFn(targetPaneId).finally(() => {
    syncingInFlight = false;
    applyEnabledClass(); // refresh tooltip if anchors moved
  });
}

export function initSyncNavToggle(): void {
  // Restore persisted state. Anchors are NOT persisted — they're set anew
  // when the user toggles ON, and the panes' current prefixes at boot
  // become the new baselines if sync was on at last reload.
  if (localStorage.getItem(LS_KEY) === '1') {
    State.syncNav.enabled = true;
    State.syncNav.leftAnchor = getPane('left').prefix;
    State.syncNav.rightAnchor = getPane('right').prefix;
  }
  applyEnabledClass();

  // Wire the per-pane toggle button. Both panes get the same click handler;
  // either one toggles the global sync state.
  for (const p of ['left', 'right'] as PaneId[]) {
    const btn = paneEl('btn-sync-nav', p) as HTMLButtonElement | null;
    if (!btn) continue;
    btn.onclick = (): void => {
      setActivePane(p);
      setSyncNav(!State.syncNav.enabled);
    };
  }

  // Wire the floating chip's dismiss link.
  const chipDismiss = document.getElementById('synced-nav-chip-dismiss');
  if (chipDismiss) {
    chipDismiss.onclick = (): void => setSyncNav(false);
  }
  mountIcons($('synced-nav-chip'));
}
