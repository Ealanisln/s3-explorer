// Object grid renderer + listing loader. The big visual surface of the SPA.
//
// All pane-scoped DOM lookups go through `paneEl(name, paneId)`. Render
// functions take an optional `paneId` and use `withPane()` so the Proxy on
// State resolves to that pane during the render, even if the user is
// currently focused on the other side.

import { State, withPane, setActivePane, getPane } from '../state.js';
import type { PaneId } from '../state.js';
import { api } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { paneEl, escapeHtml } from '../util/dom.js';
import { confirmDialog } from '../util/dialog.js';
import { formatSize, formatDate, fileIcon } from '../util/format.js';
import { mountIcons } from '../util/icons.js';
import { openPreview } from './preview.js';
import { openInfoPanel, closeInfoPanel } from './info-panel.js';
import {
  downloadObject, shareObject, deleteObject, restoreDeleteMarker, openRename,
  openObjectInNewTab, copyObjectLink,
} from './actions.js';
import { runRecursiveSearchForLink, updateSearchBanner, restoreFilterForContext } from './search.js';
import { navigateTo } from '../router/index.js';
import { runTransfer } from '../panes/transfer.js';
import type { S3Object, SearchFolderInfo } from '../types.js';

// The "other" pane id — used by drag-and-drop / context menu to figure out
// where a transfer should land.
function otherPane(paneId: PaneId): PaneId {
  return paneId === 'left' ? 'right' : 'left';
}

// Returns the keys to transfer when the user drags row `o`: if it's part of
// the current selection, take the whole selection; otherwise just this row.
function dragKeysFor(o: S3Object, paneId: PaneId): string[] {
  const sel = getPane(paneId).selected;
  if (sel.has(o.Key) && sel.size > 1) return [...sel];
  return [o.Key];
}

// True when the OTHER pane is mounted, visible (dualMode), and has both an
// active connection and bucket — i.e. a valid transfer destination.
function otherPaneReady(paneId: PaneId): boolean {
  if (!State.dualMode) return false;
  const other = getPane(otherPane(paneId));
  return Boolean(other.activeConnId && other.activeBucket);
}

export function toggleEmpty(show: boolean, paneId?: PaneId): void {
  const p: PaneId = paneId || State.activePane;
  (paneEl('empty', p) as HTMLElement).style.display = show ? 'block' : 'none';
  (paneEl('grid', p) as HTMLElement).style.display = show ? 'none' : 'table';
}

export function showLoadingRow(paneId: PaneId): HTMLTableRowElement {
  const tbody = paneEl('grid-body', paneId);
  tbody.innerHTML = '';
  const tr = document.createElement('tr');
  tr.innerHTML = '<td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim)">Cargando carpeta…</td>';
  tbody.appendChild(tr);
  return tr as HTMLTableRowElement;
}

function applySort<T extends S3Object>(list: T[]): T[];
function applySort(list: string[], isPrefixList: true): string[];
function applySort(list: S3Object[] | string[], isPrefixList = false): S3Object[] | string[] {
  const { field, dir } = State.sort;
  const mult = dir === 'asc' ? 1 : -1;
  if (isPrefixList) {
    return [...(list as string[])].sort((a, b) => a.localeCompare(b) * (field === 'name' ? mult : 1));
  }
  return [...(list as S3Object[])].sort((a, b) => {
    let av: number | string; let bv: number | string;
    if (field === 'size') { av = a.Size || 0; bv = b.Size || 0; }
    else if (field === 'modified') {
      av = a.LastModified ? new Date(a.LastModified).getTime() : 0;
      bv = b.LastModified ? new Date(b.LastModified).getTime() : 0;
    } else {
      av = a.Key.toLowerCase(); bv = b.Key.toLowerCase();
    }
    if (av < bv) return -1 * mult;
    if (av > bv) return 1 * mult;
    return 0;
  });
}

function updateSortIndicators(paneId: PaneId): void {
  const root = paneEl('grid', paneId).closest('.pane') as HTMLElement | null;
  if (!root) return;
  root.querySelectorAll<HTMLElement>('.grid th.sortable').forEach((th) => {
    const active = th.dataset.sort === State.sort.field;
    th.classList.toggle('active', active);
    const ind = th.querySelector('.sort-indicator');
    if (ind) ind.textContent = active ? (State.sort.dir === 'asc' ? '▲' : '▼') : '';
  });
}

