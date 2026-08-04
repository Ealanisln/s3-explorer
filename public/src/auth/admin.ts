// Admin "Usuarios" modal — lists users + per-row actions (reset password,
// reset TOTP, enable/disable) + create-user form.
//
// Only mounted when current user has role:'admin'; auth/bootstrap.ts toggles
// the visibility of the trigger button accordingly.

import { $, openModal, escapeHtml } from '../util/dom.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { confirmDialog, promptDialog } from '../util/dialog.js';
import { formatDate } from '../util/format.js';
import { mountIcons } from '../util/icons.js';
import { t, localizeServerError } from '../i18n/index.js';
import { getCurrentUser } from './bootstrap.js';

interface AdminUserRow {
  username: string;
  role: 'admin' | 'user';
  totpEnrolled: boolean;
  recoveryRemaining: number;
  lastLoginAt: string | null;
  disabled: boolean;
}

async function loadUsersAdmin(): Promise<void> {
  const tbody = $('users-tbody');
  tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:20px">${escapeHtml(t('common.loading'))}</td></tr>`;
  try {
    const res = await fetch('/auth/admin/users', { credentials: 'same-origin' });
    const data = await res.json() as { users?: AdminUserRow[]; message?: string; code?: string };
    if (!res.ok) throw new Error(localizeServerError(data));
    const me = getCurrentUser();
    tbody.innerHTML = '';
    for (const u of data.users || []) {
      const tr = document.createElement('tr');
      const isMe = me && u.username === me.username;
      tr.innerHTML = `
        <td>${escapeHtml(u.username)}</td>
        <td><span class="user-role ${u.role === 'admin' ? 'admin' : ''}">${u.role.toUpperCase()}</span></td>
        <td>${u.totpEnrolled
          ? `<span class="pill ok"><span class="dot"></span>${t('users.pillEnabled')}</span> <span style="color:var(--text-dim);font-size:11px;margin-left:6px">${t('users.codesAbbrev', { count: u.recoveryRemaining })}</span>`
          : `<span class="pill warn"><span class="dot"></span>${t('users.pillPending')}</span>`}</td>
        <td style="font-size:12px;color:var(--text-dim)">${u.lastLoginAt ? escapeHtml(formatDate(u.lastLoginAt)) : t('common.never')}</td>
        <td>${u.disabled ? `<span style="color:var(--danger)">${t('users.disabled')}</span>` : t('users.active')}</td>
        <td style="text-align:right">
          ${isMe ? `<span style="color:var(--text-dim);font-size:11px">${t('users.you')}</span>` :
            `<button class="btn-icon" data-act="reset-totp" data-user="${escapeHtml(u.username)}" title="${t('users.resetTotp')}" aria-label="${t('users.resetTotp')}"><i data-icon="key"></i></button>
             <button class="btn-icon" data-act="reset-pw" data-user="${escapeHtml(u.username)}" title="${t('users.resetPassword')}" aria-label="${t('users.resetPassword')}"><i data-icon="lock"></i></button>
             <button class="btn-icon" data-act="${u.disabled ? 'enable' : 'disable'}" data-user="${escapeHtml(u.username)}" title="${u.disabled ? t('users.enable') : t('users.disable')}" aria-label="${u.disabled ? t('users.enable') : t('users.disable')}"><i data-icon="${u.disabled ? 'power' : 'lock'}"></i></button>`}
        </td>
      `;
      tbody.appendChild(tr);
    }
    mountIcons(tbody);
    tbody.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
      b.onclick = (): Promise<void> => handleUserAction(b.dataset.act || '', b.dataset.user || '');
    });
  } catch (ex) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--danger);padding:20px">${escapeHtml((ex as Error).message)}</td></tr>`;
  }
}

async function handleUserAction(act: string, username: string): Promise<void> {
  let body: Record<string, unknown> | undefined;
  let url = '';
  let confirmTitle = '';
  let confirmMsg = '';
  let confirmLabel = t('common.accept');
  let danger = false;
  if (act === 'disable') {
    confirmTitle = t('users.disableTitle');
    confirmMsg = t('users.disableMessage', { name: username });
    confirmLabel = t('users.disable');
    danger = true;
    url = `/auth/admin/users/${encodeURIComponent(username)}/disable`;
  } else if (act === 'enable') {
    confirmTitle = t('users.enableTitle');
    confirmMsg = t('users.enableMessage', { name: username });
    confirmLabel = t('users.enable');
    url = `/auth/admin/users/${encodeURIComponent(username)}/enable`;
  } else if (act === 'reset-totp') {
    confirmTitle = t('users.resetTotp');
    confirmMsg = t('users.resetTotpMessage', { name: username });
    confirmLabel = t('users.resetTotp');
    danger = true;
    url = `/auth/admin/users/${encodeURIComponent(username)}/reset-totp`;
  } else if (act === 'reset-pw') {
    const np = await promptDialog({
      title: t('users.resetPwTitle'),
      message: t('users.resetPwMessage', { name: username }),
      inputType: 'password',
      placeholder: t('users.resetPwPlaceholder'),
      confirmLabel: t('users.resetPwApply'),
      validate: (v) => (v.length < 8 ? t('users.resetPwTooShort') : null),
    });
    if (np === null) return;
    body = { newPassword: np };
    url = `/auth/admin/users/${encodeURIComponent(username)}/reset-password`;
  } else {
    return;
  }
  if (confirmMsg) {
    const ok = await confirmDialog({ title: confirmTitle, message: confirmMsg, confirmLabel, danger });
    if (!ok) return;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json() as { ok?: boolean; message?: string; code?: string };
    if (!res.ok) throw new Error(localizeServerError(data));
    toast('OK', 'success');
    loadUsersAdmin();
  } catch (ex) {
    toast((ex as Error).message, 'error', errorIdOpts(ex));
  }
}

export function initAdminUsers(): void {
  $('btn-admin-users').onclick = async (): Promise<void> => {
    await loadUsersAdmin();
    openModal('modal-users');
  };

  ($('form-create-user') as HTMLFormElement).onsubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const msg = $('create-user-msg');
    msg.textContent = '';
    try {
      const res = await fetch('/auth/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username: (f.elements.namedItem('username') as HTMLInputElement).value.trim(),
          password: (f.elements.namedItem('password') as HTMLInputElement).value,
          role: (f.elements.namedItem('role') as HTMLSelectElement).value,
        }),
      });
      const data = await res.json() as { ok?: boolean; message?: string; code?: string };
      if (!res.ok) throw new Error(localizeServerError(data));
      msg.textContent = t('users.created', { name: (f.elements.namedItem('username') as HTMLInputElement).value });
      msg.className = 'test-result ok';
      f.reset();
      loadUsersAdmin();
    } catch (ex) {
      msg.textContent = (ex as Error).message;
      msg.className = 'test-result err';
    }
  };
}
