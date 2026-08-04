import { z } from 'zod';

// `validateBody` moved to ../http/validate.ts (shared with s3/routes/*).
// Re-export here so existing imports keep compiling.
export { validateBody } from '../http/validate';

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

export const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(64),
  scope: z.enum(['read', 'write']),
  // 30 / 90 days, or null/omitted for a token that never expires.
  expiresInDays: z.union([z.literal(30), z.literal(90)]).nullish(),
});
