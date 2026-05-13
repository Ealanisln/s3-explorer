import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { buildTestApp } from '../../fixtures/app';
import { createTestUser, loginAs, loginAsAdmin } from '../../fixtures/users';
import type { TestUser } from '../../fixtures/users';

const app = buildTestApp();

// One admin seeded for the file. createUser enforces UNIQUE on username, so
// each describe block does NOT re-seed — they all share this cookie.
let adminUser: TestUser;
let adminCookie: string;

beforeAll(async () => {
  const session = await loginAsAdmin(app);
  adminUser = session.user;
  adminCookie = session.cookie;
});

describe('admin guard', () => {
  it('rejects non-admin with 403', async () => {
    const u = createTestUser({
      username: 'plain-user',
      password: 'good-password-1!',
      role: 'user',
      totpEnrolled: true,
    });
    const cookie = await loginAs(app, u);

    const res = await request(app).get('/auth/admin/users').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/admin/i);
  });

  it('rejects unauthenticated with 401', async () => {
    const res = await request(app).get('/auth/admin/users');
    expect(res.status).toBe(401);
  });
});

describe('GET /auth/admin/users', () => {
  it('returns the list with safe fields only (no hashes, no totp secret)', async () => {
    const cookie = adminCookie;
    createTestUser({
      username: 'listed-user',
      password: 'good-password-1!',
      totpEnrolled: true,
    });

    const res = await request(app).get('/auth/admin/users').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);

    const target = res.body.users.find((u: { username: string }) => u.username === 'listed-user');
    expect(target).toBeDefined();
    expect(target).toMatchObject({
      username: 'listed-user',
      role: 'user',
      disabled: false,
      totpEnrolled: true,
      mustChangePassword: false,
    });
    expect(target.passwordHash).toBeUndefined();
    expect(target.totpSecret).toBeUndefined();
    expect(target.recoveryCodesHashed).toBeUndefined();
  });
});

