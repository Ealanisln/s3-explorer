// Small form modals: bucket create, folder create, rename, refresh button.
// Grouped here because each is one event handler — wouldn't justify its own file.
//
// Bucket-create is global (not pane-scoped). Folder, rename, and refresh act
// on the currently-active pane; they read State (which proxies to the active
// pane) and target paneEl(...) for the toolbar refresh icon.

import { State, getPane, setActivePane } from '../state.js';
import type { PaneId } from '../state.js';
import { api } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { $, paneEl, openModal, closeModal } from '../util/dom.js';
import { loadObjects } from './grid.js';
import { renderBuckets } from '../buckets/list.js';
import { selectConnection } from '../connections/list.js';
import type { Connection } from '../types.js';

// Bucket create + global rename submit (modals are app-global). Run once.
export function initGlobalForms(): void {
  // Bucket create lives in the sidebar — global.
  $('btn-create-bucket').onclick = (): void => openModal('modal-bucket');
  ($('form-bucket') as HTMLFormElement).onsubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const name = (f.elements.namedItem('name') as HTMLInputElement).value.trim();
    try {
      await api('/api/buckets', { method: 'POST', body: { name } });
      toast('Bucket creado', 'success');
      closeModal('modal-bucket');
      const { buckets } = await api<{ buckets: { Name: string; CreationDate: string | null }[] }>('/api/buckets');
      State.buckets = buckets;
      renderBuckets();
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
