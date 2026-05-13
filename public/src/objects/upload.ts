// Upload flow: file picker + drag-and-drop + pre-upload conflict detection
// (POST /api/objects/:bucket/exists → overwrite modal).
//
// Uploads target the pane that owned the file picker / drop target, so a
// drop on the left pane never overwrites files on the right.

import { getPane, setActivePane } from '../state.js';
import type { PaneId } from '../state.js';
import { api } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { $, paneEl, openModal, closeModal, escapeHtml } from '../util/dom.js';
import { formatSize } from '../util/format.js';

interface UploadItem { file: File; key: string }

let onUploadComplete: (paneId: PaneId) => void | Promise<void> = () => undefined;

export function configureUpload(deps: { onUploadComplete: (paneId: PaneId) => void | Promise<void> }): void {
  onUploadComplete = deps.onUploadComplete;
}

export async function uploadFiles(files: FileList | null, paneId: PaneId): Promise<void> {
  const pane = getPane(paneId);
  if (!files || !files.length || !pane.activeBucket) return;

  const items: UploadItem[] = [...files].map((f) => ({ file: f, key: pane.prefix + f.name }));

  let conflicts: UploadItem[] = [];
  try {
    const data = await api<{ results: { key: string; exists: boolean }[] }>(
      `/api/objects/${encodeURIComponent(pane.activeBucket)}/exists`,
      { method: 'POST', body: { keys: items.map((i) => i.key) } },
    );
    const existing = new Set(data.results.filter((r) => r.exists).map((r) => r.key));
    conflicts = items.filter((i) => existing.has(i.key));
  } catch (e) {
    console.warn('[upload] exists-check failed, proceeding without conflict warning:', (e as Error).message);
  }

  if (conflicts.length === 0) {
    await doUpload(items, paneId);
    return;
  }

  if (pane.versioning === 'Enabled') {
    toast(`${conflicts.length} archivo(s) crearán nuevas versiones`, 'info', 4000);
    await doUpload(items, paneId);
    return;
  }

  promptOverwrite(items, conflicts, paneId);
}

async function doUpload(items: UploadItem[], paneId: PaneId): Promise<void> {
  const pane = getPane(paneId);
  if (!items.length || !pane.activeBucket) return;
  const fd = new FormData();
  fd.append('prefix', pane.prefix);
  for (const it of items) fd.append('files', it.file);
  try {
    toast(`Subiendo ${items.length} archivo(s)...`, 'info');
    await api(`/api/object/${encodeURIComponent(pane.activeBucket)}/upload`, { method: 'POST', body: fd });
    toast('Subida completa', 'success');
    await onUploadComplete(paneId);
  } catch (e) {
    toast((e as Error).message, 'error', errorIdOpts(e));
  }
}

function promptOverwrite(allItems: UploadItem[], conflicts: UploadItem[], paneId: PaneId): void {
  const conflictKeys = new Set(conflicts.map((c) => c.key));
  const newOnes = allItems.filter((i) => !conflictKeys.has(i.key));
  const pane = getPane(paneId);

  $('overwrite-conflict-count').textContent = String(conflicts.length);
  $('overwrite-dest').textContent = (pane.activeBucket || '') + '/' + (pane.prefix || '');
  const list = $('overwrite-list');
  list.innerHTML = conflicts.map((c) => `
    <div class="overwrite-item">
      <span class="overwrite-icon">📄</span>
      <span class="overwrite-name">${escapeHtml(c.file.name)}</span>
      <span class="overwrite-size">${formatSize(c.file.size)}</span>
    </div>
  `).join('');

  const newInfo = $('overwrite-new-info');
  newInfo.textContent = newOnes.length > 0
    ? `${newOnes.length} archivo(s) nuevo(s) (sin conflicto) se subirá(n) normalmente con "Subir solo los nuevos".`
    : 'Todos los archivos seleccionados tienen conflicto.';

  const btnSkip = $('btn-overwrite-skip') as HTMLButtonElement;
  btnSkip.disabled = newOnes.length === 0;

  openModal('modal-overwrite');

  const cleanup = (): void => {
    $('btn-overwrite-cancel').onclick = null;
    $('btn-overwrite-skip').onclick = null;
    $('btn-overwrite-all').onclick = null;
    closeModal('modal-overwrite');
  };
  $('btn-overwrite-cancel').onclick = (): void => {
    toast('Subida cancelada', 'info');
    cleanup();
  };
  $('btn-overwrite-skip').onclick = (): void => {
    cleanup();
    void doUpload(newOnes, paneId);
  };
  $('btn-overwrite-all').onclick = (): void => {
    cleanup();
    void doUpload(allItems, paneId);
  };
}

export function initUpload(paneId: PaneId): void {
  paneEl('btn-upload', paneId).onclick = (): void => {
    setActivePane(paneId);
    const input = paneEl('file-input', paneId) as HTMLInputElement;
    input.value = '';
    input.click();
  };
  (paneEl('file-input', paneId) as HTMLInputElement).onchange = async (e: Event): Promise<void> => {
    const input = e.target as HTMLInputElement;
    await uploadFiles(input.files, paneId);
    input.value = '';
  };

  // Drag & drop on the content area.
  const content = paneEl('content', paneId);
  const dz = paneEl('dropzone', paneId);
  let dragCounter = 0;
  content.addEventListener('dragenter', (e: Event) => {
    e.preventDefault();
    if (getPane(paneId).activeBucket) { dragCounter++; dz.classList.add('show'); }
  });
  content.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dz.classList.remove('show'); }
  });
  content.addEventListener('dragover', (e: Event) => e.preventDefault());
  content.addEventListener('drop', (e: Event) => {
    const ev = e as DragEvent;
    ev.preventDefault();
    dragCounter = 0;
    dz.classList.remove('show');
    setActivePane(paneId);
    if (!getPane(paneId).activeBucket) return;
    void uploadFiles(ev.dataTransfer?.files || null, paneId);
  });
}

