// "Crear / desbloquear bóveda" modal handlers. The crypto work happens in
// crypto.ts; this module owns the DOM listeners + the migrate-from-legacy
// flow when an old plaintext vault is present.

import { $, openModal, closeModal } from '../util/dom.js';
import { confirmDialog } from '../util/dialog.js';
import { toast } from '../util/toast.js';
import { State } from '../state.js';
import {
  deriveKey, encryptVault, decryptVault, b64dec, randomSalt, b64,
} from './crypto.js';
import {
  getVault, clearVault, clearLegacy, setVaultKey,
  getPendingMigration, setPendingMigration,
  VAULT_KEY,
} from './persistence.js';
import type { Connection } from '../types.js';

type Mode = 'create' | 'unlock';

export function openPassphraseModal(opts: { mode: Mode }): void {
  const isCreate = opts.mode === 'create';
  const pending = getPendingMigration();
  const hasMigration = isCreate && pending && pending.length > 0;
  $('passphrase-title').textContent = isCreate
    ? (hasMigration ? 'Cifra tus conexiones existentes' : 'Crea una contraseña para la bóveda')
    : 'Desbloquea tu bóveda';
  $('passphrase-hint').textContent = isCreate
    ? (hasMigration
        ? `Detectamos ${pending!.length} conexión(es) guardada(s) en texto plano. Crea una contraseña para cifrarlas. Si la olvidas, deberás reingresarlas.`
        : 'Tus conexiones S3 se cifrarán localmente con AES-256-GCM. Esta contraseña no se envía al servidor. Si la olvidas, deberás reingresar tus conexiones.')
    : 'Ingresa la contraseña que usaste para cifrar tus conexiones S3.';
  $('passphrase-confirm-wrap').style.display = isCreate ? 'block' : 'none';
  $('passphrase-error').textContent = '';
  ($('form-passphrase') as HTMLFormElement).reset();
  $('btn-passphrase-reset').style.display = isCreate ? 'none' : 'inline-block';
  openModal('modal-passphrase');
  setTimeout(
    () => document.querySelector<HTMLInputElement>('#form-passphrase input[name=passphrase]')?.focus(),
    50,
  );
}

export interface PassphraseDeps {
  onUnlocked: () => void | Promise<void>;
}

export function initPassphraseForm(deps: PassphraseDeps): void {
  ($('form-passphrase') as HTMLFormElement).onsubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const errEl = $('passphrase-error');
    errEl.textContent = '';
    const f = e.target as HTMLFormElement;
    const pass = (f.elements.namedItem('passphrase') as HTMLInputElement).value;
    const confirmInput = (f.elements.namedItem('confirm') as HTMLInputElement).value;
    const vault = getVault();
    try {
      if (!vault) {
        if (pass.length < 8) { errEl.textContent = 'Mínimo 8 caracteres.'; return; }
        if (pass !== confirmInput) { errEl.textContent = 'Las contraseñas no coinciden.'; return; }
        const salt = randomSalt();
        const key = await deriveKey(pass, salt);
        const pending = getPendingMigration();
        const initial = pending && pending.length ? pending : [];
        const envelope = await encryptVault(initial, key);
        localStorage.setItem(VAULT_KEY, JSON.stringify({ v: 1, salt: b64(salt), ...envelope }));
        setVaultKey(key);
        State.connections = initial;
        if (pending && pending.length) {
          clearLegacy();
          setPendingMigration(null);
          toast('Conexiones migradas a la bóveda cifrada.', 'success', 5000);
        }
      } else {
        const salt = b64dec(vault.salt);
        const key = await deriveKey(pass, salt);
        try {
          State.connections = await decryptVault<Connection[]>(vault, key);
        } catch {
          errEl.textContent = 'Contraseña incorrecta.';
          return;
        }
        setVaultKey(key);
      }
      closeModal('modal-passphrase');
      await deps.onUnlocked();
    } catch (err) {
      errEl.textContent = (err as Error).message || 'Error';
    }
  };

  $('btn-passphrase-reset').onclick = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Borrar bóveda',
      message: 'Esto borrará permanentemente todas tus conexiones guardadas. Tendrás que reingresarlas. Esta acción no se puede deshacer.',
      confirmLabel: 'Borrar bóveda',
      danger: true,
    });
    if (!ok) return;
    clearVault();
    setVaultKey(null);
    State.connections = [];
    closeModal('modal-passphrase');
    openPassphraseModal({ mode: 'create' });
  };
}
