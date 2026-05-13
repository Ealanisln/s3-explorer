import {
  type S3Client, CopyObjectCommand, GetObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'stream';
import type { TransferItem } from './schemas';
import { listAllKeys } from './listing';

// Progress events emitted as SSE frames.
//
// Lifecycle for an items-based transfer:
//   progress → (bytes…)? → item-done|item-error → … → done
//
// Lifecycle for a prefix-based recursive transfer adds two extra frames at
// the start:
//   discovering (running scan count) → discovered (final total) → progress …
// Once `discovered` fires, `progress.total` is the final value. Before that,
// `progress.total` reflects `discovered_so_far` (i.e. a moving target). The
// UI shows "X / unknown" while in `discovering` and "X / Total" after.
export type ProgressEvent =
  | { t: 'discovering'; scanned: number }
  | { t: 'discovered'; total: number }
  | { t: 'progress'; completed: number; total: number; currentKey: string }
  | { t: 'bytes'; key: string; loaded: number; total: number }
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
      await copyOneCrossConn(sourceS3, destS3, sourceBucket, destBucket, key, destKey, onEvent, abort);
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

// ─── helpers used by both items- and prefix-based transfers ─────────────────

async function copyOneSameConn(
  s3: S3Client, sourceBucket: string, destBucket: string,
  key: string, destKey: string,
): Promise<void> {
  await s3.send(new CopyObjectCommand({
    Bucket: destBucket,
    Key: destKey,
    CopySource: encodeCopySource(sourceBucket, key),
  }));
}

async function copyOneCrossConn(
  sourceS3: S3Client, destS3: S3Client,
  sourceBucket: string, destBucket: string,
  key: string, destKey: string,
  onEvent: (e: ProgressEvent) => void,
  abort: AbortSignal,
): Promise<void> {
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
  const totalBytes = got.ContentLength ?? 0;
  upload.on('httpUploadProgress', (p: { loaded?: number; total?: number }) => {
    if (typeof p.loaded !== 'number') return;
    onEvent({ t: 'bytes', key, loaded: p.loaded, total: p.total ?? totalBytes });
  });
  abort.addEventListener('abort', () => { void upload.abort(); }, { once: true });
  await upload.done();
}

// Sleep that wakes early if the abort signal fires.
function sleepAbortable(ms: number, abort: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { abort.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    abort.addEventListener('abort', onAbort, { once: true });
  });
}

// Retry on 5xx and 429. Non-retryable 4xx fail immediately. Aborts honoured.
async function withRetry<T>(fn: () => Promise<T>, abort: AbortSignal): Promise<T> {
  const delays = [1000, 2000, 4000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (abort.aborted) throw new Error('aborted');
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      const retryable = !status || status >= 500 || status === 429;
      if (!retryable || attempt === delays.length) throw e;
      await sleepAbortable(delays[attempt], abort);
    }
  }
  throw lastErr;
}

// ─── recursive (prefix-based) transfer ──────────────────────────────────────

export interface TransferRecursiveOptions {
  sourceBucket: string;
  destBucket: string;
  sourcePrefix: string;     // e.g. "documents/2026/"
  destPrefix: string;       // e.g. "backup/2026/"
  mode: 'copy' | 'move';
  sameConn: boolean;        // use server-side CopyObject when true
  concurrency: number;      // parallel item workers (default 4)
  maxItems: number;         // safety cap, default 100k
  onEvent: (e: ProgressEvent) => void;
  abort: AbortSignal;
}

/**
 * Stream-discover-and-transfer. The producer iterates `ListObjectsV2` pages
 * and pushes items onto a bounded queue; N parallel workers pull from the
 * queue and copy (then optionally delete) each item.
 *
 * Memory: bounded by `queueCapacity` + `concurrency × per-upload` (~32 MB).
 * For default concurrency=4 and queueCapacity=concurrency*4=16, total RAM
 * footprint is ~140 MB peak — independent of how many objects are under the
 * prefix.
 *
 * Resilience:
 *   - Per-item retries (3, exponential backoff)
 *   - Circuit breaker: 10 consecutive errors aborts the batch
 *   - Cap of `maxItems` (default 100k); discovery beyond that aborts
 *
 * Move semantics: per-item — the source object is deleted ONLY after its
 * copy succeeds. A failed copy never deletes from source.
 */
