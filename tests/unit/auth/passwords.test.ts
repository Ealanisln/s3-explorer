import * as bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import {
  FAKE_HASH,
  hashPassword,
  hashPasswordSync,
  isPasswordBreached,
  shouldRehash,
  verifyPassword,
} from '../../../src/auth/passwords';

describe('passwords', () => {
  describe('hashPassword / hashPasswordSync', () => {
    it('produces an argon2id hash (not bcrypt)', async () => {
      const h = await hashPassword('hunter2');
      expect(h).toMatch(/^\$argon2id\$/);
    });

    it('sync variant matches async format', () => {
      const h = hashPasswordSync('hunter2');
      expect(h).toMatch(/^\$argon2id\$/);
    });

    it('produces different hashes for the same input (random salt)', async () => {
      const a = await hashPassword('same-input');
      const b = await hashPassword('same-input');
      expect(a).not.toBe(b);
    });
  });

  describe('verifyPassword', () => {
    it('verifies an argon2id hash', async () => {
      const h = await hashPassword('correct horse battery staple');
      expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
      expect(await verifyPassword('wrong', h)).toBe(false);
    });

    it('verifies legacy bcrypt hashes (transparent multi-algo support)', async () => {
      const bcryptHash = bcrypt.hashSync('legacy-pass', 4);
      expect(bcryptHash.startsWith('$2')).toBe(true);
      expect(await verifyPassword('legacy-pass', bcryptHash)).toBe(true);
      expect(await verifyPassword('wrong', bcryptHash)).toBe(false);
    });

    it('returns false for missing/empty/unknown-format hashes', async () => {
      expect(await verifyPassword('x', null)).toBe(false);
      expect(await verifyPassword('x', undefined)).toBe(false);
      expect(await verifyPassword('x', '')).toBe(false);
      expect(await verifyPassword('x', 'not-a-known-format')).toBe(false);
    });

    it('returns false on argon2 internal errors (catches and fails closed)', async () => {
      // Malformed argon2 prefix → argon2.verify throws → catch returns false
      expect(await verifyPassword('x', '$argon2id$NOT-VALID')).toBe(false);
    });
  });

  describe('shouldRehash', () => {
    it('returns true for bcrypt hashes', () => {
      expect(shouldRehash('$2a$04$abcdefghijklmnopqrstuv')).toBe(true);
      expect(shouldRehash('$2b$04$abcdefghijklmnopqrstuv')).toBe(true);
      expect(shouldRehash('$2y$04$abcdefghijklmnopqrstuv')).toBe(true);
    });

    it('returns false for argon2id hashes', () => {
      const h = hashPasswordSync('x');
      expect(shouldRehash(h)).toBe(false);
    });

    it('returns false for empty/unknown', () => {
      expect(shouldRehash(null)).toBe(false);
      expect(shouldRehash(undefined)).toBe(false);
      expect(shouldRehash('')).toBe(false);
      expect(shouldRehash('plaintext')).toBe(false);
    });
  });

  describe('FAKE_HASH (CD-SEC-002 constant-time sentinel)', () => {
    it('is a valid argon2id hash', () => {
      expect(FAKE_HASH).toMatch(/^\$argon2id\$/);
    });

    it('does not verify against any reasonable guess', async () => {
      expect(await verifyPassword('not-a-real-password', FAKE_HASH)).toBe(true);
      // Real attackers don't know the sentinel value — verify they can't guess it.
      expect(await verifyPassword('password', FAKE_HASH)).toBe(false);
      expect(await verifyPassword('', FAKE_HASH)).toBe(false);
    });
  });

  describe('isPasswordBreached', () => {
    it('returns false when CHECK_HIBP=0 (default in tests, fail-open)', async () => {
      // tests/setup.ts pins CHECK_HIBP=0, so we never reach the network.
      expect(await isPasswordBreached('password123')).toBe(false);
      expect(await isPasswordBreached('any-string-at-all')).toBe(false);
    });
  });
});
