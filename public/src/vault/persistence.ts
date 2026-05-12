// localStorage I/O for the encrypted connection vault. The key derivation +
// crypto live in ./crypto.ts; this module only handles the storage layer +
// the in-memory CryptoKey lifecycle.

import { State } from '../state.js';
import { encryptVault } from './crypto.js';
import type { Connection, VaultEnvelope } from '../types.js';

export const VAULT_KEY = 's3-explorer-vault-v1';
export const LEGACY_STORAGE_KEY = 's3-explorer-connections';

let vaultKeyRef: CryptoKey | null = null;
let pendingMigrationRef: Connection[] | null = null;

export function getVaultKey(): CryptoKey | null {
  return vaultKeyRef;
}

export function setVaultKey(key: CryptoKey | null): void {
  vaultKeyRef = key;
}

export function getPendingMigration(): Connection[] | null {
  return pendingMigrationRef;
}

export function setPendingMigration(v: Connection[] | null): void {
  pendingMigrationRef = v;
}

export function getVault(): VaultEnvelope | null {
  try {
    return JSON.parse(localStorage.getItem(VAULT_KEY) || 'null') as VaultEnvelope | null;
  } catch {
    return null;
  }
}

export function readLegacyConnections(): Connection[] {
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '[]') as Connection[];
    return Array.isArray(legacy) ? legacy : [];
  } catch {
    return [];
  }
}

export function clearLegacy(): void {
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

export function clearVault(): void {
  localStorage.removeItem(VAULT_KEY);
}

export async function saveConnections(): Promise<void> {
  const key = vaultKeyRef;
  if (!key) throw new Error('Vault is locked');
  const vault = getVault();
  const salt = vault?.salt || b64FreshSalt();
  const envelope = await encryptVault(State.connections, key);
  const stored: VaultEnvelope = { v: 1, salt, iv: envelope.iv, ct: envelope.ct };
  localStorage.setItem(VAULT_KEY, JSON.stringify(stored));
}

function b64FreshSalt(): string {
  const buf = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...buf));
}

export function lockVault(): void {
  vaultKeyRef = null;
  State.connections = [];
  State.activeConnId = null;
}
