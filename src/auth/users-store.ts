import { db, ensureDbInit } from '../db';
import { audit } from './audit';
import { hashPasswordSync } from './passwords';
import type { User, UserRole } from '../types';

// MUST run before any prepared statements touch the schema. The DB module
// guarantees this is a no-op on subsequent calls.
ensureDbInit();

const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

interface UserRow {
  username: string;
  password_hash: string;
  totp_secret: string | null;
  totp_confirmed: number;
  recovery_codes_hashed: string;
  role: string;
  disabled: number;
  must_change_password: number;
  created_at: string;
  last_login_at: string | null;
  last_totp_step: number;
}

function rowToUser(row: UserRow): User {
  return {
    username: row.username,
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret,
    totpConfirmed: !!row.totp_confirmed,
    recoveryCodesHashed: JSON.parse(row.recovery_codes_hashed || '[]') as (string | null)[],
    role: (row.role === 'admin' ? 'admin' : 'user') as UserRole,
    disabled: !!row.disabled,
    mustChangePassword: !!row.must_change_password,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    lastTotpStep: row.last_totp_step ?? 0,
  };
}

// Prepared statements — compiled once, reused for every request.
const stmtFindUser = db.prepare<[string]>('SELECT * FROM users WHERE LOWER(username) = LOWER(?)');
const stmtListUsers = db.prepare('SELECT * FROM users ORDER BY username');
const stmtInsertUser = db.prepare(`
  INSERT INTO users (
    username, password_hash, totp_secret, totp_confirmed,
    recovery_codes_hashed, role, disabled, must_change_password,
    created_at, last_login_at, last_totp_step
  ) VALUES (
    @username, @passwordHash, @totpSecret, @totpConfirmed,
    @recoveryCodesHashed, @role, @disabled, @mustChangePassword,
    @createdAt, @lastLoginAt, @lastTotpStep
  )
`);
const stmtCountUsers = db.prepare('SELECT COUNT(*) AS c FROM users');

export function findUser(username: string | undefined | null): User | undefined {
  if (!username) return undefined;
  const row = stmtFindUser.get(username) as UserRow | undefined;
  return row ? rowToUser(row) : undefined;
}

export function listUsers(): User[] {
  const rows = stmtListUsers.all() as UserRow[];
  return rows.map(rowToUser);
}

// Map User patch (camelCase, JS types) → SQL column updates. Only the columns
// present in `patch` are touched, so partial updates stay surgical.
type Patchable =
  | 'passwordHash'
  | 'totpSecret'
  | 'totpConfirmed'
  | 'recoveryCodesHashed'
  | 'role'
  | 'disabled'
  | 'mustChangePassword'
  | 'lastLoginAt'
  | 'lastTotpStep';

const COLUMN_MAP: Record<Patchable, string> = {
  passwordHash: 'password_hash',
  totpSecret: 'totp_secret',
  totpConfirmed: 'totp_confirmed',
  recoveryCodesHashed: 'recovery_codes_hashed',
  role: 'role',
  disabled: 'disabled',
  mustChangePassword: 'must_change_password',
  lastLoginAt: 'last_login_at',
  lastTotpStep: 'last_totp_step',
};

function patchToBindings(patch: Partial<User>): { setClauses: string[]; values: unknown[] } {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const key of Object.keys(patch) as Patchable[]) {
    const col = COLUMN_MAP[key];
    if (!col) continue; // ignore unknown / non-updatable fields
    setClauses.push(`${col} = ?`);
    let v: unknown = patch[key];
    if (key === 'totpConfirmed' || key === 'disabled' || key === 'mustChangePassword') {
      v = v ? 1 : 0;
    } else if (key === 'recoveryCodesHashed') {
      v = JSON.stringify(v ?? []);
    }
    values.push(v);
  }
  return { setClauses, values };
}

// Async signature is preserved so call sites in routes.ts don't change. The
// underlying SQLite write IS sync — the Promise wrapper is just for API
// continuity with the old mutex-based implementation.
export async function updateUser(username: string, patch: Partial<User>): Promise<User | null> {
  const { setClauses, values } = patchToBindings(patch);
  if (setClauses.length === 0) {
    return findUser(username) ?? null;
  }
  const sql = `UPDATE users SET ${setClauses.join(', ')} WHERE LOWER(username) = LOWER(?)`;
  const stmt = db.prepare(sql);
  const result = stmt.run(...values, username);
  if (result.changes === 0) return null;
  return findUser(username) ?? null;
}

// Replaces the old `withUsers` "transaction-around-array-mutation" pattern.
// The only caller (admin user creation) just needs: insert-if-not-exists.
// Returns true on conflict, false on success.
export function createUser(user: User): boolean {
  try {
    stmtInsertUser.run({
      username: user.username,
      passwordHash: user.passwordHash,
      totpSecret: user.totpSecret ?? null,
      totpConfirmed: user.totpConfirmed ? 1 : 0,
      recoveryCodesHashed: JSON.stringify(user.recoveryCodesHashed || []),
      role: user.role === 'admin' ? 'admin' : 'user',
      disabled: user.disabled ? 1 : 0,
      mustChangePassword: user.mustChangePassword ? 1 : 0,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt ?? null,
      lastTotpStep: user.lastTotpStep ?? 0,
    });
    return false;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (
      err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
      err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      /UNIQUE constraint failed/i.test(err.message || '')
    ) {
      return true;
    }
    throw e;
  }
}

// Bootstrap admin from env on first boot. Runs synchronously at module load,
// AFTER ensureDbInit() (which already migrated any legacy users.json above).
// If the DB has any users, this is a no-op.
(function bootstrapAdmin() {
  const count = (stmtCountUsers.get() as { c: number }).c;
  if (count > 0) return;
  if (!ADMIN_USER || !ADMIN_PASS) {
    console.warn('[auth] No users found and ADMIN_USER/ADMIN_PASS not set. ' +
      'Set them in env to bootstrap the first admin.');
    return;
  }
  const user: User = {
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
    lastTotpStep: 0,
  };
  createUser(user);
  audit('admin_bootstrapped', { username: ADMIN_USER });
  console.log(`[auth] Bootstrapped admin user "${ADMIN_USER}". Must enroll TOTP on first login.`);
})();
