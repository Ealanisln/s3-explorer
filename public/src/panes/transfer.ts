// Two-pane transfer client. Consumes the SSE stream from POST /api/transfer
// (shipped in MR D / !17). The UI runs through a confirm modal → progress
// modal; cancel sends AbortController.abort() which closes the request and
// the server's `req.on('close')` handler aborts the in-flight copy.
//
// Items are addressed by source-key. destKey defaults to the dest pane's
// current prefix + basename(sourceKey). For cross-prefix folder drops that
// preserve structure, callers can pass `keepRelative=true` and a `sourcePrefix`
// — keys then become destPrefix + (sourceKey.slice(sourcePrefix.length)).

import { paneConn, getPane } from '../state.js';
import type { PaneId } from '../state.js';
import { $, openModal, closeModal, escapeHtml } from '../util/dom.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { t } from '../i18n/index.js';
import type { Connection } from '../types.js';
import { loadObjects } from '../objects/grid.js';

export interface TransferRequest {
  sourcePaneId: PaneId;
  destPaneId: PaneId;
  // Either explicit file keys OR a folder prefix (mutually exclusive).
  keys?: string[];
  folder?: { sourcePrefix: string };
  // Pre-selected mode (from a context-menu pick). When omitted, the confirm
  // modal asks the user. Either way the modal opens for a final confirmation.
  preselectMode?: 'copy' | 'move';
  // When true, destKey preserves the path relative to `sourcePrefix`.
  keepRelative?: boolean;
  sourcePrefix?: string;
  // Override the destination prefix. Default is `destPane.prefix`. Used for
  // intra-pane drops onto a specific folder row: the destination is that
  // folder, NOT the currently-open folder.
  destPrefixOverride?: string;
  // For folder mode only: when true, the server lands keys at
  // `destPrefixOverride + rel` instead of `destPrefixOverride + sourceFolderName + rel`.
  // Used by folder rename, where the caller already encoded the new name in
  // destPrefixOverride.
  flattenFolder?: boolean;
  // Skip the copy/move confirm modal entirely. Used by callers that already
  // showed their own confirm (folder rename) — going through the standard
  // one would ask "Copiar vs Mover" again, which is confusing.
  skipConfirm?: boolean;
}

function sideHeaders(c: Connection, side: 'source' | 'dest'): Record<string, string> {
  const p = `x-s3-${side}-`;
  return {
    [p + 'endpoint']: c.endpoint || '',
    [p + 'region']: c.region || 'us-east-1',
    [p + 'access-key']: c.accessKey,
    [p + 'secret-key']: c.secretKey,
    [p + 'session-token']: c.sessionToken || '',
    [p + 'path-style']: c.pathStyle ? 'true' : 'false',
  };
}

function basename(key: string): string {
  return key.split('/').pop() || key;
}

// Status labels as plain-text badges. (Earlier iterations used SVG icons,
// but they rendered inconsistently in some browsers — text labels are
// bullet-proof and screen-reader-friendly out of the box.)
type StatusKey = 'pending' | 'active' | 'done' | 'error';
// Built lazily (functions, not consts) so each row paints in the CURRENT
// language rather than the boot-time one.
function statusText(status: StatusKey, mode: 'copy' | 'move'): string {
  if (status === 'pending') return t('transfer.pending');
  if (status === 'error') return t('common.error');
  if (mode === 'move') return status === 'active' ? t('transfer.moving') : t('transfer.moved');
  return status === 'active' ? t('transfer.copying') : t('transfer.copied');
}

function setRowStatus(row: HTMLElement, status: StatusKey, mode: 'copy' | 'move'): void {
  const cell = row.querySelector('.status');
  if (!cell) return;
  cell.textContent = statusText(status, mode);
}

function buildItems(req: TransferRequest): { key: string; destKey: string }[] {
  const destPane = getPane(req.destPaneId);
  const destPrefix = req.destPrefixOverride ?? destPane.prefix;
  const keys = req.keys ?? [];
  return keys.map((key) => {
    let destKey: string;
    if (req.keepRelative && req.sourcePrefix !== undefined) {
      const rel = key.startsWith(req.sourcePrefix) ? key.slice(req.sourcePrefix.length) : basename(key);
      destKey = destPrefix + rel;
    } else {
      destKey = destPrefix + basename(key);
    }
    return { key, destKey };
  });
}

// ── Confirm modal ─────────────────────────────────────────────────────────

