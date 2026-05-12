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

import { State } from '../state.js';
import { api, authHeaders } from '../api/client.js';
import { $, escapeHtml } from '../util/dom.js';
import type { S3Object, SearchFolderInfo } from '../types.js';

let onRenderGrid: () => void = () => undefined;
let onLoadObjects: () => void | Promise<void> = () => undefined;

export function configureSearch(deps: {
  onRenderGrid: () => void;
  onLoadObjects: () => void | Promise<void>;
}): void {
  onRenderGrid = deps.onRenderGrid;
  onLoadObjects = deps.onLoadObjects;
}

let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let searchAbort: AbortController | null = null;

function categorizeMatch(key: string, qLower: string): { type: 'folder' | 'file'; key: string } {
  const segments = key.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].toLowerCase().includes(qLower)) {
      return { type: 'folder', key: segments.slice(0, i + 1).join('/') + '/' };
    }
  }
  return { type: 'file', key };
}

export function clearSearch(): void {
  if (searchAbort) searchAbort.abort();
  ($('search-input') as HTMLInputElement).value = '';
  State.filterTerm = '';
  State.searchResults = null;
  State.searchFolderHits = null;
  State.searchMeta = null;
  $('btn-search-clear').style.display = 'none';
  updateSearchBanner();
  onRenderGrid();
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
async function tryFtsSearch(q: string, qLower: string): Promise<boolean> {
  if (!State.activeBucket) return false;
  try {
    const status = await api<IndexStatus>(
      `/api/index/${encodeURIComponent(State.activeBucket)}/status`,
    );
    if (!status.last_indexed_at || status.stale) return false;
  } catch {
    return false; // /status failed → fall back
  }
  try {
    const { results } = await api<{ results: FtsHit[] }>(
      `/api/index/${encodeURIComponent(State.activeBucket)}/search?q=${encodeURIComponent(q)}&limit=2000`,
    );
    State.searchResults = [];
    State.searchFolderHits = new Map<string, SearchFolderInfo>();
    for (const r of results) {
      const cat = categorizeMatch(r.Key, qLower);
      if (cat.type === 'folder') {
        const cur = State.searchFolderHits.get(cat.key) || {
          fileCount: 0, totalSize: 0, latestModified: null,
        };
        cur.fileCount++;
        cur.totalSize += r.Size ?? 0;
        if (!cur.latestModified || (r.LastModified && new Date(r.LastModified) > new Date(cur.latestModified))) {
          cur.latestModified = r.LastModified;
        }
        State.searchFolderHits.set(cat.key, cur);
      } else {
        State.searchResults.push({
          Key: r.Key,
          Size: r.Size ?? 0,
          LastModified: r.LastModified ?? undefined,
          ETag: r.ETag ?? undefined,
        });
      }
    }
    State.searchMeta = {
      scanned: results.length,
      hits: results.length,
      query: q,
      status: 'done',
      reason: 'fts',
    };
    onRenderGrid();
    updateSearchBanner();
    return true;
  } catch (e) {
    console.warn('[search] FTS5 path failed, falling back:', (e as Error).message);
    return false;
  }
}

async function runRecursiveSearch(): Promise<void> {
  const q = State.filterTerm.trim();
  if (!q || !State.activeBucket) return;
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();

  const qLower = q.toLowerCase();
  State.searchResults = [];
  State.searchFolderHits = new Map();
  State.searchMeta = { scanned: 0, hits: 0, query: q, status: 'scanning' };
  State.selected.clear();
  onRenderGrid();
  updateSearchBanner();

  // Fast path via FTS5 — if it returns true we're done.
  if (await tryFtsSearch(q, qLower)) return;

  // Slow path: NDJSON stream over the bucket.
  let rerenderTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRerender = (): void => {
    if (rerenderTimer) return;
    rerenderTimer = setTimeout(() => {
      rerenderTimer = null;
      onRenderGrid();
      updateSearchBanner();
    }, 120);
  };

  try {
    const params = new URLSearchParams({ q });
    const res = await fetch(`/api/search-stream/${encodeURIComponent(State.activeBucket)}?${params}`, {
      headers: authHeaders(),
      signal: searchAbort.signal,
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
            const cur = State.searchFolderHits!.get(cat.key) || {
              fileCount: 0, totalSize: 0, latestModified: null,
            };
            cur.fileCount++;
            cur.totalSize += (ev.size as number | undefined) ?? 0;
            const modified = ev.modified as string | undefined;
            if (modified && (!cur.latestModified || new Date(modified) > new Date(cur.latestModified))) {
              cur.latestModified = modified;
            }
            State.searchFolderHits!.set(cat.key, cur);
          } else {
            State.searchResults!.push({
              Key: key,
              Size: (ev.size as number | undefined) ?? 0,
              LastModified: ev.modified as string | undefined,
              ETag: ev.etag as string | undefined,
            } as S3Object);
          }
          State.searchMeta!.hits++;
          scheduleRerender();
        } else if (ev.t === 'progress') {
          State.searchMeta!.scanned = (ev.scanned as number) ?? 0;
          scheduleRerender();
        } else if (ev.t === 'done') {
          State.searchMeta!.status = 'done';
          State.searchMeta!.reason = ev.reason as string | undefined;
          State.searchMeta!.scanned = (ev.scanned as number) ?? 0;
          onRenderGrid();
          updateSearchBanner();
        } else if (ev.t === 'error') {
          State.searchMeta!.status = 'error';
          State.searchMeta!.error = ev.message as string | undefined;
          updateSearchBanner();
        }
      }
    }
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') {
      if (State.searchMeta) State.searchMeta.status = 'cancelled';
      updateSearchBanner();
      onRenderGrid();
      return;
    }
    if (State.searchMeta) {
      State.searchMeta.status = 'error';
      State.searchMeta.error = err.message;
    }
    updateSearchBanner();
  }
}

