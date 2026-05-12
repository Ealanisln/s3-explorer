// fetch wrapper. Adds the x-s3-* credential headers for the active connection
// (the server uses them per-request and never persists them), plus the
// x-s3-conn-id UUID so the bucket-index feature can scope rows by connection.
//
// Centralizes the auth-error handling: NO_SESSION/USER_INVALID → reload,
// PASSWORD_CHANGE_REQUIRED → reopen the account modal.

import { activeConn } from '../state.js';
import { toast } from '../util/toast.js';
import { openModal } from '../util/dom.js';

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
    const err = await res.json().catch(() => ({} as { code?: string; message?: string }));
    if (err.code === 'NO_SESSION' || err.code === 'USER_INVALID') {
      toast('Sesión expirada — reiniciando.', 'error', 4000);
      setTimeout(() => location.reload(), 1500);
    }
    throw new Error(err.message || 'No autenticado');
  }
  if (res.status === 403) {
    const err = await res.json().catch(() => ({} as { code?: string; message?: string }));
    if (err.code === 'PASSWORD_CHANGE_REQUIRED') {
      // Server is enforcing the password rotation the SPA nags about on init.
      // Reopen the modal so the user can't just dismiss it once and keep going.
      openModal('modal-account');
      toast('Debes cambiar tu contraseña inicial antes de continuar.', 'info', 6000);
    }
    throw new Error(err.message || 'Operación rechazada');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText } as { message: string }));
    throw new Error(err.message || 'Error');
  }
  return res.json() as Promise<T>;
}
