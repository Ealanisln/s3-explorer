// Management endpoints for Personal Access Tokens (/auth/tokens).
// Session-auth only — a Bearer PAT must never manage tokens.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { buildTestApp } from '../../fixtures/app';
import { createTestUser, loginAs, loginAsAdmin, type TestUser } from '../../fixtures/users';

const app = buildTestApp();
let cookie: string;

beforeAll(async () => {
  cookie = (await loginAsAdmin(app)).cookie;
});

describe('POST /auth/tokens', () => {
  it('creates a token and returns the plaintext exactly once', async () => {
    const res = await request(app)
      .post('/auth/tokens')
      .set('Cookie', cookie)
      .send({ name: 'mi-agente', scope: 'read', expiresInDays: 30 });

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^s3x_[A-Za-z0-9_-]{43}$/);
    expect(res.body).toMatchObject({ name: 'mi-agente', scope: 'read' });
    expect(res.body.expiresAt).toBeTruthy();

    // The list never returns the plaintext (nor any hash).
    const list = await request(app).get('/auth/tokens').set('Cookie', cookie);
    expect(list.status).toBe(200);
    const created = (list.body.tokens as { id: number; name: string }[])
      .find((t) => t.id === res.body.id)!;
    expect(created).toMatchObject({ name: 'mi-agente', scope: 'read', revokedAt: null });
    expect(JSON.stringify(list.body)).not.toContain(res.body.token);
    expect(JSON.stringify(list.body)).not.toMatch(/token_hash|tokenHash|"token"/);
  });

  it('supports tokens without expiry (expiresInDays null / omitted)', async () => {
    const explicit = await request(app)
      .post('/auth/tokens')
      .set('Cookie', cookie)
      .send({ name: 'sin-expirar', scope: 'write', expiresInDays: null });
    expect(explicit.status).toBe(200);
    expect(explicit.body.expiresAt).toBeNull();

    const omitted = await request(app)
      .post('/auth/tokens')
      .set('Cookie', cookie)
      .send({ name: 'sin-expirar-2', scope: 'read' });
    expect(omitted.status).toBe(200);
    expect(omitted.body.expiresAt).toBeNull();
  });

  it('rejects invalid scope and arbitrary expiresInDays (zod)', async () => {
    const badScope = await request(app)
      .post('/auth/tokens')
      .set('Cookie', cookie)
      .send({ name: 'x', scope: 'admin' });
    expect(badScope.status).toBe(400);

    const badDays = await request(app)
      .post('/auth/tokens')
      .set('Cookie', cookie)
      .send({ name: 'x', scope: 'read', expiresInDays: 45 });
    expect(badDays.status).toBe(400);

    const noName = await request(app)
      .post('/auth/tokens')
      .set('Cookie', cookie)
      .send({ scope: 'read' });
    expect(noName.status).toBe(400);
  });

  it('requires a session — anonymous gets 401', async () => {
    const res = await request(app)
      .post('/auth/tokens')
      .send({ name: 'x', scope: 'read' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NO_SESSION');
  });

  it('rejects a Bearer PAT on /auth/* — tokens cannot manage tokens', async () => {
    const created = await request(app)
      .post('/auth/tokens')
      .set('Cookie', cookie)
      .send({ name: 'self-manage', scope: 'write' });
    expect(created.status).toBe(200);

    for (const [method, path] of [
      ['get', '/auth/tokens'],
      ['post', '/auth/tokens'],
      ['delete', `/auth/tokens/${created.body.id}`],
    ] as const) {
      const res = await request(app)[method](path)
        .set('Authorization', `Bearer ${created.body.token}`)
        .send({ name: 'nope', scope: 'read' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('NO_SESSION');
    }
  });
});

describe('DELETE /auth/tokens/:id (revoke)', () => {
  it('revokes own token and is idempotent', async () => {
    const created = await request(app)
      .post('/auth/tokens')
      .set('Cookie', cookie)
      .send({ name: 'para-revocar', scope: 'read' });
    const id = created.body.id as number;

    const first = await request(app).delete(`/auth/tokens/${id}`).set('Cookie', cookie);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });

    const again = await request(app).delete(`/auth/tokens/${id}`).set('Cookie', cookie);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true });

    const list = await request(app).get('/auth/tokens').set('Cookie', cookie);
    const row = (list.body.tokens as { id: number; revokedAt: string | null }[])
      .find((t) => t.id === id)!;
    expect(row.revokedAt).not.toBeNull();
  });

  it('cannot revoke another user\'s token (404)', async () => {
    const other = createTestUser({
      username: 'token-other',
      password: 'good-password-1!',
      totpEnrolled: true,
    });
    const otherCookie = await loginAs(app, other);
    const created = await request(app)
      .post('/auth/tokens')
      .set('Cookie', otherCookie)
      .send({ name: 'ajeno', scope: 'read' });
    expect(created.status).toBe(200);

    const res = await request(app)
      .delete(`/auth/tokens/${created.body.id}`)
      .set('Cookie', cookie); // admin session, but not the owner
    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric id (400)', async () => {
    const res = await request(app).delete('/auth/tokens/abc').set('Cookie', cookie);
    expect(res.status).toBe(400);
  });
});

describe('cap of active tokens', () => {
  let capUser: TestUser;
  let capCookie: string;

  beforeAll(async () => {
    capUser = createTestUser({
      username: 'token-cap-user',
      password: 'good-password-1!',
      totpEnrolled: true,
    });
    capCookie = await loginAs(app, capUser);
  });

  it('rejects the 11th active token with 409, and revoking frees a slot', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/auth/tokens')
        .set('Cookie', capCookie)
        .send({ name: `bot-${i}`, scope: 'read' });
      expect(res.status).toBe(200);
      ids.push(res.body.id);
    }

    const eleventh = await request(app)
      .post('/auth/tokens')
      .set('Cookie', capCookie)
      .send({ name: 'bot-11', scope: 'read' });
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.code).toBe('TOKEN_LIMIT');
    expect(eleventh.body.message).toMatch(/10 tokens/);

    // Revoked tokens do not count toward the cap.
    await request(app).delete(`/auth/tokens/${ids[0]}`).set('Cookie', capCookie);
    const retry = await request(app)
      .post('/auth/tokens')
      .set('Cookie', capCookie)
      .send({ name: 'bot-11', scope: 'read' });
    expect(retry.status).toBe(200);
  });
});
