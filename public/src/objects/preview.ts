// Object preview modal — image / video / audio / pdf / small-text / fallback.
// Includes the versions panel (view / download / share / restore / delete).

import { State } from '../state.js';
import { api, authHeaders } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { $, openModal, escapeHtml } from '../util/dom.js';
import { formatSize, formatDate } from '../util/format.js';
import { mountIcons } from '../util/icons.js';
import { downloadObject, shareObject } from './actions.js';
import type { S3Object } from '../types.js';

interface VersionInfo {
  VersionId: string;
  IsLatest: boolean;
  LastModified: string;
  Size?: number;
  ETag?: string;
  Type: 'version' | 'delete-marker';
}

let currentPreview: S3Object | null = null;
let currentPreviewVersionId: string | null = null;

// onObjectsChanged is invoked when a restore/delete inside the preview modal
// requires refreshing the grid (e.g. restore a version → reload listing).
let onObjectsChanged: () => void | Promise<void> = () => undefined;

export function configurePreview(deps: { onObjectsChanged: () => void | Promise<void> }): void {
  onObjectsChanged = deps.onObjectsChanged;
}

export async function renderPreviewBody(obj: S3Object, versionInfo: VersionInfo | null): Promise<void> {
  const body = $('preview-body');
  body.innerHTML = '<div style="padding:40px;color:var(--text-dim)">Cargando vista previa...</div>';
  const info = $('preview-info');
  const versionId = versionInfo ? versionInfo.VersionId : null;
  currentPreviewVersionId = versionId;
  const sizeForPreview = versionInfo ? (versionInfo.Size ?? 0) : obj.Size;
  const dateForPreview = versionInfo ? versionInfo.LastModified : obj.LastModified;
  const versionLabel = versionId
    ? `<span style="color:var(--warn); margin-left:8px">· versión ${versionId.slice(0, 8)}…${versionInfo!.IsLatest ? ' (LATEST)' : ''}</span>`
    : '';
  info.innerHTML = `${formatSize(sizeForPreview)} · ${formatDate(dateForPreview)}${versionLabel}`;

  const ext = (obj.Key.split('.').pop() || '').toLowerCase();
  const params = new URLSearchParams({ key: obj.Key, inline: '1' });
  if (versionId) params.set('versionId', versionId);
  const url = `/api/object/${encodeURIComponent(State.activeBucket || '')}/download?${params}`;

  try {
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
      const blob = await (await fetch(url, { headers: authHeaders(), credentials: 'same-origin' })).blob();
      body.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt=""/>`;
    } else if (['mp4', 'webm', 'ogv'].includes(ext)) {
      const blob = await (await fetch(url, { headers: authHeaders(), credentials: 'same-origin' })).blob();
      body.innerHTML = `<video controls src="${URL.createObjectURL(blob)}"></video>`;
    } else if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) {
      const blob = await (await fetch(url, { headers: authHeaders(), credentials: 'same-origin' })).blob();
      body.innerHTML = `<audio controls src="${URL.createObjectURL(blob)}" style="width:80%"></audio>`;
    } else if (ext === 'pdf') {
      const blob = await (await fetch(url, { headers: authHeaders(), credentials: 'same-origin' })).blob();
      body.innerHTML = `<iframe src="${URL.createObjectURL(blob)}"></iframe>`;
    } else if (sizeForPreview < 1024 * 512 && ['txt', 'md', 'json', 'xml', 'log', 'csv', 'js', 'ts', 'html', 'css', 'yml', 'yaml', 'sh', 'py', 'java', 'go', 'rs', 'sql', 'env', 'conf', 'ini'].includes(ext)) {
      const text = await (await fetch(url, { headers: authHeaders(), credentials: 'same-origin' })).text();
      body.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
    } else {
      body.innerHTML = `<div style="padding:40px;color:var(--text-dim);text-align:center">
        <p style="font-size:48px;margin-bottom:8px">📄</p>
        <p>Vista previa no disponible para este tipo de archivo.</p>
        <p style="font-size:12px;margin-top:8px">Tamaño: ${formatSize(sizeForPreview)}</p>
      </div>`;
    }
  } catch (e) {
    body.innerHTML = `<div style="padding:40px;color:var(--danger)">${escapeHtml((e as Error).message)}</div>`;
  }
}

export async function openPreview(obj: S3Object): Promise<void> {
  currentPreview = obj;
  currentPreviewVersionId = null;
  $('preview-title').textContent = obj.Key.split('/').pop() || obj.Key;
  $('versions-panel').style.display = 'none';
  $('versions-panel').innerHTML = '';
  openModal('modal-preview');
  await renderPreviewBody(obj, null);
}

export function initPreview(): void {
  $('btn-download').onclick = (): void => { if (currentPreview) downloadObject(currentPreview.Key); };
  $('btn-share').onclick = (): void => { if (currentPreview) shareObject(currentPreview.Key); };
  $('btn-show-versions').onclick = async (): Promise<void> => {
    if (!currentPreview) return;
    const panel = $('versions-panel');
    panel.style.display = 'block';
    panel.innerHTML = '<div style="color:var(--text-dim)">Cargando versiones...</div>';
    try {
      const { versions } = await api<{ versions: VersionInfo[] }>(
        `/api/object/${encodeURIComponent(State.activeBucket || '')}/versions?key=${encodeURIComponent(currentPreview.Key)}`,
      );
      if (!versions.length) {
        panel.innerHTML = '<div style="color:var(--text-dim)">Sin versiones (¿versionado deshabilitado?).</div>';
        return;
      }
      panel.innerHTML = '';
      for (const v of versions) {
        const row = document.createElement('div');
        row.className = 'version-row';
        if (v.VersionId === currentPreviewVersionId) row.classList.add('viewing');
        const isDel = v.Type === 'delete-marker';
        row.innerHTML = `
          <div class="vid" title="${escapeHtml(v.VersionId)}">${escapeHtml(v.VersionId)}</div>
          <div>${escapeHtml(formatDate(v.LastModified))}</div>
          <div>${isDel ? '<span class="delete-marker">DELETE</span>' : formatSize(v.Size ?? 0)} ${v.IsLatest ? '<span class="latest">LATEST</span>' : ''}</div>
          <div class="actions">
            ${isDel ? '' : `<button class="btn xs" data-act="view" title="Vista previa de esta versión" aria-label="Ver"><i data-icon="eye" data-icon-size="12"></i></button>
            <button class="btn xs" data-act="download" title="Descargar" aria-label="Descargar"><i data-icon="download" data-icon-size="12"></i></button>
            <button class="btn xs" data-act="share" title="Enlace temporal" aria-label="Enlace"><i data-icon="link" data-icon-size="12"></i></button>
            <button class="btn xs" data-act="restore" title="Restaurar como versión actual"><i data-icon="reindex" data-icon-size="12"></i> Restaurar</button>`}
            <button class="btn xs btn-danger" data-act="delete" title="Eliminar permanente" aria-label="Eliminar"><i data-icon="trash" data-icon-size="12"></i></button>
          </div>
        `;
        row.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
          b.onclick = async (): Promise<void> => {
            const act = b.dataset.act;
            if (!currentPreview) return;
            if (act === 'view') {
              await renderPreviewBody(currentPreview, v);
              panel.querySelectorAll('.version-row').forEach((r) => r.classList.remove('viewing'));
              row.classList.add('viewing');
            } else if (act === 'download') {
              downloadObject(currentPreview.Key, v.VersionId);
            } else if (act === 'share') {
              await shareObject(currentPreview.Key, v.VersionId);
            } else if (act === 'restore') {
              if (!confirm('Restaurar esta versión como la actual?')) return;
              try {
                await api(`/api/object/${encodeURIComponent(State.activeBucket || '')}/copy`, {
                  method: 'POST',
                  body: { sourceKey: currentPreview.Key, destKey: currentPreview.Key, sourceVersionId: v.VersionId },
                });
                toast('Versión restaurada', 'success');
                await onObjectsChanged();
                ($('btn-show-versions') as HTMLButtonElement).click();
              } catch (e) {
                toast((e as Error).message, 'error', errorIdOpts(e));
              }
            } else if (act === 'delete') {
              if (!confirm(`Eliminar esta versión (${v.VersionId.slice(0, 8)}...)?`)) return;
              try {
                await api(`/api/object/${encodeURIComponent(State.activeBucket || '')}`, {
                  method: 'DELETE',
                  body: { key: currentPreview.Key, versionId: v.VersionId },
                });
                toast('Versión eliminada', 'success');
                ($('btn-show-versions') as HTMLButtonElement).click();
              } catch (e) {
                toast((e as Error).message, 'error', errorIdOpts(e));
              }
            }
          };
        });
        panel.appendChild(row);
      }
      mountIcons(panel);
    } catch (e) {
      panel.innerHTML = `<div style="color:var(--danger)">${escapeHtml((e as Error).message)}</div>`;
    }
  };
}