export function renderBreadcrumbs(paneId?: PaneId): void {
  const p: PaneId = paneId || State.activePane;
  withPane(p, () => {
    const el = paneEl('breadcrumbs', p);
    el.innerHTML = '';

    // Connection name (non-navigable label — clicking does nothing useful)
    // shown so the user knows which S3 endpoint they're looking at, especially
    // when both panes are visible and may be browsing different connections.
    const conn = State.connections.find((c) => c.id === State.activeConnId);
    if (conn) {
      const connSpan = document.createElement('span');
      connSpan.className = 'crumb-conn';
      connSpan.textContent = conn.name;
      connSpan.title = conn.endpoint || 'AWS S3';
      el.appendChild(connSpan);
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      el.appendChild(sep);
    }

    const parts: { name: string; prefix: string }[] = [];
    parts.push({ name: State.activeBucket || '', prefix: '' });
    const segs = State.prefix.split('/').filter(Boolean);
    let acc = '';
    for (const s of segs) {
      acc += s + '/';
      parts.push({ name: s, prefix: acc });
    }
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const link = document.createElement('a');
      link.textContent = part.name;
      link.className = last ? 'current' : '';
      if (!last) {
        link.onclick = (): void => {
          setActivePane(p);
          getPane(p).prefix = part.prefix;
          void loadObjects(p);
        };
        // Each non-current breadcrumb is also a drop target so the user can
        // drag a row UP the hierarchy. The last segment (current folder) is
        // skipped — dropping into "where you already are" is a no-op anyway.
        attachBreadcrumbDropHandlers(link, part.prefix, p);
      }
      el.appendChild(link);
      if (!last) {
        const s = document.createElement('span'); s.className = 'sep'; s.textContent = '/';
        el.appendChild(s);
      }
    });
  });
}

// Allow dragging a row onto a breadcrumb segment to move/copy UP the
// hierarchy (parent folder, grandparent, all the way to bucket root). Same
// validation as the folder-row drop handler — the destination is the
// breadcrumb's accumulated prefix.
function attachBreadcrumbDropHandlers(link: HTMLAnchorElement, destPrefix: string, paneId: PaneId): void {
  let hovering = false;
  link.addEventListener('dragenter', (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DND_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!hovering) { hovering = true; link.classList.add('drop-target-crumb'); }
  });
  link.addEventListener('dragover', (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DND_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  link.addEventListener('dragleave', (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DND_MIME)) return;
    if (link.contains(e.relatedTarget as Node)) return;
    hovering = false;
    link.classList.remove('drop-target-crumb');
  });
  link.addEventListener('drop', (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DND_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    hovering = false;
    link.classList.remove('drop-target-crumb');
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;
    let payload: DndPayload;
    try { payload = JSON.parse(raw) as DndPayload; } catch { return; }

    const samePane = payload.sourcePaneId === paneId;
    const err = validateFolderDrop(payload, destPrefix, samePane);
    if (err) { toast(err, 'info', 4000); return; }

    if (payload.kind === 'folder') {
      void runTransfer({
        sourcePaneId: payload.sourcePaneId,
        destPaneId: paneId,
        folder: { sourcePrefix: payload.prefix },
        destPrefixOverride: destPrefix,
      });
    } else {
      void runTransfer({
        sourcePaneId: payload.sourcePaneId,
        destPaneId: paneId,
        keys: payload.keys,
        destPrefixOverride: destPrefix,
      });
    }
  });
}

