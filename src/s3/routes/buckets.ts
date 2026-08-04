import { Router, type Request, type Response } from 'express';
import {
  type S3Client,
  ListBucketsCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  GetBucketVersioningCommand,
  PutBucketVersioningCommand,
} from '@aws-sdk/client-s3';
import { wrap } from '../../http/errors';
import { validateBody } from '../../http/validate';
import { audit } from '../../auth/audit';
import { requireScope } from '../../auth/token-auth';
import { createBucketSchema, versioningSchema, testSchema } from '../schemas';

type ClientFactory = (req: Request) => S3Client;

export function bucketsRouter(buildClient: ClientFactory): Router {
  const r = Router();

  // POST /api/test — connection probe. If body has `bucket`, runs HeadBucket;
  // otherwise ListBuckets and returns the count.
  r.post('/test', validateBody(testSchema), wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const { bucket } = req.body as { bucket?: string };
    if (bucket) {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      res.json({ ok: true, mode: 'head-bucket', bucket });
      return;
    }
    const out = await s3.send(new ListBucketsCommand({}));
    res.json({ ok: true, mode: 'list-buckets', owner: out.Owner, bucketCount: (out.Buckets || []).length });
  }));

  r.get('/buckets', wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const out = await s3.send(new ListBucketsCommand({}));
    res.json({ buckets: out.Buckets || [], owner: out.Owner });
  }));

  r.post('/buckets', requireScope('write'), validateBody(createBucketSchema), wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const { name } = req.body as { name: string };
    await s3.send(new CreateBucketCommand({ Bucket: name }));
    res.json({ ok: true });
  }));

  r.delete('/buckets/:bucket', requireScope('write'), wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    await s3.send(new DeleteBucketCommand({ Bucket: req.params.bucket }));
    res.json({ ok: true });
  }));

  r.get('/buckets/:bucket/versioning', wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    const out = await s3.send(new GetBucketVersioningCommand({ Bucket: req.params.bucket }));
    res.json({ status: out.Status || 'Disabled' });
  }));

  // PUT /api/buckets/:bucket/versioning — enable only. Suspending is rejected at
  // the schema level (versioningSchema requires enabled=true literal).
  r.put('/buckets/:bucket/versioning', requireScope('write'), validateBody(versioningSchema), wrap(async (req: Request, res: Response) => {
    const s3 = buildClient(req);
    await s3.send(new PutBucketVersioningCommand({
      Bucket: req.params.bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    }));
    audit('versioning_enabled', { username: req.user?.username, bucket: req.params.bucket });
    res.json({ ok: true });
  }));

  return r;
}
