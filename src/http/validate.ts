// Generic body-validation middleware. Moved from src/auth/schemas.ts so that
// the s3/routes modules can use it without depending on the auth subsystem.
import type { Request, Response, NextFunction } from 'express';
import type { z } from 'zod';

export function validateBody<T>(schema: z.ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path?.join('.') || '(body)';
      const msg = first?.message || 'Bad request';
      res.status(400).json({ message: `${path}: ${msg}`, code: 'BAD_REQUEST' });
      return;
    }
    req.body = parsed.data;
    next();
  };
}
