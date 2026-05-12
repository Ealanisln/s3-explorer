// ============================================================
// S3 Explorer - Client
// ============================================================

let currentUser = null;

// ---------- Auth bootstrap ----------
async function authInit() {
  try {
    const res = await fetch('/auth/me', { credentials: 'same-origin' });
    const me = await res.json();
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
      // Force a password change before letting them in
      showAuthScreen(null);
      hideAuthOverlay();
      renderUserChip();
      openModal('modal-account');
      toast('Debes cambiar tu contraseña inicial antes de continuar.', 'info', 6000);
      return true;
    }
    hideAuthOverlay();
    renderUserChip();
    return true;
  } catch (e) {
    showAuthScreen('login');
    return false;
  }
}

function showAuthScreen(name) {
  document.getElementById('auth-overlay').style.display = 'flex';
  for (const id of ['auth-login-form', 'auth-totp-form', 'auth-enroll', 'auth-recovery']) {
    document.getElementById(id).style.display = id === `auth-${name}` || (name === 'login' && id === 'auth-login-form') || (name === 'totp' && id === 'auth-totp-form') ? 'block' : 'none';
  }
}

function hideAuthOverlay() {
  document.getElementById('auth-overlay').style.display = 'none';
}

function renderUserChip() {
  if (!currentUser) return;
  const wrap = document.getElementById('sidebar-user');
  wrap.style.display = 'flex';
  document.getElementById('user-name').textContent = currentUser.username;
  const role = document.getElementById('user-role');
  role.textContent = currentUser.role === 'admin' ? 'ADMIN' : 'USER';
  role.className = 'user-role' + (currentUser.role === 'admin' ? ' admin' : '');
  document.getElementById('btn-admin-users').style.display = currentUser.role === 'admin' ? 'inline-block' : 'none';
}

// Step 1: username + password
document.getElementById('auth-login-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = document.getElementById('auth-login-error');
  err.textContent = '';
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: f.username.value.trim(), password: f.password.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Error');
    if (data.step === 'totp') {
      showAuthScreen('totp');
      setTimeout(() => document.querySelector('#auth-totp-form input[name=code]')?.focus(), 50);
    } else if (data.step === 'enroll_totp') {
      // Session already issued, go straight to enrollment
      const me = await fetch('/auth/me', { credentials: 'same-origin' }).then(r => r.json());
      currentUser = me;
      await startEnrollment();
    }
  } catch (ex) { err.textContent = ex.message; }
};

// Step 2: TOTP
document.getElementById('auth-totp-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = document.getElementById('auth-totp-error');
  err.textContent = '';
  try {
    const res = await fetch('/auth/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code: f.code.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Error');
    f.code.value = '';
    await authInit();
    loadConnections();
  } catch (ex) { err.textContent = ex.message; }
};

document.getElementById('auth-totp-back').onclick = () => {
  document.getElementById('auth-totp-form').reset();
  showAuthScreen('login');
};

