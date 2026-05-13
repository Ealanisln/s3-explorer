import { type S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

/**
 * Async iterator that yields every object key under `prefix` in `bucket`.
 * Paginated via ContinuationToken; one S3 round-trip per 1000 keys.
 * Stops early if `abort.aborted` is true between pages OR between yields.
 *
 * Yielded objects:
 *   - key:  full S3 key (string)
 *   - size: byte length from S3 (0 if missing)
 *
 * Does NOT skip "folder marker" objects (keys ending in '/'); the caller
 * decides whether to filter them. For our transfer flow the destKey is
 * computed as `destPrefix + key.slice(sourcePrefix.length)`, so a marker
 * "foo/bar/" copies to "destPrefix/bar/" as a 0-byte object — which is what
 * a "folder" actually is in S3 anyway.
 */
export async function* listAllKeys(
  s3: S3Client,
  bucket: string,
  prefix: string,
  abort: AbortSignal,
): AsyncGenerator<{ key: string; size: number }, void, void> {
  let token: string | undefined;
  do {
    if (abort.aborted) return;
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    if (abort.aborted) return;
    for (const obj of res.Contents ?? []) {
      if (abort.aborted) return;
      if (typeof obj.Key === 'string') {
        yield { key: obj.Key, size: obj.Size ?? 0 };
      }
    }
    token = res.NextContinuationToken;
  } while (token);
}
