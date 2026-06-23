// Upload flow: file picker + drag-and-drop + pre-upload conflict resolution.
//
// When the destination already has a file with the same name, the user
// picks one of four actions (single decision applied to the whole batch):
//   • Reemplazar todos    → upload as-is, overwrites server objects.
//   • Renombrar y subir   → client-side rename via " (N)" suffix
//                            (macOS/Windows style) and upload.
//   • Saltar conflictos   → upload only the non-conflicting files.
//   • Cancelar todo       → nothing is uploaded.
//
// If versioning is ON, the modal is skipped and we upload as-is — the
// server keeps prior versions automatically, so "replace" is non-destructive.

import { getPane, setActivePane } from '../state.js';
import type { PaneId } from '../state.js';
import { api } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { $, paneEl, openModal, closeModal, escapeHtml } from '../util/dom.js';
import { formatSize } from '../util/format.js';
import { mountIcons } from '../util/icons.js';
import { nextFreeName } from './rename.js';

interface UploadItem { file: File; key: string }
interface ExistingMeta { size: number | null; lastModified: string | null }
interface ConflictItem extends UploadItem { existing: ExistingMeta }

interface ExistsResult { key: string; exists: boolean; size?: number | null; lastModified?: string | null }

let onUploadComplete: (paneId: PaneId) => void | Promise<void> = () => undefined;

// Per-pane reset hook for the drag-counter / dropzone-overlay state.
// initUpload installs the hook; promptOverwrite cleanup invokes it so the
// drag overlay can't get stuck "on" when the modal interrupts the flow.
const dragCounters = new Map<PaneId, () => void>();
function resetDragState(paneId: PaneId): void {
  dragCounters.get(paneId)?.();
}

export function configureUpload(deps: { onUploadComplete: (paneId: PaneId) => void | Promise<void> }): void {
  onUploadComplete = deps.onUploadComplete;
}

export async function uploadFiles(files: FileList | null, paneId: PaneId): Promise<void> {
  const pane = getPane(paneId);
  if (!files || !files.length || !pane.activeBucket) return;

  const items: UploadItem[] = [...files].map((f) => ({ file: f, key: pane.prefix + f.name }));

  let conflicts: ConflictItem[] = [];
  try {
    const data = await api<{ results: ExistsResult[] }>(
      `/api/objects/${encodeURIComponent(pane.activeBucket)}/exists`,
      { method: 'POST', body: { keys: items.map((i) => i.key) } },
    );
    const existing = new Map<string, ExistingMeta>();
    for (const r of data.results) {
      if (r.exists) {
        existing.set(r.key, {
          size: r.size ?? null,
          lastModified: r.lastModified ?? null,
        });
      }
    }
    conflicts = items
      .filter((i) => existing.has(i.key))
      .map((i) => ({ ...i, existing: existing.get(i.key) as ExistingMeta }));
  } catch (e) {
    console.warn('[upload] exists-check failed, proceeding without conflict warning:', (e as Error).message);
  }

  if (conflicts.length === 0) {
    await doUpload(items, paneId);
    return;
  }

  // Always prompt on conflict — even when versioning is ON. With
  // versioning the user can still prefer "renombrar" (keeps both files
  // as distinct keys) vs "reemplazar" (new version of the same key).
  // The modal swaps copy to reflect the non-destructive nature in that case.
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

// Build the rename map for the conflict set. `existingKeys` is the set of
// keys we already know exist (from the initial /exists round trip). We
// only know about original-name collisions; if the bucket also has a
// `foo (1).pdf` we don't see it in this set — that's an acceptable v1
// limitation since the generated name space is sparse in practice.
function planRenames(
  conflicts: ConflictItem[],
  existingKeys: Set<string>,
  prefix: string,
): Map<string, string> {
  // Work in the "name" space (without prefix) so the rename logic stays
  // path-agnostic. takenNames starts with the existing names at this
  // prefix and grows as we assign new names to in-batch files.
  const takenNames = new Set<string>();
  for (const k of existingKeys) {
    if (k.startsWith(prefix)) takenNames.add(k.slice(prefix.length));
  }
  const map = new Map<string, string>();
  for (const c of conflicts) {
    const newName = nextFreeName(c.file.name, takenNames);
    takenNames.add(newName);
    map.set(c.key, newName);
  }
  return map;
}

function renameItems(allItems: UploadItem[], renameMap: Map<string, string>, prefix: string): UploadItem[] {
  return allItems.map((it) => {
    const newName = renameMap.get(it.key);
    if (!newName || newName === it.file.name) return it;
    // File.name is read-only — wrap the underlying blob in a new File.
    const renamed = new File([it.file], newName, {
      type: it.file.type,
      lastModified: it.file.lastModified,
    });
    return { file: renamed, key: prefix + newName };
  });
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
  } catch {
    return '';
  }
}

