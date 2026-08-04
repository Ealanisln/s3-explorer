// Personal Access Tokens (PATs) for machine/agent authentication (MCP prep).
//
// Only the SHA-256 hash of the token is stored — the plaintext is shown once
// at creation and never persisted. Lookup is by hash (unique index), so no
// constant-time comparison is needed: the presented token is hashed and used
// as an exact-match key.
//
// `scope` gates what the token can do on /api/*: 'read' allows browsing /
// inspection only; 'write' additionally allows mutations. Revocation is a
// soft flag (revoked_at) so the row remains as an audit trail.

export const version = 4;

export const sql = `
CREATE TABLE api_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,                     -- SHA-256 hex of the full token
  scope         TEXT NOT NULL CHECK(scope IN ('read','write')),
  created_at    TEXT NOT NULL,                            -- ISO 8601
  expires_at    TEXT,                                     -- ISO 8601, NULL = never expires
  last_used_at  TEXT,                                     -- ISO 8601, throttled updates
  revoked_at    TEXT                                      -- ISO 8601, NULL = active
);

CREATE INDEX idx_api_tokens_username ON api_tokens(username);
`;
