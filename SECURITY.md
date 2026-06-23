# Security Policy

## Reporting a vulnerability

**Please do not open public issues for security vulnerabilities.**

Report privately through one of:

- GitHub: **Security → Report a vulnerability** (private security advisory) — preferred.
- Email: `security@CHANGE-ME.example` *(maintainers: replace with a monitored address before publishing).*

Please include: affected version/commit, a description, reproduction steps or a
proof of concept, and the impact you believe it has. We aim to acknowledge
reports within a few business days and to ship a fix or mitigation as fast as
the severity warrants. We'll credit reporters who want it.

This is a self-hosted application: there is no central service to patch on your
behalf. Once a fix is released, **operators must update their own deployment.**

## Supported versions

Security fixes target the `main` branch and the latest release. Older tags are
not maintained.

## Security model — what protects you

The non-obvious invariants this project depends on. If you contribute, do not
regress them.

### Credentials never live on the server
Each user supplies their own S3 endpoint + keys. The browser encrypts the
connection list (AES-256-GCM, PBKDF2 from a user passphrase) and stores it in
`localStorage`. S3 credentials reach the server only as per-request `x-s3-*`
headers, are used transiently in `buildClient(req)`, and are discarded. They are
**never** persisted, logged, set in cookies, or echoed back in responses/errors.

### Authentication
- Passwords: **argon2id** (OWASP parameters). Legacy bcrypt hashes are verified
  and transparently upgraded on next login.
- Two-factor: **TOTP** (mandatory enrollment on first login). A used TOTP
  timestep cannot be replayed within its validity window (monotonic step
  enforcement, `last_totp_step`).
- Recovery codes: **128 bits** of entropy, bcrypt-hashed, single-use (burned on
  use). Codes issued before the entropy bump still validate.
- Sessions: HMAC-SHA256 signed cookie (`httpOnly`, `Secure`, `SameSite=strict`),
  timing-safe verification, `jti` revocation list persisted in SQLite.
- Rate limiting: 5 attempts / 15 min per username + IP on login and TOTP.
- TOTP secrets at rest: **AES-256-GCM**.

### Transport & headers
- Caddy terminates TLS; the app is not published directly (only reachable behind
  the proxy).
- Strict CSP (`script-src 'self'`, no inline). `X-Frame-Options: DENY`, `nosniff`,
  HSTS, COOP/CORP. Inline object previews force `text/plain` for active types
  (HTML/SVG/JS/XML) to prevent stored XSS via uploaded blobs.
- Host + Origin allowlists provide DNS-rebinding and CSRF protection.

### SSRF
The user-supplied S3 endpoint is validated: cloud metadata endpoints
(`169.254.0.0/16` link-local incl. IMDS in any IP encoding, plus the named GCP/
Azure hosts) are blocked. Internal/RFC1918 endpoints are **allowed by design**
(MinIO, Docker hostnames). For a locked-down deployment, set `S3_ALLOW_HOSTS` to
an explicit allowlist (see below).

### Data integrity & supply chain
- Container images pinned by digest; non-root user; `read_only` rootfs,
  `cap_drop: ALL`, `no-new-privileges`, tmpfs with size caps.
- CI gates every change on **gitleaks** (secret scan), **Trivy**, and
  `npm audit --audit-level=high`.

## Deployment hardening checklist

Before exposing this to anything, confirm:

- [ ] `SESSION_SECRET` and `TOTP_ENCRYPTION_KEY` are set to strong random values
      (`openssl rand -hex 32`). **In production the app refuses to start without
      them** — it will not silently fall back to an ephemeral key.
- [ ] `TOTP_ENCRYPTION_KEY` is backed up and **never rotated** after the first
      enrollment (rotating it makes existing TOTP secrets undecryptable).
- [ ] `NODE_ENV=production`.
- [ ] The app port is **not** published to the host — only Caddy is.
- [ ] `TRUST_PROXY=1` when behind the proxy (so rate-limit / audit IPs are real),
      and Caddy overwrites inbound `X-Forwarded-For`.
- [ ] TLS is real (Let's Encrypt) or `tls internal` with the CA installed.
- [ ] `BLOCK_METADATA_ENDPOINTS=1` (default). Consider `S3_ALLOW_HOSTS` if your
      set of S3 endpoints is fixed and known.
- [ ] The `/data` volume (SQLite DB with password hashes + encrypted TOTP
      secrets) is backed up and access-controlled. Shred any `users.json.bak`
      left from a legacy migration once you've verified the DB.

## OWASP Top 10 (2021) posture

| Category | Status |
| --- | --- |
| A01 Broken Access Control | Auth + role gate on all `/api`; user-scoped data, no IDOR |
| A02 Cryptographic Failures | argon2id, AES-256-GCM, HMAC sessions; client-side creds |
| A03 Injection | Prepared statements; strict CSP; consistent HTML escaping |
| A04 Insecure Design | Creds-never-on-server; versioning-suspend blocked; input caps |
| A05 Security Misconfiguration | Hardened container; security headers; generic error mapping |
| A06 Vulnerable Components | `npm audit` clean; Renovate; CI scanning |
| A07 Auth Failures | TOTP + replay prevention; rate limiting; session revocation |
| A08 Integrity Failures | Digest-pinned images; gitleaks + Trivy in CI |
| A09 Logging Failures | Audit events; secrets never logged |
| A10 SSRF | Metadata blocked (encoding-resistant); optional allowlist |

## Known, accepted trade-offs

These are deliberate decisions for the project's threat model (self-hosted, small
teams). They are documented rather than "fixed":

- **Rate-limit state is in-memory.** It resets on restart and is not shared
  across replicas. Acceptable for a single-instance deployment; if you run
  multiple replicas, put a shared limiter (e.g. Redis) in front.
- **Authenticated SSRF to internal hosts is allowed by design.** Any logged-in
  user can point an S3 endpoint at an internal address (the multi-provider use
  case needs this). Cloud metadata is blocked; use `S3_ALLOW_HOSTS` to fully
  lock it down.
- **Sessions survive server restart** unless `SESSION_SECRET` is rotated. To
  mass-revoke during an incident, rotate `SESSION_SECRET`.
