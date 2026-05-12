import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from './sessions';
import { findUser } from './users-store';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies && req.cookies.s3x_session;
  const payload = verifyToken(token);
  if (!payload) { res.status(401).json({ message: 'Not authenticated', code: 'NO_SESSION' }); return; }
  const user = findUser(payload.uid);
  if (!user || user.disabled) {
    res.status(401).json({ message: 'User invalid or disabled', code: 'USER_INVALID' });
    return;
  }
  req.session = payload;
  req.user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ message: 'Admin only' });
    return;
  }
  next();
}

export function requireTotpEnrolled(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !req.user.totpSecret || !req.user.totpConfirmed) {
    res.status(403).json({ message: 'TOTP enrollment required', code: 'TOTP_REQUIRED' });
    return;
  }
  next();
}

// Block /api/* until the user has rotated the admin-issued initial password.
// The SPA already nags via a modal, but a client that ignores the modal would
// otherwise retain full API access with credentials the admin still knows.
export function requirePasswordCurrent(req: Request, res: Response, next: NextFunction): void {
  if (req.user && req.user.mustChangePassword) {
    res.status(403).json({
      message: 'Debes cambiar la contraseña inicial antes de usar la API.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
    return;
  }
  next();
}
