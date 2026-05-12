import { Router, type Request, type Response } from 'express';
import { type S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as mime from 'mime-types';
import type { Readable } from 'stream';
import { wrap } from '../../http/errors';
import { q } from '../../http/query';

type ClientFactory = (req: Request) => S3Client;

const MAX_PRESIGN_SECONDS = parseInt(process.env.MAX_PRESIGN_SECONDS || '86400', 10);     // 24h
const DEFAULT_PRESIGN_SECONDS = parseInt(process.env.DEFAULT_PRESIGN_SECONDS || '300', 10); // 5 min

// Script-bearing types that we refuse to render inline in our own origin —
// they're rewritten to `text/plain` to defeat stored-XSS via inline preview.
const DANGEROUS_INLINE_TYPES = /^(text\/html|application\/xhtml|image\/svg|application\/xml|text\/xml|application\/javascript|text\/javascript|application\/ecmascript)/i;

// Generic / unknown content-types that S3 may return when the uploader didn't
// set one. Trust the file extension via mime-types instead, otherwise PDFs/
// images would force-download instead of rendering inline.
const GENERIC_CONTENT_TYPES = /^(binary|application)\/octet-stream$/i;

export function presignRouter(buildClient: ClientFactory): Router {
  const r = Router();

  // GET /api/object/:bucket/download — streams the object body. If inline=1,
  // adds a strict CSP to the response and force-rewrites dangerous types to
  // text/plain. This route bypasses the global SPA CSP (set in server-wide
  // middleware) because it doesn't serve SPA pages.
  r.get('/object/:bucket/download', wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const key = q(req, 'key');
    const versionId = q(req, 'versionId') || undefined;
    const inline = q(req, 'inline') === '1';
    if (!key) { res.status(400).json({ message: 'missing key' }); return; }
    const out = await s3.send(new GetObjectCommand({
      Bucket: req.params.bucket,
      Key: key,
      VersionId: versionId,
    }));
    const filename = key.split('/').pop() || key;

    // Resolve content-type: prefer S3's declared type UNLESS it's generic
    // (binary/octet-stream), in which case fall back to mime lookup by ext.
    const s3Type = out.ContentType;
    let contentType: string;
    if (!s3Type || GENERIC_CONTENT_TYPES.test(s3Type)) {
      contentType = (mime.lookup(filename) || s3Type || 'application/octet-stream') as string;
    } else {
      contentType = s3Type;
    }

    // CD-SEC-002: defense against stored-XSS via inline preview.
    if (inline && DANGEROUS_INLINE_TYPES.test(contentType)) {
      contentType = 'text/plain; charset=utf-8';
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Scoped CSP for inline previews. No `sandbox` directive — breaks Chrome's
    // built-in PDF viewer. With nosniff + the dangerous-type flip above, the
    // XSS surface is closed.
    if (inline) {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; object-src 'self'",
      );
    }
    if (out.ContentLength) res.setHeader('Content-Length', String(out.ContentLength));
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    if (!out.Body) { res.end(); return; }
    (out.Body as Readable).pipe(res);
  }));

  r.get('/object/:bucket/presign', wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const key = q(req, 'key');
    const versionId = q(req, 'versionId') || undefined;
    if (!key) { res.status(400).json({ message: 'missing key' }); return; }
    const requested = parseInt(q(req, 'expires', String(DEFAULT_PRESIGN_SECONDS)), 10);
    const expires = Math.max(60, Math.min(requested, MAX_PRESIGN_SECONDS));
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: req.params.bucket, Key: key, VersionId: versionId }),
      { expiresIn: expires },
    );
    res.json({ url, expires, capped: expires !== requested });
  }));

  return r;
}
