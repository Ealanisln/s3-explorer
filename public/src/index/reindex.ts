// Reindex button + status badge for the bucket-index feature (MR 8 backend).
//
// Triggers POST /api/index/:bucket/rebuild and polls /status until done.
// The search module (objects/search.ts) reads the same /status endpoint when
// the user hits Enter, choosing FTS5 vs the legacy /search-stream automatically.
//
// One reindex button + status badge per pane.

import { getPane, setActivePane } from '../state.js';
import type { PaneId } from '../state.js';
import { api } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { paneEl, paneElMaybe } from '../util/dom.js';
import { t } from '../i18n/index.js';

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
  const count = status.object_count.toLocaleString();
  if (min < 1) return t('index.badgeSeconds', { count });
  if (min < 60) return t('index.badgeMin', { count, min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('index.badgeHours', { count, hours: hr });
  const days = Math.floor(hr / 24);
  return t('index.badgeStale', { count, days });
}

async function refreshBadge(paneId: PaneId): Promise<void> {
  const pane = getPane(paneId);
  if (!pane.activeBucket) return;
  const badge = paneElMaybe('index-status-badge', paneId);
  if (!badge) return;
  try {
    const status = await api<IndexStatus>(`/api/index/${encodeURIComponent(pane.activeBucket)}/status`);
    badge.textContent = badgeText(status);
    badge.style.display = status.last_indexed_at ? 'inline' : 'none';
    badge.classList.toggle('stale', status.stale);
  } catch {
    badge.style.display = 'none';
  }
}

async function reindexBucket(paneId: PaneId): Promise<void> {
  const pane = getPane(paneId);
  if (!pane.activeBucket) return;
  const btn = paneEl('btn-reindex', paneId) as HTMLButtonElement;
  const original = btn.textContent || '';
  btn.disabled = true;
  btn.textContent = t('index.indexing');
  try {
    const { count, durationMs } = await api<{ count: number; durationMs: number }>(
      `/api/index/${encodeURIComponent(pane.activeBucket)}/rebuild`,
      { method: 'POST' },
    );
    toast(t('index.ready', { count: count.toLocaleString(), seconds: Math.round(durationMs / 1000) }), 'success', 5000);
    await refreshBadge(paneId);
  } catch (e) {
    toast(t('index.error', { message: (e as Error).message }), 'error', errorIdOpts(e));
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

export function initReindex(paneId: PaneId): void {
  const btn = paneEl('btn-reindex', paneId) as HTMLButtonElement;
  btn.onclick = (): void => {
    setActivePane(paneId);
    void reindexBucket(paneId);
  };
}

export function onBucketOpened(paneId: PaneId): void {
  void refreshBadge(paneId);
}
