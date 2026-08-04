// Object grid renderer + listing loader. The big visual surface of the SPA.
//
// All pane-scoped DOM lookups go through `paneEl(name, paneId)`. Render
// functions take an optional `paneId` and use `withPane()` so the Proxy on
// State resolves to that pane during the render, even if the user is
// currently focused on the other side.

import { State, withPane, setActivePane, getPane, NAV_HISTORY_MAX } from '../state.js';
import type { PaneId } from '../state.js';
import { api, authHeaders } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { paneEl, escapeHtml, $, openModal, closeModal } from '../util/dom.js';
import { confirmDialog, choiceDialog } from '../util/dialog.js';
import { formatSize, formatDate, fileIcon } from '../util/format.js';
import { t } from '../i18n/index.js';
import { mountIcons } from '../util/icons.js';
import { openContextMenu } from '../util/context-menu.js';
import { openPreview } from './preview.js';
import { openInfoPanel, closeInfoPanel } from './info-panel.js';
import {
  downloadObject, shareObject, deleteObject, restoreDeleteMarker, openRename,
  openObjectInNewTab, copyObjectLink,
} from './actions.js';
import { runRecursiveSearchForLink, updateSearchBanner, restoreFilterForContext, updateSearchPlaceholder } from './search.js';
import { navigateTo } from '../router/index.js';
import { runTransfer } from '../panes/transfer.js';
import { setDualMode } from '../panes/init.js';
import { syncNav, reanchorSyncNav, cancelSyncNav } from '../panes/synced-nav.js';
import type { S3Object, SearchFolderInfo } from '../types.js';

// The "other" pane id — used by drag-and-drop / context menu to figure out
// where a transfer should land.
function otherPane(paneId: PaneId): PaneId {
  return paneId === 'left' ? 'right' : 'left';
}

// ── Per-pane prefix navigation history (back / forward) ───────────────────
//
// Each pane keeps its own stack of visited prefixes for the CURRENT
// (connId, bucket). The back/forward buttons in the toolbar move through
// this stack; the URL hash router still independently reflects the active
// pane (no change to that). The stack resets when the pane switches bucket
// or connection — mixing histories across buckets would push the user to
// keys that don't exist in the new scope.

// Suppression flag for pushNav. Set to true while goBack/goForward apply a
// history entry so the resulting loadObjects/navigateTo doesn't echo back
// into the history and create a phantom entry.
let suppressNavPush = false;

function pushNav(paneId: PaneId, newPrefix: string): void {
  if (suppressNavPush) return;
  const pane = getPane(paneId);
  // No-op if the target is the same as where we already are. Re-clicking
  // the open folder, hitting the breadcrumb's current segment, etc. should
  // not pollute the stack.
  if (pane.navHistory[pane.navIndex] === newPrefix) return;
  // Truncate any forward branch (matches browser semantics: navigating to
  // somewhere new discards what was previously "forward").
  pane.navHistory = pane.navHistory.slice(0, pane.navIndex + 1);
  pane.navHistory.push(newPrefix);
  // Roll off the oldest when exceeding the cap so memory stays bounded
  // even after a marathon of folder digging.
  while (pane.navHistory.length > NAV_HISTORY_MAX) {
    pane.navHistory.shift();
  }
  pane.navIndex = pane.navHistory.length - 1;
  updateNavButtons(paneId);
}

// Reset the history to a single seed entry — called when the pane switches
// bucket or connection (different scope, mixed history would be confusing).
export function resetNav(paneId: PaneId, seedPrefix = ''): void {
  const pane = getPane(paneId);
  pane.navHistory = [seedPrefix];
  pane.navIndex = 0;
  updateNavButtons(paneId);
}

// Reflect navIndex / history length onto the back+forward button disabled
// state. Called whenever the stack changes OR when loadObjects finishes
// (active pane switched, etc.).
export function updateNavButtons(paneId: PaneId): void {
  const pane = getPane(paneId);
  const back = paneEl('btn-nav-back', paneId) as HTMLButtonElement | null;
  const fwd = paneEl('btn-nav-fwd', paneId) as HTMLButtonElement | null;
  if (back) back.disabled = pane.navIndex <= 0;
  if (fwd) fwd.disabled = pane.navIndex >= pane.navHistory.length - 1;
}

async function goBack(paneId: PaneId): Promise<void> {
  const pane = getPane(paneId);
  if (pane.navIndex <= 0) return;
  pane.navIndex--;
  const prev = pane.navHistory[pane.navIndex];
  pane.prefix = prev;
  suppressNavPush = true;
  try {
    await loadObjects(paneId);
  } finally {
    suppressNavPush = false;
    updateNavButtons(paneId);
  }
}

async function goForward(paneId: PaneId): Promise<void> {
  const pane = getPane(paneId);
  if (pane.navIndex >= pane.navHistory.length - 1) return;
  pane.navIndex++;
  const next = pane.navHistory[pane.navIndex];
  pane.prefix = next;
  suppressNavPush = true;
  try {
    await loadObjects(paneId);
  } finally {
    suppressNavPush = false;
    updateNavButtons(paneId);
  }
}

