import { Router, type Request, type Response } from 'express';
import type { S3Client } from '@aws-sdk/client-s3';
import { newErrorId } from '../http/errors';
import { sanitizeError } from '../s3/errors';
import { buildSideClient, isSameConnection } from '../s3/dual-client';
import { validateBody } from '../http/validate';
import { transferSchema, type TransferRequest } from './schemas';
import { transferSameConn, transferCrossConn, type ProgressEvent } from './transfer';
import { audit } from '../auth/audit';

export function transferRouter(): Router {
  const r = Router();

  // POST /api/transfer — SSE-streamed batch copy/move between two S3 locations.
  //
  // The endpoint always expects two header sets (x-s3-source-* and x-s3-dest-*).
  // When both point at the same endpoint+access-key, the orchestrator uses
  // server-side CopyObject; otherwise it streams bytes via the proxy.
  r.post('/transfer', validateBody(transferSchema), async (req: Request, res: Response): Promise<void> => {
    const body = req.body as TransferRequest;

    // Build clients up-front so credential / endpoint errors return a normal
    // JSON 4xx instead of being trapped inside an SSE stream.
    let sourceS3: S3Client;
    let destS3: S3Client;
    try {
      sourceS3 = buildSideClient(req, 'source', {
        onBlocked: (reason, endpoint) => audit('s3_endpoint_blocked', {
          username: req.user?.username, endpoint, reason, side: 'source',
        }),
      });
      destS3 = buildSideClient(req, 'dest', {
        onBlocked: (reason, endpoint) => audit('s3_endpoint_blocked', {
          username: req.user?.username, endpoint, reason, side: 'dest',
        }),
      });
    } catch (e) {
      const errorId = newErrorId();
      const err = e as { name?: string; message?: string };
      console.error('[transfer-error]', {
        errorId, user: req.user?.username, name: err.name, message: err.message,
      });
      const { status, body: errBody } = sanitizeError(e as Parameters<typeof sanitizeError>[0], errorId);
      res.status(status).json(errBody);
      return;
    }

    const sameConn = isSameConnection(req);
    if (!sameConn) {
      audit('transfer_cross_connection', {
        username: req.user?.username,
        sourceBucket: body.sourceBucket,
        destBucket: body.destBucket,
        count: body.items.length,
        mode: body.mode,
        sourceEndpoint: req.header('x-s3-source-endpoint'),
        destEndpoint: req.header('x-s3-dest-endpoint'),
      });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (e: ProgressEvent): void => {
      try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* client disconnected */ }
    };

    const abortCtl = new AbortController();
    req.on('close', () => { abortCtl.abort(); });

    try {
      const opts = {
        sourceBucket: body.sourceBucket,
        destBucket: body.destBucket,
        items: body.items,
        mode: body.mode,
        onEvent: send,
        abort: abortCtl.signal,
      };
      if (sameConn) {
        await transferSameConn(sourceS3, opts);
      } else {
        await transferCrossConn(sourceS3, destS3, opts);
      }
    } catch (e) {
      const errorId = newErrorId();
      const err = e as { name?: string; message?: string };
      console.error('[transfer-error]', {
        errorId, user: req.user?.username, name: err.name, message: err.message,
      });
      const { body: errBody } = sanitizeError(e as Parameters<typeof sanitizeError>[0], errorId);
      try { res.write(`data: ${JSON.stringify({ t: 'fatal', ...errBody })}\n\n`); } catch { /* ignore */ }
    }
    res.end();
  });

  return r;
}
