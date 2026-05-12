// =============================================================================
// auth.js — User store, sessions, TOTP, and admin endpoints
// =============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const argon2 = require('@node-rs/argon2');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');

// CD-SEC-008: argon2id for password hashing (OWASP-recommended 2023+).
// Params: m=19456 KiB (~19 MB), t=2 iterations, p=1 parallelism — OWASP defaults.
const ARGON2_OPTS = {
  algorithm: argon2.Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

// Unified password hashing — argon2id everywhere new
async function hashPassword(plain) {
  return argon2.hash(plain, ARGON2_OPTS);
}

// Unified password verify — accepts both bcrypt (legacy) and argon2id (current) hashes
async function verifyPassword(plain, hashed) {
  if (!hashed) return false;
  try {
    if (hashed.startsWith('$argon2')) return await argon2.verify(hashed, plain);
    if (hashed.startsWith('$2')) return await bcrypt.compare(plain, hashed); // legacy bcrypt
    return false;
  } catch {
    return false;
  }
}

// Did this hash come from a legacy algorithm that should be re-hashed on next successful login?
function shouldRehash(hashed) {
  return typeof hashed === 'string' && hashed.startsWith('$2'); // legacy bcrypt → upgrade to argon2id
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const REVOKED_FILE = path.join(DATA_DIR, 'revoked.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_SECONDS = parseInt(process.env.SESSION_TTL_SECONDS || '43200', 10); // 12 h
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const SECURE_COOKIE = (process.env.SECURE_COOKIE || '1') === '1';

// CD-SEC-010: AES-256-GCM key for encrypting TOTP secrets at rest.
// Must be 64 hex chars (32 bytes). If absent, ephemeral key is generated and existing secrets
// become undecryptable on next restart — production MUST set this.
const TOTP_KEY_HEX = process.env.TOTP_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const TOTP_KEY = Buffer.from(TOTP_KEY_HEX, 'hex');
if (TOTP_KEY.length !== 32) {
  throw new Error('[auth] TOTP_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Generate: openssl rand -hex 32');
}

if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET env var not set — generated ephemeral secret. ' +
    'All sessions will be invalidated on server restart. Set SESSION_SECRET in production.');
}
if (!process.env.TOTP_ENCRYPTION_KEY) {
  console.warn('[auth] TOTP_ENCRYPTION_KEY not set — generated ephemeral key. ' +
    'EXISTING TOTP SECRETS WILL BECOME UNDECRYPTABLE ON RESTART. Set TOTP_ENCRYPTION_KEY in production.');
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// CD-SEC-002: pre-computed sentinel hash for constant-time login when user doesn't exist.
// argon2id format so verifyPassword takes the same path whether or not the user exists.
const FAKE_HASH = argon2.hashSync('not-a-real-password', ARGON2_OPTS);

// HIBP k-anonymity password breach check
// Sends only the first 5 chars of the SHA-1 of the password; never the password itself.
// Enable with CHECK_HIBP=1 in env. Fails open if HIBP API is unreachable (3s timeout).
const HIBP_ENABLED = (process.env.CHECK_HIBP || '0') === '1';

async function isPasswordBreached(password) {
  if (!HIBP_ENABLED) return false;
  try {
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 's3-explorer' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return false; // fail open
    const text = await res.text();
    for (const line of text.split('\n')) {
      const [s, count] = line.trim().split(':');
      if (s === suffix && parseInt(count, 10) > 0) return true;
    }
    return false;
  } catch {
    return false; // network/timeout/abort — fail open, don't block password set
  }
}

// CD-SEC-010: encrypt/decrypt TOTP secrets at rest with AES-256-GCM
function encryptTotpSecret(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', TOTP_KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}
function decryptTotpSecret(stored, contextUsername) {
  if (!stored) return null;
  // Backward-compatible: handles legacy cleartext secrets created before CD-SEC-010 fix.
  // SEC2-04: audit when this fallback path fires so unexpected cleartext (e.g. someone
  // hand-edited users.json or downgraded) is visible in logs.
  if (!stored.startsWith('enc:v1:')) {
    audit('totp_legacy_cleartext_loaded', { username: contextUsername || '(unknown)' });
    return stored;
  }
  const [, , ivB64, tagB64, ctB64] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', TOTP_KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

// ----- Audit logger (JSON lines to stdout) -----
function audit(event, fields = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

// ----- User store -----
// SEC2-03: serialize all read-modify-write operations through a promise-chain mutex
// so concurrent updateUser/saveUsers calls don't lose updates (lost-update problem).
let userStoreLock = Promise.resolve();
function withUserStoreLock(fn) {
  const next = userStoreLock.then(fn, fn);
  userStoreLock = next.then(() => {}, () => {}); // never leave the chain in a rejected state
  return next;
}

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}
function saveUsersSync(users) {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

function findUser(username) {
  return loadUsers().find(u => u.username.toLowerCase() === String(username || '').toLowerCase());
}

// Async because callers can be async. The mutex ensures load+modify+save runs atomically.
function updateUser(username, patch) {
  return withUserStoreLock(() => {
    const users = loadUsers();
    const i = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
    if (i < 0) return null;
    users[i] = { ...users[i], ...patch };
    saveUsersSync(users);
    return users[i];
  });
}

// For multi-step writes (e.g. push new user) — caller can run a transaction
function withUsers(fn) {
  return withUserStoreLock(() => {
    const users = loadUsers();
    const result = fn(users);
    saveUsersSync(users);
    return result;
  });
}

// Bootstrap admin from env on first boot
(function bootstrapAdmin() {
  if (loadUsers().length > 0) return;
  if (!ADMIN_USER || !ADMIN_PASS) {
    console.warn('[auth] No users found and ADMIN_USER/ADMIN_PASS not set. ' +
      'Set them in env to bootstrap the first admin.');
    return;
  }
  const users = [{
    username: ADMIN_USER,
    passwordHash: argon2.hashSync(ADMIN_PASS, ARGON2_OPTS),
    totpSecret: null,
    totpConfirmed: false,
    recoveryCodesHashed: [],
    role: 'admin',
    disabled: false,
    mustChangePassword: false,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  }];
  // Bootstrap runs synchronously at module load, before any request can race with it
  saveUsersSync(users);
  audit('admin_bootstrapped', { username: ADMIN_USER });
  console.log(`[auth] Bootstrapped admin user "${ADMIN_USER}". Must enroll TOTP on first login.`);
})();

// ----- Session signing (HMAC-SHA256, no JWT lib needed) -----
// CD-SEC-004: persistent revocation — {jti: expEpoch} so we can drop entries past their TTL
const revokedJtis = new Map();
(function loadRevoked() {
  try {
    const raw = JSON.parse(fs.readFileSync(REVOKED_FILE, 'utf8'));
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, exp] of Object.entries(raw)) {
      if (exp > now) revokedJtis.set(jti, exp);
    }
  } catch {}
})();
function saveRevoked() {
  const now = Math.floor(Date.now() / 1000);
  const obj = {};
  for (const [jti, exp] of revokedJtis) {
    if (exp > now) obj[jti] = exp;
  }
  try {
    const tmp = REVOKED_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, REVOKED_FILE);
  } catch (e) {
    console.error('[auth] Failed to persist revocation list:', e.message);
  }
}
// Periodic cleanup of expired entries
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const [jti, exp] of revokedJtis) {
    if (exp <= now) { revokedJtis.delete(jti); changed = true; }
  }
  if (changed) saveRevoked();
}, 60 * 60 * 1000).unref();

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  return `${body}.${sig}`;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); } catch { return null; }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (revokedJtis.has(payload.jti)) return null;
  return payload;
}

