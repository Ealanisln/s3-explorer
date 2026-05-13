import { S3Client } from '@aws-sdk/client-s3';
import type { Request } from 'express';

// SSRF defense for the user-supplied S3 endpoint header.
// The app must support arbitrary custom endpoints (MinIO, Vultr, R2, etc.) —
// including internal Docker hostnames like minio-{uuid}:9000 — so we don't
// denylist all internal IPs. We DO block well-known cloud metadata endpoints
// by default to prevent an authenticated user from exfiltrating IAM credentials
// via SSRF on hosts with IMDSv1 enabled.
//
// Override:
//   BLOCK_METADATA_ENDPOINTS=0          → disable the metadata blocklist
//   S3_DENY_HOSTS=host1,host2,...       → additional exact-match hostnames
// WHATWG URL returns IPv6 hostnames wrapped in brackets (e.g. '[fd00:ec2::254]'),
// so the IPv6 IMDS entry must include them — without the brackets, the match
// silently fails and the endpoint is allowed through.
const METADATA_HOSTS: readonly string[] = [
  '169.254.169.254',          // AWS, GCP, Azure (IPv4 link-local)
  '[fd00:ec2::254]',          // AWS IMDS IPv6
  'metadata.google.internal', // GCP
  'metadata.azure.com',       // Azure
];

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

export function endpointBlockReason(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null; // unparseable → let the SDK reject it
  }
  if (BLOCK_METADATA && METADATA_HOSTS.includes(host)) return 'cloud metadata endpoint';
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
