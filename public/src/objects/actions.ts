// Per-object actions invoked from the grid row menu, info panel, or preview.
// Each function is independent — no DOM listener wiring here.

import { State } from '../state.js';
import { api, authHeaders } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { $, openModal } from '../util/dom.js';
import { confirmDialog, choiceDialog } from '../util/dialog.js';

export async function fetchAsBlob(url: string, filename: string): Promise<void> {
  try {
    toast('Descargando...', 'info');
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error('Falló la descarga');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    toast((e as Error).message, 'error', errorIdOpts(e));
  }
}

// Helper: generate a presigned URL for `key` with a short validity. Used by
// "open in new tab" and "copy link" — both want a single round-trip with a
// fixed default duration, not the choice picker that shareObject() shows.
async function presignShort(key: string, versionId?: string): Promise<string> {
  if (!State.activeBucket) throw new Error('Bucket no activo');
  const params = new URLSearchParams({ key, expires: '300' });
  if (versionId) params.set('versionId', versionId);
  const { url } = await api<{ url: string; expires: number; capped: boolean }>(
    `/api/object/${encodeURIComponent(State.activeBucket)}/presign?${params}`,
  );
  return url;
}

export async function openObjectInNewTab(key: string, versionId?: string): Promise<void> {
  try {
    const url = await presignShort(key, versionId);
    // noopener,noreferrer: presigned URL goes straight to the S3 endpoint —
    // we don't want the opened tab to retain a window.opener handle back to
    // the SPA, and we don't want to leak the s3-explorer Referer to S3.
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (e) {
    toast((e as Error).message, 'error', errorIdOpts(e));
  }
}

export async function copyObjectLink(key: string, versionId?: string): Promise<void> {
  try {
    const url = await presignShort(key, versionId);
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      toast('Enlace copiado (expira en 5 min)', 'success', 5000);
      return;
    }
    // Fallback for older browsers / non-HTTPS contexts where the Clipboard
    // API isn't available. document.execCommand('copy') is deprecated but
    // still widely supported as a last-resort path.
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) toast('Enlace copiado (expira en 5 min)', 'success', 5000);
    else toast('No se pudo copiar — selecciónalo manualmente: ' + url, 'info', 10000);
  } catch (e) {
    toast((e as Error).message, 'error', errorIdOpts(e));
  }
}

export function downloadObject(key: string, versionId?: string): void {
  if (!State.activeBucket) return;
  const params = new URLSearchParams({ key });
  if (versionId) params.set('versionId', versionId);
  fetchAsBlob(
    `/api/object/${encodeURIComponent(State.activeBucket)}/download?${params}`,
    key.split('/').pop() || key,
  );
}

export async function shareObject(key: string, versionId?: string): Promise<void> {
  if (!State.activeBucket) return;
  const choice = await choiceDialog<'5m' | '1h' | '24h'>({
    title: 'Enlace temporal',
    message: 'Selecciona la validez del enlace. El archivo será accesible vía URL durante ese tiempo.',
    choices: [
      { value: '5m', label: '5 minutos', hint: 'Ideal para compartir rápidamente.', recommended: true },
      { value: '1h', label: '1 hora', hint: 'Para envíos por chat o correo.' },
      { value: '24h', label: '24 horas', hint: 'Acceso temporal extendido.' },
    ],
  });
  if (choice === null) return;
  const expiresMap: Record<string, number> = { '5m': 300, '1h': 3600, '24h': 86400 };
  const expires = expiresMap[choice];
  try {
    const params = new URLSearchParams({ key, expires: String(expires) });
    if (versionId) params.set('versionId', versionId);
    const { url, expires: actual, capped } = await api<{ url: string; expires: number; capped: boolean }>(
      `/api/object/${encodeURIComponent(State.activeBucket)}/presign?${params}`,
    );
    await navigator.clipboard.writeText(url);
    const human = actual >= 3600 ? `${Math.round(actual / 3600)} h` : `${Math.round(actual / 60)} min`;
    toast(`Enlace copiado (válido ${human})${capped ? ' — el servidor limitó la duración' : ''}`, 'success', 5000);
  } catch (e) {
    toast((e as Error).message, 'error', errorIdOpts(e));
  }
}

export async function deleteObject(
  key: string,
  onAfter: () => void | Promise<void>,
): Promise<void> {
  if (!State.activeBucket) return;
  const name = key.split('/').pop() || key;
  const ok = await confirmDialog({
    title: 'Eliminar archivo',
    message: `Se eliminará "${name}". ¿Continuar?`,
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/object/${encodeURIComponent(State.activeBucket)}`, {
      method: 'DELETE',
      body: { key },
    });
    toast('Eliminado', 'success');
    await onAfter();
  } catch (e) {
    toast((e as Error).message, 'error', errorIdOpts(e));
  }
}

export async function restoreDeleteMarker(
  o: { Key: string; VersionId?: string },
  onAfter: () => void | Promise<void>,
): Promise<void> {
  if (!State.activeBucket) return;
  try {
    await api(`/api/object/${encodeURIComponent(State.activeBucket)}/restore`, {
      method: 'POST',
      body: { key: o.Key, versionId: o.VersionId },
    });
    toast('Archivo restaurado', 'success');
    await onAfter();
  } catch (e) {
    toast((e as Error).message, 'error', errorIdOpts(e));
  }
}

export function openRename(key: string): void {
  const form = $('form-rename') as HTMLFormElement;
  (form.elements.namedItem('sourceKey') as HTMLInputElement).value = key;
  (form.elements.namedItem('newName') as HTMLInputElement).value = key.split('/').pop() || '';
  openModal('modal-rename');
}
