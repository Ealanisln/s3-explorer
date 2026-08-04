// Minimal HTTP client for the S3 Explorer API, shared by every MCP tool.
//
// Uses the global fetch (undici, Node 20+) — no extra HTTP dependency. Every
// request carries `Authorization: Bearer s3x_...` plus the transient x-s3-*
// credential headers the server's buildClient() reads (src/s3/client.ts).
import type { McpConfig } from './config';

// Error body shapes the server produces:
//   S3-facing routes  → { error, message, errorId }        (src/s3/errors.ts)
//   Auth middleware   → { message, code }                   (TOKEN_INVALID / TOKEN_SCOPE)
interface ApiErrorBody {
  message?: string;
  code?: string;
  error?: string;
  errorId?: string;
}

export class S3xApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly errorName?: string;
  readonly errorId?: string;
  constructor(message: string, status: number, body: ApiErrorBody) {
    super(message);
    this.name = 'S3xApiError';
    this.status = status;
    this.code = body.code;
    this.errorName = body.error;
    this.errorId = body.errorId;
  }
}

// Translate an error response into an actionable, agent-friendly message that
// distinguishes a bad token (401 TOKEN_INVALID) from insufficient scope
// (403 TOKEN_SCOPE) from ordinary S3 errors.
function friendlyMessage(status: number, body: ApiErrorBody): string {
  if (status === 401 && body.code === 'TOKEN_INVALID') {
    return 'Authentication failed: the API token (S3X_API_TOKEN) is invalid, revoked, or expired. ' +
      'Create a new personal access token in S3 Explorer under "Mi cuenta" → "Tokens de API".';
  }
  if (status === 403 && body.code === 'TOKEN_SCOPE') {
    return 'Permission denied: the API token has read-only scope, but this operation requires ' +
      'a token with "write" scope. Create a write-scope token or use a read-only workflow.';
  }
  if (status === 401) {
    return `Authentication failed (401): ${body.message ?? 'unauthorized'}. ` +
      'Check S3X_API_TOKEN and the S3 credential variables (S3X_S3_ACCESS_KEY_ID / S3X_S3_SECRET_ACCESS_KEY).';
  }
  if (status === 429) {
    return `Rate limited (429): ${body.message ?? 'too many failed attempts'}. Wait and retry.`;
  }
  const parts: string[] = [`S3 Explorer API error (${status})`];
  if (body.error) parts.push(body.error);
  if (body.message) parts.push(body.message);
  if (body.errorId) parts.push(`errorId=${body.errorId}`);
  return parts.join(': ');
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  /** JSON body (object) or a FormData instance for multipart uploads. */
  body?: unknown;
}

export class S3xClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(cfg: Pick<McpConfig, 'baseUrl' | 'apiToken' | 's3'>) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.headers = {
      authorization: `Bearer ${cfg.apiToken}`,
      'x-s3-access-key': cfg.s3.accessKey,
      'x-s3-secret-key': cfg.s3.secretKey,
      'x-s3-region': cfg.s3.region,
      'x-s3-path-style': cfg.s3.pathStyle,
    };
    if (cfg.s3.endpoint) this.headers['x-s3-endpoint'] = cfg.s3.endpoint;
    if (cfg.s3.sessionToken) this.headers['x-s3-session-token'] = cfg.s3.sessionToken;
  }

  private url(path: string, query?: RequestOptions['query']): string {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private async send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { ...this.headers };
    let body: RequestInit['body'];
    if (opts.body instanceof FormData) {
      body = opts.body; // fetch sets the multipart boundary header itself
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await fetch(this.url(path, opts.query), { method, headers, body });
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Could not reach S3 Explorer at ${this.baseUrl} (${cause}). Check S3X_BASE_URL and that the instance is running.`,
      );
    }
    if (!res.ok) {
      let errBody: ApiErrorBody = {};
      try {
        errBody = (await res.json()) as ApiErrorBody;
      } catch {
        /* non-JSON error body — keep the generic message */
      }
      throw new S3xApiError(friendlyMessage(res.status, errBody), res.status, errBody);
    }
    return res;
  }

  /** JSON request/response — the common case. */
  async requestJson<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.send(method, path, opts);
    return (await res.json()) as T;
  }

  /** Streaming GET (NDJSON) — returns the raw body as an async byte iterable. */
  async requestNdjson(path: string, query?: RequestOptions['query']): Promise<AsyncIterable<Uint8Array>> {
    const res = await this.send('GET', path, { query });
    if (!res.body) return (async function* () { /* empty stream */ })();
    return res.body as unknown as AsyncIterable<Uint8Array>;
  }
}

/** Encode one S3 key or path segment for use inside a URL path. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}