export function updateBatchBar(paneId?: PaneId): void {
  const p: PaneId = paneId || State.activePane;
  const bar = paneEl('batch-bar', p);
  const pane = getPane(p);
  if (pane.selected.size === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  paneEl('batch-info', p).textContent = `${pane.selected.size} archivo(s) seleccionado(s)`;
}

function showRowMenu(e: MouseEvent, o: S3Object, paneId: PaneId): void {
  document.querySelectorAll('.dropdown.row-actions-menu').forEach((d) => d.remove());
  const dd = document.createElement('div');
  dd.className = 'dropdown row-actions-menu';
  dd.style.position = 'fixed';
  // Position initially at the cursor — we'll clamp into the viewport once
  // we know the dropdown's real size (after it's in the DOM).
  dd.style.left = e.clientX + 'px';
  dd.style.top = e.clientY + 'px';
  dd.style.visibility = 'hidden';
  const dualEntries = !o.IsDeleteMarker && otherPaneReady(paneId) ? `
    <button data-act="copy-other">Copiar al otro panel →</button>
    <button data-act="move-other">Mover al otro panel →</button>
  ` : '';
  dd.innerHTML = o.IsDeleteMarker ? `
    <button data-act="restore">Restaurar</button>
    <button data-act="versions">Ver versiones</button>
    <button data-act="purge" class="danger">Borrar marker</button>
  ` : `
    <button data-act="preview">Vista previa</button>
    <button data-act="open-new-tab">Abrir en pestaña nueva</button>
    <button data-act="download">Descargar</button>
    <button data-act="copy-url">Copiar enlace</button>
    <button data-act="share">Enlace temporal…</button>
    <button data-act="versions">Ver versiones</button>
    <button data-act="rename">Renombrar</button>
    ${dualEntries}
    <button data-act="delete" class="danger">Eliminar</button>
  `;
  document.body.appendChild(dd);
  // Clamp into the viewport: if the dropdown would overflow the right edge,
  // flip to the left side of the cursor; same logic for the bottom edge.
  // We need the real size, which is only available after appendChild.
  const rect = dd.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;
  let left = e.clientX;
  let top = e.clientY;
  if (left + rect.width + margin > vw) left = Math.max(margin, vw - rect.width - margin);
  if (top + rect.height + margin > vh) top = Math.max(margin, vh - rect.height - margin);
  dd.style.left = left + 'px';
  dd.style.top = top + 'px';
  dd.style.visibility = '';

  const close = (): void => { dd.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 10);
  dd.onclick = async (ev: Event): Promise<void> => {
    setActivePane(paneId);
    const target = ev.target as HTMLElement;
    const act = target.dataset.act;
    const reload = (): Promise<void> => loadObjects(paneId);
    if (act === 'restore') await restoreDeleteMarker(o, reload);
    if (act === 'purge') {
      const ok = await confirmDialog({
        title: 'Borrar delete marker',
        message: 'Esta acción borra permanentemente el delete marker. ¿Continuar?',
        confirmLabel: 'Borrar',
        danger: true,
      });
      if (ok) {
        try {
          await api(`/api/object/${encodeURIComponent(getPane(paneId).activeBucket || '')}`, {
            method: 'DELETE',
            body: { key: o.Key, versionId: o.VersionId },
          });
          toast('Marker borrado', 'success');
          await reload();
        } catch (e) {
          toast((e as Error).message, 'error', errorIdOpts(e));
        }
      }
    }
    if (act === 'preview') void openPreview(o);
    if (act === 'open-new-tab') void openObjectInNewTab(o.Key);
    if (act === 'download') downloadObject(o.Key);
    if (act === 'copy-url') void copyObjectLink(o.Key);
    if (act === 'share') await shareObject(o.Key);
    if (act === 'versions') {
      void openPreview(o);
      setTimeout(() => (document.getElementById('btn-show-versions') as HTMLButtonElement)?.click(), 200);
    }
    if (act === 'rename') openRename(o.Key);
    if (act === 'copy-other' || act === 'move-other') {
      await runTransfer({
        sourcePaneId: paneId,
        destPaneId: otherPane(paneId),
        keys: dragKeysFor(o, paneId),
        preselectMode: act === 'move-other' ? 'move' : 'copy',
      });
    }
    if (act === 'delete') await deleteObject(o.Key, reload);
  };
}

// Drag-and-drop payload carried in DataTransfer for cross-pane transfers.
// MIME `application/x-s3-explorer-keys` is unique enough to disambiguate from
// regular file drops (which are handled by upload.ts).
const DND_MIME = 'application/x-s3-explorer-keys';

// Two payload shapes:
//   - "keys": one or more explicit files (existing behaviour)
//   - "folder": a single prefix (key ending in /) — the server will expand it
//
// The receiver (transfer.ts) dispatches based on `kind`.
type DndPayload =
  | { kind: 'keys'; sourcePaneId: PaneId; keys: string[] }
  | { kind: 'folder'; sourcePaneId: PaneId; prefix: string };

// Validate whether dropping `payload` onto folder `destFolderPrefix` (in the
// same pane) is sensible. Returns an error message or null when OK. Used by
// the folder-row drop handler to bail early with a toast.
function validateFolderDrop(
  payload: DndPayload, destFolderPrefix: string, samePane: boolean,
): string | null {
  if (payload.kind === 'folder') {
    const src = payload.prefix;
    if (samePane && src === destFolderPrefix) {
      return 'No puedes mover una carpeta dentro de sí misma.';
    }
    if (samePane && destFolderPrefix.startsWith(src)) {
      return 'No puedes mover una carpeta a una de sus subcarpetas.';
    }
  } else {
    // Files: only block when the dest folder is the file's CURRENT folder —
    // otherwise it'd be a no-op move/copy in the same location.
    const allSameLocation = samePane && payload.keys.every((k) => {
      const parent = k.slice(0, k.lastIndexOf('/') + 1);
      return parent === destFolderPrefix;
    });
    if (allSameLocation) return 'Los archivos ya están en esa carpeta.';
  }
  return null;
}

function bindRowEvents(tr: HTMLTableRowElement, o: S3Object, paneId: PaneId): void {
  // Rows are draggable when they're real files (not delete markers). The
  // payload contains either the single key or the current selection if the
  // dragged row is part of it.
  if (!o.IsDeleteMarker) {
    tr.draggable = true;
    tr.addEventListener('dragstart', (e: DragEvent) => {
      setActivePane(paneId);
      const keys = dragKeysFor(o, paneId);
      const payload: DndPayload = { kind: 'keys', sourcePaneId: paneId, keys };
      e.dataTransfer?.setData(DND_MIME, JSON.stringify(payload));
      // Plain-text fallback in case the receiver doesn't speak our MIME
      // (debugging, devtools paste, etc.).
      e.dataTransfer?.setData('text/plain', keys.join('\n'));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
    });
  }

  const cb = tr.querySelector<HTMLInputElement>('input[type=checkbox]');
  if (cb) {
    cb.onclick = (e: Event): void => {
      setActivePane(paneId);
      e.stopPropagation();
      const checked = (e.target as HTMLInputElement).checked;
      const sel = getPane(paneId).selected;
      if (checked) sel.add(o.Key); else sel.delete(o.Key);
      tr.classList.toggle('selected', checked);
      updateBatchBar(paneId);
    };
  }
  const mb = tr.querySelector<HTMLButtonElement>('.menu-btn');
  if (mb) mb.onclick = (e: MouseEvent): void => {
    setActivePane(paneId);
    e.stopPropagation();
    showRowMenu(e, o, paneId);
  };
  tr.addEventListener('click', (e: Event) => {
    setActivePane(paneId);
    const t = e.target as HTMLElement;
    if (t.closest('input,button')) return;
    if (o.IsDeleteMarker) {
      const fname = (o.Key.split('/').pop() || o.Key);
      void confirmDialog({
        title: 'Archivo eliminado',
        message: `"${fname}" está eliminado.\n\n¿Restaurarlo (borrar el delete marker)?`,
        confirmLabel: 'Restaurar',
      }).then((ok) => {
        if (ok) void restoreDeleteMarker(o, () => loadObjects(paneId));
      });
      return;
    }
    openInfoPanel(o, paneId);
  });
  tr.addEventListener('dblclick', (e: Event) => {
    setActivePane(paneId);
    const t = e.target as HTMLElement;
    if (t.closest('input,button')) return;
    if (!o.IsDeleteMarker) void openPreview(o);
  });
}

export function renderGrid(paneId?: PaneId): void {
  const p: PaneId = paneId || State.activePane;
  withPane(p, () => renderGridInner(p));
}

function renderGridInner(paneId: PaneId): void {
  const tbody = paneEl('grid-body', paneId);
  tbody.innerHTML = '';

  updateSortIndicators(paneId);
  const isSearchMode = State.searchResults !== null;
  const term = State.filterTerm.toLowerCase();

  if (isSearchMode) {
    renderSearchMode(tbody, paneId);
    return;
  }

  // Normal mode: filter prefixes + objects by filterTerm locally
  const visiblePrefixes = applySort(
    term ? State.prefixes.filter((pp) => pp.toLowerCase().includes(term)) : State.prefixes,
    true,
  );
  const visibleObjects = applySort(
    term ? State.objects.filter((o) => o.Key.toLowerCase().includes(term)) : State.objects,
  );

  if (!visiblePrefixes.length && !visibleObjects.length) {
    const tr = document.createElement('tr');
    const msg = term
      ? `Sin coincidencias en esta carpeta para "${escapeHtml(State.filterTerm)}". <a href="#" data-recursive-search style="color:var(--accent)">Buscar en todo el bucket →</a>`
      : 'Carpeta vacía. Arrastra archivos aquí o usa "Subir archivos".';
    tr.innerHTML = `<td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim)">${msg}</td>`;
    tbody.appendChild(tr);
    const link = tr.querySelector<HTMLAnchorElement>('[data-recursive-search]');
    if (link) link.onclick = (e: Event): void => { e.preventDefault(); void runRecursiveSearchForLink(paneId); };
    updateBatchBar(paneId);
    return;
  }

  if (State.listingTruncated) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" style="background:var(--warn-soft); border-left:3px solid var(--warn); padding:10px 14px; font-size:12px; color:var(--warn)">
      <i data-icon="warn" style="vertical-align:middle; margin-right:4px"></i>Listado truncado en ${(State.prefixes.length + State.objects.length).toLocaleString()} entradas (${State.listingPages} páginas). Esta carpeta tiene más — usa la búsqueda para localizar elementos específicos.
    </td>`;
    tbody.appendChild(tr);
  }

  for (const pp of visiblePrefixes) {
    const name = pp.replace(State.prefix, '').replace('/', '');
    const tr = document.createElement('tr');
    tr.draggable = true;        // folders are draggable for recursive transfer
    tr.dataset.folderPrefix = pp;
    tr.innerHTML = `
      <td class="col-check"></td>
      <td class="cell-name"><span class="ft-badge folder"><i data-icon="folder" data-icon-size="12"></i></span>${escapeHtml(name)}/</td>
      <td class="col-size">—</td>
      <td class="col-date">—</td>
      <td class="col-act"></td>
    `;
    tr.addEventListener('dragstart', (e: DragEvent) => {
      setActivePane(paneId);
      const payload: DndPayload = { kind: 'folder', sourcePaneId: paneId, prefix: pp };
      e.dataTransfer?.setData(DND_MIME, JSON.stringify(payload));
      e.dataTransfer?.setData('text/plain', pp);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
    });
    attachFolderRowDropHandlers(tr, pp, paneId);
    tr.onclick = (): void => {
      setActivePane(paneId);
      const pane = getPane(paneId);
      pane.prefix = pp;
      pane.filterTerm = '';
      (paneEl('search-input', paneId) as HTMLInputElement).value = '';
      updateSearchBanner(paneId);
      void loadObjects(paneId);
    };
    tbody.appendChild(tr);
  }

  for (const o of visibleObjects) {
    const name = o.Key.replace(State.prefix, '');
    if (!name) continue;
    const ico = fileIcon(name);
    const tr = document.createElement('tr');
    tr.dataset.key = o.Key;
    if (o.IsDeleteMarker) tr.classList.add('deleted');
    const badge = o.IsDeleteMarker ? '<span class="badge-deleted">DELETED</span>' : '';
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" data-key="${escapeHtml(o.Key)}"/></td>
      <td class="cell-name"><span class="ft-badge ${ico.cls}">${ico.label}</span><span class="name-text">${escapeHtml(name)}</span>${badge}</td>
      <td class="col-size">${o.IsDeleteMarker ? '—' : formatSize(o.Size)}</td>
      <td class="col-date">${escapeHtml(formatDate(o.LastModified))}</td>
      <td class="col-act"><button class="menu-btn" data-menu="${escapeHtml(o.Key)}" aria-label="Acciones"><i data-icon="dots_h"></i></button></td>
    `;
    bindRowEvents(tr as HTMLTableRowElement, o, paneId);
    tbody.appendChild(tr);
  }

  (paneEl('check-all', paneId) as HTMLInputElement).onclick = (e: Event): void => {
    setActivePane(paneId);
    const checked = (e.target as HTMLInputElement).checked;
    tbody.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((cb) => {
      cb.checked = checked;
      cb.dispatchEvent(new Event('click'));
    });
  };

  mountIcons(tbody);
  updateBatchBar(paneId);
}

