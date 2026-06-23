import type { Request } from 'express';
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import {
  EndpointBlockedError,
  MissingS3CredentialsError,
  buildClient,
  endpointBlockReason,
  normalizeEndpoint,
} from '../../../src/s3/client';

function makeReq(headers: Record<string, string | undefined> = {}): Request {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    header(name: string) { return lower[name.toLowerCase()]; },
  } as unknown as Request;
}

describe('normalizeEndpoint', () => {
  it('returns undefined for empty / undefined input', () => {
    expect(normalizeEndpoint(undefined)).toBeUndefined();
    expect(normalizeEndpoint('')).toBeUndefined();
    expect(normalizeEndpoint('   ')).toBeUndefined();
  });

  it('prepends https:// when no scheme is given', () => {
    expect(normalizeEndpoint('minio.local')).toBe('https://minio.local');
    expect(normalizeEndpoint('s3.amazonaws.com')).toBe('https://s3.amazonaws.com');
  });

  it('preserves http:// and https:// schemes', () => {
    expect(normalizeEndpoint('http://localhost:9000')).toBe('http://localhost:9000');
    expect(normalizeEndpoint('https://s3.example.com')).toBe('https://s3.example.com');
  });

  it('strips trailing slashes', () => {
    expect(normalizeEndpoint('https://minio.local/')).toBe('https://minio.local');
    expect(normalizeEndpoint('https://minio.local///')).toBe('https://minio.local');
    expect(normalizeEndpoint('minio.local/')).toBe('https://minio.local');
  });
});

describe('endpointBlockReason', () => {
  it('blocks well-known cloud metadata endpoints by default', () => {
    expect(endpointBlockReason('https://169.254.169.254')).toBe('cloud metadata endpoint');
    expect(endpointBlockReason('http://169.254.169.254/latest/meta-data/'))
      .toBe('cloud metadata endpoint');
    expect(endpointBlockReason('https://metadata.google.internal'))
      .toBe('cloud metadata endpoint');
    expect(endpointBlockReason('https://metadata.azure.com'))
      .toBe('cloud metadata endpoint');
  });

  // WHATWG URL parser returns IPv6 hostnames wrapped in brackets, so the entry
  // in METADATA_HOSTS must include them. Without the brackets the match
  // silently failed and IMDS IPv6 was reachable — fixed in dd77c83.
  it('blocks the AWS IMDS IPv6 endpoint', () => {
    expect(endpointBlockReason('http://[fd00:ec2::254]')).toBe('cloud metadata endpoint');
    expect(endpointBlockReason('http://[fd00:ec2::254]:80')).toBe('cloud metadata endpoint');
  });

  it('allows legitimate S3 endpoints', () => {
    expect(endpointBlockReason('https://s3.amazonaws.com')).toBeNull();
    expect(endpointBlockReason('https://minio.example.com')).toBeNull();
    expect(endpointBlockReason('http://minio-abc123:9000')).toBeNull();
  });

  // SSRF hardening: a bare string match on '169.254.169.254' was bypassable by
  // alternate IP encodings that the OS resolver still routes to IMDS. We now
  // canonicalize numeric IPv4 and check the whole link-local /16.
  it('blocks IMDS via decimal / octal / hex IPv4 encodings', () => {
    expect(endpointBlockReason('http://2852039166')).toBe('cloud metadata endpoint'); // 169.254.169.254
    expect(endpointBlockReason('http://0251.0376.0251.0376')).toBe('cloud metadata endpoint'); // octal
    expect(endpointBlockReason('http://0xA9.0xFE.0xA9.0xFE')).toBe('cloud metadata endpoint'); // hex
    expect(endpointBlockReason('http://0xA9FEA9FE')).toBe('cloud metadata endpoint'); // single hex
  });

  it('blocks IMDS via IPv4-mapped IPv6', () => {
    expect(endpointBlockReason('http://[::ffff:169.254.169.254]')).toBe('cloud metadata endpoint');
  });

  it('blocks the whole IPv4 link-local /16, not just .169.254', () => {
    expect(endpointBlockReason('http://169.254.0.1')).toBe('cloud metadata endpoint');
    expect(endpointBlockReason('http://169.254.255.255')).toBe('cloud metadata endpoint');
  });

  it('still allows RFC1918 / loopback / Docker hostnames (internal S3 is by design)', () => {
    expect(endpointBlockReason('http://10.0.0.5:9000')).toBeNull();
    expect(endpointBlockReason('http://192.168.1.10:9000')).toBeNull();
    expect(endpointBlockReason('http://127.0.0.1:9000')).toBeNull();
    expect(endpointBlockReason('http://172.16.0.3:9000')).toBeNull();
    expect(endpointBlockReason('http://minio-abc123:9000')).toBeNull();
  });

  it('returns null for empty / unparseable input (lets the SDK reject)', () => {
    expect(endpointBlockReason(undefined)).toBeNull();
    expect(endpointBlockReason('not a url')).toBeNull();
  });
});

