// Shared shell for the custom context/dropdown menus (file rows, folder
// rows). Owns the behavior both menus used to duplicate: single-instance
// enforcement, fixed positioning at the cursor with viewport clamping,
// outside-click dismissal, and Escape dismissal (matching the keyboard
// behavior of util/dialog.ts). Callers provide the inner HTML — trusted
// `<button data-act="...">` entries built from i18n strings — and an action
// dispatcher keyed on `data-act`.

export interface MenuPosition {
  left: number;
  top: number;
}

// Pure clamping logic, exported for unit tests. Given the cursor point and
// the menu's measured size, keep the menu fully inside the viewport with a
// small margin: if it would overflow the right/bottom edge, pull it back;
// never past the top-left margin even when the menu is bigger than the
// viewport.
export function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): MenuPosition {
  let left = x;
  let top = y;
  if (left + menuWidth + margin > viewportWidth) {
    left = Math.max(margin, viewportWidth - menuWidth - margin);
  }
  if (top + menuHeight + margin > viewportHeight) {
    top = Math.max(margin, viewportHeight - menuHeight - margin);
  }
  return { left, top };
}

export interface ContextMenuOptions {
  /** Cursor position (event.clientX / clientY). */
  x: number;
  y: number;
  /** Inner HTML: `<button data-act="...">` entries. Trusted strings only. */
  html: string;
  /**
   * Invoked with the `data-act` of the clicked entry. Any click — inside or
   * outside the menu — also closes it via the document-level listener.
   */
  onAction: (act: string, ev: MouseEvent) => void | Promise<void>;
}

export function openContextMenu(opts: ContextMenuOptions): void {
  // Only one menu at a time — remove any previous instance. Its document
  // listeners self-remove on the next click/Escape (their close() is then a
  // no-op on the already-detached element).
  document.querySelectorAll('.dropdown.row-actions-menu').forEach((d) => d.remove());

  const dd = document.createElement('div');
  dd.className = 'dropdown row-actions-menu';
  dd.style.position = 'fixed';
  // Position initially at the cursor — we'll clamp into the viewport once we
  // know the dropdown's real size (only available after appendChild).
  dd.style.left = opts.x + 'px';
  dd.style.top = opts.y + 'px';
  dd.style.visibility = 'hidden';
  dd.innerHTML = opts.html;
  document.body.appendChild(dd);

  const rect = dd.getBoundingClientRect();
  const { left, top } = clampMenuPosition(
    opts.x, opts.y, rect.width, rect.height, window.innerWidth, window.innerHeight,
  );
  dd.style.left = left + 'px';
  dd.style.top = top + 'px';
  dd.style.visibility = '';

  const close = (): void => {
    dd.remove();
    document.removeEventListener('click', close);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  // Deferred so the click that opened the menu doesn't immediately close it.
  setTimeout(() => document.addEventListener('click', close), 10);
  document.addEventListener('keydown', onKey);

  dd.onclick = (ev: MouseEvent): void => {
    const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act) void opts.onAction(act, ev);
  };
}
