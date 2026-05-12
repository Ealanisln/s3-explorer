const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const auth = require('./dist/auth');

// TypeScript S3 client builder — compiled to dist/ by `npm run build`.
const { buildClient: rawBuildClient } = require('./dist/s3/client');

// Bind buildClient with the auth-audit callback so the s3/client module
// stays decoupled from the auth subsystem. Same shape as the inline version
// it replaces — every router gets this `(req) => S3Client` factory.
function buildClient(req) {
  return rawBuildClient(req, {
    onBlocked: (reason, endpoint) => auth.audit('s3_endpoint_blocked', {
      username: req.user && req.user.username,
      endpoint,
      reason,
    }),
  });
}

const app = express();

// ----- Configuration via env -----
const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '4569', 10);
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
app.use(express.json({ limit: '5mb' }));

// (multer config moved into src/s3/routes/upload.ts — only the upload route uses it.)

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
app.use('/api', require('./dist/s3/routes/search').searchRouter(buildClient));
app.use('/api', require('./dist/s3/routes/presign').presignRouter(buildClient));
app.use('/api', require('./dist/s3/routes/upload').uploadRouter(buildClient));

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
});
