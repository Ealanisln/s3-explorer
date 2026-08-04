// "Mi cuenta" modal: change password + regenerate recovery codes + API tokens.

import { $ } from '../util/dom.js';
import { toast, errorIdOpts } from '../util/toast.js';
import { confirmDialog } from '../util/dialog.js';
import { formatDate } from '../util/format.js';
import { mountIcons } from '../util/icons.js';
// `i18nT` alias exists because the token-table loop below binds `t` to each
// token row, shadowing the translate function inside that template literal.
import { t, t as i18nT, localizeServerError } from '../i18n/index.js';
import { setCurrentUser, getCurrentUser } from './bootstrap.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

export function initAccountForms(): void {
  // Keep the hidden username field in the change-password form synced with
  // the logged-in user so password managers associate the credential with
  // the right account (and the browser's a11y warning goes away).
  const syncPwUsername = (): void => {
    const el = document.getElementById('change-pw-username') as HTMLInputElement | null;
    const u = getCurrentUser();
    if (el && u) el.value = u.username;
  };
  syncPwUsername();

  ($('form-change-password') as HTMLFormElement).onsubmit = async (e: Event): Promise<void> => {
    syncPwUsername();
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
      const data = await res.json() as { ok?: boolean; message?: string; code?: string };
      if (!res.ok) throw new Error(localizeServerError(data));
      msg.textContent = t('account.passwordUpdated');
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
    const ok = await confirmDialog({
      title: t('account.regenTitle'),
      message: t('account.regenMessage'),
      confirmLabel: t('account.regenConfirm'),
    });
    if (!ok) return;
    try {
      const res = await fetch('/auth/me/recovery', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json() as { recoveryCodes?: string[]; message?: string; code?: string };
      if (!res.ok) throw new Error(localizeServerError(data));
      const list = $('new-recovery-codes');
      list.innerHTML = (data.recoveryCodes || []).map((c) => `<div class="code">${escapeHtml(c)}</div>`).join('');
      toast(t('account.codesRegenerated'), 'success', 8000);
    } catch (ex) {
      toast((ex as Error).message, 'error', errorIdOpts(ex));
    }
  };

  initApiTokens();
}

// ----- Personal Access Tokens ("Tokens de API" tab) -----

interface ApiTokenRow {
  id: number;
  name: string;
  scope: 'read' | 'write';
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

async function loadTokens(): Promise<void> {
  const tbody = $('tokens-tbody');
  tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:20px">${escapeHtml(t('common.loading'))}</td></tr>`;
  try {
    const res = await fetch('/auth/tokens', { credentials: 'same-origin' });
    const data = await res.json() as { tokens?: ApiTokenRow[]; message?: string; code?: string };
    if (!res.ok) throw new Error(localizeServerError(data));
    tbody.innerHTML = '';
    if (!data.tokens || data.tokens.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:20px">${escapeHtml(t('tokens.empty'))}</td></tr>`;
      return;
    }
    const now = Date.now();
    for (const t of data.tokens) {
      const expired = t.expiresAt !== null && new Date(t.expiresAt).getTime() <= now;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(t.name)}</td>
        <td><span class="pill ${t.scope === 'write' ? 'warn' : 'ok'}"><span class="dot"></span>${t.scope === 'write' ? i18nT('tokens.pillWrite') : i18nT('tokens.pillRead')}</span></td>
        <td style="font-size:12px;color:var(--text-dim)">${escapeHtml(formatDate(t.createdAt))}</td>
        <td style="font-size:12px;color:var(--text-dim)">${t.expiresAt ? escapeHtml(formatDate(t.expiresAt)) : i18nT('common.never')}</td>
        <td style="font-size:12px;color:var(--text-dim)">${t.lastUsedAt ? escapeHtml(formatDate(t.lastUsedAt)) : i18nT('common.never')}</td>
        <td style="text-align:right">
          ${t.revokedAt
    ? `<span style="color:var(--danger);font-size:12px">${i18nT('tokens.revoked')}</span>`
    : expired
      ? `<span style="color:var(--text-dim);font-size:12px">${i18nT('tokens.expired')}</span>`
      : `<button class="btn-icon" data-act="revoke-token" data-id="${t.id}" data-name="${escapeHtml(t.name)}" title="${i18nT('tokens.revoke')}" aria-label="${i18nT('tokens.revoke')}"><i data-icon="trash"></i></button>`}
        </td>
      `;
      tbody.appendChild(tr);
    }
    mountIcons(tbody);
    tbody.querySelectorAll<HTMLButtonElement>('button[data-act="revoke-token"]').forEach((b) => {
      b.onclick = (): Promise<void> => revokeTokenAction(b.dataset.id || '', b.dataset.name || '');
    });
  } catch (ex) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--danger);padding:20px">${escapeHtml((ex as Error).message)}</td></tr>`;
  }
}

async function revokeTokenAction(id: string, name: string): Promise<void> {
  const ok = await confirmDialog({
    title: t('tokens.revokeTitle'),
    message: t('tokens.revokeMessage', { name }),
    confirmLabel: t('tokens.revoke'),
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await fetch(`/auth/tokens/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    const data = await res.json() as { ok?: boolean; message?: string; code?: string };
    if (!res.ok) throw new Error(localizeServerError(data));
    toast(t('tokens.revokedToast'), 'success');
    loadTokens();
  } catch (ex) {
    toast((ex as Error).message, 'error', errorIdOpts(ex));
  }
}

function initApiTokens(): void {
  // Lazy-load the list the first time (and every time) the tab is opened.
  const tabBtn = document.querySelector<HTMLButtonElement>('#modal-account .modal-tab[data-tab="tokens"]');
  if (tabBtn) {
    tabBtn.addEventListener('click', () => { loadTokens(); });
  }

  ($('form-create-token') as HTMLFormElement).onsubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const msg = $('create-token-msg');
    msg.textContent = '';
    msg.className = 'test-result';
    const expiresRaw = (f.elements.namedItem('expires') as HTMLSelectElement).value;
    try {
      const res = await fetch('/auth/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          name: (f.elements.namedItem('name') as HTMLInputElement).value.trim(),
          scope: (f.elements.namedItem('scope') as HTMLSelectElement).value,
          expiresInDays: expiresRaw ? Number(expiresRaw) : null,
        }),
      });
      const data = await res.json() as { token?: string; message?: string; code?: string };
      if (!res.ok || !data.token) throw new Error(localizeServerError(data));
      f.reset();
      f.hidden = true;
      $('new-token-value').textContent = data.token;
      ($('new-token-box') as HTMLDivElement).hidden = false;
      toast(t('tokens.createdToast'), 'success', 8000);
      loadTokens();
    } catch (ex) {
      msg.textContent = (ex as Error).message;
      msg.className = 'test-result err';
    }
  };

  $('btn-copy-token').onclick = async (): Promise<void> => {
    const value = $('new-token-value').textContent || '';
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast(t('tokens.copied'), 'success');
    } catch {
      toast(t('tokens.copyFailed'), 'error');
    }
  };
}
