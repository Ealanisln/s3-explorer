import { Router, type Request, type Response } from 'express';
import {
  type S3Client,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { wrap } from '../../http/errors';
import { validateBody } from '../../http/validate';
import {
  folderSchema,
  folderDeleteSchema,
  restoreSchema,
  deleteObjectSchema,
  deleteBatchSchema,
  copySchema,
  renameSchema,
  existsSchema,
} from '../schemas';
import { newErrorId } from '../../http/errors';
import { sanitizeError } from '../errors';
import { audit } from '../../auth/audit';

type ClientFactory = (req: Request) => S3Client;

// Read a string-shaped query param without committing to Express's ParsedQs union.
function q(req: Request, name: string, fallback = ''): string {
  const v = req.query[name];
  return typeof v === 'string' ? v : fallback;
}

interface ListedObject {
  Key: string;
  Size: number;
  LastModified?: Date;
  ETag?: string;
  StorageClass?: string;
  IsDeleteMarker: boolean;
  VersionId?: string;
}

function buildCopySource(bucket: string, key: string, versionId?: string): string {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  let src = `/${encodeURIComponent(bucket)}/${encodedKey}`;
  if (versionId) src += `?versionId=${encodeURIComponent(versionId)}`;
  return src;
}

export function objectsRouter(buildClient: ClientFactory): Router {
  const r = Router();

  // GET /api/objects/:bucket — folder listing. When showDeleted=1, uses
  // ListObjectVersions and dedupes by latest version per key (so delete markers
  // surface as tombstones in the same list).
  r.get('/objects/:bucket', wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const prefix = q(req, 'prefix', '');
    const showDeleted = q(req, 'showDeleted') === '1';
    const PAGE_CAP = parseInt(q(req, 'pageCap', '50'), 10);          // up to 50 pages × 1000 = 50k entries
    const MAX_ENTRIES = parseInt(q(req, 'max', '50000'), 10);

    if (showDeleted) {
      const prefixesSet = new Set<string>();
      const byKey = new Map<string, ListedObject>();
      let keyMarker: string | undefined;
      let versionMarker: string | undefined;
      let pages = 0;
      let truncated = false;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const out = await s3.send(new ListObjectVersionsCommand({
          Bucket: req.params.bucket,
          Prefix: prefix,
          Delimiter: '/',
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
          MaxKeys: 1000,
        }));
        for (const cp of out.CommonPrefixes || []) if (cp.Prefix) prefixesSet.add(cp.Prefix);
        for (const v of out.Versions || []) {
          if (!v.Key || v.Key === prefix) continue;
          const cur = byKey.get(v.Key);
          if (!cur || (v.LastModified && cur.LastModified && v.LastModified > cur.LastModified)) {
            byKey.set(v.Key, {
              Key: v.Key,
              Size: v.Size ?? 0,
              LastModified: v.LastModified,
              ETag: v.ETag,
              VersionId: v.VersionId,
              IsDeleteMarker: false,
            });
          }
        }
        for (const m of out.DeleteMarkers || []) {
          if (!m.Key || m.Key === prefix) continue;
          const cur = byKey.get(m.Key);
          if (!cur || (m.LastModified && cur.LastModified && m.LastModified > cur.LastModified)) {
            byKey.set(m.Key, {
              Key: m.Key,
              Size: 0,
              LastModified: m.LastModified,
              VersionId: m.VersionId,
              IsDeleteMarker: true,
            });
          }
        }
        pages++;
        if (!out.IsTruncated) break;
        if (pages >= PAGE_CAP || prefixesSet.size + byKey.size >= MAX_ENTRIES) { truncated = true; break; }
        keyMarker = out.NextKeyMarker;
        versionMarker = out.NextVersionIdMarker;
      }

      // Second pass: ListObjectsV2 only returns LIVE keys (delete markers are
      // hidden by S3). The CommonPrefixes it returns are the subfolders that
      // still have at least one live object inside. Subtract those from the
      // versions-listing prefixes and we get the set of "deleted folders" —
      // subfolders that exist as paths but whose every key is a delete-marker
      // tombstone. The frontend will style those rows the same as deleted
      // files (DELETED badge + strikethrough).
      const livePrefixes = new Set<string>();
      let v2Token: string | undefined;
      let v2Pages = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const v2 = await s3.send(new ListObjectsV2Command({
          Bucket: req.params.bucket,
          Prefix: prefix,
          Delimiter: '/',
          ContinuationToken: v2Token,
          MaxKeys: 1000,
        }));
        for (const cp of v2.CommonPrefixes || []) {
          if (cp.Prefix) livePrefixes.add(cp.Prefix);
        }
        v2Pages++;
        if (!v2.IsTruncated) break;
        if (v2Pages >= PAGE_CAP) break;
        v2Token = v2.NextContinuationToken;
      }
      const deletedPrefixes = [...prefixesSet].filter((p) => !livePrefixes.has(p));

      res.json({
        prefixes: [...prefixesSet],
        deletedPrefixes,
        objects: [...byKey.values()],
        nextToken: null,
        isTruncated: truncated,
        pages,
      });
      return;
    }

    const prefixesSet = new Set<string>();
    const objects: ListedObject[] = [];
    let token: string | undefined;
    let pages = 0;
    let truncated = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const out = await s3.send(new ListObjectsV2Command({
        Bucket: req.params.bucket,
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: token,
        MaxKeys: 1000,
      }));
      for (const cp of out.CommonPrefixes || []) if (cp.Prefix) prefixesSet.add(cp.Prefix);
      for (const o of out.Contents || []) {
        if (!o.Key || o.Key === prefix) continue;
        objects.push({
          Key: o.Key,
          Size: o.Size ?? 0,
          LastModified: o.LastModified,
          ETag: o.ETag,
          StorageClass: o.StorageClass,
          IsDeleteMarker: false,
        });
      }
      pages++;
      if (!out.IsTruncated) break;
      if (pages >= PAGE_CAP || prefixesSet.size + objects.length >= MAX_ENTRIES) { truncated = true; break; }
      token = out.NextContinuationToken;
    }

    res.json({
      prefixes: [...prefixesSet],
      objects,
      nextToken: null,
      isTruncated: truncated,
      pages,
    });
  }));

  // POST /api/object/:bucket/restore — for delete-marker rows. Deletes the
  // marker version, exposing the prior content version as the "latest" again.
  r.post('/object/:bucket/restore', validateBody(restoreSchema), wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const { key, versionId } = req.body as { key: string; versionId?: string };
    await s3.send(new DeleteObjectCommand({ Bucket: req.params.bucket, Key: key, VersionId: versionId }));
    res.json({ ok: true });
  }));

  r.get('/object/:bucket/head', wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const key = q(req, 'key');
    const versionId = q(req, 'versionId') || undefined;
    if (!key) { res.status(400).json({ message: 'missing key' }); return; }
    const out = await s3.send(new HeadObjectCommand({ Bucket: req.params.bucket, Key: key, VersionId: versionId }));
    res.json({
      ContentType: out.ContentType,
      ContentLength: out.ContentLength,
      LastModified: out.LastModified,
      ETag: out.ETag,
      VersionId: out.VersionId,
      Metadata: out.Metadata,
    });
  }));

  r.get('/object/:bucket/versions', wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const key = q(req, 'key');
    if (!key) { res.status(400).json({ message: 'missing key' }); return; }
    const out = await s3.send(new ListObjectVersionsCommand({
      Bucket: req.params.bucket,
      Prefix: key,
    }));
    const versions = (out.Versions || []).filter((v) => v.Key === key).map((v) => ({
      VersionId: v.VersionId,
      IsLatest: v.IsLatest,
      LastModified: v.LastModified,
      Size: v.Size,
      ETag: v.ETag,
      Type: 'version' as const,
    }));
    const markers = (out.DeleteMarkers || []).filter((v) => v.Key === key).map((v) => ({
      VersionId: v.VersionId,
      IsLatest: v.IsLatest,
      LastModified: v.LastModified,
      Type: 'delete-marker' as const,
    }));
    const all = [...versions, ...markers].sort((a, b) => {
      const aT = a.LastModified ? a.LastModified.getTime() : 0;
      const bT = b.LastModified ? b.LastModified.getTime() : 0;
      return bT - aT;
    });
    res.json({ versions: all });
  }));

  r.post('/object/:bucket/folder', validateBody(folderSchema), wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const { prefix, name } = req.body as { prefix?: string; name: string };
    const safePrefix = typeof prefix === 'string' ? prefix : '';
    const key = safePrefix + name.replace(/\/$/, '') + '/';
    await s3.send(new PutObjectCommand({ Bucket: req.params.bucket, Key: key, Body: '' }));
    res.json({ ok: true, key });
  }));

  // GET /api/object/:bucket/folder/count?prefix=foo/bar/
  // Quick size-of-folder probe used by the delete-confirm dialog. Capped at
  // 5 pages (≤5000 keys) so a huge folder doesn't make the user wait for a
  // full enumeration just to render the confirm screen. The flag
  // `truncated` lets the UI render "≥5000 archivos" when the cap was hit.
  r.get('/object/:bucket/folder/count', wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const prefix = q(req, 'prefix');
    if (!prefix || !prefix.endsWith('/')) {
      res.status(400).json({ error: 'InvalidPrefix', message: 'prefix debe terminar en /' });
      return;
    }
    let count = 0;
    let totalBytes = 0;
    let token: string | undefined;
    let page = 0;
    const MAX_PAGES = 5;
    do {
      const lr = await s3.send(new ListObjectsV2Command({
        Bucket: req.params.bucket,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      }));
      for (const obj of lr.Contents ?? []) {
        count++;
        totalBytes += obj.Size ?? 0;
      }
      token = lr.NextContinuationToken;
      page++;
    } while (token && page < MAX_PAGES);
    res.json({ count, totalBytes, truncated: !!token });
  }));

  // POST /api/object/:bucket/folder/delete — SSE-streamed recursive folder delete.
  //
  // Default behavior: walk ListObjectsV2 under `prefix` and delete each key in
  // batches of 1000 (the S3 DeleteObjects limit). On a versioned bucket this
  // creates a delete-marker per key — recoverable from the "Mostrar
  // eliminados" toggle.
  //
  // When body.purgeVersions === true, instead walks ListObjectVersions (both
  // versions and delete markers) and removes every record permanently. Useful
  // for actually freeing storage on a versioned bucket. Irreversible.
  r.post('/object/:bucket/folder/delete', validateBody(folderDeleteSchema), async (req: Request, res: Response): Promise<void> => {
    const { prefix, purgeVersions } = req.body as { prefix: string; purgeVersions?: boolean };
    if (!prefix.endsWith('/')) {
      res.status(400).json({ error: 'InvalidPrefix', message: 'prefix debe terminar en /' });
      return;
    }
    if (prefix === '/' || prefix.length === 0) {
      res.status(400).json({ error: 'InvalidPrefix', message: 'No se puede eliminar la raíz del bucket' });
      return;
    }

    let s3: S3Client;
    try {
      s3 = buildClient(req);
    } catch (e) {
      const errorId = newErrorId();
      const err = e as { name?: string; message?: string };
      console.error('[folder-delete-build]', { errorId, name: err.name, message: err.message });
      const { status, body } = sanitizeError(e as Parameters<typeof sanitizeError>[0], errorId);
      res.status(status).json(body);
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let lastEmit = Date.now();
    const send = (e: Record<string, unknown>): void => {
      try { res.write(`data: ${JSON.stringify(e)}\n\n`); lastEmit = Date.now(); }
      catch { /* client disconnected */ }
    };
    const keepalive = setInterval(() => {
      if (Date.now() - lastEmit < 30_000) return;
      try { res.write(`: keepalive ${Date.now()}\n\n`); } catch { /* ignore */ }
    }, 15_000);

    const abortCtl = new AbortController();
    let finished = false;
    res.on('close', () => { if (!finished) abortCtl.abort(); });

    audit('folder_delete_started', {
      username: req.user?.username,
      bucket: req.params.bucket,
      prefix,
      purgeVersions: !!purgeVersions,
    });

    let deleted = 0;
    let failed = 0;
    let scanned = 0;

    const flush = async (batch: { Key: string; VersionId?: string }[]): Promise<void> => {
      if (batch.length === 0) return;
      const r2 = await s3.send(new DeleteObjectsCommand({
        Bucket: req.params.bucket,
        Delete: { Objects: batch, Quiet: true },
      }));
      const okCount = batch.length - (r2.Errors?.length ?? 0);
      deleted += okCount;
      failed += r2.Errors?.length ?? 0;
      send({ t: 'progress', deleted, failed, scanned, currentKey: batch[batch.length - 1].Key });
    };

    try {
      if (purgeVersions) {
        let keyToken: string | undefined;
        let versionToken: string | undefined;
        do {
          if (abortCtl.signal.aborted) break;
          const lr = await s3.send(new ListObjectVersionsCommand({
            Bucket: req.params.bucket,
            Prefix: prefix,
            KeyMarker: keyToken,
            VersionIdMarker: versionToken,
            MaxKeys: 1000,
          }));
          const records: { Key: string; VersionId?: string }[] = [];
          for (const v of lr.Versions ?? []) {
            if (typeof v.Key === 'string') records.push({ Key: v.Key, VersionId: v.VersionId });
          }
          for (const m of lr.DeleteMarkers ?? []) {
            if (typeof m.Key === 'string') records.push({ Key: m.Key, VersionId: m.VersionId });
          }
          scanned += records.length;
          for (let i = 0; i < records.length; i += 1000) {
            if (abortCtl.signal.aborted) break;
            await flush(records.slice(i, i + 1000));
          }
          keyToken = lr.NextKeyMarker;
          versionToken = lr.NextVersionIdMarker;
        } while (keyToken || versionToken);
      } else {
        let batch: { Key: string }[] = [];
        let token: string | undefined;
        do {
          if (abortCtl.signal.aborted) break;
          const lr = await s3.send(new ListObjectsV2Command({
            Bucket: req.params.bucket,
            Prefix: prefix,
            ContinuationToken: token,
            MaxKeys: 1000,
          }));
          for (const obj of lr.Contents ?? []) {
            if (typeof obj.Key === 'string') {
              batch.push({ Key: obj.Key });
              scanned++;
              if (batch.length >= 1000) {
                await flush(batch);
                batch = [];
              }
            }
          }
          token = lr.NextContinuationToken;
        } while (token);
        if (!abortCtl.signal.aborted && batch.length > 0) {
          await flush(batch);
        }
      }
      send({ t: 'done', deleted, failed, scanned });
    } catch (e) {
      const errorId = newErrorId();
      const err = e as { name?: string; message?: string };
      console.error('[folder-delete]', {
        errorId, user: req.user?.username, prefix, name: err.name, message: err.message,
      });
      const { body } = sanitizeError(e as Parameters<typeof sanitizeError>[0], errorId);
      try { res.write(`data: ${JSON.stringify({ t: 'fatal', ...body })}\n\n`); } catch { /* ignore */ }
    } finally {
      clearInterval(keepalive);
      finished = true;
    }

    audit('folder_delete_finished', {
      username: req.user?.username,
      bucket: req.params.bucket,
      prefix,
      purgeVersions: !!purgeVersions,
      deleted,
      failed,
      scanned,
    });
    res.end();
  });

  r.delete('/object/:bucket', validateBody(deleteObjectSchema), wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const { key, versionId } = req.body as { key: string; versionId?: string };
    await s3.send(new DeleteObjectCommand({ Bucket: req.params.bucket, Key: key, VersionId: versionId }));
    res.json({ ok: true });
  }));

  r.post('/object/:bucket/delete-batch', validateBody(deleteBatchSchema), wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const { keys } = req.body as { keys: (string | { key: string; versionId?: string })[] };
    const out = await s3.send(new DeleteObjectsCommand({
      Bucket: req.params.bucket,
      Delete: {
        Objects: keys.map((k) => typeof k === 'string' ? { Key: k } : { Key: k.key, VersionId: k.versionId }),
      },
    }));
    res.json({ deleted: out.Deleted || [], errors: out.Errors || [] });
  }));

  r.post('/object/:bucket/copy', validateBody(copySchema), wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const { sourceKey, destKey, sourceVersionId } = req.body as {
      sourceKey: string; destKey: string; sourceVersionId?: string;
    };
    await s3.send(new CopyObjectCommand({
      Bucket: req.params.bucket,
      Key: destKey,
      CopySource: buildCopySource(req.params.bucket, sourceKey, sourceVersionId),
    }));
    res.json({ ok: true });
  }));

  r.post('/object/:bucket/rename', validateBody(renameSchema), wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const { sourceKey, destKey } = req.body as { sourceKey: string; destKey: string };
    await s3.send(new CopyObjectCommand({
      Bucket: req.params.bucket,
      Key: destKey,
      CopySource: buildCopySource(req.params.bucket, sourceKey),
    }));
    await s3.send(new DeleteObjectCommand({ Bucket: req.params.bucket, Key: sourceKey }));
    res.json({ ok: true });
  }));

  // POST /api/objects/:bucket/exists — pre-upload conflict check (JL's flow).
  // Per-key fail-open: an individual HeadObject error becomes exists=false so a
  // single perm-denied key can't block the upload. Cap at 100 (also enforced by
  // existsSchema, this is defense-in-depth at the route layer).
  r.post('/objects/:bucket/exists', validateBody(existsSchema), wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const { keys } = req.body as { keys: string[] };
    const limited = keys.slice(0, 100);
    const results = await Promise.all(limited.map(async (key) => {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: req.params.bucket, Key: key }));
        return { key, exists: true };
      } catch (e) {
        const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
        const status = err.$metadata?.httpStatusCode;
        if (status === 404 || err.name === 'NotFound') {
          return { key, exists: false };
        }
        console.error('[exists-check]', { user: req.user?.username, key, name: err.name });
        return { key, exists: false, error: err.name };
      }
    }));
    res.json({ results });
  }));

  return r;
}
