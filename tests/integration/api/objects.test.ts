import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import {
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
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

describe('GET /api/objects/:bucket (folder listing)', () => {
  it('returns prefixes + objects from ListObjectsV2', async () => {
    s3.on(ListObjectsV2Command).resolves({
      CommonPrefixes: [{ Prefix: 'folder/' }],
      Contents: [
        { Key: 'file.txt', Size: 10, LastModified: new Date('2026-01-01'), ETag: 'a' },
      ],
      IsTruncated: false,
    });
    const res = await request(app)
      .get('/api/objects/b')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.prefixes).toEqual(['folder/']);
    expect(res.body.objects).toHaveLength(1);
    expect(res.body.objects[0]).toMatchObject({ Key: 'file.txt', Size: 10, IsDeleteMarker: false });
  });

  it('paginates with continuation tokens and stops at PAGE_CAP', async () => {
    let calls = 0;
    s3.on(ListObjectsV2Command).callsFake(() => {
      calls++;
      return {
        Contents: [{ Key: `obj-${calls}`, Size: 1 }],
        IsTruncated: true,
        NextContinuationToken: 'tok-' + calls,
      };
    });
    const res = await request(app)
      .get('/api/objects/b?pageCap=3')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.body.pages).toBe(3);
    expect(res.body.isTruncated).toBe(true);
    expect(res.body.objects).toHaveLength(3);
  });

  it('filters out the prefix self-entry (no Key matching the requested prefix)', async () => {
    s3.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'folder/', Size: 0 }, // self
        { Key: 'folder/real.txt', Size: 5 },
      ],
      IsTruncated: false,
    });
    const res = await request(app)
      .get('/api/objects/b?prefix=folder/')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.body.objects.map((o: { Key: string }) => o.Key)).toEqual(['folder/real.txt']);
  });

  describe('?showDeleted=1 (versions + delete-marker dedupe)', () => {
    // The showDeleted listing does TWO calls now: ListObjectVersions to
    // surface versions + delete markers, and ListObjectsV2 to determine
    // which subfolder prefixes are "fully dead" (every key under them is
    // a delete-marker tombstone). The V2 call needs its own mock so it
    // doesn't return undefined and crash the handler.
    beforeEach(() => {
      s3.on(ListObjectsV2Command).resolves({ Contents: [], CommonPrefixes: [], IsTruncated: false });
    });

    it('uses ListObjectVersionsCommand and surfaces delete markers', async () => {
      s3.on(ListObjectVersionsCommand).resolves({
        Versions: [
          { Key: 'x.txt', VersionId: 'v1', Size: 5, LastModified: new Date('2026-01-01'), ETag: 'a' },
        ],
        DeleteMarkers: [
          { Key: 'x.txt', VersionId: 'v2', LastModified: new Date('2026-02-01') },
        ],
        IsTruncated: false,
      });
      const res = await request(app)
        .get('/api/objects/b?showDeleted=1')
        .set('Cookie', cookie)
        .set(TEST_S3_HEADERS);
      expect(res.body.objects).toHaveLength(1);
      // The marker is newer → wins after dedupe
      expect(res.body.objects[0]).toMatchObject({
        Key: 'x.txt',
        IsDeleteMarker: true,
        VersionId: 'v2',
      });
    });

    it('keeps the live version when it is newer than the marker', async () => {
      s3.on(ListObjectVersionsCommand).resolves({
        Versions: [
          { Key: 'x.txt', VersionId: 'v3', Size: 7, LastModified: new Date('2026-03-01'), ETag: 'c' },
        ],
        DeleteMarkers: [
          { Key: 'x.txt', VersionId: 'v2', LastModified: new Date('2026-02-01') },
        ],
        IsTruncated: false,
      });
      const res = await request(app)
        .get('/api/objects/b?showDeleted=1')
        .set('Cookie', cookie)
        .set(TEST_S3_HEADERS);
      expect(res.body.objects[0]).toMatchObject({
        Key: 'x.txt',
        IsDeleteMarker: false,
        VersionId: 'v3',
      });
    });

    it('flags subfolders with only delete-markers as deletedPrefixes', async () => {
      s3.on(ListObjectVersionsCommand).resolves({
        Versions: [],
        DeleteMarkers: [
          { Key: 'dead/inside.txt', VersionId: 'm1', LastModified: new Date('2026-02-01') },
        ],
        CommonPrefixes: [{ Prefix: 'live/' }, { Prefix: 'dead/' }],
        IsTruncated: false,
      });
      // Only `live/` has a non-marker latest version → V2 returns just that.
      s3.on(ListObjectsV2Command).resolves({
        Contents: [],
        CommonPrefixes: [{ Prefix: 'live/' }],
        IsTruncated: false,
      });
      const res = await request(app)
        .get('/api/objects/b?showDeleted=1')
        .set('Cookie', cookie)
        .set(TEST_S3_HEADERS);
      expect(res.body.prefixes).toEqual(expect.arrayContaining(['live/', 'dead/']));
      expect(res.body.deletedPrefixes).toEqual(['dead/']);
    });
  });
});

