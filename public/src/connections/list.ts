// Sidebar connection list + per-row menu + selectConnection.

import { State, activeConn, getPane, subscribe } from '../state.js';
import type { PaneId } from '../state.js';
import { api } from '../api/client.js';
import { saveConnections } from '../vault/persistence.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { mountIcons } from '../util/icons.js';
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
      <span class="ft-badge def" style="width:22px;height:22px;font-size:9px">S3</span>
      <span class="name" title="${escapeHtml(c.endpoint || 'AWS')}">${escapeHtml(c.name)}</span>
      <span class="menu" data-conn-id="${escapeHtml(c.id)}" aria-label="Menú"><i data-icon="dots_h" data-icon-size="14"></i></span>
    `;
    li.onclick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('menu') || target.closest('.menu')) showConnMenu(e, c);
      else void selectConnection(c.id);
    };
    ul.appendChild(li);
  }
  mountIcons(ul);
}

export async function selectConnection(id: string, paneId?: PaneId): Promise<void> {
  const p: PaneId = paneId || State.activePane;
  const pane = getPane(p);
  pane.activeConnId = id;
  pane.activeBucket = null;
  pane.prefix = '';
  renderConnections();
  const statusEl = $('conn-status');
  statusEl.classList.remove('online');
  statusEl.textContent = 'Conectando...';
  const conn = activeConn();
  if (!conn) return;
  try {
    if (conn.buckets && conn.buckets.length) {
      State.buckets = conn.buckets.map((name) => ({ Name: name, CreationDate: null }));
      renderBuckets();
      $('buckets-section').style.display = 'block';
      statusEl.classList.add('online');
      statusEl.textContent = `Conectado · ${conn.buckets.length} buckets (manuales)`;
      toggleEmpty(true, p);
      paneEl('empty', p).innerHTML = '<h2>Selecciona un bucket</h2><p>Elige un bucket en la barra lateral para navegar tus archivos.</p>';
      return;
    }
    const { buckets } = await api<{ buckets: { Name: string; CreationDate: string | null }[] }>('/api/buckets');
    State.buckets = buckets;
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

// When the active pane changes (user clicks the other side), refresh the
// sidebar so its highlight reflects whichever pane is now focused.
subscribe('activePane', () => {
  renderConnections();
  renderBuckets();
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
