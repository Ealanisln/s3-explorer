const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const mime = require('mime-types');
const auth = require('./auth');
const {
  S3Client,
  ListBucketsCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  GetBucketVersioningCommand,
  PutBucketVersioningCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();

// ----- Configuration via env -----
const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '4569', 10);
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || String(2 * 1024 * 1024 * 1024), 10); // 2 GB default
const MAX_PRESIGN_SECONDS = parseInt(process.env.MAX_PRESIGN_SECONDS || '86400', 10); // 24h
const DEFAULT_PRESIGN_SECONDS = parseInt(process.env.DEFAULT_PRESIGN_SECONDS || '300', 10); // 5 min
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ||
  `localhost:${PORT},127.0.0.1:${PORT},localhost,127.0.0.1,[::1]:${PORT},[::1]`
).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ALLOWED_ORIGINS_RAW = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const TRUST_PROXY = (process.env.TRUST_PROXY || '') === '1';

if (TRUST_PROXY) app.set('trust proxy', 1);

// SEC2-11: detect TRUST_PROXY misconfig. If we're bound to 0.0.0.0 we're almost
// certainly behind a reverse proxy (Docker network); without trust proxy the rate-limit
// per-IP collapses to "per Caddy container IP" → effectively per-username only.
if (HOST === '0.0.0.0' && !TRUST_PROXY) {
  console.warn(
    '[server] WARNING: HOST=0.0.0.0 but TRUST_PROXY is not set. ' +
    'Rate-limit and audit-log IPs will show the proxy IP, not the real client. ' +
    'Set TRUST_PROXY=1 in env if you are behind a reverse proxy (Caddy/nginx).'
  );
}

// Disable etag for API responses to avoid leaking caching state
app.set('etag', false);

// Remove "X-Powered-By: Express" — minor fingerprinting reduction
app.disable('x-powered-by');

// ----- Health endpoint (exempt from host/auth checks) -----
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ----- Security headers (defense in depth) -----
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (!req.path.startsWith('/api/object/') || req.query.inline !== '1') {
    // SPA pages and JSON responses
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; " +
      "img-src 'self' blob: data:; " +
      "media-src 'self' blob:; " +
      "object-src 'self' blob:; " +
      "frame-src 'self' blob:; " +
      "style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; " +
      "connect-src 'self'; " +
      "base-uri 'none'; " +
      "form-action 'none'; " +
      "frame-ancestors 'none'"
    );
  }
  next();
});

// ----- Host header allowlist (DNS rebinding protection) -----
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  const bareHost = host.split(':')[0];
  if (!ALLOWED_HOSTS.includes(host) && !ALLOWED_HOSTS.includes(bareHost)) {
    return res.status(403).json({ message: `Host not allowed: ${host}. Set ALLOWED_HOSTS env var to whitelist.` });
  }
  next();
});

// ----- Origin allowlist (CSRF protection) -----
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next(); // same-origin or non-browser
  const selfOrigins = [
    `http://${req.headers.host}`,
    `https://${req.headers.host}`,
  ];
  const allowed = [...selfOrigins, ...ALLOWED_ORIGINS_RAW];
  if (!allowed.includes(origin)) {
    return res.status(403).json({ message: `Origin not allowed: ${origin}` });
  }
  next();
});

// ----- Cookie + JSON body parser -----
app.use(cookieParser());

// ----- Body parsers AFTER security middleware -----
const uploadTmpDir = path.join(os.tmpdir(), 's3-explorer-uploads');
fs.mkdirSync(uploadTmpDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadTmpDir,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + '-' + Date.now()),
  }),
  // CD-SEC-003: limit concurrent files per request; tmpfs in compose caps total disk
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 10, fields: 20, parts: 30 },
});

app.use(express.json({ limit: '5mb' }));

// ----- Auth routes (login/logout/totp/admin) — registered BEFORE static + /api -----
auth.register(app);

// ----- Static files (SPA) — served unauthenticated; the SPA itself checks /auth/me -----
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filepath) {
    if (filepath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ----- All /api routes require auth + TOTP enrolled -----
app.use('/api', auth.requireAuth, auth.requireTotpEnrolled);

function normalizeEndpoint(ep) {
  if (!ep) return undefined;
  const trimmed = ep.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  return 'https://' + trimmed.replace(/\/+$/, '');
}

function buildClient(req) {
  const endpoint = normalizeEndpoint(req.header('x-s3-endpoint'));
  const region = req.header('x-s3-region') || 'us-east-1';
  const accessKeyId = req.header('x-s3-access-key');
  const secretAccessKey = req.header('x-s3-secret-key');
  const sessionToken = req.header('x-s3-session-token') || undefined;
  const forcePathStyle = (req.header('x-s3-path-style') || 'true') === 'true';

  if (!accessKeyId || !secretAccessKey) {
    const err = new Error('Missing S3 credentials');
    err.status = 401;
    throw err;
  }

  return new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey, sessionToken },
  });
}

