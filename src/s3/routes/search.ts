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

    let scanned = 0;
    let hits = 0;

    // Cap total hits across BOTH walks. Folder hits and file hits each
    // count towards the same limit so a query with thousands of folder
    // name matches doesn't push past it.
    const tryEmit = (frame: Record<string, unknown>): void => {
      if (aborted || hits >= maxResults) return;
      send(frame);
      hits++;
      if (hits >= maxResults) aborted = true;
    };

    // ── File walk ─────────────────────────────────────────────────────
    // Existing recursive ListObjectsV2 (no Delimiter), scoped to startPrefix.
    // Emits 'hit' frames for keys whose full path contains the query.
    const fileWalk = (async (): Promise<void> => {
      let token: string | undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (aborted) return;
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
            tryEmit({ t: 'hit', key: o.Key, size: o.Size, modified: o.LastModified, etag: o.ETag });
          }
        }
        send({ t: 'progress', scanned });
        if (aborted) return;
        if (!out.IsTruncated) return;
        token = out.NextContinuationToken;
      }
    })();

    // ── Folder walk ───────────────────────────────────────────────────
    // BFS through CommonPrefixes under startPrefix, emitting 'folder-hit'
    // for folders whose LAST path segment (folder name) matches the query.
    // Catches folders that have no files containing the query — like the
    // user's "92780_solicitudes/" case where the folder name itself is the
    // signal, not the file content.
    const folderWalk = (async (): Promise<void> => {
      const queue: string[] = [startPrefix];
      while (queue.length) {
        if (aborted) return;
        const cur = queue.shift()!;
        let token: string | undefined;
        do {
          if (aborted) return;
          const out = await s3.send(new ListObjectsV2Command({
            Bucket: req.params.bucket,
            Prefix: cur,
            Delimiter: '/',
            ContinuationToken: token,
            MaxKeys: 1000,
          }));
          for (const cp of out.CommonPrefixes ?? []) {
            if (!cp.Prefix || aborted) continue;
            queue.push(cp.Prefix);
            // Last segment of the prefix is the folder name. E.g.
            // "foo/bar_92780/" → name = "bar_92780".
            const name = cp.Prefix.replace(/\/$/, '').split('/').pop() || '';
            if (name.toLowerCase().includes(query)) {
              tryEmit({ t: 'folder-hit', key: cp.Prefix });
            }
          }
          token = out.NextContinuationToken;
        } while (token);
      }
    })();

    try {
      await Promise.all([fileWalk, folderWalk]);
      send({ t: 'done', scanned, hits, reason: hits >= maxResults ? 'limit' : 'complete' });
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