export function initNavButtons(paneId: PaneId): void {
  const back = paneEl('btn-nav-back', paneId) as HTMLButtonElement | null;
  const fwd = paneEl('btn-nav-fwd', paneId) as HTMLButtonElement | null;
  if (back) back.onclick = (): void => { setActivePane(paneId); void goBack(paneId); };
  if (fwd) fwd.onclick = (): void => { setActivePane(paneId); void goForward(paneId); };
  updateNavButtons(paneId);
}

// Alt+Left / Alt+Right keyboard shortcut for the active pane. Wired once at
// boot from main.ts. Mirrors the conventional browser binding.
let navShortcutsBound = false;
export function initNavShortcuts(): void {
  if (navShortcutsBound) return;
  navShortcutsBound = true;
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const target = e.target as HTMLElement | null;
    // Don't hijack the shortcut while the user is typing into an input or
    // editing the breadcrumb / search field.
    if (target && (target.matches('input, textarea, [contenteditable="true"]'))) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); void goBack(State.activePane); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); void goForward(State.activePane); }
  });
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
  tr.innerHTML = `<td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim)">${t('grid.loadingFolder')}</td>`;
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
          pushNav(p, part.prefix);
          syncNav(p, part.prefix);
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

    // Edit button at the end of the breadcrumb — toggles the crumb chips
    // into a free-form text input for jumping directly to a known path.
    if (State.activeBucket) {
      const editBtn = document.createElement('button');
      editBtn.className = 'crumb-edit-btn';
      editBtn.type = 'button';
      editBtn.title = t('crumb.editPath');
      editBtn.setAttribute('aria-label', t('crumb.editAria'));
      editBtn.innerHTML = '<i data-icon="edit" data-icon-size="13"></i>';
      editBtn.onclick = (): void => enterBreadcrumbEdit(p);
      el.appendChild(editBtn);
      // Hydrate the <i data-icon="edit"> inside the button — mountIcons only
      // runs once at boot on the original DOM, so any dynamically-injected
      // icon (this button, and the OK / cancel ones in edit mode) needs an
      // explicit call here.
      mountIcons(el);
    }
  });
}

// Replace the breadcrumb chips with a single text input containing the
// current `bucket/prefix/` path. The user types or pastes a new path,
// Enter navigates, Escape cancels. Cross-bucket switch is allowed only
// when the target bucket already exists in the active connection's
// bucket list (we don't switch connections via the breadcrumb edit).
function enterBreadcrumbEdit(paneId: PaneId): void {
  withPane(paneId, () => {
    const el = paneEl('breadcrumbs', paneId);
    const conn = State.connections.find((c) => c.id === State.activeConnId);
    if (!conn || !State.activeBucket) return;

    const currentPath = `${State.activeBucket}/${State.prefix || ''}`;
    el.innerHTML = '';
    el.classList.add('editing');

    // Connection pill stays — it's locked, can't be changed from here.
    const connSpan = document.createElement('span');
    connSpan.className = 'crumb-conn';
    connSpan.textContent = conn.name;
    connSpan.title = conn.endpoint || 'AWS S3';
    el.appendChild(connSpan);
    const sep = document.createElement('span');
    sep.className = 'sep'; sep.textContent = '/';
    el.appendChild(sep);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'crumb-edit-input';
    input.value = currentPath;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', t('crumb.pathAria'));
    el.appendChild(input);

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'crumb-edit-action ok';
    okBtn.title = t('crumb.go');
    okBtn.innerHTML = '<i data-icon="check" data-icon-size="13"></i>';
    el.appendChild(okBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'crumb-edit-action cancel';
    cancelBtn.title = t('crumb.cancelEsc');
    cancelBtn.innerHTML = '<i data-icon="close" data-icon-size="13"></i>';
    el.appendChild(cancelBtn);

    mountIcons(el);

    const pane = getPane(paneId);
    // pane.buckets is the authoritative cached bucket list for this pane —
    // it's whatever `fetchConnBuckets` resolved to (manual list or auto-
    // discovered). Empty means "haven't loaded yet" — skip the membership
    // check in that case so the user isn't blocked.
    const bucketNames = pane.buckets.map((b) => b.Name);

    const exitEditMode = (): void => {
      el.classList.remove('editing');
      renderBreadcrumbs(paneId);
    };

    const commit = (): void => {
      const parsed = parseBreadcrumbInput(input.value, bucketNames);
      if (!parsed.ok) {
        input.classList.add('err');
        toast(parsed.error, 'error', 4000);
        return;
      }
      // If the typed path lands in a different bucket the nav history is
      // bucket-scoped — reset it for the new scope. Otherwise just push.
      const bucketChanged = parsed.bucket !== pane.activeBucket;
      pane.activeBucket = parsed.bucket;
      pane.prefix = parsed.prefix;
      pane.selected.clear();
      if (bucketChanged) resetNav(paneId, parsed.prefix);
      else pushNav(paneId, parsed.prefix);
      // Breadcrumb edit is a baseline reset for synced nav — the user just
      // jumped to an arbitrary path, so the delta concept breaks. Re-anchor
      // both panes at their current positions (not silent — explicit toast).
      reanchorSyncNav();
      // loadObjects re-renders the breadcrumb in normal mode, so we don't
      // need to call exitEditMode explicitly.
      void loadObjects(paneId);
    };

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      input.classList.remove('err');
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); exitEditMode(); }
    });
    okBtn.onclick = (): void => commit();
    cancelBtn.onclick = (): void => exitEditMode();
    // Clicking outside the input (anywhere not on the edit controls) cancels.
    setTimeout(() => {
      const handleOutside = (e: MouseEvent): void => {
        if (!el.contains(e.target as Node)) {
          document.removeEventListener('mousedown', handleOutside);
          exitEditMode();
        }
      };
      document.addEventListener('mousedown', handleOutside);
    }, 0);

    input.focus();
    input.select();
  });
}