interface ConfirmDeps {
  count: number;
  sourceLabel: string;
  destLabel: string;
  crossConn: boolean;
  preselect?: 'copy' | 'move';
  // When set, this is a folder transfer — show the prefix instead of a file
  // count. Server discovers content; we don't know the exact item count yet.
  folderLabel?: string;
}

function openConfirmModal(deps: ConfirmDeps): Promise<'copy' | 'move' | null> {
  // Switch the count slot to show either "N archivos" or "carpeta foo/".
  // The HTML element exists in both modes; we just rewrite its content.
  if (deps.folderLabel !== undefined) {
    $('transfer-confirm-count').textContent = t('transfer.folderLabel', { name: deps.folderLabel });
  } else {
    $('transfer-confirm-count').textContent = String(deps.count);
  }
  $('transfer-confirm-source').textContent = deps.sourceLabel;
  $('transfer-confirm-dest').textContent = deps.destLabel;
  $('transfer-confirm-cross').style.display = deps.crossConn ? 'block' : 'none';
  // Re-tag the primary button to match the pre-selected mode so Enter / first
  // focus does the intuitive thing.
  const copyBtn = $('btn-transfer-do-copy');
  const moveBtn = $('btn-transfer-do-move');
  copyBtn.classList.toggle('btn-primary', deps.preselect !== 'move');
  moveBtn.classList.toggle('btn-primary', deps.preselect === 'move');
  openModal('modal-transfer-confirm');
  (deps.preselect === 'move' ? moveBtn : copyBtn).focus();
  return new Promise((resolve) => {
    const cleanup = (result: 'copy' | 'move' | null): void => {
      $('btn-transfer-cancel').onclick = null;
      copyBtn.onclick = null;
      moveBtn.onclick = null;
      closeModal('modal-transfer-confirm');
      resolve(result);
    };
    $('btn-transfer-cancel').onclick = (): void => cleanup(null);
    copyBtn.onclick = (): void => cleanup('copy');
    moveBtn.onclick = (): void => cleanup('move');
  });
}

// ── Progress modal ────────────────────────────────────────────────────────

interface ProgressState {
  byKey: Map<string, HTMLElement>;
  mode: 'copy' | 'move';
  abort: AbortController;
  ok: number;
  failed: number;
  // Folder/recursive mode: total is `null` until the server emits `discovered`.
  // In items mode, total is known from the start.
  total: number | null;
  isFolderMode: boolean;
  // Rolling cap for the DOM list. Older `done` rows are evicted when exceeded.
  // Error rows are pinned and never evicted (typically rare).
  maxRowsInList: number;
}

// Initial state shape depends on whether we know the items upfront (file list)
// or have to discover them server-side (folder).
function openProgressModal(opts: {
  knownItems: { key: string; destKey: string }[] | null;
  mode: 'copy' | 'move';
  isFolderMode: boolean;
  initialTitle: string;
}): ProgressState {
  $('transfer-progress-title').textContent = opts.initialTitle;
  ($('btn-transfer-close') as HTMLButtonElement).style.display = 'none';
  ($('btn-transfer-abort') as HTMLButtonElement).style.display = 'inline-flex';
  ($('btn-transfer-abort') as HTMLButtonElement).textContent = t('common.cancel');
  ($('btn-transfer-abort') as HTMLButtonElement).disabled = false;
  ($('transfer-progress-fill') as HTMLElement).style.width = '0%';
  // Sweep animation while transfer is active. CSS toggles via the
  // `.in-progress` class on the outer bar.
  ($('transfer-progress-fill').parentElement as HTMLElement | null)?.classList.add('in-progress');

  const list = $('transfer-item-list');
  list.innerHTML = '';
  const byKey = new Map<string, HTMLElement>();
  const total = opts.knownItems ? opts.knownItems.length : null;
  $('transfer-progress-summary').textContent = opts.isFolderMode
    ? t('transfer.discoveringFolder')
    : `0 / ${total ?? '?'}`;
  if (opts.knownItems) {
    for (const it of opts.knownItems) {
      const row = addRow(byKey, list, it.key, 'pending');
      setRowStatus(row, 'pending', opts.mode);
    }
  }
  openModal('modal-transfer-progress');

  const abort = new AbortController();
  ($('btn-transfer-abort') as HTMLButtonElement).onclick = (): void => {
    abort.abort();
    ($('btn-transfer-abort') as HTMLButtonElement).disabled = true;
    ($('btn-transfer-abort') as HTMLButtonElement).textContent = t('progress.cancelling');
  };

  return {
    byKey, mode: opts.mode, abort,
    ok: 0, failed: 0,
    total, isFolderMode: opts.isFolderMode,
    maxRowsInList: 50,
  };
}

