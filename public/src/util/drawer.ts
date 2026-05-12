// Mobile sidebar drawer.
// CSS owns the layout (off-canvas + transition); this module owns the
// toggle state. The drawer is irrelevant on desktop (sidebar stays in its
// own grid column above 768px), but the listeners are cheap to attach
// unconditionally so we don't need to listen to resize events.

import { $, $maybe } from './dom.js';

function setOpen(open: boolean): void {
  const sidebar = $maybe('sidebar');
  const backdrop = $maybe('sidebar-backdrop');
  if (!sidebar || !backdrop) return;
  sidebar.classList.toggle('open', open);
  backdrop.classList.toggle('open', open);
}

export function initDrawer(): void {
  const menu = $maybe('btn-menu');
  if (!menu) return;
  menu.onclick = (): void => {
    const sidebar = $maybe('sidebar');
    if (!sidebar) return;
    setOpen(!sidebar.classList.contains('open'));
  };

  const backdrop = $maybe('sidebar-backdrop');
  if (backdrop) backdrop.onclick = (): void => setOpen(false);

  // Auto-close after the user picks a connection / bucket — the drawer's job
  // is done and we want to give focus back to the content.
  $('connections').addEventListener('click', () => setOpen(false));
  $('buckets').addEventListener('click', () => setOpen(false));

  // Esc closes the drawer too (matches the modal behavior).
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  });
}
