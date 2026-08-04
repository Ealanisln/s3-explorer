import { t } from '../i18n/index.js';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastOpts {
  // Server-side correlation id. When present, rendered as a second line in a
  // monospace clickable span so the user can copy it for support — and admin
  // can grep server logs by the same string.
  errorId?: string;
}

export function toast(
  msg: string,
  kind: ToastKind = 'info',
  msOrOpts: number | ToastOpts = 3000,
  maybeOpts: ToastOpts = {},
): void {
  const ms = typeof msOrOpts === 'number' ? msOrOpts : 3000;
  const opts = typeof msOrOpts === 'object' ? msOrOpts : maybeOpts;

  const c = document.getElementById('toast-container');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;

  const msgEl = document.createElement('div');
  msgEl.textContent = msg;
  el.appendChild(msgEl);

  if (opts.errorId) {
    const idEl = document.createElement('div');
    idEl.className = 'toast-error-id';
    idEl.textContent = opts.errorId;
    idEl.title = t('toast.copyErrorId');
    idEl.style.cursor = 'pointer';
    idEl.onclick = (): void => {
      navigator.clipboard.writeText(opts.errorId!).catch(() => undefined);
    };
    el.appendChild(idEl);
  }

  c.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// Helper: pull errorId off any thrown value, return as ToastOpts. Lets call
// sites do `toast(e.message, 'error', errorIdOpts(e))` without repeated casts.
export function errorIdOpts(e: unknown): ToastOpts {
  if (e && typeof e === 'object' && 'errorId' in e) {
    const id = (e as { errorId?: unknown }).errorId;
    if (typeof id === 'string') return { errorId: id };
  }
  return {};
}