async function startEnrollment(regenerate = false) {
  showAuthScreen('enroll');
  try {
    const url = regenerate ? '/auth/totp/setup?regenerate=1' : '/auth/totp/setup';
    const res = await fetch(url, { method: 'POST', credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Error');
    document.getElementById('enroll-qr').innerHTML = data.qrSvg;
    document.getElementById('enroll-secret').textContent = data.secret;
    setTimeout(() => document.querySelector('#auth-enroll-confirm-form input[name=code]')?.focus(), 50);
  } catch (ex) {
    document.getElementById('auth-enroll-error').textContent = ex.message;
  }
}

document.getElementById('btn-regen-qr').onclick = async () => {
  if (!confirm('Generar QR nuevo? Tu app de autenticación deberá escanearlo de nuevo y el QR anterior dejará de funcionar.')) return;
  await startEnrollment(true);
};

document.getElementById('auth-enroll-confirm-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = document.getElementById('auth-enroll-error');
  err.textContent = '';
  try {
    const res = await fetch('/auth/totp/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code: f.code.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Error');
    showRecoveryCodes(data.recoveryCodes);
  } catch (ex) { err.textContent = ex.message; }
};

function showRecoveryCodes(codes) {
  showAuthScreen('recovery');
  const list = document.getElementById('recovery-codes-list');
  list.innerHTML = codes.map(c => `<div class="code">${escapeHtml(c)}</div>`).join('');
  document.getElementById('chk-recovery-saved').checked = false;
  document.getElementById('btn-recovery-continue').disabled = true;
  document.getElementById('btn-copy-recovery').onclick = async () => {
    try { await navigator.clipboard.writeText(codes.join('\n')); toast('Códigos copiados', 'success'); }
    catch { toast('No se pudo copiar; selecciona y copia manualmente.', 'error'); }
  };
  document.getElementById('chk-recovery-saved').onchange = (e) => {
    document.getElementById('btn-recovery-continue').disabled = !e.target.checked;
  };
  document.getElementById('btn-recovery-continue').onclick = async () => {
    await authInit();
    loadConnections();
  };
}

document.getElementById('btn-logout').onclick = async () => {
  if (!confirm('Cerrar sesión?')) return;
  try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
  currentUser = null;
  vaultKey = null;
  State.connections = [];
  State.activeConnId = null;
  location.reload();
};

document.getElementById('btn-my-account').onclick = () => {
  document.getElementById('account-pw-msg').textContent = '';
  document.getElementById('form-change-password').reset();
  document.getElementById('new-recovery-codes').innerHTML = '';
  openModal('modal-account');
};

document.getElementById('form-change-password').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = document.getElementById('account-pw-msg');
  msg.textContent = '';
  msg.className = 'test-result';
  try {
    const res = await fetch('/auth/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ currentPassword: f.current.value, newPassword: f.next.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    msg.textContent = '✓ Contraseña actualizada';
    msg.className = 'test-result ok';
    f.reset();
    if (currentUser) currentUser.mustChangePassword = false;
  } catch (ex) { msg.textContent = ex.message; msg.className = 'test-result err'; }
};

document.getElementById('btn-regen-recovery').onclick = async () => {
  if (!confirm('Regenerar invalidará tus códigos actuales. ¿Continuar?')) return;
  try {
    const res = await fetch('/auth/me/recovery', { method: 'POST', credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    const list = document.getElementById('new-recovery-codes');
    list.innerHTML = data.recoveryCodes.map(c => `<div class="code">${escapeHtml(c)}</div>`).join('');
    toast('Códigos regenerados. Guárdalos ahora.', 'success', 8000);
  } catch (ex) { toast(ex.message, 'error'); }
};

// ---------- Admin: Users ----------
document.getElementById('btn-admin-users').onclick = async () => {
  await loadUsersAdmin();
  openModal('modal-users');
};

async function loadUsersAdmin() {
  const tbody = document.getElementById('users-tbody');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:20px">Cargando...</td></tr>';
  try {
    const res = await fetch('/auth/admin/users', { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    tbody.innerHTML = '';
    for (const u of data.users) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(u.username)}</td>
        <td><span class="user-role ${u.role === 'admin' ? 'admin' : ''}">${u.role.toUpperCase()}</span></td>
        <td>${u.totpEnrolled ? `✓ <span style="color:var(--text-dim);font-size:11px">${u.recoveryRemaining} cód.</span>` : '<span style="color:var(--yellow)">⚠ pendiente</span>'}</td>
        <td style="font-size:12px;color:var(--text-dim)">${u.lastLoginAt ? formatDate(u.lastLoginAt) : 'nunca'}</td>
        <td>${u.disabled ? '<span style="color:var(--red)">deshabilitado</span>' : 'activo'}</td>
        <td style="text-align:right">
          ${u.username === currentUser.username ? '<span style="color:var(--text-dim);font-size:11px">(tú)</span>' :
            `<button class="btn-icon" data-act="reset-totp" data-user="${escapeHtml(u.username)}" title="Resetear TOTP">🔑</button>
             <button class="btn-icon" data-act="reset-pw" data-user="${escapeHtml(u.username)}" title="Resetear contraseña">🔒</button>
             <button class="btn-icon" data-act="${u.disabled ? 'enable' : 'disable'}" data-user="${escapeHtml(u.username)}" title="${u.disabled ? 'Habilitar' : 'Deshabilitar'}">${u.disabled ? '▶' : '⏸'}</button>`}
        </td>
      `;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('button[data-act]').forEach(b => b.onclick = (e) => handleUserAction(b.dataset.act, b.dataset.user));
  } catch (ex) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--red);padding:20px">${escapeHtml(ex.message)}</td></tr>`;
  }
}

async function handleUserAction(act, username) {
  let body, url, confirmMsg;
  if (act === 'disable') { confirmMsg = `Deshabilitar a ${username}?`; url = `/auth/admin/users/${encodeURIComponent(username)}/disable`; }
  else if (act === 'enable') { confirmMsg = `Habilitar a ${username}?`; url = `/auth/admin/users/${encodeURIComponent(username)}/enable`; }
  else if (act === 'reset-totp') { confirmMsg = `Resetear TOTP de ${username}? Tendrá que re-enrolar en su próximo login.`; url = `/auth/admin/users/${encodeURIComponent(username)}/reset-totp`; }
  else if (act === 'reset-pw') {
    const np = prompt(`Nueva contraseña inicial para ${username} (mín. 8 chars):`);
    if (!np) return;
    body = { newPassword: np };
    url = `/auth/admin/users/${encodeURIComponent(username)}/reset-password`;
  }
  if (confirmMsg && !confirm(confirmMsg)) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    toast('OK', 'success');
    loadUsersAdmin();
  } catch (ex) { toast(ex.message, 'error'); }
}

document.getElementById('form-create-user').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = document.getElementById('create-user-msg');
  msg.textContent = '';
  try {
    const res = await fetch('/auth/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: f.username.value.trim(), password: f.password.value, role: f.role.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    msg.textContent = `✓ Usuario "${f.username.value}" creado. Deberá cambiar contraseña en primer login.`;
    msg.className = 'test-result ok';
    f.reset();
    loadUsersAdmin();
  } catch (ex) { msg.textContent = ex.message; msg.className = 'test-result err'; }
};

const State = {
  connections: [],
  activeConnId: null,
  buckets: [],
  activeBucket: null,
  prefix: '',
  objects: [],
  prefixes: [],
  selected: new Set(),
  versioning: 'Disabled',
  filterTerm: '',
  searchResults: null,
  searchFolderHits: null,
  searchMeta: null,
  showDeleted: false,
  sort: { field: 'name', dir: 'asc' },
};

const VAULT_KEY = 's3-explorer-vault-v1';
const LEGACY_STORAGE_KEY = 's3-explorer-connections';
let vaultKey = null; // CryptoKey held in memory after unlock
let pendingMigration = null; // legacy connections waiting to be encrypted into the new vault

// ---------- Crypto helpers ----------
async function deriveKey(passphrase, salt) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function b64dec(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

async function encryptVault(plaintextObj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(plaintextObj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: b64(iv), ct: b64(ct) };
}

async function decryptVault(envelope, key) {
  const iv = b64dec(envelope.iv);
  const ct = b64dec(envelope.ct);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

function getVault() {
  try { return JSON.parse(localStorage.getItem(VAULT_KEY) || 'null'); }
  catch { return null; }
}

// ---------- Persistence ----------
async function loadConnections() {
  const vault = getVault();
  if (!vault) {
    // Check for legacy plaintext storage to migrate
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '[]');
      if (Array.isArray(legacy) && legacy.length) {
        pendingMigration = legacy;
      }
    } catch {}
    State.connections = [];
    renderConnections();
    openPassphraseModal({ mode: 'create' });
    return;
  }
  openPassphraseModal({ mode: 'unlock' });
}

async function saveConnections() {
  if (!vaultKey) throw new Error('Vault is locked');
  const vault = getVault() || {};
  const salt = vault.salt || b64(crypto.getRandomValues(new Uint8Array(16)));
  const envelope = await encryptVault(State.connections, vaultKey);
  localStorage.setItem(VAULT_KEY, JSON.stringify({ v: 1, salt, ...envelope }));
}

function lockVault() {
  vaultKey = null;
  State.connections = [];
  State.activeConnId = null;
  renderConnections();
  clearMain();
  toggleEmpty(true);
  document.getElementById('empty').innerHTML = `<h2>Bóveda bloqueada</h2><p>Desbloquea para acceder a tus conexiones.</p><button class="btn btn-primary" id="btn-unlock-now">Desbloquear</button>`;
  document.getElementById('btn-unlock-now').onclick = () => openPassphraseModal({ mode: 'unlock' });
}

function openPassphraseModal({ mode }) {
  const isCreate = mode === 'create';
  const hasMigration = isCreate && pendingMigration && pendingMigration.length;
  document.getElementById('passphrase-title').textContent = isCreate
    ? (hasMigration ? 'Cifra tus conexiones existentes' : 'Crea una contraseña para la bóveda')
    : 'Desbloquea tu bóveda';
  document.getElementById('passphrase-hint').textContent = isCreate
    ? (hasMigration
        ? `Detectamos ${pendingMigration.length} conexión(es) guardada(s) en texto plano. Crea una contraseña para cifrarlas. Si la olvidas, deberás reingresarlas.`
        : 'Tus conexiones S3 se cifrarán localmente con AES-256-GCM. Esta contraseña no se envía al servidor. Si la olvidas, deberás reingresar tus conexiones.')
    : 'Ingresa la contraseña que usaste para cifrar tus conexiones S3.';
  document.getElementById('passphrase-confirm-wrap').style.display = isCreate ? 'block' : 'none';
  document.getElementById('passphrase-error').textContent = '';
  document.getElementById('form-passphrase').reset();
  document.getElementById('btn-passphrase-reset').style.display = isCreate ? 'none' : 'inline-block';
  openModal('modal-passphrase');
  setTimeout(() => document.querySelector('#form-passphrase input[name=passphrase]')?.focus(), 50);
}

document.getElementById('form-passphrase').onsubmit = async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('passphrase-error');
  errEl.textContent = '';
  const pass = e.target.passphrase.value;
  const confirm = e.target.confirm.value;
  const vault = getVault();
  try {
    if (!vault) {
      // Create
      if (pass.length < 8) { errEl.textContent = 'Mínimo 8 caracteres.'; return; }
      if (pass !== confirm) { errEl.textContent = 'Las contraseñas no coinciden.'; return; }
      const salt = crypto.getRandomValues(new Uint8Array(16));
      vaultKey = await deriveKey(pass, salt);
      const initial = pendingMigration && pendingMigration.length ? pendingMigration : [];
      const envelope = await encryptVault(initial, vaultKey);
      localStorage.setItem(VAULT_KEY, JSON.stringify({ v: 1, salt: b64(salt), ...envelope }));
      State.connections = initial;
      if (pendingMigration && pendingMigration.length) {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        pendingMigration = null;
        toast('Conexiones migradas a la bóveda cifrada.', 'success', 5000);
      }
    } else {
      // Unlock
      const salt = b64dec(vault.salt);
      const key = await deriveKey(pass, salt);
      try {
        State.connections = await decryptVault(vault, key);
      } catch {
        errEl.textContent = 'Contraseña incorrecta.';
        return;
      }
      vaultKey = key;
    }
    closeModal('modal-passphrase');
    renderConnections();
    if (State.connections.length) {
      toggleEmpty(true);
      document.getElementById('empty').innerHTML = `<h2>Bóveda desbloqueada</h2><p>Selecciona una conexión en la barra lateral.</p>`;
    }
  } catch (err) {
    errEl.textContent = err.message || 'Error';
  }
};

document.getElementById('btn-passphrase-reset').onclick = () => {
  if (!confirm('Esto borrará permanentemente todas tus conexiones guardadas. ¿Continuar?')) return;
  localStorage.removeItem(VAULT_KEY);
  vaultKey = null;
  State.connections = [];
  closeModal('modal-passphrase');
  openPassphraseModal({ mode: 'create' });
};

document.getElementById('btn-lock').onclick = () => {
  if (!vaultKey) { openPassphraseModal({ mode: 'unlock' }); return; }
  if (confirm('Bloquear la bóveda? Tendrás que ingresar la contraseña de nuevo.')) lockVault();
};

function activeConn() {
  return State.connections.find(c => c.id === State.activeConnId);
}

function authHeaders() {
  const c = activeConn();
  if (!c) return {};
  return {
    'x-s3-endpoint': c.endpoint || '',
    'x-s3-region': c.region || 'us-east-1',
    'x-s3-access-key': c.accessKey,
    'x-s3-secret-key': c.secretKey,
    'x-s3-session-token': c.sessionToken || '',
    'x-s3-path-style': c.pathStyle ? 'true' : 'false',
  };
}

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { ...authHeaders(), ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  if (res.status === 401) {
    const err = await res.json().catch(() => ({}));
    if (err.code === 'NO_SESSION' || err.code === 'USER_INVALID') {
      toast('Sesión expirada — reiniciando.', 'error', 4000);
      setTimeout(() => location.reload(), 1500);
    }
    throw new Error(err.message || 'No autenticado');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || 'Error');
  }
  return res.json();
}

// ---------- Toasts ----------
function toast(msg, kind = 'info', ms = 3000) {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- Modals ----------
function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('.modal-backdrop').style.display = 'none');
// Modal close-on-backdrop: only close if BOTH mousedown AND click landed on the
// backdrop itself (not on a child). Prevents drag-from-input → release-outside
// from accidentally dismissing the modal and losing form data.
// Also: form modals are excluded entirely to avoid data loss on stray clicks.
const FORM_MODALS = new Set([
  'modal-passphrase', 'modal-conn', 'modal-bucket', 'modal-folder',
  'modal-rename', 'modal-account', 'modal-users',
]);
document.querySelectorAll('.modal-backdrop').forEach(b => {
  if (FORM_MODALS.has(b.id)) return; // dismiss only via ✕ or submit
  let downOnBackdrop = false;
  b.addEventListener('mousedown', e => { downOnBackdrop = e.target === b; });
  b.addEventListener('click', e => {
    if (downOnBackdrop && e.target === b) b.style.display = 'none';
    downOnBackdrop = false;
  });
});

// Esc closes any visible modal (except passphrase — that one needs explicit action)
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal-backdrop')]
    .filter(b => b.style.display !== 'none' && b.id !== 'modal-passphrase');
  if (open.length) open[open.length - 1].style.display = 'none';
});