function renderSearchMode(tbody: HTMLElement, paneId: PaneId): void {
  const folderHits = State.searchFolderHits ? [...State.searchFolderHits.entries()] : [];
  const sortedFolders = folderHits.sort((a, b) => {
    const { field, dir } = State.sort;
    const mult = dir === 'asc' ? 1 : -1;
    if (field === 'size') return (((a[1].totalSize || 0) - (b[1].totalSize || 0))) * mult;
    if (field === 'modified') {
      const aT = a[1].latestModified ? new Date(a[1].latestModified).getTime() : 0;
      const bT = b[1].latestModified ? new Date(b[1].latestModified).getTime() : 0;
      return (aT - bT) * mult;
    }
    return a[0].localeCompare(b[0]) * mult;
  });
  const sortedFiles = applySort(State.searchResults || []);

  if (!sortedFolders.length && !sortedFiles.length) {
    const tr = document.createElement('tr');
    const msg = State.searchMeta?.status === 'scanning'
      ? 'Escaneando... aún sin coincidencias.'
      : `Sin resultados para "${escapeHtml(State.filterTerm)}".`;
    tr.innerHTML = `<td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim)">${msg}</td>`;
    tbody.appendChild(tr);
    updateBatchBar(paneId);
    return;
  }

  for (const [folderKey, info] of sortedFolders) {
    renderSearchFolderRow(tbody, folderKey, info, paneId);
  }
  for (const o of sortedFiles) {
    renderSearchFileRow(tbody, o, paneId);
  }
  mountIcons(tbody);
  updateBatchBar(paneId);
}

