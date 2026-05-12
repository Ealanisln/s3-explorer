import type { Response, Request } from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionPayload, PendingPayload, User } from '../types';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const REVOKED_FILE = path.join(DATA_DIR, 'revoked.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_SECONDS = parseInt(process.env.SESSION_TTL_SECONDS || '43200', 10); // 12 h
const SECURE_COOKIE = (process.env.SECURE_COOKIE || '1') === '1';

if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET env var not set — generated ephemeral secret. ' +
    'All sessions will be invalidated on server restart. Set SESSION_SECRET in production.');
}

// CD-SEC-004: persistent revocation list — {jti: expEpoch}
const revokedJtis = new Map<string, number>();

(function loadRevoked() {
  try {
    const raw = JSON.parse(fs.readFileSync(REVOKED_FILE, 'utf8')) as Record<string, number>;
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, exp] of Object.entries(raw)) {
      if (exp > now) revokedJtis.set(jti, exp);
    }
  } catch {
    // file missing or unreadable — start with an empty list
  }
})();

function saveRevoked(): void {
  const now = Math.floor(Date.now() / 1000);
  const obj: Record<string, number> = {};
  for (const [jti, exp] of revokedJtis) {
    if (exp > now) obj[jti] = exp;
  }
  try {
    const tmp = REVOKED_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, REVOKED_FILE);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[auth] Failed to persist revocation list:', msg);
  }
}

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const [jti, exp] of revokedJtis) {
    if (exp <= now) { revokedJtis.delete(jti); changed = true; }
  }
  if (changed) saveRevoked();
}, 60 * 60 * 1000).unref();

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
  if (revokedJtis.has(payload.jti)) return null;
  return payload;
}

function addRevoked(jti: string, exp: number): void {
  revokedJtis.set(jti, exp);
  saveRevoked();
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
