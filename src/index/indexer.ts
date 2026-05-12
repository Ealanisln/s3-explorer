import { type S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { db } from '../db';

interface IndexScope {
  username: string;
  connectionId: string;
  bucket: string;
}

const stmtClearScope = db.prepare<[string, string, string]>(
  'DELETE FROM bucket_index WHERE username = ? AND connection_id = ? AND bucket = ?',
);

const stmtUpsertObject = db.prepare(`
  INSERT INTO bucket_index (
    username, connection_id, bucket, key, size, modified, etag, storage_class, indexed_at
  ) VALUES (
    @username, @connectionId, @bucket, @key, @size, @modified, @etag, @storageClass, @indexedAt
  )
  ON CONFLICT(username, connection_id, bucket, key) DO UPDATE SET
    size          = excluded.size,
    modified      = excluded.modified,
    etag          = excluded.etag,
    storage_class = excluded.storage_class,
    indexed_at    = excluded.indexed_at
`);

const stmtUpsertStatus = db.prepare(`
  INSERT INTO bucket_index_status (
    username, connection_id, bucket, last_indexed_at, object_count, last_error
  ) VALUES (
    @username, @connectionId, @bucket, @lastIndexedAt, @objectCount, NULL
  )
  ON CONFLICT(username, connection_id, bucket) DO UPDATE SET
    last_indexed_at = excluded.last_indexed_at,
    object_count    = excluded.object_count,
    last_error      = NULL
`);

const stmtSetError = db.prepare(`
  INSERT INTO bucket_index_status (
    username, connection_id, bucket, last_indexed_at, object_count, last_error
  ) VALUES (
    @username, @connectionId, @bucket, NULL, 0, @error
  )
  ON CONFLICT(username, connection_id, bucket) DO UPDATE SET
    last_error = excluded.last_error
`);

const stmtDeleteScope = db.prepare<[string, string, string]>(
  'DELETE FROM bucket_index WHERE username = ? AND connection_id = ? AND bucket = ?',
);
const stmtDeleteStatus = db.prepare<[string, string, string]>(
  'DELETE FROM bucket_index_status WHERE username = ? AND connection_id = ? AND bucket = ?',
);

interface UpsertRow {
  username: string;
  connectionId: string;
  bucket: string;
  key: string;
  size: number | null;
  modified: string | null;
  etag: string | null;
  storageClass: string | null;
  indexedAt: string;
}

// Bulk-write transaction. better-sqlite3 transactions are synchronous; calling
// site builds the array then invokes the prepared transaction once per chunk.
const txUpsertChunk = db.transaction((rows: UpsertRow[]) => {
  for (const r of rows) stmtUpsertObject.run(r);
});

export interface RebuildResult {
  count: number;
  durationMs: number;
}

/**
 * Pages through ListObjectsV2 for the whole bucket and writes each chunk into
 * `bucket_index` inside a SQLite transaction. The previous index for this
 * (user, connection, bucket) scope is cleared up front so a rebuild always
 * leaves a clean snapshot — no stale rows from objects that were deleted in
 * S3 since the last index.
 *
 * `chunkSize` controls how many ListObjectsV2 results buffer in memory before
 * we flush a transaction. 10k is a good balance: ~1MB of strings in RAM,
 * ~50ms per chunk to insert on a warm DB.
 */
export async function rebuildBucketIndex(
  s3: S3Client,
  scope: IndexScope,
  opts: { chunkSize?: number; pageCap?: number } = {},
): Promise<RebuildResult> {
  const { username, connectionId, bucket } = scope;
  const chunkSize = opts.chunkSize ?? 10_000;
  const pageCap = opts.pageCap ?? 5_000; // 5000 pages × 1000 = 5M objects ceiling

  const start = Date.now();
  stmtClearScope.run(username, connectionId, bucket);

  let token: string | undefined;
  let pages = 0;
  let total = 0;
  let buffer: UpsertRow[] = [];
  const indexedAt = new Date().toISOString();

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const out = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: token,
        MaxKeys: 1000,
      }));
      for (const o of out.Contents || []) {
        if (!o.Key) continue;
        buffer.push({
          username,
          connectionId,
          bucket,
          key: o.Key,
          size: o.Size ?? null,
          modified: o.LastModified ? o.LastModified.toISOString() : null,
          etag: o.ETag ?? null,
          storageClass: o.StorageClass ?? null,
          indexedAt,
        });
        if (buffer.length >= chunkSize) {
          txUpsertChunk(buffer);
          total += buffer.length;
          buffer = [];
        }
      }
      pages++;
      if (!out.IsTruncated) break;
      if (pages >= pageCap) break;
      token = out.NextContinuationToken;
    }
    if (buffer.length) {
      txUpsertChunk(buffer);
      total += buffer.length;
    }
    stmtUpsertStatus.run({
      username,
      connectionId,
      bucket,
      lastIndexedAt: indexedAt,
      objectCount: total,
    });
    return { count: total, durationMs: Date.now() - start };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stmtSetError.run({ username, connectionId, bucket, error: msg });
    throw e;
  }
}

