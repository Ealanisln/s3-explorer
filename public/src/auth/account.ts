// "Mi cuenta" modal: change password + regenerate recovery codes.

import { $ } from '../util/dom.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { setCurrentUser, getCurrentUser } from './bootstrap.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

export function initAccountForms(): void {
  ($('form-change-password') as HTMLFormElement).onsubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const msg = $('account-pw-msg');
    msg.textContent = '';
    msg.className = 'test-result';
    try {
      const res = await fetch('/auth/me/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          currentPassword: (f.elements.namedItem('current') as HTMLInputElement).value,
          newPassword: (f.elements.namedItem('next') as HTMLInputElement).value,
        }),
      });
      const data = await res.json() as { ok?: boolean; message?: string };
      if (!res.ok) throw new Error(data.message || 'Error');
      msg.textContent = '✓ Contraseña actualizada';
      msg.className = 'test-result ok';
      f.reset();
      const u = getCurrentUser();
      if (u) setCurrentUser({ ...u, mustChangePassword: false });
    } catch (ex) {
      msg.textContent = (ex as Error).message;
      msg.className = 'test-result err';
    }
  };

  $('btn-regen-recovery').onclick = async (): Promise<void> => {
    if (!confirm('Regenerar invalidará tus códigos actuales. ¿Continuar?')) return;
    try {
      const res = await fetch('/auth/me/recovery', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json() as { recoveryCodes?: string[]; message?: string };
      if (!res.ok) throw new Error(data.message || 'Error');
      const list = $('new-recovery-codes');
      list.innerHTML = (data.recoveryCodes || []).map((c) => `<div class="code">${escapeHtml(c)}</div>`).join('');
      toast('Códigos regenerados. Guárdalos ahora.', 'success', 8000);
    } catch (ex) {
      toast((ex as Error).message, 'error', errorIdOpts(ex));
    }
  };
}
