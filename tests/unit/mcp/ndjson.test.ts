import { describe, it, expect } from 'vitest';
import { aggregateSearchNdjson } from '../../../src/mcp/ndjson';

async function* chunks(...parts: Array<string | Uint8Array>): AsyncIterable<string | Uint8Array> {
  for (const p of parts) yield p;
}

function line(frame: Record<string, unknown>): string {
  return JSON.stringify(frame) + '\n';
}

describe('aggregateSearchNdjson', () => {
  it('aggregates hit and folder-hit frames with scanned from done', async () => {
    const agg = await aggregateSearchNdjson(chunks(
      line({ t: 'hit', key: 'docs/report.pdf', size: 42, modified: '2026-01-01T00:00:00.000Z' }),
      line({ t: 'folder-hit', key: 'reports/' }),
      line({ t: 'progress', scanned: 100 }),
      line({ t: 'done', scanned: 250, hits: 2, reason: 'complete' }),
    ), 200);
    expect(agg.results).toEqual([
      { type: 'file', key: 'docs/report.pdf', size: 42, modified: '2026-01-01T00:00:00.000Z' },
      { type: 'folder', key: 'reports/' },
    ]);
    expect(agg.scanned).toBe(250);
    expect(agg.truncated).toBe(false);
    expect(agg.error).toBeUndefined();
  });

  it('caps results locally and marks truncated', async () => {
    const frames = Array.from({ length: 10 }, (_, i) => line({ t: 'hit', key: `m-${i}.txt` }));
    const agg = await aggregateSearchNdjson(chunks(frames.join('')), 3);
    expect(agg.results).toHaveLength(3);
    expect(agg.truncated).toBe(true);
  });

  it('marks truncated when the server reports reason=limit', async () => {
    const agg = await aggregateSearchNdjson(chunks(
      line({ t: 'hit', key: 'a.txt' }),
      line({ t: 'done', scanned: 5000, hits: 1, reason: 'limit' }),
    ), 200);
    expect(agg.results).toHaveLength(1);
    expect(agg.truncated).toBe(true);
  });

  it('surfaces an error frame', async () => {
    const agg = await aggregateSearchNdjson(chunks(
      line({ t: 'error', error: 'AccessDenied', message: 'Acceso denegado', errorId: 'err-12345678' }),
    ), 200);
    expect(agg.error).toBe('Acceso denegado');
  });

  it('handles frames split across chunks and binary chunks', async () => {
    const encoder = new TextEncoder();
    const full = line({ t: 'hit', key: 'split-across-chunks.txt' });
    const agg = await aggregateSearchNdjson(chunks(
      encoder.encode(full.slice(0, 10)),
      encoder.encode(full.slice(10)),
      line({ t: 'done', scanned: 1, hits: 1, reason: 'complete' }),
    ), 200);
    expect(agg.results).toEqual([{ type: 'file', key: 'split-across-chunks.txt' }]);
  });

  it('parses a final frame without a trailing newline', async () => {
    const agg = await aggregateSearchNdjson(chunks(
      JSON.stringify({ t: 'hit', key: 'no-trailing-newline.txt' }),
    ), 200);
    expect(agg.results).toEqual([{ type: 'file', key: 'no-trailing-newline.txt' }]);
  });

  it('skips malformed and unknown-type lines without failing', async () => {
    const agg = await aggregateSearchNdjson(chunks(
      'this is not json\n',
      line({ t: 'mystery-frame', key: 'x' }),
      line({ t: 'hit' }), // hit without a key — ignored
      line({ t: 'hit', key: 'good.txt' }),
    ), 200);
    expect(agg.results).toEqual([{ type: 'file', key: 'good.txt' }]);
  });
});
