// DOM helpers. `$` resolves by global id (sidebar, modals, etc.).
// `paneEl` resolves a pane-scoped element by `data-el` inside the active pane
// (or a specific pane), used for everything inside the two-pane explorer.
//
// Pane-scoped elements use `data-el="X"` rather than `id="X"` so the right
// pane can be a runtime clone of the left without colliding ids.

import type { PaneId } from '../state.js';

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[dom] missing element #${id}`);
  return el;
}

export function $maybe(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function paneRoot(paneId: PaneId): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.pane[data-pane="${paneId}"]`);
  if (!el) throw new Error(`[dom] missing pane root data-pane="${paneId}"`);
  return el;
}

export function paneEl(name: string, paneId: PaneId): HTMLElement {
  const el = paneRoot(paneId).querySelector<HTMLElement>(`[data-el="${name}"]`);
  if (!el) throw new Error(`[dom] missing [data-el="${name}"] inside pane ${paneId}`);
  return el;
}

export function paneElMaybe(name: string, paneId: PaneId): HTMLElement | null {
  return paneRoot(paneId).querySelector<HTMLElement>(`[data-el="${name}"]`);
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
