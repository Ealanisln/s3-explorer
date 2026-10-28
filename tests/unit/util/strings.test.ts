import { describe, expect, it } from 'vitest';
import { lastPathSegment, stripTrailingSlashes } from '../../../src/util/strings';

// Both helpers replace regexes that CodeQL flags as js/polynomial-redos. The
// reference regexes below are only run on short inputs, where backtracking is
// harmless, to pin the helpers to the exact semantics they replace.
const refStrip = (s: string): string => s.replace(/\/+$/, '');
const refLastSegment = (s: string): string => s.match(/([^/]+\/)$/)?.[1] ?? '';

function randomPaths(count: number): string[] {
  const alphabet = ['a', 'b', '/', '/', '.', ' '];
  const out: string[] = [];
  let seed = 42;
  const next = (): number => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed; };
  for (let i = 0; i < count; i++) {
    let s = '';
    const len = next() % 12;
    for (let j = 0; j < len; j++) s += alphabet[next() % alphabet.length];
    out.push(s);
  }
  return out;
}

function elapsedMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('stripTrailingSlashes', () => {
  it('removes every trailing slash and nothing else', () => {
    expect(stripTrailingSlashes('https://minio.local///')).toBe('https://minio.local');
    expect(stripTrailingSlashes('https://minio.local')).toBe('https://minio.local');
    expect(stripTrailingSlashes('a/b/')).toBe('a/b');
    expect(stripTrailingSlashes('///')).toBe('');
    expect(stripTrailingSlashes('')).toBe('');
  });

  it('matches the /\\/+$/ regex it replaces', () => {
    for (const s of randomPaths(5_000)) expect(stripTrailingSlashes(s)).toBe(refStrip(s));
  });

  // The regex took ~0.5 s on 40k slashes and grows quadratically; the linear
  // walk stays in the low milliseconds even on 1M characters.
  it('stays linear on long slash runs', () => {
    const slashes = '/'.repeat(1_000_000);
    expect(elapsedMs(() => stripTrailingSlashes('x' + slashes + 'x'))).toBeLessThan(250);
    expect(elapsedMs(() => stripTrailingSlashes('x' + slashes))).toBeLessThan(250);
  });
});

describe('lastPathSegment', () => {
  it('returns the trailing "<segment>/" of a folder prefix', () => {
    expect(lastPathSegment('zell/logs/2026/02/')).toBe('02/');
    expect(lastPathSegment('02/')).toBe('02/');
    expect(lastPathSegment('')).toBe('');
  });

  it('returns "" when there is no trailing slash or the last segment is empty', () => {
    expect(lastPathSegment('a/b')).toBe('');
    expect(lastPathSegment('a//')).toBe('');
    expect(lastPathSegment('/')).toBe('');
  });

  it('matches the /([^/]+\\/)$/ regex it replaces', () => {
    for (const s of randomPaths(5_000)) expect(lastPathSegment(s)).toBe(refLastSegment(s));
  });

  it('stays linear on long segments without a trailing slash', () => {
    const segment = 'a'.repeat(1_000_000);
    expect(elapsedMs(() => lastPathSegment(segment))).toBeLessThan(250);
    expect(elapsedMs(() => lastPathSegment(segment + '/'))).toBeLessThan(250);
  });
});
