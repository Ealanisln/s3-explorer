import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
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

describe('GET /api/search/:bucket (bounded JSON search)', () => {
  it('returns matching keys (substring, case-insensitive)', async () => {
    s3.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'docs/Report-2026.pdf', Size: 1 },
        { Key: 'images/header.png', Size: 2 },
        { Key: 'docs/report-summary.txt', Size: 3 },
      ],
      IsTruncated: false,
    });
    const res = await request(app)
      .get('/api/search/b?q=REPORT')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { Key: string }) => r.Key).sort()).toEqual([
      'docs/Report-2026.pdf',
      'docs/report-summary.txt',
    ]);
    expect(res.body.truncated).toBe(false);
  });

  it('returns empty results immediately when q is empty', async () => {
    const res = await request(app)
      .get('/api/search/b?q=')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.body).toEqual({ results: [], scanned: 0, truncated: false });
    expect(s3.commandCalls(ListObjectsV2Command)).toHaveLength(0);
  });

  it('caps results at limit and marks truncated=true', async () => {
    s3.on(ListObjectsV2Command).resolves({
      Contents: Array.from({ length: 50 }, (_, i) => ({ Key: `match-${i}.txt`, Size: 1 })),
      IsTruncated: false,
    });
    const res = await request(app)
      .get('/api/search/b?q=match&limit=10')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.body.results).toHaveLength(10);
    expect(res.body.truncated).toBe(true);
  });

  it('respects scan cap and stops paginating when reached', async () => {
    let calls = 0;
    s3.on(ListObjectsV2Command).callsFake(() => {
      calls++;
      return {
        Contents: Array.from({ length: 1000 }, (_, i) => ({ Key: `page-${calls}-${i}.txt`, Size: 1 })),
        IsTruncated: true,
        NextContinuationToken: 'tok-' + calls,
      };
    });
    const res = await request(app)
      .get('/api/search/b?q=zzz&scan=2000')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(calls).toBe(2);
    expect(res.body.scanned).toBe(2000);
  });
});

describe('GET /api/search-stream/:bucket (NDJSON)', () => {
  function parseFrames(body: string): Array<Record<string, unknown>> {
    return body
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('emits progress + hit + done frames in NDJSON', async () => {
    s3.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'one-match.txt', Size: 1, LastModified: new Date('2026-01-01'), ETag: 'a' },
        { Key: 'no-touch.bin', Size: 2 },
      ],
      IsTruncated: false,
    });
    const res = await request(app)
      .get('/api/search-stream/b?q=match')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);

    const frames = parseFrames(res.text);
    expect(frames.find((f) => f.t === 'hit')).toMatchObject({ key: 'one-match.txt' });
    expect(frames.find((f) => f.t === 'progress')).toMatchObject({ scanned: 2 });
    expect(frames.find((f) => f.t === 'done')).toMatchObject({ scanned: 2, hits: 1, reason: 'complete' });
  });

  it('emits done with reason=limit when hits reach maxResults', async () => {
    s3.on(ListObjectsV2Command).resolves({
      Contents: Array.from({ length: 50 }, (_, i) => ({ Key: `m-${i}.txt`, Size: 1 })),
      IsTruncated: false,
    });
    const res = await request(app)
      .get('/api/search-stream/b?q=m-&limit=5')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    const frames = parseFrames(res.text);
    const done = frames.find((f) => f.t === 'done');
    expect(done).toMatchObject({ reason: 'limit', hits: 5 });
  });

  it('returns 400 (regular JSON, before stream opens) when q is missing', async () => {
    const res = await request(app)
      .get('/api/search-stream/b')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('missing q');
  });

  it('returns 401 MissingCredentials before opening the stream (no ndjson)', async () => {
    const res = await request(app)
      .get('/api/search-stream/b?q=any')
      .set('Cookie', cookie)
      .set('x-s3-endpoint', 'https://minio.local');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('MissingCredentials');
    expect(res.body.errorId).toMatch(/^err-[a-f0-9]{8}$/);
  });

  it('scopes both walks to the prefix query param', async () => {
    let fileWalkPrefix: string | undefined;
    let folderWalkRootPrefix: string | undefined;
    s3.on(ListObjectsV2Command).callsFake((input: { Prefix?: string; Delimiter?: string }) => {
      if (input.Delimiter === '/') {
        if (folderWalkRootPrefix === undefined) folderWalkRootPrefix = input.Prefix;
        return { Contents: [], CommonPrefixes: [], IsTruncated: false };
      }
      fileWalkPrefix = input.Prefix;
      return { Contents: [{ Key: 'sub/zzz.txt', Size: 1 }], IsTruncated: false };
    });
    await request(app)
      .get('/api/search-stream/b?q=zzz&prefix=sub/')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(fileWalkPrefix).toBe('sub/');
    expect(folderWalkRootPrefix).toBe('sub/');
  });

  it('emits folder-hit for subfolders whose last segment matches the query', async () => {
    s3.on(ListObjectsV2Command).callsFake((input: { Prefix?: string; Delimiter?: string }) => {
      if (input.Delimiter === '/') {
        // BFS root → return two children, one matches "92780".
        if (input.Prefix === '') {
          return {
            Contents: [],
            CommonPrefixes: [
              { Prefix: 'live/' },
              { Prefix: 'match_92780_dir/' },
            ],
            IsTruncated: false,
          };
        }
        // Deeper levels → no more children, BFS terminates.
        return { Contents: [], CommonPrefixes: [], IsTruncated: false };
      }
      // File walk: no matching file content.
      return { Contents: [], IsTruncated: false };
    });
    const res = await request(app)
      .get('/api/search-stream/b?q=92780')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    const frames = parseFrames(res.text);
    const folderHits = frames.filter((f) => f.t === 'folder-hit');
    expect(folderHits).toHaveLength(1);
    expect(folderHits[0]).toMatchObject({ key: 'match_92780_dir/' });
  });
});
