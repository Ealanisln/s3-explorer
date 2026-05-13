// Sidebar bucket list + per-bucket menu + open/versioning.
//
// The sidebar shows one bucket list at a time. Clicking a bucket opens it
// in the currently-active pane. The "active" highlight reflects the bucket
// open in the active pane.

import { State, getPane } from '../state.js';
import type { PaneId } from '../state.js';
import { api } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { $, paneEl, paneElMaybe, escapeHtml } from '../util/dom.js';
import { loadObjects } from '../objects/grid.js';
import { mountIcons } from '../util/icons.js';

interface BucketRow { Name: string; CreationDate: string | null }

function showBucketMenu(e: MouseEvent, b: BucketRow): void {
  e.stopPropagation();
  document.querySelectorAll('.dropdown.bucket-menu').forEach((d) => d.remove());
  const dd = document.createElement('div');
  dd.className = 'dropdown bucket-menu';
  dd.style.position = 'fixed';
  dd.style.left = e.clientX + 'px';
  dd.style.top = e.clientY + 'px';
  dd.innerHTML = '<button data-act="delete" class="danger">Eliminar bucket</button>';
  document.body.appendChild(dd);
  const close = (): void => { dd.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 10);
  dd.onclick = async (ev: Event): Promise<void> => {
    const target = ev.target as HTMLElement;
    if (target.dataset.act === 'delete') {
      if (!confirm(`Eliminar bucket "${b.Name}"? Debe estar vacío.`)) return;
      try {
        await api(`/api/buckets/${encodeURIComponent(b.Name)}`, { method: 'DELETE' });
        toast('Bucket eliminado', 'success');
        const { buckets } = await api<{ buckets: BucketRow[] }>('/api/buckets');
        State.buckets = buckets;
        renderBuckets();
      } catch (e) {
        toast((e as Error).message, 'error', errorIdOpts(e));
      }
    }
  };
}

export function renderBuckets(): void {
  const ul = $('buckets');
  ul.innerHTML = '';
  const active = getPane().activeBucket;
  for (const b of State.buckets) {
    const li = document.createElement('li');
    li.className = b.Name === active ? 'active' : '';
    li.innerHTML = `
      <span class="ft-badge folder" style="width:22px;height:22px"><i data-icon="bucket" data-icon-size="12"></i></span>
      <span class="name">${escapeHtml(b.Name)}</span>
      <span class="menu" data-bucket="${escapeHtml(b.Name)}" aria-label="Menú"><i data-icon="dots_h" data-icon-size="14"></i></span>
    `;
    li.onclick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('menu') || target.closest('.menu')) showBucketMenu(e, b);
      else void openBucket(b.Name);
    };
    ul.appendChild(li);
  }
  mountIcons(ul);
}

let onBucketOpened: (paneId: PaneId) => void = () => undefined;

export function configureBuckets(deps: { onBucketOpened: (paneId: PaneId) => void }): void {
  onBucketOpened = deps.onBucketOpened;
}

export async function openBucket(name: string, paneId?: PaneId): Promise<void> {
  const p: PaneId = paneId || State.activePane;
  const pane = getPane(p);
  pane.activeBucket = name;
  pane.prefix = '';
  renderBuckets();
  await loadVersioning(p);
  await loadObjects(p);
  onBucketOpened(p);
}

export async function loadVersioning(paneId?: PaneId): Promise<void> {
  const p: PaneId = paneId || State.activePane;
  const pane = getPane(p);
  try {
    const { status } = await api<{ status: 'Enabled' | 'Suspended' | 'Disabled' }>(
      `/api/buckets/${encodeURIComponent(pane.activeBucket || '')}/versioning`,
    );
    pane.versioning = status;
    const btn = paneEl('btn-versioning', p) as HTMLButtonElement;
    btn.style.display = 'inline-block';
    const tog = paneElMaybe('toggle-deleted', p);
    if (tog) tog.style.display = status === 'Enabled' ? 'inline-flex' : 'none';
    if (status !== 'Enabled' && pane.showDeleted) {
      pane.showDeleted = false;
      (paneEl('chk-deleted', p) as HTMLInputElement).checked = false;
    }
    if (status === 'Enabled') {
      btn.textContent = 'Versionado: ON 🔒';
      btn.title = 'Versionado activado (permanente desde esta app — para suspenderlo usa awscli)';
      btn.disabled = true;
      btn.onclick = null;
    } else {
      btn.textContent = 'Activar versionado';
      btn.title = 'Activar versionado en este bucket (no se puede desactivar después desde esta app)';
      btn.disabled = false;
      btn.onclick = async (): Promise<void> => {
        if (!confirm(
          `Activar versionado en "${pane.activeBucket}"?\n\n`
          + 'IMPORTANTE: una vez activado, NO podrás desactivarlo desde esta app. '
          + 'Si necesitas suspenderlo, deberás usar awscli o la consola del proveedor.\n\n'
          + '¿Continuar?',
        )) return;
        try {
          await api(`/api/buckets/${encodeURIComponent(pane.activeBucket || '')}/versioning`, {
            method: 'PUT',
            body: { enabled: true },
          });
          toast('Versionado activado', 'success');
          await loadVersioning(p);
        } catch (e) {
          toast((e as Error).message, 'error', errorIdOpts(e));
        }
      };
    }
  } catch {
    pane.versioning = 'Disabled';
  }
}
