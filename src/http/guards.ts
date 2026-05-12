import type { Request, Response, NextFunction } from 'express';
import { ALLOWED_HOSTS, ALLOWED_ORIGINS } from '../config';

// Defense-in-depth response headers. Caddy sets HSTS / X-Frame / nosniff at
// the edge; we set the strict CSP and friends here so a direct hit on the
// origin (e.g. healthcheck, sidecar) is still hardened.
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Inline-preview routes (/api/object/:bucket/download?inline=1) set their
  // own scoped CSP, so skip the SPA-wide one for that case.
  if (!req.path.startsWith('/api/object/') || req.query.inline !== '1') {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; " +
      "img-src 'self' blob: data:; " +
      "media-src 'self' blob:; " +
      "object-src 'self' blob:; " +
      "frame-src 'self' blob:; " +
      "style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; " +
      "connect-src 'self'; " +
      "base-uri 'none'; " +
      "form-action 'none'; " +
      "frame-ancestors 'none'",
    );
  }
  next();
}

// DNS-rebinding protection. The Host header must match either an exact entry
// in ALLOWED_HOSTS (with port) or the bare hostname (no port).
export function hostAllowlist(req: Request, res: Response, next: NextFunction): void {
  const host = (req.headers.host || '').toLowerCase();
  const bareHost = host.split(':')[0];
  if (!ALLOWED_HOSTS.includes(host) && !ALLOWED_HOSTS.includes(bareHost)) {
    res.status(403).json({
      message: `Host not allowed: ${host}. Set ALLOWED_HOSTS env var to whitelist.`,
    });
    return;
  }
  next();
}

// CSRF defense. Same-origin or non-browser requests have no Origin header and
// pass through. Cross-origin requests must hit either http(s)://${current-host}
// or one of ALLOWED_ORIGINS.
export function originAllowlist(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (!origin) { next(); return; } // same-origin or non-browser
  const selfOrigins = [
    `http://${req.headers.host}`,
    `https://${req.headers.host}`,
  ];
  const allowed = [...selfOrigins, ...ALLOWED_ORIGINS];
  if (!allowed.includes(origin)) {
    res.status(403).json({ message: `Origin not allowed: ${origin}` });
    return;
  }
  next();
}