// CD-SEC-005: don't leak full AWS SDK messages (ARNs, bucket names, internal paths) to clients.
// Map known error names to generic user-facing messages; full detail stays in server logs only.
const SAFE_AWS_ERRORS = {
  AccessDenied: 'Acceso denegado. Verifica los permisos del IAM para este bucket/objeto.',
  NoSuchBucket: 'El bucket no existe.',
  NoSuchKey: 'El archivo no existe.',
  NoSuchUpload: 'La subida fue cancelada o expiró.',
  BucketAlreadyExists: 'Ya existe un bucket con ese nombre.',
  BucketAlreadyOwnedByYou: 'Ya tienes un bucket con ese nombre.',
  BucketNotEmpty: 'El bucket no está vacío.',
  InvalidAccessKeyId: 'Credenciales inválidas. Verifica access key y secret key.',
  SignatureDoesNotMatch: 'Credenciales inválidas. Verifica access key y secret key.',
  InvalidBucketName: 'Nombre de bucket inválido.',
  InvalidArgument: 'Parámetro inválido.',
  EntityTooLarge: 'Archivo demasiado grande.',
  RequestTimeout: 'Tiempo de espera agotado.',
  ServiceUnavailable: 'El proveedor S3 no está disponible. Reintenta en unos segundos.',
  SlowDown: 'El proveedor S3 está limitando la velocidad. Reintenta en unos segundos.',
  Forbidden: 'Acceso denegado.',
  NotFound: 'Recurso no encontrado.',
};

function sanitizeError(e) {
  const status = e.status || e.$metadata?.httpStatusCode || 500;
  const code = e.name || 'Error';
  const safe = SAFE_AWS_ERRORS[code];
  if (safe) return { status, body: { error: code, message: safe } };
  // For unknown errors: status code only, no message detail
  if (status >= 500) return { status, body: { error: 'InternalError', message: 'Error interno del servidor.' } };
  return { status, body: { error: code, message: 'Operación rechazada.' } };
}

function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      // Full detail only to server logs (with username for audit context)
      console.error('[s3-error]', {
        user: req.user?.username,
        path: req.path,
        name: e.name,
        message: e.message,
        code: e.Code || e.$metadata?.httpStatusCode,
      });
      const { status, body } = sanitizeError(e);
      res.status(status).json(body);
    }
  };
}

app.post('/api/test', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const bucket = req.body && req.body.bucket;
  if (bucket) {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    res.json({ ok: true, mode: 'head-bucket', bucket });
    return;
  }
  const out = await s3.send(new ListBucketsCommand({}));
  res.json({ ok: true, mode: 'list-buckets', owner: out.Owner, bucketCount: (out.Buckets || []).length });
}));

app.get('/api/buckets', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const out = await s3.send(new ListBucketsCommand({}));
  res.json({ buckets: out.Buckets || [], owner: out.Owner });
}));

app.post('/api/buckets', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const { name } = req.body;
  await s3.send(new CreateBucketCommand({ Bucket: name }));
  res.json({ ok: true });
}));

app.delete('/api/buckets/:bucket', wrap(async (req, res) => {
  const s3 = buildClient(req);
  await s3.send(new DeleteBucketCommand({ Bucket: req.params.bucket }));
  res.json({ ok: true });
}));

app.get('/api/buckets/:bucket/versioning', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const out = await s3.send(new GetBucketVersioningCommand({ Bucket: req.params.bucket }));
  res.json({ status: out.Status || 'Disabled' });
}));

app.put('/api/buckets/:bucket/versioning', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const { enabled } = req.body;
  // Policy: versioning can only be enabled, never suspended via this app.
  // This prevents accidental data loss; suspension must be done with full AWS CLI access.
  if (enabled !== true) {
    res.status(403).json({
      message: 'Por política, no se puede desactivar el versionado desde esta app. Si necesitas suspenderlo, hazlo con awscli/consola del proveedor.',
    });
    return;
  }
  await s3.send(new PutBucketVersioningCommand({
    Bucket: req.params.bucket,
    VersioningConfiguration: { Status: 'Enabled' },
  }));
  auth.audit('versioning_enabled', { username: req.user.username, bucket: req.params.bucket });
  res.json({ ok: true });
}));

