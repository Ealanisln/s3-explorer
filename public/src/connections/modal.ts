// Connection form modal — create/edit + test connection.

import { State } from '../state.js';
import { saveConnections } from '../vault/persistence.js';
import { $, openModal, closeModal } from '../util/dom.js';
import { renderConnections, selectConnection } from './list.js';
import type { Connection } from '../types.js';

function readConnForm(): Connection {
  const f = $('form-conn') as HTMLFormElement;
  const el = f.elements;
  const get = (name: string): HTMLInputElement => el.namedItem(name) as HTMLInputElement;
  const bucketsRaw = (get('buckets').value || '')
    .split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const buckets = [...new Set(bucketsRaw)];
  return {
    id: get('id').value || crypto.randomUUID(),
    name: get('name').value.trim(),
    endpoint: get('endpoint').value.trim(),
    region: get('region').value.trim() || 'us-east-1',
    accessKey: get('accessKey').value.trim(),
    secretKey: get('secretKey').value,
    sessionToken: get('sessionToken').value.trim(),
    pathStyle: (el.namedItem('pathStyle') as HTMLInputElement).checked,
    buckets,
  };
}

// Tracks whether the modal was opened for a fresh connection (create) or to
// edit an existing one. Used by the submit handler to guarantee a NEW uuid
// for create-mode submissions, even if the hidden id field still carries a
// stale value from a previous edit (form.reset() does NOT always clear hidden
// inputs whose value was set programmatically — that's the bug that made
// adding a second Vultr connection overwrite the first).
let modalMode: 'create' | 'edit' = 'create';

export function openConnModal(c: Connection | null): void {
  const f = $('form-conn') as HTMLFormElement;
  const el = f.elements;
  const get = (name: string): HTMLInputElement => el.namedItem(name) as HTMLInputElement;
  f.reset();
  modalMode = c ? 'edit' : 'create';
  // Always wipe the hidden id field FIRST so even if the form-reset quirk
  // left a stale id, we're starting from a clean slate.
  get('id').value = '';
  $('test-result').textContent = '';
  const importResult = document.getElementById('import-result');
  if (importResult) { importResult.textContent = ''; importResult.className = 'test-result'; }
  $('conn-modal-title').textContent = c ? 'Editar conexión' : 'Nueva conexión S3';
  if (c) {
    get('id').value = c.id;
    get('name').value = c.name;
    get('endpoint').value = c.endpoint || '';
    get('region').value = c.region || 'us-east-1';
    get('accessKey').value = c.accessKey;
    get('secretKey').value = c.secretKey;
    get('sessionToken').value = c.sessionToken || '';
    (el.namedItem('pathStyle') as HTMLInputElement).checked = c.pathStyle !== false;
    get('buckets').value = (c.buckets || []).join('\n');
  } else {
    get('region').value = 'us-east-1';
    (el.namedItem('pathStyle') as HTMLInputElement).checked = true;
  }
  openModal('modal-conn');
}

export function initConnModal(): void {
  $('btn-add-conn').onclick = (): void => openConnModal(null);
  $('btn-first-conn').onclick = (): void => openConnModal(null);

  $('btn-test-conn').onclick = async (): Promise<void> => {
    const conn = readConnForm();
    const tr = $('test-result');
    tr.textContent = 'Probando...';
    tr.className = 'test-result';
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-s3-endpoint': conn.endpoint || '',
        'x-s3-region': conn.region,
        'x-s3-access-key': conn.accessKey,
        'x-s3-secret-key': conn.secretKey,
        'x-s3-session-token': conn.sessionToken,
        'x-s3-path-style': conn.pathStyle ? 'true' : 'false',
      };
      const body = conn.buckets && conn.buckets.length ? { bucket: conn.buckets[0] } : {};
      const res = await fetch('/api/test', {
        method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body),
      });
      const data = await res.json() as { mode?: string; bucket?: string; bucketCount?: number; message?: string };
      if (!res.ok) throw new Error(data.message || 'Error');
      if (data.mode === 'head-bucket') tr.textContent = `✓ OK · acceso a "${data.bucket}"`;
      else tr.textContent = `✓ OK · ${data.bucketCount} buckets`;
      tr.className = 'test-result ok';
    } catch (e) {
      tr.textContent = '✗ ' + (e as Error).message;
      tr.className = 'test-result err';
    }
  };

  ($('form-conn') as HTMLFormElement).onsubmit = (e: Event): void => {
    e.preventDefault();
    const conn = readConnForm();
    // Defense in depth: in create mode, always mint a fresh uuid regardless
    // of what the hidden field contains. This guarantees a new connection
    // even if a stale id somehow leaked through from a previous edit-mode
    // session of the same modal.
    if (modalMode === 'create') conn.id = crypto.randomUUID();
    const idx = State.connections.findIndex((c) => c.id === conn.id);
    if (idx >= 0) State.connections[idx] = conn;
    else State.connections.push(conn);
    void saveConnections();
    renderConnections();
    closeModal('modal-conn');
    void selectConnection(conn.id);
  };
}
