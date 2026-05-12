// Reindex button + status badge for the bucket-index feature (MR 8 backend).
//
// Triggers POST /api/index/:bucket/rebuild and polls /status until done.
// The search module (objects/search.ts) reads the same /status endpoint when
// the user hits Enter, choosing FTS5 vs the legacy /search-stream automatically.

import { State } from '../state.js';
import { api } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { $ } from '../util/dom.js';

interface IndexStatus {
  last_indexed_at: string | null;
  object_count: number;
  last_error: string | null;
  stale: boolean;
}

function badgeText(status: IndexStatus): string {
  if (!status.last_indexed_at) return '';
  const age = Date.now() - new Date(status.last_indexed_at).getTime();
  const min = Math.floor(age / 60000);
  if (min < 1) return `⚡ índice ${status.object_count.toLocaleString()} obj (hace segundos)`;
  if (min < 60) return `⚡ índice ${status.object_count.toLocaleString()} obj (hace ${min} min)`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `⚡ índice ${status.object_count.toLocaleString()} obj (hace ${hr} h)`;
  const days = Math.floor(hr / 24);
  return `⚠ índice ${status.object_count.toLocaleString()} obj (hace ${days} d, stale)`;
}

async function refreshBadge(): Promise<void> {
  if (!State.activeBucket) return;
  const badge = document.getElementById('index-status-badge');
  if (!badge) return;
  try {
    const status = await api<IndexStatus>(`/api/index/${encodeURIComponent(State.activeBucket)}/status`);
    badge.textContent = badgeText(status);
    badge.style.display = status.last_indexed_at ? 'inline' : 'none';
    badge.classList.toggle('stale', status.stale);
  } catch {
    badge.style.display = 'none';
  }
}

async function reindexBucket(): Promise<void> {
  if (!State.activeBucket) return;
  const btn = $('btn-reindex') as HTMLButtonElement;
  const original = btn.textContent || '';
  btn.disabled = true;
  btn.textContent = '⏳ Indexando...';
  try {
    const { count, durationMs } = await api<{ count: number; durationMs: number }>(
      `/api/index/${encodeURIComponent(State.activeBucket)}/rebuild`,
      { method: 'POST' },
    );
    toast(`Índice listo: ${count.toLocaleString()} objetos en ${Math.round(durationMs / 1000)}s`, 'success', 5000);
    await refreshBadge();
  } catch (e) {
    toast('Error al reindexar: ' + (e as Error).message, 'error', errorIdOpts(e));
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

export function initReindex(): void {
  const btn = $('btn-reindex') as HTMLButtonElement;
  btn.onclick = (): void => { void reindexBucket(); };
}

// Called from main.ts when a bucket is opened (passed to buckets/list.ts deps).
export function onBucketOpened(): void {
  void refreshBadge();
}
