// Auth screen orchestration + DOM wiring for login → TOTP → enrollment →
// recovery codes. Port of the legacy app.js authInit/startEnrollment block;
// behavior preserved 1:1 so existing users see the same flow.
//
// The post-auth callback (e.g. loadConnections) is injected via initAuthForms's
// `deps.onAuthenticated`. Default is no-op so this module compiles standalone.

import { $, $maybe, openModal } from '../util/dom.js';
import { confirmDialog } from '../util/dialog.js';
import { toast } from '../util/toast.js';
import { setVaultKey } from '../vault/persistence.js';
import { State } from '../state.js';
import { t, localizeServerError } from '../i18n/index.js';
import type { CurrentUser } from '../types.js';

let currentUser: CurrentUser | null = null;

export function getCurrentUser(): CurrentUser | null {
  return currentUser;
}

export function setCurrentUser(u: CurrentUser | null): void {
  currentUser = u;
}

export interface AuthBootstrapDeps {
  onAuthenticated: () => void | Promise<void>; // hand-off to connections loader
}

let deps: AuthBootstrapDeps = { onAuthenticated: () => undefined };

export function configureAuthDeps(d: AuthBootstrapDeps): void {
  deps = d;
}

// ─── Screen switching ──────────────────────────────────────────────────────

type ScreenName = 'login' | 'totp' | 'enroll' | 'recovery' | null;

export function showAuthScreen(name: ScreenName): void {
  $('auth-overlay').style.display = 'grid';
  for (const id of ['auth-login-form', 'auth-totp-form', 'auth-enroll', 'auth-recovery']) {
    const el = $(id);
    const visible = id === `auth-${name}` ||
      (name === 'login' && id === 'auth-login-form') ||
      (name === 'totp' && id === 'auth-totp-form');
    el.style.display = visible ? 'block' : 'none';
  }
}

export function hideAuthOverlay(): void {
  $('auth-overlay').style.display = 'none';
}

export function renderUserChip(): void {
  if (!currentUser) return;
  $('sidebar-user').style.display = 'flex';
  $('user-name').textContent = currentUser.username;
  const role = $('user-role');
  role.textContent = currentUser.role === 'admin' ? 'ADMIN' : 'USER';
  role.className = 'user-role' + (currentUser.role === 'admin' ? ' admin' : '');
  $('btn-admin-users').style.display = currentUser.role === 'admin' ? 'inline-block' : 'none';
}

// ─── Boot flow ─────────────────────────────────────────────────────────────

export async function authInit(): Promise<boolean> {
  try {
    const res = await fetch('/auth/me', { credentials: 'same-origin' });
    const me = await res.json() as CurrentUser;
    if (!me.authenticated) {
      showAuthScreen('login');
      return false;
    }
    currentUser = me;
    if (!me.totpEnrolled) {
      await startEnrollment();
      return false;
    }
    if (me.mustChangePassword) {
      // Server-side requirePasswordCurrent ALSO enforces this; the modal is
      // the UX nudge.
      showAuthScreen(null);
      hideAuthOverlay();
      renderUserChip();
      openModal('modal-account');
      toast(t('auth.mustChangePassword'), 'info', 6000);
      return true;
    }
    hideAuthOverlay();
    renderUserChip();
    return true;
  } catch {
    showAuthScreen('login');
    return false;
  }
}

// ─── TOTP enrollment ──────────────────────────────────────────────────────

export async function startEnrollment(regenerate = false): Promise<void> {
  showAuthScreen('enroll');
  try {
    const url = regenerate ? '/auth/totp/setup?regenerate=1' : '/auth/totp/setup';
    const res = await fetch(url, { method: 'POST', credentials: 'same-origin' });
    const data = await res.json() as { otpauth: string; qrSvg: string; secret: string; message?: string; code?: string };
    if (!res.ok) throw new Error(localizeServerError(data));
    $('enroll-qr').innerHTML = data.qrSvg;
    $('enroll-secret').textContent = data.secret;
    setTimeout(() =>
      (document.querySelector<HTMLInputElement>('#auth-enroll-confirm-form input[name=code]'))?.focus(),
      50,
    );
  } catch (ex) {
    $('auth-enroll-error').textContent = (ex as Error).message;
  }
}