function addRevoked(jti, exp) {
  revokedJtis.set(jti, exp);
  saveRevoked();
}

function issueSession(res, user) {
  const jti = crypto.randomBytes(16).toString('hex');
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = sign({ uid: user.username, role: user.role, jti, exp });
  res.cookie('s3x_session', token, {
    httpOnly: true,
    secure: SECURE_COOKIE,
    sameSite: 'strict',
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
  return jti;
}

function revokeSession(req) {
  const token = req.cookies && req.cookies.s3x_session;
  const payload = token && verify(token);
  if (payload) addRevoked(payload.jti, payload.exp);
}

// ----- Pending step-2 (TOTP) state -----
// After password OK, we need a short-lived token saying "you may submit a TOTP code".
const PENDING_TTL = 120; // seconds
function issuePending(username) {
  return sign({ p: 1, uid: username, exp: Math.floor(Date.now() / 1000) + PENDING_TTL });
}
function verifyPending(token) {
  const p = verify(token);
  return p && p.p === 1 ? p : null;
}

// ----- Rate limiting (in-memory, per username + IP) -----
const attempts = new Map(); // key -> { count, until }
function rateLimit(key, max = 5, windowSec = 900) {
  const now = Math.floor(Date.now() / 1000);
  const rec = attempts.get(key);
  if (rec && rec.until > now) {
    if (rec.count >= max) return false;
  } else {
    attempts.set(key, { count: 0, until: now + windowSec });
  }
  return true;
}
function recordFailure(key) {
  const rec = attempts.get(key);
  if (rec) rec.count++;
}
function clearAttempts(key) {
  attempts.delete(key);
}

// ----- Recovery codes -----
function generateRecoveryCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    // 10 chars hex split with hyphen for legibility: xxxxx-xxxxx
    const raw = crypto.randomBytes(5).toString('hex');
    codes.push(raw.slice(0, 5) + '-' + raw.slice(5));
  }
  return codes;
}
function hashCodes(codes) {
  return codes.map(c => bcrypt.hashSync(c, 10));
}

