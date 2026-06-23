import express, { type Express, type Request, type NextFunction, type Response } from 'express';
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

export function createApp(): Express {
  const app = express();

  if (TRUST_PROXY) app.set('trust proxy', 1);
  warnIfTrustProxyMisconfigured();

  app.set('etag', false);
  app.disable('x-powered-by');

  app.get('/healthz', (_req: Request, res: Response) => res.json({ ok: true }));

  app.use(securityHeaders);
  app.use(hostAllowlist);
  app.use(originAllowlist);

  app.use(cookieParser());
  app.use(express.json({ limit: '5mb' }));

  auth.register(app);

  app.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders(res, filepath) {
      // no-cache means "revalidate on every request" — combined with the
      // ETag / Last-Modified express.static already sets, the browser
      // sends If-None-Match and gets a 304 when unchanged. No actual
      // bandwidth penalty, but new builds land immediately without
      // requiring a Ctrl+F5. We do this for every text asset the SPA
      // pulls so a CSS / JS change isn't stuck behind heuristic caching.
      if (filepath.endsWith('.html')
        || filepath.endsWith('.css')
        || filepath.endsWith('.js')
        || filepath.endsWith('.mjs')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  app.use('/api', auth.requireAuth, auth.requireTotpEnrolled, auth.requirePasswordCurrent);

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

  app.use((_req: Request, res: Response) => res.status(404).json({ message: 'Not found' }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
    console.error('Unhandled:', err.message);
    if (res.headersSent) { next(err); return; }
    res.status(500).json({ message: 'Internal server error' });
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`S3 Explorer listening on http://${HOST}:${PORT}`);
    console.log(`  - ALLOWED_HOSTS: ${ALLOWED_HOSTS.join(', ')}`);
    console.log(`  - Auth: username + password + TOTP`);
  });
}
