// Small form modals: bucket create, folder create, rename, refresh button.
// Grouped here because each is one event handler — wouldn't justify its own file.

import { State } from '../state.js';
import { api } from '../api/client.js';
import { toast } from '../util/toast.js';
import { $, openModal, closeModal } from '../util/dom.js';
import { loadObjects } from './grid.js';
import { renderBuckets } from '../buckets/list.js';
import { selectConnection } from '../connections/list.js';
import type { Connection } from '../types.js';

export function initSmallForms(): void {
  // Bucket create
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
      toast((e2 as Error).message, 'error');
    }
  };

  // Folder create
  $('btn-new-folder').onclick = (): void => openModal('modal-folder');
  ($('form-folder') as HTMLFormElement).onsubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const name = (f.elements.namedItem('name') as HTMLInputElement).value.trim();
    try {
      await api(`/api/object/${encodeURIComponent(State.activeBucket || '')}/folder`, {
        method: 'POST',
        body: { prefix: State.prefix, name },
      });
      toast('Carpeta creada', 'success');
      closeModal('modal-folder');
      await loadObjects();
    } catch (e2) {
      toast((e2 as Error).message, 'error');
    }
  };

  // Rename
  ($('form-rename') as HTMLFormElement).onsubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const src = (f.elements.namedItem('sourceKey') as HTMLInputElement).value;
    const newName = (f.elements.namedItem('newName') as HTMLInputElement).value.trim();
    const dest = State.prefix + newName;
    try {
      await api(`/api/object/${encodeURIComponent(State.activeBucket || '')}/rename`, {
        method: 'POST',
        body: { sourceKey: src, destKey: dest },
      });
      toast('Renombrado', 'success');
      closeModal('modal-rename');
      await loadObjects();
    } catch (e2) {
      toast((e2 as Error).message, 'error');
    }
  };

  // Refresh
  $('btn-refresh').onclick = (): void => {
    if (State.activeBucket) void loadObjects();
    else if (State.activeConnId) void selectConnection(State.activeConnId);
  };
}

// Generic backdrop + Escape key wiring (moved from the legacy app.js inline block).
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

  // Click outside → close. Only for non-form modals; form modals require an
  // explicit close/submit so a stray click doesn't drop the user's data.
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

  // Esc closes any visible modal except the passphrase (that one needs an
  // explicit action — the vault must be unlocked or created).
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll<HTMLElement>('.modal-backdrop')]
      .filter((b) => b.style.display !== 'none' && b.id !== 'modal-passphrase');
    if (open.length) open[open.length - 1].style.display = 'none';
  });
}

// Lock button — closes the vault. Imported here because the button lives in
// the sidebar alongside the small form triggers.
let onLock: () => void = () => undefined;

export function configureLock(deps: { onLock: () => void }): void {
  onLock = deps.onLock;
}

export function initLockButton(): void {
  $('btn-lock').onclick = (): void => {
    onLock();
  };
}

// Unused helper kept for symmetry with the old API.
export type _ConnRef = Connection;
