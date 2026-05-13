import {
  type S3Client, CopyObjectCommand, GetObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'stream';
import type { TransferItem } from './schemas';

// Progress events emitted as SSE frames. `progress` fires on every item start;
// `item-done` / `item-error` fires when each item resolves; `done` is the
// terminal frame.
export type ProgressEvent =
  | { t: 'progress'; completed: number; total: number; currentKey: string }
  | { t: 'item-done'; key: string }
  | { t: 'item-error'; key: string; message: string }
  | { t: 'done'; ok: number; failed: number };

export interface TransferOptions {
  sourceBucket: string;
  destBucket: string;
  items: ReadonlyArray<TransferItem>;
  mode: 'copy' | 'move';
  onEvent: (e: ProgressEvent) => void;
  abort: AbortSignal;
}

// CopyObject server-side. Fastest path — bytes never touch the proxy.
// CopySource format: `${bucket}/${encodedKey}`. encodeURIComponent handles
// special chars; we DON'T encode '/' because S3 expects literal slashes
// inside the key portion of CopySource.
function encodeCopySource(bucket: string, key: string): string {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${bucket}/${encodedKey}`;
}

export async function transferSameConn(s3: S3Client, opts: TransferOptions): Promise<void> {
  const { sourceBucket, destBucket, items, mode, onEvent, abort } = opts;
  let ok = 0; let failed = 0;
  for (let i = 0; i < items.length; i++) {
    if (abort.aborted) break;
    const { key, destKey } = items[i];
    onEvent({ t: 'progress', completed: i, total: items.length, currentKey: key });
    try {
      await s3.send(new CopyObjectCommand({
        Bucket: destBucket,
        Key: destKey,
        CopySource: encodeCopySource(sourceBucket, key),
      }));
      if (mode === 'move') {
        await s3.send(new DeleteObjectCommand({ Bucket: sourceBucket, Key: key }));
      }
      onEvent({ t: 'item-done', key });
      ok++;
    } catch (e) {
      const err = e as { name?: string; message?: string };
      onEvent({ t: 'item-error', key, message: err.name || 'CopyError' });
      failed++;
    }
  }
  onEvent({ t: 'done', ok, failed });
}

// Cross-connection: stream GetObject → Upload (lib-storage handles multipart).
// Memory is bounded by lib-storage partSize (default 5 MB, queueSize 4 = ~20 MB
// per active item). Items run serially so total peak is ~20 MB.
export async function transferCrossConn(
  sourceS3: S3Client, destS3: S3Client, opts: TransferOptions,
): Promise<void> {
  const { sourceBucket, destBucket, items, mode, onEvent, abort } = opts;
  let ok = 0; let failed = 0;
  for (let i = 0; i < items.length; i++) {
    if (abort.aborted) break;
    const { key, destKey } = items[i];
    onEvent({ t: 'progress', completed: i, total: items.length, currentKey: key });
    try {
      const got = await sourceS3.send(new GetObjectCommand({ Bucket: sourceBucket, Key: key }));
      if (!got.Body) throw new Error('NoSuchKey');
      const upload = new Upload({
        client: destS3,
        params: {
          Bucket: destBucket,
          Key: destKey,
          Body: got.Body as Readable,
          ContentType: got.ContentType,
          ContentLength: got.ContentLength,
        },
        partSize: 8 * 1024 * 1024,
        queueSize: 4,
      });
      // Allow client abort to cancel the in-flight upload.
      abort.addEventListener('abort', () => { void upload.abort(); }, { once: true });
      await upload.done();
      if (mode === 'move') {
        await sourceS3.send(new DeleteObjectCommand({ Bucket: sourceBucket, Key: key }));
      }
      onEvent({ t: 'item-done', key });
      ok++;
    } catch (e) {
      const err = e as { name?: string; message?: string };
      onEvent({ t: 'item-error', key, message: err.name || 'TransferError' });
      failed++;
    }
  }
  onEvent({ t: 'done', ok, failed });
}