// ---------- Render: Empty ----------
function toggleEmpty(show) {
  document.getElementById('empty').style.display = show ? 'block' : 'none';
  document.getElementById('grid').style.display = show ? 'none' : 'table';
}

// ---------- Render: Connections ----------
function renderConnections() {
  const ul = document.getElementById('connections');
  ul.innerHTML = '';
  for (const c of State.connections) {
    const li = document.createElement('li');
    li.className = c.id === State.activeConnId ? 'active' : '';
    li.innerHTML = `
      <span class="icon-file" style="width:22px;height:22px;font-size:10px">S3</span>
      <span class="name" title="${escapeHtml(c.endpoint || 'AWS')}">${escapeHtml(c.name)}</span>
      <span class="menu" data-conn-id="${c.id}">⋯</span>
    `;
    li.onclick = (e) => {
      if (e.target.classList.contains('menu')) {
        showConnMenu(e, c);
      } else {
        selectConnection(c.id);
      }
    };
    ul.appendChild(li);
  }
}

function showConnMenu(e, c) {
  e.stopPropagation();
  const existing = document.querySelector('.dropdown.conn-menu');
  if (existing) existing.remove();
  const dd = document.createElement('div');
  dd.className = 'dropdown conn-menu';
  dd.style.position = 'fixed';
  dd.style.left = (e.clientX) + 'px';
  dd.style.top = (e.clientY) + 'px';
  dd.innerHTML = `
    <button data-act="edit">Editar</button>
    <button data-act="duplicate">Duplicar</button>
    <button data-act="delete" class="danger">Eliminar</button>
  `;
  document.body.appendChild(dd);
  const close = () => { dd.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 10);
  dd.onclick = (ev) => {
    const act = ev.target.dataset.act;
    if (act === 'edit') openConnModal(c);
    if (act === 'duplicate') {
      const copy = { ...c, id: crypto.randomUUID(), name: c.name + ' (copia)' };
      State.connections.push(copy); saveConnections(); renderConnections();
    }
    if (act === 'delete') {
      if (confirm(`¿Eliminar conexión "${c.name}"?`)) {
        State.connections = State.connections.filter(x => x.id !== c.id);
        saveConnections();
        if (State.activeConnId === c.id) { State.activeConnId = null; clearMain(); }
        renderConnections();
      }
    }
  };
}

async function selectConnection(id) {
  State.activeConnId = id;
  State.activeBucket = null;
  State.prefix = '';
  renderConnections();
  document.getElementById('conn-status').classList.remove('online');
  document.getElementById('conn-status').textContent = 'Conectando...';
  const conn = activeConn();
  try {
    if (conn.buckets && conn.buckets.length) {
      // Explicit bucket list — skip ListBuckets entirely (works for restricted IAM)
      State.buckets = conn.buckets.map(name => ({ Name: name, CreationDate: null }));
      renderBuckets();
      document.getElementById('buckets-section').style.display = 'block';
      document.getElementById('conn-status').classList.add('online');
      document.getElementById('conn-status').textContent = `Conectado · ${conn.buckets.length} buckets (manuales)`;
      toggleEmpty(true);
      document.getElementById('empty').innerHTML = `<h2>Selecciona un bucket</h2><p>Elige un bucket en la barra lateral para navegar tus archivos.</p>`;
      return;
    }
    const { buckets } = await api('/api/buckets');
    State.buckets = buckets;
    renderBuckets();
    document.getElementById('buckets-section').style.display = 'block';
    document.getElementById('conn-status').classList.add('online');
    document.getElementById('conn-status').textContent = `Conectado · ${buckets.length} buckets`;
    toggleEmpty(true);
    document.getElementById('empty').innerHTML = `<h2>Selecciona un bucket</h2><p>Elige un bucket en la barra lateral para navegar tus archivos.</p>`;
  } catch (e) {
    document.getElementById('conn-status').textContent = 'Error de conexión';
    // AccessDenied on ListAllMyBuckets → suggest specifying buckets manually
    if (/ListAllMyBuckets|not authorized|AccessDenied/i.test(e.message)) {
      toggleEmpty(true);
      document.getElementById('empty').innerHTML = `
        <h2>Tu IAM no permite listar buckets</h2>
        <p>Tu credencial no tiene <code>s3:ListAllMyBuckets</code>. Edita la conexión y agrega manualmente los nombres de los buckets que sí tienes permiso para usar.</p>
        <button class="btn btn-primary" id="btn-edit-this-conn">Editar conexión</button>
      `;
      document.getElementById('btn-edit-this-conn').onclick = () => openConnModal(conn);
    } else {
      toast('Error al conectar: ' + e.message, 'error');
    }
  }
}

function clearMain() {
  document.getElementById('buckets-section').style.display = 'none';
  document.getElementById('buckets').innerHTML = '';
  document.getElementById('grid').style.display = 'none';
  document.getElementById('breadcrumbs').innerHTML = '';
  document.getElementById('conn-status').textContent = 'Sin conexión';
  document.getElementById('conn-status').classList.remove('online');
}

// ---------- Render: Buckets ----------
function renderBuckets() {
  const ul = document.getElementById('buckets');
  ul.innerHTML = '';
  for (const b of State.buckets) {
    const li = document.createElement('li');
    li.className = b.Name === State.activeBucket ? 'active' : '';
    li.innerHTML = `
      <span class="icon-file icon-folder" style="width:22px;height:22px;font-size:10px">📦</span>
      <span class="name">${escapeHtml(b.Name)}</span>
      <span class="menu" data-bucket="${b.Name}">⋯</span>
    `;
    li.onclick = (e) => {
      if (e.target.classList.contains('menu')) {
        showBucketMenu(e, b);
      } else {
        openBucket(b.Name);
      }
    };
    ul.appendChild(li);
  }
}

function showBucketMenu(e, b) {
  e.stopPropagation();
  const existing = document.querySelector('.dropdown.bucket-menu');
  if (existing) existing.remove();
  const dd = document.createElement('div');
  dd.className = 'dropdown bucket-menu';
  dd.style.position = 'fixed';
  dd.style.left = (e.clientX) + 'px';
  dd.style.top = (e.clientY) + 'px';
  dd.innerHTML = `<button data-act="delete" class="danger">Eliminar bucket</button>`;
  document.body.appendChild(dd);
  const close = () => { dd.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 10);
  dd.onclick = async (ev) => {
    if (ev.target.dataset.act === 'delete') {
      if (!confirm(`Eliminar bucket "${b.Name}"? Debe estar vacío.`)) return;
      try {
        await api(`/api/buckets/${encodeURIComponent(b.Name)}`, { method: 'DELETE' });
        toast('Bucket eliminado', 'success');
        const { buckets } = await api('/api/buckets');
        State.buckets = buckets;
        renderBuckets();
      } catch (e) { toast(e.message, 'error'); }
    }
  };
}

async function openBucket(name) {
  State.activeBucket = name;
  State.prefix = '';
  renderBuckets();
  await loadVersioning();
  await loadObjects();
}

async function loadVersioning() {
  try {
    const { status } = await api(`/api/buckets/${encodeURIComponent(State.activeBucket)}/versioning`);
    State.versioning = status;
    const btn = document.getElementById('btn-versioning');
    btn.style.display = 'inline-block';
    const tog = document.querySelector('.toggle-deleted');
    tog.style.display = status === 'Enabled' ? 'inline-flex' : 'none';
    if (status !== 'Enabled' && State.showDeleted) {
      State.showDeleted = false;
      document.getElementById('chk-deleted').checked = false;
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
      btn.onclick = async () => {
        if (!confirm(
          `Activar versionado en "${State.activeBucket}"?\n\n` +
          `IMPORTANTE: una vez activado, NO podrás desactivarlo desde esta app. ` +
          `Si necesitas suspenderlo, deberás usar awscli o la consola del proveedor.\n\n` +
          `¿Continuar?`
        )) return;
        try {
          await api(`/api/buckets/${encodeURIComponent(State.activeBucket)}/versioning`, {
            method: 'PUT', body: { enabled: true },
          });
          toast('Versionado activado', 'success');
          loadVersioning();
        } catch (e) { toast(e.message, 'error'); }
      };
    }
  } catch { State.versioning = 'Disabled'; }
}

// ---------- Render: Objects ----------
async function loadObjects() {
  if (!State.activeBucket) return;
  toggleEmpty(false);
  document.getElementById('btn-upload').disabled = false;
  document.getElementById('btn-new-folder').disabled = false;
  document.getElementById('search-input').disabled = false;
  State.searchResults = null;
  State.searchMeta = null;
  updateSearchBanner();
  renderBreadcrumbs();
  if (typeof closeInfoPanel === 'function') closeInfoPanel();
  const loader = showLoadingRow();
  try {
    const params = new URLSearchParams({ prefix: State.prefix });
    if (State.showDeleted) params.set('showDeleted', '1');
    const data = await api(`/api/objects/${encodeURIComponent(State.activeBucket)}?${params}`);
    State.prefixes = data.prefixes;
    State.objects = data.objects;
    State.listingTruncated = !!data.isTruncated;
    State.listingPages = data.pages || 1;
    State.selected.clear();
    renderGrid();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    loader.remove();
  }
}

