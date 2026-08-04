import type { Application, Request, Response } from 'express';
import * as bcrypt from 'bcryptjs';
import * as QRCode from 'qrcode';
import { audit } from './audit';
import {
  hashPassword,
  verifyPassword,
  shouldRehash,
  FAKE_HASH,
  isPasswordBreached,
} from './passwords';
import {
  encryptTotpSecret,
  decryptTotpSecret,
  generateTotpSecret,
  checkTotpCode,
  buildOtpAuthUri,
} from './totp';
import { generateRecoveryCodes, hashCodes } from './recovery-codes';
import { rateLimit, recordFailure, clearAttempts } from './rate-limit';
import { issueSession, issuePending, revokeSession, verifyPending, verifyToken } from './sessions';
import { findUser, listUsers, updateUser, createUser } from './users-store';
import {
  requireAuth,
  requireAdmin,
  requireTotpEnrolled,
} from './middleware';
import {
  loginSchema,
  totpSchema,
  changePasswordSchema,
  createUserSchema,
  resetPasswordSchema,
  createTokenSchema,
  validateBody,
} from './schemas';
import {
  createToken,
  listTokens,
  findTokenById,
  revokeToken,
  countActiveTokens,
  MAX_ACTIVE_TOKENS,
} from './tokens-store';
import type { User } from '../types';

