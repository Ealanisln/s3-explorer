import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAttempts, rateLimit, recordFailure } from '../../../src/auth/rate-limit';

describe('rate-limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to `max` failed attempts in the window, then blocks', () => {
    const key = 'login:1.1.1.1:alice';
    for (let i = 0; i < 5; i++) {
      expect(rateLimit(key)).toBe(true);
      recordFailure(key);
    }
    // 6th attempt is over the limit
    expect(rateLimit(key)).toBe(false);
  });

  it('uses 5 attempts / 15 min as the default window', () => {
    const key = 'login:1.1.1.1:bob';
    for (let i = 0; i < 5; i++) {
      rateLimit(key);
      recordFailure(key);
    }
    expect(rateLimit(key)).toBe(false);

    // 14:59 later — still blocked.
    vi.advanceTimersByTime(14 * 60 * 1000 + 59 * 1000);
    expect(rateLimit(key)).toBe(false);

    // 15:01 → bucket has expired, next call re-initializes and allows again.
    vi.advanceTimersByTime(2 * 1000);
    expect(rateLimit(key)).toBe(true);
  });

  it('respects custom max + window arguments', () => {
    const key = 'custom:carol';
    expect(rateLimit(key, 2, 60)).toBe(true);
    recordFailure(key);
    expect(rateLimit(key, 2, 60)).toBe(true);
    recordFailure(key);
    expect(rateLimit(key, 2, 60)).toBe(false);
  });

  it('isolates buckets per key (different users do not pollute each other)', () => {
    const ka = 'login:ip-a:alice';
    const kb = 'login:ip-a:bob';
    for (let i = 0; i < 5; i++) {
      rateLimit(ka);
      recordFailure(ka);
    }
    expect(rateLimit(ka)).toBe(false);
    expect(rateLimit(kb)).toBe(true); // bob still clean
  });

  it('clearAttempts() wipes the bucket so the next attempt is fresh', () => {
    const key = 'login:1.1.1.1:carol';
    for (let i = 0; i < 5; i++) {
      rateLimit(key);
      recordFailure(key);
    }
    expect(rateLimit(key)).toBe(false);

    clearAttempts(key);
    expect(rateLimit(key)).toBe(true);
    // And we can record failures again without immediately tripping.
    recordFailure(key);
    expect(rateLimit(key)).toBe(true);
  });

  it('recordFailure on an unknown key is a no-op', () => {
    expect(() => recordFailure('never-seen')).not.toThrow();
  });

  it('clearAttempts on an unknown key is a no-op', () => {
    expect(() => clearAttempts('never-seen')).not.toThrow();
  });
});