function renderSearchFolderRow(tbody: HTMLElement, folderKey: string, info: SearchFolderInfo, paneId: PaneId): void {
  const name = folderKey.replace(/\/$/, '').split('/').pop() || folderKey;
  const parent = folderKey.slice(0, folderKey.length - name.length - 1);
  const tr = document.createElement('tr');
  tr.dataset.folder = folderKey;
  tr.innerHTML = `
    <td class="col-check"></td>
    <td class="cell-name">
      <span class="ft-badge folder"><i data-icon="folder" data-icon-size="12"></i></span>
      <div>
        <div>${escapeHtml(name)}/ <span style="color:var(--text-dim); font-size:11px; margin-left:6px">${info.fileCount} archivos</span></div>
        ${parent ? `<div class="path-cell">${escapeHtml(parent)}</div>` : ''}
      </div>
    </td>
    <td class="col-size">${formatSize(info.totalSize)}</td>
    <td class="col-date">${escapeHtml(formatDate(info.latestModified))}</td>
    <td class="col-act"></td>
  `;
  tr.onclick = (): void => {
    setActivePane(paneId);
    const pane = getPane(paneId);
    pane.prefix = folderKey;
    pane.searchResults = null;
    pane.searchFolderHits = null;
    pane.searchMeta = null;
    pane.filterTerm = '';
    (paneEl('search-input', paneId) as HTMLInputElement).value = '';
    paneEl('btn-search-clear', paneId).style.display = 'none';
    void loadObjects(paneId);
  };
  tbody.appendChild(tr);
}

