// In-memory rate limit. Lost on process restart by design — for a panel
// internal serving small teams this is acceptable. If we ever need shared
// state across replicas, move this into the SQLite store.

interface Attempt {
  count: number;
  until: number;
}

const attempts = new Map<string, Attempt>();

export function rateLimit(key: string, max = 5, windowSec = 900): boolean {
  const now = Math.floor(Date.now() / 1000);
  const rec = attempts.get(key);
  if (rec && rec.until > now) {
    if (rec.count >= max) return false;
  } else {
    attempts.set(key, { count: 0, until: now + windowSec });
  }
  return true;
}

export function recordFailure(key: string): void {
  const rec = attempts.get(key);
  if (rec) rec.count++;
}

export function clearAttempts(key: string): void {
  attempts.delete(key);
}
