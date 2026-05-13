import type { Express } from 'express';
import { createApp } from '../../src/server';

// Builds a fresh Express app for a single test file. Vitest's `pool: 'forks'`
// + `isolate: true` ensures each test file gets a fresh module graph, so the
// DB (`:memory:`) and singleton state inside src/ start clean per file.
export function buildTestApp(): Express {
  return createApp();
}
