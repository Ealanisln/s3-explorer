// MCP tool handlers against the real Express app.
//
// The app is booted in-process and bound to an ephemeral port; the MCP tool
// handlers then talk to it over real HTTP (Bearer PAT + x-s3-* headers),
// exactly as the stdio server would — only the stdio transport is skipped.
//
// NOTE: failed token presentations are rate limited per IP (10 / 15 min), and
// every request here comes from 127.0.0.1 — keep bad-token cases to a minimum
// and LAST in the file.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  ListBucketsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { buildTestApp } from '../../fixtures/app';
import { loginAsAdmin } from '../../fixtures/users';
import { setupS3Mock, type S3MockClient } from '../../fixtures/s3-mock';
import { S3xClient } from '../../../src/mcp/client';
import { buildTools, SEARCH_RESULT_CAP, type McpToolset } from '../../../src/mcp/tools';
import { DEFAULT_MAX_UPLOAD_BYTES } from '../../../src/mcp/config';

const app = buildTestApp();
let server: Server;
let baseUrl: string;
let s3: S3MockClient;
let readTools: McpToolset;
let writeTools: McpToolset;
let tmpDir: string;

function clientFor(token: string): S3xClient {
  return new S3xClient({
    baseUrl,
    apiToken: token,
    s3: {
      endpoint: 'https://test-minio.local',
      region: 'us-east-1',
      accessKey: 'test-access-key',
      secretKey: 'test-secret-key-value',
      pathStyle: 'true',
    },
  });
}

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const cookie = (await loginAsAdmin(app)).cookie;
  const read = await request(app)
    .post('/auth/tokens').set('Cookie', cookie).send({ name: 'mcp-lector', scope: 'read' });
  const write = await request(app)
    .post('/auth/tokens').set('Cookie', cookie).send({ name: 'mcp-escritor', scope: 'write' });

  readTools = buildTools(clientFor(read.body.token), DEFAULT_MAX_UPLOAD_BYTES);
  writeTools = buildTools(clientFor(write.body.token), DEFAULT_MAX_UPLOAD_BYTES);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3x-mcp-test-'));
});

afterAll(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  s3 = setupS3Mock();
});

describe('list_buckets', () => {
  it('returns bucket names and creation dates', async () => {
    s3.on(ListBucketsCommand).resolves({
      Buckets: [
        { Name: 'alfa', CreationDate: new Date('2026-01-01') },
        { Name: 'beta' },
      ],
    });
    const out = await readTools.list_buckets.handler({}) as { buckets: Array<{ name?: string }> };
    expect(out.buckets.map((b) => b.name)).toEqual(['alfa', 'beta']);
  });
});

describe('browse', () => {
  it('lists objects and common prefixes under a prefix', async () => {
    s3.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: 'reports/q1.pdf', Size: 100, LastModified: new Date('2026-02-01') }],
      CommonPrefixes: [{ Prefix: 'reports/2026/' }],
      IsTruncated: false,
    });
    const out = await readTools.browse.handler({ bucket: 'b', prefix: 'reports/' }) as {
      prefixes: string[];
      objects: Array<{ key: string; size: number }>;
      truncated: boolean;
    };
    expect(out.prefixes).toEqual(['reports/2026/']);
    expect(out.objects).toEqual([
      { key: 'reports/q1.pdf', size: 100, lastModified: '2026-02-01T00:00:00.000Z' },
    ]);
    expect(out.truncated).toBe(false);

    const input = s3.commandCalls(ListObjectsV2Command)[0].args[0].input;
    expect(input).toMatchObject({ Bucket: 'b', Prefix: 'reports/', Delimiter: '/' });
  });
});

describe('search_files', () => {
  it('aggregates the NDJSON stream into bounded results (files + folders)', async () => {
    s3.on(ListObjectsV2Command).callsFake((input: { Prefix?: string; Delimiter?: string }) => {
      if (input.Delimiter === '/') {
        if (input.Prefix === '') {
          return { Contents: [], CommonPrefixes: [{ Prefix: 'match_folder/' }], IsTruncated: false };
        }
        return { Contents: [], CommonPrefixes: [], IsTruncated: false };
      }
      return {
        Contents: [
          { Key: 'docs/match-1.txt', Size: 1, LastModified: new Date('2026-01-01') },
          { Key: 'docs/other.bin', Size: 2 },
        ],
        IsTruncated: false,
      };
    });
    const out = await readTools.search_files.handler({ bucket: 'b', query: 'match' });
    expect(out.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'file', key: 'docs/match-1.txt', size: 1 }),
      expect.objectContaining({ type: 'folder', key: 'match_folder/' }),
    ]));
    expect(out.results.length).toBeLessThanOrEqual(SEARCH_RESULT_CAP);
    expect(out.truncated).toBe(false);
    expect(out.scanned).toBe(2);
  });

  it('marks truncation when the server hits the result cap', async () => {
    s3.on(ListObjectsV2Command).callsFake((input: { Delimiter?: string }) => {
      if (input.Delimiter === '/') return { Contents: [], CommonPrefixes: [], IsTruncated: false };
      return {
        Contents: Array.from({ length: SEARCH_RESULT_CAP + 50 }, (_, i) => ({ Key: `hit-${i}.txt`, Size: 1 })),
        IsTruncated: false,
      };
    });
    const out = await readTools.search_files.handler({ bucket: 'b', query: 'hit-' });
    expect(out.results.length).toBeLessThanOrEqual(SEARCH_RESULT_CAP);
    expect(out.truncated).toBe(true);
  });
});

