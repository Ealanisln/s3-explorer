import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Readable } from 'stream';
import request from 'supertest';
import { GetObjectCommand } from '@aws-sdk/client-s3';
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

function streamOf(body: string): Readable {
  return Readable.from([Buffer.from(body, 'utf8')]);
}

describe('GET /api/object/:bucket/download', () => {
  it('streams the body with the SDK-declared content type', async () => {
    s3.on(GetObjectCommand).resolves({
      ContentType: 'image/png',
      ContentLength: 5,
      Body: streamOf('hello'),
    } as never);
    const res = await request(app)
      .get('/api/object/b/download?key=file.png')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect((res.body as Buffer).toString('utf8')).toBe('hello');
  });

  it('returns 400 when key is missing', async () => {
    const res = await request(app)
      .get('/api/object/b/download')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(400);
  });

  describe('inline preview CSP defense (CD-SEC-002)', () => {
    // Stored-XSS prevention: when the SPA opens an object preview, dangerous
    // script-bearing content types are force-rewritten to text/plain so the
    // browser does not execute them in our origin.
    const cases: Array<[string, string]> = [
      ['text/html', 'text/plain; charset=utf-8'],
      ['application/xhtml+xml', 'text/plain; charset=utf-8'],
      ['image/svg+xml', 'text/plain; charset=utf-8'],
      ['application/xml', 'text/plain; charset=utf-8'],
      ['text/xml', 'text/plain; charset=utf-8'],
      ['application/javascript', 'text/plain; charset=utf-8'],
      ['text/javascript', 'text/plain; charset=utf-8'],
      ['application/ecmascript', 'text/plain; charset=utf-8'],
    ];

    for (const [s3Type, expected] of cases) {
      it(`rewrites ${s3Type} to text/plain on inline=1`, async () => {
        s3.on(GetObjectCommand).resolves({
          ContentType: s3Type,
          ContentLength: 5,
          Body: streamOf('hello'),
        } as never);
        const res = await request(app)
          .get('/api/object/b/download?key=x.svg&inline=1')
          .set('Cookie', cookie)
          .set(TEST_S3_HEADERS);
        expect(res.headers['content-type']).toBe(expected);
        expect(res.headers['content-security-policy']).toContain("default-src 'none'");
        expect(res.headers['content-disposition']).toMatch(/^inline/);
      });
    }

    it('does NOT rewrite safe types (image/png) on inline=1', async () => {
      s3.on(GetObjectCommand).resolves({
        ContentType: 'image/png',
        ContentLength: 5,
        Body: streamOf('hello'),
      } as never);
      const res = await request(app)
        .get('/api/object/b/download?key=ok.png&inline=1')
        .set('Cookie', cookie)
        .set(TEST_S3_HEADERS);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    });

    it('falls back to mime-by-extension when S3 returns binary/octet-stream', async () => {
      s3.on(GetObjectCommand).resolves({
        ContentType: 'binary/octet-stream',
        ContentLength: 5,
        Body: streamOf('hello'),
      } as never);
      const res = await request(app)
        .get('/api/object/b/download?key=report.pdf')
        .set('Cookie', cookie)
        .set(TEST_S3_HEADERS);
      expect(res.headers['content-type']).toBe('application/pdf');
    });
  });
});

describe('GET /api/object/:bucket/presign', () => {
  it('returns a signed URL with the requested expires (within bounds)', async () => {
    const res = await request(app)
      .get('/api/object/b/presign?key=file.txt&expires=600')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.expires).toBe(600);
    expect(res.body.capped).toBe(false);
    expect(res.body.url).toMatch(/^https?:\/\//);
    expect(res.body.url).toContain('X-Amz-Expires=600');
  });

  it('caps to MAX_PRESIGN_SECONDS (24h) when requested longer', async () => {
    const res = await request(app)
      .get('/api/object/b/presign?key=file.txt&expires=99999999')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.body.expires).toBe(86400);
    expect(res.body.capped).toBe(true);
  });

  it('clamps to minimum 60s', async () => {
    const res = await request(app)
      .get('/api/object/b/presign?key=file.txt&expires=5')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.body.expires).toBe(60);
    expect(res.body.capped).toBe(true);
  });

  it('uses DEFAULT_PRESIGN_SECONDS (300) when expires omitted', async () => {
    const res = await request(app)
      .get('/api/object/b/presign?key=file.txt')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.body.expires).toBe(300);
  });

  it('returns 400 when key is missing', async () => {
    const res = await request(app)
      .get('/api/object/b/presign')
      .set('Cookie', cookie)
      .set(TEST_S3_HEADERS);
    expect(res.status).toBe(400);
  });
});