describe('POST /auth/admin/users', () => {
  it('creates a user with role=user, mustChangePassword=true, and TOTP not enrolled', async () => {
    const cookie = adminCookie;

    const res = await request(app)
      .post('/auth/admin/users')
      .set('Cookie', cookie)
      .send({ username: 'created-by-admin', password: 'admin-issued-1!' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const list = await request(app).get('/auth/admin/users').set('Cookie', cookie);
    const created = list.body.users.find(
      (u: { username: string }) => u.username === 'created-by-admin'
    );
    expect(created).toMatchObject({
      role: 'user',
      disabled: false,
      totpEnrolled: false,
      mustChangePassword: true,
    });
  });

  it('returns 409 on duplicate username (case-insensitive)', async () => {
    const cookie = adminCookie;
    await request(app)
      .post('/auth/admin/users')
      .set('Cookie', cookie)
      .send({ username: 'dup-user', password: 'whatever-12345' });

    const res = await request(app)
      .post('/auth/admin/users')
      .set('Cookie', cookie)
      .send({ username: 'DUP-USER', password: 'different-12345' });
    expect(res.status).toBe(409);
  });

  it('rejects invalid username (zod schema)', async () => {
    const cookie = adminCookie;
    const res = await request(app)
      .post('/auth/admin/users')
      .set('Cookie', cookie)
      .send({ username: 'has spaces', password: 'whatever-12345' });
    expect(res.status).toBe(400);
  });

  it('rejects password shorter than 8 chars', async () => {
    const cookie = adminCookie;
    const res = await request(app)
      .post('/auth/admin/users')
      .set('Cookie', cookie)
      .send({ username: 'short-pass', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('persists role=admin when requested', async () => {
    const cookie = adminCookie;
    await request(app)
      .post('/auth/admin/users')
      .set('Cookie', cookie)
      .send({ username: 'second-admin', password: 'good-password-1!', role: 'admin' });

    const list = await request(app).get('/auth/admin/users').set('Cookie', cookie);
    const created = list.body.users.find(
      (u: { username: string }) => u.username === 'second-admin'
    );
    expect(created.role).toBe('admin');
  });
});

describe('disable / enable', () => {
  it('disables a target user and blocks their login', async () => {
    const cookie = adminCookie;
    const victim = createTestUser({
      username: 'to-be-disabled',
      password: 'good-password-1!',
      totpEnrolled: true,
    });

    const res = await request(app)
      .post(`/auth/admin/users/${victim.username}/disable`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);

    const login = await request(app)
      .post('/auth/login')
      .send({ username: victim.username, password: victim.password });
    expect(login.status).toBe(401);
  });

  it('refuses to disable the admin acting on themselves', async () => {
    const user = adminUser; const cookie = adminCookie;
    const res = await request(app)
      .post(`/auth/admin/users/${user.username}/disable`)
      .set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/ti mismo/);
  });

  it('returns 404 disabling an unknown user', async () => {
    const cookie = adminCookie;
    const res = await request(app)
      .post('/auth/admin/users/nope-no-one/disable')
      .set('Cookie', cookie);
    expect(res.status).toBe(404);
  });

  it('re-enables a disabled user', async () => {
    const cookie = adminCookie;
    const victim = createTestUser({
      username: 'to-be-reenabled',
      password: 'good-password-1!',
      disabled: true,
      totpEnrolled: true,
    });

    const res = await request(app)
      .post(`/auth/admin/users/${victim.username}/enable`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);

    const login = await request(app)
      .post('/auth/login')
      .send({ username: victim.username, password: victim.password });
    expect(login.status).toBe(200);
  });
});

describe('reset-password', () => {
  it('replaces the hash and sets mustChangePassword=true', async () => {
    const cookie = adminCookie;
    const victim = createTestUser({
      username: 'to-reset-pw',
      password: 'original-12345',
      totpEnrolled: true,
    });

    const res = await request(app)
      .post(`/auth/admin/users/${victim.username}/reset-password`)
      .set('Cookie', cookie)
      .send({ newPassword: 'admin-issued-new-1!' });
    expect(res.status).toBe(200);

    // Old password no longer works
    const oldLogin = await request(app)
      .post('/auth/login')
      .send({ username: victim.username, password: 'original-12345' });
    expect(oldLogin.status).toBe(401);

    // New password works and step1 succeeds
    const newLogin = await request(app)
      .post('/auth/login')
      .send({ username: victim.username, password: 'admin-issued-new-1!' });
    expect(newLogin.status).toBe(200);

    // mustChangePassword surfaces in /auth/me after they complete step 2
    const list = await request(app).get('/auth/admin/users').set('Cookie', cookie);
    const target = list.body.users.find(
      (u: { username: string }) => u.username === victim.username
    );
    expect(target.mustChangePassword).toBe(true);
  });

  it('returns 404 when target does not exist', async () => {
    const cookie = adminCookie;
    const res = await request(app)
      .post('/auth/admin/users/ghost/reset-password')
      .set('Cookie', cookie)
      .send({ newPassword: 'whatever-12345' });
    expect(res.status).toBe(404);
  });
});

describe('reset-totp', () => {
  it('clears totpSecret, totpConfirmed, and recovery codes', async () => {
    const cookie = adminCookie;
    const victim = createTestUser({
      username: 'to-reset-totp',
      password: 'good-password-1!',
      totpEnrolled: true,
    });

    const res = await request(app)
      .post(`/auth/admin/users/${victim.username}/reset-totp`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);

    const list = await request(app).get('/auth/admin/users').set('Cookie', cookie);
    const target = list.body.users.find(
      (u: { username: string }) => u.username === victim.username
    );
    expect(target.totpEnrolled).toBe(false);
    expect(target.recoveryRemaining).toBe(0);

    // Next login takes the enroll_totp branch
    const login = await request(app)
      .post('/auth/login')
      .send({ username: victim.username, password: victim.password });
    expect(login.status).toBe(200);
    expect(login.body.step).toBe('enroll_totp');
  });
});
