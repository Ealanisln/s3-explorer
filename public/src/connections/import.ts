// "Importar desde archivo .cfg/.env" — parses env-style files and pre-fills
// the connection form. File picker + drag-and-drop on the import row.

import { $ } from '../util/dom.js';

function parseEnvLike(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key.startsWith('export ')) key = key.slice(7).trim();
    out[key.toUpperCase()] = val;
  }
  return out;
}

function suggestNameFromFile(filename: string): string {
  const lower = filename.toLowerCase().replace(/^\./, '');
  if (lower.includes('vultr')) return 'Vultr';
  if (lower.includes('aws')) return 'AWS S3';
  if (lower.includes('minio')) return 'MinIO';
  if (lower.includes('r2') || lower.includes('cloudflare')) return 'Cloudflare R2';
  if (lower.includes('wasabi')) return 'Wasabi';
  if (lower.includes('b2') || lower.includes('backblaze')) return 'Backblaze B2';
  if (lower.includes('spaces') || lower.includes('digitalocean')) return 'DigitalOcean Spaces';
  return filename.replace(/^\./, '').replace(/\.[^.]+$/, '').replace(/[._-]+/g, ' ').trim() || 'Importado';
}

function applyImportedToForm(parsed: Record<string, string>, suggestedName: string): boolean {
  const f = $('form-conn') as HTMLFormElement;
  const el = f.elements;
  const get = (name: string): HTMLInputElement => el.namedItem(name) as HTMLInputElement;
  const result = $('import-result');

  const access = parsed.AWS_ACCESS_KEY_ID || parsed.ACCESS_KEY || parsed.ACCESS_KEY_ID || parsed.S3_ACCESS_KEY;
  const secret = parsed.AWS_SECRET_ACCESS_KEY || parsed.SECRET_KEY || parsed.SECRET_ACCESS_KEY || parsed.S3_SECRET_KEY;
  const endpoint = parsed.AWS_S3_ENDPOINT_URL || parsed.AWS_ENDPOINT_URL || parsed.S3_ENDPOINT || parsed.ENDPOINT_URL || parsed.MINIO_URL || '';
  const region = parsed.AWS_S3_REGION_NAME || parsed.AWS_DEFAULT_REGION || parsed.AWS_REGION || parsed.S3_REGION || '';
  const bucket = parsed.AWS_STORAGE_BUCKET_NAME || parsed.S3_BUCKET || parsed.BUCKET_NAME || parsed.BUCKET;
  const sessionToken = parsed.AWS_SESSION_TOKEN || '';

  if (!access || !secret) {
    result.textContent = '✗ El archivo no tiene access key y secret key.';
    result.className = 'test-result err';
    return false;
  }

  if (!get('name').value) get('name').value = suggestedName;
  get('accessKey').value = access;
  get('secretKey').value = secret;
  get('endpoint').value = endpoint;
  if (region) get('region').value = region;
  get('sessionToken').value = sessionToken;
  const isAwsOfficial = /amazonaws\.com$/i.test(endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  (el.namedItem('pathStyle') as HTMLInputElement).checked = !isAwsOfficial;
  if (bucket) {
    const existing = (get('buckets').value || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (!existing.includes(bucket)) existing.push(bucket);
    get('buckets').value = existing.join('\n');
  }
  result.textContent = `✓ Importado · ${Object.keys(parsed).length} campos leídos`;
  result.className = 'test-result ok';
  return true;
}

export function initImport(): void {
  $('btn-import-conn').onclick = (): void => {
    ($('import-conn-file') as HTMLInputElement).click();
  };

  $('import-conn-file').addEventListener('change', async (e: Event): Promise<void> => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const result = $('import-result');
    if (file.size > 64 * 1024) {
      result.textContent = '✗ Archivo demasiado grande (máx 64 KB).';
      result.className = 'test-result err';
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseEnvLike(text);
      applyImportedToForm(parsed, suggestNameFromFile(file.name));
    } catch (err) {
      result.textContent = '✗ ' + (err as Error).message;
      result.className = 'test-result err';
    } finally {
      input.value = '';
    }
  });

  // Drag-and-drop on the import row.
  const row = document.querySelector<HTMLElement>('.import-row');
  if (!row) return;
  (['dragenter', 'dragover'] as const).forEach((ev) => row.addEventListener(ev, (e: Event) => {
    e.preventDefault(); e.stopPropagation();
    row.classList.add('dragover');
  }));
  (['dragleave', 'drop'] as const).forEach((ev) => row.addEventListener(ev, (e: Event) => {
    e.preventDefault(); e.stopPropagation();
    row.classList.remove('dragover');
  }));
  row.addEventListener('drop', async (e: Event): Promise<void> => {
    const ev = e as DragEvent;
    const file = ev.dataTransfer?.files?.[0];
    if (!file) return;
    const result = $('import-result');
    try {
      const text = await file.text();
      const parsed = parseEnvLike(text);
      applyImportedToForm(parsed, suggestNameFromFile(file.name));
    } catch (err) {
      result.textContent = '✗ ' + (err as Error).message;
      result.className = 'test-result err';
    }
  });
}