function showLoadingRow() {
  const tbody = document.getElementById('grid-body');
  tbody.innerHTML = '';
  const tr = document.createElement('tr');
  tr.innerHTML = `<td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim)">⏳ Cargando carpeta...</td>`;
  tbody.appendChild(tr);
  return tr;
}

function applySort(list, isPrefixList = false) {
  const { field, dir } = State.sort;
  const mult = dir === 'asc' ? 1 : -1;
  if (isPrefixList) {
    return [...list].sort((a, b) => a.localeCompare(b) * (field === 'name' ? mult : 1));
  }
  return [...list].sort((a, b) => {
    let av, bv;
    if (field === 'size') { av = a.Size || 0; bv = b.Size || 0; }
    else if (field === 'modified') { av = new Date(a.LastModified).getTime(); bv = new Date(b.LastModified).getTime(); }
    else { av = a.Key.toLowerCase(); bv = b.Key.toLowerCase(); }
    if (av < bv) return -1 * mult;
    if (av > bv) return 1 * mult;
    return 0;
  });
}

function updateSortIndicators() {
  document.querySelectorAll('.grid th.sortable').forEach(th => {
    const active = th.dataset.sort === State.sort.field;
    th.classList.toggle('active', active);
    const ind = th.querySelector('.sort-indicator');
    ind.textContent = active ? (State.sort.dir === 'asc' ? '▲' : '▼') : '';
  });
}

function renderBreadcrumbs() {
  const el = document.getElementById('breadcrumbs');
  el.innerHTML = '';
  const parts = [];
  parts.push({ name: State.activeBucket, prefix: '' });
  const segs = State.prefix.split('/').filter(Boolean);
  let acc = '';
  for (const s of segs) {
    acc += s + '/';
    parts.push({ name: s, prefix: acc });
  }
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    const link = document.createElement('a');
    link.textContent = p.name;
    link.className = last ? 'current' : '';
    if (!last) link.onclick = () => { State.prefix = p.prefix; loadObjects(); };
    el.appendChild(link);
    if (!last) {
      const s = document.createElement('span'); s.className = 'sep'; s.textContent = '/';
      el.appendChild(s);
    }
  });
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['jpg','jpeg','png','gif','webp','svg','bmp'].includes(ext)) return { cls: 'icon-img', label: '🖼' };
  if (['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','csv','json','xml','log'].includes(ext)) return { cls: 'icon-doc', label: ext.slice(0,3).toUpperCase() };
  if (['mp3','wav','ogg','flac'].includes(ext)) return { cls: 'icon-doc', label: '♪' };
  if (['mp4','mov','avi','webm','mkv'].includes(ext)) return { cls: 'icon-img', label: '▶' };
  if (['zip','tar','gz','rar','7z'].includes(ext)) return { cls: '', label: '📦' };
  return { cls: '', label: ext.slice(0,3).toUpperCase() || '·' };
}