app.get('/api/objects/:bucket', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const prefix = req.query.prefix || '';
  const showDeleted = req.query.showDeleted === '1';
  const PAGE_CAP = parseInt(req.query.pageCap || '50', 10); // up to 50 pages × 1000 = 50k entries
  const MAX_ENTRIES = parseInt(req.query.max || '50000', 10);

  if (showDeleted) {
    const prefixesSet = new Set();
    const byKey = new Map();
    let keyMarker = undefined;
    let versionMarker = undefined;
    let pages = 0;
    let truncated = false;

    while (true) {
      const out = await s3.send(new ListObjectVersionsCommand({
        Bucket: req.params.bucket,
        Prefix: prefix,
        Delimiter: '/',
        KeyMarker: keyMarker,
        VersionIdMarker: versionMarker,
        MaxKeys: 1000,
      }));
      for (const cp of (out.CommonPrefixes || [])) prefixesSet.add(cp.Prefix);
      for (const v of (out.Versions || [])) {
        if (v.Key === prefix) continue;
        const cur = byKey.get(v.Key);
        if (!cur || new Date(v.LastModified) > new Date(cur.LastModified)) {
          byKey.set(v.Key, { ...v, IsDeleteMarker: false });
        }
      }
      for (const m of (out.DeleteMarkers || [])) {
        if (m.Key === prefix) continue;
        const cur = byKey.get(m.Key);
        if (!cur || new Date(m.LastModified) > new Date(cur.LastModified)) {
          byKey.set(m.Key, { ...m, IsDeleteMarker: true });
        }
      }
      pages++;
      if (!out.IsTruncated) break;
      if (pages >= PAGE_CAP || (prefixesSet.size + byKey.size) >= MAX_ENTRIES) { truncated = true; break; }
      keyMarker = out.NextKeyMarker;
      versionMarker = out.NextVersionIdMarker;
    }

    res.json({
      prefixes: [...prefixesSet],
      objects: [...byKey.values()].map(o => ({
        Key: o.Key, Size: o.Size || 0, LastModified: o.LastModified,
        ETag: o.ETag, VersionId: o.VersionId, IsDeleteMarker: o.IsDeleteMarker,
      })),
      nextToken: null,
      isTruncated: truncated,
      pages,
    });
    return;
  }

  const prefixesSet = new Set();
  const objects = [];
  let token = undefined;
  let pages = 0;
  let truncated = false;

  while (true) {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: req.params.bucket,
      Prefix: prefix,
      Delimiter: '/',
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const cp of (out.CommonPrefixes || [])) prefixesSet.add(cp.Prefix);
    for (const o of (out.Contents || [])) {
      if (o.Key === prefix) continue;
      objects.push({
        Key: o.Key, Size: o.Size, LastModified: o.LastModified,
        ETag: o.ETag, StorageClass: o.StorageClass, IsDeleteMarker: false,
      });
    }
    pages++;
    if (!out.IsTruncated) break;
    if (pages >= PAGE_CAP || (prefixesSet.size + objects.length) >= MAX_ENTRIES) { truncated = true; break; }
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

app.post('/api/object/:bucket/restore', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const { key, versionId } = req.body;
  await s3.send(new DeleteObjectCommand({ Bucket: req.params.bucket, Key: key, VersionId: versionId }));
  res.json({ ok: true });
}));