type BreadcrumbParseResult =
  | { ok: true; bucket: string; prefix: string }
  | { ok: false; error: string };

// Normalize and parse the path the user typed/pasted into the breadcrumb.
// Returns { ok: true, bucket, prefix } on success, or { ok: false, error }
// when the input doesn't resolve to a bucket the current connection can
// reach.
function parseBreadcrumbInput(raw: string, availableBuckets: string[]): BreadcrumbParseResult {
  let s = raw.trim();
  if (!s) return { ok: false, error: t('crumb.emptyPath') };

  // Accept s3://bucket/foo/bar styles.
  s = s.replace(/^s3:\/\//i, '');
  // Convert Windows-style backslashes to forward slashes (paste from File
  // Explorer is a real-world thing).
  s = s.replace(/\\/g, '/');
  // Drop any number of leading slashes.
  s = s.replace(/^\/+/, '');
  if (!s) return { ok: false, error: t('crumb.emptyPath') };

  const firstSlash = s.indexOf('/');
  const bucket = firstSlash === -1 ? s : s.slice(0, firstSlash);
  let prefix = firstSlash === -1 ? '' : s.slice(firstSlash + 1);
  // Drop double-slash artifacts; ensure trailing slash on a non-empty prefix.
  prefix = prefix.replace(/\/{2,}/g, '/');
  if (prefix && !prefix.endsWith('/')) prefix += '/';

  if (!bucket) return { ok: false, error: t('crumb.missingBucket') };
  // When the active connection has a manual bucket allowlist, enforce it.
  // For auto-discovered buckets (availableBuckets pulled from the pane's
  // loaded list) we trust whatever the user typed but warn if it's clearly
  // not in the cached list — the next loadObjects will surface a real error
  // from S3 if it's wrong.
  if (availableBuckets.length > 0 && !availableBuckets.includes(bucket)) {
    return { ok: false, error: t('crumb.bucketNotInConn', { bucket }) };
  }

  return { ok: true, bucket, prefix };
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
  paneEl('batch-info', p).textContent = t('grid.selectedCount', { count: pane.selected.size });
}

// Folder row context menu. Same dropdown shell as showRowMenu but tailored
// actions: navigate, rename (uses /api/transfer in move mode), delete
// recursively (uses the new SSE-streamed /folder/delete endpoint).
//
// For DELETED folders (every key under the prefix is a delete-marker
// tombstone) the action set is different — there's nothing live to
// rename, but the user can either restore everything in one shot or
// permanently purge the version history.
function showFolderMenu(e: MouseEvent, folderPrefix: string, paneId: PaneId): void {
  const isDeleted = State.deletedPrefixes.has(folderPrefix);
  const html = isDeleted ? `
    <button data-act="restore">${t('foldermenu.restore')}</button>
    <button data-act="open">${t('foldermenu.openDeleted')}</button>
    <button data-act="open-other">${t('foldermenu.openOther')}</button>
    <button data-act="purge" class="danger">${t('foldermenu.purge')}</button>
  ` : `
    <button data-act="open">${t('foldermenu.open')}</button>
    <button data-act="open-other">${t('foldermenu.openOther')}</button>
    <button data-act="rename">${t('common.rename')}</button>
    <button data-act="delete" class="danger">${t('foldermenu.delete')}</button>
  `;
  openContextMenu({ x: e.clientX, y: e.clientY, html, onAction: async (act): Promise<void> => {
    setActivePane(paneId);
    if (act === 'open') {
      const pane = getPane(paneId);
      pane.prefix = folderPrefix;
      pushNav(paneId, folderPrefix);
      syncNav(paneId, folderPrefix);
      void loadObjects(paneId);
    } else if (act === 'open-other') {
      void openFolderInOtherPane(folderPrefix, paneId);
    } else if (act === 'rename') {
      void openRenameFolder(folderPrefix, paneId);
    } else if (act === 'delete') {
      void deleteFolder(folderPrefix, paneId);
    } else if (act === 'restore') {
      void restoreFolder(folderPrefix, paneId);
    } else if (act === 'purge') {
      // Deleted folder → permanently remove every version + marker.
      // Reuse deleteFolder with a flag so the confirm dialog defaults to
      // purgeVersions:true. For now, deleteFolder already exposes the
      // picker; on a versioned bucket the user just picks "purgar" from
      // the choice dialog. On a non-versioned bucket there's no purge
      // distinction so the regular confirm + delete applies.
      void deleteFolder(folderPrefix, paneId);
    }
  } });
}

// Open `folderPrefix` in the OTHER pane (whichever pane doesn't have focus).
// Inherits the source pane's connection + bucket + cached bucket list so the
// user doesn't have to re-select them. Auto-enables dual mode when off, so
// the option always works regardless of the current pane layout. Override is
// silent — if the other pane was already pointing at a different conn/bucket,
// it gets reset to match the source.
async function openFolderInOtherPane(folderPrefix: string, sourcePaneId: PaneId): Promise<void> {
  const targetPaneId = otherPane(sourcePaneId);
  const source = getPane(sourcePaneId);
  if (!source.activeConnId || !source.activeBucket) {
    toast(t('pane.needConnBucket'), 'info', 4000);
    return;
  }

  // Reveal the other pane if dual mode was off. setDualMode handles the CSS
  // class on `.panes-wrap`, the right pane's `hidden` attr, and re-syncs the
  // active outline. On mobile (≤ 900px) it short-circuits — single-pane only.
  if (!State.dualMode) {
    setDualMode(true);
    if (!State.dualMode) {
      // Mobile rejected the toggle. Fall back to opening in the current pane.
      toast(t('pane.mobileNoDual'), 'info', 4000);
      source.prefix = folderPrefix;
      void loadObjects(sourcePaneId);
      return;
    }
  }

  const target = getPane(targetPaneId);
  // Override the target pane's state with the source's connection + bucket
  // context so the listing call below has everything it needs.
  target.activeConnId = source.activeConnId;
  target.activeBucket = source.activeBucket;
  // Share the cached bucket list so the sidebar tree under that connection
  // doesn't need to refetch it.
  target.buckets = source.buckets.slice();
  target.versioning = source.versioning;
  target.prefix = folderPrefix;
  target.selected.clear();
  target.searchResults = null;
  target.searchFolderHits = null;
  target.searchMeta = null;
  target.filterTerm = '';
  // The target pane's nav history is bound to ITS prior (connId, bucket).
  // Since we're force-switching its scope to the source's, reset and seed
  // with the new prefix as the first entry — back/forward in this pane
  // starts fresh from the folder the user just opened.
  resetNav(targetPaneId, folderPrefix);
  // "Abrir en segundo panel" is the opposite of "keep them linked" — the
  // user explicitly forced the target pane to a specific location. Cancel
  // sync if it was on; user can re-enable from the new positions.
  cancelSyncNav(t('sync.destReassigned'));

  // Switch focus to the new pane so the user immediately sees they're
  // working in it, and so the URL routing reflects the new location.
  setActivePane(targetPaneId);
  await loadObjects(targetPaneId);
}

// Pretty-print byte counts for the confirm dialog. Mirrors formatSize but
// kept inline so the folder-delete code doesn't pull a util just for this.
function fmtBytes(b: number): string {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

interface FolderCountResponse { count: number; totalBytes: number; truncated: boolean }
interface FolderDeleteFrame {
  t: 'progress' | 'done' | 'fatal';
  deleted?: number;
  failed?: number;
  scanned?: number;
  currentKey?: string;
  message?: string;
  errorId?: string;
}

// Confirm + stream the recursive delete for `folderPrefix` (must end in '/').
// The /count endpoint gives a quick "≈N archivos / size" preview so the user
// knows what they're nuking before saying yes. On a versioned bucket we ask
// whether to leave a recoverable delete-marker or purge every version.
async function deleteFolder(folderPrefix: string, paneId: PaneId): Promise<void> {
  const pane = getPane(paneId);
  if (!pane.activeBucket) return;
  const bucket = pane.activeBucket;
  const folderName = folderPrefix.replace(/\/$/, '').split('/').pop() || folderPrefix;

  // Count preview — capped at 5000 server-side so a huge folder doesn't make
  // the confirm dialog wait forever for a number.
  let countMsg = '';
  try {
    const c = await api<FolderCountResponse>(
      `/api/object/${encodeURIComponent(bucket)}/folder/count?prefix=${encodeURIComponent(folderPrefix)}`,
    );
    const num = c.truncated ? `${c.count.toLocaleString()}+` : c.count.toLocaleString();
    countMsg = t('folder.contains', { count: num, size: fmtBytes(c.totalBytes) + (c.truncated ? '+' : '') });
  } catch {
    countMsg = t('folder.countFailed');
  }

  // Pick delete strategy. On a non-versioned bucket the choice is moot — a
  // regular delete is permanent either way. We still show the picker if
  // versioning is on so the user knows what's happening.
  let purgeVersions = false;
  if (pane.versioning === 'Enabled') {
    const choice = await choiceDialog<'marker' | 'purge'>({
      title: t('folder.deleteTitle', { name: folderName }),
      message: t('folder.versionedChoice', { countMsg }),
      choices: [
        { value: 'marker', label: t('folder.optMarkers'), hint: t('folder.optMarkersHint'), recommended: true },
        { value: 'purge', label: t('folder.optPurge'), hint: t('folder.optPurgeHint') },
      ],
    });
    if (choice === null) return;
    purgeVersions = choice === 'purge';
  } else {
    const ok = await confirmDialog({
      title: t('folder.deleteTitle', { name: folderName }),
      message: t('folder.noVersioningWarning', { countMsg }),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
  }

  // Open the progress modal.
  $('folder-delete-title').textContent = purgeVersions
    ? t('folder.purging', { name: folderName })
    : t('folder.deleting', { name: folderName });
  ($('btn-folder-delete-close') as HTMLButtonElement).style.display = 'none';
  ($('btn-folder-delete-abort') as HTMLButtonElement).style.display = 'inline-flex';
  ($('btn-folder-delete-abort') as HTMLButtonElement).disabled = false;
  ($('btn-folder-delete-abort') as HTMLButtonElement).textContent = t('common.cancel');
  ($('folder-delete-progress-fill') as HTMLElement).style.width = '0%';
  ($('folder-delete-progress-fill').parentElement as HTMLElement | null)?.classList.add('in-progress');
  $('folder-delete-summary').textContent = t('progress.starting');
  $('folder-delete-current').textContent = '';
  openModal('modal-folder-delete');

  const abort = new AbortController();
  ($('btn-folder-delete-abort') as HTMLButtonElement).onclick = (): void => {
    abort.abort();
    ($('btn-folder-delete-abort') as HTMLButtonElement).disabled = true;
    ($('btn-folder-delete-abort') as HTMLButtonElement).textContent = t('progress.cancelling');
  };

  let totalDeleted = 0;
  let totalFailed = 0;
  let totalScanned = 0;
  let aborted = false;

  try {
    const res = await fetch(`/api/object/${encodeURIComponent(bucket)}/folder/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      credentials: 'same-origin',
      signal: abort.signal,
      body: JSON.stringify({ prefix: folderPrefix, purgeVersions }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let ev: FolderDeleteFrame;
        try { ev = JSON.parse(line.slice(5).trim()) as FolderDeleteFrame; } catch { continue; }

        if (ev.t === 'fatal') {
          toast(t('api.serverError', { message: ev.message || t('common.unknown') }), 'error',
            ev.errorId ? { errorId: ev.errorId } : undefined);
          continue;
        }
        if (ev.t === 'progress') {
          totalDeleted = ev.deleted ?? totalDeleted;
          totalFailed = ev.failed ?? totalFailed;
          totalScanned = ev.scanned ?? totalScanned;
          // Indeterminate bar — we don't know the final count up front; sweep
          // animation in the CSS makes the bar feel alive. Each batch shifts
          // the fill by a small fraction so there's also some real movement.
          const pct = Math.min(95, (totalDeleted % 1000) / 10 + (totalDeleted > 0 ? 5 : 0));
          ($('folder-delete-progress-fill') as HTMLElement).style.width = pct.toFixed(1) + '%';
          $('folder-delete-summary').textContent = t('progress.deletedSummary', {
            deleted: totalDeleted.toLocaleString(),
            scanned: totalScanned.toLocaleString(),
            failed: totalFailed > 0 ? t('progress.failedSuffix', { count: totalFailed }) : '',
            tail: '',
          });
          if (ev.currentKey) $('folder-delete-current').textContent = ev.currentKey;
        } else if (ev.t === 'done') {
          totalDeleted = ev.deleted ?? totalDeleted;
          totalFailed = ev.failed ?? totalFailed;
          totalScanned = ev.scanned ?? totalScanned;
          ($('folder-delete-progress-fill') as HTMLElement).style.width = '100%';
        }
      }
    }
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') aborted = true;
    else {
      toast(t('grid.listError', { message: err.message }), 'error', errorIdOpts(e));
    }
  }

  // Wrap up the modal.
  ($('folder-delete-progress-fill').parentElement as HTMLElement | null)?.classList.remove('in-progress');
  ($('btn-folder-delete-abort') as HTMLButtonElement).style.display = 'none';
  ($('btn-folder-delete-close') as HTMLButtonElement).style.display = 'inline-flex';
  const tail = aborted ? t('progress.cancelledSuffix') : '';
  $('folder-delete-summary').textContent = t('progress.deletedSummary', {
    deleted: totalDeleted.toLocaleString(),
    scanned: totalScanned.toLocaleString(),
    failed: totalFailed > 0 ? t('progress.failedSuffix', { count: totalFailed }) : '',
    tail,
  });
  $('folder-delete-current').textContent = '';

  // Hop one level up if the deleted folder was the open one, otherwise stay
  // and refresh. Either way we want the row to disappear.
  const parentPrefix = folderPrefix.replace(/[^/]+\/$/, '');
  if (pane.prefix.startsWith(folderPrefix)) pane.prefix = parentPrefix;
  void loadObjects(paneId);

  if (totalFailed === 0 && !aborted) {
    toast(t('folder.deletedToast', { count: totalDeleted.toLocaleString() }), 'success', 5000);
  } else if (aborted) {
    toast(t('folder.deleteCancelled'), 'info');
  } else {
    toast(t('progress.completedWithErrors', { count: totalFailed }), 'error');
  }
}

// Restore a deleted folder: walks ListObjectVersions server-side and removes
// the LATEST delete marker for each key under `folderPrefix` whose top-of-
// stack record is a marker. Same SSE progress flow as deleteFolder, sharing
// the same modal markup with a different title.
async function restoreFolder(folderPrefix: string, paneId: PaneId): Promise<void> {
  const pane = getPane(paneId);
  if (!pane.activeBucket) return;
  const bucket = pane.activeBucket;
  const folderName = folderPrefix.replace(/\/$/, '').split('/').pop() || folderPrefix;

  const ok = await confirmDialog({
    title: t('folder.restoreTitle', { name: folderName }),
    message: t('folder.restoreMessage'),
    confirmLabel: t('common.restore'),
  });
  if (!ok) return;

  // Reuse the folder-delete progress modal — same shape, different title.
  $('folder-delete-title').textContent = t('folder.restoring', { name: folderName });
  ($('btn-folder-delete-close') as HTMLButtonElement).style.display = 'none';
  ($('btn-folder-delete-abort') as HTMLButtonElement).style.display = 'inline-flex';
  ($('btn-folder-delete-abort') as HTMLButtonElement).disabled = false;
  ($('btn-folder-delete-abort') as HTMLButtonElement).textContent = t('common.cancel');
  ($('folder-delete-progress-fill') as HTMLElement).style.width = '0%';
  ($('folder-delete-progress-fill').parentElement as HTMLElement | null)?.classList.add('in-progress');
  $('folder-delete-summary').textContent = t('progress.starting');
  $('folder-delete-current').textContent = '';
  openModal('modal-folder-delete');

  const abort = new AbortController();
  ($('btn-folder-delete-abort') as HTMLButtonElement).onclick = (): void => {
    abort.abort();
    ($('btn-folder-delete-abort') as HTMLButtonElement).disabled = true;
    ($('btn-folder-delete-abort') as HTMLButtonElement).textContent = t('progress.cancelling');
  };

  let totalRestored = 0;
  let totalFailed = 0;
  let totalScanned = 0;
  let aborted = false;

  interface RestoreFrame {
    t: 'progress' | 'done' | 'fatal';
    restored?: number;
    failed?: number;
    scanned?: number;
    currentKey?: string;
    message?: string;
    errorId?: string;
  }

  try {
    const res = await fetch(`/api/object/${encodeURIComponent(bucket)}/folder/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      credentials: 'same-origin',
      signal: abort.signal,
      body: JSON.stringify({ prefix: folderPrefix }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('No response body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let ev: RestoreFrame;
        try { ev = JSON.parse(line.slice(5).trim()) as RestoreFrame; } catch { continue; }
        if (ev.t === 'fatal') {
          toast(t('api.serverError', { message: ev.message || t('common.unknown') }), 'error',
            ev.errorId ? { errorId: ev.errorId } : undefined);
          continue;
        }
        if (ev.t === 'progress') {
          totalRestored = ev.restored ?? totalRestored;
          totalFailed = ev.failed ?? totalFailed;
          totalScanned = ev.scanned ?? totalScanned;
          const pct = Math.min(95, (totalRestored % 1000) / 10 + (totalRestored > 0 ? 5 : 0));
          ($('folder-delete-progress-fill') as HTMLElement).style.width = pct.toFixed(1) + '%';
          $('folder-delete-summary').textContent = t('progress.restoredSummary', {
            restored: totalRestored.toLocaleString(),
            scanned: totalScanned.toLocaleString(),
            failed: totalFailed > 0 ? t('progress.failedSuffix', { count: totalFailed }) : '',
            tail: '',
          });
          if (ev.currentKey) $('folder-delete-current').textContent = ev.currentKey;
        } else if (ev.t === 'done') {
          totalRestored = ev.restored ?? totalRestored;
          totalFailed = ev.failed ?? totalFailed;
          totalScanned = ev.scanned ?? totalScanned;
          ($('folder-delete-progress-fill') as HTMLElement).style.width = '100%';
        }
      }
    }
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') aborted = true;
    else toast(t('grid.listError', { message: err.message }), 'error', errorIdOpts(e));
  }

  ($('folder-delete-progress-fill').parentElement as HTMLElement | null)?.classList.remove('in-progress');
  ($('btn-folder-delete-abort') as HTMLButtonElement).style.display = 'none';
  ($('btn-folder-delete-close') as HTMLButtonElement).style.display = 'inline-flex';
  const tail = aborted ? t('progress.cancelledSuffix') : '';
  $('folder-delete-summary').textContent = t('progress.restoredSummary', {
    restored: totalRestored.toLocaleString(),
    scanned: totalScanned.toLocaleString(),
    failed: totalFailed > 0 ? t('progress.failedSuffix', { count: totalFailed }) : '',
    tail,
  });
  $('folder-delete-current').textContent = '';

  void loadObjects(paneId);

  if (totalFailed === 0 && !aborted) {
    toast(t('folder.restoredToast', { count: totalRestored.toLocaleString() }), 'success', 5000);
  } else if (aborted) {
    toast(t('folder.restoreCancelled'), 'info');
  } else {
    toast(t('progress.completedWithErrors', { count: totalFailed }), 'error');
  }
}

// Open the rename modal for `folderPrefix`. On submit, fires runTransfer with
// folder mode + move so the server-side recursive copy + delete already in
// /api/transfer does all the work. No new backend required.
async function openRenameFolder(folderPrefix: string, paneId: PaneId): Promise<void> {
  const pane = getPane(paneId);
  if (!pane.activeBucket) return;
  // Derive parent prefix + current folder name.
  const match = folderPrefix.match(/([^/]+)\/$/);
  if (!match) return;
  const currentName = match[1];
  const parentPrefix = folderPrefix.slice(0, folderPrefix.length - currentName.length - 1);

  const f = $('form-folder-rename') as HTMLFormElement;
  f.reset();
  $('folder-rename-current').textContent = folderPrefix;
  const errEl = $('folder-rename-error');
  errEl.textContent = '';
  const input = f.elements.namedItem('newName') as HTMLInputElement;
  input.value = currentName;
  openModal('modal-folder-rename');
  setTimeout(() => { input.focus(); input.select(); }, 30);

  f.onsubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    errEl.textContent = '';
    const newName = input.value.trim().replace(/\/+$/, '');
    if (!newName) { errEl.textContent = t('folder.renameEmpty'); return; }
    if (newName.includes('/')) { errEl.textContent = t('folder.renameSlash'); return; }
    if (newName === currentName) { closeModal('modal-folder-rename'); return; }
    const destPrefix = parentPrefix + newName + '/';
    // Conflict check: is there already a sibling with that name? The pane's
    // current prefixes list is the cheapest source. Note this catches the
    // "rename to existing folder" case only when we're already viewing the
    // parent; that's the common case, and the server-side transfer would
    // happily merge into an existing folder otherwise.
    if (pane.prefix === parentPrefix && pane.prefixes.includes(destPrefix)) {
      errEl.textContent = t('folder.renameExists', { name: newName });
      return;
    }
    closeModal('modal-folder-rename');
    // Rename = recursive MOVE from foo/oldName/ → foo/newName/ with the new
    // `flatten` flag so the server lands each key at destPrefix + rel
    // (instead of destPrefix + sourceFolderName + rel which would double the
    // path). `skipConfirm` bypasses the standard copy/move picker since this
    // dialog already committed to "rename = move".
    await runTransfer({
      sourcePaneId: paneId,
      destPaneId: paneId,
      folder: { sourcePrefix: folderPrefix },
      destPrefixOverride: destPrefix,
      preselectMode: 'move',
      flattenFolder: true,
      skipConfirm: true,
    });
  };
}

function showRowMenu(e: MouseEvent, o: S3Object, paneId: PaneId): void {
  const dualEntries = !o.IsDeleteMarker && otherPaneReady(paneId) ? `
    <button data-act="copy-other">${t('rowmenu.copyOther')}</button>
    <button data-act="move-other">${t('rowmenu.moveOther')}</button>
  ` : '';
  const html = o.IsDeleteMarker ? `
    <button data-act="restore">${t('common.restore')}</button>
    <button data-act="versions">${t('rowmenu.versions')}</button>
    <button data-act="purge" class="danger">${t('rowmenu.purgeMarker')}</button>
  ` : `
    <button data-act="preview">${t('rowmenu.preview')}</button>
    <button data-act="open-new-tab">${t('rowmenu.openNewTab')}</button>
    <button data-act="download">${t('common.download')}</button>
    <button data-act="copy-url">${t('rowmenu.copyLink')}</button>
    <button data-act="share">${t('rowmenu.tempLink')}</button>
    <button data-act="versions">${t('rowmenu.versions')}</button>
    <button data-act="rename">${t('common.rename')}</button>
    ${dualEntries}
    <button data-act="delete" class="danger">${t('common.delete')}</button>
  `;
  openContextMenu({ x: e.clientX, y: e.clientY, html, onAction: async (act): Promise<void> => {
    setActivePane(paneId);
    const reload = (): Promise<void> => loadObjects(paneId);
    if (act === 'restore') await restoreDeleteMarker(o, reload);
    if (act === 'purge') {
      const ok = await confirmDialog({
        title: t('marker.purgeTitle'),
        message: t('marker.purgeMessage'),
        confirmLabel: t('marker.purgeConfirm'),
        danger: true,
      });
      if (ok) {
        try {
          await api(`/api/object/${encodeURIComponent(getPane(paneId).activeBucket || '')}`, {
            method: 'DELETE',
            body: { key: o.Key, versionId: o.VersionId },
          });
          toast(t('marker.purged'), 'success');
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
  } });
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
      return t('dnd.folderIntoItself');
    }
    if (samePane && destFolderPrefix.startsWith(src)) {
      return t('dnd.folderIntoSub');
    }
  } else {
    // Files: only block when the dest folder is the file's CURRENT folder —
    // otherwise it'd be a no-op move/copy in the same location.
    const allSameLocation = samePane && payload.keys.every((k) => {
      const parent = k.slice(0, k.lastIndexOf('/') + 1);
      return parent === destFolderPrefix;
    });
    if (allSameLocation) return t('dnd.alreadyThere');
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
    const target = e.target as HTMLElement;
    if (target.closest('input,button')) return;
    if (o.IsDeleteMarker) {
      const fname = (o.Key.split('/').pop() || o.Key);
      void confirmDialog({
        title: t('marker.deletedTitle'),
        message: t('marker.deletedMessage', { name: fname }),
        confirmLabel: t('common.restore'),
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
      ? t('grid.noMatchesHtml', { term: escapeHtml(State.filterTerm) })
      : t('grid.emptyFolder');
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
      <i data-icon="warn" style="vertical-align:middle; margin-right:4px"></i>${t('grid.truncated', { count: (State.prefixes.length + State.objects.length).toLocaleString(), pages: State.listingPages ?? 1 })}
    </td>`;
    tbody.appendChild(tr);
  }

  for (const pp of visiblePrefixes) {
    const name = pp.replace(State.prefix, '').replace('/', '');
    const tr = document.createElement('tr');
    tr.draggable = true;        // folders are draggable for recursive transfer
    tr.dataset.folderPrefix = pp;
    // Folder is "deleted" when every key under it is a delete-marker
    // tombstone — surfaced by the showDeleted=1 listing via the
    // deletedPrefixes set. Apply the same `.deleted` row class as deleted
    // files so it picks up the strikethrough + dim styling, and append a
    // DELETED badge to mirror file rows.
    const isDeletedFolder = State.deletedPrefixes.has(pp);
    if (isDeletedFolder) tr.classList.add('deleted');
    const folderBadge = isDeletedFolder ? '<span class="badge-deleted">DELETED</span>' : '';
    // Wrap the folder name in .name-text (same as file rows) so it gets
    // flex:1 and pushes the DELETED badge to the right edge of the cell —
    // matching the file-row alignment instead of the badge sitting glued
    // to the name.
    tr.innerHTML = `
      <td class="col-check"></td>
      <td class="cell-name"><span class="ft-badge folder"><i data-icon="folder" data-icon-size="12"></i></span><span class="name-text">${escapeHtml(name)}/</span>${folderBadge}</td>
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
      pushNav(paneId, pp);
      syncNav(paneId, pp);
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
      <td class="cell-name"><span class="ft-badge ${ico.cls}">${escapeHtml(ico.label)}</span><span class="name-text">${escapeHtml(name)}</span>${badge}</td>
      <td class="col-size">${o.IsDeleteMarker ? '—' : formatSize(o.Size)}</td>
      <td class="col-date">${escapeHtml(formatDate(o.LastModified))}</td>
      <td class="col-act"><button class="menu-btn" data-menu="${escapeHtml(o.Key)}" aria-label="${t('common.actions')}"><i data-icon="dots_h"></i></button></td>
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
      ? t('search.scanningNoMatches')
      : t('search.noResults', { term: escapeHtml(State.filterTerm) });
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
        <div>${escapeHtml(name)}/ <span style="color:var(--text-dim); font-size:11px; margin-left:6px">${t('search.filesCount', { count: info.fileCount })}</span></div>
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
    pushNav(paneId, folderKey);
    syncNav(paneId, folderKey);
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
      <span class="ft-badge ${ico.cls}">${escapeHtml(ico.label)}</span>
      <div class="name-stack">
        <div class="name-text">${escapeHtml(name)}</div>
        ${folder ? `<div class="path-cell">${escapeHtml(folder)}</div>` : ''}
      </div>
    </td>
    <td class="col-size">${formatSize(o.Size)}</td>
    <td class="col-date">${escapeHtml(formatDate(o.LastModified))}</td>
    <td class="col-act"><button class="menu-btn" aria-label="${t('common.actions')}"><i data-icon="dots_h"></i></button></td>
  `;
  bindRowEvents(tr as HTMLTableRowElement, o, paneId);
  tbody.appendChild(tr);
}

interface ListingResponse {
  prefixes: string[];
  // Only present when showDeleted=1. Subset of `prefixes` whose contents
  // are all delete-marker tombstones — i.e. "deleted folders".
  deletedPrefixes?: string[];
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
  // Reflect the new scope in the search input's placeholder so the user
  // knows what `Enter` will recursively search.
  updateSearchPlaceholder(p);
  updateSearchBanner(p);
  // Reflect the latest navIndex onto the back/forward buttons. They might
  // have been edited by goBack/goForward (just moved the pointer) or by a
  // user navigation that pushNav'd a new entry — either way refresh here.
  updateNavButtons(p);
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
    pane.deletedPrefixes = new Set(data.deletedPrefixes ?? []);
    pane.objects = data.objects;
    pane.listingTruncated = !!data.isTruncated;
    pane.listingPages = data.pages || 1;
    pane.selected.clear();
    renderGrid(p);
  } catch (e) {
    toast(t('grid.listError', { message: (e as Error).message }), 'error', errorIdOpts(e));
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
      title: t('batch.deleteTitle'),
      message: t('batch.deleteMessage', { count }),
      confirmLabel: t('batch.deleteConfirm', { count }),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/object/${encodeURIComponent(pane.activeBucket || '')}/delete-batch`, {
        method: 'POST',
        body: { keys: [...pane.selected] },
      });
      toast(t('batch.deleted'), 'success');
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
    // File rows (normal mode + search results) carry data-key.
    const fileTr = target.closest<HTMLTableRowElement>('tr[data-key]');
    if (fileTr) {
      const key = fileTr.dataset.key;
      if (!key) return;
      const pane = getPane(paneId);
      const obj = (pane.searchResults?.find((o) => o.Key === key))
        ?? pane.objects.find((o) => o.Key === key);
      if (!obj) return;
      e.preventDefault();
      setActivePane(paneId);
      showRowMenu(e, obj, paneId);
      return;
    }
    // Folder rows in normal mode carry data-folder-prefix; search-mode
    // folder rows carry data-folder. Both map to a prefix string we can
    // pass into showFolderMenu.
    const folderTr = target.closest<HTMLTableRowElement>('tr[data-folder-prefix], tr[data-folder]');
    if (folderTr) {
      const prefix = folderTr.dataset.folderPrefix ?? folderTr.dataset.folder;
      if (!prefix) return;
      e.preventDefault();
      setActivePane(paneId);
      showFolderMenu(e, prefix, paneId);
    }
  });
}