function renderSearchFileRow(tbody: HTMLElement, o: S3Object, paneId: PaneId): void {
  const name = o.Key.split('/').pop() || o.Key;
  const folder = o.Key.slice(0, o.Key.length - name.length);
  const ico = fileIcon(name);
  const tr = document.createElement('tr');
  tr.dataset.key = o.Key;
  tr.innerHTML = `
    <td class="col-check"><input type="checkbox" data-key="${escapeHtml(o.Key)}"/></td>
    <td class="cell-name">
      <span class="ft-badge ${ico.cls}">${ico.label}</span>
      <div class="name-stack">
        <div class="name-text">${escapeHtml(name)}</div>
        ${folder ? `<div class="path-cell">${escapeHtml(folder)}</div>` : ''}
      </div>
    </td>
    <td class="col-size">${formatSize(o.Size)}</td>
    <td class="col-date">${escapeHtml(formatDate(o.LastModified))}</td>
    <td class="col-act"><button class="menu-btn" aria-label="Acciones"><i data-icon="dots_h"></i></button></td>
  `;
  bindRowEvents(tr as HTMLTableRowElement, o, paneId);
  tbody.appendChild(tr);
}

interface ListingResponse {
  prefixes: string[];
  objects: S3Object[];
  isTruncated?: boolean;
  pages?: number;
}