describe('GET /api/object/:bucket/head', () => {
  it('returns metadata for a key', async () => {
    s3.on(HeadObjectCommand).resolves({
      ContentType: 'image/png',
      ContentLength: 12345,
      ETag: 'etag',
      VersionId: 'v1',
      LastModified: new Date('2026-01-01'),
      Metadata: { x: 'y' },
    });
    const res = await request(app)
      .get('/api/object/b/head?key=foo.png')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.body).toMatchObject({
      ContentType: 'image/png',
      ContentLength: 12345,
      ETag: 'etag',
      VersionId: 'v1',
      Metadata: { x: 'y' },
    });
  });

  it('returns 400 when key is missing', async () => {
    const res = await request(app)
      .get('/api/object/b/head')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('missing key');
  });
});

describe('GET /api/object/:bucket/versions', () => {
  it('merges versions + delete markers sorted newest-first', async () => {
    s3.on(ListObjectVersionsCommand).resolves({
      Versions: [
        { Key: 'a.txt', VersionId: 'v1', Size: 1, LastModified: new Date('2026-01-01'), ETag: 'a' },
        { Key: 'a.txt', VersionId: 'v3', Size: 3, LastModified: new Date('2026-03-01'), ETag: 'c' },
        { Key: 'other.txt', VersionId: 'vX', Size: 0, LastModified: new Date('2026-01-15') },
      ],
      DeleteMarkers: [
        { Key: 'a.txt', VersionId: 'v2', LastModified: new Date('2026-02-01') },
      ],
    });
    const res = await request(app)
      .get('/api/object/b/versions?key=a.txt')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.body.versions).toHaveLength(3);
    expect(res.body.versions[0]).toMatchObject({ VersionId: 'v3', Type: 'version' });
    expect(res.body.versions[1]).toMatchObject({ VersionId: 'v2', Type: 'delete-marker' });
    expect(res.body.versions[2]).toMatchObject({ VersionId: 'v1', Type: 'version' });
  });

  it('400 when key is missing', async () => {
    const res = await request(app)
      .get('/api/object/b/versions')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/object/:bucket/folder', () => {
  it('creates a PutObject with trailing slash key', async () => {
    s3.on(PutObjectCommand).resolves({});
    const res = await request(app)
      .post('/api/object/b/folder')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ prefix: 'parent/', name: 'child' });
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('parent/child/');
    expect(s3.commandCalls(PutObjectCommand)[0].args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'parent/child/',
    });
  });
});

describe('DELETE /api/object/:bucket', () => {
  it('deletes a key', async () => {
    s3.on(DeleteObjectCommand).resolves({});
    const res = await request(app)
      .delete('/api/object/b')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ key: 'file.txt' });
    expect(res.status).toBe(200);
    expect(s3.commandCalls(DeleteObjectCommand)[0].args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'file.txt',
    });
  });

  it('passes VersionId when provided', async () => {
    s3.on(DeleteObjectCommand).resolves({});
    await request(app)
      .delete('/api/object/b')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ key: 'file.txt', versionId: 'v9' });
    expect(s3.commandCalls(DeleteObjectCommand)[0].args[0].input).toMatchObject({
      VersionId: 'v9',
    });
  });
});