function renderGrid() {
  const tbody = document.getElementById('grid-body');
  tbody.innerHTML = '';

  updateSortIndicators();
  const isSearchMode = State.searchResults !== null;
  const term = State.filterTerm.toLowerCase();

  if (isSearchMode) {
    const folderHits = State.searchFolderHits ? [...State.searchFolderHits.entries()] : [];
    const sortedFolders = folderHits.sort((a, b) => {
      const { field, dir } = State.sort;
      const mult = dir === 'asc' ? 1 : -1;
      if (field === 'size') return ((a[1].totalSize || 0) - (b[1].totalSize || 0)) * mult;
      if (field === 'modified') return (new Date(a[1].latestModified) - new Date(b[1].latestModified)) * mult;
      return a[0].localeCompare(b[0]) * mult;
    });
    const sortedFiles = applySort(State.searchResults);

    if (!sortedFolders.length && !sortedFiles.length) {
      const tr = document.createElement('tr');
      const msg = State.searchMeta?.status === 'scanning'
        ? `Escaneando... aún sin coincidencias.`
        : `Sin resultados para "${escapeHtml(State.filterTerm)}".`;
      tr.innerHTML = `<td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim)">${msg}</td>`;
      tbody.appendChild(tr);
      updateBatchBar();
      return;
    }

    for (const [folderKey, info] of sortedFolders) {
      const name = folderKey.replace(/\/$/, '').split('/').pop();
      const parent = folderKey.slice(0, folderKey.length - name.length - 1);
      const tr = document.createElement('tr');
      tr.dataset.folder = folderKey;
      tr.innerHTML = `
        <td class="col-check"></td>
        <td class="cell-name">
          <span class="icon-file icon-folder">📁</span>
          <div>
            <div>${escapeHtml(name)}/ <span style="color:var(--text-dim); font-size:11px; margin-left:6px">${info.fileCount} archivos</span></div>
            ${parent ? `<div class="path-cell">${escapeHtml(parent)}</div>` : ''}
          </div>
        </td>
        <td class="col-size">${formatSize(info.totalSize)}</td>
        <td class="col-date">${formatDate(info.latestModified)}</td>
        <td class="col-act"></td>
      `;
      tr.onclick = () => {
        State.prefix = folderKey;
        State.searchResults = null;
        State.searchFolderHits = null;
        State.searchMeta = null;
        State.filterTerm = '';
        searchInput.value = '';
        searchClearBtn.style.display = 'none';
        loadObjects();
      };
      tbody.appendChild(tr);
    }

    for (const o of sortedFiles) {
      const name = o.Key.split('/').pop();
      const folder = o.Key.slice(0, o.Key.length - name.length);
      const ico = fileIcon(name);
      const tr = document.createElement('tr');
      tr.dataset.key = o.Key;
      tr.innerHTML = `
        <td class="col-check"><input type="checkbox" data-key="${escapeHtml(o.Key)}"/></td>
        <td class="cell-name">
          <span class="icon-file ${ico.cls}">${ico.label}</span>
          <div>
            <div>${escapeHtml(name)}</div>
            ${folder ? `<div class="path-cell">${escapeHtml(folder)}</div>` : ''}
          </div>
        </td>
        <td class="col-size">${formatSize(o.Size)}</td>
        <td class="col-date">${formatDate(o.LastModified)}</td>
        <td class="col-act"><button class="menu-btn">⋯</button></td>
      `;
      bindRowEvents(tr, o);
      tbody.appendChild(tr);
    }
    updateBatchBar();
    return;
  }

  // Normal mode: filter prefixes + objects by filterTerm locally
  const visiblePrefixes = applySort(
    term ? State.prefixes.filter(p => p.toLowerCase().includes(term)) : State.prefixes,
    true
  );
  const visibleObjects = applySort(
    term ? State.objects.filter(o => o.Key.toLowerCase().includes(term)) : State.objects
  );

  if (!visiblePrefixes.length && !visibleObjects.length) {
    const tr = document.createElement('tr');
    const msg = term
      ? `Sin coincidencias en esta carpeta para "${escapeHtml(State.filterTerm)}". <a href="#" id="link-recursive-search" style="color:var(--primary-2)">Buscar en todo el bucket →</a>`
      : 'Carpeta vacía. Arrastra archivos aquí o usa "Subir archivos".';
    tr.innerHTML = `<td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim)">${msg}</td>`;
    tbody.appendChild(tr);
    const link = tr.querySelector('#link-recursive-search');
    if (link) link.onclick = (e) => { e.preventDefault(); runRecursiveSearch(); };
    updateBatchBar();
    return;
  }

  if (State.listingTruncated) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" style="background:rgba(227,179,65,0.12); border-left:3px solid var(--yellow); padding:10px 14px; font-size:12px; color:var(--yellow)">
      ⚠ Listado truncado en ${(State.prefixes.length + State.objects.length).toLocaleString()} entradas (${State.listingPages} páginas). Esta carpeta tiene más — usa la búsqueda para localizar elementos específicos.
    </td>`;
    tbody.appendChild(tr);
  }

  for (const p of visiblePrefixes) {
    const name = p.replace(State.prefix, '').replace('/', '');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-check"></td>
      <td class="cell-name"><span class="icon-file icon-folder">📁</span>${escapeHtml(name)}/</td>
      <td class="col-size">—</td>
      <td class="col-date">—</td>
      <td class="col-act"></td>
    `;
    tr.onclick = () => { State.prefix = p; document.getElementById('search-input').value = ''; State.filterTerm = ''; updateSearchBanner(); loadObjects(); };
    tbody.appendChild(tr);
  }

  for (const o of visibleObjects) {
    const name = o.Key.replace(State.prefix, '');
    if (!name) continue;
    const ico = fileIcon(name);
    const tr = document.createElement('tr');
    tr.dataset.key = o.Key;
    if (o.IsDeleteMarker) tr.classList.add('deleted');
    const badge = o.IsDeleteMarker ? '<span class="badge-deleted">DELETED</span>' : '';
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" data-key="${escapeHtml(o.Key)}"/></td>
      <td class="cell-name"><span class="icon-file ${ico.cls}">${ico.label}</span>${escapeHtml(name)}${badge}</td>
      <td class="col-size">${o.IsDeleteMarker ? '—' : formatSize(o.Size)}</td>
      <td class="col-date">${formatDate(o.LastModified)}</td>
      <td class="col-act"><button class="menu-btn" data-menu="${escapeHtml(o.Key)}">⋯</button></td>
    `;
    bindRowEvents(tr, o);
    tbody.appendChild(tr);
  }

  document.getElementById('check-all').onclick = (e) => {
    document.querySelectorAll('#grid-body input[type=checkbox]').forEach(cb => {
      cb.checked = e.target.checked;
      cb.dispatchEvent(new Event('click'));
    });
  };

  updateBatchBar();
}

function bindRowEvents(tr, o) {
  const cb = tr.querySelector('input[type=checkbox]');
  if (cb) {
    cb.onclick = (e) => {
      e.stopPropagation();
      if (e.target.checked) State.selected.add(o.Key); else State.selected.delete(o.Key);
      tr.classList.toggle('selected', e.target.checked);
      updateBatchBar();
    };
  }
  const mb = tr.querySelector('.menu-btn');
  if (mb) mb.onclick = (e) => { e.stopPropagation(); showRowMenu(e, o); };
  tr.addEventListener('click', (e) => {
    if (e.target.closest('input,button')) return;
    if (o.IsDeleteMarker) {
      if (confirm(`"${o.Key.split('/').pop()}" está eliminado.\n\n¿Restaurarlo (borrar el delete marker)?`)) {
        restoreDeleteMarker(o);
      }
      return;
    }
    openInfoPanel(o);
  });
  tr.addEventListener('dblclick', (e) => {
    if (e.target.closest('input,button')) return;
    if (!o.IsDeleteMarker) openPreview(o);
  });
}

async function restoreDeleteMarker(o) {
  try {
    await api(`/api/object/${encodeURIComponent(State.activeBucket)}/restore`, {
      method: 'POST', body: { key: o.Key, versionId: o.VersionId },
    });
    toast('Archivo restaurado', 'success');
    loadObjects();
  } catch (e) { toast(e.message, 'error'); }
}

function showRowMenu(e, o) {
  document.querySelectorAll('.dropdown.row-menu').forEach(d => d.remove());
  const dd = document.createElement('div');
  dd.className = 'dropdown row-menu';
  dd.style.position = 'fixed';
  dd.style.left = (e.clientX - 140) + 'px';
  dd.style.top = (e.clientY) + 'px';
  dd.innerHTML = o.IsDeleteMarker ? `
    <button data-act="restore">Restaurar</button>
    <button data-act="versions">Ver versiones</button>
    <button data-act="purge" class="danger">Borrar marker</button>
  ` : `
    <button data-act="preview">Vista previa</button>
    <button data-act="download">Descargar</button>
    <button data-act="share">Enlace temporal</button>
    <button data-act="versions">Ver versiones</button>
    <button data-act="rename">Renombrar</button>
    <button data-act="delete" class="danger">Eliminar</button>
  `;
  document.body.appendChild(dd);
  const close = () => { dd.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 10);
  dd.onclick = async (ev) => {
    const act = ev.target.dataset.act;
    if (act === 'restore') restoreDeleteMarker(o);
    if (act === 'purge') {
      if (confirm('Borrar permanentemente el delete marker?')) {
        try {
          await api(`/api/object/${encodeURIComponent(State.activeBucket)}`, {
            method: 'DELETE', body: { key: o.Key, versionId: o.VersionId },
          });
          toast('Marker borrado', 'success');
          loadObjects();
        } catch (e) { toast(e.message, 'error'); }
      }
    }
    if (act === 'preview') openPreview(o);
    if (act === 'download') downloadObject(o.Key);
    if (act === 'share') shareObject(o.Key);
    if (act === 'versions') { openPreview(o); setTimeout(() => document.getElementById('btn-show-versions').click(), 200); }
    if (act === 'rename') openRename(o.Key);
    if (act === 'delete') deleteObject(o.Key);
  };
}

function updateBatchBar() {
  const bar = document.getElementById('batch-bar');
  if (State.selected.size === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  document.getElementById('batch-info').textContent = `${State.selected.size} archivo(s) seleccionado(s)`;
}

document.getElementById('btn-batch-delete').onclick = async () => {
  if (!confirm(`Eliminar ${State.selected.size} archivo(s)?`)) return;
  try {
    await api(`/api/object/${encodeURIComponent(State.activeBucket)}/delete-batch`, {
      method: 'POST',
      body: { keys: [...State.selected] },
    });
    toast('Archivos eliminados', 'success');
    State.selected.clear();
    loadObjects();
  } catch (e) { toast(e.message, 'error'); }
};

// ---------- Actions ----------
function downloadObject(key, versionId) {
  const params = new URLSearchParams({ key });
  if (versionId) params.set('versionId', versionId);
  // Build URL with auth via temp form post-equivalent: use fetch + blob
  fetchAsBlob(`/api/object/${encodeURIComponent(State.activeBucket)}/download?${params}`, key.split('/').pop());
}

async function fetchAsBlob(url, filename) {
  try {
    toast('Descargando...', 'info');
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error('Falló la descarga');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch (e) { toast(e.message, 'error'); }
}

async function shareObject(key, versionId) {
  const choice = prompt(
    'Validez del enlace temporal:\n  1 = 5 minutos (recomendado)\n  2 = 1 hora\n  3 = 24 horas\n\nIngresa 1, 2 o 3:',
    '1'
  );
  if (choice === null) return;
  const expiresMap = { '1': 300, '2': 3600, '3': 86400 };
  const expires = expiresMap[choice.trim()] || 300;
  try {
    const params = new URLSearchParams({ key, expires: String(expires) });
    if (versionId) params.set('versionId', versionId);
    const { url, expires: actual, capped } = await api(`/api/object/${encodeURIComponent(State.activeBucket)}/presign?${params}`);
    await navigator.clipboard.writeText(url);
    const human = actual >= 3600 ? `${Math.round(actual/3600)} h` : `${Math.round(actual/60)} min`;
    toast(`Enlace copiado (válido ${human})${capped ? ' — el servidor limitó la duración' : ''}`, 'success', 5000);
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteObject(key) {
  if (!confirm(`Eliminar "${key}"?`)) return;
  try {
    await api(`/api/object/${encodeURIComponent(State.activeBucket)}`, {
      method: 'DELETE', body: { key },
    });
    toast('Eliminado', 'success');
    loadObjects();
  } catch (e) { toast(e.message, 'error'); }
}

function openRename(key) {
  const form = document.getElementById('form-rename');
  form.sourceKey.value = key;
  form.newName.value = key.split('/').pop();
  openModal('modal-rename');
}

document.getElementById('form-rename').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const src = f.sourceKey.value;
  const newName = f.newName.value.trim();
  const dest = State.prefix + newName;
  try {
    await api(`/api/object/${encodeURIComponent(State.activeBucket)}/rename`, {
      method: 'POST', body: { sourceKey: src, destKey: dest },
    });
    toast('Renombrado', 'success');
    closeModal('modal-rename');
    loadObjects();
  } catch (e) { toast(e.message, 'error'); }
};

// ---------- Preview ----------
let currentPreview = null;

let currentPreviewVersionId = null; // null = latest; set when previewing a specific version

async function renderPreviewBody(obj, versionInfo) {
  const body = document.getElementById('preview-body');
  body.innerHTML = '<div style="padding:40px;color:var(--text-dim)">Cargando vista previa...</div>';
  const info = document.getElementById('preview-info');
  const versionId = versionInfo ? versionInfo.VersionId : null;
  currentPreviewVersionId = versionId;
  const sizeForPreview = versionInfo ? versionInfo.Size : obj.Size;
  const dateForPreview = versionInfo ? versionInfo.LastModified : obj.LastModified;
  const versionLabel = versionId
    ? `<span style="color:var(--yellow); margin-left:8px">· versión ${versionId.slice(0, 8)}…${versionInfo.IsLatest ? ' (LATEST)' : ''}</span>`
    : '';
  info.innerHTML = `${formatSize(sizeForPreview)} · ${formatDate(dateForPreview)}${versionLabel}`;

  const ext = obj.Key.split('.').pop().toLowerCase();
  const params = new URLSearchParams({ key: obj.Key, inline: '1' });
  if (versionId) params.set('versionId', versionId);
  const url = `/api/object/${encodeURIComponent(State.activeBucket)}/download?${params}`;

  try {
    if (['jpg','jpeg','png','gif','webp','svg','bmp'].includes(ext)) {
      const blob = await (await fetch(url, { headers: authHeaders(), credentials: 'same-origin' })).blob();
      body.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt=""/>`;
    } else if (['mp4','webm','ogv'].includes(ext)) {
      const blob = await (await fetch(url, { headers: authHeaders(), credentials: 'same-origin' })).blob();
      body.innerHTML = `<video controls src="${URL.createObjectURL(blob)}"></video>`;
    } else if (['mp3','wav','ogg','flac'].includes(ext)) {
      const blob = await (await fetch(url, { headers: authHeaders(), credentials: 'same-origin' })).blob();
      body.innerHTML = `<audio controls src="${URL.createObjectURL(blob)}" style="width:80%"></audio>`;
    } else if (ext === 'pdf') {
      const blob = await (await fetch(url, { headers: authHeaders(), credentials: 'same-origin' })).blob();
      body.innerHTML = `<iframe src="${URL.createObjectURL(blob)}"></iframe>`;
    } else if (sizeForPreview < 1024 * 512 && ['txt','md','json','xml','log','csv','js','ts','html','css','yml','yaml','sh','py','java','go','rs','sql','env','conf','ini'].includes(ext)) {
      const text = await (await fetch(url, { headers: authHeaders(), credentials: 'same-origin' })).text();
      body.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
    } else {
      body.innerHTML = `<div style="padding:40px;color:var(--text-dim);text-align:center">
        <p style="font-size:48px;margin-bottom:8px">📄</p>
        <p>Vista previa no disponible para este tipo de archivo.</p>
        <p style="font-size:12px;margin-top:8px">Tamaño: ${formatSize(sizeForPreview)}</p>
      </div>`;
    }
  } catch (e) {
    body.innerHTML = `<div style="padding:40px;color:var(--red)">${escapeHtml(e.message)}</div>`;
  }
}

