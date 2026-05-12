// Object grid renderer + listing loader. The big visual surface of the SPA.

import { State } from '../state.js';
import { api } from '../api/client.js';
import { toast } from '../util/toast.js';
import { $, escapeHtml } from '../util/dom.js';
import { formatSize, formatDate, fileIcon } from '../util/format.js';
import { openPreview } from './preview.js';
import { openInfoPanel, closeInfoPanel } from './info-panel.js';
import {
  downloadObject, shareObject, deleteObject, restoreDeleteMarker, openRename,
} from './actions.js';
import { runRecursiveSearchForLink, updateSearchBanner } from './search.js';
import type { S3Object, SearchFolderInfo } from '../types.js';

export function toggleEmpty(show: boolean): void {
  $('empty').style.display = show ? 'block' : 'none';
  $('grid').style.display = show ? 'none' : 'table';
}

export function showLoadingRow(): HTMLTableRowElement {
  const tbody = $('grid-body');
  tbody.innerHTML = '';
  const tr = document.createElement('tr');
  tr.innerHTML = '<td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim)">⏳ Cargando carpeta...</td>';
  tbody.appendChild(tr);
  return tr;
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

function updateSortIndicators(): void {
  document.querySelectorAll<HTMLElement>('.grid th.sortable').forEach((th) => {
    const active = th.dataset.sort === State.sort.field;
    th.classList.toggle('active', active);
    const ind = th.querySelector('.sort-indicator');
    if (ind) ind.textContent = active ? (State.sort.dir === 'asc' ? '▲' : '▼') : '';
  });
}

export function renderBreadcrumbs(): void {
  const el = $('breadcrumbs');
  el.innerHTML = '';
  const parts: { name: string; prefix: string }[] = [];
  parts.push({ name: State.activeBucket || '', prefix: '' });
  const segs = State.prefix.split('/').filter(Boolean);
  let acc = '';
  for (const s of segs) {
    acc += s + '/';
    parts.push({ name: s, prefix: acc });
  }
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    const link = document.createElement('a');
    link.textContent = p.name;
    link.className = last ? 'current' : '';
    if (!last) link.onclick = (): void => { State.prefix = p.prefix; void loadObjects(); };
    el.appendChild(link);
    if (!last) {
      const s = document.createElement('span'); s.className = 'sep'; s.textContent = '/';
      el.appendChild(s);
    }
  });
}

