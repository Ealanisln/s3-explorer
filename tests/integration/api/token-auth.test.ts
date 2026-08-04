// Bearer PAT authentication + scope enforcement on /api/*.
//
// NOTE: token-auth failures are rate limited per IP (10 / 15 min). Supertest
// requests all share one IP, so the rate-limit describe MUST stay last in
// this file — once the budget is burned, every token auth attempt 429s.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { ListBucketsCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import { buildTestApp } from '../../fixtures/app';
import { createTestUser, loginAsAdmin } from '../../fixtures/users';
import { setupS3Mock, TEST_S3_HEADERS, type S3MockClient } from '../../fixtures/s3-mock';
import { createToken } from '../../../src/auth/tokens-store';
import { updateUser } from '../../../src/auth/users-store';

const app = buildTestApp();
let cookie: string;
let s3: S3MockClient;
let readToken: string;
let writeToken: string;

beforeAll(async () => {
  cookie = (await loginAsAdmin(app)).cookie;
  const read = await request(app)
    .post('/auth/tokens')
    .set('Cookie', cookie)
    .send({ name: 'lector', scope: 'read' });
  const write = await request(app)
    .post('/auth/tokens')
    .set('Cookie', cookie)
    .send({ name: 'escritor', scope: 'write' });
  readToken = read.body.token;
  writeToken = write.body.token;
});

beforeEach(() => {
  s3 = setupS3Mock();
});

describe('Bearer token auth on /api/*', () => {
  it('read token authenticates a read endpoint (GET /api/buckets)', async () => {
    s3.on(ListBucketsCommand).resolves({ Buckets: [{ Name: 'uno' }] });
    const res = await request(app)
      .get('/api/buckets')
      .set('Authorization', `Bearer ${readToken}`)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.buckets).toHaveLength(1);
  });

  it('bumps last_used_at after a bearer request', async () => {
    const list = await request(app).get('/auth/tokens').set('Cookie', cookie);
    const lector = (list.body.tokens as { name: string; lastUsedAt: string | null }[])
      .find((t) => t.name === 'lector')!;
    expect(lector.lastUsedAt).not.toBeNull();
  });

  it('skips the TOTP/password session gates by design (agent identity)', async () => {
    // A user who could NOT use /api/* with a session cookie (no TOTP, initial
    // password pending) still works via PAT — the token chain replaces the
    // session chain entirely. Tokens for such users can only be minted by the
    // user once fully enrolled, or seeded directly (as here, for the test).
    createTestUser({
      username: 'agent-raw',
      password: 'good-password-1!',
      totpEnrolled: false,
      mustChangePassword: true,
    });
    const { plaintext } = createToken({
      username: 'agent-raw', name: 'seeded', scope: 'read', expiresAt: null,
    });
    s3.on(ListBucketsCommand).resolves({ Buckets: [] });
    const res = await request(app)
      .get('/api/buckets')
      .set('Authorization', `Bearer ${plaintext}`)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(200);
  });
});

describe('scope enforcement', () => {
  it('read token is rejected on a write endpoint with 403 (not 401), no SDK call', async () => {
    s3.on(CreateBucketCommand).resolves({});
    const res = await request(app)
      .post('/api/buckets')
      .set('Authorization', `Bearer ${readToken}`)
      .set(TEST_S3_HEADERS)
      .send({ name: 'nuevo-bucket' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOKEN_SCOPE');
    expect(s3.commandCalls(CreateBucketCommand)).toHaveLength(0);
  });

  it('write token passes the same write endpoint', async () => {
    s3.on(CreateBucketCommand).resolves({});
    const res = await request(app)
      .post('/api/buckets')
      .set('Authorization', `Bearer ${writeToken}`)
      .set(TEST_S3_HEADERS)
      .send({ name: 'nuevo-bucket' });
    expect(res.status).toBe(200);
    expect(s3.commandCalls(CreateBucketCommand)).toHaveLength(1);
  });

  it('write implies read', async () => {
    s3.on(ListBucketsCommand).resolves({ Buckets: [] });
    const res = await request(app)
      .get('/api/buckets')
      .set('Authorization', `Bearer ${writeToken}`)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(200);
  });

  it('session users are unaffected by scope gates (full access)', async () => {
    s3.on(CreateBucketCommand).resolves({});
    const res = await request(app)
      .post('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ name: 'via-sesion' });
    expect(res.status).toBe(200);
  });
});

describe('invalid tokens → 401', () => {
  // Each failing attempt here burns one unit of the shared per-IP failure
  // budget (10). Keep the total below the limit so assertions see 401, not 429.
  it('unknown token', async () => {
    const res = await request(app)
      .get('/api/buckets')
      .set('Authorization', 'Bearer s3x_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('malformed token (bad length)', async () => {
    const res = await request(app)
      .get('/api/buckets')
      .set('Authorization', 'Bearer s3x_demasiado-corto')
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('revoked token', async () => {
    const created = await request(app)
      .post('/auth/tokens')
      .set('Cookie', cookie)
      .send({ name: 'revocado', scope: 'read' });
    await request(app).delete(`/auth/tokens/${created.body.id}`).set('Cookie', cookie);

    const res = await request(app)
      .get('/api/buckets')
      .set('Authorization', `Bearer ${created.body.token}`)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('expired token', async () => {
    const { plaintext } = createToken({
      username: 'admin-test',
      name: 'vencido',
      scope: 'read',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await request(app)
      .get('/api/buckets')
      .set('Authorization', `Bearer ${plaintext}`)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('token whose user was disabled', async () => {
    createTestUser({
      username: 'token-disabled-user',
      password: 'good-password-1!',
      totpEnrolled: true,
    });
    const { plaintext } = createToken({
      username: 'token-disabled-user', name: 'huerfano', scope: 'read', expiresAt: null,
    });
    await updateUser('token-disabled-user', { disabled: true });

    const res = await request(app)
      .get('/api/buckets')
      .set('Authorization', `Bearer ${plaintext}`)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('non-s3x Bearer falls through to session auth (401 NO_SESSION)', async () => {
    const res = await request(app)
      .get('/api/buckets')
      .set('Authorization', 'Bearer some-jwt-looking-thing')
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NO_SESSION');
  });
});

// MUST be last — burns the per-IP failure budget for the whole file.
describe('rate limiting on repeated bad tokens', () => {
  it('returns 429 after 10 failures / 15 min per IP, then blocks even valid tokens', async () => {
    let final: request.Response | null = null;
    for (let i = 0; i < 12; i++) {
      final = await request(app)
        .get('/api/buckets')
        .set('Authorization', 'Bearer s3x_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')
        .set(TEST_S3_HEADERS);
      if (final.status === 429) break;
      expect(final.status).toBe(401);
    }
    expect(final!.status).toBe(429);
    expect(final!.body.message).toMatch(/15 minutos/);

    // Once the IP is limited, even a valid token is throttled (fail closed).
    const valid = await request(app)
      .get('/api/buckets')
      .set('Authorization', `Bearer ${readToken}`)
      .set(TEST_S3_HEADERS);
    expect(valid.status).toBe(429);

    // Session auth is NOT affected by the token limiter.
    s3.on(ListBucketsCommand).resolves({ Buckets: [] });
    const session = await request(app)
      .get('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(session.status).toBe(200);
  });
});
