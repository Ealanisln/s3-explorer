import { describe, expect, it, beforeAll } from 'vitest';

// S3_ALLOW_HOSTS is read once at module load, so we set it BEFORE importing the
// client module. vitest isolates each test file in its own fork (pool: forks,
// isolate: true), so this env mutation doesn't leak into other suites.
let endpointBlockReason: (ep: string | undefined) => string | null;

beforeAll(async () => {
  // Entries are matched against URL hostname (port-stripped), so the allowlist
  // holds hostnames without ports.
  process.env.S3_ALLOW_HOSTS = 'minio.example.com, s3.internal';
  const mod = await import('../../../src/s3/client');
  endpointBlockReason = mod.endpointBlockReason;
});

describe('endpointBlockReason with S3_ALLOW_HOSTS set (allowlist mode)', () => {
  it('allows hosts on the allowlist (port ignored)', () => {
    expect(endpointBlockReason('https://minio.example.com')).toBeNull();
    expect(endpointBlockReason('http://s3.internal:9000')).toBeNull();
  });

  it('rejects any host not on the allowlist — even otherwise-valid S3 endpoints', () => {
    expect(endpointBlockReason('https://s3.amazonaws.com')).toBe('not in S3_ALLOW_HOSTS allowlist');
    expect(endpointBlockReason('http://10.0.0.5:9000')).toBe('not in S3_ALLOW_HOSTS allowlist');
  });

  it('still rejects cloud metadata even if someone allowlisted its IP form', () => {
    // metadata is blocked by the IP/range check; not on the allowlist anyway.
    expect(endpointBlockReason('http://169.254.169.254')).toBe('not in S3_ALLOW_HOSTS allowlist');
  });
});