export function updateBatchBar(): void {
  const bar = $('batch-bar');
  if (State.selected.size === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  $('batch-info').textContent = `${State.selected.size} archivo(s) seleccionado(s)`;
}

function showRowMenu(e: MouseEvent, o: S3Object): void {
  document.querySelectorAll('.dropdown.row-menu').forEach((d) => d.remove());
  const dd = document.createElement('div');
  dd.className = 'dropdown row-menu';
  dd.style.position = 'fixed';
  dd.style.left = (e.clientX - 140) + 'px';
  dd.style.top = (e.clientY) + 'px';
  dd.innerHTML = o.IsDeleteMarker ? `
    <button data-act="restore">Restaurar</button>
    <button data-act="versions">Ver versiones</button>
    <button data-act="purge" class="danger">Borrar marker</button>
  ` : `
    <button data-act="preview">Vista previa</button>
    <button data-act="download">Descargar</button>
    <button data-act="share">Enlace temporal</button>
    <button data-act="versions">Ver versiones</button>
    <button data-act="rename">Renombrar</button>
    <button data-act="delete" class="danger">Eliminar</button>
  `;
  document.body.appendChild(dd);
  const close = (): void => { dd.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 10);
  dd.onclick = async (ev: Event): Promise<void> => {
    const target = ev.target as HTMLElement;
    const act = target.dataset.act;
    if (act === 'restore') await restoreDeleteMarker(o, loadObjects);
    if (act === 'purge') {
      if (confirm('Borrar permanentemente el delete marker?')) {
        try {
          await api(`/api/object/${encodeURIComponent(State.activeBucket || '')}`, {
            method: 'DELETE',
            body: { key: o.Key, versionId: o.VersionId },
          });
          toast('Marker borrado', 'success');
          await loadObjects();
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      }
    }
    if (act === 'preview') void openPreview(o);
    if (act === 'download') downloadObject(o.Key);
    if (act === 'share') await shareObject(o.Key);
    if (act === 'versions') {
      void openPreview(o);
      setTimeout(() => ($('btn-show-versions') as HTMLButtonElement).click(), 200);
    }
    if (act === 'rename') openRename(o.Key);
    if (act === 'delete') await deleteObject(o.Key, loadObjects);
  };
}

function bindRowEvents(tr: HTMLTableRowElement, o: S3Object): void {
  const cb = tr.querySelector<HTMLInputElement>('input[type=checkbox]');
  if (cb) {
    cb.onclick = (e: Event): void => {
      e.stopPropagation();
      const checked = (e.target as HTMLInputElement).checked;
      if (checked) State.selected.add(o.Key); else State.selected.delete(o.Key);
      tr.classList.toggle('selected', checked);
      updateBatchBar();
    };
  }
  const mb = tr.querySelector<HTMLButtonElement>('.menu-btn');
  if (mb) mb.onclick = (e: MouseEvent): void => { e.stopPropagation(); showRowMenu(e, o); };
  tr.addEventListener('click', (e: Event) => {
    const t = e.target as HTMLElement;
    if (t.closest('input,button')) return;
    if (o.IsDeleteMarker) {
      if (confirm(`"${(o.Key.split('/').pop() || o.Key)}" está eliminado.\n\n¿Restaurarlo (borrar el delete marker)?`)) {
        void restoreDeleteMarker(o, loadObjects);
      }
      return;
    }
    openInfoPanel(o);
  });
  tr.addEventListener('dblclick', (e: Event) => {
    const t = e.target as HTMLElement;
    if (t.closest('input,button')) return;
    if (!o.IsDeleteMarker) void openPreview(o);
  });
}

export function renderGrid(): void {
  const tbody = $('grid-body');
  tbody.innerHTML = '';

  updateSortIndicators();
  const isSearchMode = State.searchResults !== null;
  const term = State.filterTerm.toLowerCase();

  if (isSearchMode) {
    renderSearchMode(tbody);
    return;
  }

  // Normal mode: filter prefixes + objects by filterTerm locally
  const visiblePrefixes = applySort(
    term ? State.prefixes.filter((p) => p.toLowerCase().includes(term)) : State.prefixes,
    true,
  );
  const visibleObjects = applySort(
    term ? State.objects.filter((o) => o.Key.toLowerCase().includes(term)) : State.objects,
  );

  if (!visiblePrefixes.length && !visibleObjects.length) {
    const tr = document.createElement('tr');
    const msg = term
      ? `Sin coincidencias en esta carpeta para "${escapeHtml(State.filterTerm)}". <a href="#" id="link-recursive-search" style="color:var(--primary-2)">Buscar en todo el bucket →</a>`
      : 'Carpeta vacía. Arrastra archivos aquí o usa "Subir archivos".';
    tr.innerHTML = `<td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim)">${msg}</td>`;
    tbody.appendChild(tr);
    const link = tr.querySelector<HTMLAnchorElement>('#link-recursive-search');
    if (link) link.onclick = (e: Event): void => { e.preventDefault(); void runRecursiveSearchForLink(); };
    updateBatchBar();
    return;
  }

  if (State.listingTruncated) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" style="background:rgba(227,179,65,0.12); border-left:3px solid var(--yellow); padding:10px 14px; font-size:12px; color:var(--yellow)">
      ⚠ Listado truncado en ${(State.prefixes.length + State.objects.length).toLocaleString()} entradas (${State.listingPages} páginas). Esta carpeta tiene más — usa la búsqueda para localizar elementos específicos.
    </td>`;
    tbody.appendChild(tr);
  }

  for (const p of visiblePrefixes) {
    const name = p.replace(State.prefix, '').replace('/', '');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-check"></td>
      <td class="cell-name"><span class="icon-file icon-folder">📁</span>${escapeHtml(name)}/</td>
      <td class="col-size">—</td>
      <td class="col-date">—</td>
      <td class="col-act"></td>
    `;
    tr.onclick = (): void => {
      State.prefix = p;
      ($('search-input') as HTMLInputElement).value = '';
      State.filterTerm = '';
      updateSearchBanner();
      void loadObjects();
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
      <td class="cell-name"><span class="icon-file ${ico.cls}">${ico.label}</span>${escapeHtml(name)}${badge}</td>
      <td class="col-size">${o.IsDeleteMarker ? '—' : formatSize(o.Size)}</td>
      <td class="col-date">${escapeHtml(formatDate(o.LastModified))}</td>
      <td class="col-act"><button class="menu-btn" data-menu="${escapeHtml(o.Key)}">⋯</button></td>
    `;
    bindRowEvents(tr, o);
    tbody.appendChild(tr);
  }

  ($('check-all') as HTMLInputElement).onclick = (e: Event): void => {
    const checked = (e.target as HTMLInputElement).checked;
    document.querySelectorAll<HTMLInputElement>('#grid-body input[type=checkbox]').forEach((cb) => {
      cb.checked = checked;
      cb.dispatchEvent(new Event('click'));
    });
  };

  updateBatchBar();
}

function renderSearchMode(tbody: HTMLElement): void {
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
    updateBatchBar();
    return;
  }

  for (const [folderKey, info] of sortedFolders) {
    renderSearchFolderRow(tbody, folderKey, info);
  }
  for (const o of sortedFiles) {
    renderSearchFileRow(tbody, o);
  }
  updateBatchBar();
}

function renderSearchFolderRow(tbody: HTMLElement, folderKey: string, info: SearchFolderInfo): void {
  const name = folderKey.replace(/\/$/, '').split('/').pop() || folderKey;
  const parent = folderKey.slice(0, folderKey.length - name.length - 1);
  const tr = document.createElement('tr');
  tr.dataset.folder = folderKey;
  tr.innerHTML = `
    <td class="col-check"></td>
    <td class="cell-name">
      <span class="icon-file icon-folder">📁</span>
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
    State.prefix = folderKey;
    State.searchResults = null;
    State.searchFolderHits = null;
    State.searchMeta = null;
    State.filterTerm = '';
    ($('search-input') as HTMLInputElement).value = '';
    $('btn-search-clear').style.display = 'none';
    void loadObjects();
  };
  tbody.appendChild(tr);
}

function renderSearchFileRow(tbody: HTMLElement, o: S3Object): void {
  const name = o.Key.split('/').pop() || o.Key;
  const folder = o.Key.slice(0, o.Key.length - name.length);
  const ico = fileIcon(name);
  const tr = document.createElement('tr');
  tr.dataset.key = o.Key;
  tr.innerHTML = `
    <td class="col-check"><input type="checkbox" data-key="${escapeHtml(o.Key)}"/></td>
    <td class="cell-name">
      <span class="icon-file ${ico.cls}">${ico.label}</span>
      <div>
        <div>${escapeHtml(name)}</div>
        ${folder ? `<div class="path-cell">${escapeHtml(folder)}</div>` : ''}
      </div>
    </td>
    <td class="col-size">${formatSize(o.Size)}</td>
    <td class="col-date">${escapeHtml(formatDate(o.LastModified))}</td>
    <td class="col-act"><button class="menu-btn">⋯</button></td>
  `;
  bindRowEvents(tr, o);
  tbody.appendChild(tr);
}

interface ListingResponse {
  prefixes: string[];
  objects: S3Object[];
  isTruncated?: boolean;
  pages?: number;
}

export async function loadObjects(): Promise<void> {
  if (!State.activeBucket) return;
  toggleEmpty(false);
  ($('btn-upload') as HTMLButtonElement).disabled = false;
  ($('btn-new-folder') as HTMLButtonElement).disabled = false;
  ($('search-input') as HTMLInputElement).disabled = false;
  State.searchResults = null;
  State.searchMeta = null;
  updateSearchBanner();
  renderBreadcrumbs();
  closeInfoPanel();
  const loader = showLoadingRow();
  try {
    const params = new URLSearchParams({ prefix: State.prefix });
    if (State.showDeleted) params.set('showDeleted', '1');
    const data = await api<ListingResponse>(`/api/objects/${encodeURIComponent(State.activeBucket)}?${params}`);
    State.prefixes = data.prefixes;
    State.objects = data.objects;
    State.listingTruncated = !!data.isTruncated;
    State.listingPages = data.pages || 1;
    State.selected.clear();
    renderGrid();
  } catch (e) {
    toast('Error: ' + (e as Error).message, 'error');
  } finally {
    loader.remove();
  }
}

export function initBatchBar(): void {
  $('btn-batch-delete').onclick = async (): Promise<void> => {
    if (!confirm(`Eliminar ${State.selected.size} archivo(s)?`)) return;
    try {
      await api(`/api/object/${encodeURIComponent(State.activeBucket || '')}/delete-batch`, {
        method: 'POST',
        body: { keys: [...State.selected] },
      });
      toast('Archivos eliminados', 'success');
      State.selected.clear();
      await loadObjects();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
}
