// Sidebar connection tree + per-row menu + selectConnection.
//
// The sidebar is one tree: each connection is a parent node, its buckets are
// nested children. Connections are collapsed by default. Clicking a connection
// row both selects it (loads buckets into the active pane) and expands it.
// Clicking the chevron toggles expansion without changing the active selection.

import { State, getPane, subscribe } from '../state.js';
import type { PaneId, BucketRow } from '../state.js';
import { api } from '../api/client.js';
import { saveConnections } from '../vault/persistence.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { t } from '../i18n/index.js';
import { mountIcons } from '../util/icons.js';
import { $, paneEl, escapeHtml, openModal } from '../util/dom.js';
import { confirmDialog } from '../util/dialog.js';
import { openBucket, loadVersioning } from '../buckets/list.js';
import { toggleEmpty } from '../objects/grid.js';
import { navigateTo } from '../router/index.js';
import { reanchorSyncNav } from '../panes/synced-nav.js';
import type { Connection } from '../types.js';

let openEditModal: (c: Connection | null) => void = () => undefined;

export function configureConnections(deps: { openEditModal: (c: Connection | null) => void }): void {
  openEditModal = deps.openEditModal;
}

// Per-conn tree UI state. Cache survives re-renders so toggling a node doesn't
// refetch /api/buckets. Cleared on logout / vault re-lock by clearMain().
const expanded = new Set<string>();
const bucketCache = new Map<string, BucketRow[]>();
const inflight = new Map<string, Promise<BucketRow[] | null>>();

function showConnMenu(e: MouseEvent, c: Connection): void {
  e.stopPropagation();
  document.querySelectorAll('.dropdown.conn-menu').forEach((d) => d.remove());
  const dd = document.createElement('div');
  dd.className = 'dropdown conn-menu';
  dd.style.position = 'fixed';
  dd.style.left = e.clientX + 'px';
  dd.style.top = e.clientY + 'px';
  dd.innerHTML = `
    <button data-act="edit">${t('conn.edit')}</button>
    <button data-act="duplicate">${t('conn.duplicate')}</button>
    <button data-act="delete" class="danger">${t('common.delete')}</button>
  `;
  document.body.appendChild(dd);
  const close = (): void => { dd.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 10);
  dd.onclick = async (ev: Event): Promise<void> => {
    const target = ev.target as HTMLElement;
    const act = target.dataset.act;
    if (act === 'edit') openEditModal(c);
    if (act === 'duplicate') {
      const copy: Connection = { ...c, id: crypto.randomUUID(), name: c.name + t('conn.copySuffix') };
      State.connections.push(copy);
      void saveConnections();
      renderConnections();
    }
    if (act === 'delete') {
      const ok = await confirmDialog({
        title: t('conn.deleteTitle'),
        message: t('conn.deleteMessage', { name: c.name }),
        confirmLabel: t('common.delete'),
        danger: true,
      });
      if (ok) {
        State.connections = State.connections.filter((x) => x.id !== c.id);
        void saveConnections();
        bucketCache.delete(c.id);
        expanded.delete(c.id);
        // Clear out of every pane that was pointing at this connection.
        for (const p of ['left', 'right'] as PaneId[]) {
          const pane = getPane(p);
          if (pane.activeConnId === c.id) {
            pane.activeConnId = null;
            pane.activeBucket = null;
            pane.buckets = [];
          }
        }
        clearMain();
        renderConnections();
      }
    }
  };
}

