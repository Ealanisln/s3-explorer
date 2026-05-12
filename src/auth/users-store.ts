import * as fs from 'fs';
import * as path from 'path';
import { audit } from './audit';
import { hashPasswordSync } from './passwords';
import type { User } from '../types';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

fs.mkdirSync(DATA_DIR, { recursive: true });

// SEC2-03: serialize all read-modify-write operations through a promise-chain
// mutex so concurrent updateUser/saveUsers calls don't lose updates.
let userStoreLock: Promise<unknown> = Promise.resolve();

function withUserStoreLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = userStoreLock.then(fn, fn) as Promise<T>;
  userStoreLock = next.then(() => undefined, () => undefined); // never leave the chain rejected
  return next;
}

function loadUsers(): User[] {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) as User[]; }
  catch { return []; }
}

function saveUsersSync(users: User[]): void {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

export function findUser(username: string | undefined | null): User | undefined {
  return loadUsers().find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
}

export function listUsers(): User[] {
  return loadUsers();
}

// Async because callers can be async. The mutex ensures load+modify+save runs atomically.
export function updateUser(username: string, patch: Partial<User>): Promise<User | null> {
  return withUserStoreLock(() => {
    const users = loadUsers();
    const i = users.findIndex((u) => u.username.toLowerCase() === username.toLowerCase());
    if (i < 0) return null;
    users[i] = { ...users[i], ...patch } as User;
    saveUsersSync(users);
    return users[i];
  });
}

// For multi-step writes (e.g. push new user). Caller mutates the array in-place.
export function withUsers<T>(fn: (users: User[]) => T): Promise<T> {
  return withUserStoreLock(() => {
    const users = loadUsers();
    const result = fn(users);
    saveUsersSync(users);
    return result;
  });
}

// Bootstrap admin from env on first boot. Runs synchronously at module load,
// before any request can race with it.
(function bootstrapAdmin() {
  if (loadUsers().length > 0) return;
  if (!ADMIN_USER || !ADMIN_PASS) {
    console.warn('[auth] No users found and ADMIN_USER/ADMIN_PASS not set. ' +
      'Set them in env to bootstrap the first admin.');
    return;
  }
  const users: User[] = [{
    username: ADMIN_USER,
    passwordHash: hashPasswordSync(ADMIN_PASS),
    totpSecret: null,
    totpConfirmed: false,
    recoveryCodesHashed: [],
    role: 'admin',
    disabled: false,
    mustChangePassword: false,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  }];
  saveUsersSync(users);
  audit('admin_bootstrapped', { username: ADMIN_USER });
  console.log(`[auth] Bootstrapped admin user "${ADMIN_USER}". Must enroll TOTP on first login.`);
})();
