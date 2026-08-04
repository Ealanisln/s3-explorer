// Bucket open/versioning logic. The actual sidebar rendering lives in
// connections/list.ts now (single tree). This file only exposes:
//   - openBucket(name, paneId): make a bucket active in a pane and load it
//   - loadVersioning(paneId): hydrate the versioning state for the toolbar
//
// We keep these here so the import graph stays acyclic — connections/list.ts
// imports from us, not the other way around. The tree renderer is plugged in
// via setTreeRenderer() at boot.

import { State, getPane } from '../state.js';
import type { PaneId } from '../state.js';
import { api } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { t } from '../i18n/index.js';
import { paneEl, paneElMaybe } from '../util/dom.js';
import { confirmDialog } from '../util/dialog.js';
import { loadObjects } from '../objects/grid.js';
import { navigateTo } from '../router/index.js';
import { reanchorSyncNav } from '../panes/synced-nav.js';

interface BucketRow { Name: string; CreationDate: string | null }

let renderTree: () => void = () => undefined;
export function setTreeRenderer(fn: () => void): void { renderTree = fn; }

let onBucketOpened: (paneId: PaneId) => void = () => undefined;

export function configureBuckets(deps: { onBucketOpened: (paneId: PaneId) => void }): void {
  onBucketOpened = deps.onBucketOpened;
}

// Kept for legacy callers that used to refresh the bucket list directly. Now
// it just nudges the sidebar tree, which derives its rows from the per-conn
// bucket cache maintained by connections/list.ts.
export function renderBuckets(): void {
  renderTree();
}

export async function openBucket(name: string, paneId?: PaneId): Promise<void> {
  const p: PaneId = paneId || State.activePane;
  const pane = getPane(p);
  pane.activeBucket = name;
  pane.prefix = '';
  // Nav history is scoped to (connId, bucket) — opening a new bucket
  // resets the back/forward stack so the user doesn't get tossed into a
  // prefix that doesn't exist in this bucket.
  pane.navHistory = [''];
  pane.navIndex = 0;
  // Path semantics changed in this pane — silent re-anchor so the user
  // doesn't get a "anclajes actualizados" toast every time they pick a
  // bucket from the sidebar.
  reanchorSyncNav(true);
  renderTree();
  // Sync URL when this happens on the active pane.
  if (p === State.activePane && pane.activeConnId) {
    navigateTo({ connId: pane.activeConnId, bucket: name, prefix: '' });
  }
  await loadVersioning(p);
  await loadObjects(p);
  onBucketOpened(p);
}

export async function loadVersioning(paneId?: PaneId): Promise<void> {
  const p: PaneId = paneId || State.activePane;
  const pane = getPane(p);
  try {
    const { status } = await api<{ status: 'Enabled' | 'Suspended' | 'Disabled' }>(
      `/api/buckets/${encodeURIComponent(pane.activeBucket || '')}/versioning`,
    );
    pane.versioning = status;
    const btn = paneEl('btn-versioning', p) as HTMLButtonElement;
    btn.style.display = 'inline-block';
    const tog = paneElMaybe('toggle-deleted', p);
    if (tog) tog.style.display = status === 'Enabled' ? 'inline-flex' : 'none';
    if (status !== 'Enabled' && pane.showDeleted) {
      pane.showDeleted = false;
      (paneEl('chk-deleted', p) as HTMLInputElement).checked = false;
    }
    if (status === 'Enabled') {
      btn.textContent = t('versioning.on');
      btn.title = t('versioning.onTitle');
      btn.disabled = true;
      btn.onclick = null;
    } else {
      btn.textContent = t('versioning.enable');
      btn.title = t('versioning.enableBtnTitle');
      btn.disabled = false;
      btn.onclick = async (): Promise<void> => {
        const ok = await confirmDialog({
          title: t('versioning.enable'),
          message: t('versioning.enableMessage', { bucket: pane.activeBucket || '' }),
          confirmLabel: t('versioning.enable'),
        });
        if (!ok) return;
        try {
          await api(`/api/buckets/${encodeURIComponent(pane.activeBucket || '')}/versioning`, {
            method: 'PUT',
            body: { enabled: true },
          });
          toast(t('versioning.enabled'), 'success');
          await loadVersioning(p);
        } catch (e) {
          toast((e as Error).message, 'error', errorIdOpts(e));
        }
      };
    }
  } catch {
    pane.versioning = 'Disabled';
  }
}

// Re-export to keep callers happy that imported BucketRow from here previously.
export type { BucketRow };
