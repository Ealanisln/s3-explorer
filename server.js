const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const mime = require('mime-types');
const auth = require('./dist/auth');
// Commands used only by the remaining inline routes (search, search-stream,
// download, presign, upload). Bucket + object CRUD live in src/s3/routes/.
const {
  ListObjectsV2Command,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// TypeScript leaf utilities — emitted to dist/ by `npm run build`.
const { buildClient: rawBuildClient } = require('./dist/s3/client');
const { sanitizeError } = require('./dist/s3/errors');
const { wrap: wrapBase } = require('./dist/http/errors');

// Bind buildClient with the auth-audit callback so the s3/client module
// stays decoupled from the auth subsystem. Same shape as the inline version
// it replaces — every call site keeps the `buildClient(req)` signature.
function buildClient(req) {
  return rawBuildClient(req, {
    onBlocked: (reason, endpoint) => auth.audit('s3_endpoint_blocked', {
      username: req.user && req.user.username,
      endpoint,
      reason,
    }),
  });
}

// Re-export wrap unchanged — wrapBase already calls sanitizeError on throw.
const wrap = wrapBase;

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

// SSRF denylist for the x-s3-endpoint header (METADATA_HOSTS, BLOCK_METADATA,
// S3_DENY_HOSTS) lives in src/s3/client.ts now and is read directly there.

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

// ----- All /api routes require auth + TOTP enrolled + password rotated -----
app.use('/api', auth.requireAuth, auth.requireTotpEnrolled, auth.requirePasswordCurrent);

// buckets + objects routes moved to src/s3/routes/{buckets,objects}.ts.
// Mounted below as Express Routers that receive `buildClient` (with the
// audit-on-block callback bound) so per-route SDK calls keep working without
// each handler having to know about the audit subsystem.
app.use('/api', require('./dist/s3/routes/buckets').bucketsRouter(buildClient));
app.use('/api', require('./dist/s3/routes/objects').objectsRouter(buildClient));

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
