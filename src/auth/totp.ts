import * as crypto from 'crypto';
import { authenticator } from 'otplib';
import { audit } from './audit';

// CD-SEC-010: AES-256-GCM key for encrypting TOTP secrets at rest.
// Must be 64 hex chars (32 bytes). If absent, an ephemeral key is generated
// and existing secrets become undecryptable on next restart — production MUST
// set this.
// Fail closed in production: an ephemeral key there silently makes every
// existing encrypted TOTP secret undecryptable on the next restart, locking all
// users out of 2FA. Refuse to boot rather than warn-and-continue. Dev keeps the
// ephemeral fallback for convenience.
if (!process.env.TOTP_ENCRYPTION_KEY && process.env.NODE_ENV === 'production') {
  throw new Error('[auth] TOTP_ENCRYPTION_KEY must be set in production. Generate: openssl rand -hex 32');
}

const TOTP_KEY_HEX = process.env.TOTP_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const TOTP_KEY = Buffer.from(TOTP_KEY_HEX, 'hex');
if (TOTP_KEY.length !== 32) {
  throw new Error('[auth] TOTP_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Generate: openssl rand -hex 32');
}

if (!process.env.TOTP_ENCRYPTION_KEY) {
  console.warn('[auth] TOTP_ENCRYPTION_KEY not set — generated ephemeral key. ' +
    'EXISTING TOTP SECRETS WILL BECOME UNDECRYPTABLE ON RESTART. Set TOTP_ENCRYPTION_KEY in production.');
}

export function encryptTotpSecret(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', TOTP_KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptTotpSecret(stored: string | null | undefined, contextUsername?: string): string | null {
  if (!stored) return null;
  // Backward-compatible: handles legacy cleartext secrets from before CD-SEC-010.
  // SEC2-04: audit when this fallback fires so unexpected cleartext (e.g. someone
  // hand-edited users.json or downgraded) is visible in logs.
  if (!stored.startsWith('enc:v1:')) {
    audit('totp_legacy_cleartext_loaded', { username: contextUsername || '(unknown)' });
    return stored;
  }
  const [, , ivB64, tagB64, ctB64] = stored.split(':');
  if (!ivB64 || !tagB64 || !ctB64) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', TOTP_KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function checkTotpCode(code: string, secret: string): boolean {
  return authenticator.check(code, secret);
}

export function buildOtpAuthUri(username: string, secret: string): string {
  return authenticator.keyuri(username, 'S3 Explorer', secret);
}
