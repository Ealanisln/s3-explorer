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
import type { Connection } from '../types.js';
import { loadObjects } from '../objects/grid.js';

export interface TransferRequest {
  sourcePaneId: PaneId;
  destPaneId: PaneId;
  // Source keys to transfer. `destKey` is computed from the dest pane's prefix
  // + basename(key) unless `keepRelative` is set.
  keys: string[];
  // Pre-selected mode (from a context-menu pick). When omitted, the confirm
  // modal asks the user. Either way the modal opens for a final confirmation.
  preselectMode?: 'copy' | 'move';
  // When true, destKey preserves the path relative to `sourcePrefix`.
  keepRelative?: boolean;
  sourcePrefix?: string;
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

function buildItems(req: TransferRequest): { key: string; destKey: string }[] {
  const destPane = getPane(req.destPaneId);
  const destPrefix = destPane.prefix;
  return req.keys.map((key) => {
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
}

function openConfirmModal(deps: ConfirmDeps): Promise<'copy' | 'move' | null> {
  $('transfer-confirm-count').textContent = String(deps.count);
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
  items: { key: string; destKey: string }[];
  byKey: Map<string, HTMLElement>;
  mode: 'copy' | 'move';
  abort: AbortController;
  ok: number;
  failed: number;
}

function openProgressModal(items: { key: string; destKey: string }[], mode: 'copy' | 'move'): ProgressState {
  $('transfer-progress-title').textContent = mode === 'move' ? 'Moviendo archivos' : 'Copiando archivos';
  ($('btn-transfer-close') as HTMLButtonElement).style.display = 'none';
  ($('btn-transfer-abort') as HTMLButtonElement).style.display = 'inline-flex';
  ($('btn-transfer-abort') as HTMLButtonElement).textContent = 'Cancelar';
  ($('btn-transfer-abort') as HTMLButtonElement).disabled = false;
  $('transfer-progress-summary').textContent = `0 / ${items.length}`;
  ($('transfer-progress-fill') as HTMLElement).style.width = '0%';

  const list = $('transfer-item-list');
  list.innerHTML = '';
  const byKey = new Map<string, HTMLElement>();
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'transfer-item pending';
    row.innerHTML = `<span class="status"></span><span class="key" title="${escapeHtml(it.key)}">${escapeHtml(it.key)}</span><span class="err-msg"></span>`;
    list.appendChild(row);
    byKey.set(it.key, row);
  }
  openModal('modal-transfer-progress');

  const abort = new AbortController();
  ($('btn-transfer-abort') as HTMLButtonElement).onclick = (): void => {
    abort.abort();
    ($('btn-transfer-abort') as HTMLButtonElement).disabled = true;
    ($('btn-transfer-abort') as HTMLButtonElement).textContent = 'Cancelando…';
  };

  return { items, byKey, mode, abort, ok: 0, failed: 0 };
}

function finishProgressModal(state: ProgressState, aborted: boolean): void {
  ($('btn-transfer-abort') as HTMLButtonElement).style.display = 'none';
  ($('btn-transfer-close') as HTMLButtonElement).style.display = 'inline-flex';
  const verb = state.mode === 'move' ? 'movidos' : 'copiados';
  const tail = aborted ? ' (cancelado)' : '';
  $('transfer-progress-summary').textContent =
    `${state.ok} ${verb} · ${state.failed} fallidos${tail}`;
}

// ── SSE frame handling ────────────────────────────────────────────────────

interface ProgressFrame { t: 'progress'; completed: number; total: number; currentKey: string }
interface ItemDoneFrame { t: 'item-done'; key: string }
interface ItemErrorFrame { t: 'item-error'; key: string; message: string }
interface DoneFrame { t: 'done'; ok: number; failed: number }
interface FatalFrame { t: 'fatal'; message?: string; errorId?: string }
type SseFrame = ProgressFrame | ItemDoneFrame | ItemErrorFrame | DoneFrame | FatalFrame;

function applyFrame(state: ProgressState, ev: SseFrame): void {
  if (ev.t === 'progress') {
    const row = state.byKey.get(ev.currentKey);
    if (row) {
      state.byKey.forEach((r) => r.classList.remove('active'));
      row.classList.remove('pending');
      row.classList.add('active');
    }
    const pct = ev.total ? (ev.completed / ev.total) * 100 : 0;
    ($('transfer-progress-fill') as HTMLElement).style.width = pct.toFixed(1) + '%';
    $('transfer-progress-summary').textContent = `${ev.completed} / ${ev.total} · ${escapeHtml(ev.currentKey)}`;
  } else if (ev.t === 'item-done') {
    const row = state.byKey.get(ev.key);
    if (row) { row.classList.remove('active', 'pending'); row.classList.add('done'); }
  } else if (ev.t === 'item-error') {
    const row = state.byKey.get(ev.key);
    if (row) {
      row.classList.remove('active', 'pending');
      row.classList.add('error');
      const em = row.querySelector('.err-msg');
      if (em) em.textContent = ev.message;
    }
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
    toast('Falta conexión activa en uno de los paneles', 'error');
    return;
  }
  const sourcePane = getPane(req.sourcePaneId);
  const destPane = getPane(req.destPaneId);
  if (!sourcePane.activeBucket || !destPane.activeBucket) {
    toast('Falta bucket activo en uno de los paneles', 'error');
    return;
  }

  const sourceLabel = `${sourceConn.name} · ${sourcePane.activeBucket}/${sourcePane.prefix || ''}`;
  const destLabel = `${destConn.name} · ${destPane.activeBucket}/${destPane.prefix || ''}`;
  const crossConn = sourceConn.id !== destConn.id;

  const mode = await openConfirmModal({
    count: req.keys.length, sourceLabel, destLabel, crossConn,
    preselect: req.preselectMode,
  });
  if (!mode) return;

  const items = buildItems(req);
  const state = openProgressModal(items, mode);

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
      body: JSON.stringify({
        sourceBucket: sourcePane.activeBucket,
        destBucket: destPane.activeBucket,
        items,
        mode,
      }),
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
            toast(`Error del servidor: ${(ev as FatalFrame).message || 'desconocido'}`, 'error',
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
      toast(`${state.ok} archivo(s) ${mode === 'move' ? 'movidos' : 'copiados'}`, 'success');
    } else {
      toast(`Completado con ${state.failed} error(es)`, 'error');
    }
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') {
      finishProgressModal(state, true);
      toast('Transferencia cancelada', 'info');
    } else {
      finishProgressModal(state, false);
      toast('Error: ' + err.message, 'error', errorIdOpts(e));
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
