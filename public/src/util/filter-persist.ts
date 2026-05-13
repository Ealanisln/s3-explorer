// Persist the in-folder search filter (substring filter, NOT the recursive
// search) across navigation, page reloads, and pane-active switches.
//
// Scope: sessionStorage — closing the tab clears it, which matches the
// user's mental model of "navigation state".
//
// Key shape: `s3x-filter:<connId>:<bucket>:<prefix>`.
//   - prefix '' means bucket root.
//   - When the term is empty we DELETE the entry to keep storage tidy.

const PREFIX = 's3x-filter:';

function buildKey(connId: string, bucket: string, prefix: string): string {
  return `${PREFIX}${connId}:${bucket}:${prefix}`;
}

export function saveFilter(connId: string, bucket: string, prefix: string, term: string): void {
  try {
    const k = buildKey(connId, bucket, prefix);
    if (term) sessionStorage.setItem(k, term);
    else sessionStorage.removeItem(k);
  } catch { /* quota / private mode — best-effort */ }
}

export function loadFilter(connId: string, bucket: string, prefix: string): string {
  try {
    return sessionStorage.getItem(buildKey(connId, bucket, prefix)) || '';
  } catch { return ''; }
}

export function clearAllFilters(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    keys.forEach((k) => sessionStorage.removeItem(k));
  } catch { /* ignore */ }
}
