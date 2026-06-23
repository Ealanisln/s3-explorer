import { db } from './connection';
import * as migration001 from './migrations/001_init';
import * as migration002 from './migrations/002_index';
import * as migration003 from './migrations/003_totp_step';

interface Migration {
  version: number;
  sql: string;
}

// Add new migrations here in order. Each runs once, atomically, in a
// transaction. The schema_version table records what has been applied.
const MIGRATIONS: Migration[] = [
  migration001,
  migration002,
  migration003,
];

export function applyMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_version').all() as { version: number }[];
  const applied = new Set(appliedRows.map((r) => r.version));

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
        .run(m.version, new Date().toISOString());
    });
    tx();
    console.log(`[db] applied migration v${m.version}`);
  }
}
