import * as argon2 from '@node-rs/argon2';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';

// CD-SEC-008: argon2id for password hashing (OWASP-recommended 2023+).
// Params: m=19456 KiB (~19 MB), t=2 iterations, p=1 parallelism — OWASP defaults.
const ARGON2_OPTS: argon2.Options = {
  algorithm: argon2.Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTS);
}

export function hashPasswordSync(plain: string): string {
  return argon2.hashSync(plain, ARGON2_OPTS);
}

// Accepts both bcrypt (legacy) and argon2id (current) hashes.
export async function verifyPassword(plain: string, hashed: string | null | undefined): Promise<boolean> {
  if (!hashed) return false;
  try {
    if (hashed.startsWith('$argon2')) return await argon2.verify(hashed, plain);
    if (hashed.startsWith('$2')) return await bcrypt.compare(plain, hashed); // legacy bcrypt
    return false;
  } catch {
    return false;
  }
}

// Should this hash come from a legacy algorithm and be re-hashed on next login?
export function shouldRehash(hashed: string | null | undefined): boolean {
  return typeof hashed === 'string' && hashed.startsWith('$2'); // bcrypt → argon2id
}

// CD-SEC-002: pre-computed sentinel hash for constant-time login when user
// doesn't exist. Module-load-time sync so cost is amortized across the process.
export const FAKE_HASH: string = argon2.hashSync('not-a-real-password', ARGON2_OPTS);

// HIBP k-anonymity password breach check. Sends only the first 5 chars of the
// SHA-1 of the password; the full hash and password never leave the server.
// Enable with CHECK_HIBP=1. Fails open if HIBP is unreachable (3s timeout).
const HIBP_ENABLED = (process.env.CHECK_HIBP || '0') === '1';

export async function isPasswordBreached(password: string): Promise<boolean> {
  if (!HIBP_ENABLED) return false;
  try {
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 's3-explorer' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return false; // fail open
    const text = await res.text();
    for (const line of text.split('\n')) {
      const [s, count] = line.trim().split(':');
      if (s === suffix && parseInt(count || '0', 10) > 0) return true;
    }
    return false;
  } catch {
    return false; // network/timeout/abort — fail open, don't block password set
  }
}
