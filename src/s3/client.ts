import { S3Client } from '@aws-sdk/client-s3';
import { BlockList, isIP } from 'node:net';
import type { Request } from 'express';

// SSRF defense for the user-supplied S3 endpoint header.
// The app must support arbitrary custom endpoints (MinIO, Vultr, R2, etc.) —
// including internal Docker hostnames like minio-{uuid}:9000 and RFC1918
// addresses — so we deliberately do NOT denylist all internal IPs. We DO block
// well-known cloud metadata endpoints by default to prevent an authenticated
// user from exfiltrating IAM credentials via SSRF on hosts with IMDSv1 enabled.
//
// Override:
//   BLOCK_METADATA_ENDPOINTS=0          → disable the metadata blocklist
//   S3_DENY_HOSTS=host1,host2,...       → additional exact-match hostnames
const METADATA_HOSTNAMES: readonly string[] = [
  'metadata.google.internal', // GCP
  'metadata.azure.com',       // Azure
];

// The link-local /16 covers cloud IMDS (169.254.169.254 on AWS/GCP/Azure/etc.)
// in EVERY IP encoding once we canonicalize — closing the decimal/octal/hex and
// IPv4-mapped-IPv6 bypasses that a bare string match on `169.254.169.254` missed
// (e.g. http://2852039166/ or http://[::ffff:169.254.169.254]).
const METADATA_BLOCKLIST = new BlockList();
METADATA_BLOCKLIST.addSubnet('169.254.0.0', 16, 'ipv4'); // IPv4 link-local incl. IMDS
METADATA_BLOCKLIST.addAddress('fd00:ec2::254', 'ipv6');  // AWS IMDS IPv6

const BLOCK_METADATA = (process.env.BLOCK_METADATA_ENDPOINTS || '1') === '1';
const S3_DENY_HOSTS: readonly string[] = (process.env.S3_DENY_HOSTS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function normalizeEndpoint(ep: string | undefined): string | undefined {
  if (!ep) return undefined;
  const trimmed = ep.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  return 'https://' + trimmed.replace(/\/+$/, '');
}

// Parse an IPv4 in dotted / decimal / octal / hex form (inet_aton semantics)
// into canonical dotted-decimal, or null if `host` isn't a numeric IPv4. This
// is what defeats the IMDS encoding bypasses: a browser / the OS resolver treats
// `2852039166`, `0xA9.0xFE.0xA9.0xFE`, `0251.0376.0251.0376` all as
// 169.254.169.254, but `new URL().hostname` returns them verbatim.
function canonicalizeNumericIpv4(host: string): string | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p === '') return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null; // any non-numeric label → it's a hostname, not an IP
    if (!Number.isSafeInteger(n) || n < 0) return null;
    nums.push(n);
  }
  // inet_aton: the final part absorbs all remaining low-order bytes.
  let value: number;
  switch (nums.length) {
    case 1:
      value = nums[0];
      if (value > 0xffffffff) return null;
      break;
    case 2:
      if (nums[0] > 0xff || nums[1] > 0xffffff) return null;
      value = nums[0] * 0x1000000 + nums[1];
      break;
    case 3:
      if (nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return null;
      value = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2];
      break;
    default: // 4
      if (nums.some((x) => x > 0xff)) return null;
      value = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2] * 0x100 + nums[3];
  }
  value = value >>> 0;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

// Reduce a URL hostname to the IP literal we should evaluate, unwrapping IPv6
// brackets and IPv4-mapped IPv6 (::ffff:a.b.c.d) and canonicalizing numeric
// IPv4 encodings. Returns the original host untouched when it isn't an IP.
function hostToIp(host: string): string {
  let h = host;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return mapped[1];
  return canonicalizeNumericIpv4(h) || h;
}

export function endpointBlockReason(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null; // unparseable → let the SDK reject it
  }
  if (BLOCK_METADATA) {
    if (METADATA_HOSTNAMES.includes(host)) return 'cloud metadata endpoint';
    const ip = hostToIp(host);
    const fam = isIP(ip);
    if (fam === 4 && METADATA_BLOCKLIST.check(ip, 'ipv4')) return 'cloud metadata endpoint';
    if (fam === 6 && METADATA_BLOCKLIST.check(ip, 'ipv6')) return 'cloud metadata endpoint';
  }
  if (S3_DENY_HOSTS.includes(host)) return 'denied by S3_DENY_HOSTS';
  return null;
}

export class EndpointBlockedError extends Error {
  readonly status = 403;
  readonly reason: string;
  readonly endpoint: string;
  constructor(reason: string, endpoint: string) {
    super('Endpoint not allowed');
    this.name = 'EndpointBlocked';
    this.reason = reason;
    this.endpoint = endpoint;
  }
}

export class MissingS3CredentialsError extends Error {
  readonly status = 401;
  constructor() {
    super('Missing S3 credentials');
    this.name = 'MissingCredentials';
  }
}

export interface BuildClientOptions {
  /**
   * Called once when an endpoint is rejected, before the error is thrown.
   * Lets the caller emit an audit event without coupling this module to auth.
   */
  onBlocked?: (reason: string, endpoint: string) => void;
}

export function buildClient(req: Request, opts: BuildClientOptions = {}): S3Client {
  const endpoint = normalizeEndpoint(req.header('x-s3-endpoint'));
  const region = req.header('x-s3-region') || 'us-east-1';
  const accessKeyId = req.header('x-s3-access-key');
  const secretAccessKey = req.header('x-s3-secret-key');
  const sessionToken = req.header('x-s3-session-token') || undefined;
  const forcePathStyle = (req.header('x-s3-path-style') || 'true') === 'true';

  if (!accessKeyId || !secretAccessKey) {
    throw new MissingS3CredentialsError();
  }

  const blocked = endpointBlockReason(endpoint);
  if (blocked) {
    if (opts.onBlocked) opts.onBlocked(blocked, endpoint as string);
    throw new EndpointBlockedError(blocked, endpoint as string);
  }

  return new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey, sessionToken },
  });
}
