import type { Request, Response } from 'express';
import { sanitizeError, type ErrorLike } from '../s3/errors';

type AsyncHandler = (req: Request, res: Response) => Promise<unknown> | unknown;

/**
 * Wraps an async route handler so any thrown error is mapped to a sanitized
 * JSON response. Full error detail is logged to stderr for ops; only generic
 * messages reach the client.
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
      // Full detail only to server logs (with username for audit context).
      // req.user is added by requireAuth middleware downstream of this wrapper.
      const username = (req as Request & { user?: { username?: string } }).user?.username;
      console.error('[s3-error]', {
        user: username,
        path: req.path,
        name: err.name,
        message: err.message,
        code: err.Code || err.$metadata?.httpStatusCode,
      });
      if (onError) onError(err, req);
      const { status, body } = sanitizeError(err);
      res.status(status).json(body);
    }
  };
}
