// Object info side panel — opens on row click, shows metadata + actions.

import { State } from '../state.js';
import { api } from '../api/client.js';
import { toast } from '../util/toast.js';
import { $, escapeHtml } from '../util/dom.js';
import { formatSize, formatDate, fileIcon } from '../util/format.js';
import { openPreview } from './preview.js';
import { downloadObject, shareObject, openRename } from './actions.js';
import type { S3Object } from '../types.js';

let currentInfoObj: S3Object | null = null;

let onObjectsChanged: () => void | Promise<void> = () => undefined;

export function configureInfoPanel(deps: { onObjectsChanged: () => void | Promise<void> }): void {
  onObjectsChanged = deps.onObjectsChanged;
}

export function openInfoPanel(o: S3Object): void {
  currentInfoObj = o;
  const panel = $('info-panel');
  document.querySelector('.main')?.classList.add('with-info');
  panel.classList.add('open');

  const name = o.Key.split('/').pop() || o.Key;
  const folder = o.Key.slice(0, o.Key.length - name.length);
  const ico = fileIcon(name);
  const iconEl = $('info-icon');
  iconEl.className = 'icon-file ' + ico.cls;
  iconEl.textContent = ico.label;
  $('info-name').textContent = name;
  $('info-path').textContent = folder || '(raíz)';

  const meta = $('info-meta');
  setMetaCell(meta, 'size', formatSize(o.Size));
  setMetaCell(meta, 'modified', formatDate(o.LastModified));
  setMetaCell(meta, 'etag', (o.ETag || '—').replace(/"/g, ''));
  setMetaCell(meta, 'storage-class', o.StorageClass || 'STANDARD');
  setMetaCell(meta, 'content-type', 'Cargando...');
  setMetaCell(meta, 'version-id', o.VersionId || '—');
  $('info-user-meta-wrap').style.display = 'none';

  void loadHead(o);
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

async function loadHead(o: S3Object): Promise<void> {
  const meta = $('info-meta');
  try {
    const params = new URLSearchParams({ key: o.Key });
    if (o.VersionId) params.set('versionId', o.VersionId);
    const head = await api<HeadResponse>(`/api/object/${encodeURIComponent(State.activeBucket || '')}/head?${params}`);
    setMetaCell(meta, 'content-type', head.ContentType || 'application/octet-stream');
    if (head.VersionId) setMetaCell(meta, 'version-id', head.VersionId);
    const userMeta = head.Metadata || {};
    const entries = Object.entries(userMeta);
    if (entries.length) {
      const dl = $('info-user-meta');
      dl.innerHTML = entries.map(([k, v]) =>
        `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`,
      ).join('');
      $('info-user-meta-wrap').style.display = 'block';
    }
  } catch (e) {
    setMetaCell(meta, 'content-type', `(error: ${(e as Error).message})`);
  }
}

export function closeInfoPanel(): void {
  $('info-panel').classList.remove('open');
  document.querySelector('.main')?.classList.remove('with-info');
  currentInfoObj = null;
}

export function initInfoPanel(): void {
  $('info-close').onclick = closeInfoPanel;
  $('info-preview').onclick = (): void => { if (currentInfoObj) void openPreview(currentInfoObj); };
  $('info-download').onclick = (): void => { if (currentInfoObj) downloadObject(currentInfoObj.Key); };
  $('info-share').onclick = (): void => { if (currentInfoObj) void shareObject(currentInfoObj.Key); };
  $('info-versions').onclick = (): void => {
    if (!currentInfoObj) return;
    void openPreview(currentInfoObj);
    setTimeout(() => ($('btn-show-versions') as HTMLButtonElement).click(), 200);
  };
  $('info-rename').onclick = (): void => { if (currentInfoObj) openRename(currentInfoObj.Key); };
  $('info-delete').onclick = async (): Promise<void> => {
    if (!currentInfoObj) return;
    const key = currentInfoObj.Key;
    if (!confirm(`Eliminar "${key}"?`)) return;
    try {
      await api(`/api/object/${encodeURIComponent(State.activeBucket || '')}`, {
        method: 'DELETE',
        body: { key },
      });
      toast('Eliminado', 'success');
      closeInfoPanel();
      await onObjectsChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
}