async function openPreview(obj) {
  currentPreview = obj;
  currentPreviewVersionId = null;
  document.getElementById('preview-title').textContent = obj.Key.split('/').pop();
  document.getElementById('versions-panel').style.display = 'none';
  document.getElementById('versions-panel').innerHTML = '';
  openModal('modal-preview');
  await renderPreviewBody(obj, null);
}

document.getElementById('btn-download').onclick = () => { if (currentPreview) downloadObject(currentPreview.Key); };
document.getElementById('btn-share').onclick = () => { if (currentPreview) shareObject(currentPreview.Key); };
document.getElementById('btn-show-versions').onclick = async () => {
  if (!currentPreview) return;
  const panel = document.getElementById('versions-panel');
  panel.style.display = 'block';
  panel.innerHTML = '<div style="color:var(--text-dim)">Cargando versiones...</div>';
  try {
    const { versions } = await api(`/api/object/${encodeURIComponent(State.activeBucket)}/versions?key=${encodeURIComponent(currentPreview.Key)}`);
    if (!versions.length) {
      panel.innerHTML = '<div style="color:var(--text-dim)">Sin versiones (¿versionado deshabilitado?).</div>';
      return;
    }
    panel.innerHTML = '';
    for (const v of versions) {
      const row = document.createElement('div');
      row.className = 'version-row';
      if (v.VersionId === currentPreviewVersionId) row.classList.add('viewing');
      const isDel = v.Type === 'delete-marker';
      row.innerHTML = `
        <div class="vid" title="${escapeHtml(v.VersionId)}">${escapeHtml(v.VersionId)}</div>
        <div>${formatDate(v.LastModified)}</div>
        <div>${isDel ? '<span class="delete-marker">DELETE</span>' : formatSize(v.Size)} ${v.IsLatest ? '<span class="latest">LATEST</span>' : ''}</div>
        <div class="actions">
          ${isDel ? '' : `<button class="btn" data-act="view" title="Vista previa de esta versión">👁</button>
          <button class="btn" data-act="download" title="Descargar">↓</button>
          <button class="btn" data-act="share" title="Enlace temporal">link</button>
          <button class="btn" data-act="restore" title="Restaurar como versión actual">restaurar</button>`}
          <button class="btn btn-danger" data-act="delete" title="Eliminar permanente">✕</button>
        </div>
      `;
      row.querySelectorAll('button').forEach(b => {
        b.onclick = async () => {
          const act = b.dataset.act;
          if (act === 'view') {
            await renderPreviewBody(currentPreview, v);
            // refresh highlight without re-fetching the version list
            panel.querySelectorAll('.version-row').forEach(r => r.classList.remove('viewing'));
            row.classList.add('viewing');
          }
          if (act === 'download') downloadObject(currentPreview.Key, v.VersionId);
          if (act === 'share') shareObject(currentPreview.Key, v.VersionId);
          if (act === 'restore') {
            if (!confirm('Restaurar esta versión como la actual?')) return;
            try {
              await api(`/api/object/${encodeURIComponent(State.activeBucket)}/copy`, {
                method: 'POST',
                body: { sourceKey: currentPreview.Key, destKey: currentPreview.Key, sourceVersionId: v.VersionId },
              });
              toast('Versión restaurada', 'success');
              loadObjects();
              document.getElementById('btn-show-versions').click();
            } catch (e) { toast(e.message, 'error'); }
          }
          if (act === 'delete') {
            if (!confirm(`Eliminar esta versión (${v.VersionId.slice(0,8)}...)?`)) return;
            try {
              await api(`/api/object/${encodeURIComponent(State.activeBucket)}`, {
                method: 'DELETE', body: { key: currentPreview.Key, versionId: v.VersionId },
              });
              toast('Versión eliminada', 'success');
              document.getElementById('btn-show-versions').click();
            } catch (e) { toast(e.message, 'error'); }
          }
        };
      });
      panel.appendChild(row);
    }
  } catch (e) {
    panel.innerHTML = `<div style="color:var(--red)">${escapeHtml(e.message)}</div>`;
  }
};

// ---------- Upload ----------
// Reset the file input's value BEFORE opening the picker so re-selecting the same
// filename (e.g. user edited the file and wants to re-upload) actually fires `change`.
// Otherwise the browser considers value unchanged and skips the event.
document.getElementById('btn-upload').onclick = () => {
  const input = document.getElementById('file-input');
  input.value = '';
  input.click();
};
document.getElementById('file-input').onchange = async (e) => {
  await uploadFiles(e.target.files);
  e.target.value = ''; // also reset after upload as belt-and-suspenders
};

async function uploadFiles(files) {
  if (!files || !files.length) return;

  // Pre-flight: detect collisions before uploading. UX differs by versioning state:
  //   - Versioning ON  → existing files become previous versions; informational toast
  //   - Versioning OFF → existing files are overwritten permanently; ask user
  const items = [...files].map(f => ({ file: f, key: State.prefix + f.name }));

  let conflicts = [];
  try {
    const data = await api(`/api/objects/${encodeURIComponent(State.activeBucket)}/exists`, {
      method: 'POST',
      body: { keys: items.map(i => i.key) },
    });
    const existingSet = new Set((data.results || []).filter(r => r.exists).map(r => r.key));
    conflicts = items.filter(i => existingSet.has(i.key));
  } catch (e) {
    // If the pre-check fails (network blip, bucket perms, etc.) fall through and upload normally.
    // The server still handles the actual write; this check is just for UX warning.
    console.warn('[upload] exists-check failed, proceeding without conflict warning:', e.message);
  }

  if (conflicts.length === 0) {
    return doUpload(items);
  }

  if (State.versioning === 'Enabled') {
    toast(`${conflicts.length} archivo(s) crearán nuevas versiones`, 'info', 4000);
    return doUpload(items);
  }

  // Versioning OFF and there are conflicts → ask the user explicitly
  return promptOverwrite(items, conflicts);
}

async function doUpload(items) {
  if (!items.length) return;
  const fd = new FormData();
  fd.append('prefix', State.prefix);
  for (const it of items) fd.append('files', it.file);
  try {
    toast(`Subiendo ${items.length} archivo(s)...`, 'info');
    await api(`/api/object/${encodeURIComponent(State.activeBucket)}/upload`, { method: 'POST', body: fd });
    toast('Subida completa', 'success');
    loadObjects();
  } catch (e) { toast(e.message, 'error'); }
}

function promptOverwrite(allItems, conflicts) {
  const conflictKeys = new Set(conflicts.map(c => c.key));
  const newOnes = allItems.filter(i => !conflictKeys.has(i.key));

  document.getElementById('overwrite-conflict-count').textContent = conflicts.length;
  document.getElementById('overwrite-dest').textContent = State.activeBucket + '/' + (State.prefix || '');
  const list = document.getElementById('overwrite-list');
  list.innerHTML = conflicts.map(c => `
    <div class="overwrite-item">
      <span class="overwrite-icon">📄</span>
      <span class="overwrite-name">${escapeHtml(c.file.name)}</span>
      <span class="overwrite-size">${formatSize(c.file.size)}</span>
    </div>
  `).join('');

  const newInfo = document.getElementById('overwrite-new-info');
  newInfo.textContent = newOnes.length > 0
    ? `${newOnes.length} archivo(s) nuevo(s) (sin conflicto) se subirá(n) normalmente con "Subir solo los nuevos".`
    : 'Todos los archivos seleccionados tienen conflicto.';

  const btnSkip = document.getElementById('btn-overwrite-skip');
  btnSkip.disabled = newOnes.length === 0;

  openModal('modal-overwrite');

  // Single-use handlers — reset on each prompt
  const cleanup = () => {
    document.getElementById('btn-overwrite-cancel').onclick = null;
    document.getElementById('btn-overwrite-skip').onclick = null;
    document.getElementById('btn-overwrite-all').onclick = null;
    closeModal('modal-overwrite');
  };
  document.getElementById('btn-overwrite-cancel').onclick = () => {
    toast('Subida cancelada', 'info');
    cleanup();
  };
  document.getElementById('btn-overwrite-skip').onclick = () => {
    cleanup();
    doUpload(newOnes);
  };
  document.getElementById('btn-overwrite-all').onclick = () => {
    cleanup();
    doUpload(allItems);
  };
}