export function register(app: Application): void {
  // ----- Session info -----
  app.get('/auth/me', (req: Request, res: Response) => {
    const token = req.cookies && req.cookies.s3x_session;
    const payload = verifyToken(token);
    if (!payload) { res.json({ authenticated: false }); return; }
    const user = findUser(payload.uid);
    if (!user || user.disabled) { res.json({ authenticated: false }); return; }
    res.json({
      authenticated: true,
      username: user.username,
      role: user.role,
      totpEnrolled: !!user.totpConfirmed,
      mustChangePassword: !!user.mustChangePassword,
    });
  });

  // ----- Step 1: password -----
  app.post('/auth/login', validateBody(loginSchema), async (req: Request, res: Response) => {
    const { username, password } = req.body as { username: string; password: string };
    const ip = req.ip || '';
    const rlKey = `login:${ip}:${username.toLowerCase()}`;
    if (!rateLimit(rlKey)) {
      audit('login_rate_limited', { username, ip });
      res.status(429).json({ message: 'Demasiados intentos. Espera 15 minutos.' });
      return;
    }
    const user = findUser(username);
    // CD-SEC-002: constant-time — always run verify against a sentinel hash if user is missing
    const hashToCheck = user ? user.passwordHash : FAKE_HASH;
    const passwordOk = await verifyPassword(password, hashToCheck);
    const ok = passwordOk && user && !user.disabled;
    if (!ok) {
      recordFailure(rlKey);
      audit('login_fail', { username, ip, reason: 'bad_credentials' });
      res.status(401).json({ message: 'Credenciales inválidas' });
      return;
    }
    // CD-SEC-008: transparent rehash — if stored hash is legacy bcrypt, upgrade to argon2id
    const updates: Partial<User> = { lastLoginAt: new Date().toISOString() };
    if (shouldRehash(user.passwordHash)) {
      updates.passwordHash = await hashPassword(password);
      audit('password_rehashed', { username: user.username, from: 'bcrypt', to: 'argon2id' });
    }
    // If user has no TOTP enrolled yet, skip to enrollment after login
    if (!user.totpSecret || !user.totpConfirmed) {
      const jti = issueSession(res, user);
      await updateUser(user.username, updates);
      clearAttempts(rlKey);
      audit('login_ok', { username: user.username, ip, jti, totpEnrolled: false });
      res.json({ step: 'enroll_totp' });
      return;
    }
    // Otherwise: ask for TOTP. Apply pending updates now since password is verified.
    await updateUser(user.username, updates);
    issuePending(res, user.username);
    audit('login_step1_ok', { username: user.username, ip });
    res.json({ step: 'totp' });
  });

  // ----- Step 2: TOTP code -----
  app.post('/auth/totp', validateBody(totpSchema), async (req: Request, res: Response) => {
    const { code } = req.body as { code: string };
    const ip = req.ip || '';
    const pendingToken = req.cookies && req.cookies.s3x_pending;
    const pending = verifyPending(pendingToken);
    if (!pending) { res.status(401).json({ message: 'Sesión expirada. Reintenta el login.' }); return; }
    const user = findUser(pending.uid);
    if (!user || user.disabled || !user.totpSecret) {
      res.status(401).json({ message: 'Usuario inválido' });
      return;
    }
    const rlKey = `totp:${ip}:${user.username}`;
    if (!rateLimit(rlKey)) {
      audit('totp_rate_limited', { username: user.username, ip });
      res.status(429).json({ message: 'Demasiados intentos. Espera 15 minutos.' });
      return;
    }
    const clean = code.replace(/\s+/g, '');
    let ok = false;
    if (/^\d{6}$/.test(clean)) {
      const secret = decryptTotpSecret(user.totpSecret, user.username);
      if (secret) {
        const step = checkTotpCode(clean, secret);
        if (step !== null && step > user.lastTotpStep) {
          // Valid code AND its timestep hasn't been consumed yet — accept and
          // burn the step so the same code can't be replayed within its window.
          ok = true;
          await updateUser(user.username, { lastTotpStep: step });
        } else if (step !== null) {
          // Code is cryptographically valid but its step was already used.
          audit('totp_replay_blocked', { username: user.username, ip });
        }
      }
    } else if (/^[a-f0-9]{5}-[a-f0-9]{5}$|^[a-f0-9]{8}(-[a-f0-9]{8}){3}$/.test(clean)) {
      // Recovery code. Accept both the legacy 40-bit (xxxxx-xxxxx) and the
      // current 128-bit (xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxx) formats so codes
      // issued before the entropy bump still validate. Match is by bcrypt
      // compare against the stored hashes regardless of format.
      for (let i = 0; i < user.recoveryCodesHashed.length; i++) {
        const h = user.recoveryCodesHashed[i];
        if (h && await bcrypt.compare(clean, h)) {
          ok = true;
          const updated = [...user.recoveryCodesHashed];
          updated[i] = null; // burn this code
          await updateUser(user.username, { recoveryCodesHashed: updated });
          audit('recovery_code_used', {
            username: user.username, ip, remaining: updated.filter(Boolean).length,
          });
          break;
        }
      }
    }
    if (!ok) {
      recordFailure(rlKey);
      audit('totp_fail', { username: user.username, ip });
      res.status(401).json({ message: 'Código inválido' });
      return;
    }
    clearAttempts(rlKey);
    res.clearCookie('s3x_pending', { path: '/' });
    const jti = issueSession(res, user);
    await updateUser(user.username, { lastLoginAt: new Date().toISOString() });
    audit('login_ok', { username: user.username, ip, jti });
    res.json({ ok: true });
  });

  // ----- Logout -----
  app.post('/auth/logout', (req: Request, res: Response) => {
    revokeSession(req);
    res.clearCookie('s3x_session', { path: '/' });
    audit('logout', { username: (req.user && req.user.username) || 'unknown' });
    res.json({ ok: true });
  });

  // ----- TOTP enrollment (must be logged-in) -----
  // CD-SEC-010 + idempotency:
  // - If TOTP already confirmed, REFUSE (must go through admin reset-totp).
  // - If there's a pending (unconfirmed) secret, REUSE it. F5 during enrollment
  //   doesn't invalidate the QR the user already scanned.
  // - Use ?regenerate=1 to explicitly start over.
  app.post('/auth/totp/setup', requireAuth, async (req: Request, res: Response) => {
    const user = req.user!;
    if (user.totpConfirmed) {
      res.status(409).json({
        message: 'TOTP ya está activado para tu cuenta. Pide al admin que te haga "Resetear TOTP" si necesitas re-enrolar.',
        code: 'ALREADY_ENROLLED',
      });
      return;
    }
    const wantsRegen = req.query.regenerate === '1';
    let secret: string;
    if (user.totpSecret && !wantsRegen) {
      // Reuse pending secret — survives page refresh
      const decrypted = decryptTotpSecret(user.totpSecret, user.username);
      if (!decrypted) {
        res.status(500).json({ message: 'Error al leer el secret pendiente' });
        return;
      }
      secret = decrypted;
      audit('totp_setup_resumed', { username: user.username });
    } else {
      secret = generateTotpSecret();
      await updateUser(user.username, {
        totpSecret: encryptTotpSecret(secret),
        totpConfirmed: false,
      });
      audit('totp_setup_started', { username: user.username, regenerated: wantsRegen });
    }
    const otpauth = buildOtpAuthUri(user.username, secret);
    const qrSvg = await QRCode.toString(otpauth, { type: 'svg', margin: 1, width: 220 });
    res.json({ otpauth, qrSvg, secret });
  });

  app.post('/auth/totp/confirm', requireAuth, validateBody(totpSchema), async (req: Request, res: Response) => {
    const user = req.user!;
    const { code } = req.body as { code: string };
    if (!user.totpSecret) { res.status(400).json({ message: 'No hay secret pendiente' }); return; }
    const secret = decryptTotpSecret(user.totpSecret, user.username);
    const step = secret ? checkTotpCode(code.replace(/\s+/g, ''), secret) : null;
    // Enforce monotonic step here too so the enrollment-confirmation code can't
    // be immediately replayed to complete a login in the same window.
    if (step === null || step <= user.lastTotpStep) {
      audit('totp_setup_fail', { username: user.username });
      res.status(401).json({ message: 'Código inválido' });
      return;
    }
    const recoveryCodes = generateRecoveryCodes(8);
    await updateUser(user.username, {
      totpConfirmed: true,
      recoveryCodesHashed: hashCodes(recoveryCodes),
      lastTotpStep: step,
    });
    audit('totp_confirmed', { username: user.username });
    res.json({ ok: true, recoveryCodes });
  });

  // ----- Change own password -----
  app.post('/auth/me/password', requireAuth, validateBody(changePasswordSchema), async (req: Request, res: Response) => {
    const user = req.user!;
    const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
    if (!await verifyPassword(currentPassword, user.passwordHash)) {
      audit('password_change_fail', { username: user.username });
      res.status(401).json({ message: 'Contraseña actual incorrecta' });
      return;
    }
    if (await isPasswordBreached(newPassword)) {
      audit('password_breached_rejected', { username: user.username });
      res.status(400).json({
        message: 'Esa contraseña aparece en fugas conocidas (HIBP). Elige otra.',
        code: 'BREACHED',
      });
      return;
    }
    await updateUser(user.username, {
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
    });
    audit('password_changed', { username: user.username });
    res.json({ ok: true });
  });

  // ----- Regenerate recovery codes -----
  app.post('/auth/me/recovery', requireAuth, requireTotpEnrolled, async (req: Request, res: Response) => {
    const user = req.user!;
    const codes = generateRecoveryCodes(8);
    await updateUser(user.username, { recoveryCodesHashed: hashCodes(codes) });
    audit('recovery_codes_regenerated', { username: user.username });
    res.json({ recoveryCodes: codes });
  });

  // ----- Personal Access Tokens (session-auth ONLY — Bearer tokens are
  // rejected here because /auth/* never goes through token auth; a PAT must
  // not be able to mint or revoke other PATs) -----

  app.get('/auth/tokens', requireAuth, requireTotpEnrolled, (req: Request, res: Response) => {
    const user = req.user!;
    const tokens = listTokens(user.username).map((t) => ({
      id: t.id,
      name: t.name,
      scope: t.scope,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      lastUsedAt: t.lastUsedAt,
      revokedAt: t.revokedAt,
    }));
    res.json({ tokens });
  });

  app.post('/auth/tokens', requireAuth, requireTotpEnrolled, validateBody(createTokenSchema), (req: Request, res: Response) => {
    const user = req.user!;
    const { name, scope, expiresInDays } = req.body as {
      name: string; scope: 'read' | 'write'; expiresInDays?: 30 | 90 | null;
    };
    if (countActiveTokens(user.username) >= MAX_ACTIVE_TOKENS) {
      res.status(409).json({
        message: `Límite de ${MAX_ACTIVE_TOKENS} tokens activos alcanzado. Revoca alguno antes de crear otro.`,
        code: 'TOKEN_LIMIT',
      });
      return;
    }
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const { token, plaintext } = createToken({ username: user.username, name, scope, expiresAt });
    audit('token_created', {
      username: user.username, tokenId: token.id, name: token.name, scope: token.scope, expiresAt,
    });
    // The plaintext leaves the server exactly once, here. Only its hash is stored.
    res.json({
      id: token.id,
      name: token.name,
      scope: token.scope,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      token: plaintext,
    });
  });

  app.delete('/auth/tokens/:id', requireAuth, requireTotpEnrolled, (req: Request, res: Response) => {
    const user = req.user!;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ message: 'id inválido', code: 'BAD_REQUEST' });
      return;
    }
    const token = findTokenById(id, user.username);
    if (!token) { res.status(404).json({ message: 'No existe' }); return; }
    // Idempotent: revoking an already-revoked token is a no-op success.
    if (!token.revokedAt) {
      revokeToken(id);
      audit('token_revoked', { username: user.username, tokenId: id, name: token.name });
    }
    res.json({ ok: true });
  });

  // ----- Admin: list users -----
  app.get('/auth/admin/users', requireAuth, requireAdmin, (_req: Request, res: Response) => {
    const users = listUsers().map((u) => ({
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
  app.post('/auth/admin/users', requireAuth, requireAdmin, validateBody(createUserSchema), async (req: Request, res: Response) => {
    const actor = req.user!;
    const { username, password, role } = req.body as { username: string; password: string; role?: 'admin' | 'user' };
    if (await isPasswordBreached(password)) {
      audit('password_breached_rejected', { by: actor.username, attempted_for: username });
      res.status(400).json({
        message: 'Esa contraseña aparece en fugas conocidas (HIBP). Elige otra.',
        code: 'BREACHED',
      });
      return;
    }
    // Hash outside the DB insert — argon2id takes ~85ms. The INSERT itself is
    // atomic and SQLite's UNIQUE index on LOWER(username) detects collisions.
    const passwordHash = await hashPassword(password);
    const conflict = createUser({
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
      lastTotpStep: 0,
    });
    if (conflict) { res.status(409).json({ message: 'Usuario ya existe' }); return; }
    audit('user_created', { by: actor.username, username, role });
    res.json({ ok: true });
  });

  // ----- Admin: disable -----
  app.post('/auth/admin/users/:username/disable', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const actor = req.user!;
    if (req.params.username.toLowerCase() === actor.username.toLowerCase()) {
      res.status(400).json({ message: 'No puedes deshabilitarte a ti mismo' });
      return;
    }
    const u = await updateUser(req.params.username, { disabled: true });
    if (!u) { res.status(404).json({ message: 'No existe' }); return; }
    audit('user_disabled', { by: actor.username, username: req.params.username });
    res.json({ ok: true });
  });

  // ----- Admin: enable -----
  app.post('/auth/admin/users/:username/enable', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const actor = req.user!;
    const u = await updateUser(req.params.username, { disabled: false });
    if (!u) { res.status(404).json({ message: 'No existe' }); return; }
    audit('user_enabled', { by: actor.username, username: req.params.username });
    res.json({ ok: true });
  });

  // ----- Admin: reset password (forces change on next login) -----
  app.post('/auth/admin/users/:username/reset-password', requireAuth, requireAdmin, validateBody(resetPasswordSchema), async (req: Request, res: Response) => {
    const actor = req.user!;
    const { newPassword } = req.body as { newPassword: string };
    if (await isPasswordBreached(newPassword)) {
      audit('password_breached_rejected', { by: actor.username, attempted_for: req.params.username });
      res.status(400).json({
        message: 'Esa contraseña aparece en fugas conocidas (HIBP). Elige otra.',
        code: 'BREACHED',
      });
      return;
    }
    const u = await updateUser(req.params.username, {
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: true,
    });
    if (!u) { res.status(404).json({ message: 'No existe' }); return; }
    audit('admin_password_reset', { by: actor.username, username: req.params.username });
    res.json({ ok: true });
  });

  // ----- Admin: reset TOTP (forces re-enrollment) -----
  app.post('/auth/admin/users/:username/reset-totp', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const actor = req.user!;
    const u = await updateUser(req.params.username, {
      totpSecret: null,
      totpConfirmed: false,
      recoveryCodesHashed: [],
    });
    if (!u) { res.status(404).json({ message: 'No existe' }); return; }
    audit('admin_totp_reset', { by: actor.username, username: req.params.username });
    res.json({ ok: true });
  });
}
