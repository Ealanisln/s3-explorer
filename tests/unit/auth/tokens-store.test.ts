import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import {
  TOKEN_PREFIX,
  TOKEN_REGEX,
  MAX_ACTIVE_TOKENS,
  LAST_USED_THROTTLE_MS,
  generateToken,
  hashToken,
  createToken,
  findTokenByHash,
  findTokenById,
  listTokens,
  revokeToken,
  countActiveTokens,
  isTokenExpired,
  touchLastUsed,
} from '../../../src/auth/tokens-store';

describe('generateToken', () => {
  it('produces s3x_ prefix + 43 base64url chars (32 random bytes)', () => {
    const t = generateToken();
    expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(t).toHaveLength(4 + 43);
    expect(t).toMatch(TOKEN_REGEX);
  });

  it('produces unique tokens', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(seen.size).toBe(100);
  });
});

describe('hashToken', () => {
  it('is the SHA-256 hex of the FULL token, prefix included', () => {
    const t = generateToken();
    const expected = crypto.createHash('sha256').update(t).digest('hex');
    expect(hashToken(t)).toBe(expected);
    expect(hashToken(t)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('createToken / findTokenByHash', () => {
  it('persists only the hash — lookup works by hashing the plaintext', () => {
    const { token, plaintext } = createToken({
      username: 'store-user', name: 'ci-bot', scope: 'read', expiresAt: null,
    });
    expect(token.id).toBeGreaterThan(0);
    expect(token.revokedAt).toBeNull();
    expect(token.lastUsedAt).toBeNull();

    const found = findTokenByHash(hashToken(plaintext));
    expect(found).toBeDefined();
    expect(found!.id).toBe(token.id);
    expect(found!.scope).toBe('read');
    // The plaintext itself is NOT a lookup key — only its hash is stored.
    expect(findTokenByHash(plaintext)).toBeUndefined();
  });

  it('listTokens never exposes hash or plaintext fields', () => {
    createToken({ username: 'list-user', name: 'a', scope: 'write', expiresAt: null });
    const [t] = listTokens('list-user');
    expect(t).toBeDefined();
    expect(Object.keys(t as object)).toEqual(
      expect.arrayContaining(['id', 'name', 'scope', 'createdAt', 'expiresAt', 'lastUsedAt', 'revokedAt']),
    );
    expect(JSON.stringify(t)).not.toMatch(/token_hash|tokenHash/);
  });

  it('findTokenById is scoped to the owner (case-insensitive username)', () => {
    const { token } = createToken({ username: 'Owner-User', name: 'x', scope: 'read', expiresAt: null });
    expect(findTokenById(token.id, 'owner-user')).toBeDefined();
    expect(findTokenById(token.id, 'someone-else')).toBeUndefined();
  });
});

describe('isTokenExpired', () => {
  it('null expiresAt never expires', () => {
    const { token } = createToken({ username: 'exp-user', name: 'never', scope: 'read', expiresAt: null });
    expect(isTokenExpired(token)).toBe(false);
  });

  it('past expiresAt is expired, future is not', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const { token: expired } = createToken({ username: 'exp-user', name: 'old', scope: 'read', expiresAt: past });
    const { token: fresh } = createToken({ username: 'exp-user', name: 'new', scope: 'read', expiresAt: future });
    expect(isTokenExpired(expired)).toBe(true);
    expect(isTokenExpired(fresh)).toBe(false);
  });
});

describe('revokeToken / countActiveTokens', () => {
  it('revocation is a soft flag and idempotent', () => {
    const { token } = createToken({ username: 'rev-user', name: 'r', scope: 'read', expiresAt: null });
    revokeToken(token.id);
    const after = findTokenById(token.id, 'rev-user')!;
    expect(after.revokedAt).not.toBeNull();

    // Second revoke keeps the original timestamp (no UPDATE ran).
    revokeToken(token.id);
    expect(findTokenById(token.id, 'rev-user')!.revokedAt).toBe(after.revokedAt);
  });

  it('counts only non-revoked, non-expired tokens', () => {
    const u = 'count-user';
    createToken({ username: u, name: 'active', scope: 'read', expiresAt: null });
    createToken({
      username: u, name: 'expired', scope: 'read',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const { token: revoked } = createToken({ username: u, name: 'revoked', scope: 'read', expiresAt: null });
    revokeToken(revoked.id);
    expect(countActiveTokens(u)).toBe(1);
    expect(MAX_ACTIVE_TOKENS).toBe(10);
  });
});

describe('touchLastUsed (write throttle)', () => {
  it('sets last_used_at on first use, then throttles within 60s', () => {
    const { token } = createToken({ username: 'touch-user', name: 't', scope: 'read', expiresAt: null });
    const t0 = new Date('2026-08-04T10:00:00.000Z');
    touchLastUsed(token, t0);
    const after1 = findTokenById(token.id, 'touch-user')!;
    expect(after1.lastUsedAt).toBe(t0.toISOString());

    // 30s later — inside the throttle window, no write.
    touchLastUsed(after1, new Date(t0.getTime() + 30_000));
    expect(findTokenById(token.id, 'touch-user')!.lastUsedAt).toBe(t0.toISOString());

    // 61s later — outside the window, bumped.
    const t2 = new Date(t0.getTime() + LAST_USED_THROTTLE_MS + 1000);
    touchLastUsed(after1, t2);
    expect(findTokenById(token.id, 'touch-user')!.lastUsedAt).toBe(t2.toISOString());
  });
});
