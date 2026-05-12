// Per-object actions invoked from the grid row menu, info panel, or preview.
// Each function is independent — no DOM listener wiring here.

import { State } from '../state.js';
import { api, authHeaders } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { $, openModal } from '../util/dom.js';

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
  const choice = prompt(
    'Validez del enlace temporal:\n  1 = 5 minutos (recomendado)\n  2 = 1 hora\n  3 = 24 horas\n\nIngresa 1, 2 o 3:',
    '1',
  );
  if (choice === null) return;
  const expiresMap: Record<string, number> = { '1': 300, '2': 3600, '3': 86400 };
  const expires = expiresMap[choice.trim()] || 300;
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
  if (!confirm(`Eliminar "${key}"?`)) return;
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
