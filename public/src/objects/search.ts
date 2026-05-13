// Search controller. Two modes:
//
//   1. As-you-type (input event)  → updates State.filterTerm and re-renders
//      the grid with a local substring filter on the current prefix.
//
//   2. Enter / "search all bucket" link → goes recursive across the whole
//      bucket. New: if the FTS5 index is fresh (status.last_indexed_at within
//      24h), uses GET /api/index/:bucket/search for near-instant results.
//      Otherwise falls back to GET /api/search-stream with the NDJSON
//      progress events (the legacy flow).
//
// Search state lives on each pane independently — there's one in-flight
// AbortController per pane so a recursive search on the left can keep
// running while the user types on the right.

import { State, getPane, setActivePane, withPane } from '../state.js';
import type { PaneId } from '../state.js';
import { api, authHeaders } from '../api/client.js';
import { paneEl, paneRoot, escapeHtml } from '../util/dom.js';
import type { S3Object, SearchFolderInfo } from '../types.js';

let onRenderGrid: (paneId: PaneId) => void = () => undefined;
let onLoadObjects: (paneId: PaneId) => void | Promise<void> = () => undefined;

export function configureSearch(deps: {
  onRenderGrid: (paneId: PaneId) => void;
  onLoadObjects: (paneId: PaneId) => void | Promise<void>;
}): void {
  onRenderGrid = deps.onRenderGrid;
  onLoadObjects = deps.onLoadObjects;
}

const searchDebounce: Record<PaneId, ReturnType<typeof setTimeout> | null> = { left: null, right: null };
const searchAbort: Record<PaneId, AbortController | null> = { left: null, right: null };

function categorizeMatch(key: string, qLower: string): { type: 'folder' | 'file'; key: string } {
  const segments = key.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].toLowerCase().includes(qLower)) {
      return { type: 'folder', key: segments.slice(0, i + 1).join('/') + '/' };
    }
  }
  return { type: 'file', key };
}

export function clearSearch(paneId: PaneId): void {
  if (searchAbort[paneId]) searchAbort[paneId]!.abort();
  (paneEl('search-input', paneId) as HTMLInputElement).value = '';
  const pane = getPane(paneId);
  pane.filterTerm = '';
  pane.searchResults = null;
  pane.searchFolderHits = null;
  pane.searchMeta = null;
  paneEl('btn-search-clear', paneId).style.display = 'none';
  updateSearchBanner(paneId);
  onRenderGrid(paneId);
}

interface IndexStatus {
  last_indexed_at: string | null;
  object_count: number;
  last_error: string | null;
  stale: boolean;
}

interface FtsHit {
  Key: string;
  Size: number | null;
  LastModified: string | null;
  ETag: string | null;
  StorageClass: string | null;
}

// Fast path: query the FTS5 index. Returns true if the index was used (whether
// hits or 0), false if the caller should fall back to /api/search-stream.
async function tryFtsSearch(q: string, qLower: string, paneId: PaneId): Promise<boolean> {
  const pane = getPane(paneId);
  if (!pane.activeBucket) return false;
  try {
    const status = await api<IndexStatus>(
      `/api/index/${encodeURIComponent(pane.activeBucket)}/status`,
    );
    if (!status.last_indexed_at || status.stale) return false;
  } catch {
    return false; // /status failed → fall back
  }
  try {
    const { results } = await api<{ results: FtsHit[] }>(
      `/api/index/${encodeURIComponent(pane.activeBucket)}/search?q=${encodeURIComponent(q)}&limit=2000`,
    );
    pane.searchResults = [];
    pane.searchFolderHits = new Map<string, SearchFolderInfo>();
    for (const r of results) {
      const cat = categorizeMatch(r.Key, qLower);
      if (cat.type === 'folder') {
        const cur = pane.searchFolderHits.get(cat.key) || {
          fileCount: 0, totalSize: 0, latestModified: null,
        };
        cur.fileCount++;
        cur.totalSize += r.Size ?? 0;
        if (!cur.latestModified || (r.LastModified && new Date(r.LastModified) > new Date(cur.latestModified))) {
          cur.latestModified = r.LastModified;
        }
        pane.searchFolderHits.set(cat.key, cur);
      } else {
        pane.searchResults.push({
          Key: r.Key,
          Size: r.Size ?? 0,
          LastModified: r.LastModified ?? undefined,
          ETag: r.ETag ?? undefined,
        });
      }
    }
    pane.searchMeta = {
      scanned: results.length,
      hits: results.length,
      query: q,
      status: 'done',
      reason: 'fts',
    };
    onRenderGrid(paneId);
    updateSearchBanner(paneId);
    return true;
  } catch (e) {
    console.warn('[search] FTS5 path failed, falling back:', (e as Error).message);
    return false;
  }
}

