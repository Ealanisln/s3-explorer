// AES-256-GCM with a key derived from the user's passphrase via PBKDF2.
// Mirror of the legacy app.js helpers — same iteration count, same salt
// length, same envelope shape, so vaults persisted before the TS migration
// decrypt unchanged.

import type { VaultEnvelope } from '../types.js';

const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    // TS 5+ tightens BufferSource to ArrayBuffer-only; Uint8Array<ArrayBufferLike>
    // (what `b64dec` returns) doesn't match. The runtime accepts it fine — cast
    // through BufferSource to satisfy the compiler without copying the bytes.
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function b64(buf: ArrayBuffer | Uint8Array): string {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...arr));
}

export function b64dec(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

export async function encryptVault(
  plaintextObj: unknown,
  key: CryptoKey,
): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(JSON.stringify(plaintextObj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: b64(iv), ct: b64(ct) };
}

export async function decryptVault<T = unknown>(envelope: VaultEnvelope, key: CryptoKey): Promise<T> {
  const iv = b64dec(envelope.iv);
  const ct = b64dec(envelope.ct);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
