// Sidebar connection list + per-row menu + selectConnection.

import { State, getPane, subscribe } from '../state.js';
import type { PaneId } from '../state.js';
import { api } from '../api/client.js';
import { saveConnections } from '../vault/persistence.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { $, paneEl, escapeHtml } from '../util/dom.js';
import { renderBuckets } from '../buckets/list.js';
import { toggleEmpty } from '../objects/grid.js';
import type { Connection } from '../types.js';

let openEditModal: (c: Connection | null) => void = () => undefined;

export function configureConnections(deps: { openEditModal: (c: Connection | null) => void }): void {
  openEditModal = deps.openEditModal;
}

function showConnMenu(e: MouseEvent, c: Connection): void {
  e.stopPropagation();
  document.querySelectorAll('.dropdown.conn-menu').forEach((d) => d.remove());
  const dd = document.createElement('div');
  dd.className = 'dropdown conn-menu';
  dd.style.position = 'fixed';
  dd.style.left = e.clientX + 'px';
  dd.style.top = e.clientY + 'px';
  dd.innerHTML = `
    <button data-act="edit">Editar</button>
    <button data-act="duplicate">Duplicar</button>
    <button data-act="delete" class="danger">Eliminar</button>
  `;
  document.body.appendChild(dd);
  const close = (): void => { dd.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 10);
  dd.onclick = (ev: Event): void => {
    const target = ev.target as HTMLElement;
    const act = target.dataset.act;
    if (act === 'edit') openEditModal(c);
    if (act === 'duplicate') {
      const copy: Connection = { ...c, id: crypto.randomUUID(), name: c.name + ' (copia)' };
      State.connections.push(copy);
      void saveConnections();
      renderConnections();
    }
    if (act === 'delete') {
      if (confirm(`¿Eliminar conexión "${c.name}"?`)) {
        State.connections = State.connections.filter((x) => x.id !== c.id);
        void saveConnections();
        // Clear out of every pane that was pointing at this connection.
        for (const p of ['left', 'right'] as PaneId[]) {
          const pane = getPane(p);
          if (pane.activeConnId === c.id) {
            pane.activeConnId = null;
            pane.activeBucket = null;
            pane.buckets = [];
          }
        }
        clearMain();
        renderConnections();
      }
    }
  };
}

export function renderConnections(): void {
  const ul = $('connections');
  ul.innerHTML = '';
  const active = getPane().activeConnId;
  for (const c of State.connections) {
    const li = document.createElement('li');
    li.className = c.id === active ? 'active' : '';
    li.innerHTML = `
      <span class="icon-file" style="width:22px;height:22px;font-size:10px">S3</span>
      <span class="name" title="${escapeHtml(c.endpoint || 'AWS')}">${escapeHtml(c.name)}</span>
      <span class="menu" data-conn-id="${escapeHtml(c.id)}">⋯</span>
    `;
    li.onclick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('menu')) showConnMenu(e, c);
      else void selectConnection(c.id);
    };
    ul.appendChild(li);
  }
}

export async function selectConnection(id: string, paneId?: PaneId): Promise<void> {
  const p: PaneId = paneId || State.activePane;
  const pane = getPane(p);
  pane.activeConnId = id;
  pane.activeBucket = null;
  pane.prefix = '';
  pane.buckets = [];
  renderConnections();
  const statusEl = $('conn-status');
  statusEl.classList.remove('online');
  statusEl.textContent = 'Conectando...';
  // Resolve the connection directly from the pane, not via the proxied
  // active-pane reader — `paneId` may be the non-active side.
  const conn = State.connections.find((c) => c.id === pane.activeConnId);
  if (!conn) return;
  try {
    if (conn.buckets && conn.buckets.length) {
      pane.buckets = conn.buckets.map((name) => ({ Name: name, CreationDate: null }));
      renderBuckets();
      $('buckets-section').style.display = 'block';
      statusEl.classList.add('online');
      statusEl.textContent = `Conectado · ${conn.buckets.length} buckets (manuales)`;
      toggleEmpty(true, p);
      paneEl('empty', p).innerHTML = '<h2>Selecciona un bucket</h2><p>Elige un bucket en la barra lateral para navegar tus archivos.</p>';
      return;
    }
    // Fetch /api/buckets with this pane's connection headers. The default
    // `authHeaders()` only reads the active pane — if the user clicked the
    // sidebar while focused on the other side, the wrong creds would go out.
    // Build the headers explicitly from the pane we're connecting on.
    const { buckets } = await api<{ buckets: { Name: string; CreationDate: string | null }[] }>(
      '/api/buckets',
      { headers: connHeaders(conn) },
    );
    pane.buckets = buckets;
    renderBuckets();
    $('buckets-section').style.display = 'block';
    statusEl.classList.add('online');
    statusEl.textContent = `Conectado · ${buckets.length} buckets`;
    toggleEmpty(true, p);
    paneEl('empty', p).innerHTML = '<h2>Selecciona un bucket</h2><p>Elige un bucket en la barra lateral para navegar tus archivos.</p>';
  } catch (e) {
    const err = e as Error;
    statusEl.textContent = 'Error de conexión';
    if (/ListAllMyBuckets|not authorized|AccessDenied/i.test(err.message)) {
      toggleEmpty(true, p);
      paneEl('empty', p).innerHTML = `
        <h2>Tu IAM no permite listar buckets</h2>
        <p>Tu credencial no tiene <code>s3:ListAllMyBuckets</code>. Edita la conexión y agrega manualmente los nombres de los buckets que sí tienes permiso para usar.</p>
        <button class="btn btn-primary" data-edit-this-conn>Editar conexión</button>
      `;
      const btn = paneEl('empty', p).querySelector<HTMLButtonElement>('[data-edit-this-conn]');
      if (btn) btn.onclick = (): void => openEditModal(conn);
    } else {
      toast('Error al conectar: ' + err.message, 'error', errorIdOpts(err));
    }
  }
}

// Same shape as api/client.ts authHeaders() but parameterized on a Connection,
// so we can issue requests on behalf of a non-active pane (e.g. when the user
// clicks the sidebar while focused on the other side).
function connHeaders(c: Connection): Record<string, string> {
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

// When the active pane changes (user clicks the other side), refresh the
// sidebar so its highlight + bucket list reflect whichever pane is now focused.
subscribe('activePane', () => {
  renderConnections();
  renderBuckets();
  // Hide the buckets section when the active pane has no connection yet.
  const hasBuckets = getPane().buckets.length > 0;
  $('buckets-section').style.display = hasBuckets ? 'block' : 'none';
});

export function clearMain(): void {
  $('buckets-section').style.display = 'none';
  $('buckets').innerHTML = '';
  for (const p of ['left', 'right'] as PaneId[]) {
    const grid = document.querySelector<HTMLElement>(`.pane[data-pane="${p}"] [data-el="grid"]`);
    const crumbs = document.querySelector<HTMLElement>(`.pane[data-pane="${p}"] [data-el="breadcrumbs"]`);
    if (grid) grid.style.display = 'none';
    if (crumbs) crumbs.innerHTML = '';
  }
  const s = $('conn-status');
  s.textContent = 'Sin conexión';
  s.classList.remove('online');
}
