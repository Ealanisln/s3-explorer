export const version = 2;

// File-index feature (MR 8):
//
// - `bucket_index`: one row per (user, connection_id, bucket, key). Scoped by
//   user + their client-generated connection UUID + bucket so two users (or
//   the same user across two connections) keep their indexes apart.
//
// - `bucket_index_fts`: external-content FTS5 virtual table mirroring `key`.
//   Triggers keep it in sync. `unicode61` is the recommended tokenizer for
//   path-like strings (handles accents, normalizes Unicode).
//
// - `bucket_index_status`: per-bucket metadata. Surfaced via /api/index/.../status
//   so the SPA can show "indexed N objects, X minutes ago" + a staleness badge.
//
// The user-supplied connection_id is a UUID (validated at the route boundary
// in src/index/routes.ts), so no further sanitization needed in queries —
// these go through bound parameters anyway.

export const sql = `
CREATE TABLE bucket_index (
  id              INTEGER PRIMARY KEY,
  username        TEXT NOT NULL,
  connection_id   TEXT NOT NULL,
  bucket          TEXT NOT NULL,
  key             TEXT NOT NULL,
  size            INTEGER,
  modified        TEXT,
  etag            TEXT,
  storage_class   TEXT,
  indexed_at      TEXT NOT NULL,
  UNIQUE(username, connection_id, bucket, key)
);
CREATE INDEX idx_bucket_index_scope ON bucket_index(username, connection_id, bucket);

CREATE VIRTUAL TABLE bucket_index_fts USING fts5(
  key,
  content='bucket_index',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER bucket_index_ai AFTER INSERT ON bucket_index BEGIN
  INSERT INTO bucket_index_fts(rowid, key) VALUES (new.id, new.key);
END;
CREATE TRIGGER bucket_index_ad AFTER DELETE ON bucket_index BEGIN
  INSERT INTO bucket_index_fts(bucket_index_fts, rowid, key) VALUES('delete', old.id, old.key);
END;
CREATE TRIGGER bucket_index_au AFTER UPDATE ON bucket_index BEGIN
  INSERT INTO bucket_index_fts(bucket_index_fts, rowid, key) VALUES('delete', old.id, old.key);
  INSERT INTO bucket_index_fts(rowid, key) VALUES (new.id, new.key);
END;

CREATE TABLE bucket_index_status (
  username         TEXT NOT NULL,
  connection_id    TEXT NOT NULL,
  bucket           TEXT NOT NULL,
  last_indexed_at  TEXT,
  object_count     INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  PRIMARY KEY (username, connection_id, bucket)
);
`;