app.get('/api/search-stream/:bucket', async (req, res) => {
  let s3;
  try { s3 = buildClient(req); } catch (e) {
    // SEC2-02: don't leak SDK error text — use sanitizeError like every other endpoint
    const { status, body } = sanitizeError(e);
    res.status(status).json(body);
    return;
  }
  const q = (req.query.q || '').toLowerCase().trim();
  const startPrefix = req.query.prefix || '';
  const maxResults = Math.min(parseInt(req.query.limit || '2000', 10), 10000);

  if (!q) { res.status(400).json({ message: 'missing q' }); return; }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (e) => { try { res.write(JSON.stringify(e) + '\n'); } catch {} };

  let aborted = false;
  req.on('close', () => { aborted = true; });

  let token = undefined;
  let scanned = 0;
  let hits = 0;

  try {
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
        if (o.Key.toLowerCase().includes(q)) {
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
    // SEC2-02: send sanitized error instead of raw SDK message
    console.error('[search-stream-error]', {
      user: req.user?.username,
      bucket: req.params.bucket,
      name: e.name,
      message: e.message,
    });
    const { body } = sanitizeError(e);
    send({ t: 'error', ...body });
  }
  res.end();
});

app.get('/api/search/:bucket', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const q = (req.query.q || '').toLowerCase().trim();
  const prefix = req.query.prefix || '';
  const maxResults = Math.min(parseInt(req.query.limit || '500', 10), 2000);
  const maxScan = Math.min(parseInt(req.query.scan || '50000', 10), 200000);

  if (!q) return res.json({ results: [], scanned: 0, truncated: false });

  const results = [];
  let token = undefined;
  let scanned = 0;
  let truncated = false;

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
      const name = o.Key.split('/').pop().toLowerCase();
      if (name.includes(q) || o.Key.toLowerCase().includes(q)) {
        results.push({
          Key: o.Key,
          Size: o.Size,
          LastModified: o.LastModified,
          ETag: o.ETag,
        });
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

app.get('/api/object/:bucket/head', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const key = req.query.key;
  const versionId = req.query.versionId || undefined;
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

app.get('/api/object/:bucket/versions', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const prefix = req.query.key;
  const out = await s3.send(new ListObjectVersionsCommand({
    Bucket: req.params.bucket,
    Prefix: prefix,
  }));
  const versions = (out.Versions || []).filter(v => v.Key === prefix).map(v => ({
    VersionId: v.VersionId,
    IsLatest: v.IsLatest,
    LastModified: v.LastModified,
    Size: v.Size,
    ETag: v.ETag,
    Type: 'version',
  }));
  const markers = (out.DeleteMarkers || []).filter(v => v.Key === prefix).map(v => ({
    VersionId: v.VersionId,
    IsLatest: v.IsLatest,
    LastModified: v.LastModified,
    Type: 'delete-marker',
  }));
  res.json({ versions: [...versions, ...markers].sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified)) });
}));

const DANGEROUS_INLINE_TYPES = /^(text\/html|application\/xhtml|image\/svg|application\/xml|text\/xml|application\/javascript|text\/javascript|application\/ecmascript)/i;
// Generic / unknown content-types that S3 may return when the uploader didn't set one.
// In these cases trust the file extension instead — otherwise PDFs/images won't render inline.
const GENERIC_CONTENT_TYPES = /^(binary|application)\/octet-stream$/i;

app.get('/api/object/:bucket/download', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const key = req.query.key;
  const versionId = req.query.versionId || undefined;
  const inline = req.query.inline === '1';
  if (!key) { res.status(400).json({ message: 'missing key' }); return; }
  const out = await s3.send(new GetObjectCommand({ Bucket: req.params.bucket, Key: key, VersionId: versionId }));
  const filename = key.split('/').pop();

  // Resolve content-type: prefer S3's declared type UNLESS it's generic (binary/octet-stream
  // or application/octet-stream) — in that case fall back to mime lookup by extension so
  // the browser renders PDFs/images/etc. inline instead of forcing download.
  const s3Type = out.ContentType;
  let contentType;
  if (!s3Type || GENERIC_CONTENT_TYPES.test(s3Type)) {
    contentType = mime.lookup(filename) || s3Type || 'application/octet-stream';
  } else {
    contentType = s3Type;
  }

  // CD-SEC-002: defense against stored-XSS via inline preview — refuse to render
  // script-bearing types in our own origin. Force them to text/plain when inline=1.
  if (inline && DANGEROUS_INLINE_TYPES.test(contentType)) {
    contentType = 'text/plain; charset=utf-8';
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // CSP: scoped to inline previews. Don't apply the "sandbox" directive because
  // Chrome's built-in PDF viewer can't initialize in a sandboxed iframe (broke PDF
  // preview). With nosniff + the dangerous-type flip above, XSS surface is closed.
  if (inline) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; object-src 'self'");
  }
  if (out.ContentLength) res.setHeader('Content-Length', out.ContentLength);
  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  out.Body.pipe(res);
}));

app.get('/api/object/:bucket/presign', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const key = req.query.key;
  const versionId = req.query.versionId || undefined;
  if (!key) { res.status(400).json({ message: 'missing key' }); return; }
  const requested = parseInt(req.query.expires || String(DEFAULT_PRESIGN_SECONDS), 10);
  const expires = Math.max(60, Math.min(requested, MAX_PRESIGN_SECONDS));
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: req.params.bucket, Key: key, VersionId: versionId }),
    { expiresIn: expires }
  );
  res.json({ url, expires, capped: expires !== requested });
}));

