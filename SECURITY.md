# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x (latest release + `main`) | Yes |
| Older tags | No |

Security fixes target the `main` branch and the latest release. This is a
self-hosted application: there is no central service to patch on your behalf —
once a fix is released, **operators must update their own deployment.**

## Reporting a vulnerability

**Please do not open public issues for security vulnerabilities.**

Report privately via **GitHub → Security → Report a vulnerability** (private
security advisory) on this repository.

Include: affected version/commit, a description, reproduction steps or a proof
of concept, and the impact you believe it has.

**Response expectations:** we aim to acknowledge reports within **5 business
days** and to ship a fix or documented mitigation as fast as the severity
warrants (critical issues prioritized). Reporters who want credit will be
credited in the release notes.

## Scope

S3 Explorer proxies **user-supplied S3 credentials**: the browser holds them in
an encrypted local vault and sends them to the server as transient per-request
headers, which the server uses to build an S3 client and then discards.
Anything that breaks that promise is squarely in scope:

- Credential handling — any path that persists, logs, caches, or echoes back
  `x-s3-*` headers or vault contents.
- Authentication and session management — password hashing (argon2id), TOTP
  (including replay), recovery codes, cookie signing/revocation, rate limiting.
- SSRF via the user-supplied S3 endpoint — bypasses of the cloud-metadata
  (IMDS/GCP/Azure) block or of `S3_ALLOW_HOSTS` / `S3_DENY_HOSTS`.
- XSS / CSP bypasses, CSRF, DNS rebinding, and privilege escalation between
  user and admin roles.

Out of scope: vulnerabilities in upstream dependencies with no exploitable
path through this app (report upstream), issues requiring a compromised host
or a deployment that ignores the documented hardening checklist, and
self-attacks against one's own browser vault.

Known, accepted trade-offs (documented by design): in-memory rate-limit state
(single-instance assumption), authenticated SSRF to internal hosts (the
multi-provider use case requires it; use `S3_ALLOW_HOSTS` to lock down), and
sessions surviving restart unless `SESSION_SECRET` is rotated.

## Deployment hardening checklist

- [ ] `SESSION_SECRET` and `TOTP_ENCRYPTION_KEY` set to strong random values
      (`openssl rand -hex 32`); in production the app refuses to start without them.
- [ ] `TOTP_ENCRYPTION_KEY` backed up and **never rotated** after first enrollment.
- [ ] `NODE_ENV=production`; app port not published to the host — only the proxy is.
- [ ] `TRUST_PROXY=1` behind the proxy, with the proxy overwriting `X-Forwarded-For`.
- [ ] Real TLS (Let's Encrypt) or `tls internal` with the CA installed on clients.
- [ ] `BLOCK_METADATA_ENDPOINTS=1` (default); consider `S3_ALLOW_HOSTS` when the
      set of S3 endpoints is fixed.
- [ ] The `/data` volume (SQLite DB with password hashes and encrypted TOTP
      secrets) backed up and access-controlled.
