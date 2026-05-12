import type { Response, Request } from 'express';
import * as crypto from 'crypto';
import { db, ensureDbInit } from '../db';
import type { SessionPayload, PendingPayload, User } from '../types';

// Same guarantee as users-store.ts: DB tables exist before we prepare statements.
ensureDbInit();

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_SECONDS = parseInt(process.env.SESSION_TTL_SECONDS || '43200', 10); // 12 h
const SECURE_COOKIE = (process.env.SECURE_COOKIE || '1') === '1';

if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET env var not set — generated ephemeral secret. ' +
    'All sessions will be invalidated on server restart. Set SESSION_SECRET in production.');
}

// CD-SEC-004: revocation list moved into SQLite. The old file-backed Map
// (revoked.json + in-memory hydration + tmp+rename writes + setInterval
// cleanup) is replaced by a single table with two prepared statements and a
// boot-time DELETE for expired rows.
const stmtIsRevoked = db.prepare<[string]>('SELECT 1 FROM revoked_sessions WHERE jti = ?');
const stmtAddRevoked = db.prepare<[string, number]>(
  'INSERT OR REPLACE INTO revoked_sessions (jti, exp_epoch) VALUES (?, ?)'
);
const stmtPurgeExpired = db.prepare<[number]>(
  'DELETE FROM revoked_sessions WHERE exp_epoch <= ?'
);

// Purge expired entries on boot, and periodically thereafter.
function purgeExpired(): void {
  const now = Math.floor(Date.now() / 1000);
  stmtPurgeExpired.run(now);
}
purgeExpired();
setInterval(purgeExpired, 60 * 60 * 1000).unref();

function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Buffer {
  let normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  return Buffer.from(normalized, 'base64');
}

function sign(payload: SessionPayload | PendingPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(token: string | undefined): SessionPayload | null {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload: SessionPayload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')) as SessionPayload; }
  catch { return null; }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (stmtIsRevoked.get(payload.jti)) return null;
  return payload;
}

function addRevoked(jti: string, exp: number): void {
  stmtAddRevoked.run(jti, exp);
}

export function issueSession(res: Response, user: User): string {
  const jti = crypto.randomBytes(16).toString('hex');
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = sign({ uid: user.username, role: user.role, jti, exp });
  res.cookie('s3x_session', token, {
    httpOnly: true,
    secure: SECURE_COOKIE,
    sameSite: 'strict',
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
  return jti;
}

export function revokeSession(req: Request): void {
  const token = req.cookies && req.cookies.s3x_session;
  const payload = token && verifyToken(token);
  if (payload) addRevoked(payload.jti, payload.exp);
}

// ----- Pending step-2 (TOTP) state -----
// After password OK, we need a short-lived token saying "you may submit a TOTP code".
const PENDING_TTL = 120; // seconds

export function issuePending(res: Response, username: string): void {
  const token = sign({ p: 1, uid: username, exp: Math.floor(Date.now() / 1000) + PENDING_TTL });
  res.cookie('s3x_pending', token, {
    httpOnly: true,
    secure: SECURE_COOKIE,
    sameSite: 'strict',
    maxAge: PENDING_TTL * 1000,
    path: '/',
  });
}

export function verifyPending(token: string | undefined): PendingPayload | null {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload: PendingPayload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')) as PendingPayload; }
  catch { return null; }
  if (payload.p !== 1) return null;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