// Create (or return existing) row for a key. In folder mode rows are created
// lazily as items appear via `progress` frames. The rolling cap is enforced
// when adding — oldest `done` row is evicted if we'd go over.
function addRow(byKey: Map<string, HTMLElement>, list: HTMLElement, key: string, initialClass: string): HTMLElement {
  const existing = byKey.get(key);
  if (existing) return existing;
  const row = document.createElement('div');
  row.className = `transfer-item ${initialClass}`;
  row.innerHTML = `<span class="status"></span>`
    + `<span class="key" title="${escapeHtml(key)}">${escapeHtml(key)}</span>`
    + `<span class="err-msg"></span>`;
  list.appendChild(row);
  byKey.set(key, row);
  return row;
}

// Roll the list down to maxRowsInList by evicting the oldest `done` row.
// Errors are pinned (never evicted) so users can see what failed.
function evictIfNeeded(state: ProgressState, list: HTMLElement): void {
  while (list.children.length > state.maxRowsInList) {
    const oldestDone = list.querySelector<HTMLElement>('.transfer-item.done');
    if (!oldestDone) break;            // nothing safe to remove
    // Find which key maps to this element so we can clear it from byKey.
    for (const [k, el] of state.byKey) {
      if (el === oldestDone) { state.byKey.delete(k); break; }
    }
    oldestDone.remove();
  }
}

function finishProgressModal(state: ProgressState, aborted: boolean): void {
  ($('btn-transfer-abort') as HTMLButtonElement).style.display = 'none';
  ($('btn-transfer-close') as HTMLButtonElement).style.display = 'inline-flex';
  // Stop the sweep animation; bar stays at its final width.
  ($('transfer-progress-fill').parentElement as HTMLElement | null)?.classList.remove('in-progress');
  const verb = state.mode === 'move' ? t('transfer.verbMoved') : t('transfer.verbCopied');
  const tail = aborted ? t('progress.cancelledSuffix') : '';
  const totalSuffix = state.total !== null && state.total !== state.ok + state.failed
    ? t('transfer.ofTotal', { total: state.total.toLocaleString() }) : '';
  $('transfer-progress-summary').textContent = t('transfer.summary', {
    ok: state.ok.toLocaleString(),
    verb,
    failed: state.failed.toLocaleString(),
    total: totalSuffix,
    tail,
  });
}

// ── SSE frame handling ────────────────────────────────────────────────────

interface DiscoveringFrame { t: 'discovering'; scanned: number }
interface DiscoveredFrame { t: 'discovered'; total: number }
interface ProgressFrame { t: 'progress'; completed: number; total: number; currentKey: string }
interface BytesFrame { t: 'bytes'; key: string; loaded: number; total: number }
interface ItemDoneFrame { t: 'item-done'; key: string }
interface ItemErrorFrame { t: 'item-error'; key: string; message: string }
interface DoneFrame { t: 'done'; ok: number; failed: number }
interface FatalFrame { t: 'fatal'; message?: string; errorId?: string }
type SseFrame =
  | DiscoveringFrame | DiscoveredFrame
  | ProgressFrame | BytesFrame
  | ItemDoneFrame | ItemErrorFrame | DoneFrame | FatalFrame;