// ----- Auth middleware -----
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.s3x_session;
  const payload = token && verify(token);
  if (!payload) return res.status(401).json({ message: 'Not authenticated', code: 'NO_SESSION' });
  const user = findUser(payload.uid);
  if (!user || user.disabled) return res.status(401).json({ message: 'User invalid or disabled', code: 'USER_INVALID' });
  req.session = payload;
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only' });
  next();
}

function requireTotpEnrolled(req, res, next) {
  if (!req.user.totpSecret || !req.user.totpConfirmed) {
    return res.status(403).json({ message: 'TOTP enrollment required', code: 'TOTP_REQUIRED' });
  }
  next();
}

// Block /api/* until the user has rotated the admin-issued initial password.
// The SPA already nags via a modal, but a client that ignores the modal would
// otherwise retain full API access with credentials the admin still knows.
function requirePasswordCurrent(req, res, next) {
  if (req.user && req.user.mustChangePassword) {
    return res.status(403).json({
      message: 'Debes cambiar la contraseña inicial antes de usar la API.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }
  next();
}

// ----- Routes -----
function register(app) {
  // ----- Session info -----
  app.get('/auth/me', (req, res) => {
    const token = req.cookies && req.cookies.s3x_session;
    const payload = token && verify(token);
    if (!payload) return res.json({ authenticated: false });
    const user = findUser(payload.uid);
    if (!user || user.disabled) return res.json({ authenticated: false });
    res.json({
      authenticated: true,
      username: user.username,
      role: user.role,
      totpEnrolled: !!user.totpConfirmed,
      mustChangePassword: !!user.mustChangePassword,
    });
  });

  // ----- Step 1: password -----
  app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    const ip = req.ip || '';
    const rlKey = `login:${ip}:${(username || '').toLowerCase()}`;
    if (!rateLimit(rlKey)) {
      audit('login_rate_limited', { username, ip });
      return res.status(429).json({ message: 'Demasiados intentos. Espera 15 minutos.' });
    }
    if (!username || !password) {
      return res.status(400).json({ message: 'username y password requeridos' });
    }
    const user = findUser(username);
    // CD-SEC-002: real constant-time — always run a verify against a sentinel hash if user is missing
    const hashToCheck = user ? user.passwordHash : FAKE_HASH;
    const passwordOk = await verifyPassword(password, hashToCheck);
    const ok = passwordOk && user && !user.disabled;
    if (!ok) {
      recordFailure(rlKey);
      audit('login_fail', { username, ip, reason: 'bad_credentials' });
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }
    // CD-SEC-008: transparent rehash — if the stored hash is legacy bcrypt, upgrade to argon2id now
    let updates = { lastLoginAt: new Date().toISOString() };
    if (shouldRehash(user.passwordHash)) {
      updates.passwordHash = await hashPassword(password);
      audit('password_rehashed', { username: user.username, from: 'bcrypt', to: 'argon2id' });
    }
    // If user has no TOTP enrolled yet, skip to enrollment after login
    if (!user.totpSecret || !user.totpConfirmed) {
      // Issue full session immediately but flag that enrollment is needed.
      // The client will be redirected to the enrollment flow.
      const jti = issueSession(res, user);
      await updateUser(user.username, updates);
      clearAttempts(rlKey);
      audit('login_ok', { username: user.username, ip, jti, totpEnrolled: false });
      return res.json({ step: 'enroll_totp' });
    }
    // Otherwise: ask for TOTP. Apply pending updates (lastLogin, rehash) now since password is verified.
    await updateUser(user.username, updates);
    const pendingToken = issuePending(user.username);
    res.cookie('s3x_pending', pendingToken, {
      httpOnly: true,
      secure: SECURE_COOKIE,
      sameSite: 'strict',
      maxAge: PENDING_TTL * 1000,
      path: '/',
    });
    audit('login_step1_ok', { username: user.username, ip });
    res.json({ step: 'totp' });
  });

  // ----- Step 2: TOTP code -----
  app.post('/auth/totp', async (req, res) => {
    const { code } = req.body || {};
    const ip = req.ip || '';
    const pendingToken = req.cookies && req.cookies.s3x_pending;
    const pending = verifyPending(pendingToken);
    if (!pending) return res.status(401).json({ message: 'Sesión expirada. Reintenta el login.' });
    const user = findUser(pending.uid);
    if (!user || user.disabled || !user.totpSecret) {
      return res.status(401).json({ message: 'Usuario inválido' });
    }
    const rlKey = `totp:${ip}:${user.username}`;
    if (!rateLimit(rlKey)) {
      audit('totp_rate_limited', { username: user.username, ip });
      return res.status(429).json({ message: 'Demasiados intentos. Espera 15 minutos.' });
    }
    const clean = String(code || '').replace(/\s+/g, '');
    let ok = false;
    if (/^\d{6}$/.test(clean)) {
      ok = authenticator.check(clean, decryptTotpSecret(user.totpSecret, user.username));
    } else if (/^[a-f0-9]{5}-[a-f0-9]{5}$/.test(clean)) {
      // Recovery code
      for (let i = 0; i < user.recoveryCodesHashed.length; i++) {
        const h = user.recoveryCodesHashed[i];
        if (h && await bcrypt.compare(clean, h)) {
          ok = true;
          const updated = [...user.recoveryCodesHashed];
          updated[i] = null; // burn this code
          await updateUser(user.username, { recoveryCodesHashed: updated });
          audit('recovery_code_used', { username: user.username, ip, remaining: updated.filter(Boolean).length });
          break;
        }
      }
    }
    if (!ok) {
      recordFailure(rlKey);
      audit('totp_fail', { username: user.username, ip });
      return res.status(401).json({ message: 'Código inválido' });
    }
    clearAttempts(rlKey);
    res.clearCookie('s3x_pending', { path: '/' });
    const jti = issueSession(res, user);
    await updateUser(user.username, { lastLoginAt: new Date().toISOString() });
    audit('login_ok', { username: user.username, ip, jti });
    res.json({ ok: true });
  });

  // ----- Logout -----
  app.post('/auth/logout', (req, res) => {
    revokeSession(req);
    res.clearCookie('s3x_session', { path: '/' });
    audit('logout', { username: (req.user && req.user.username) || 'unknown' });
    res.json({ ok: true });
  });

  // ----- TOTP enrollment (must be logged-in) -----
  // CD-SEC-010 + idempotency fix:
  // - If TOTP already confirmed, REFUSE (must go through admin reset-totp).
  // - If there's a pending (unconfirmed) secret, REUSE it. This way F5/refresh
  //   during enrollment doesn't invalidate the QR the user already scanned.
  // - Use ?regenerate=1 to explicitly start over (e.g. user can't find their QR).
  app.post('/auth/totp/setup', requireAuth, async (req, res) => {
    if (req.user.totpConfirmed) {
      return res.status(409).json({
        message: 'TOTP ya está activado para tu cuenta. Pide al admin que te haga "Resetear TOTP" si necesitas re-enrolar.',
        code: 'ALREADY_ENROLLED',
      });
    }
    const wantsRegen = req.query.regenerate === '1';
    let secret;
    if (req.user.totpSecret && !wantsRegen) {
      // Reuse pending secret — survives page refresh
      secret = decryptTotpSecret(req.user.totpSecret, req.user.username);
      audit('totp_setup_resumed', { username: req.user.username });
    } else {
      secret = authenticator.generateSecret();
      await updateUser(req.user.username, { totpSecret: encryptTotpSecret(secret), totpConfirmed: false });
      audit('totp_setup_started', { username: req.user.username, regenerated: wantsRegen });
    }
    const otpauth = authenticator.keyuri(req.user.username, 'S3 Explorer', secret);
    const qrSvg = await QRCode.toString(otpauth, { type: 'svg', margin: 1, width: 220 });
    res.json({ otpauth, qrSvg, secret });
  });

  app.post('/auth/totp/confirm', requireAuth, async (req, res) => {
    const { code } = req.body || {};
    if (!req.user.totpSecret) return res.status(400).json({ message: 'No hay secret pendiente' });
    const ok = authenticator.check(String(code || '').replace(/\s+/g, ''), decryptTotpSecret(req.user.totpSecret, req.user.username));
    if (!ok) {
      audit('totp_setup_fail', { username: req.user.username });
      return res.status(401).json({ message: 'Código inválido' });
    }
    const recoveryCodes = generateRecoveryCodes(8);
    await updateUser(req.user.username, {
      totpConfirmed: true,
      recoveryCodesHashed: hashCodes(recoveryCodes),
    });
    audit('totp_confirmed', { username: req.user.username });
    res.json({ ok: true, recoveryCodes });
  });

  // ----- Change own password -----
  app.post('/auth/me/password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!await verifyPassword(currentPassword || '', req.user.passwordHash)) {
      audit('password_change_fail', { username: req.user.username });
      return res.status(401).json({ message: 'Contraseña actual incorrecta' });
    }
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ message: 'Mínimo 8 caracteres' });
    }
    if (await isPasswordBreached(newPassword)) {
      audit('password_breached_rejected', { username: req.user.username });
      return res.status(400).json({
        message: 'Esa contraseña aparece en fugas conocidas (HIBP). Elige otra.',
        code: 'BREACHED',
      });
    }
    await updateUser(req.user.username, {
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
    });
    audit('password_changed', { username: req.user.username });
    res.json({ ok: true });
  });

  // ----- Regenerate recovery codes -----
  app.post('/auth/me/recovery', requireAuth, requireTotpEnrolled, async (req, res) => {
    const codes = generateRecoveryCodes(8);
    await updateUser(req.user.username, { recoveryCodesHashed: hashCodes(codes) });
    audit('recovery_codes_regenerated', { username: req.user.username });
    res.json({ recoveryCodes: codes });
  });

  // ----- Admin: list users -----
  app.get('/auth/admin/users', requireAuth, requireAdmin, (req, res) => {
    const users = loadUsers().map(u => ({
      username: u.username,
      role: u.role,
      disabled: !!u.disabled,
      totpEnrolled: !!u.totpConfirmed,
      mustChangePassword: !!u.mustChangePassword,
      recoveryRemaining: (u.recoveryCodesHashed || []).filter(Boolean).length,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    }));
    res.json({ users });
  });

  // ----- Admin: create user -----
  app.post('/auth/admin/users', requireAuth, requireAdmin, async (req, res) => {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ message: 'username y password requeridos' });
    if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) return res.status(400).json({ message: 'username inválido (2-32 chars, letras/números/._-)' });
    if (password.length < 8) return res.status(400).json({ message: 'password mínimo 8 caracteres' });
    if (await isPasswordBreached(password)) {
      audit('password_breached_rejected', { by: req.user.username, attempted_for: username });
      return res.status(400).json({
        message: 'Esa contraseña aparece en fugas conocidas (HIBP). Elige otra.',
        code: 'BREACHED',
      });
    }
    // Pre-compute the password hash OUTSIDE the lock (argon2 is slow ~85ms);
    // the existence check + push is then done atomically under the lock.
    const passwordHash = await hashPassword(password);
    const conflict = await withUsers((users) => {
      if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
        return true; // conflict, don't push
      }
      users.push({
        username,
        passwordHash,
        totpSecret: null,
        totpConfirmed: false,
        recoveryCodesHashed: [],
        role: role === 'admin' ? 'admin' : 'user',
        disabled: false,
        mustChangePassword: true,
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
      });
      return false;
    });
    if (conflict) return res.status(409).json({ message: 'Usuario ya existe' });
    audit('user_created', { by: req.user.username, username, role });
    res.json({ ok: true });
  });

  // ----- Admin: disable/enable -----
  app.post('/auth/admin/users/:username/disable', requireAuth, requireAdmin, async (req, res) => {
    if (req.params.username.toLowerCase() === req.user.username.toLowerCase()) {
      return res.status(400).json({ message: 'No puedes deshabilitarte a ti mismo' });
    }
    const u = await updateUser(req.params.username, { disabled: true });
    if (!u) return res.status(404).json({ message: 'No existe' });
    audit('user_disabled', { by: req.user.username, username: req.params.username });
    res.json({ ok: true });
  });

  app.post('/auth/admin/users/:username/enable', requireAuth, requireAdmin, async (req, res) => {
    const u = await updateUser(req.params.username, { disabled: false });
    if (!u) return res.status(404).json({ message: 'No existe' });
    audit('user_enabled', { by: req.user.username, username: req.params.username });
    res.json({ ok: true });
  });

  // ----- Admin: reset password (forces change on next login) -----
  app.post('/auth/admin/users/:username/reset-password', requireAuth, requireAdmin, async (req, res) => {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ message: 'Mínimo 8 caracteres' });
    if (await isPasswordBreached(newPassword)) {
      audit('password_breached_rejected', { by: req.user.username, attempted_for: req.params.username });
      return res.status(400).json({
        message: 'Esa contraseña aparece en fugas conocidas (HIBP). Elige otra.',
        code: 'BREACHED',
      });
    }
    const u = await updateUser(req.params.username, {
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: true,
    });
    if (!u) return res.status(404).json({ message: 'No existe' });
    audit('admin_password_reset', { by: req.user.username, username: req.params.username });
    res.json({ ok: true });
  });

  // ----- Admin: reset TOTP (forces re-enrollment) -----
  app.post('/auth/admin/users/:username/reset-totp', requireAuth, requireAdmin, async (req, res) => {
    const u = await updateUser(req.params.username, {
      totpSecret: null,
      totpConfirmed: false,
      recoveryCodesHashed: [],
    });
    if (!u) return res.status(404).json({ message: 'No existe' });
    audit('admin_totp_reset', { by: req.user.username, username: req.params.username });
    res.json({ ok: true });
  });
}

module.exports = { register, requireAuth, requireTotpEnrolled, requirePasswordCurrent, audit };
