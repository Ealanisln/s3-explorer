// Object info side panel — opens on row click, shows metadata + actions.
// One info-panel per pane (cloned with the pane DOM); the active object is
// tracked per-pane so opening info on the left doesn't clobber the right.

import { State, setActivePane, getPane } from '../state.js';
import type { PaneId } from '../state.js';
import { api } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { paneEl, paneRoot, escapeHtml } from '../util/dom.js';
import { confirmDialog } from '../util/dialog.js';
import { formatSize, formatDate, fileIcon } from '../util/format.js';
import { openPreview } from './preview.js';
import { downloadObject, shareObject, openRename } from './actions.js';
import type { S3Object } from '../types.js';

const currentInfoObj: Record<PaneId, S3Object | null> = { left: null, right: null };

let onObjectsChanged: (paneId: PaneId) => void | Promise<void> = () => undefined;

export function configureInfoPanel(deps: { onObjectsChanged: (paneId: PaneId) => void | Promise<void> }): void {
  onObjectsChanged = deps.onObjectsChanged;
}

export function openInfoPanel(o: S3Object, paneId?: PaneId): void {
  const p: PaneId = paneId || State.activePane;
  currentInfoObj[p] = o;
  const panel = paneEl('info-panel', p);
  paneRoot(p).classList.add('with-info');
  panel.classList.add('open');

  const name = o.Key.split('/').pop() || o.Key;
  const folder = o.Key.slice(0, o.Key.length - name.length);
  const ico = fileIcon(name);
  const iconEl = paneEl('info-icon', p);
  iconEl.className = 'ft-badge ' + ico.cls;
  iconEl.textContent = ico.label;
  paneEl('info-name', p).textContent = name;
  paneEl('info-path', p).textContent = folder || '(raíz)';

  const meta = paneEl('info-meta', p);
  setMetaCell(meta, 'size', formatSize(o.Size));
  setMetaCell(meta, 'modified', formatDate(o.LastModified));
  setMetaCell(meta, 'etag', (o.ETag || '—').replace(/"/g, ''));
  setMetaCell(meta, 'storage-class', o.StorageClass || 'STANDARD');
  setMetaCell(meta, 'content-type', 'Cargando...');
  setMetaCell(meta, 'version-id', o.VersionId || '—');
  paneEl('info-user-meta-wrap', p).style.display = 'none';

  void loadHead(o, p);
}

function setMetaCell(meta: HTMLElement, key: string, value: string): void {
  const el = meta.querySelector<HTMLElement>(`[data-k="${key}"]`);
  if (el) el.textContent = value;
}

interface HeadResponse {
  ContentType?: string;
  VersionId?: string;
  Metadata?: Record<string, string>;
}

async function loadHead(o: S3Object, paneId: PaneId): Promise<void> {
  const meta = paneEl('info-meta', paneId);
  const bucket = getPane(paneId).activeBucket || '';
  try {
    const params = new URLSearchParams({ key: o.Key });
    if (o.VersionId) params.set('versionId', o.VersionId);
    const head = await api<HeadResponse>(`/api/object/${encodeURIComponent(bucket)}/head?${params}`);
    setMetaCell(meta, 'content-type', head.ContentType || 'application/octet-stream');
    if (head.VersionId) setMetaCell(meta, 'version-id', head.VersionId);
    const userMeta = head.Metadata || {};
    const entries = Object.entries(userMeta);
    if (entries.length) {
      const dl = paneEl('info-user-meta', paneId);
      dl.innerHTML = entries.map(([k, v]) =>
        `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`,
      ).join('');
      paneEl('info-user-meta-wrap', paneId).style.display = 'block';
    }
  } catch (e) {
    setMetaCell(meta, 'content-type', `(error: ${(e as Error).message})`);
  }
}

export function closeInfoPanel(paneId?: PaneId): void {
  const p: PaneId = paneId || State.activePane;
  paneEl('info-panel', p).classList.remove('open');
  paneRoot(p).classList.remove('with-info');
  currentInfoObj[p] = null;
}

export function initInfoPanel(paneId: PaneId): void {
  paneEl('info-close', paneId).onclick = (): void => closeInfoPanel(paneId);
  paneEl('info-preview', paneId).onclick = (): void => {
    setActivePane(paneId);
    if (currentInfoObj[paneId]) void openPreview(currentInfoObj[paneId]!);
  };
  paneEl('info-download', paneId).onclick = (): void => {
    setActivePane(paneId);
    if (currentInfoObj[paneId]) downloadObject(currentInfoObj[paneId]!.Key);
  };
  paneEl('info-share', paneId).onclick = (): void => {
    setActivePane(paneId);
    if (currentInfoObj[paneId]) void shareObject(currentInfoObj[paneId]!.Key);
  };
  paneEl('info-versions', paneId).onclick = (): void => {
    setActivePane(paneId);
    if (!currentInfoObj[paneId]) return;
    void openPreview(currentInfoObj[paneId]!);
    setTimeout(() => (document.getElementById('btn-show-versions') as HTMLButtonElement)?.click(), 200);
  };
  paneEl('info-rename', paneId).onclick = (): void => {
    setActivePane(paneId);
    if (currentInfoObj[paneId]) openRename(currentInfoObj[paneId]!.Key);
  };
  paneEl('info-delete', paneId).onclick = async (): Promise<void> => {
    setActivePane(paneId);
    const obj = currentInfoObj[paneId];
    if (!obj) return;
    const key = obj.Key;
    const name = key.split('/').pop() || key;
    const ok = await confirmDialog({
      title: 'Eliminar archivo',
      message: `Se eliminará "${name}". ¿Continuar?`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/object/${encodeURIComponent(getPane(paneId).activeBucket || '')}`, {
        method: 'DELETE',
        body: { key },
      });
      toast('Eliminado', 'success');
      closeInfoPanel(paneId);
      await onObjectsChanged(paneId);
    } catch (e) {
      toast((e as Error).message, 'error', errorIdOpts(e));
    }
  };
}
