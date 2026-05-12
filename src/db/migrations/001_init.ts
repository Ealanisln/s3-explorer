// Inline SQL — kept as a TS string so the migration ships in dist/ without a
// separate file-copy step in the Dockerfile builder. Each migration has a
// numeric version + idempotent CREATE statements within an implicit
// transaction (run by the migrator).

export const version = 1;

export const sql = `
CREATE TABLE users (
  username                TEXT PRIMARY KEY,
  password_hash           TEXT NOT NULL,
  totp_secret             TEXT,                                  -- AES-GCM ciphertext (enc:v1:...) or legacy cleartext
  totp_confirmed          INTEGER NOT NULL DEFAULT 0,            -- 0/1
  recovery_codes_hashed   TEXT NOT NULL DEFAULT '[]',            -- JSON array of bcrypt hashes (slots null when burned)
  role                    TEXT NOT NULL DEFAULT 'user',          -- 'admin' | 'user'
  disabled                INTEGER NOT NULL DEFAULT 0,
  must_change_password    INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,                         -- ISO 8601
  last_login_at           TEXT                                   -- ISO 8601 nullable
);

-- Case-insensitive username uniqueness. The PRIMARY KEY is case-sensitive in
-- SQLite by default; this index plus LOWER() in queries enforces what the JSON
-- store did with .toLowerCase() comparisons.
CREATE UNIQUE INDEX idx_users_username_ci ON users(LOWER(username));

CREATE TABLE revoked_sessions (
  jti        TEXT PRIMARY KEY,
  exp_epoch  INTEGER NOT NULL
);
CREATE INDEX idx_revoked_exp ON revoked_sessions(exp_epoch);
`;
