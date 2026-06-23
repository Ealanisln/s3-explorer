import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  issuePending,
  issueSession,
  revokeSession,
  verifyPending,
  verifyToken,
} from '../../../src/auth/sessions';
import type { User } from '../../../src/types';

interface CookieCall {
  name: string;
  value: string;
  opts?: Record<string, unknown>;
}

function makeRes() {
  const cookies: CookieCall[] = [];
  const res = {
    cookie(name: string, value: string, opts?: Record<string, unknown>) {
      cookies.push({ name, value, opts });
      return this;
    },
  } as unknown as Response;
  return { res, cookies };
}

function makeReq(sessionCookie?: string): Request {
  return {
    cookies: sessionCookie ? { s3x_session: sessionCookie } : {},
  } as unknown as Request;
}

const baseUser: User = {
  username: 'alice',
  passwordHash: '$argon2id$irrelevant',
  totpSecret: null,
  totpConfirmed: true,
  recoveryCodesHashed: [],
  role: 'user',
  disabled: false,
  mustChangePassword: false,
  createdAt: new Date().toISOString(),
  lastLoginAt: null,
  lastTotpStep: 0,
};

describe('sessions', () => {
  describe('issueSession + verifyToken', () => {
    it('sets an HttpOnly, SameSite=strict cookie with a signed token', () => {
      const { res, cookies } = makeRes();
      const jti = issueSession(res, baseUser);
      expect(jti).toMatch(/^[a-f0-9]{32}$/);
      expect(cookies).toHaveLength(1);
      const c = cookies[0];
      expect(c.name).toBe('s3x_session');
      expect(c.opts?.httpOnly).toBe(true);
      expect(c.opts?.sameSite).toBe('strict');
      // Token format: <body>.<sig>
      expect(c.value.split('.')).toHaveLength(2);
    });

    it('verifies a freshly issued token and returns its payload', () => {
      const { res, cookies } = makeRes();
      const jti = issueSession(res, baseUser);
      const payload = verifyToken(cookies[0].value);
      expect(payload).not.toBeNull();
      expect(payload?.uid).toBe('alice');
      expect(payload?.role).toBe('user');
      expect(payload?.jti).toBe(jti);
      expect(payload?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('rejects tokens with a tampered payload', () => {
      const { res, cookies } = makeRes();
      issueSession(res, baseUser);
      const [body, sig] = cookies[0].value.split('.');
      // Decode body, swap username, re-encode — signature is now invalid.
      const decoded = JSON.parse(
        Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
      );
      decoded.uid = 'attacker';
      const tamperedBody = Buffer.from(JSON.stringify(decoded))
        .toString('base64')
        .replace(/=+$/, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      expect(verifyToken(`${tamperedBody}.${sig}`)).toBeNull();
    });

    it('rejects tokens with a tampered signature', () => {
      const { res, cookies } = makeRes();
      issueSession(res, baseUser);
      const [body] = cookies[0].value.split('.');
      const badSig = Buffer.alloc(32, 0).toString('base64')
        .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
      expect(verifyToken(`${body}.${badSig}`)).toBeNull();
    });

    it('rejects malformed tokens', () => {
      expect(verifyToken(undefined)).toBeNull();
      expect(verifyToken('')).toBeNull();
      expect(verifyToken('no-dot')).toBeNull();
      expect(verifyToken('.')).toBeNull();
      expect(verifyToken('a.b')).toBeNull(); // valid shape, bad signature
    });

    it('rejects expired tokens', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-05-13T00:00:00Z'));
        const { res, cookies } = makeRes();
        issueSession(res, baseUser);
        // SESSION_TTL_SECONDS defaults to 12h. Jump 13h forward.
        vi.setSystemTime(new Date('2026-05-13T13:00:00Z'));
        expect(verifyToken(cookies[0].value)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('revokeSession', () => {
    it('invalidates a previously valid session token', () => {
      const { res, cookies } = makeRes();
      issueSession(res, baseUser);
      const token = cookies[0].value;
      expect(verifyToken(token)).not.toBeNull();
      revokeSession(makeReq(token));
      expect(verifyToken(token)).toBeNull();
    });

    it('is a no-op for missing or invalid tokens', () => {
      expect(() => revokeSession(makeReq())).not.toThrow();
      expect(() => revokeSession(makeReq('garbage'))).not.toThrow();
    });
  });

  describe('issuePending + verifyPending', () => {
    let timersUsed = false;
    beforeEach(() => { timersUsed = false; });
    afterEach(() => { if (timersUsed) vi.useRealTimers(); });

    it('sets a short-lived s3x_pending cookie', () => {
      const { res, cookies } = makeRes();
      issuePending(res, 'alice');
      expect(cookies).toHaveLength(1);
      expect(cookies[0].name).toBe('s3x_pending');
      expect(cookies[0].opts?.maxAge).toBe(120 * 1000);
    });

    it('verifies a pending token with the correct username', () => {
      const { res, cookies } = makeRes();
      issuePending(res, 'alice');
      const payload = verifyPending(cookies[0].value);
      expect(payload).not.toBeNull();
      expect(payload?.uid).toBe('alice');
      expect(payload?.p).toBe(1);
    });

    it('rejects pending tokens after the 120s TTL', () => {
      timersUsed = true;
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-13T00:00:00Z'));
      const { res, cookies } = makeRes();
      issuePending(res, 'alice');
      vi.setSystemTime(new Date('2026-05-13T00:02:01Z')); // 121s later
      expect(verifyPending(cookies[0].value)).toBeNull();
    });

    it('verifyPending refuses a session token (p flag mismatch)', () => {
      const { res, cookies } = makeRes();
      issueSession(res, baseUser);
      // A full session token has no `p:1` field — should be rejected as pending.
      expect(verifyPending(cookies[0].value)).toBeNull();
    });
  });
});