function showRecoveryCodes(codes: string[]): void {
  showAuthScreen('recovery');
  const list = $('recovery-codes-list');
  // Recovery codes are server-generated hex; no XSS surface, but escapeHtml
  // here keeps the pattern consistent.
  list.innerHTML = codes.map((c) => `<div class="code">${escapeHtmlLocal(c)}</div>`).join('');
  ($('chk-recovery-saved') as HTMLInputElement).checked = false;
  ($('btn-recovery-continue') as HTMLButtonElement).disabled = true;
  $('btn-copy-recovery').onclick = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast(t('auth.codesCopied'), 'success');
    } catch {
      toast(t('auth.copyFailed'), 'error');
    }
  };
  $('chk-recovery-saved').onchange = (e: Event): void => {
    ($('btn-recovery-continue') as HTMLButtonElement).disabled = !(e.target as HTMLInputElement).checked;
  };
  $('btn-recovery-continue').onclick = async (): Promise<void> => {
    await authInit();
    await deps.onAuthenticated();
  };
}

// Local helper since dom.escapeHtml is used elsewhere too — keeping the import
// graph tighter on this hot path.
function escapeHtmlLocal(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

// ─── DOM listener wiring ──────────────────────────────────────────────────

export function initAuthForms(d?: AuthBootstrapDeps): void {
  if (d) deps = d;

  // Step 1: username + password
  ($('auth-login-form') as HTMLFormElement).onsubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const err = $('auth-login-error');
    err.textContent = '';
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username: (f.elements.namedItem('username') as HTMLInputElement).value.trim(),
          password: (f.elements.namedItem('password') as HTMLInputElement).value,
        }),
      });
      const data = await res.json() as { step?: string; message?: string; code?: string };
      if (!res.ok) throw new Error(localizeServerError(data));
      if (data.step === 'totp') {
        showAuthScreen('totp');
        setTimeout(
          () => document.querySelector<HTMLInputElement>('#auth-totp-form input[name=code]')?.focus(),
          50,
        );
      } else if (data.step === 'enroll_totp') {
        const me = await fetch('/auth/me', { credentials: 'same-origin' }).then((r) => r.json()) as CurrentUser;
        currentUser = me;
        await startEnrollment();
      }
    } catch (ex) {
      err.textContent = (ex as Error).message;
    }
  };

  // Step 2: TOTP code
  ($('auth-totp-form') as HTMLFormElement).onsubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const err = $('auth-totp-error');
    err.textContent = '';
    try {
      const res = await fetch('/auth/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code: (f.elements.namedItem('code') as HTMLInputElement).value }),
      });
      const data = await res.json() as { ok?: boolean; message?: string; code?: string };
      if (!res.ok) throw new Error(localizeServerError(data));
      (f.elements.namedItem('code') as HTMLInputElement).value = '';
      await authInit();
      await deps.onAuthenticated();
    } catch (ex) {
      err.textContent = (ex as Error).message;
    }
  };

  $('auth-totp-back').onclick = (): void => {
    ($('auth-totp-form') as HTMLFormElement).reset();
    showAuthScreen('login');
  };

  $('btn-regen-qr').onclick = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: t('auth.regenQrTitle'),
      message: t('auth.regenQrMessage'),
      confirmLabel: t('auth.regenQrConfirm'),
    });
    if (!ok) return;
    await startEnrollment(true);
  };

  ($('auth-enroll-confirm-form') as HTMLFormElement).onsubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const err = $('auth-enroll-error');
    err.textContent = '';
    try {
      const res = await fetch('/auth/totp/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code: (f.elements.namedItem('code') as HTMLInputElement).value }),
      });
      const data = await res.json() as { ok?: boolean; recoveryCodes?: string[]; message?: string; code?: string };
      if (!res.ok) throw new Error(localizeServerError(data));
      showRecoveryCodes(data.recoveryCodes || []);
    } catch (ex) {
      err.textContent = (ex as Error).message;
    }
  };

  $('btn-logout').onclick = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: t('auth.logoutTitle'),
      message: t('auth.logoutMessage'),
      confirmLabel: t('auth.logoutTitle'),
    });
    if (!ok) return;
    try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* ignore */ }
    currentUser = null;
    setVaultKey(null);
    State.connections = [];
    State.activeConnId = null;
    location.reload();
  };

  // (Account modal + admin users are wired in their own init modules.)
  const myAccount = $maybe('btn-my-account');
  if (myAccount) myAccount.onclick = (): void => openModal('modal-account');
}