const stmtSearchFts = db.prepare<[string, string, string, string, number]>(`
  SELECT bi.key, bi.size, bi.modified, bi.etag, bi.storage_class
  FROM bucket_index_fts fts
  JOIN bucket_index bi ON bi.id = fts.rowid
  WHERE bucket_index_fts MATCH ?
    AND bi.username = ?
    AND bi.connection_id = ?
    AND bi.bucket = ?
  ORDER BY rank
  LIMIT ?
`);

interface SearchRow {
  key: string;
  size: number | null;
  modified: string | null;
  etag: string | null;
  storage_class: string | null;
}

export interface SearchHit {
  Key: string;
  Size: number | null;
  LastModified: string | null;
  ETag: string | null;
  StorageClass: string | null;
}

// FTS5 has its own operator/phrase syntax (`foo*`, `"phrase"`, `:col`, `NOT`,
// `AND`, `OR`, parens). The user's `q` parameter is treated as plain text:
//
//   - Pure alphanumeric tokens   → each becomes a prefix query (`foo*`).
//     "contract"       → contract*
//     "foo bar"        → foo* bar*
//
//   - Anything with punctuation  → wrap the whole thing as a phrase.
//     "docs/contract"  → "docs/contract"   (FTS tokenizer splits on /,
//                                           phrase matches consecutive tokens)
//     "foo'; --"       → "foo --"          (single quotes + control chars
//                                           stripped; no SQL injection
//                                           because the value is bound as a
//                                           parameter, not interpolated)
//
// Empty / whitespace-only query  → `""`, which matches no rows.
function buildMatchExpr(raw: string): string {
  // Strip control chars, double quotes (would close our phrase early), and
  // single quotes (FTS5 syntax-special at top level). Lowercase neutralizes
  // FTS5 boolean operators (OR / AND / NOT / NEAR are only recognized in
  // upper case at the parser level — lowercase becomes a regular token, and
  // unicode61 tokenizer already case-folds the indexed content anyway, so
  // search semantics are unchanged.) Multi-space → single.
  const safe = raw
    .replace(/[\x00-\x1f"']/g, '')   // eslint-disable-line no-control-regex
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
  if (!safe) return '""';
  if (/^[\p{Letter}\p{Number}_-]+( [\p{Letter}\p{Number}_-]+)*$/u.test(safe)) {
    return safe.split(' ').map((t) => `${t}*`).join(' ');
  }
  return `"${safe}"`;
}

export function searchIndex(scope: IndexScope, query: string, limit: number): SearchHit[] {
  const match = buildMatchExpr(query);
  let rows: SearchRow[];
  try {
    rows = stmtSearchFts.all(
      match,
      scope.username,
      scope.connectionId,
      scope.bucket,
      limit,
    ) as SearchRow[];
  } catch (e) {
    // FTS5 can still reject a malformed expression we didn't anticipate.
    // Failing closed (empty result) keeps the SPA usable instead of bubbling
    // up a 500. The DB itself is unaffected — the SqliteError is a parser
    // error from the MATCH clause, nothing is mutated.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[index/search] FTS5 parse error for query=%j → %s', query, msg);
    return [];
  }
  return rows.map((r) => ({
    Key: r.key,
    Size: r.size,
    LastModified: r.modified,
    ETag: r.etag,
    StorageClass: r.storage_class,
  }));
}

const stmtGetStatus = db.prepare<[string, string, string]>(`
  SELECT last_indexed_at, object_count, last_error
  FROM bucket_index_status
  WHERE username = ? AND connection_id = ? AND bucket = ?
`);

export interface IndexStatus {
  last_indexed_at: string | null;
  object_count: number;
  last_error: string | null;
  stale: boolean;
}

const STALE_HOURS = 24;

export function getIndexStatus(scope: IndexScope): IndexStatus {
  const row = stmtGetStatus.get(scope.username, scope.connectionId, scope.bucket) as
    | { last_indexed_at: string | null; object_count: number; last_error: string | null }
    | undefined;
  if (!row) {
    return { last_indexed_at: null, object_count: 0, last_error: null, stale: true };
  }
  let stale = true;
  if (row.last_indexed_at) {
    const age = Date.now() - new Date(row.last_indexed_at).getTime();
    stale = age > STALE_HOURS * 60 * 60 * 1000;
  }
  return { ...row, stale };
}

export function deleteBucketIndex(scope: IndexScope): { deletedRows: number } {
  const r = stmtDeleteScope.run(scope.username, scope.connectionId, scope.bucket);
  stmtDeleteStatus.run(scope.username, scope.connectionId, scope.bucket);
  return { deletedRows: r.changes };
}