export async function loadObjects(paneId?: PaneId): Promise<void> {
  const p: PaneId = paneId || State.activePane;
  const pane = getPane(p);
  if (!pane.activeBucket) return;
  toggleEmpty(false, p);
  (paneEl('btn-upload', p) as HTMLButtonElement).disabled = false;
  (paneEl('btn-new-folder', p) as HTMLButtonElement).disabled = false;
  (paneEl('search-input', p) as HTMLInputElement).disabled = false;
  pane.searchResults = null;
  pane.searchMeta = null;
  // Restore any persisted local filter for this (conn, bucket, prefix) combo
  // BEFORE rendering, so the grid paint already applies the filter.
  restoreFilterForContext(p);
  updateSearchBanner(p);
  renderBreadcrumbs(p);
  closeInfoPanel(p);
  // Sync URL when this load is for the active pane. Covers folder-click,
  // breadcrumb-click, search-folder-click, openBucket — every navigation
  // ends up here. No-op when the URL already matches (navigateTo guards it).
  if (p === State.activePane && pane.activeConnId && pane.activeBucket) {
    navigateTo({
      connId: pane.activeConnId,
      bucket: pane.activeBucket,
      prefix: pane.prefix,
    });
  }
  const loader = showLoadingRow(p);
  try {
    const params = new URLSearchParams({ prefix: pane.prefix });
    if (pane.showDeleted) params.set('showDeleted', '1');
    const data = await api<ListingResponse>(`/api/objects/${encodeURIComponent(pane.activeBucket)}?${params}`);
    pane.prefixes = data.prefixes;
    pane.objects = data.objects;
    pane.listingTruncated = !!data.isTruncated;
    pane.listingPages = data.pages || 1;
    pane.selected.clear();
    renderGrid(p);
  } catch (e) {
    toast('Error: ' + (e as Error).message, 'error', errorIdOpts(e));
  } finally {
    loader.remove();
  }
}

// Cross-pane drag-and-drop drop target. Wired per-pane so each pane acts as
// both source (rows) and dest (content area). File-drop from the OS still
// goes through upload.ts via a different code path; this handler matches
// the application MIME and bails on plain file drops.
export function initDragDrop(paneId: PaneId): void {
  const root = paneEl('content', paneId).closest('.pane') as HTMLElement | null;
  if (!root) return;
  const content = paneEl('content', paneId);
  let depth = 0;

  content.addEventListener('dragenter', (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DND_MIME)) return;
    e.preventDefault();
    depth++;
    root.classList.add('drop-target');
  });
  content.addEventListener('dragleave', (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DND_MIME)) return;
    depth--;
    if (depth <= 0) { depth = 0; root.classList.remove('drop-target'); }
  });
  content.addEventListener('dragover', (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DND_MIME)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  content.addEventListener('drop', (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DND_MIME)) return;
    e.preventDefault();
    depth = 0;
    root.classList.remove('drop-target');
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;
    let payload: DndPayload;
    try { payload = JSON.parse(raw) as DndPayload; } catch { return; }
    // Same-pane drop on the empty area is a no-op — the user dropped onto
    // "this folder" which is where the files already are. Folder-row drops
    // are handled by attachFolderRowDropHandlers (they stop propagation).
    if (payload.sourcePaneId === paneId) return;
    if (payload.kind === 'folder') {
      void runTransfer({
        sourcePaneId: payload.sourcePaneId,
        destPaneId: paneId,
        folder: { sourcePrefix: payload.prefix },
      });
    } else {
      void runTransfer({
        sourcePaneId: payload.sourcePaneId,
        destPaneId: paneId,
        keys: payload.keys,
      });
    }
  });
}

