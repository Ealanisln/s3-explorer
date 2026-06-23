// Cross-cutting types shared across modules. Re-exported via `import` so each
// module only depends on what it needs.

import 'express';

export type UserRole = 'admin' | 'user';

export interface User {
  username: string;
  passwordHash: string;
  totpSecret: string | null;
  totpConfirmed: boolean;
  recoveryCodesHashed: (string | null)[];
  role: UserRole;
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  // Last TOTP timestep consumed by a successful 2FA login/enrollment. Used to
  // reject replay of a still-valid code (see migration 003). 0 = none yet.
  lastTotpStep: number;
}

export interface SessionPayload {
  uid: string;
  role: UserRole;
  jti: string;
  exp: number;
}

export interface PendingPayload {
  p: 1;
  uid: string;
  exp: number;
}

// Augment Express's Request so route handlers can read req.user / req.session
// after the auth middleware has run, without per-file casts.
declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
    session?: SessionPayload;
  }
}
