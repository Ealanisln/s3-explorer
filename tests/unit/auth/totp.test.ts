import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticator } from 'otplib';
import {
  buildOtpAuthUri,
  checkTotpCode,
  currentTotpStep,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
} from '../../../src/auth/totp';

describe('totp', () => {
  describe('encryptTotpSecret / decryptTotpSecret', () => {
    it('round-trips a secret', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const enc = encryptTotpSecret(secret);
      expect(enc).toMatch(/^enc:v1:/);
      const parts = (enc ?? '').split(':');
      expect(parts).toHaveLength(5);
      expect(parts[0]).toBe('enc');
      expect(parts[1]).toBe('v1');
      const dec = decryptTotpSecret(enc);
      expect(dec).toBe(secret);
    });

    it('uses a fresh IV per encryption so ciphertexts differ', () => {
      const a = encryptTotpSecret('hello-world');
      const b = encryptTotpSecret('hello-world');
      expect(a).not.toBe(b);
      expect(decryptTotpSecret(a)).toBe('hello-world');
      expect(decryptTotpSecret(b)).toBe('hello-world');
    });

    it('returns null for empty inputs (encrypt)', () => {
      expect(encryptTotpSecret(null)).toBeNull();
      expect(encryptTotpSecret(undefined)).toBeNull();
      expect(encryptTotpSecret('')).toBeNull();
    });

    it('returns null for empty inputs (decrypt)', () => {
      expect(decryptTotpSecret(null)).toBeNull();
      expect(decryptTotpSecret(undefined)).toBeNull();
      expect(decryptTotpSecret('')).toBeNull();
    });

    it('returns null when the encrypted blob is malformed', () => {
      expect(decryptTotpSecret('enc:v1:onlyone')).toBeNull();
      expect(decryptTotpSecret('enc:v1::tag:ct')).toBeNull();
    });

    it('throws when the auth tag is tampered with', () => {
      const enc = encryptTotpSecret('a-real-secret') as string;
      const [, , iv, , ct] = enc.split(':');
      // Replace tag with a zero-bytes tag of the right size (16 bytes).
      // AES-GCM authentication MUST fail.
      const zeroTag = Buffer.alloc(16, 0).toString('base64');
      const tampered = ['enc', 'v1', iv, zeroTag, ct].join(':');
      expect(() => decryptTotpSecret(tampered)).toThrow();
    });

    it('throws when the ciphertext is tampered with', () => {
      const enc = encryptTotpSecret('a-real-secret') as string;
      const [, , iv, tag, ct] = enc.split(':');
      // Flip the first byte of the ciphertext: XOR a 0x01 into byte 0.
      const ctBuf = Buffer.from(ct, 'base64');
      ctBuf[0] ^= 0x01;
      const tampered = ['enc', 'v1', iv, tag, ctBuf.toString('base64')].join(':');
      expect(() => decryptTotpSecret(tampered)).toThrow();
    });

    it('accepts legacy cleartext secrets and emits an audit event', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const legacy = 'JBSWY3DPEHPK3PXP';
        const result = decryptTotpSecret(legacy, 'legacy-user');
        expect(result).toBe(legacy);
        // The audit() helper emits a single JSON line to stdout.
        const auditCall = logSpy.mock.calls.find((args) => {
          const first = args[0];
          if (typeof first !== 'string') return false;
          try {
            const parsed = JSON.parse(first);
            return parsed.event === 'totp_legacy_cleartext_loaded';
          } catch { return false; }
        });
        expect(auditCall, 'expected totp_legacy_cleartext_loaded audit event').toBeDefined();
        const payload = JSON.parse((auditCall as unknown[])[0] as string);
        expect(payload.username).toBe('legacy-user');
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe('generateTotpSecret + checkTotpCode', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-13T12:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns the matched timestep for a valid code', () => {
      const secret = generateTotpSecret();
      expect(typeof secret).toBe('string');
      expect(secret.length).toBeGreaterThanOrEqual(16);
      const code = authenticator.generate(secret);
      // A freshly generated code matches the current step (delta 0).
      expect(checkTotpCode(code, secret)).toBe(currentTotpStep());
    });

    it('returns null for a code generated from a different secret', () => {
      const a = generateTotpSecret();
      const b = generateTotpSecret();
      const codeForA = authenticator.generate(a);
      expect(checkTotpCode(codeForA, b)).toBeNull();
    });

    it('returns null for obviously bad codes', () => {
      const secret = generateTotpSecret();
      expect(checkTotpCode('000000', secret)).toBeNull();
      expect(checkTotpCode('not-a-code', secret)).toBeNull();
    });
  });

  describe('currentTotpStep (replay tracking)', () => {
    it('is the 30s-floored epoch step and increases monotonically', () => {
      expect(currentTotpStep(0)).toBe(0);
      expect(currentTotpStep(29_999)).toBe(0);
      expect(currentTotpStep(30_000)).toBe(1);
      expect(currentTotpStep(1_700_000_000_000)).toBe(Math.floor(1_700_000_000_000 / 1000 / 30));
    });

    it('the matched step of a fresh code exceeds a stale stored step (replay guard math)', () => {
      const secret = generateTotpSecret();
      const code = authenticator.generate(secret);
      const matched = checkTotpCode(code, secret);
      expect(matched).not.toBeNull();
      // A user that never authenticated has lastTotpStep 0 → always accepted.
      expect(matched as number).toBeGreaterThan(0);
      // Re-checking the SAME code yields the SAME step → the route layer
      // rejects it as <= lastTotpStep once consumed.
      expect(checkTotpCode(code, secret)).toBe(matched);
    });
  });

  describe('buildOtpAuthUri', () => {
    it('emits an otpauth:// URI with the issuer and username', () => {
      const uri = buildOtpAuthUri('alice', 'JBSWY3DPEHPK3PXP');
      expect(uri.startsWith('otpauth://totp/')).toBe(true);
      expect(uri).toContain('alice');
      expect(uri).toContain('S3%20Explorer');
      expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    });
  });
});
