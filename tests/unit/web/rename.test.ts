import { describe, it, expect } from 'vitest';
import { nextFreeName } from '../../../public/src/objects/rename';

describe('nextFreeName', () => {
  it('returns the name unchanged when not taken', () => {
    expect(nextFreeName('foo.pdf', new Set())).toBe('foo.pdf');
  });

  it('appends (1) on first collision before the extension', () => {
    expect(nextFreeName('foo.pdf', new Set(['foo.pdf']))).toBe('foo (1).pdf');
  });

  it('bumps to (2) when (1) is also taken', () => {
    expect(nextFreeName('foo.pdf', new Set(['foo.pdf', 'foo (1).pdf']))).toBe('foo (2).pdf');
  });

  it('handles extension-less names', () => {
    expect(nextFreeName('README', new Set(['README']))).toBe('README (1)');
  });

  it('treats leading-dot files as extension-less (Finder behavior)', () => {
    expect(nextFreeName('.htaccess', new Set(['.htaccess']))).toBe('.htaccess (1)');
  });

  it('splits at the last dot for compound extensions', () => {
    expect(nextFreeName('archive.tar.gz', new Set(['archive.tar.gz']))).toBe('archive.tar (1).gz');
  });

  it('bumps a name that already carries a (N) suffix', () => {
    expect(nextFreeName('foo (3).pdf', new Set(['foo (3).pdf']))).toBe('foo (4).pdf');
  });

  it('skips intermediate taken values when bumping a pre-suffixed name', () => {
    expect(nextFreeName('foo (3).pdf', new Set(['foo (3).pdf', 'foo (4).pdf']))).toBe('foo (5).pdf');
  });
});
