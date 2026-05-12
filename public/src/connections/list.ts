// Sidebar connection list + per-row menu + selectConnection.

import { State, activeConn } from '../state.js';
import { api } from '../api/client.js';
import { saveConnections } from '../vault/persistence.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { $, escapeHtml } from '../util/dom.js';
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
        if (State.activeConnId === c.id) {
          State.activeConnId = null;
          clearMain();
        }
        renderConnections();
      }
    }
  };
}

export function renderConnections(): void {
  const ul = $('connections');
  ul.innerHTML = '';
  for (const c of State.connections) {
    const li = document.createElement('li');
    li.className = c.id === State.activeConnId ? 'active' : '';
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

export async function selectConnection(id: string): Promise<void> {
  State.activeConnId = id;
  State.activeBucket = null;
  State.prefix = '';
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
      toggleEmpty(true);
      $('empty').innerHTML = '<h2>Selecciona un bucket</h2><p>Elige un bucket en la barra lateral para navegar tus archivos.</p>';
      return;
    }
    const { buckets } = await api<{ buckets: { Name: string; CreationDate: string | null }[] }>('/api/buckets');
    State.buckets = buckets;
    renderBuckets();
    $('buckets-section').style.display = 'block';
    statusEl.classList.add('online');
    statusEl.textContent = `Conectado · ${buckets.length} buckets`;
    toggleEmpty(true);
    $('empty').innerHTML = '<h2>Selecciona un bucket</h2><p>Elige un bucket en la barra lateral para navegar tus archivos.</p>';
  } catch (e) {
    const err = e as Error;
    statusEl.textContent = 'Error de conexión';
    if (/ListAllMyBuckets|not authorized|AccessDenied/i.test(err.message)) {
      toggleEmpty(true);
      $('empty').innerHTML = `
        <h2>Tu IAM no permite listar buckets</h2>
        <p>Tu credencial no tiene <code>s3:ListAllMyBuckets</code>. Edita la conexión y agrega manualmente los nombres de los buckets que sí tienes permiso para usar.</p>
        <button class="btn btn-primary" id="btn-edit-this-conn">Editar conexión</button>
      `;
      $('btn-edit-this-conn').onclick = (): void => openEditModal(conn);
    } else {
      toast('Error al conectar: ' + err.message, 'error', errorIdOpts(err));
    }
  }
}

export function clearMain(): void {
  $('buckets-section').style.display = 'none';
  $('buckets').innerHTML = '';
  $('grid').style.display = 'none';
  $('breadcrumbs').innerHTML = '';
  const s = $('conn-status');
  s.textContent = 'Sin conexión';
  s.classList.remove('online');
}
