// Small form modals: bucket create, folder create, rename, refresh button.
// Grouped here because each is one event handler — wouldn't justify its own file.
//
// Bucket-create is global (not pane-scoped). Folder, rename, and refresh act
// on the currently-active pane; they read State (which proxies to the active
// pane) and target paneEl(...) for the toolbar refresh icon.

import { State, getPane, setActivePane, adoptPaneState } from '../state.js';
import type { PaneId } from '../state.js';
import { api } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { $, paneEl, openModal, closeModal } from '../util/dom.js';
import { loadObjects } from './grid.js';
import { selectConnection, refreshActiveConnBuckets, renderConnections } from '../connections/list.js';
import { loadVersioning } from '../buckets/list.js';
import { setDualMode } from '../panes/init.js';
import type { Connection } from '../types.js';

// Close one pane in dual mode. Closing the RIGHT pane just collapses back to
// the (already-visible) left view. Closing the LEFT pane migrates the right
// pane's full state into the left slot so the surviving content becomes the
// single view, then repaints.
function closePane(closing: PaneId): void {
  if (closing === 'left') {
    adoptPaneState('left', 'right');
    setActivePane('left');
    setDualMode(false);
    // Repaint the (now single) left pane from the migrated state.
    renderConnections(); // sidebar highlight + bucket list follow the new conn
    const left = getPane('left');
    if (left.activeBucket) {
      void loadVersioning('left');
      void loadObjects('left');
    } else if (left.activeConnId) {
      void selectConnection(left.activeConnId, 'left');
    }
    return;
  }
  // Closing the right pane: left is already the single view, nothing to move.
  setActivePane('left');
  setDualMode(false);
}

// Bucket create + global rename submit (modals are app-global). Run once.
export function initGlobalForms(): void {
  // Bucket create modal is opened from each connection row's "+" button in the
  // sidebar tree (see connections/list.ts). The submit handler here just runs
  // POST /api/buckets against whatever connection is active for the focused pane.
  ($('form-bucket') as HTMLFormElement).onsubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const name = (f.elements.namedItem('name') as HTMLInputElement).value.trim();
    try {
      await api('/api/buckets', { method: 'POST', body: { name } });
      toast('Bucket creado', 'success');
      closeModal('modal-bucket');
      await refreshActiveConnBuckets();
      State.buckets = getPane().buckets;
    } catch (e2) {
      toast((e2 as Error).message, 'error', errorIdOpts(e2));
    }
  };

  // Rename submits against the active pane's bucket/prefix.
  ($('form-rename') as HTMLFormElement).onsubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const src = (f.elements.namedItem('sourceKey') as HTMLInputElement).value;
    const newName = (f.elements.namedItem('newName') as HTMLInputElement).value.trim();
    const pane = getPane();
    const dest = pane.prefix + newName;
    try {
      await api(`/api/object/${encodeURIComponent(pane.activeBucket || '')}/rename`, {
        method: 'POST',
        body: { sourceKey: src, destKey: dest },
      });
      toast('Renombrado', 'success');
      closeModal('modal-rename');
      await loadObjects();
    } catch (e2) {
      toast((e2 as Error).message, 'error', errorIdOpts(e2));
    }
  };

  // Folder create submits against the active pane's bucket/prefix.
  ($('form-folder') as HTMLFormElement).onsubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const name = (f.elements.namedItem('name') as HTMLInputElement).value.trim();
    const pane = getPane();
    try {
      await api(`/api/object/${encodeURIComponent(pane.activeBucket || '')}/folder`, {
        method: 'POST',
        body: { prefix: pane.prefix, name },
      });
      toast('Carpeta creada', 'success');
      closeModal('modal-folder');
      await loadObjects();
    } catch (e2) {
      toast((e2 as Error).message, 'error', errorIdOpts(e2));
    }
  };
}

// Per-pane wiring: new-folder + refresh buttons in each toolbar.
export function initPaneForms(paneId: PaneId): void {
  paneEl('btn-new-folder', paneId).onclick = (): void => {
    setActivePane(paneId);
    openModal('modal-folder');
  };

  paneEl('btn-refresh', paneId).onclick = (): void => {
    setActivePane(paneId);
    const pane = getPane(paneId);
    if (pane.activeBucket) void loadObjects(paneId);
    else if (pane.activeConnId) void selectConnection(pane.activeConnId);
  };

  // Dedicated "close this pane" button. Shown on BOTH panes in dual mode so
  // the user can close whichever one they want — closing the left pane
  // migrates the right pane's content into the single view (closePane).
  paneEl('btn-close-pane', paneId).onclick = (): void => {
    closePane(paneId);
  };
}

const FORM_MODALS = new Set([
  'modal-passphrase', 'modal-conn', 'modal-bucket', 'modal-folder',
  'modal-rename', 'modal-account', 'modal-users',
]);

export function initModalDismiss(): void {
  document.querySelectorAll<HTMLElement>('[data-close]').forEach((b) => {
    b.onclick = (): void => {
      const backdrop = b.closest('.modal-backdrop') as HTMLElement | null;
      if (backdrop) backdrop.style.display = 'none';
    };
  });

  document.querySelectorAll<HTMLElement>('.modal-backdrop').forEach((b) => {
    if (FORM_MODALS.has(b.id)) return;
    let downOnBackdrop = false;
    b.addEventListener('mousedown', (e: Event) => {
      downOnBackdrop = (e.target as HTMLElement) === b;
    });
    b.addEventListener('click', (e: Event) => {
      if (downOnBackdrop && (e.target as HTMLElement) === b) b.style.display = 'none';
      downOnBackdrop = false;
    });
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll<HTMLElement>('.modal-backdrop')]
      .filter((b) => b.style.display !== 'none' && b.id !== 'modal-passphrase');
    if (open.length) open[open.length - 1].style.display = 'none';
  });
}

let onLock: () => void = () => undefined;

export function configureLock(deps: { onLock: () => void }): void {
  onLock = deps.onLock;
}

export function initLockButton(): void {
  $('btn-lock').onclick = (): void => {
    onLock();
  };
}

export type _ConnRef = Connection;
