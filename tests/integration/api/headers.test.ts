import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { buildTestApp } from '../../fixtures/app';
import { loginAsAdmin } from '../../fixtures/users';
import { setupS3Mock, TEST_S3_HEADERS } from '../../fixtures/s3-mock';
import { ListBucketsCommand } from '@aws-sdk/client-s3';

const app = buildTestApp();
let cookie: string;

beforeAll(async () => {
  const s = await loginAsAdmin(app);
  cookie = s.cookie;
});

describe('buildClient header requirements', () => {
  it('returns 401 MissingCredentials when x-s3-access-key/secret-key are absent', async () => {
    setupS3Mock();
    const res = await request(app)
      .get('/api/buckets')
      .set('Cookie', cookie)
      .set('x-s3-endpoint', 'https://minio.local')
      .set('x-s3-region', 'us-east-1');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('MissingCredentials');
    expect(res.body.errorId).toMatch(/^err-[a-f0-9]{8}$/);
  });

  it('returns 403 EndpointBlocked for AWS IMDS hostname', async () => {
    setupS3Mock();
    const res = await request(app)
      .get('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .set('x-s3-endpoint', 'http://169.254.169.254');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('EndpointBlocked');
    expect(res.body.message).toMatch(/bloqueado/i);
  });

  it('returns 403 EndpointBlocked for GCP metadata hostname', async () => {
    setupS3Mock();
    const res = await request(app)
      .get('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .set('x-s3-endpoint', 'http://metadata.google.internal');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('EndpointBlocked');
  });

  it('passes through to S3 when all headers are present and endpoint is allowed', async () => {
    const s3 = setupS3Mock();
    s3.on(ListBucketsCommand).resolves({ Buckets: [{ Name: 'ok-bucket' }] });
    const res = await request(app)
      .get('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.buckets).toEqual([{ Name: 'ok-bucket' }]);
  });
});

describe('/api/* auth + 404 surface', () => {
  it('unauthenticated /api request returns 401 (no session)', async () => {
    setupS3Mock();
    const res = await request(app).get('/api/buckets').set(TEST_S3_HEADERS);
    expect(res.status).toBe(401);
  });

  it('unknown /api path returns 404 with generic JSON message', async () => {
    const res = await request(app)
      .get('/api/does-not-exist')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Not found');
  });
});