function applyFrame(state: ProgressState, ev: SseFrame): void {
  const list = $('transfer-item-list');
  if (ev.t === 'discovering') {
    // Folder mode: backend is still walking ListObjectsV2. Tell the user.
    $('transfer-progress-summary').textContent = t('transfer.discoveringCount', { count: ev.scanned.toLocaleString() });
  } else if (ev.t === 'discovered') {
    // Discovery done — `total` is now stable. Subsequent `progress` frames
    // use this total for the bar %.
    state.total = ev.total;
    $('transfer-progress-summary').textContent = t('transfer.discovered', { count: ev.total.toLocaleString() });
  } else if (ev.t === 'progress') {
    // Special sentinel keys from the backend circuit breakers — surface as
    // visible errors but don't try to add a row for them by their fake key.
    if (ev.currentKey === '__OVERFLOW__' || ev.currentKey === '__CIRCUIT_BREAKER__') return;
    // Lazily create the row if we're in folder mode (no pre-population).
    const row = addRow(state.byKey, list, ev.currentKey, 'pending');
    setRowStatus(row, 'pending', state.mode);
    // Mark previously-active rows as best-effort done (defensive: backend
    // always emits item-done before next progress, but if a frame is lost or
    // we evicted the row, this prevents an orphan-active state).
    state.byKey.forEach((r) => {
      if (r !== row && r.classList.contains('active')) {
        r.classList.remove('active');
        r.classList.add('done');
        setRowStatus(r, 'done', state.mode);
      }
    });
    row.classList.remove('pending');
    row.classList.add('active');
    setRowStatus(row, 'active', state.mode);
    evictIfNeeded(state, list);
    // Bar percent: known total → real %, else 0% with text indication.
    const total = state.total ?? ev.total ?? 0;
    const pct = total > 0 ? (ev.completed / total) * 100 : 0;
    ($('transfer-progress-fill') as HTMLElement).style.width = pct.toFixed(1) + '%';
    const denominator = state.total !== null
      ? state.total.toLocaleString()
      : `${ev.total.toLocaleString()}+`;  // discovering still
    $('transfer-progress-summary').textContent =
      `${ev.completed.toLocaleString()} / ${denominator} · ${escapeHtml(ev.currentKey)}`;
  } else if (ev.t === 'bytes') {
    // (Bytes-level progress within a single item — reserved for future UI
    // showing per-file %. For now we just let the overall bar reflect items.)
    return;
  } else if (ev.t === 'item-done') {
    const row = state.byKey.get(ev.key);
    if (row) {
      row.classList.remove('active', 'pending');
      row.classList.add('done');
      setRowStatus(row, 'done', state.mode);
    }
    // Don't evict here — eviction happens when the NEXT row is added, so the
    // user gets to see the row briefly transition to "done".
  } else if (ev.t === 'item-error') {
    // Surface sentinel errors at the top of the list with full text.
    if (ev.key === '__OVERFLOW__' || ev.key === '__CIRCUIT_BREAKER__') {
      const sentinel = document.createElement('div');
      sentinel.className = 'transfer-item error';
      sentinel.innerHTML = `<span class="status"></span>`
        + `<span class="key">${escapeHtml(ev.key)}</span>`
        + `<span class="err-msg">${escapeHtml(ev.message)}</span>`;
      list.insertBefore(sentinel, list.firstChild);
      return;
    }
    const row = addRow(state.byKey, list, ev.key, 'pending');
    row.classList.remove('active', 'pending');
    row.classList.add('error');
    setRowStatus(row, 'error', state.mode);
    const em = row.querySelector('.err-msg');
    if (em) em.textContent = ev.message;
  } else if (ev.t === 'done') {
    state.ok = ev.ok;
    state.failed = ev.failed;
    ($('transfer-progress-fill') as HTMLElement).style.width = '100%';
  }
  // 'fatal' surfaces via the toast in the runner.
}

// ── Public entry point ────────────────────────────────────────────────────

