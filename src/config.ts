// Single source for env-driven config. Read once at module load; freeze the
// resulting constants. Routers that own their own env (e.g. multer's
// MAX_UPLOAD_BYTES inside upload.ts) keep reading directly — only cross-cutting
// values live here.

export const HOST = process.env.HOST || '127.0.0.1';
export const PORT = parseInt(process.env.PORT || '4569', 10);

export const ALLOWED_HOSTS: readonly string[] = (
  process.env.ALLOWED_HOSTS ||
  `localhost:${PORT},127.0.0.1:${PORT},localhost,127.0.0.1,[::1]:${PORT},[::1]`
).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export const ALLOWED_ORIGINS: readonly string[] = (
  process.env.ALLOWED_ORIGINS || ''
).split(',').map((s) => s.trim()).filter(Boolean);

export const TRUST_PROXY = (process.env.TRUST_PROXY || '') === '1';

// SEC2-11: detect TRUST_PROXY misconfig. If we're bound to 0.0.0.0 we're almost
// certainly behind a reverse proxy (Docker network); without trust proxy the
// rate-limit per-IP collapses to "per Caddy container IP" → effectively
// per-username only.
export function warnIfTrustProxyMisconfigured(): void {
  if (HOST === '0.0.0.0' && !TRUST_PROXY) {
    console.warn(
      '[server] WARNING: HOST=0.0.0.0 but TRUST_PROXY is not set. ' +
      'Rate-limit and audit-log IPs will show the proxy IP, not the real client. ' +
      'Set TRUST_PROXY=1 in env if you are behind a reverse proxy (Caddy/nginx).',
    );
  }
}
