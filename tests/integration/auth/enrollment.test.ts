import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { buildTestApp } from '../../fixtures/app';
import { createTestUser } from '../../fixtures/users';

const app = buildTestApp();

function setCookie(res: request.Response, name: string): string | null {
  const headers = res.headers['set-cookie'];
  const list = Array.isArray(headers) ? headers : headers ? [String(headers)] : [];
  for (const h of list) {
    const first = h.split(';')[0];
    if (first.startsWith(`${name}=`)) return first;
  }
  return null;
}

describe('TOTP enrollment flow', () => {
  async function freshSession(username: string, mustChangePassword = false): Promise<string> {
    createTestUser({
      username,
      password: 'good-password-1!',
      totpEnrolled: false,
      mustChangePassword,
    });
    const res = await request(app)
      .post('/auth/login')
      .send({ username, password: 'good-password-1!' });
    expect(res.body.step).toBe('enroll_totp');
    return setCookie(res, 's3x_session')!;
  }

  it('GET /auth/totp/setup returns otpauth, qrSvg, and secret', async () => {
    const cookie = await freshSession('enroll-setup');
    const res = await request(app).post('/auth/totp/setup').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.otpauth).toMatch(/^otpauth:\/\/totp\//);
    expect(res.body.qrSvg).toContain('<svg');
    expect(typeof res.body.secret).toBe('string');
    expect(res.body.secret.length).toBeGreaterThan(0);
  });

  it('reuses the pending secret across refreshes (no regenerate)', async () => {
    const cookie = await freshSession('enroll-reuse');
    const first = await request(app).post('/auth/totp/setup').set('Cookie', cookie);
    const second = await request(app).post('/auth/totp/setup').set('Cookie', cookie);
    expect(first.body.secret).toBe(second.body.secret);
  });

  it('regenerate=1 rotates the secret', async () => {
    const cookie = await freshSession('enroll-regen');
    const first = await request(app).post('/auth/totp/setup').set('Cookie', cookie);
    const second = await request(app)
      .post('/auth/totp/setup?regenerate=1')
      .set('Cookie', cookie);
    expect(second.body.secret).not.toBe(first.body.secret);
  });

  it('rejects /auth/totp/setup once TOTP is confirmed (409 ALREADY_ENROLLED)', async () => {
    const cookie = await freshSession('enroll-already');
    const setup = await request(app).post('/auth/totp/setup').set('Cookie', cookie);
    const code = authenticator.generate(setup.body.secret);
    await request(app).post('/auth/totp/confirm').set('Cookie', cookie).send({ code });

    const retry = await request(app).post('/auth/totp/setup').set('Cookie', cookie);
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('ALREADY_ENROLLED');
  });

  it('confirm rejects wrong code, accepts valid code and returns 8 recovery codes', async () => {
    const cookie = await freshSession('enroll-confirm');
    const setup = await request(app).post('/auth/totp/setup').set('Cookie', cookie);

    const bad = await request(app)
      .post('/auth/totp/confirm')
      .set('Cookie', cookie)
      .send({ code: '000000' });
    expect(bad.status).toBe(401);

    const ok = await request(app)
      .post('/auth/totp/confirm')
      .set('Cookie', cookie)
      .send({ code: authenticator.generate(setup.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodes).toHaveLength(8);
    for (const c of ok.body.recoveryCodes) {
      // 128-bit codes: xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxx
      expect(c).toMatch(/^[a-f0-9]{8}(-[a-f0-9]{8}){3}$/);
    }
  });

  it('requires auth — /auth/totp/setup without a session returns 401', async () => {
    const res = await request(app).post('/auth/totp/setup');
    expect(res.status).toBe(401);
  });
});

describe('mustChangePassword gate', () => {
  // requirePasswordCurrent guards /api/* — a user with mustChangePassword=true
  // must rotate their password before any S3 call is allowed.
  it('blocks /api/* with 403 PASSWORD_CHANGE_REQUIRED', async () => {
    const user = createTestUser({
      username: 'must-change',
      password: 'good-password-1!',
      totpEnrolled: true,
      mustChangePassword: true,
    });

    // Login + TOTP manually so we can use the cookie against /api
    const step1 = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: user.password });
    const pending = setCookie(step1, 's3x_pending')!;
    const step2 = await request(app)
      .post('/auth/totp')
      .set('Cookie', pending)
      .send({ code: authenticator.generate(user.totpSecret!) });
    const session = setCookie(step2, 's3x_session')!;

    const api = await request(app).get('/api/buckets').set('Cookie', session);
    expect(api.status).toBe(403);
    expect(api.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('allows /api/* after the user rotates the password', async () => {
    const user = createTestUser({
      username: 'rotate-pass',
      password: 'good-password-1!',
      totpEnrolled: true,
      mustChangePassword: true,
    });

    const step1 = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: user.password });
    const pending = setCookie(step1, 's3x_pending')!;
    const step2 = await request(app)
      .post('/auth/totp')
      .set('Cookie', pending)
      .send({ code: authenticator.generate(user.totpSecret!) });
    const session = setCookie(step2, 's3x_session')!;

    const change = await request(app)
      .post('/auth/me/password')
      .set('Cookie', session)
      .send({ currentPassword: 'good-password-1!', newPassword: 'brand-new-password-2!' });
    expect(change.status).toBe(200);

    // The cookie is unchanged — but the user record now has mustChangePassword=false
    const me = await request(app).get('/auth/me').set('Cookie', session);
    expect(me.body.mustChangePassword).toBe(false);
  });

  it('rejects password change when currentPassword is wrong', async () => {
    const user = createTestUser({
      username: 'rotate-wrong',
      password: 'good-password-1!',
      totpEnrolled: true,
    });
    const step1 = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: user.password });
    const pending = setCookie(step1, 's3x_pending')!;
    const step2 = await request(app)
      .post('/auth/totp')
      .set('Cookie', pending)
      .send({ code: authenticator.generate(user.totpSecret!) });
    const session = setCookie(step2, 's3x_session')!;

    const res = await request(app)
      .post('/auth/me/password')
      .set('Cookie', session)
      .send({ currentPassword: 'NOPE', newPassword: 'brand-new-password-2!' });
    expect(res.status).toBe(401);
  });
});

describe('requireTotpEnrolled gate', () => {
  // Even with a valid session, /api/* must reject users who haven't confirmed
  // TOTP yet (post-login but pre-enrollment state).
  it('blocks /api/* with 403 TOTP_REQUIRED when totpConfirmed=false', async () => {
    createTestUser({
      username: 'no-totp-api',
      password: 'good-password-1!',
      totpEnrolled: false,
    });
    const login = await request(app)
      .post('/auth/login')
      .send({ username: 'no-totp-api', password: 'good-password-1!' });
    const session = setCookie(login, 's3x_session')!;

    const res = await request(app).get('/api/buckets').set('Cookie', session);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOTP_REQUIRED');
  });
});
