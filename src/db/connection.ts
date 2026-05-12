import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

// Re-export the type so consumers can write `import type { DB } from '../db/connection'`
// without re-touching the better-sqlite3 namespace. Also needed so `composite: true`
// emits a clean .d.ts for the `db` export.
export type DB = Database.Database;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

// `better-sqlite3` is sync. Fine for this app — every endpoint is a single
// short transaction, and Express handles concurrency via the Node event loop.
//
// WAL mode lets readers proceed while a writer holds the lock; NORMAL sync
// is durable enough for our threat model (worst case: lose the last commit
// on power loss) without the throughput hit of FULL fsync per write.
// foreign_keys ON is the standard SQLite footgun fix.
export const db: DB = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000'); // wait up to 5s for write lock

console.log(`[db] open ${DB_PATH} (WAL, FK on, busy_timeout=5s)`);
