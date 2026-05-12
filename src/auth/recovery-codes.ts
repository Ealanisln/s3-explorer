import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';

export function generateRecoveryCodes(n = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    // 10 chars hex split by hyphen for legibility: xxxxx-xxxxx
    const raw = crypto.randomBytes(5).toString('hex');
    codes.push(raw.slice(0, 5) + '-' + raw.slice(5));
  }
  return codes;
}

export function hashCodes(codes: string[]): string[] {
  return codes.map((c) => bcrypt.hashSync(c, 10));
}
