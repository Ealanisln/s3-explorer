// fetch wrapper. Adds the x-s3-* credential headers for the active connection
// (the server uses them per-request and never persists them), plus the
// x-s3-conn-id UUID so the bucket-index feature can scope rows by connection.
//
// Centralizes the auth-error handling: NO_SESSION/USER_INVALID → reload,
// PASSWORD_CHANGE_REQUIRED → reopen the account modal. AWS-style errors carry
// an `errorId` that we attach to the thrown Error so call sites can surface it
// in their toast for log-correlation.

import { activeConn } from '../state.js';
import { toast } from '../util/toast.js';
import { openModal } from '../util/dom.js';
import { t, localizeServerError } from '../i18n/index.js';

export function authHeaders(): Record<string, string> {
  const c = activeConn();
  if (!c) return {};
  return {
    'x-s3-endpoint': c.endpoint || '',
    'x-s3-region': c.region || 'us-east-1',
    'x-s3-access-key': c.accessKey,
    'x-s3-secret-key': c.secretKey,
    'x-s3-session-token': c.sessionToken || '',
    'x-s3-path-style': c.pathStyle ? 'true' : 'false',
    'x-s3-conn-id': c.id,
  };
}

export interface ApiOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

// Error subclass carrying the server-side correlation id so call sites can
// pass it to toast() for display. `instanceof ApiError` lets handlers branch
// when they want to do something fancier than a toast.
export class ApiError extends Error {
  readonly errorId?: string;
  readonly code?: string;
  constructor(message: string, opts: { errorId?: string; code?: string } = {}) {
    super(message);
    this.name = 'ApiError';
    this.errorId = opts.errorId;
    this.code = opts.code;
  }
}

interface ErrorPayload {
  code?: string;
  message?: string;
  errorId?: string;
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders(), ...(opts.headers || {}) };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (opts.body instanceof FormData) {
      body = opts.body;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
  }
  const res = await fetch(path, {
    method: opts.method,
    headers,
    body,
    credentials: 'same-origin',
    signal: opts.signal,
  });
  if (res.status === 401) {
    const err = await res.json().catch(() => ({} as ErrorPayload));
    if (err.code === 'NO_SESSION' || err.code === 'USER_INVALID') {
      toast(t('api.sessionExpired'), 'error', 4000);
      setTimeout(() => location.reload(), 1500);
    }
    throw new ApiError(localizeServerError(err, t('api.notAuthenticated')), { errorId: err.errorId, code: err.code });
  }
  if (res.status === 403) {
    const err = await res.json().catch(() => ({} as ErrorPayload));
    if (err.code === 'PASSWORD_CHANGE_REQUIRED') {
      // Server is enforcing the password rotation the SPA nags about on init.
      // Reopen the modal so the user can't just dismiss it once and keep going.
      openModal('modal-account');
      toast(t('auth.mustChangePassword'), 'info', 6000);
    }
    throw new ApiError(localizeServerError(err, t('api.rejected')), { errorId: err.errorId, code: err.code });
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText } as ErrorPayload));
    // Known machine codes get a localized message; unknown ones keep the
    // server-provided text (Spanish) as-is.
    throw new ApiError(localizeServerError(err, t('common.error')), { errorId: err.errorId, code: err.code });
  }
  return res.json() as Promise<T>;
}