describe('POST /api/object/:bucket/restore (delete-marker undo)', () => {
  it('deletes the delete-marker version', async () => {
    s3.on(DeleteObjectCommand).resolves({});
    await request(app)
      .post('/api/object/b/restore')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ key: 'x.txt', versionId: 'marker-v' });
    expect(s3.commandCalls(DeleteObjectCommand)[0].args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'x.txt',
      VersionId: 'marker-v',
    });
  });
});

describe('POST /api/object/:bucket/delete-batch', () => {
  it('passes through string keys', async () => {
    s3.on(DeleteObjectsCommand).resolves({ Deleted: [{ Key: 'a' }, { Key: 'b' }], Errors: [] });
    const res = await request(app)
      .post('/api/object/b/delete-batch')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ keys: ['a', 'b'] });
    expect(res.body.deleted).toHaveLength(2);
    expect(s3.commandCalls(DeleteObjectsCommand)[0].args[0].input.Delete?.Objects).toEqual([
      { Key: 'a' },
      { Key: 'b' },
    ]);
  });

  it('passes through object keys with versionId', async () => {
    s3.on(DeleteObjectsCommand).resolves({ Deleted: [], Errors: [] });
    await request(app)
      .post('/api/object/b/delete-batch')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ keys: [{ key: 'x', versionId: 'v1' }] });
    expect(s3.commandCalls(DeleteObjectsCommand)[0].args[0].input.Delete?.Objects).toEqual([
      { Key: 'x', VersionId: 'v1' },
    ]);
  });

  it('rejects > 1000 keys via schema', async () => {
    const keys = Array.from({ length: 1001 }, (_, i) => 'k-' + i);
    const res = await request(app)
      .post('/api/object/b/delete-batch')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ keys });
    expect(res.status).toBe(400);
  });

  it('rejects empty keys array', async () => {
    const res = await request(app)
      .post('/api/object/b/delete-batch')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ keys: [] });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/object/:bucket/copy', () => {
  it('builds CopySource with encoded segments + versionId', async () => {
    s3.on(CopyObjectCommand).resolves({});
    await request(app)
      .post('/api/object/b/copy')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ sourceKey: 'folder/has space.txt', destKey: 'dest/copy.txt', sourceVersionId: 'v9' });
    const call = s3.commandCalls(CopyObjectCommand)[0];
    expect(call.args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'dest/copy.txt',
      CopySource: '/b/folder/has%20space.txt?versionId=v9',
    });
  });
});

describe('POST /api/object/:bucket/rename', () => {
  it('issues copy + delete in order', async () => {
    s3.on(CopyObjectCommand).resolves({});
    s3.on(DeleteObjectCommand).resolves({});
    await request(app)
      .post('/api/object/b/rename')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ sourceKey: 'old.txt', destKey: 'new.txt' });
    expect(s3.commandCalls(CopyObjectCommand)).toHaveLength(1);
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(s3.commandCalls(DeleteObjectCommand)[0].args[0].input).toMatchObject({
      Key: 'old.txt',
    });
  });
});

describe('POST /api/objects/:bucket/exists', () => {
  it('returns exists=true for found keys, exists=false for 404 (NotFound name)', async () => {
    s3.on(HeadObjectCommand, { Key: 'present' }).resolves({});
    s3.on(HeadObjectCommand, { Key: 'gone' }).rejects(
      Object.assign(new Error('not found'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      }),
    );
    const res = await request(app)
      .post('/api/objects/b/exists')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ keys: ['present', 'gone'] });
    expect(res.body.results).toEqual([
      { key: 'present', exists: true },
      { key: 'gone', exists: false },
    ]);
  });

  it('fails open: an unexpected error becomes exists=false (not a 500 for the whole request)', async () => {
    s3.on(HeadObjectCommand).rejects(
      Object.assign(new Error('boom'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }),
    );
    const res = await request(app)
      .post('/api/objects/b/exists')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ keys: ['secret'] });
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ key: 'secret', exists: false, error: 'AccessDenied' });
  });

  it('schema caps the input at 100 keys', async () => {
    const keys = Array.from({ length: 101 }, (_, i) => 'k-' + i);
    const res = await request(app)
      .post('/api/objects/b/exists')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .send({ keys });
    expect(res.status).toBe(400);
  });
});
