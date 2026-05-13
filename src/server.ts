import express, { type Request, type NextFunction, type Response } from 'express';
import cookieParser from 'cookie-parser';
import * as path from 'path';
import * as auth from './auth';
import { HOST, PORT, ALLOWED_HOSTS, TRUST_PROXY, warnIfTrustProxyMisconfigured } from './config';
import { securityHeaders, hostAllowlist, originAllowlist } from './http/guards';
import { buildClient as rawBuildClient } from './s3/client';
import type { S3Client } from '@aws-sdk/client-s3';
import { bucketsRouter } from './s3/routes/buckets';
import { objectsRouter } from './s3/routes/objects';
import { searchRouter } from './s3/routes/search';
import { presignRouter } from './s3/routes/presign';
import { uploadRouter } from './s3/routes/upload';
import { indexRouter } from './index/routes';
import { transferRouter } from './transfer/routes';

const app = express();

if (TRUST_PROXY) app.set('trust proxy', 1);
warnIfTrustProxyMisconfigured();

// Disable etag for API responses to avoid leaking caching state
app.set('etag', false);
// Remove "X-Powered-By: Express" — minor fingerprinting reduction
app.disable('x-powered-by');

// Health endpoint — exempt from host/auth checks so docker healthchecks and
// load balancer probes don't need to set a real Host header or auth cookie.
app.get('/healthz', (_req: Request, res: Response) => res.json({ ok: true }));

// Order matters: security headers and allowlists run BEFORE body parsers so a
// rejected request doesn't even pay the parse cost.
app.use(securityHeaders);
app.use(hostAllowlist);
app.use(originAllowlist);

app.use(cookieParser());
app.use(express.json({ limit: '5mb' }));

// /auth/* routes (login, totp, admin) — registered BEFORE the static serve so
// a clever caller can't hit a public/auth.html or similar and bypass.
auth.register(app);

// SPA static files — served unauthenticated; the SPA itself calls /auth/me to
// decide whether to render. At runtime dist/server.js lives in /app/dist/, so
// `../public` resolves to /app/public.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filepath) {
    if (filepath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// /api/* gate: every API request must be authenticated, TOTP-enrolled, and
// have rotated any admin-issued initial password.
app.use('/api', auth.requireAuth, auth.requireTotpEnrolled, auth.requirePasswordCurrent);

// Wrap the raw TS builder with the audit-on-block side effect, so the
// s3/client module stays decoupled from auth.
function buildClient(req: Request): S3Client {
  return rawBuildClient(req, {
    onBlocked: (reason, endpoint) => auth.audit('s3_endpoint_blocked', {
      username: req.user && req.user.username,
      endpoint,
      reason,
    }),
  });
}

app.use('/api', bucketsRouter(buildClient));
app.use('/api', objectsRouter(buildClient));
app.use('/api', searchRouter(buildClient));
app.use('/api', presignRouter(buildClient));
app.use('/api', uploadRouter(buildClient));
app.use('/api', indexRouter(buildClient));
app.use('/api', transferRouter());

// 404 + final error handler. Never leak stack traces.
app.use((_req: Request, res: Response) => res.status(404).json({ message: 'Not found' }));
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled:', err.message);
  if (res.headersSent) { next(err); return; }
  res.status(500).json({ message: 'Internal server error' });
});

app.listen(PORT, HOST, () => {
  console.log(`S3 Explorer listening on http://${HOST}:${PORT}`);
  console.log(`  - ALLOWED_HOSTS: ${ALLOWED_HOSTS.join(', ')}`);
  console.log(`  - Auth: username + password + TOTP`);
});