app.post('/api/object/:bucket/upload', upload.array('files'), wrap(async (req, res) => {
  const s3 = buildClient(req);
  const prefix = req.body.prefix || '';
  const results = [];
  const cleanups = [];
  try {
    for (const f of req.files || []) {
      const key = prefix + f.originalname;
      const stream = fs.createReadStream(f.path);
      cleanups.push(f.path);
      const uploader = new Upload({
        client: s3,
        params: {
          Bucket: req.params.bucket,
          Key: key,
          Body: stream,
          ContentType: f.mimetype || mime.lookup(f.originalname) || 'application/octet-stream',
        },
        queueSize: 4,
        partSize: 8 * 1024 * 1024, // 8 MB parts
        leavePartsOnError: false,
      });
      await uploader.done();
      results.push({ key, size: f.size });
    }
    res.json({ ok: true, uploaded: results });
  } finally {
    for (const p of cleanups) {
      fs.unlink(p, () => {});
    }
  }
}));

app.post('/api/object/:bucket/folder', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const { prefix, name } = req.body || {};
  // SEC2-12: validate input — was crashing with TypeError → 500. Now 400 with reason.
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ message: 'name (string, no vacío) requerido' });
  }
  if (name.length > 1024) {
    return res.status(400).json({ message: 'name demasiado largo (máx 1024 chars)' });
  }
  const safePrefix = typeof prefix === 'string' ? prefix : '';
  const key = safePrefix + name.replace(/\/$/, '') + '/';
  await s3.send(new PutObjectCommand({ Bucket: req.params.bucket, Key: key, Body: '' }));
  res.json({ ok: true, key });
}));

app.delete('/api/object/:bucket', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const { key, versionId } = req.body;
  await s3.send(new DeleteObjectCommand({ Bucket: req.params.bucket, Key: key, VersionId: versionId }));
  res.json({ ok: true });
}));

app.post('/api/object/:bucket/delete-batch', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const { keys } = req.body;
  const out = await s3.send(new DeleteObjectsCommand({
    Bucket: req.params.bucket,
    Delete: { Objects: keys.map(k => typeof k === 'string' ? { Key: k } : { Key: k.key, VersionId: k.versionId }) },
  }));
  res.json({ deleted: out.Deleted || [], errors: out.Errors || [] });
}));

function buildCopySource(bucket, key, versionId) {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  let src = `/${encodeURIComponent(bucket)}/${encodedKey}`;
  if (versionId) src += `?versionId=${encodeURIComponent(versionId)}`;
  return src;
}

app.post('/api/object/:bucket/copy', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const { sourceKey, destKey, sourceVersionId } = req.body;
  if (!sourceKey || !destKey) { res.status(400).json({ message: 'sourceKey and destKey required' }); return; }
  await s3.send(new CopyObjectCommand({
    Bucket: req.params.bucket,
    Key: destKey,
    CopySource: buildCopySource(req.params.bucket, sourceKey, sourceVersionId),
  }));
  res.json({ ok: true });
}));

app.post('/api/object/:bucket/rename', wrap(async (req, res) => {
  const s3 = buildClient(req);
  const { sourceKey, destKey } = req.body;
  if (!sourceKey || !destKey) { res.status(400).json({ message: 'sourceKey and destKey required' }); return; }
  await s3.send(new CopyObjectCommand({
    Bucket: req.params.bucket,
    Key: destKey,
    CopySource: buildCopySource(req.params.bucket, sourceKey),
  }));
  await s3.send(new DeleteObjectCommand({ Bucket: req.params.bucket, Key: sourceKey }));
  res.json({ ok: true });
}));

// 404 + safe JSON error fallback (never leak stacks)
app.use((req, res) => res.status(404).json({ message: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('Unhandled:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ message: 'Internal server error' });
});

app.listen(PORT, HOST, () => {
  console.log(`S3 Explorer listening on http://${HOST}:${PORT}`);
  console.log(`  - ALLOWED_HOSTS: ${ALLOWED_HOSTS.join(', ')}`);
  console.log(`  - Auth: username + password + TOTP`);
  console.log(`  - Max upload: ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB`);
  console.log(`  - Presign: default ${DEFAULT_PRESIGN_SECONDS}s, max ${MAX_PRESIGN_SECONDS}s`);
});
