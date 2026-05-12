// Sidebar bucket list + per-bucket menu + open/versioning.

import { State } from '../state.js';
import { api } from '../api/client.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { $, escapeHtml } from '../util/dom.js';
import { loadObjects } from '../objects/grid.js';

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
  for (const b of State.buckets) {
    const li = document.createElement('li');
    li.className = b.Name === State.activeBucket ? 'active' : '';
    li.innerHTML = `
      <span class="icon-file icon-folder" style="width:22px;height:22px;font-size:10px">📦</span>
      <span class="name">${escapeHtml(b.Name)}</span>
      <span class="menu" data-bucket="${escapeHtml(b.Name)}">⋯</span>
    `;
    li.onclick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('menu')) showBucketMenu(e, b);
      else void openBucket(b.Name);
    };
    ul.appendChild(li);
  }
}

let onBucketOpened: () => void = () => undefined;

export function configureBuckets(deps: { onBucketOpened: () => void }): void {
  onBucketOpened = deps.onBucketOpened;
}

export async function openBucket(name: string): Promise<void> {
  State.activeBucket = name;
  State.prefix = '';
  renderBuckets();
  await loadVersioning();
  await loadObjects();
  onBucketOpened();
}

export async function loadVersioning(): Promise<void> {
  try {
    const { status } = await api<{ status: 'Enabled' | 'Suspended' | 'Disabled' }>(
      `/api/buckets/${encodeURIComponent(State.activeBucket || '')}/versioning`,
    );
    State.versioning = status;
    const btn = $('btn-versioning') as HTMLButtonElement;
    btn.style.display = 'inline-block';
    const tog = document.querySelector<HTMLElement>('.toggle-deleted');
    if (tog) tog.style.display = status === 'Enabled' ? 'inline-flex' : 'none';
    if (status !== 'Enabled' && State.showDeleted) {
      State.showDeleted = false;
      ($('chk-deleted') as HTMLInputElement).checked = false;
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
          `Activar versionado en "${State.activeBucket}"?\n\n`
          + 'IMPORTANTE: una vez activado, NO podrás desactivarlo desde esta app. '
          + 'Si necesitas suspenderlo, deberás usar awscli o la consola del proveedor.\n\n'
          + '¿Continuar?',
        )) return;
        try {
          await api(`/api/buckets/${encodeURIComponent(State.activeBucket || '')}/versioning`, {
            method: 'PUT',
            body: { enabled: true },
          });
          toast('Versionado activado', 'success');
          await loadVersioning();
        } catch (e) {
          toast((e as Error).message, 'error', errorIdOpts(e));
        }
      };
    }
  } catch {
    State.versioning = 'Disabled';
  }
}
