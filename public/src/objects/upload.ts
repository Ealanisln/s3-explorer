// Upload flow: file picker + drag-and-drop + JL's pre-upload conflict
// detection (POST /api/objects/:bucket/exists → overwrite modal).

import { State } from '../state.js';
import { api } from '../api/client.js';
import { toast } from '../util/toast.js';
import { $, openModal, closeModal, escapeHtml } from '../util/dom.js';
import { formatSize } from '../util/format.js';

interface UploadItem { file: File; key: string }

let onUploadComplete: () => void | Promise<void> = () => undefined;

export function configureUpload(deps: { onUploadComplete: () => void | Promise<void> }): void {
  onUploadComplete = deps.onUploadComplete;
}

export async function uploadFiles(files: FileList | null): Promise<void> {
  if (!files || !files.length || !State.activeBucket) return;

  const items: UploadItem[] = [...files].map((f) => ({ file: f, key: State.prefix + f.name }));

  // Pre-flight: detect collisions. UX differs by versioning state.
  let conflicts: UploadItem[] = [];
  try {
    const data = await api<{ results: { key: string; exists: boolean }[] }>(
      `/api/objects/${encodeURIComponent(State.activeBucket)}/exists`,
      { method: 'POST', body: { keys: items.map((i) => i.key) } },
    );
    const existing = new Set(data.results.filter((r) => r.exists).map((r) => r.key));
    conflicts = items.filter((i) => existing.has(i.key));
  } catch (e) {
    // Pre-check fails → fall through and upload normally. Server still gates
    // the write; this check is just UX.
    console.warn('[upload] exists-check failed, proceeding without conflict warning:', (e as Error).message);
  }

  if (conflicts.length === 0) {
    await doUpload(items);
    return;
  }

  if (State.versioning === 'Enabled') {
    toast(`${conflicts.length} archivo(s) crearán nuevas versiones`, 'info', 4000);
    await doUpload(items);
    return;
  }

  promptOverwrite(items, conflicts);
}

async function doUpload(items: UploadItem[]): Promise<void> {
  if (!items.length || !State.activeBucket) return;
  const fd = new FormData();
  fd.append('prefix', State.prefix);
  for (const it of items) fd.append('files', it.file);
  try {
    toast(`Subiendo ${items.length} archivo(s)...`, 'info');
    await api(`/api/object/${encodeURIComponent(State.activeBucket)}/upload`, { method: 'POST', body: fd });
    toast('Subida completa', 'success');
    await onUploadComplete();
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

function promptOverwrite(allItems: UploadItem[], conflicts: UploadItem[]): void {
  const conflictKeys = new Set(conflicts.map((c) => c.key));
  const newOnes = allItems.filter((i) => !conflictKeys.has(i.key));

  $('overwrite-conflict-count').textContent = String(conflicts.length);
  $('overwrite-dest').textContent = (State.activeBucket || '') + '/' + (State.prefix || '');
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
    void doUpload(newOnes);
  };
  $('btn-overwrite-all').onclick = (): void => {
    cleanup();
    void doUpload(allItems);
  };
}

export function initUpload(): void {
  $('btn-upload').onclick = (): void => {
    const input = $('file-input') as HTMLInputElement;
    input.value = '';
    input.click();
  };
  ($('file-input') as HTMLInputElement).onchange = async (e: Event): Promise<void> => {
    const input = e.target as HTMLInputElement;
    await uploadFiles(input.files);
    input.value = ''; // belt-and-suspenders so re-uploading the same file works
  };

  // Drag & drop on the content area.
  const content = $('content');
  const dz = $('dropzone');
  let dragCounter = 0;
  content.addEventListener('dragenter', (e: Event) => {
    e.preventDefault();
    if (State.activeBucket) { dragCounter++; dz.classList.add('show'); }
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
    if (!State.activeBucket) return;
    void uploadFiles(ev.dataTransfer?.files || null);
  });
}
