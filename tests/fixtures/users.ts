import type { Express } from 'express';
import request from 'supertest';
import { authenticator } from 'otplib';
import { hashPasswordSync } from '../../src/auth/passwords';
import { encryptTotpSecret, generateTotpSecret } from '../../src/auth/totp';
import { createUser } from '../../src/auth/users-store';
import type { User, UserRole } from '../../src/types';

export interface TestUserSeed {
  username: string;
  password: string;
  role?: UserRole;
  disabled?: boolean;
  mustChangePassword?: boolean;
  totpEnrolled?: boolean;
}

export interface TestUser {
  username: string;
  password: string;
  role: UserRole;
  totpSecret: string | null;
}

// Seed a user directly via the SQLite store. Skips the /auth/login flow so
// tests can set up arbitrary states (disabled accounts, legacy hashes, etc.).
export function createTestUser(seed: TestUserSeed): TestUser {
  const totpSecret = seed.totpEnrolled ? generateTotpSecret() : null;
  const user: User = {
    username: seed.username,
    passwordHash: hashPasswordSync(seed.password),
    totpSecret: totpSecret ? encryptTotpSecret(totpSecret) : null,
    totpConfirmed: !!seed.totpEnrolled,
    recoveryCodesHashed: [],
    role: seed.role ?? 'user',
    disabled: !!seed.disabled,
    mustChangePassword: !!seed.mustChangePassword,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  const conflict = createUser(user);
  if (conflict) throw new Error(`createTestUser: ${seed.username} already exists`);
  return {
    username: seed.username,
    password: seed.password,
    role: user.role,
    totpSecret,
  };
}

// Run the password + TOTP dance against a built test app. Returns the
// `s3x_session` cookie string ready to attach to subsequent requests via
// `.set('Cookie', cookie)`.
export async function loginAs(app: Express, user: TestUser): Promise<string> {
  if (!user.totpSecret) {
    throw new Error('loginAs: user has no TOTP enrolled; use loginWithoutTotp instead');
  }
  const step1 = await request(app)
    .post('/auth/login')
    .send({ username: user.username, password: user.password });
  if (step1.status !== 200) {
    throw new Error(`login step1 failed (${step1.status}): ${step1.text}`);
  }
  const pendingCookie = extractCookie(step1.headers['set-cookie'], 's3x_pending');
  if (!pendingCookie) throw new Error('login step1: no s3x_pending cookie');

  const code = authenticator.generate(user.totpSecret);
  const step2 = await request(app)
    .post('/auth/totp')
    .set('Cookie', pendingCookie)
    .send({ code });
  if (step2.status !== 200) {
    throw new Error(`login step2 failed (${step2.status}): ${step2.text}`);
  }
  const sessionCookie = extractCookie(step2.headers['set-cookie'], 's3x_session');
  if (!sessionCookie) throw new Error('login step2: no s3x_session cookie');
  return sessionCookie;
}

// Convenience: seed an admin with TOTP enrolled and return both the user and
// an active session cookie. Most integration tests need this exact setup.
// Pass a custom username when the same test file logs in as admin more than
// once (createUser enforces UNIQUE on username).
export async function loginAsAdmin(
  app: Express,
  username = 'admin-test',
): Promise<{ user: TestUser; cookie: string }> {
  const user = createTestUser({
    username,
    password: 'admin-pass-12345!',
    role: 'admin',
    totpEnrolled: true,
  });
  const cookie = await loginAs(app, user);
  return { user, cookie };
}

// Generate a fresh TOTP code for a user with a known secret. Useful when a
// test needs to re-authenticate or call a route that re-checks TOTP.
export function withTotp(user: TestUser): string {
  if (!user.totpSecret) throw new Error('withTotp: user has no TOTP secret');
  return authenticator.generate(user.totpSecret);
}

// supertest returns Set-Cookie as `string | string[] | undefined`. Pick the
// first matching cookie and return the `name=value` portion ready to set on
// a subsequent request.
function extractCookie(setCookie: unknown, name: string): string | null {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [String(setCookie)] : [];
  for (const h of headers) {
    if (typeof h !== 'string') continue;
    const first = h.split(';')[0];
    if (first.startsWith(`${name}=`)) return first;
  }
  return null;
}
