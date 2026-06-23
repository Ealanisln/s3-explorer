import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';

export function generateRecoveryCodes(n = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    // 128 bits of entropy (16 bytes → 32 hex chars), grouped 8-8-8-8 with
    // hyphens for legibility: xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxx. Bumped from
    // the old 40-bit (xxxxx-xxxxx) codes — see SECURITY.md. Codes already
    // issued keep working: the login verifier accepts both formats.
    const raw = crypto.randomBytes(16).toString('hex');
    codes.push((raw.match(/.{8}/g) as string[]).join('-'));
  }
  return codes;
}

export function hashCodes(codes: string[]): string[] {
  return codes.map((c) => bcrypt.hashSync(c, 10));
}
