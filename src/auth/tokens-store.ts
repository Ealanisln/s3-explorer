// Personal Access Token store (SQLite). Mirrors the users-store pattern:
// prepared statements compiled once, sync better-sqlite3 calls, camelCase
// mapping at the row boundary.
//
// Token format: `s3x_` + 43 chars base64url of 32 random bytes. Only the
// SHA-256 hex of the FULL token (prefix included) is persisted; lookup is an
// exact indexed match on that hash, so no constant-time compare is needed.
import * as crypto from 'crypto';
import { db, ensureDbInit } from '../db';
import type { ApiToken, TokenScope } from '../types';

// Same guarantee as users-store.ts: tables exist before statements compile.
ensureDbInit();

export const TOKEN_PREFIX = 's3x_';
// 32 random bytes → 43 base64url chars (no padding).
export const TOKEN_REGEX = /^s3x_[A-Za-z0-9_-]{43}$/;

// Max ACTIVE (not revoked, not expired) tokens per user.
export const MAX_ACTIVE_TOKENS = 10;

// Only bump last_used_at when the stored value is older than this — avoids a
// SQLite write on every single API request from a busy agent.
export const LAST_USED_THROTTLE_MS = 60_000;

interface TokenRow {
  id: number;
  username: string;
  name: string;
  token_hash: string;
  scope: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

function rowToToken(row: TokenRow): ApiToken {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    scope: (row.scope === 'write' ? 'write' : 'read') as TokenScope,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

const stmtInsert = db.prepare(`
  INSERT INTO api_tokens (username, name, token_hash, scope, created_at, expires_at)
  VALUES (@username, @name, @tokenHash, @scope, @createdAt, @expiresAt)
`);
const stmtFindByHash = db.prepare<[string]>('SELECT * FROM api_tokens WHERE token_hash = ?');
const stmtListByUser = db.prepare<[string]>(
  'SELECT * FROM api_tokens WHERE LOWER(username) = LOWER(?) ORDER BY id DESC'
);
const stmtFindById = db.prepare<[number, string]>(
  'SELECT * FROM api_tokens WHERE id = ? AND LOWER(username) = LOWER(?)'
);
const stmtRevoke = db.prepare<[string, number]>(
  'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'
);
const stmtCountActive = db.prepare<[string, string]>(`
  SELECT COUNT(*) AS c FROM api_tokens
  WHERE LOWER(username) = LOWER(?)
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > ?)
`);
const stmtTouch = db.prepare<[string, number]>(
  'UPDATE api_tokens SET last_used_at = ? WHERE id = ?'
);

// Generate a fresh plaintext token. Shown to the user exactly once.
export function generateToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface CreateTokenInput {
  username: string;
  name: string;
  scope: TokenScope;
  expiresAt: string | null; // ISO 8601, null = never
}

// Mint a token: returns the record plus the plaintext (caller returns it once
// and forgets it). The plaintext never touches the DB.
export function createToken(input: CreateTokenInput): { token: ApiToken; plaintext: string } {
  const plaintext = generateToken();
  const createdAt = new Date().toISOString();
  const info = stmtInsert.run({
    username: input.username,
    name: input.name,
    tokenHash: hashToken(plaintext),
    scope: input.scope,
    createdAt,
    expiresAt: input.expiresAt,
  });
  const token: ApiToken = {
    id: Number(info.lastInsertRowid),
    username: input.username,
    name: input.name,
    scope: input.scope,
    createdAt,
    expiresAt: input.expiresAt,
    lastUsedAt: null,
    revokedAt: null,
  };
  return { token, plaintext };
}

export function findTokenByHash(tokenHash: string): ApiToken | undefined {
  const row = stmtFindByHash.get(tokenHash) as TokenRow | undefined;
  return row ? rowToToken(row) : undefined;
}

export function listTokens(username: string): ApiToken[] {
  const rows = stmtListByUser.all(username) as TokenRow[];
  return rows.map(rowToToken);
}

export function findTokenById(id: number, username: string): ApiToken | undefined {
  const row = stmtFindById.get(id, username) as TokenRow | undefined;
  return row ? rowToToken(row) : undefined;
}

// Soft-revoke. Idempotent: revoking an already-revoked token changes nothing.
export function revokeToken(id: number): void {
  stmtRevoke.run(new Date().toISOString(), id);
}

export function countActiveTokens(username: string): number {
  const row = stmtCountActive.get(username, new Date().toISOString()) as { c: number };
  return row.c;
}

export function isTokenExpired(token: ApiToken, now = new Date()): boolean {
  return token.expiresAt !== null && new Date(token.expiresAt).getTime() <= now.getTime();
}

// Throttled last_used_at bump — see LAST_USED_THROTTLE_MS.
export function touchLastUsed(token: ApiToken, now = new Date()): void {
  const last = token.lastUsedAt ? new Date(token.lastUsedAt).getTime() : 0;
  if (now.getTime() - last < LAST_USED_THROTTLE_MS) return;
  stmtTouch.run(now.toISOString(), token.id);
}
