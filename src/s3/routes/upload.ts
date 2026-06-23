import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { type S3Client, type PutObjectCommandInput } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import * as mime from 'mime-types';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { wrap } from '../../http/errors';

type ClientFactory = (req: Request) => S3Client;

const MAX_UPLOAD_BYTES = parseInt(
  process.env.MAX_UPLOAD_BYTES || String(2 * 1024 * 1024 * 1024), // 2 GB default
  10,
);

// CD-SEC-003: multer config with hard caps to bound a malicious request:
// - fileSize cap per file (also enforced by Caddy's request_body max_size)
// - files cap so one request can't open dozens of tmp file descriptors
// - fields / parts caps to defeat parser-confusion abuse
const uploadTmpDir = path.join(os.tmpdir(), 's3-explorer-uploads');
fs.mkdirSync(uploadTmpDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadTmpDir,
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID() + '-' + Date.now()),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 10, fields: 20, parts: 30 },
});

export function uploadRouter(buildClient: ClientFactory): Router {
  const r = Router();

  r.post('/object/:bucket/upload', upload.array('files'), wrap(async (req: Request, res: Response) => {
    // multer has already written every part to a tmp file by the time this
    // handler runs, so the cleanup MUST cover all of req.files unconditionally
    // — including the case where buildClient(req) throws (blocked endpoint /
    // missing creds) before we process a single file. Iterating req.files in
    // finally (rather than a list built inside the loop) guarantees no tmp
    // file is orphaned on the upload tmpfs.
    const files = (req.files || []) as Express.Multer.File[];
    try {
      const s3 = buildClient(req);
      const prefix = typeof req.body?.prefix === 'string' ? req.body.prefix : '';
      const results: Array<{ key: string; size: number }> = [];
      for (const f of files) {
        const key = prefix + f.originalname;
        const stream = fs.createReadStream(f.path);
        const params: PutObjectCommandInput = {
          Bucket: req.params.bucket,
          Key: key,
          Body: stream,
          ContentType: (f.mimetype || mime.lookup(f.originalname) || 'application/octet-stream') as string,
        };
        const uploader = new Upload({
          client: s3,
          params,
          queueSize: 4,
          partSize: 8 * 1024 * 1024, // 8 MB parts
          leavePartsOnError: false,
        });
        await uploader.done();
        results.push({ key, size: f.size });
      }
      res.json({ ok: true, uploaded: results });
    } finally {
      for (const f of files) fs.unlink(f.path, () => undefined);
    }
  }));

  return r;
}
