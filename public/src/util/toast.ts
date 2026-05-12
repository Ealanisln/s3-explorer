export type ToastKind = 'info' | 'success' | 'error';

export function toast(msg: string, kind: ToastKind = 'info', ms = 3000): void {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