// Drag & drop
const content = document.getElementById('content');
const dz = document.getElementById('dropzone');
let dragCounter = 0;
content.addEventListener('dragenter', e => { e.preventDefault(); if (State.activeBucket) { dragCounter++; dz.classList.add('show'); } });
content.addEventListener('dragleave', () => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dz.classList.remove('show'); } });
content.addEventListener('dragover', e => e.preventDefault());
content.addEventListener('drop', e => {
  e.preventDefault();
  dragCounter = 0;
  dz.classList.remove('show');
  if (!State.activeBucket) return;
  uploadFiles(e.dataTransfer.files);
});

// ---------- Connection modal ----------
document.getElementById('btn-add-conn').onclick = () => openConnModal(null);
document.getElementById('btn-first-conn').onclick = () => openConnModal(null);

function openConnModal(c) {
  const f = document.getElementById('form-conn');
  const el = f.elements;
  f.reset();
  document.getElementById('test-result').textContent = '';
  const importResult = document.getElementById('import-result');
  if (importResult) { importResult.textContent = ''; importResult.className = 'test-result'; }
  document.getElementById('conn-modal-title').textContent = c ? 'Editar conexión' : 'Nueva conexión S3';
  if (c) {
    el.id.value = c.id;
    el.name.value = c.name;
    el.endpoint.value = c.endpoint || '';
    el.region.value = c.region || 'us-east-1';
    el.accessKey.value = c.accessKey;
    el.secretKey.value = c.secretKey;
    el.sessionToken.value = c.sessionToken || '';
    el.pathStyle.checked = c.pathStyle !== false;
    el.buckets.value = (c.buckets || []).join('\n');
  } else {
    el.region.value = 'us-east-1';
    el.pathStyle.checked = true;
  }
  openModal('modal-conn');
}

function readConnForm() {
  const f = document.getElementById('form-conn');
  const el = f.elements;
  const bucketsRaw = (el.buckets.value || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  const buckets = [...new Set(bucketsRaw)];
  return {
    id: el.id.value || crypto.randomUUID(),
    name: el.name.value.trim(),
    endpoint: el.endpoint.value.trim(),
    region: el.region.value.trim() || 'us-east-1',
    accessKey: el.accessKey.value.trim(),
    secretKey: el.secretKey.value,
    sessionToken: el.sessionToken.value.trim(),
    pathStyle: el.pathStyle.checked,
    buckets,
  };
}

document.getElementById('btn-test-conn').onclick = async () => {
  const conn = readConnForm();
  const tr = document.getElementById('test-result');
  tr.textContent = 'Probando...';
  tr.className = 'test-result';
  try {
    const headers = {
      'Content-Type': 'application/json',
      'x-s3-endpoint': conn.endpoint || '',
      'x-s3-region': conn.region,
      'x-s3-access-key': conn.accessKey,
      'x-s3-secret-key': conn.secretKey,
      'x-s3-session-token': conn.sessionToken,
      'x-s3-path-style': conn.pathStyle ? 'true' : 'false',
    };
    // If user provided explicit buckets, test against the first one (HeadBucket).
    // Otherwise try ListBuckets and report the count.
    const body = conn.buckets && conn.buckets.length ? { bucket: conn.buckets[0] } : {};
    const res = await fetch('/api/test', {
      method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    if (data.mode === 'head-bucket') {
      tr.textContent = `✓ OK · acceso a "${data.bucket}"`;
    } else {
      tr.textContent = `✓ OK · ${data.bucketCount} buckets`;
    }
    tr.className = 'test-result ok';
  } catch (e) {
    tr.textContent = '✗ ' + e.message;
    tr.className = 'test-result err';
  }
};

// ---------- Import connection from file ----------
function parseEnvLike(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Strip optional "export " prefix
    if (key.startsWith('export ')) key = key.slice(7).trim();
    out[key.toUpperCase()] = val;
  }
  return out;
}

function suggestNameFromFile(filename) {
  const lower = filename.toLowerCase().replace(/^\./, '');
  if (lower.includes('vultr')) return 'Vultr';
  if (lower.includes('aws')) return 'AWS S3';
  if (lower.includes('minio')) return 'MinIO';
  if (lower.includes('r2') || lower.includes('cloudflare')) return 'Cloudflare R2';
  if (lower.includes('wasabi')) return 'Wasabi';
  if (lower.includes('b2') || lower.includes('backblaze')) return 'Backblaze B2';
  if (lower.includes('spaces') || lower.includes('digitalocean')) return 'DigitalOcean Spaces';
  // Fallback: use the filename without extension/leading dot
  return filename.replace(/^\./, '').replace(/\.[^.]+$/, '').replace(/[._-]+/g, ' ').trim() || 'Importado';
}

function applyImportedToForm(parsed, suggestedName) {
  const f = document.getElementById('form-conn');
  const el = f.elements;
  const result = document.getElementById('import-result');

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

  if (!el.name.value) el.name.value = suggestedName;
  el.accessKey.value = access;
  el.secretKey.value = secret;
  el.endpoint.value = endpoint;
  if (region) el.region.value = region;
  el.sessionToken.value = sessionToken;
  // Auto-detect path-style: AWS official endpoints use vhost-style; others typically need path-style
  const isAwsOfficial = /amazonaws\.com$/i.test(endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  el.pathStyle.checked = !isAwsOfficial;
  // Add the imported bucket to the manual buckets list (preserve existing entries, dedupe)
  if (bucket) {
    const existing = (el.buckets.value || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    if (!existing.includes(bucket)) existing.push(bucket);
    el.buckets.value = existing.join('\n');
  }
  result.textContent = `✓ Importado · ${Object.keys(parsed).length} campos leídos`;
  result.className = 'test-result ok';
  return true;
}

document.getElementById('btn-import-conn').onclick = () => {
  document.getElementById('import-conn-file').click();
};

document.getElementById('import-conn-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const result = document.getElementById('import-result');
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
    result.textContent = '✗ ' + err.message;
    result.className = 'test-result err';
  } finally {
    e.target.value = ''; // allow re-importing the same file later
  }
});

// Drag-and-drop support on the import row
(() => {
  const row = document.querySelector('.import-row');
  if (!row) return;
  ['dragenter', 'dragover'].forEach(ev => row.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation();
    row.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => row.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation();
    row.classList.remove('dragover');
  }));
  row.addEventListener('drop', async (e) => {
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const result = document.getElementById('import-result');
    try {
      const text = await file.text();
      const parsed = parseEnvLike(text);
      applyImportedToForm(parsed, suggestNameFromFile(file.name));
    } catch (err) {
      result.textContent = '✗ ' + err.message;
      result.className = 'test-result err';
    }
  });
})();

document.getElementById('form-conn').onsubmit = (e) => {
  e.preventDefault();
  const conn = readConnForm();
  const idx = State.connections.findIndex(c => c.id === conn.id);
  if (idx >= 0) State.connections[idx] = conn;
  else State.connections.push(conn);
  saveConnections();
  renderConnections();
  closeModal('modal-conn');
  selectConnection(conn.id);
};

// ---------- Bucket modal ----------
document.getElementById('btn-create-bucket').onclick = () => openModal('modal-bucket');
document.getElementById('form-bucket').onsubmit = async (e) => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  try {
    await api('/api/buckets', { method: 'POST', body: { name } });
    toast('Bucket creado', 'success');
    closeModal('modal-bucket');
    const { buckets } = await api('/api/buckets');
    State.buckets = buckets;
    renderBuckets();
  } catch (e) { toast(e.message, 'error'); }
};

// ---------- Folder modal ----------
document.getElementById('btn-new-folder').onclick = () => openModal('modal-folder');
document.getElementById('form-folder').onsubmit = async (e) => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  try {
    await api(`/api/object/${encodeURIComponent(State.activeBucket)}/folder`, {
      method: 'POST', body: { prefix: State.prefix, name },
    });
    toast('Carpeta creada', 'success');
    closeModal('modal-folder');
    loadObjects();
  } catch (e) { toast(e.message, 'error'); }
};

// ---------- Refresh ----------
document.getElementById('btn-refresh').onclick = () => {
  if (State.activeBucket) loadObjects();
  else if (State.activeConnId) selectConnection(State.activeConnId);
};

// ---------- Utils ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function formatSize(b) {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b/1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b/1024/1024).toFixed(1) + ' MB';
  return (b/1024/1024/1024).toFixed(2) + ' GB';
}
function formatDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  return date.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
}

// ---------- Search ----------
const searchInput = document.getElementById('search-input');
const searchClearBtn = document.getElementById('btn-search-clear');
let searchDebounce = null;