// Wire dragenter/over/leave/drop on a single folder row so it acts as a drop
// target. The row's prefix becomes the destination (overriding the pane's
// open folder), so the user can drag a file or folder into ANY visible
// sub-folder — including in the same pane.
function attachFolderRowDropHandlers(tr: HTMLTableRowElement, folderPrefix: string, paneId: PaneId): void {
  let hovering = false;
  tr.addEventListener('dragenter', (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DND_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!hovering) { hovering = true; tr.classList.add('drop-target-row'); }
  });
  tr.addEventListener('dragover', (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DND_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  tr.addEventListener('dragleave', (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DND_MIME)) return;
    // Only remove the highlight when the cursor truly leaves the row (not
    // when it crosses into a child <td>). relatedTarget === null inside the
    // row means we're truly out.
    if (tr.contains(e.relatedTarget as Node)) return;
    hovering = false;
    tr.classList.remove('drop-target-row');
  });
  tr.addEventListener('drop', (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DND_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    hovering = false;
    tr.classList.remove('drop-target-row');
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;
    let payload: DndPayload;
    try { payload = JSON.parse(raw) as DndPayload; } catch { return; }

    const samePane = payload.sourcePaneId === paneId;
    const err = validateFolderDrop(payload, folderPrefix, samePane);
    if (err) { toast(err, 'info', 4000); return; }

    if (payload.kind === 'folder') {
      void runTransfer({
        sourcePaneId: payload.sourcePaneId,
        destPaneId: paneId,
        folder: { sourcePrefix: payload.prefix },
        destPrefixOverride: folderPrefix,
      });
    } else {
      void runTransfer({
        sourcePaneId: payload.sourcePaneId,
        destPaneId: paneId,
        keys: payload.keys,
        destPrefixOverride: folderPrefix,
      });
    }
  });
}

export function initBatchBar(paneId: PaneId): void {
  paneEl('btn-batch-delete', paneId).onclick = async (): Promise<void> => {
    setActivePane(paneId);
    const pane = getPane(paneId);
    const count = pane.selected.size;
    const ok = await confirmDialog({
      title: 'Eliminar archivos',
      message: `Se eliminarán ${count} archivo(s). ¿Continuar?`,
      confirmLabel: `Eliminar ${count}`,
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/object/${encodeURIComponent(pane.activeBucket || '')}/delete-batch`, {
        method: 'POST',
        body: { keys: [...pane.selected] },
      });
      toast('Archivos eliminados', 'success');
      pane.selected.clear();
      await loadObjects(paneId);
    } catch (e) {
      toast((e as Error).message, 'error', errorIdOpts(e));
    }
  };

  // Delegated contextmenu (right-click) on the table body. Wired once per
  // pane at boot — survives re-renders that replace rows. Looking up the
  // S3Object from the current pane state by data-key is more robust than
  // capturing it in a per-row closure.
  const tbody = paneEl('grid-body', paneId);
  tbody.addEventListener('contextmenu', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const tr = target.closest<HTMLTableRowElement>('tr[data-key]');
    if (!tr) return;  // header, folder row, or anywhere else → native menu
    const key = tr.dataset.key;
    if (!key) return;
    // Find the S3Object in the pane state (normal mode OR search results).
    const pane = getPane(paneId);
    const obj = (pane.searchResults?.find((o) => o.Key === key))
      ?? pane.objects.find((o) => o.Key === key);
    if (!obj) return;
    e.preventDefault();
    setActivePane(paneId);
    showRowMenu(e, obj, paneId);
  });
}