export async function transferRecursive(
  sourceS3: S3Client, destS3: S3Client, opts: TransferRecursiveOptions,
): Promise<void> {
  const {
    sourceBucket, destBucket, sourcePrefix, destPrefix,
    mode, sameConn, concurrency, maxItems, onEvent, abort,
  } = opts;

  // Internal controller so the worker pool can abort itself on circuit-break
  // or maxItems exceeded without us inventing a fake external trigger.
  const inner = new AbortController();
  abort.addEventListener('abort', () => inner.abort(), { once: true });
  const signal = inner.signal;

  const queue: { key: string; destKey: string }[] = [];
  const queueCapacity = concurrency * 4;
  let producerDone = false;
  let totalDiscovered = 0;
  let ok = 0; let failed = 0;
  let consecutiveErrors = 0;

  // The LAST path segment of sourcePrefix is preserved in the destination so
  // that dragging "foo/" onto a dest pane at "x/" yields "x/foo/..." (like
  // every desktop file manager). For an empty sourcePrefix (whole bucket),
  // this resolves to "" and contents merge directly into destPrefix.
  //   "zell/logs/2026/02/" → folderName = "02/"
  //   "02/"                → folderName = "02/"
  //   ""                   → folderName = ""
  const folderNameMatch = sourcePrefix.match(/([^/]+\/)$/);
  const folderName = folderNameMatch ? folderNameMatch[1] : '';

  // ── Producer: list pages and push to queue ───────────────────────────────
  const producer = (async (): Promise<void> => {
    try {
      let scanned = 0;
      let lastEmittedAt = 0;
      let lastEmittedScanned = 0;
      for await (const { key } of listAllKeys(sourceS3, sourceBucket, sourcePrefix, signal)) {
        if (signal.aborted) break;
        if (scanned >= maxItems) {
          onEvent({
            t: 'item-error', key: '__OVERFLOW__',
            message: `MaxItemsExceeded: prefix has more than ${maxItems} objects`,
          });
          inner.abort();
          break;
        }
        // Back-pressure: wait if queue is full
        while (queue.length >= queueCapacity && !signal.aborted) {
          await sleepAbortable(50, signal);
        }
        if (signal.aborted) break;
        // Compute destKey preserving the source folder name + the path
        // relative to sourcePrefix.
        const rel = key.slice(sourcePrefix.length);
        const destKey = destPrefix + folderName + rel;
        queue.push({ key, destKey });
        scanned++;
        // Throttle discovery events: emit every 100 items or every 250 ms.
        const now = Date.now();
        const enoughItems = scanned - lastEmittedScanned >= 100;
        const enoughTime  = now - lastEmittedAt > 250 && scanned > lastEmittedScanned;
        if (enoughItems || enoughTime) {
          onEvent({ t: 'discovering', scanned });
          lastEmittedAt = now;
          lastEmittedScanned = scanned;
        }
      }
      totalDiscovered = scanned;
      onEvent({ t: 'discovered', total: scanned });
    } finally {
      producerDone = true;
    }
  })();

  // ── Worker: pull one item at a time, copy with retry ─────────────────────
  const worker = async (): Promise<void> => {
    while (!signal.aborted) {
      const item = queue.shift();
      if (!item) {
        if (producerDone) return;          // producer drained queue → exit
        await sleepAbortable(50, signal);
        continue;
      }
      // Emit progress with the running `completed` (ok + failed) and the
      // best-known total (totalDiscovered, which is 0 until producer reports).
      onEvent({
        t: 'progress',
        completed: ok + failed,
        total: totalDiscovered || (queue.length + ok + failed + 1),
        currentKey: item.key,
      });
      try {
        await withRetry(async () => {
          if (sameConn) {
            await copyOneSameConn(sourceS3, sourceBucket, destBucket, item.key, item.destKey);
          } else {
            await copyOneCrossConn(sourceS3, destS3, sourceBucket, destBucket,
              item.key, item.destKey, onEvent, signal);
          }
        }, signal);
        if (mode === 'move') {
          await withRetry(
            () => sourceS3.send(new DeleteObjectCommand({ Bucket: sourceBucket, Key: item.key })),
            signal,
          ).then(() => undefined);
        }
        onEvent({ t: 'item-done', key: item.key });
        ok++;
        consecutiveErrors = 0;
      } catch (e) {
        const err = e as { name?: string; message?: string };
        onEvent({ t: 'item-error', key: item.key, message: err.name || 'TransferError' });
        failed++;
        consecutiveErrors++;
        if (consecutiveErrors >= 10) {
          onEvent({
            t: 'item-error', key: '__CIRCUIT_BREAKER__',
            message: 'TooManyConsecutiveErrors: aborting batch',
          });
          inner.abort();
        }
      }
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all([producer, ...workers]);
  onEvent({ t: 'done', ok, failed });
}
