import type { Request, Response } from 'express';
import * as crypto from 'crypto';
import { sanitizeError, type ErrorLike } from '../s3/errors';

type AsyncHandler = (req: Request, res: Response) => Promise<unknown> | unknown;

// Short error correlation ID. 4 random bytes → 8 hex chars → `err-xxxxxxxx`.
// 32 bits of entropy is plenty for grep-by-ID purposes (we're correlating
// within the lifetime of a few hours of logs, not protecting against
// collision attacks). Exported so streaming handlers that bypass wrap()
// (e.g. search-stream) can use the same ID shape.
export function newErrorId(): string {
  return 'err-' + crypto.randomBytes(4).toString('hex');
}

/**
 * Wraps an async route handler so any thrown error is mapped to a sanitized
 * JSON response with a request-correlation `errorId`. The same ID appears in
 * the server log line, so the user can copy it from a toast and an admin can
 * grep Loki/Coolify for the full SDK error message + stack.
 *
 * Full error detail is logged to stderr for ops; only the generic Spanish
 * message + errorId reach the client.
 *
 * The optional onError hook is invoked before sanitization — used by callers
 * that want to emit audit events (e.g. s3_endpoint_blocked) without coupling
 * this module to the auth audit log.
 */
export function wrap(
  fn: AsyncHandler,
  onError?: (err: ErrorLike, req: Request) => void,
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (e) {
      const err = e as ErrorLike & { Code?: string };
      const errorId = newErrorId();
      // Full detail only to server logs (with username for audit context).
      // The errorId is the join key: same value goes back to the client.
      const username = (req as Request & { user?: { username?: string } }).user?.username;
      console.error('[s3-error]', {
        errorId,
        user: username,
        path: req.path,
        name: err.name,
        message: err.message,
        code: err.Code || err.$metadata?.httpStatusCode,
      });
      if (onError) onError(err, req);
      const { status, body } = sanitizeError(err, errorId);
      res.status(status).json(body);
    }
  };
}
