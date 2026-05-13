import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildTestApp } from '../../fixtures/app';
import { createTestUser, withTotp } from '../../fixtures/users';

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

describe('rate-limit at /auth/login', () => {
  it('returns 429 after 5 failed password attempts in the 15min window', async () => {
    createTestUser({
      username: 'rl-login',
      password: 'good-password-1!',
      totpEnrolled: true,
    });

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/auth/login')
        .send({ username: 'rl-login', password: 'wrong-' + i });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app)
      .post('/auth/login')
      .send({ username: 'rl-login', password: 'wrong-final' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(/15 minutos/);
  });

  it('correct password is still blocked once limit is reached', async () => {
    createTestUser({
      username: 'rl-then-correct',
      password: 'good-password-1!',
      totpEnrolled: true,
    });

    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/auth/login')
        .send({ username: 'rl-then-correct', password: 'wrong' });
    }

    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'rl-then-correct', password: 'good-password-1!' });
    expect(res.status).toBe(429);
  });

  it('limit is scoped per username — other accounts still work', async () => {
    createTestUser({
      username: 'rl-victim',
      password: 'good-password-1!',
      totpEnrolled: true,
    });
    createTestUser({
      username: 'rl-bystander',
      password: 'good-password-1!',
      totpEnrolled: true,
    });

    for (let i = 0; i < 6; i++) {
      await request(app)
        .post('/auth/login')
        .send({ username: 'rl-victim', password: 'wrong' });
    }

    const bystander = await request(app)
      .post('/auth/login')
      .send({ username: 'rl-bystander', password: 'good-password-1!' });
    expect(bystander.status).toBe(200);
    expect(bystander.body.step).toBe('totp');
  });

  // Behavior note: routes.ts only calls clearAttempts(login:*) in the
  // step=enroll_totp branch. For TOTP-enrolled users, completing step 1
  // does NOT reset the login counter — that only happens via window expiry.
  it('successful login on enroll_totp branch clears the failure counter', async () => {
    createTestUser({
      username: 'rl-clear-enroll',
      password: 'good-password-1!',
      totpEnrolled: false,
    });

    for (let i = 0; i < 4; i++) {
      await request(app)
        .post('/auth/login')
        .send({ username: 'rl-clear-enroll', password: 'wrong' });
    }

    const ok = await request(app)
      .post('/auth/login')
      .send({ username: 'rl-clear-enroll', password: 'good-password-1!' });
    expect(ok.status).toBe(200);
    expect(ok.body.step).toBe('enroll_totp');

    // Counter cleared — 5 fresh failures must all return 401, not 429
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/auth/login')
        .send({ username: 'rl-clear-enroll', password: 'wrong-' + i });
      expect(r.status).toBe(401);
    }
  });
});

describe('rate-limit at /auth/totp', () => {
  it('returns 429 after 5 failed TOTP attempts on the same pending session', async () => {
    const user = createTestUser({
      username: 'rl-totp',
      password: 'good-password-1!',
      totpEnrolled: true,
    });

    const step1 = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: user.password });
    const pending = setCookie(step1, 's3x_pending')!;

    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/auth/totp')
        .set('Cookie', pending)
        .send({ code: '000000' });
      expect(r.status).toBe(401);
    }

    const blocked = await request(app)
      .post('/auth/totp')
      .set('Cookie', pending)
      .send({ code: withTotp(user) });
    expect(blocked.status).toBe(429);
  });
});
