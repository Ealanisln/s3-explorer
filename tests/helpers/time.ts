import { vi } from 'vitest';

// Travel forward in time and run pending timers. Use for testing pending-token
// expiry (120s), session TTL, and rate-limit windows. Caller must
// `vi.useFakeTimers()` first and `vi.useRealTimers()` in afterEach.
export async function advanceSeconds(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}
