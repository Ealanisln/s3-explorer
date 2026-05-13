import { S3Client } from '@aws-sdk/client-s3';
import type { Request } from 'express';
import {
  normalizeEndpoint, endpointBlockReason,
  EndpointBlockedError, MissingS3CredentialsError,
  type BuildClientOptions,
} from './client';

// Header prefix selector. The transfer endpoint accepts two independent sets of
// S3 credentials — `x-s3-source-*` and `x-s3-dest-*` — so the server can stream
// objects from one connection to another. Same SSRF defenses as the single
// buildClient.
export type ClientSide = 'source' | 'dest';

export function buildSideClient(req: Request, side: ClientSide, opts: BuildClientOptions = {}): S3Client {
  const p = `x-s3-${side}-`;
  const endpoint = normalizeEndpoint(req.header(p + 'endpoint'));
  const region = req.header(p + 'region') || 'us-east-1';
  const accessKeyId = req.header(p + 'access-key');
  const secretAccessKey = req.header(p + 'secret-key');
  const sessionToken = req.header(p + 'session-token') || undefined;
  const forcePathStyle = (req.header(p + 'path-style') || 'true') === 'true';

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

// True if the two header sets point at the same S3 backend AND use the same
// access key. When true, the orchestrator can use server-side CopyObject
// instead of streaming bytes through the proxy.
export function isSameConnection(req: Request): boolean {
  const srcEp = normalizeEndpoint(req.header('x-s3-source-endpoint'));
  const dstEp = normalizeEndpoint(req.header('x-s3-dest-endpoint'));
  const srcKey = req.header('x-s3-source-access-key');
  const dstKey = req.header('x-s3-dest-access-key');
  return srcEp === dstEp && srcKey === dstKey;
}
