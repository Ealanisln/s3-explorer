import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db/connection';
import type { User } from '../types';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const REVOKED_FILE = path.join(DATA_DIR, 'revoked.json');

// One-shot import: if the DB has no users yet AND a legacy users.json exists,
// move it into the new tables and rename the JSON file to `.bak`. Idempotent —
// once the DB has users, this is a no-op even if the .json files reappear.
export function migrateLegacyJson(): void {
  const userCount = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (userCount > 0) return;

  if (fs.existsSync(USERS_FILE)) {
    try {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      const users = JSON.parse(raw) as User[];
      if (!Array.isArray(users)) throw new Error('users.json is not an array');

      const insert = db.prepare(`
        INSERT INTO users (
          username, password_hash, totp_secret, totp_confirmed,
          recovery_codes_hashed, role, disabled, must_change_password,
          created_at, last_login_at
        ) VALUES (
          @username, @passwordHash, @totpSecret, @totpConfirmed,
          @recoveryCodesHashed, @role, @disabled, @mustChangePassword,
          @createdAt, @lastLoginAt
        )
      `);

      const tx = db.transaction((rows: User[]) => {
        for (const u of rows) {
          insert.run({
            username: u.username,
            passwordHash: u.passwordHash,
            totpSecret: u.totpSecret ?? null,
            totpConfirmed: u.totpConfirmed ? 1 : 0,
            recoveryCodesHashed: JSON.stringify(u.recoveryCodesHashed || []),
            role: u.role === 'admin' ? 'admin' : 'user',
            disabled: u.disabled ? 1 : 0,
            mustChangePassword: u.mustChangePassword ? 1 : 0,
            createdAt: u.createdAt || new Date().toISOString(),
            lastLoginAt: u.lastLoginAt ?? null,
          });
        }
      });
      tx(users);

      fs.renameSync(USERS_FILE, USERS_FILE + '.bak');
      console.log(`[db] migrated ${users.length} users from users.json → SQLite (renamed to .bak)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[db] users.json migration failed:', msg);
      console.error('[db]   - The DB is empty and users.json was NOT renamed. Fix the file or remove it, then restart.');
      throw e;
    }
  }

  if (fs.existsSync(REVOKED_FILE)) {
    try {
      const raw = fs.readFileSync(REVOKED_FILE, 'utf8');
      const revoked = JSON.parse(raw) as Record<string, number>;
      const entries = Object.entries(revoked);
      const insert = db.prepare('INSERT OR IGNORE INTO revoked_sessions (jti, exp_epoch) VALUES (?, ?)');
      const tx = db.transaction((rows: [string, number][]) => {
        for (const [jti, exp] of rows) insert.run(jti, exp);
      });
      tx(entries);
      fs.renameSync(REVOKED_FILE, REVOKED_FILE + '.bak');
      console.log(`[db] migrated ${entries.length} revoked JTIs from revoked.json → SQLite (renamed to .bak)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[db] revoked.json migration failed (non-fatal):', msg);
      // Non-fatal: an empty revocation list just means stale cookies stay valid
      // until their natural TTL. Worth flagging in audit but not worth halting boot.
    }
  }
}
