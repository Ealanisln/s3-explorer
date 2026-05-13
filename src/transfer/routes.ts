import { Router, type Request, type Response } from 'express';
import type { S3Client } from '@aws-sdk/client-s3';
import { newErrorId } from '../http/errors';
import { sanitizeError } from '../s3/errors';
import { buildSideClient, isSameConnection } from '../s3/dual-client';
import { validateBody } from '../http/validate';
import { transferSchema, type TransferRequest } from './schemas';
import {
  transferSameConn, transferCrossConn, transferRecursive,
  type ProgressEvent,
} from './transfer';
import { audit } from '../auth/audit';

// Defaults for prefix-based (recursive) transfers. Read once at module load.
const TRANSFER_CONCURRENCY = Math.max(
  1, Math.min(16, parseInt(process.env.TRANSFER_CONCURRENCY || '4', 10) || 4),
);
const TRANSFER_MAX_PREFIX_ITEMS = Math.max(
  1, parseInt(process.env.TRANSFER_MAX_PREFIX_ITEMS || '100000', 10) || 100000,
);

// Normalize a "prefix" string to end with '/' UNLESS it's empty (bucket root).
// Empty prefix means "entire bucket" — leave as-is.
function normalizePrefix(p: string): string {
  if (p === '') return '';
  return p.endsWith('/') ? p : p + '/';
}

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
    const isPrefixMode = body.prefix !== undefined;

    // Defense-in-depth: when moving/copying within the SAME bucket+connection,
    // reject a prefix-mode transfer where the destination sits inside (or is
    // equal to) the source. Without this, the recursive copy would walk into
    // its own freshly-written objects forever. The client also blocks this,
    // but a malicious / buggy client could still post it.
    if (
      isPrefixMode
      && sameConn
      && body.sourceBucket === body.destBucket
    ) {
      const src = normalizePrefix(body.prefix!.source);
      const dst = normalizePrefix(body.prefix!.dest);
      // Same prefix (no-op) or dest descendant of source (recursion trap).
      if (src === dst || (src !== '' && dst.startsWith(src))) {
        res.status(400).json({
          error: 'InvalidTransfer',
          message: src === dst
            ? 'Origen y destino son la misma carpeta.'
            : 'No puedes mover una carpeta dentro de sí misma o de una subcarpeta.',
        });
        return;
      }
    }

    if (!sameConn) {
      audit('transfer_cross_connection', {
        username: req.user?.username,
        sourceBucket: body.sourceBucket,
        destBucket: body.destBucket,
        count: body.items?.length,
        prefixSource: body.prefix?.source,
        prefixDest: body.prefix?.dest,
        mode: body.mode,
        sourceEndpoint: req.header('x-s3-source-endpoint'),
        destEndpoint: req.header('x-s3-dest-endpoint'),
      });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // SSE writes — track last activity so the keepalive can decide whether
    // to emit. Calling `send()` resets the idle timer.
    let lastEmit = Date.now();
    const send = (e: ProgressEvent): void => {
      try { res.write(`data: ${JSON.stringify(e)}\n\n`); lastEmit = Date.now(); }
      catch { /* client disconnected */ }
    };

    // Keepalive: emit an SSE comment every 30 s if nothing else has been
    // sent. Prevents reverse proxies (Caddy, Cloudflare) from killing the
    // connection during a slow single-file upload. Comments are ignored by
    // EventSource clients and our manual SSE reader skips them naturally
    // (no `data:` prefix).
    const keepalive = setInterval(() => {
      if (Date.now() - lastEmit < 30_000) return;
      try { res.write(`: keepalive ${Date.now()}\n\n`); } catch { /* ignore */ }
    }, 15_000);

    // Abort the transfer if the client truly disconnects mid-stream. We listen
    // on RESPONSE.close (fires when the socket actually closes after writes)
    // instead of REQUEST.close — the latter can fire spuriously once Express's
    // body-parser finishes consuming the request body, even though the response
    // socket is still open and the client is still listening. That was the cause
    // of recursive transfers immediately aborting after a single ListObjectsV2.
    //
    // We also guard against double-aborting AFTER the transfer completes
    // (response naturally ends → res.on('close') fires; harmless but noisy).
    const abortCtl = new AbortController();
    let transferFinished = false;
    res.on('close', () => {
      if (!transferFinished) abortCtl.abort();
    });

    try {
      if (isPrefixMode) {
        await transferRecursive(sourceS3, destS3, {
          sourceBucket: body.sourceBucket,
          destBucket: body.destBucket,
          sourcePrefix: normalizePrefix(body.prefix!.source),
          destPrefix: normalizePrefix(body.prefix!.dest),
          mode: body.mode,
          sameConn,
          concurrency: TRANSFER_CONCURRENCY,
          maxItems: TRANSFER_MAX_PREFIX_ITEMS,
          onEvent: send,
          abort: abortCtl.signal,
        });
      } else {
        const opts = {
          sourceBucket: body.sourceBucket,
          destBucket: body.destBucket,
          items: body.items!,
          mode: body.mode,
          onEvent: send,
          abort: abortCtl.signal,
        };
        if (sameConn) {
          await transferSameConn(sourceS3, opts);
        } else {
          await transferCrossConn(sourceS3, destS3, opts);
        }
      }
    } catch (e) {
      const errorId = newErrorId();
      const err = e as { name?: string; message?: string };
      console.error('[transfer-error]', {
        errorId, user: req.user?.username, name: err.name, message: err.message,
      });
      const { body: errBody } = sanitizeError(e as Parameters<typeof sanitizeError>[0], errorId);
      try { res.write(`data: ${JSON.stringify({ t: 'fatal', ...errBody })}\n\n`); } catch { /* ignore */ }
    } finally {
      clearInterval(keepalive);
      transferFinished = true;
    }
    res.end();
  });

  return r;
}