searchInput.addEventListener('input', (e) => {
  State.filterTerm = e.target.value;
  searchClearBtn.style.display = State.filterTerm ? 'block' : 'none';
  // If we were in global-search mode, leaving the field empty or editing reverts to local filter
  if (State.searchResults !== null) {
    State.searchResults = null;
    State.searchMeta = null;
    updateSearchBanner();
  }
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => renderGrid(), 80);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (State.filterTerm.trim()) runRecursiveSearch();
  } else if (e.key === 'Escape') {
    clearSearch();
  }
});

searchClearBtn.onclick = () => clearSearch();

function clearSearch() {
  if (searchAbort) searchAbort.abort();
  searchInput.value = '';
  State.filterTerm = '';
  State.searchResults = null;
  State.searchFolderHits = null;
  State.searchMeta = null;
  searchClearBtn.style.display = 'none';
  updateSearchBanner();
  renderGrid();
}

let searchAbort = null;

function categorizeMatch(key, qLower) {
  const segments = key.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].toLowerCase().includes(qLower)) {
      return { type: 'folder', key: segments.slice(0, i + 1).join('/') + '/' };
    }
  }
  return { type: 'file', key };
}

async function runRecursiveSearch() {
  const q = State.filterTerm.trim();
  if (!q || !State.activeBucket) return;
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();

  const qLower = q.toLowerCase();
  State.searchResults = [];
  State.searchFolderHits = new Map();
  State.searchMeta = { scanned: 0, hits: 0, query: q, status: 'scanning' };
  State.selected.clear();
  renderGrid();
  updateSearchBanner();

  let rerenderTimer = null;
  const scheduleRerender = () => {
    if (rerenderTimer) return;
    rerenderTimer = setTimeout(() => { rerenderTimer = null; renderGrid(); updateSearchBanner(); }, 120);
  };

  try {
    const params = new URLSearchParams({ q });
    const res = await fetch(`/api/search-stream/${encodeURIComponent(State.activeBucket)}?${params}`, {
      headers: authHeaders(),
      signal: searchAbort.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }

        if (ev.t === 'hit') {
          const cat = categorizeMatch(ev.key, qLower);
          if (cat.type === 'folder') {
            const cur = State.searchFolderHits.get(cat.key) || { fileCount: 0, totalSize: 0, latestModified: null };
            cur.fileCount++;
            cur.totalSize += ev.size || 0;
            if (!cur.latestModified || new Date(ev.modified) > new Date(cur.latestModified)) cur.latestModified = ev.modified;
            State.searchFolderHits.set(cat.key, cur);
          } else {
            State.searchResults.push({ Key: ev.key, Size: ev.size, LastModified: ev.modified, ETag: ev.etag });
          }
          State.searchMeta.hits++;
          scheduleRerender();
        } else if (ev.t === 'progress') {
          State.searchMeta.scanned = ev.scanned;
          scheduleRerender();
        } else if (ev.t === 'done') {
          State.searchMeta.status = 'done';
          State.searchMeta.reason = ev.reason;
          State.searchMeta.scanned = ev.scanned;
          renderGrid();
          updateSearchBanner();
        } else if (ev.t === 'error') {
          State.searchMeta.status = 'error';
          State.searchMeta.error = ev.message;
          updateSearchBanner();
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      State.searchMeta.status = 'cancelled';
      updateSearchBanner();
      renderGrid();
      return;
    }
    State.searchMeta.status = 'error';
    State.searchMeta.error = e.message;
    updateSearchBanner();
  }
}

function updateSearchBanner() {
  const banner = document.getElementById('search-banner');
  if (!State.searchMeta) { banner.style.display = 'none'; return; }
  const { scanned, query, status, reason, error } = State.searchMeta;
  const folderCount = State.searchFolderHits?.size || 0;
  const fileCount = State.searchResults?.length || 0;

  let statusLabel = '';
  if (status === 'scanning') statusLabel = `<span style="color:var(--primary-2)">⏳ escaneando...</span>`;
  else if (status === 'done') statusLabel = reason === 'limit'
    ? `<span class="truncated">⚠ tope de resultados (refina la búsqueda)</span>`
    : `<span style="color:var(--green)">✓ completo</span>`;
  else if (status === 'cancelled') statusLabel = `<span class="truncated">⛔ cancelado</span>`;
  else if (status === 'error') statusLabel = `<span style="color:var(--red)">error: ${escapeHtml(error || '')}</span>`;

  banner.style.display = 'flex';
  banner.innerHTML = `
    <span>
      <strong>${folderCount}</strong> carpeta(s) · <strong>${fileCount}</strong> archivo(s)
      para "<strong>${escapeHtml(query)}</strong>"
      · escaneados ${scanned.toLocaleString()}
      · ${statusLabel}
    </span>
    <span style="display:flex; gap:6px">
      ${status === 'scanning' ? '<button class="btn" id="btn-cancel-search">Cancelar</button>' : ''}
      <button class="btn" id="btn-exit-search">Salir</button>
    </span>
  `;
  document.getElementById('btn-exit-search').onclick = () => clearSearch();
  const cancelBtn = document.getElementById('btn-cancel-search');
  if (cancelBtn) cancelBtn.onclick = () => { if (searchAbort) searchAbort.abort(); };
}

// ---------- Sort & Deleted toggle ----------
document.querySelectorAll('.grid th.sortable').forEach(th => {
  th.onclick = () => {
    const field = th.dataset.sort;
    if (State.sort.field === field) {
      State.sort.dir = State.sort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      State.sort = { field, dir: 'asc' };
    }
    renderGrid();
  };
});

document.getElementById('chk-deleted').addEventListener('change', (e) => {
  State.showDeleted = e.target.checked;
  loadObjects();
});

// ---------- Object Info Panel ----------
let currentInfoObj = null;

async function openInfoPanel(o) {
  currentInfoObj = o;
  const panel = document.getElementById('info-panel');
  document.querySelector('.main').classList.add('with-info');
  panel.classList.add('open');

  const name = o.Key.split('/').pop();
  const folder = o.Key.slice(0, o.Key.length - name.length);
  const ico = fileIcon(name);
  const iconEl = document.getElementById('info-icon');
  iconEl.className = 'icon-file ' + ico.cls;
  iconEl.textContent = ico.label;
  document.getElementById('info-name').textContent = name;
  document.getElementById('info-path').textContent = folder || '(raíz)';

  const meta = document.getElementById('info-meta');
  meta.querySelector('[data-k="size"]').textContent = formatSize(o.Size);
  meta.querySelector('[data-k="modified"]').textContent = formatDate(o.LastModified);
  meta.querySelector('[data-k="etag"]').textContent = (o.ETag || '—').replace(/"/g, '');
  meta.querySelector('[data-k="storage-class"]').textContent = o.StorageClass || 'STANDARD';
  meta.querySelector('[data-k="content-type"]').textContent = 'Cargando...';
  meta.querySelector('[data-k="version-id"]').textContent = o.VersionId || '—';
  document.getElementById('info-user-meta-wrap').style.display = 'none';

  try {
    const params = new URLSearchParams({ key: o.Key });
    if (o.VersionId) params.set('versionId', o.VersionId);
    const head = await api(`/api/object/${encodeURIComponent(State.activeBucket)}/head?${params}`);
    meta.querySelector('[data-k="content-type"]').textContent = head.ContentType || 'application/octet-stream';
    if (head.VersionId) meta.querySelector('[data-k="version-id"]').textContent = head.VersionId;
    const userMeta = head.Metadata || {};
    const entries = Object.entries(userMeta);
    if (entries.length) {
      const dl = document.getElementById('info-user-meta');
      dl.innerHTML = entries.map(([k, v]) =>
        `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`
      ).join('');
      document.getElementById('info-user-meta-wrap').style.display = 'block';
    }
  } catch (e) {
    meta.querySelector('[data-k="content-type"]').textContent = '(error: ' + e.message + ')';
  }
}

function closeInfoPanel() {
  document.getElementById('info-panel').classList.remove('open');
  document.querySelector('.main').classList.remove('with-info');
  currentInfoObj = null;
}

document.getElementById('info-close').onclick = closeInfoPanel;
document.getElementById('info-preview').onclick = () => { if (currentInfoObj) openPreview(currentInfoObj); };
document.getElementById('info-download').onclick = () => { if (currentInfoObj) downloadObject(currentInfoObj.Key); };
document.getElementById('info-share').onclick = () => { if (currentInfoObj) shareObject(currentInfoObj.Key); };
document.getElementById('info-versions').onclick = () => {
  if (!currentInfoObj) return;
  openPreview(currentInfoObj);
  setTimeout(() => document.getElementById('btn-show-versions').click(), 200);
};
document.getElementById('info-rename').onclick = () => { if (currentInfoObj) openRename(currentInfoObj.Key); };
document.getElementById('info-delete').onclick = async () => {
  if (!currentInfoObj) return;
  const key = currentInfoObj.Key;
  if (!confirm(`Eliminar "${key}"?`)) return;
  try {
    await api(`/api/object/${encodeURIComponent(State.activeBucket)}`, {
      method: 'DELETE', body: { key },
    });
    toast('Eliminado', 'success');
    closeInfoPanel();
    loadObjects();
  } catch (e) { toast(e.message, 'error'); }
};

// ---------- Init ----------
(async () => {
  const ok = await authInit();
  if (ok) loadConnections();
})();
