// NDJSON aggregation for GET /api/search-stream/:bucket.
//
// The endpoint streams one JSON frame per line: `hit` (file match),
// `folder-hit` (folder-name match), `progress`, `done`, `error`. The MCP
// search_files tool consumes the whole stream and returns one bounded JSON
// result, so agents get a single structured answer instead of a stream.

export interface SearchResultItem {
  type: 'file' | 'folder';
  key: string;
  size?: number;
  modified?: string;
}

export interface SearchAggregate {
  results: SearchResultItem[];
  /** Number of S3 keys the server scanned while searching. */
  scanned: number;
  /** True when the result list was cut off (server limit or local cap). */
  truncated: boolean;
  /** Sanitized server-side error message, if the stream ended with one. */
  error?: string;
}

interface Frame {
  t?: unknown;
  key?: unknown;
  size?: unknown;
  modified?: unknown;
  scanned?: unknown;
  reason?: unknown;
  message?: unknown;
  error?: unknown;
}

// Aggregate a stream of NDJSON chunks into a bounded result set. Accepts any
// async iterable of Uint8Array/string chunks (fetch response bodies qualify),
// so unit tests can feed synthetic chunks including splits mid-line.
export async function aggregateSearchNdjson(
  source: AsyncIterable<Uint8Array | string>,
  cap: number,
): Promise<SearchAggregate> {
  const decoder = new TextDecoder();
  const agg: SearchAggregate = { results: [], scanned: 0, truncated: false };
  let buffer = '';

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: Frame;
    try {
      frame = JSON.parse(trimmed) as Frame;
    } catch {
      return; // malformed line — skip, never crash the aggregation
    }
    switch (frame.t) {
      case 'hit':
      case 'folder-hit': {
        if (typeof frame.key !== 'string') return;
        if (agg.results.length >= cap) {
          agg.truncated = true;
          return;
        }
        const item: SearchResultItem = {
          type: frame.t === 'hit' ? 'file' : 'folder',
          key: frame.key,
        };
        if (typeof frame.size === 'number') item.size = frame.size;
        if (typeof frame.modified === 'string') item.modified = frame.modified;
        agg.results.push(item);
        return;
      }
      case 'progress':
      case 'done': {
        if (typeof frame.scanned === 'number') agg.scanned = frame.scanned;
        if (frame.t === 'done' && frame.reason === 'limit') agg.truncated = true;
        return;
      }
      case 'error': {
        agg.error = typeof frame.message === 'string'
          ? frame.message
          : typeof frame.error === 'string' ? frame.error : 'search failed';
        return;
      }
      default:
        return; // unknown frame type — forward-compatible skip
    }
  };

  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      consumeLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode(); // flush any trailing multi-byte sequence
  if (buffer.length > 0) consumeLine(buffer);

  return agg;
}
