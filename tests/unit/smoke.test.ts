import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp } from '../fixtures/app';
import { createTestUser, loginAs, loginAsAdmin } from '../fixtures/users';

describe('test fixtures smoke', () => {
  it('boots createApp() without binding a port', () => {
    const app = buildTestApp();
    expect(app).toBeDefined();
  });

  it('serves /healthz without auth', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects /api/* without a session cookie', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/api/buckets');
    expect(res.status).toBe(401);
  });

  it('rejects unknown Host header on gated routes', async () => {
    const app = buildTestApp();
    // /healthz is registered BEFORE hostAllowlist (docker healthcheck exemption),
    // so probe /auth/me instead — that runs through the full middleware stack.
    const res = await request(app).get('/auth/me').set('Host', 'evil.example.com');
    expect(res.status).toBe(403);
  });

  it('creates a TOTP-enrolled user and logs in end-to-end', async () => {
    const app = buildTestApp();
    const user = createTestUser({
      username: 'alice',
      password: 'correct-horse-battery-staple',
      totpEnrolled: true,
    });
    const cookie = await loginAs(app, user);
    expect(cookie).toMatch(/^s3x_session=/);

    const me = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      authenticated: true,
      username: 'alice',
      role: 'user',
      totpEnrolled: true,
    });
  });

  it('loginAsAdmin yields a working admin session', async () => {
    const app = buildTestApp();
    const { user, cookie } = await loginAsAdmin(app);
    expect(user.role).toBe('admin');
    const adminList = await request(app).get('/auth/admin/users').set('Cookie', cookie);
    expect(adminList.status).toBe(200);
    expect(Array.isArray(adminList.body.users) || Array.isArray(adminList.body)).toBe(true);
  });
});