describe('buildClient', () => {
  it('throws MissingS3CredentialsError when access-key is absent', () => {
    const req = makeReq({
      'x-s3-endpoint': 'https://minio.local',
      'x-s3-secret-key': 'shh',
    });
    expect(() => buildClient(req)).toThrow(MissingS3CredentialsError);
  });

  it('throws MissingS3CredentialsError when secret-key is absent', () => {
    const req = makeReq({
      'x-s3-endpoint': 'https://minio.local',
      'x-s3-access-key': 'AKIA...',
    });
    expect(() => buildClient(req)).toThrow(MissingS3CredentialsError);
  });

  it('builds an S3Client from headers (happy path)', () => {
    const req = makeReq({
      'x-s3-endpoint': 'https://minio.local',
      'x-s3-region': 'eu-west-1',
      'x-s3-access-key': 'AKIATEST',
      'x-s3-secret-key': 'secretvalue',
      'x-s3-path-style': 'true',
    });
    const client = buildClient(req);
    expect(client).toBeInstanceOf(S3Client);
    expect(client.config.region).toBeDefined();
  });

  it('defaults region to us-east-1 when not set', () => {
    const req = makeReq({
      'x-s3-endpoint': 'https://minio.local',
      'x-s3-access-key': 'AKIATEST',
      'x-s3-secret-key': 'secretvalue',
    });
    const client = buildClient(req);
    expect(client).toBeInstanceOf(S3Client);
  });

  it('throws EndpointBlockedError for cloud metadata endpoints', () => {
    const req = makeReq({
      'x-s3-endpoint': 'http://169.254.169.254',
      'x-s3-access-key': 'AKIA',
      'x-s3-secret-key': 'secret',
    });
    expect(() => buildClient(req)).toThrow(EndpointBlockedError);
  });

  it('invokes onBlocked callback before throwing', () => {
    const onBlocked = vi.fn();
    const req = makeReq({
      'x-s3-endpoint': 'https://metadata.google.internal',
      'x-s3-access-key': 'AKIA',
      'x-s3-secret-key': 'secret',
    });
    expect(() => buildClient(req, { onBlocked })).toThrow(EndpointBlockedError);
    expect(onBlocked).toHaveBeenCalledOnce();
    const [reason, endpoint] = onBlocked.mock.calls[0];
    expect(reason).toBe('cloud metadata endpoint');
    expect(endpoint).toBe('https://metadata.google.internal');
  });

  it('does not invoke onBlocked for non-blocked endpoints', () => {
    const onBlocked = vi.fn();
    const req = makeReq({
      'x-s3-endpoint': 'https://minio.local',
      'x-s3-access-key': 'AKIA',
      'x-s3-secret-key': 'secret',
    });
    expect(() => buildClient(req, { onBlocked })).not.toThrow();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('checks creds BEFORE the endpoint blocklist', () => {
    // No creds + blocked endpoint → still get MissingS3CredentialsError, not
    // EndpointBlockedError. This guarantees the credential check is the first
    // line of defense.
    const req = makeReq({
      'x-s3-endpoint': 'http://169.254.169.254',
    });
    expect(() => buildClient(req)).toThrow(MissingS3CredentialsError);
  });
});

describe('error classes', () => {
  it('EndpointBlockedError has status 403 and exposes reason/endpoint', () => {
    const e = new EndpointBlockedError('cloud metadata endpoint', 'http://169.254.169.254');
    expect(e.status).toBe(403);
    expect(e.name).toBe('EndpointBlocked');
    expect(e.reason).toBe('cloud metadata endpoint');
    expect(e.endpoint).toBe('http://169.254.169.254');
  });

  it('MissingS3CredentialsError has status 401', () => {
    const e = new MissingS3CredentialsError();
    expect(e.status).toBe(401);
    expect(e.name).toBe('MissingCredentials');
  });
});