describe('presign_url', () => {
  it('returns a temporary GET URL with the effective TTL', async () => {
    const out = await readTools.presign_url.handler({
      bucket: 'b', key: 'reports/q1.pdf', expiresSeconds: 3600,
    }) as { url: string; expiresSeconds: number; capped: boolean };
    expect(out.url).toContain('reports/q1.pdf');
    expect(out.url).toContain('X-Amz-Signature=');
    expect(out.expiresSeconds).toBe(3600);
    expect(out.capped).toBe(false);
  });
});

describe('upload_file', () => {
  it('uploads a local file under the requested key (write token)', async () => {
    s3.on(PutObjectCommand).resolves({ ETag: '"abc"' });
    const localPath = path.join(tmpDir, 'informe.txt');
    fs.writeFileSync(localPath, 'contenido de prueba');

    const out = await writeTools.upload_file.handler({
      bucket: 'b', key: 'reports/informe.txt', localPath,
    }) as { ok: boolean; key: string; size: number };
    expect(out.ok).toBe(true);
    expect(out.key).toBe('reports/informe.txt');
    expect(out.size).toBe(19);

    const input = s3.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(input).toMatchObject({
      Bucket: 'b',
      Key: 'reports/informe.txt',
      ContentType: 'text/plain',
    });
  });

  it('rejects a file that exceeds the local size guard without calling the API', async () => {
    const tinyTools = buildTools(clientFor('s3x_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 4);
    const localPath = path.join(tmpDir, 'grande.bin');
    fs.writeFileSync(localPath, 'more than four bytes');
    await expect(tinyTools.upload_file.handler({ bucket: 'b', key: 'grande.bin', localPath }))
      .rejects.toThrow(/S3X_MAX_UPLOAD_BYTES/);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('fails with a clear message when the local file does not exist', async () => {
    await expect(writeTools.upload_file.handler({
      bucket: 'b', key: 'x.txt', localPath: path.join(tmpDir, 'no-existe.txt'),
    })).rejects.toThrow(/Local file not found/);
  });

  it('read-scope token gets a clear write-scope error (403 TOKEN_SCOPE)', async () => {
    s3.on(PutObjectCommand).resolves({});
    const localPath = path.join(tmpDir, 'lector.txt');
    fs.writeFileSync(localPath, 'x');
    await expect(readTools.upload_file.handler({ bucket: 'b', key: 'lector.txt', localPath }))
      .rejects.toThrow(/write.*scope|scope.*write/i);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
});

describe('delete_object', () => {
  it('default mode issues a single delete (delete marker on versioned buckets)', async () => {
    s3.on(DeleteObjectCommand).resolves({});
    const out = await writeTools.delete_object.handler({ bucket: 'b', key: 'old/file.txt' }) as {
      ok: boolean; mode: string;
    };
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('delete-marker');
    const input = s3.commandCalls(DeleteObjectCommand)[0].args[0].input;
    expect(input).toMatchObject({ Bucket: 'b', Key: 'old/file.txt' });
    expect(input.VersionId).toBeUndefined();
  });

  it('purge=true removes every version and delete marker of the key', async () => {
    s3.on(ListObjectVersionsCommand).resolves({
      Versions: [
        { Key: 'old/file.txt', VersionId: 'v2', IsLatest: false, LastModified: new Date('2026-01-02') },
        { Key: 'old/file.txt', VersionId: 'v1', IsLatest: false, LastModified: new Date('2026-01-01') },
      ],
      DeleteMarkers: [
        { Key: 'old/file.txt', VersionId: 'm1', IsLatest: true, LastModified: new Date('2026-01-03') },
      ],
    });
    s3.on(DeleteObjectsCommand).resolves({
      Deleted: [{ Key: 'old/file.txt', VersionId: 'm1' }, { Key: 'old/file.txt', VersionId: 'v2' }, { Key: 'old/file.txt', VersionId: 'v1' }],
      Errors: [],
    });
    const out = await writeTools.delete_object.handler({
      bucket: 'b', key: 'old/file.txt', purge: true,
    }) as { ok: boolean; mode: string; purgedVersions: number };
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('purge');
    expect(out.purgedVersions).toBe(3);

    const batch = s3.commandCalls(DeleteObjectsCommand)[0].args[0].input;
    const versionIds = (batch.Delete?.Objects ?? []).map((o) => o.VersionId).sort();
    expect(versionIds).toEqual(['m1', 'v1', 'v2']);
  });

  it('purge on an unversioned bucket falls back to a plain delete', async () => {
    s3.on(ListObjectVersionsCommand).resolves({ Versions: [], DeleteMarkers: [] });
    s3.on(DeleteObjectCommand).resolves({});
    const out = await writeTools.delete_object.handler({
      bucket: 'b', key: 'plain.txt', purge: true,
    }) as { ok: boolean; mode: string };
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('purge');
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  it('read-scope token cannot delete (clear scope error, no SDK call)', async () => {
    s3.on(DeleteObjectCommand).resolves({});
    await expect(readTools.delete_object.handler({ bucket: 'b', key: 'x.txt' }))
      .rejects.toThrow(/write.*scope|scope.*write/i);
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });
});

// LAST — burns one unit of the shared per-IP token-failure budget (10 / 15 min).
describe('bad token', () => {
  it('an unknown token surfaces the invalid/revoked/expired message', async () => {
    const badTools = buildTools(clientFor('s3x_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), DEFAULT_MAX_UPLOAD_BYTES);
    await expect(badTools.list_buckets.handler({}))
      .rejects.toThrow(/invalid, revoked, or expired/);
  });
});