export function runRecursiveSearchForLink(): Promise<void> {
  return runRecursiveSearch();
}

export function updateSearchBanner(): void {
  const banner = $('search-banner');
  if (!State.searchMeta) { banner.style.display = 'none'; return; }
  const { scanned, query, status, reason, error } = State.searchMeta;
  const folderCount = State.searchFolderHits?.size || 0;
  const fileCount = State.searchResults?.length || 0;

  let statusLabel = '';
  if (status === 'scanning') {
    statusLabel = '<span style="color:var(--primary-2)">⏳ escaneando...</span>';
  } else if (status === 'done') {
    if (reason === 'limit') statusLabel = '<span class="truncated">⚠ tope de resultados (refina la búsqueda)</span>';
    else if (reason === 'fts') statusLabel = '<span style="color:var(--green)">⚡ índice FTS5</span>';
    else statusLabel = '<span style="color:var(--green)">✓ completo</span>';
  } else if (status === 'cancelled') {
    statusLabel = '<span class="truncated">⛔ cancelado</span>';
  } else if (status === 'error') {
    statusLabel = `<span style="color:var(--red)">error: ${escapeHtml(error || '')}</span>`;
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
      ${status === 'scanning' ? '<button class="btn" id="btn-cancel-search">Cancelar</button>' : ''}
      <button class="btn" id="btn-exit-search">Salir</button>
    </span>
  `;
  ($('btn-exit-search') as HTMLButtonElement).onclick = (): void => clearSearch();
  const cancelBtn = document.getElementById('btn-cancel-search') as HTMLButtonElement | null;
  if (cancelBtn) cancelBtn.onclick = (): void => { if (searchAbort) searchAbort.abort(); };
}

export function initSearch(): void {
  const searchInput = $('search-input') as HTMLInputElement;
  const searchClearBtn = $('btn-search-clear');

  searchInput.addEventListener('input', (e: Event) => {
    State.filterTerm = (e.target as HTMLInputElement).value;
    searchClearBtn.style.display = State.filterTerm ? 'block' : 'none';
    if (State.searchResults !== null) {
      State.searchResults = null;
      State.searchMeta = null;
      updateSearchBanner();
    }
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => onRenderGrid(), 80);
  });

  searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (State.filterTerm.trim()) void runRecursiveSearch();
    } else if (e.key === 'Escape') {
      clearSearch();
    }
  });

  searchClearBtn.onclick = (): void => clearSearch();

  // Sort headers + deleted toggle live here too — same DOM region.
  document.querySelectorAll<HTMLElement>('.grid th.sortable').forEach((th) => {
    th.onclick = (): void => {
      const field = th.dataset.sort as 'name' | 'size' | 'modified';
      if (State.sort.field === field) {
        State.sort.dir = State.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        State.sort = { field, dir: 'asc' };
      }
      onRenderGrid();
    };
  });

  ($('chk-deleted') as HTMLInputElement).addEventListener('change', (e: Event) => {
    State.showDeleted = (e.target as HTMLInputElement).checked;
    void onLoadObjects();
  });
}
