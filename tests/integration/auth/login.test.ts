import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { buildTestApp } from '../../fixtures/app';
import { createTestUser, loginAs, withTotp } from '../../fixtures/users';
import { advanceSeconds } from '../../helpers/time';

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

describe('POST /auth/login (step 1: password)', () => {
  it('returns step=totp and sets s3x_pending cookie on valid credentials', async () => {
    const user = createTestUser({
      username: 'login-happy',
      password: 'good-password-1!',
      totpEnrolled: true,
    });

    const res = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: user.password });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ step: 'totp' });
    expect(setCookie(res, 's3x_pending')).toBeTruthy();
    expect(setCookie(res, 's3x_session')).toBeNull();
  });

  it('rejects bad password with 401 and generic message', async () => {
    createTestUser({
      username: 'login-bad-pass',
      password: 'good-password-1!',
      totpEnrolled: true,
    });

    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'login-bad-pass', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Credenciales inválidas');
  });

  it('returns same 401 for unknown user (CD-SEC-002 constant-time)', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'nobody-here', password: 'whatever-12345' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Credenciales inválidas');
  });

  it('rejects disabled user even with correct password', async () => {
    createTestUser({
      username: 'login-disabled',
      password: 'good-password-1!',
      disabled: true,
      totpEnrolled: true,
    });

    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'login-disabled', password: 'good-password-1!' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Credenciales inválidas');
  });

  it('rejects missing fields with 400 (zod validation)', async () => {
    const res = await request(app).post('/auth/login').send({ username: 'x' });
    expect(res.status).toBe(400);
  });

  it('returns step=enroll_totp and issues session immediately when TOTP not enrolled', async () => {
    createTestUser({
      username: 'login-no-totp',
      password: 'good-password-1!',
      totpEnrolled: false,
    });

    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'login-no-totp', password: 'good-password-1!' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ step: 'enroll_totp' });
    expect(setCookie(res, 's3x_session')).toBeTruthy();
    expect(setCookie(res, 's3x_pending')).toBeNull();
  });
});

describe('POST /auth/totp (step 2)', () => {
  it('issues session cookie on valid TOTP and clears pending cookie', async () => {
    const user = createTestUser({
      username: 'totp-happy',
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
      .send({ code: withTotp(user) });

    expect(step2.status).toBe(200);
    expect(step2.body).toEqual({ ok: true });
    expect(setCookie(step2, 's3x_session')).toBeTruthy();
    const cleared = (step2.headers['set-cookie'] as unknown as string[]).find((h) =>
      h.startsWith('s3x_pending=')
    );
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('blocks replay of an already-used TOTP code within its window', async () => {
    const user = createTestUser({
      username: 'totp-replay',
      password: 'good-password-1!',
      totpEnrolled: true,
    });
    const code = withTotp(user); // single code reused for both attempts

    // First login with the code succeeds.
    const p1 = setCookie(
      await request(app).post('/auth/login').send({ username: user.username, password: user.password }),
      's3x_pending',
    )!;
    const first = await request(app).post('/auth/totp').set('Cookie', p1).send({ code });
    expect(first.status).toBe(200);

    // Second login (fresh pending cookie) replays the SAME code → rejected,
    // because its timestep was already consumed.
    const p2 = setCookie(
      await request(app).post('/auth/login').send({ username: user.username, password: user.password }),
      's3x_pending',
    )!;
    const replay = await request(app).post('/auth/totp').set('Cookie', p2).send({ code });
    expect(replay.status).toBe(401);
    expect(replay.body.message).toBe('Código inválido');
    expect(setCookie(replay, 's3x_session')).toBeNull();
  });

  it('rejects wrong TOTP code', async () => {
    const user = createTestUser({
      username: 'totp-bad',
      password: 'good-password-1!',
      totpEnrolled: true,
    });

    const step1 = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: user.password });
    const pending = setCookie(step1, 's3x_pending')!;

    const res = await request(app)
      .post('/auth/totp')
      .set('Cookie', pending)
      .send({ code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Código inválido');
    expect(setCookie(res, 's3x_session')).toBeNull();
  });

  it('rejects TOTP submission without a pending cookie', async () => {
    const user = createTestUser({
      username: 'totp-no-pending',
      password: 'good-password-1!',
      totpEnrolled: true,
    });

    const res = await request(app).post('/auth/totp').send({ code: withTotp(user) });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/expirada/i);
  });

  it('pending cookie expires after 120s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = createTestUser({
        username: 'totp-expired',
        password: 'good-password-1!',
        totpEnrolled: true,
      });

      const step1 = await request(app)
        .post('/auth/login')
        .send({ username: user.username, password: user.password });
      const pending = setCookie(step1, 's3x_pending')!;

      await advanceSeconds(121);

      const res = await request(app)
        .post('/auth/totp')
        .set('Cookie', pending)
        .send({ code: withTotp(user) });

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/expirada/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts recovery code in xxxxx-xxxxx format and burns it', async () => {
    // Recovery codes only get hashed/persisted via the confirm flow. Easiest:
    // exercise the enrollment path end-to-end so the user ends up with real
    // recovery codes wired through the normal store.
    createTestUser({
      username: 'recovery-user',
      password: 'good-password-1!',
      totpEnrolled: false,
    });
    const step1 = await request(app)
      .post('/auth/login')
      .send({ username: 'recovery-user', password: 'good-password-1!' });
    const session = setCookie(step1, 's3x_session')!;

    const setup = await request(app).post('/auth/totp/setup').set('Cookie', session);
    expect(setup.status).toBe(200);
    const secret = setup.body.secret as string;
    const confirm = await request(app)
      .post('/auth/totp/confirm')
      .set('Cookie', session)
      .send({ code: authenticator.generate(secret) });
    expect(confirm.status).toBe(200);
    const codes = confirm.body.recoveryCodes as string[];
    expect(codes).toHaveLength(8);

    // New login → use recovery code instead of TOTP digits
    const relogin = await request(app)
      .post('/auth/login')
      .send({ username: 'recovery-user', password: 'good-password-1!' });
    const pending = setCookie(relogin, 's3x_pending')!;

    const res = await request(app)
      .post('/auth/totp')
      .set('Cookie', pending)
      .send({ code: codes[0] });

    expect(res.status).toBe(200);
    expect(setCookie(res, 's3x_session')).toBeTruthy();

    // Same recovery code should NOT work twice
    const relogin2 = await request(app)
      .post('/auth/login')
      .send({ username: 'recovery-user', password: 'good-password-1!' });
    const pending2 = setCookie(relogin2, 's3x_pending')!;
    const reused = await request(app)
      .post('/auth/totp')
      .set('Cookie', pending2)
      .send({ code: codes[0] });
    expect(reused.status).toBe(401);
  });
});

