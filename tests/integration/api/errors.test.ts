import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { ListBucketsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { buildTestApp } from '../../fixtures/app';
import { loginAsAdmin } from '../../fixtures/users';
import { setupS3Mock, TEST_S3_HEADERS, type S3MockClient } from '../../fixtures/s3-mock';

const app = buildTestApp();
let cookie: string;
let s3: S3MockClient;

beforeAll(async () => {
  cookie = (await loginAsAdmin(app)).cookie;
});

beforeEach(() => {
  s3 = setupS3Mock();
});

// CD-SEC-005 — full SDK error text (which can contain ARNs, bucket names,
// internal paths) must NEVER reach the client. Only mapped Spanish messages
// plus an errorId.
describe('sanitizeError wiring through wrap()', () => {
  function awsError(name: string, status: number, leakyMessage = 'leaky internal detail'): Error {
    return Object.assign(new Error(leakyMessage), {
      name,
      $metadata: { httpStatusCode: status },
    });
  }

  it('maps AccessDenied to Spanish message with errorId, hides original text', async () => {
    s3.on(ListBucketsCommand).rejects(awsError('AccessDenied', 403, 'arn:aws:iam::123:role/secret-role denied'));
    const res = await request(app)
      .get('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('AccessDenied');
    expect(res.body.message).toBe('Acceso denegado. Verifica los permisos del IAM para este bucket/objeto.');
    expect(res.body.message).not.toContain('arn:aws');
    expect(res.body.message).not.toContain('secret-role');
    expect(res.body.errorId).toMatch(/^err-[a-f0-9]{8}$/);
  });

  it('maps NoSuchBucket to its Spanish equivalent', async () => {
    s3.on(ListObjectsV2Command).rejects(awsError('NoSuchBucket', 404));
    const res = await request(app)
      .get('/api/objects/missing')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NoSuchBucket');
    expect(res.body.message).toBe('El bucket no existe.');
  });

  it('maps InvalidAccessKeyId without hinting which credential was wrong', async () => {
    s3.on(ListBucketsCommand).rejects(awsError('InvalidAccessKeyId', 403, 'access key AKIA1234567890 invalid'));
    const res = await request(app)
      .get('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.body.message).toBe('Credenciales inválidas. Verifica access key y secret key.');
    expect(res.body.message).not.toMatch(/AKIA\d/);
  });

  it('unknown 5xx errors collapse to InternalError (no error name leak)', async () => {
    s3.on(ListBucketsCommand).rejects(awsError('WeirdInternalDetailLeak', 500, 'stack trace at /opt/server/lib/...'));
    const res = await request(app)
      .get('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('InternalError');
    expect(res.body.message).toBe('Error interno del servidor.');
    expect(res.body.message).not.toMatch(/stack trace|opt\/server/);
    expect(res.body.errorId).toMatch(/^err-[a-f0-9]{8}$/);
  });

  it('unknown 4xx errors return generic "Operación rechazada"', async () => {
    s3.on(ListBucketsCommand).rejects(awsError('SomeCustomClientError', 422, 'invalid foo bar baz'));
    const res = await request(app)
      .get('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('SomeCustomClientError');
    expect(res.body.message).toBe('Operación rechazada.');
    expect(res.body.message).not.toContain('foo bar baz');
  });

  it('defaults to 500 when error carries no httpStatusCode', async () => {
    s3.on(ListBucketsCommand).rejects(new Error('plain'));
    const res = await request(app)
      .get('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('InternalError');
  });

  it('each errored response gets a unique errorId', async () => {
    s3.on(ListBucketsCommand).rejects(awsError('AccessDenied', 403));
    const a = await request(app).get('/api/buckets').set('Cookie', cookie).set(TEST_S3_HEADERS);
    const b = await request(app).get('/api/buckets').set('Cookie', cookie).set(TEST_S3_HEADERS);
    expect(a.body.errorId).toMatch(/^err-/);
    expect(b.body.errorId).toMatch(/^err-/);
    expect(a.body.errorId).not.toBe(b.body.errorId);
  });
});