export async function runTransfer(req: TransferRequest): Promise<void> {
  const sourceConn = paneConn(req.sourcePaneId);
  const destConn = paneConn(req.destPaneId);
  if (!sourceConn || !destConn) {
    toast(t('transfer.missingConn'), 'error');
    return;
  }
  const sourcePane = getPane(req.sourcePaneId);
  const destPane = getPane(req.destPaneId);
  if (!sourcePane.activeBucket || !destPane.activeBucket) {
    toast(t('transfer.missingBucket'), 'error');
    return;
  }

  // Exactly one of keys / folder must be set.
  const isFolderMode = !!req.folder;
  if (isFolderMode === Boolean(req.keys?.length)) {
    toast(t('transfer.invalidDrop'), 'error');
    return;
  }

  const crossConn = sourceConn.id !== destConn.id;
  const crossBucket = sourcePane.activeBucket !== destPane.activeBucket;
  const effectiveDestPrefix = req.destPrefixOverride ?? destPane.prefix;
  // Source prefix: for folder transfers we use the folder's prefix; otherwise
  // the pane's current prefix.
  const effectiveSourcePrefix = req.folder?.sourcePrefix ?? sourcePane.prefix;

  // Build labels. When source and dest live in the same bucket+connection,
  // collapse the redundant parts so the user sees `prefix/ → prefix/` cleanly
  // instead of two long identical paths.
  let sourceLabel: string;
  let destLabel: string;
  if (!crossConn && !crossBucket) {
    const bucket = sourcePane.activeBucket || '';
    sourceLabel = `${bucket}/${effectiveSourcePrefix || ''}`;
    destLabel = `${bucket}/${effectiveDestPrefix || ''}`;
  } else {
    sourceLabel = `${sourceConn.name} · ${sourcePane.activeBucket}/${effectiveSourcePrefix || ''}`;
    destLabel = `${destConn.name} · ${destPane.activeBucket}/${effectiveDestPrefix || ''}`;
  }

  // Confirm modal: for folders, show "carpeta foo/" instead of file count.
  // We don't pre-discover (would require an extra round trip); user confirms
  // and discovery happens inside the same SSE stream.
  //
  // `skipConfirm` callers (e.g. folder rename) have already shown their own
  // confirm and pass `preselectMode` to lock in the operation — no second
  // dialog needed.
  let mode: 'copy' | 'move' | null;
  if (req.skipConfirm && req.preselectMode) {
    mode = req.preselectMode;
  } else {
    const confirmCount = isFolderMode ? 0 : (req.keys?.length ?? 0);
    mode = await openConfirmModal({
      count: confirmCount, sourceLabel, destLabel, crossConn,
      preselect: req.preselectMode,
      folderLabel: req.folder?.sourcePrefix,
    });
  }
  if (!mode) return;

  const items = isFolderMode ? null : buildItems({ ...req, keys: req.keys ?? [] });
  const verbTitle = mode === 'move' ? t('transfer.titleMoving') : t('transfer.titleCopying');
  const state = openProgressModal({
    knownItems: items,
    mode,
    isFolderMode,
    initialTitle: isFolderMode
      ? t('transfer.titleFolder', { verb: verbTitle })
      : t('transfer.titleFiles', { verb: verbTitle }),
  });

  // Body shape: items vs prefix (mutually exclusive per the server schema).
  const body: Record<string, unknown> = {
    sourceBucket: sourcePane.activeBucket,
    destBucket: destPane.activeBucket,
    mode,
  };
  if (isFolderMode) {
    body.prefix = {
      source: req.folder!.sourcePrefix,
      dest: effectiveDestPrefix || '',
      ...(req.flattenFolder ? { flatten: true } : {}),
    };
  } else {
    body.items = items;
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...sideHeaders(sourceConn, 'source'),
      ...sideHeaders(destConn, 'dest'),
    };
    const res = await fetch('/api/transfer', {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      signal: state.abort.signal,
      body: JSON.stringify(body),
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
      // SSE frames are `data: <json>\n\n`. Split on blank lines, parse each.
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        // Each frame may have multiple `data:` lines per spec; we emit one.
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim()) as SseFrame;
          if (ev.t === 'fatal') {
            toast(t('api.serverError', { message: (ev as FatalFrame).message || t('common.unknown') }), 'error',
              (ev as FatalFrame).errorId ? { errorId: (ev as FatalFrame).errorId } : undefined);
            continue;
          }
          applyFrame(state, ev);
        } catch (e) {
          console.warn('[transfer] bad frame', frame, e);
        }
      }
    }

    finishProgressModal(state, false);
    if (state.failed === 0) {
      toast(t('transfer.completedOk', { count: state.ok, verb: mode === 'move' ? t('transfer.verbMoved') : t('transfer.verbCopied') }), 'success');
    } else {
      toast(t('progress.completedWithErrors', { count: state.failed }), 'error');
    }
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') {
      finishProgressModal(state, true);
      toast(t('transfer.cancelled'), 'info');
    } else {
      finishProgressModal(state, false);
      toast(t('grid.listError', { message: err.message }), 'error', errorIdOpts(e));
    }
  } finally {
    // Refresh the dest pane (always) and the source pane (for moves so the
    // removed entries disappear from the listing).
    void loadObjects(req.destPaneId);
    if (state.mode === 'move') void loadObjects(req.sourcePaneId);
  }
}

export function initTransferModalDismiss(): void {
  // Wire the close (✕) button on the progress modal — only useful after finish.
  ($('btn-transfer-close') as HTMLButtonElement).onclick = (): void => {
    closeModal('modal-transfer-progress');
  };
}