function showBucketMenu(e: MouseEvent, conn: Connection, b: BucketRow): void {
  e.stopPropagation();
  document.querySelectorAll('.dropdown.bucket-menu').forEach((d) => d.remove());
  const dd = document.createElement('div');
  dd.className = 'dropdown bucket-menu';
  dd.style.position = 'fixed';
  dd.style.left = e.clientX + 'px';
  dd.style.top = e.clientY + 'px';
  dd.innerHTML = `<button data-act="delete" class="danger">${t('conn.deleteBucket')}</button>`;
  document.body.appendChild(dd);
  const close = (): void => { dd.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 10);
  dd.onclick = async (ev: Event): Promise<void> => {
    const target = ev.target as HTMLElement;
    if (target.dataset.act === 'delete') {
      const ok = await confirmDialog({
        title: t('conn.deleteBucket'),
        message: t('conn.deleteBucketMessage', { name: b.Name }),
        confirmLabel: t('common.delete'),
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/buckets/${encodeURIComponent(b.Name)}`, {
          method: 'DELETE',
          headers: connHeaders(conn),
        });
        toast(t('conn.bucketDeleted'), 'success');
        // Refresh this conn's bucket cache and tree.
        await refreshConnBuckets(conn);
        renderConnections();
      } catch (e2) {
        toast((e2 as Error).message, 'error', errorIdOpts(e2));
      }
    }
  };
}

export function renderConnections(): void {
  const ul = $('connections');
  ul.innerHTML = '';
  const activeConnId = getPane().activeConnId;
  const activeBucket = getPane().activeBucket;

  for (const c of State.connections) {
    const isActive = c.id === activeConnId;
    const isOpen = expanded.has(c.id);
    const buckets = bucketCache.get(c.id);
    const isLoading = inflight.has(c.id);

    const li = document.createElement('li');
    li.className = 'conn-node' + (isActive ? ' active' : '');
    li.dataset.connId = c.id;
    li.innerHTML = `
      <div class="conn-row">
        <span class="chevron${isOpen ? ' open' : ''}" aria-label="${t('conn.expand')}">
          <i data-icon="chevron_right" data-icon-size="12"></i>
        </span>
        <span class="ft-badge def" style="width:22px;height:22px;font-size:9px">S3</span>
        <span class="name" title="${escapeHtml(c.endpoint || 'AWS')}">${escapeHtml(c.name)}</span>
        <span class="act-btn add-bucket" title="${t('conn.createBucket')}" aria-label="${t('conn.createBucket')}">
          <i data-icon="plus" data-icon-size="13"></i>
        </span>
        <span class="act-btn menu" aria-label="${t('common.menu')}">
          <i data-icon="dots_h" data-icon-size="14"></i>
        </span>
      </div>
      ${isOpen ? `
        <ul class="bucket-children">
          ${buckets
            ? (buckets.length
              ? buckets.map((b) => `
                  <li class="bucket-node${(isActive && b.Name === activeBucket) ? ' active' : ''}" data-bucket="${escapeHtml(b.Name)}">
                    <span class="ft-badge folder" style="width:18px;height:18px"><i data-icon="bucket" data-icon-size="10"></i></span>
                    <span class="name">${escapeHtml(b.Name)}</span>
                    <span class="act-btn menu" aria-label="${t('common.menu')}">
                      <i data-icon="dots_h" data-icon-size="13"></i>
                    </span>
                  </li>`).join('')
              : `<li class="bucket-empty">${t('conn.noBuckets')}</li>`)
            : (isLoading
              ? `<li class="bucket-empty">${t('conn.loadingBuckets')}</li>`
              : '<li class="bucket-empty">—</li>')}
        </ul>
      ` : ''}
    `;
    ul.appendChild(li);

    // Wire the connection row.
    const row = li.querySelector<HTMLElement>('.conn-row')!;
    row.onclick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (target.closest('.menu')) { showConnMenu(e, c); return; }
      if (target.closest('.add-bucket')) {
        e.stopPropagation();
        void selectConnection(c.id).then(() => openModal('modal-bucket'));
        return;
      }
      if (target.closest('.chevron')) {
        e.stopPropagation();
        toggleExpand(c);
        return;
      }
      // Default: select + auto-expand.
      void selectConnection(c.id, undefined, { autoExpand: true });
    };

    // Wire each bucket row inside.
    if (isOpen && buckets) {
      li.querySelectorAll<HTMLElement>('.bucket-node').forEach((bn) => {
        const bname = bn.dataset.bucket || '';
        const bucket = buckets.find((bb) => bb.Name === bname);
        if (!bucket) return;
        bn.onclick = async (e: MouseEvent): Promise<void> => {
          const t = e.target as HTMLElement;
          if (t.closest('.menu')) { showBucketMenu(e, c, bucket); return; }
          // Switch the active pane onto this connection if needed, then open.
          if (getPane().activeConnId !== c.id) {
            await selectConnection(c.id, undefined, { skipPaint: true });
          }
          await openBucket(bucket.Name);
        };
      });
    }
  }
  mountIcons(ul);
}

function toggleExpand(c: Connection): void {
  if (expanded.has(c.id)) {
    expanded.delete(c.id);
    renderConnections();
    return;
  }
  expanded.add(c.id);
  // Fire the fetch if we don't have buckets cached yet.
  if (!bucketCache.has(c.id) && !inflight.has(c.id)) {
    void fetchConnBuckets(c).then(() => renderConnections());
  }
  renderConnections();
}

async function fetchConnBuckets(conn: Connection): Promise<BucketRow[] | null> {
  const existing = inflight.get(conn.id);
  if (existing) return existing;
  const p = (async (): Promise<BucketRow[] | null> => {
    try {
      if (conn.buckets && conn.buckets.length) {
        const rows: BucketRow[] = conn.buckets.map((name) => ({ Name: name, CreationDate: null }));
        bucketCache.set(conn.id, rows);
        return rows;
      }
      const { buckets } = await api<{ buckets: BucketRow[] }>(
        '/api/buckets',
        { headers: connHeaders(conn) },
      );
      bucketCache.set(conn.id, buckets);
      return buckets;
    } catch (e) {
      const err = e as Error;
      if (!/ListAllMyBuckets|not authorized|AccessDenied/i.test(err.message)) {
        toast(t('conn.bucketsLoadError', { message: err.message }), 'error', errorIdOpts(err));
      }
      return null;
    } finally {
      inflight.delete(conn.id);
    }
  })();
  inflight.set(conn.id, p);
  return p;
}

async function refreshConnBuckets(conn: Connection): Promise<void> {
  bucketCache.delete(conn.id);
  await fetchConnBuckets(conn);
  // Keep per-pane bucket arrays in sync where applicable.
  for (const p of ['left', 'right'] as PaneId[]) {
    const pane = getPane(p);
    if (pane.activeConnId === conn.id) {
      pane.buckets = bucketCache.get(conn.id) || [];
    }
  }
}

interface SelectOpts {
  autoExpand?: boolean;
  skipPaint?: boolean;  // when called from inside a bucket click — caller will paint
}

export async function selectConnection(id: string, paneId?: PaneId, opts: SelectOpts = {}): Promise<void> {
  const p: PaneId = paneId || State.activePane;
  const pane = getPane(p);
  pane.activeConnId = id;
  pane.activeBucket = null;
  pane.prefix = '';
  pane.buckets = [];
  // Connection change wipes the nav history — back/forward is scoped to
  // (connId, bucket) and a different connection has unrelated keys.
  pane.navHistory = [''];
  pane.navIndex = 0;
  // Path semantics changed — silent re-anchor (no surprise toast every
  // time the user picks a sidebar connection).
  reanchorSyncNav(true);
  if (opts.autoExpand) expanded.add(id);
  renderConnections();
  // Sync URL when this happens on the active pane (URL reflects active pane).
  if (p === State.activePane) navigateTo({ connId: id });
  const statusEl = $('conn-status');
  statusEl.classList.remove('online');
  statusEl.textContent = t('conn.connecting');
  const conn = State.connections.find((c) => c.id === pane.activeConnId);
  if (!conn) return;
  try {
    let buckets = bucketCache.get(conn.id);
    if (!buckets) buckets = (await fetchConnBuckets(conn)) || [];
    pane.buckets = buckets;
    renderConnections();
    statusEl.classList.add('online');
    const manualTag = (conn.buckets && conn.buckets.length) ? t('conn.manualTag') : '';
    statusEl.textContent = t('conn.connected', { count: buckets.length, manual: manualTag });
    if (!opts.skipPaint) {
      toggleEmpty(true, p);
      paneEl('empty', p).innerHTML = `<h2>${t('conn.selectBucketTitle')}</h2><p>${t('conn.selectBucketBody')}</p>`;
    }
  } catch (e) {
    const err = e as Error;
    statusEl.textContent = t('conn.connectionError');
    if (/ListAllMyBuckets|not authorized|AccessDenied/i.test(err.message)) {
      toggleEmpty(true, p);
      paneEl('empty', p).innerHTML = `
        <h2>${t('conn.iamTitle')}</h2>
        <p>${t('conn.iamBodyHtml')}</p>
        <button class="btn btn-primary" data-edit-this-conn>${t('conn.editConnection')}</button>
      `;
      const btn = paneEl('empty', p).querySelector<HTMLButtonElement>('[data-edit-this-conn]');
      if (btn) btn.onclick = (): void => openEditModal(conn);
    } else {
      toast(t('conn.connectError', { message: err.message }), 'error', errorIdOpts(err));
    }
  }
}

// Same shape as api/client.ts authHeaders() but parameterized on a Connection,
// so we can issue requests on behalf of a non-active pane (e.g. when the user
// clicks the sidebar while focused on the other side).
function connHeaders(c: Connection): Record<string, string> {
  return {
    'x-s3-endpoint': c.endpoint || '',
    'x-s3-region': c.region || 'us-east-1',
    'x-s3-access-key': c.accessKey,
    'x-s3-secret-key': c.secretKey,
    'x-s3-session-token': c.sessionToken || '',
    'x-s3-path-style': c.pathStyle ? 'true' : 'false',
    'x-s3-conn-id': c.id,
  };
}

// When the active pane changes (user clicks the other side), refresh the
// sidebar so its highlight reflects whichever pane is now focused. Also
// auto-expand whatever connection the focused pane is using.
subscribe('activePane', () => {
  const cid = getPane().activeConnId;
  if (cid) expanded.add(cid);
  renderConnections();
});

export function clearMain(): void {
  expanded.clear();
  bucketCache.clear();
  inflight.clear();
  const ulMaybe = document.getElementById('connections');
  if (ulMaybe) ulMaybe.innerHTML = '';
  for (const p of ['left', 'right'] as PaneId[]) {
    const grid = document.querySelector<HTMLElement>(`.pane[data-pane="${p}"] [data-el="grid"]`);
    const crumbs = document.querySelector<HTMLElement>(`.pane[data-pane="${p}"] [data-el="breadcrumbs"]`);
    if (grid) grid.style.display = 'none';
    if (crumbs) crumbs.innerHTML = '';
  }
  const s = $('conn-status');
  s.textContent = t('sidebar.noConnection');
  s.classList.remove('online');
}

// Exposed so other modules can refresh the tree after creating a bucket, etc.
// Re-fetches buckets for the active pane's connection then re-renders.
export async function refreshActiveConnBuckets(): Promise<void> {
  const cid = getPane().activeConnId;
  if (!cid) return;
  const conn = State.connections.find((c) => c.id === cid);
  if (!conn) return;
  await refreshConnBuckets(conn);
  renderConnections();
}

// Re-export for callers that still want the legacy "loadVersioning"/"openBucket"
// names from this module. (Existing imports point at ../buckets/list.ts directly.)
export { openBucket, loadVersioning };
