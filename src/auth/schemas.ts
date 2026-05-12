import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';

export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});

export const totpSchema = z.object({
  code: z.string().min(1).max(64),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(8).max(1024),
});

export const createUserSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_.-]{2,32}$/, 'username inválido (2-32 chars, letras/números/._-)'),
  password: z.string().min(8).max(1024),
  role: z.enum(['admin', 'user']).optional(),
});

export const resetPasswordSchema = z.object({
  newPassword: z.string().min(8).max(1024),
});

// Generic body-validation middleware. On parse failure, returns 400 with the
// first error message — the AWS-error sanitizer doesn't apply to /auth/* so we
// own the response shape here.
//
// Mutates req.body to the parsed/typed object so handlers can read it without
// casting. TS request-augmentation in src/types.ts means req.body stays `any`
// at the type system level; for stricter typing the handlers cast at use-site.
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
