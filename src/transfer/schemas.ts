import { z } from 'zod';

// One item to copy or move. destKey can differ from key (e.g. when copying
// into a folder with the same basename but a different prefix).
const itemSchema = z.object({
  key: z.string().min(1).max(1024),
  destKey: z.string().min(1).max(1024),
});

// Batch transfer. The destination bucket may live on a different S3 backend
// (cross-connection) — that's selected by which header set the client sent
// (x-s3-source-* vs x-s3-dest-*), not by anything in the body.
export const transferSchema = z.object({
  sourceBucket: z.string().min(1).max(63),
  destBucket: z.string().min(1).max(63),
  items: z.array(itemSchema).min(1).max(1000),
  mode: z.enum(['copy', 'move']),
});

export type TransferRequest = z.infer<typeof transferSchema>;
export type TransferItem = z.infer<typeof itemSchema>;
