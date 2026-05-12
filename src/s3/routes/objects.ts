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
  restoreSchema,
  deleteObjectSchema,
  deleteBatchSchema,
  copySchema,
  renameSchema,
  existsSchema,
} from '../schemas';

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

      res.json({
        prefixes: [...prefixesSet],
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
