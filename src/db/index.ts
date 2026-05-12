// Single entry point that brings the DB up: open connection (via the import
// side effect in `./connection`), apply migrations, then run any one-shot
// legacy-JSON migrations. Idempotent: subsequent calls are no-ops.

import { applyMigrations } from './migrations';
import { migrateLegacyJson } from '../startup/migrate-users-json';

export { db } from './connection';

let initialized = false;

export function ensureDbInit(): void {
  if (initialized) return;
  applyMigrations();
  migrateLegacyJson();
  initialized = true;
}