function promptOverwrite(allItems: UploadItem[], conflicts: ConflictItem[], paneId: PaneId): void {
  const conflictKeys = new Set(conflicts.map((c) => c.key));
  const newOnes = allItems.filter((i) => !conflictKeys.has(i.key));
  const pane = getPane(paneId);
  const prefix = pane.prefix;

  // Plan renames upfront so the modal can show the preview names.
  const renameMap = planRenames(conflicts, conflictKeys, prefix);

  // Versioning state changes the tone: with versioning ON, reemplazar
  // creates a new version (non-destructive) so the warning is dropped to
  // info-tone. With versioning OFF, reemplazar is irreversible — keep
  // the danger framing.
  //
  // Note: the warn-block's full inner markup is rewritten here, which
  // destroys the legacy id="overwrite-conflict-count" / id="overwrite-dest"
  // children from the static HTML — and on a SECOND call $('overwrite-…')
  // would throw because the IDs no longer exist. So we bake the
  // conflict count and destination directly into the templated markup
  // instead of setting them via separate $() lookups.
  const warnBlock = $('overwrite-warn-block');
  const versioningOn = pane.versioning === 'Enabled';
  const destPath = escapeHtml((pane.activeBucket || '') + '/' + (prefix || ''));
  warnBlock.innerHTML = versioningOn
    ? `<i data-icon="info" data-icon-size="18" style="color:var(--accent); flex-shrink:0; margin-top:1px"></i>
       <div style="flex:1">
         <strong>${conflicts.length}</strong> archivo(s) ya existen en
         <code>${destPath}</code>.
         El versionado de este bucket está <strong>activado</strong>: reemplazar crea una
         <strong>nueva versión</strong> (la anterior queda recuperable).
       </div>`
    : `<i data-icon="warn" data-icon-size="18" style="color:var(--warn); flex-shrink:0; margin-top:1px"></i>
       <div style="flex:1">
         <strong>${conflicts.length}</strong> archivo(s) ya existen en
         <code>${destPath}</code>.
         El versionado de este bucket está
         <strong style="color:var(--danger)">desactivado</strong>:
         reemplazar es <strong>irreversible</strong>.
       </div>`;
  mountIcons(warnBlock);
  // Soften the "Reemplazar todos" button when versioning makes it safe.
  const btnAll = $('btn-overwrite-all') as HTMLButtonElement;
  if (btnAll) {
    btnAll.classList.toggle('btn-danger-solid', !versioningOn);
    btnAll.classList.toggle('btn', true);
    btnAll.textContent = versioningOn ? 'Reemplazar (nueva versión)' : 'Reemplazar todos';
  }

  const list = $('overwrite-list');
  list.innerHTML = conflicts.map((c) => {
    const renamed = renameMap.get(c.key);
    const existingSize = c.existing.size != null ? formatSize(c.existing.size) : '—';
    const existingDate = fmtDate(c.existing.lastModified);
    const previewLine = renamed && renamed !== c.file.name
      ? `<div class="overwrite-rename-preview" title="${escapeHtml(renamed)}">→ ${escapeHtml(renamed)}</div>`
      : '';
    return `
      <div class="overwrite-item">
        <span class="overwrite-icon">📄</span>
        <div class="overwrite-name" title="${escapeHtml(c.file.name)}">${escapeHtml(c.file.name)}</div>
        <div class="overwrite-meta">
          <span>Entrante: ${formatSize(c.file.size)}</span>
          <span class="sep">·</span>
          <span>Existente: ${existingSize}${existingDate ? ` (${existingDate})` : ''}</span>
        </div>
        ${previewLine}
      </div>
    `;
  }).join('');

  const newInfo = $('overwrite-new-info');
  newInfo.textContent = newOnes.length > 0
    ? `${newOnes.length} archivo(s) sin conflicto se subirá(n) tal cual en todos los casos.`
    : 'Todos los archivos seleccionados tienen conflicto.';

  const btnSkip = $('btn-overwrite-skip') as HTMLButtonElement;
  btnSkip.disabled = newOnes.length === 0;
  btnSkip.title = newOnes.length === 0 ? 'No hay archivos sin conflicto que subir' : '';

  openModal('modal-overwrite');
  // Default focus on "Renombrar" — the non-destructive recommended action.
  const btnRename = $('btn-overwrite-rename') as HTMLButtonElement;
  setTimeout(() => btnRename?.focus(), 30);

  const cleanup = (): void => {
    $('btn-overwrite-cancel').onclick = null;
    $('btn-overwrite-skip').onclick = null;
    $('btn-overwrite-all').onclick = null;
    $('btn-overwrite-rename').onclick = null;
    closeModal('modal-overwrite');
    // The drag flow that produced this modal left drag state mid-stream
    // (dropzone overlay shown, counter inflated). Wipe both so the next
    // drag starts from a clean slate.
    resetDragState(paneId);
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
  $('btn-overwrite-rename').onclick = (): void => {
    cleanup();
    const renamed = renameItems(allItems, renameMap, prefix);
    void doUpload(renamed, paneId);
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
  //
  // dropzone is re-queried each call instead of captured once — the grid
  // re-renders on every upload-complete and although it shouldn't move the
  // .dropzone div, holding a stale ref would be an invisible foot-gun.
  // Cheap query, runs only during drag.
  const content = paneEl('content', paneId);
  const getDz = (): HTMLElement => paneEl('dropzone', paneId);
  // Per-pane drag counter exposed via WeakMap so promptOverwrite cleanup
  // can reset it. dragenter/leave on nested children inflate the counter
  // without bound; if the modal interrupts the drag flow mid-way, the
  // counter can get stuck above zero and the visual dropzone overlay
  // would stay on (or never re-appear) on the next drag. Reset on close.
  let dragCounter = 0;
  dragCounters.set(paneId, () => { dragCounter = 0; getDz().classList.remove('show'); });
  content.addEventListener('dragenter', (e: Event) => {
    e.preventDefault();
    if (getPane(paneId).activeBucket) { dragCounter++; getDz().classList.add('show'); }
  });
  content.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; getDz().classList.remove('show'); }
  });
  content.addEventListener('dragover', (e: Event) => e.preventDefault());
  content.addEventListener('drop', (e: Event) => {
    const ev = e as DragEvent;
    ev.preventDefault();
    dragCounter = 0;
    getDz().classList.remove('show');
    setActivePane(paneId);
    const pane = getPane(paneId);
    if (!pane.activeBucket) {
      toast('Selecciona un bucket antes de subir archivos', 'info', 4000);
      return;
    }
    const files = ev.dataTransfer?.files;
    if (!files || !files.length) {
      // Some browsers fire drop with empty file list when the drag was
      // cancelled mid-air or when something intercepted the event. Without
      // this hint the user sees literal nothing.
      toast('No se detectaron archivos en el drop. Intenta de nuevo.', 'info', 4000);
      return;
    }
    void uploadFiles(files, paneId);
  });
}
