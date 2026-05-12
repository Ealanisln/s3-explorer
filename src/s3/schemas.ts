import { z } from 'zod';

// Connection test — bucket is optional. If provided, the route does HeadBucket;
// otherwise it does ListBuckets.
export const testSchema = z.object({
  bucket: z.string().min(1).max(63).optional(),
});

export const createBucketSchema = z.object({
  name: z.string().regex(/^[a-z0-9.\-]{3,63}$/, 'name inválido (3-63 chars, minúsculas/números/.-)'),
});

// Versioning can only be enabled — suspending must be done with AWS CLI to
// prevent accidental data loss.
export const versioningSchema = z.object({
  enabled: z.literal(true, { message: 'enabled debe ser true' }),
});

export const folderSchema = z.object({
  prefix: z.string().max(1024).optional(),
  name: z.string().min(1).max(1024, { message: 'name demasiado largo (máx 1024 chars)' }),
});

export const restoreSchema = z.object({
  key: z.string().min(1).max(1024),
  versionId: z.string().min(1).max(256).optional(),
});

export const deleteObjectSchema = z.object({
  key: z.string().min(1).max(1024),
  versionId: z.string().min(1).max(256).optional(),
});

// keys: array of strings OR objects with key + optional versionId.
// Cap at 1000 to match S3's DeleteObjects limit; route logic also caps separately.
const batchEntry = z.union([
  z.string().min(1).max(1024),
  z.object({ key: z.string().min(1).max(1024), versionId: z.string().min(1).max(256).optional() }),
]);
export const deleteBatchSchema = z.object({
  keys: z.array(batchEntry).min(1).max(1000),
});

export const copySchema = z.object({
  sourceKey: z.string().min(1).max(1024),
  destKey: z.string().min(1).max(1024),
  sourceVersionId: z.string().min(1).max(256).optional(),
});

export const renameSchema = z.object({
  sourceKey: z.string().min(1).max(1024),
  destKey: z.string().min(1).max(1024),
});

// Existence check (JL's pre-upload conflict detection). Cap at 100 here;
// route also caps as a defense-in-depth.
export const existsSchema = z.object({
  keys: z.array(z.string().min(1).max(1024)).min(1).max(100),
});
