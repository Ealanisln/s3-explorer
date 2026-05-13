import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import {
  ListBucketsCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  GetBucketVersioningCommand,
  PutBucketVersioningCommand,
} from '@aws-sdk/client-s3';
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

describe('POST /api/test (connection probe)', () => {
  it('ListBuckets mode when no bucket is provided', async () => {
    s3.on(ListBucketsCommand).resolves({
      Owner: { ID: 'me' },
      Buckets: [{ Name: 'a' }, { Name: 'b' }],
    });
    const res = await request(app)
      .post('/api/test')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, mode: 'list-buckets', bucketCount: 2 });
  });

  it('HeadBucket mode when bucket is provided', async () => {
    s3.on(HeadBucketCommand).resolves({});
    const res = await request(app)
      .post('/api/test')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ bucket: 'pinpoint' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, mode: 'head-bucket', bucket: 'pinpoint' });
  });
});

describe('GET /api/buckets', () => {
  it('returns the SDK response shape', async () => {
    s3.on(ListBucketsCommand).resolves({
      Buckets: [{ Name: 'one' }, { Name: 'two' }],
      Owner: { ID: 'me' },
    });
    const res = await request(app)
      .get('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.buckets).toHaveLength(2);
    expect(res.body.owner).toEqual({ ID: 'me' });
  });

  it('returns empty list when AWS returns no Buckets field', async () => {
    s3.on(ListBucketsCommand).resolves({});
    const res = await request(app)
      .get('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.body.buckets).toEqual([]);
  });
});

describe('POST /api/buckets', () => {
  it('creates a bucket with a valid name', async () => {
    s3.on(CreateBucketCommand).resolves({});
    const res = await request(app)
      .post('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ name: 'my-new-bucket' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(s3.commandCalls(CreateBucketCommand)).toHaveLength(1);
    expect(s3.commandCalls(CreateBucketCommand)[0].args[0].input).toEqual({ Bucket: 'my-new-bucket' });
  });

  it('rejects names that violate the regex (uppercase)', async () => {
    const res = await request(app)
      .post('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ name: 'HasUpperCase' });
    expect(res.status).toBe(400);
  });

  it('rejects names that are too short', async () => {
    const res = await request(app)
      .post('/api/buckets')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ name: 'ab' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/buckets/:bucket', () => {
  it('deletes a bucket', async () => {
    s3.on(DeleteBucketCommand).resolves({});
    const res = await request(app)
      .delete('/api/buckets/some-bucket')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(200);
    expect(s3.commandCalls(DeleteBucketCommand)[0].args[0].input).toEqual({ Bucket: 'some-bucket' });
  });

  it('returns sanitized error when bucket is not empty', async () => {
    s3.on(DeleteBucketCommand).rejects(
      Object.assign(new Error('not empty internally'), {
        name: 'BucketNotEmpty',
        $metadata: { httpStatusCode: 409 },
      }),
    );
    const res = await request(app)
      .delete('/api/buckets/full-bucket')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('BucketNotEmpty');
    expect(res.body.message).toBe('El bucket no está vacío.');
    expect(res.body.errorId).toMatch(/^err-[a-f0-9]{8}$/);
  });
});

describe('GET /api/buckets/:bucket/versioning', () => {
  it('returns the versioning status', async () => {
    s3.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    const res = await request(app)
      .get('/api/buckets/b/versioning')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.body).toEqual({ status: 'Enabled' });
  });

  it('defaults to Disabled when AWS returns no Status', async () => {
    s3.on(GetBucketVersioningCommand).resolves({});
    const res = await request(app)
      .get('/api/buckets/b/versioning')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.body).toEqual({ status: 'Disabled' });
  });
});

describe('PUT /api/buckets/:bucket/versioning (enable-only policy)', () => {
  // Policy invariant from CLAUDE.md: versioning can only be enabled. Suspending
  // is blocked at the schema layer to prevent accidental data loss.
  it('accepts enabled=true and calls SDK with Status=Enabled', async () => {
    s3.on(PutBucketVersioningCommand).resolves({});
    const res = await request(app)
      .put('/api/buckets/b/versioning')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ enabled: true });
    expect(res.status).toBe(200);
    const call = s3.commandCalls(PutBucketVersioningCommand)[0];
    expect(call.args[0].input.VersioningConfiguration).toEqual({ Status: 'Enabled' });
  });

  it('rejects enabled=false at the schema layer (400, no SDK call)', async () => {
    s3.on(PutBucketVersioningCommand).resolves({});
    const res = await request(app)
      .put('/api/buckets/b/versioning')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ enabled: false });
    expect(res.status).toBe(400);
    expect(s3.commandCalls(PutBucketVersioningCommand)).toHaveLength(0);
  });

  it('rejects missing enabled field (400)', async () => {
    const res = await request(app)
      .put('/api/buckets/b/versioning')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects arbitrary string for enabled (400)', async () => {
    const res = await request(app)
      .put('/api/buckets/b/versioning')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ enabled: 'Suspended' });
    expect(res.status).toBe(400);
  });
});