async function runRecursiveSearch(paneId: PaneId): Promise<void> {
  const pane = getPane(paneId);
  const q = pane.filterTerm.trim();
  if (!q || !pane.activeBucket) return;
  if (searchAbort[paneId]) searchAbort[paneId]!.abort();
  searchAbort[paneId] = new AbortController();

  const qLower = q.toLowerCase();
  pane.searchResults = [];
  pane.searchFolderHits = new Map();
  pane.searchMeta = { scanned: 0, hits: 0, query: q, status: 'scanning' };
  pane.selected.clear();
  onRenderGrid(paneId);
  updateSearchBanner(paneId);

  if (await tryFtsSearch(q, qLower, paneId)) return;

  let rerenderTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRerender = (): void => {
    if (rerenderTimer) return;
    rerenderTimer = setTimeout(() => {
      rerenderTimer = null;
      onRenderGrid(paneId);
      updateSearchBanner(paneId);
    }, 120);
  };

  try {
    const params = new URLSearchParams({ q });
    const res = await fetch(`/api/search-stream/${encodeURIComponent(pane.activeBucket)}?${params}`, {
      headers: authHeaders(),
      signal: searchAbort[paneId]!.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText } as { message: string }));
      throw new Error(err.message);
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
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line); } catch { continue; }

        if (ev.t === 'hit') {
          const key = String(ev.key);
          const cat = categorizeMatch(key, qLower);
          if (cat.type === 'folder') {
            const cur = pane.searchFolderHits!.get(cat.key) || {
              fileCount: 0, totalSize: 0, latestModified: null,
            };
            cur.fileCount++;
            cur.totalSize += (ev.size as number | undefined) ?? 0;
            const modified = ev.modified as string | undefined;
            if (modified && (!cur.latestModified || new Date(modified) > new Date(cur.latestModified))) {
              cur.latestModified = modified;
            }
            pane.searchFolderHits!.set(cat.key, cur);
          } else {
            pane.searchResults!.push({
              Key: key,
              Size: (ev.size as number | undefined) ?? 0,
              LastModified: ev.modified as string | undefined,
              ETag: ev.etag as string | undefined,
            } as S3Object);
          }
          pane.searchMeta!.hits++;
          scheduleRerender();
        } else if (ev.t === 'progress') {
          pane.searchMeta!.scanned = (ev.scanned as number) ?? 0;
          scheduleRerender();
        } else if (ev.t === 'done') {
          pane.searchMeta!.status = 'done';
          pane.searchMeta!.reason = ev.reason as string | undefined;
          pane.searchMeta!.scanned = (ev.scanned as number) ?? 0;
          onRenderGrid(paneId);
          updateSearchBanner(paneId);
        } else if (ev.t === 'error') {
          pane.searchMeta!.status = 'error';
          pane.searchMeta!.error = ev.message as string | undefined;
          updateSearchBanner(paneId);
        }
      }
    }
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') {
      if (pane.searchMeta) pane.searchMeta.status = 'cancelled';
      updateSearchBanner(paneId);
      onRenderGrid(paneId);
      return;
    }
    if (pane.searchMeta) {
      pane.searchMeta.status = 'error';
      pane.searchMeta.error = err.message;
    }
    updateSearchBanner(paneId);
  }
}

