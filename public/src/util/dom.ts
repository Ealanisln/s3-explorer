// DOM helpers. `$` is the obvious one-liner; the modal/escapeHtml functions
// preserve the existing behavior from the legacy app.js so visual styling
// keeps working without rework.

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[dom] missing element #${id}`);
  return el;
}

export function $maybe(id: string): HTMLElement | null {
  return document.getElementById(id);
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string | number | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] || c);
}

export function openModal(id: string): void {
  $(id).style.display = 'flex';
}

export function closeModal(id: string): void {
  $(id).style.display = 'none';
}
