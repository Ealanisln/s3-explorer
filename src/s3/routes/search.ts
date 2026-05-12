import { Router, type Request, type Response } from 'express';
import { type S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { wrap, newErrorId } from '../../http/errors';
import { q } from '../../http/query';
import { sanitizeError } from '../errors';

type ClientFactory = (req: Request) => S3Client;

export function searchRouter(buildClient: ClientFactory): Router {
  const r = Router();

  // GET /api/search-stream/:bucket — NDJSON streaming substring search.
  // Doesn't use wrap() because the response is already opened with text/ndjson
  // headers before the SDK call; errors emit an `{t:"error"}` frame inline.
  r.get('/search-stream/:bucket', async (req: Request, res: Response): Promise<void> => {
    let s3: S3Client;
    try {
      s3 = buildClient(req);
    } catch (e) {
      // SEC2-02: don't leak SDK error text — same sanitizer as every other endpoint.
      // Generate an errorId so the user can copy it from the toast and admin
      // can grep server logs.
      const errorId = newErrorId();
      const err = e as { name?: string; message?: string };
      console.error('[search-stream-error]', {
        errorId,
        user: req.user?.username,
        bucket: req.params.bucket,
        name: err.name,
        message: err.message,
      });
      const { status, body } = sanitizeError(e as Parameters<typeof sanitizeError>[0], errorId);
      res.status(status).json(body);
      return;
    }
    const query = q(req, 'q').toLowerCase().trim();
    const startPrefix = q(req, 'prefix');
    const maxResults = Math.min(parseInt(q(req, 'limit', '2000'), 10), 10000);

    if (!query) { res.status(400).json({ message: 'missing q' }); return; }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (e: Record<string, unknown>): void => {
      try { res.write(JSON.stringify(e) + '\n'); } catch { /* client disconnected */ }
    };

    let aborted = false;
    req.on('close', () => { aborted = true; });

    let token: string | undefined;
    let scanned = 0;
    let hits = 0;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (aborted) break;
        const out = await s3.send(new ListObjectsV2Command({
          Bucket: req.params.bucket,
          Prefix: startPrefix,
          ContinuationToken: token,
          MaxKeys: 1000,
        }));
        const items = out.Contents || [];
        scanned += items.length;

        for (const o of items) {
          if (aborted) break;
          if (o.Key && o.Key.toLowerCase().includes(query)) {
            send({ t: 'hit', key: o.Key, size: o.Size, modified: o.LastModified, etag: o.ETag });
            hits++;
            if (hits >= maxResults) break;
          }
        }

        send({ t: 'progress', scanned });

        if (hits >= maxResults) { send({ t: 'done', scanned, hits, reason: 'limit' }); break; }
        if (!out.IsTruncated) { send({ t: 'done', scanned, hits, reason: 'complete' }); break; }
        token = out.NextContinuationToken;
      }
    } catch (e) {
      const errorId = newErrorId();
      const err = e as { name?: string; message?: string };
      console.error('[search-stream-error]', {
        errorId,
        user: req.user?.username,
        bucket: req.params.bucket,
        name: err.name,
        message: err.message,
      });
      const { body } = sanitizeError(e as Parameters<typeof sanitizeError>[0], errorId);
      send({ t: 'error', ...body });
    }
    res.end();
  });

  // GET /api/search/:bucket — bounded, non-streaming JSON search.
  r.get('/search/:bucket', wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const query = q(req, 'q').toLowerCase().trim();
    const prefix = q(req, 'prefix');
    const maxResults = Math.min(parseInt(q(req, 'limit', '500'), 10), 2000);
    const maxScan = Math.min(parseInt(q(req, 'scan', '50000'), 10), 200000);

    if (!query) { res.json({ results: [], scanned: 0, truncated: false }); return; }

    const results: Array<{ Key: string; Size?: number; LastModified?: Date; ETag?: string }> = [];
    let token: string | undefined;
    let scanned = 0;
    let truncated = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const out = await s3.send(new ListObjectsV2Command({
        Bucket: req.params.bucket,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      }));
      const items = out.Contents || [];
      scanned += items.length;
      for (const o of items) {
        if (!o.Key) continue;
        const name = (o.Key.split('/').pop() || '').toLowerCase();
        if (name.includes(query) || o.Key.toLowerCase().includes(query)) {
          results.push({ Key: o.Key, Size: o.Size, LastModified: o.LastModified, ETag: o.ETag });
          if (results.length >= maxResults) break;
        }
      }
      if (results.length >= maxResults) { truncated = true; break; }
      if (!out.IsTruncated || scanned >= maxScan) {
        if (out.IsTruncated) truncated = true;
        break;
      }
      token = out.NextContinuationToken;
    }
    res.json({ results, scanned, truncated });
  }));

  return r;
}
