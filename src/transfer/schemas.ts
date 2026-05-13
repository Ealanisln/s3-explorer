import { z } from 'zod';

// One item to copy or move. destKey can differ from key (e.g. when copying
// into a folder with the same basename but a different prefix).
const itemSchema = z.object({
  key: z.string().min(1).max(1024),
  destKey: z.string().min(1).max(1024),
});

// Prefix-based recursive transfer: server enumerates everything under
// `source` and copies each to `dest + relative_path`. Empty string = bucket
// root (entire bucket). Trailing slashes are normalized in the handler.
const prefixSchema = z.object({
  source: z.string().max(1024),
  dest: z.string().max(1024),
});

// Batch transfer. The destination bucket may live on a different S3 backend
// (cross-connection) — that's selected by which header set the client sent
// (x-s3-source-* vs x-s3-dest-*), not by anything in the body.
//
// The body has TWO mutually-exclusive shapes:
//   { items: [...] }    — explicit list (existing behaviour, capped at 1000)
//   { prefix: {source, dest} } — server-side recursive expand
// Exactly one must be present. The refinement below enforces the XOR.
export const transferSchema = z.object({
  sourceBucket: z.string().min(1).max(63),
  destBucket: z.string().min(1).max(63),
  mode: z.enum(['copy', 'move']),
  items: z.array(itemSchema).max(1000).optional(),
  prefix: prefixSchema.optional(),
}).refine(
  (d) => (d.items !== undefined) !== (d.prefix !== undefined),
  { message: 'Exactly one of `items` or `prefix` is required' },
).refine(
  (d) => !d.items || d.items.length > 0,
  { message: '`items` must not be empty when provided' },
);

export type TransferRequest = z.infer<typeof transferSchema>;
export type TransferItem = z.infer<typeof itemSchema>;
export type TransferPrefix = z.infer<typeof prefixSchema>;
