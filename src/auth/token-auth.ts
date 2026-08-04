// Bearer PAT authentication for /api/* — machine/agent access (MCP prep).
//
// When an `Authorization: Bearer s3x_...` header is present, the request
// authenticates via token INSTEAD of the session cookie chain (requireAuth →
// requireTotpEnrolled → requirePasswordCurrent). A valid token attaches the
// same req.user shape session auth does, plus req.tokenScope so routes can
// enforce read/write scope. /auth/* routes never accept tokens — user and
// token management stay session-only.
import type { Request, Response, NextFunction } from 'express';
import { audit } from './audit';
import { rateLimit, recordFailure } from './rate-limit';
import { findUser } from './users-store';
import {
  TOKEN_REGEX,
  hashToken,
  findTokenByHash,
  isTokenExpired,
  touchLastUsed,
} from './tokens-store';
import { requireAuth, requireTotpEnrolled, requirePasswordCurrent } from './middleware';
import type { TokenScope } from '../types';

// 10 failed token presentations / 15 min per IP. Wider than the 5-attempt
// login limit because agents legitimately retry, but still tight enough to
// make brute-forcing a 256-bit token laughable.
const TOKEN_RL_MAX = 10;
const TOKEN_RL_WINDOW_SEC = 900;

export function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

function rejectToken(req: Request, res: Response, ip: string, reason: string): void {
  recordFailure(`token:${ip}`);
  audit('token_auth_fail', { ip, path: req.path, reason });
  res.status(401).json({ message: 'Token inválido, revocado o expirado', code: 'TOKEN_INVALID' });
}

// Authenticate a request that presented a Bearer token. Never falls through
// to session auth — a request that chose token auth fails closed.
function tokenAuth(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || '';
  const rlKey = `token:${ip}`;
  if (!rateLimit(rlKey, TOKEN_RL_MAX, TOKEN_RL_WINDOW_SEC)) {
    audit('token_rate_limited', { ip, path: req.path });
    res.status(429).json({ message: 'Demasiados intentos. Espera 15 minutos.' });
    return;
  }
  const presented = extractBearerToken(req)!;
  if (!TOKEN_REGEX.test(presented)) {
    rejectToken(req, res, ip, 'malformed');
    return;
  }
  const token = findTokenByHash(hashToken(presented));
  if (!token) { rejectToken(req, res, ip, 'unknown'); return; }
  if (token.revokedAt) { rejectToken(req, res, ip, 'revoked'); return; }
  if (isTokenExpired(token)) { rejectToken(req, res, ip, 'expired'); return; }
  const user = findUser(token.username);
  if (!user || user.disabled) { rejectToken(req, res, ip, 'user_invalid'); return; }
  touchLastUsed(token);
  req.user = user;
  req.tokenScope = token.scope;
  req.apiToken = { id: token.id, name: token.name, scope: token.scope };
  next();
}

// Mounted on /api/*: Bearer `s3x_...` header → token auth; anything else →
// the existing session chain, unchanged.
export function apiAuth(req: Request, res: Response, next: NextFunction): void {
  const bearer = extractBearerToken(req);
  if (bearer !== null && bearer.startsWith('s3x_')) {
    tokenAuth(req, res, next);
    return;
  }
  requireAuth(req, res, () => {
    requireTotpEnrolled(req, res, () => {
      requirePasswordCurrent(req, res, next);
    });
  });
}

// Per-route scope gate for token-authenticated requests. Declared explicitly
// on every mutating route (never inferred from the HTTP method). Session
// users carry no tokenScope and pass untouched; 'write' tokens imply read.
export function requireScope(scope: TokenScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.tokenScope && scope === 'write' && req.tokenScope !== 'write') {
      audit('token_scope_denied', {
        username: req.user && req.user.username,
        tokenId: req.apiToken && req.apiToken.id,
        path: req.path,
      });
      res.status(403).json({
        message: 'Este token no tiene alcance de escritura (scope "write" requerido).',
        code: 'TOKEN_SCOPE',
      });
      return;
    }
    next();
  };
}