describe('GET /auth/me + logout', () => {
  it('returns authenticated payload when session is valid', async () => {
    const user = createTestUser({
      username: 'me-user',
      password: 'good-password-1!',
      role: 'user',
      totpEnrolled: true,
    });
    const cookie = await loginAs(app, user);

    const res = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      authenticated: true,
      username: 'me-user',
      role: 'user',
      totpEnrolled: true,
      mustChangePassword: false,
    });
  });

  it('returns authenticated: false without a cookie', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });

  it('returns authenticated: false for a tampered cookie', async () => {
    const res = await request(app)
      .get('/auth/me')
      .set('Cookie', 's3x_session=garbage.signature');
    expect(res.body).toEqual({ authenticated: false });
  });

  it('logout revokes the jti so the cookie no longer authenticates', async () => {
    const user = createTestUser({
      username: 'logout-user',
      password: 'good-password-1!',
      totpEnrolled: true,
    });
    const cookie = await loginAs(app, user);

    const out = await request(app).post('/auth/logout').set('Cookie', cookie);
    expect(out.status).toBe(200);

    const me = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(me.body).toEqual({ authenticated: false });
  });
});

describe('Password rehash on legacy bcrypt login', () => {
  // CD-SEC-008: legacy bcrypt hashes must be silently upgraded to argon2id
  // on the next successful login. We don't have a "create bcrypt user"
  // helper, so write one inline using the dependency directly.
  it('upgrades stored hash from bcrypt to argon2id', async () => {
    const bcrypt = await import('bcryptjs');
    const { createUser, findUser } = await import('../../../src/auth/users-store');
    const username = 'legacy-bcrypt-user';
    const password = 'good-password-1!';
    const bcryptHash = bcrypt.hashSync(password, 10);
    createUser({
      username,
      passwordHash: bcryptHash,
      totpSecret: null,
      totpConfirmed: false,
      recoveryCodesHashed: [],
      role: 'user',
      disabled: false,
      mustChangePassword: false,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      lastTotpStep: 0,
    });
    expect(findUser(username)!.passwordHash.startsWith('$2')).toBe(true);

    const res = await request(app).post('/auth/login').send({ username, password });
    expect(res.status).toBe(200);

    const after = findUser(username)!;
    expect(after.passwordHash.startsWith('$argon2id$')).toBe(true);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// Keep beforeEach declared so vitest type-check sees `expect`. No-op otherwise.
beforeEach(() => {});