export function runRecursiveSearchForLink(paneId: PaneId): Promise<void> {
  return runRecursiveSearch(paneId);
}

export function updateSearchBanner(paneId?: PaneId): void {
  const p: PaneId = paneId || State.activePane;
  withPane(p, () => {
    const banner = paneEl('search-banner', p);
    if (!State.searchMeta) { banner.style.display = 'none'; return; }
    const { scanned, query, status, reason, error } = State.searchMeta;
    const folderCount = State.searchFolderHits?.size || 0;
    const fileCount = State.searchResults?.length || 0;

    let statusLabel = '';
    if (status === 'scanning') {
      statusLabel = '<span style="color:var(--accent)">escaneando…</span>';
    } else if (status === 'done') {
      if (reason === 'limit') statusLabel = '<span class="truncated">tope de resultados (refina la búsqueda)</span>';
      else if (reason === 'fts') statusLabel = '<span style="color:var(--success)">índice FTS5</span>';
      else statusLabel = '<span style="color:var(--success)">completo</span>';
    } else if (status === 'cancelled') {
      statusLabel = '<span class="truncated">cancelado</span>';
    } else if (status === 'error') {
      statusLabel = `<span style="color:var(--danger)">error: ${escapeHtml(error || '')}</span>`;
    }

    banner.style.display = 'flex';
    banner.innerHTML = `
      <span>
        <strong>${folderCount}</strong> carpeta(s) · <strong>${fileCount}</strong> archivo(s)
        para "<strong>${escapeHtml(query)}</strong>"
        · escaneados ${scanned.toLocaleString()}
        · ${statusLabel}
      </span>
      <span style="display:flex; gap:6px">
        ${status === 'scanning' ? '<button class="btn" data-search-cancel>Cancelar</button>' : ''}
        <button class="btn" data-search-exit>Salir</button>
      </span>
    `;
    (banner.querySelector('[data-search-exit]') as HTMLButtonElement).onclick = (): void => clearSearch(p);
    const cancelBtn = banner.querySelector('[data-search-cancel]') as HTMLButtonElement | null;
    if (cancelBtn) cancelBtn.onclick = (): void => { if (searchAbort[p]) searchAbort[p]!.abort(); };
  });
}

export function initSearch(paneId: PaneId): void {
  const searchInput = paneEl('search-input', paneId) as HTMLInputElement;
  const searchClearBtn = paneEl('btn-search-clear', paneId);
  const pane = getPane(paneId);

  searchInput.addEventListener('focus', () => setActivePane(paneId));
  searchInput.addEventListener('input', (e: Event) => {
    setActivePane(paneId);
    pane.filterTerm = (e.target as HTMLInputElement).value;
    searchClearBtn.style.display = pane.filterTerm ? 'block' : 'none';
    if (pane.searchResults !== null) {
      pane.searchResults = null;
      pane.searchMeta = null;
      updateSearchBanner(paneId);
    }
    if (searchDebounce[paneId]) clearTimeout(searchDebounce[paneId]!);
    searchDebounce[paneId] = setTimeout(() => onRenderGrid(paneId), 80);
  });

  searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (pane.filterTerm.trim()) void runRecursiveSearch(paneId);
    } else if (e.key === 'Escape') {
      clearSearch(paneId);
    }
  });

  searchClearBtn.onclick = (): void => clearSearch(paneId);

  paneRoot(paneId).querySelectorAll<HTMLElement>('.grid th.sortable').forEach((th) => {
    th.onclick = (): void => {
      setActivePane(paneId);
      const field = th.dataset.sort as 'name' | 'size' | 'modified';
      if (pane.sort.field === field) {
        pane.sort.dir = pane.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        pane.sort = { field, dir: 'asc' };
      }
      onRenderGrid(paneId);
    };
  });

  (paneEl('chk-deleted', paneId) as HTMLInputElement).addEventListener('change', (e: Event) => {
    setActivePane(paneId);
    pane.showDeleted = (e.target as HTMLInputElement).checked;
    void onLoadObjects(paneId);
  });
}
