import { Router, type Request, type Response } from 'express';
import type { S3Client } from '@aws-sdk/client-s3';
import { wrap } from '../http/errors';
import { q } from '../http/query';
import { getConnectionId } from '../s3/connection-ref';
import {
  rebuildBucketIndex,
  searchIndex,
  getIndexStatus,
  deleteBucketIndex,
} from './indexer';

type ClientFactory = (req: Request) => S3Client;

export function indexRouter(buildClient: ClientFactory): Router {
  const r = Router();

  // POST /api/index/:bucket/rebuild
  // Triggered by the SPA's "Reindexar" button. The user's session creds
  // (already in x-s3-* headers) drive the ListObjectsV2 pagination; rows go
  // into bucket_index scoped by (username, connection_id, bucket).
  r.post('/index/:bucket/rebuild', wrap(async (req: Request, res: Response) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return; // 400 already sent
    const s3 = buildClient(req);
    const result = await rebuildBucketIndex(s3, {
      username: req.user!.username,
      connectionId,
      bucket: req.params.bucket,
    });
    res.json(result);
  }));

  // GET /api/index/:bucket/search?q=...&limit=500&prefix=foo/bar/
  // FTS5 substring/prefix search. Returns up to `limit` hits ranked by FTS5
  // bm25. No SDK call — pure DB read.
  //
  // `prefix` (optional) scopes the search to descendants of that key prefix
  // — used by the SPA so a search from `solicitud/originales/` only returns
  // hits under that path, not the whole bucket.
  r.get('/index/:bucket/search', wrap(async (req: Request, res: Response) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    const query = q(req, 'q').trim();
    if (!query) { res.json({ results: [] }); return; }
    const limit = Math.max(1, Math.min(parseInt(q(req, 'limit', '500'), 10), 5000));
    const prefix = q(req, 'prefix');
    const results = searchIndex({
      username: req.user!.username,
      connectionId,
      bucket: req.params.bucket,
    }, query, limit, prefix || undefined);
    res.json({ results });
  }));

  // GET /api/index/:bucket/status
  // Returns { last_indexed_at, object_count, last_error, stale } so the SPA
  // can decide between FTS5 search and the legacy /api/search-stream fallback.
  r.get('/index/:bucket/status', wrap(async (req: Request, res: Response) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    const status = getIndexStatus({
      username: req.user!.username,
      connectionId,
      bucket: req.params.bucket,
    });
    res.json(status);
  }));

  // DELETE /api/index/:bucket
  // Called when the SPA deletes a connection or bucket. Idempotent.
  r.delete('/index/:bucket', wrap(async (req: Request, res: Response) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    const result = deleteBucketIndex({
      username: req.user!.username,
      connectionId,
      bucket: req.params.bucket,
    });
    res.json(result);
  }));

  return r;
}
