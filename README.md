# S3 Explorer

**A MinIO-like web console for any S3-compatible storage.**

Self-hosted, multi-user file explorer for object storage. Each user brings their own S3 endpoints and credentials — the server never stores S3 keys. Built with Node.js + TypeScript + Express, a dependency-light vanilla TypeScript SPA, and SQLite. Ships as a two-container Docker Compose stack (app + Caddy with automatic TLS).

[![CI](https://github.com/Ealanisln/s3-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/Ealanisln/s3-explorer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Ealanisln/s3-explorer)](https://github.com/Ealanisln/s3-explorer/releases)

## Features

**Explorer**

- **Multi-connection** — each user defines their own endpoints and credentials, and can connect to several providers at once.
- **Client-side encrypted vault** — S3 credentials are encrypted in the browser with AES-256-GCM (key derived via PBKDF2, 250k iterations, from a user passphrase) and stored in `localStorage`. Credentials reach the server only as transient per-request headers and are never persisted or logged.
- **Dual-pane explorer** — independent navigation per pane, per-pane back/forward history (Alt+←/→), "open in second pane", FileZilla-style synchronized navigation, and the ability to close either pane.
- **Transfers between connections** — recursive copy/move of folders across buckets and even across different providers, with concurrency and safety caps.
- **Uploads with conflict resolution** — replace / rename (auto-suffix) / skip when the file already exists.
- **Folder CRUD** — create, rename, delete (delete-marker or purge) and restore; deleted folders are flagged with a badge.
- **Streaming recursive search** — NDJSON streaming results grouped by folder, scoped to the current prefix, with folder-name matching and a per-user SQLite FTS5 index for fast key search.
- **Object versioning** — browse previous versions, restore, and show deleted objects. Suspending versioning is rejected server-side to prevent accidental data loss.
- **Inline previews** — images, video, audio, PDF, and code.
- **Presigned share links** — temporary signed URLs (5 min / 1 h / 24 h presets, configurable caps).

**Security**

- **TOTP two-factor authentication** — mandatory enrollment on first login (works with Google Authenticator, Authy, 1Password, etc.), with replay prevention: a used TOTP code cannot be reused within its validity window.
- **argon2id password hashing** (legacy bcrypt hashes are verified and transparently upgraded on login) and optional Have-I-Been-Pwned breach checks (k-anonymity) for new passwords.
- **128-bit single-use recovery codes**, bcrypt-hashed at rest.
- **Login rate limiting** — 5 attempts / 15 min per username + IP on both password and TOTP steps.
- **SSRF / cloud-metadata protection** — user-supplied S3 endpoints are validated; IMDS and other cloud metadata endpoints (`169.254.0.0/16` in any IP encoding, GCP/Azure metadata hosts) are blocked by default, with optional endpoint deny/allow lists.
- **Hardened by default** — strict CSP with no inline scripts, host/origin allowlists (CSRF + DNS-rebinding defense), HMAC-signed httpOnly cookies, read-only container with `cap_drop: ALL`, and TOTP secrets encrypted at rest (AES-256-GCM).
- **Admin user management UI** and a JSON-line audit log on stdout.

> **Note:** the UI is currently in Spanish. Internationalization contributions are welcome.

## Works with

Any S3-compatible endpoint, including:

- AWS S3
- MinIO
- Vultr Object Storage
- Cloudflare R2
- Backblaze B2
- Wasabi, DigitalOcean Spaces, and others

## Screenshots

<!-- TODO: add screenshots (login + TOTP enrollment, dual-pane explorer, version browser, search) -->

## Quick start

### Docker Compose (recommended)

Requires Docker with Compose v2, ports 80/443 open, and (for automatic Let's Encrypt) a public DNS name pointing at the host.

```bash
git clone <repo-url> s3-explorer
cd s3-explorer
cp .env.example .env

# Generate the required secrets and paste them into .env:
echo "ADMIN_PASS=$(openssl rand -base64 24 | tr -d '+/=' | head -c 20)"
echo "SESSION_SECRET=$(openssl rand -hex 32)"
echo "TOTP_ENCRYPTION_KEY=$(openssl rand -hex 32)"

# Set DOMAIN (and ADMIN_USER if you want) in .env, then:
docker compose up -d --build
docker compose logs -f s3-explorer
```

Open `https://<your-domain>`, log in with `ADMIN_USER` / `ADMIN_PASS`, enroll TOTP, and save your recovery codes.

TLS modes (see `Caddyfile`):

- **Public domain** — Caddy provisions and renews Let's Encrypt certificates automatically. No extra action.
- **Intranet** — uncomment `tls internal` in the `Caddyfile`; Caddy generates a local CA whose root certificate you distribute to users.

> **Do not rotate `TOTP_ENCRYPTION_KEY` after the first enrollment.** Rotating it makes every enrolled TOTP secret undecryptable; the admin would have to reset TOTP for all users. Keep it in your password manager.

### Plain Node (no Docker)

Requires Node.js 20+.

```bash
npm install
npm run build              # tsc -b → dist/ + public/dist/
SESSION_SECRET=$(openssl rand -hex 32) \
TOTP_ENCRYPTION_KEY=$(openssl rand -hex 32) \
ADMIN_USER=admin ADMIN_PASS=change-me \
DATA_DIR=./data \
npm start                  # listens on http://127.0.0.1:4569
```

Without a reverse proxy in front you should set `SECURE_COOKIE=0` for plain-HTTP local testing only — always run behind HTTPS in production.

## Configuration

All configuration is environment-driven (see `.env.example` for generation commands and extended notes).

| Variable | Default | Description |
|---|---|---|
| `DOMAIN` | — | Public or internal FQDN (required by the Compose stack; used for Caddy TLS and the host/origin allowlists) |
| `ADMIN_USER` | — | Initial admin username (honored only on first boot, while no users exist) |
| `ADMIN_PASS` | — | Initial admin password (change it from the UI after first login) |
| `SESSION_SECRET` | ephemeral random | HMAC-SHA256 key for signing session cookies. **Must be set in production** (the app refuses to start without it when `NODE_ENV=production`). Generate: `openssl rand -hex 32` |
| `TOTP_ENCRYPTION_KEY` | ephemeral random | AES-256-GCM key (64 hex chars) encrypting TOTP secrets at rest. **Must be set in production**; never rotate after enrollment. Generate: `openssl rand -hex 32` |
| `SESSION_TTL_SECONDS` | `14400` (4 h) | Absolute session lifetime from login |
| `MAX_UPLOAD_BYTES` | `524288000` (500 MB) | Per-file upload limit |
| `CHECK_HIBP` | `1` | Check new passwords against Have I Been Pwned (k-anonymity; fails open if unreachable) |
| `ALLOWED_HOSTS` | `localhost:4569,...` | Accepted `Host` headers (DNS-rebinding defense). The Compose stack sets it from `${DOMAIN}` |
| `ALLOWED_ORIGINS` | `https://${DOMAIN}` (compose) | Accepted `Origin` values (CSRF defense) |
| `MAX_PRESIGN_SECONDS` | `86400` (24 h) | Upper cap for presigned-link TTL |
| `DEFAULT_PRESIGN_SECONDS` | `300` (5 min) | Presigned-link TTL when the client does not specify one |
| `DATA_DIR` | `/data` (Docker) | Where the SQLite DB (`app.db`) and per-user search index live. Must be a persistent volume |
| `DB_PATH` | `${DATA_DIR}/app.db` | Override the SQLite database path |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` inside Docker) |
| `PORT` | `4569` | HTTP port |
| `SECURE_COOKIE` | `1` | Set the `Secure` flag on cookies (requires HTTPS) |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy so rate limiting and audit logs see real client IPs |
| `TRANSFER_CONCURRENCY` | `4` | Parallel workers per recursive folder transfer (max 16) |
| `TRANSFER_MAX_PREFIX_ITEMS` | `100000` | Safety cap: refuse to transfer prefixes with more objects than this |
| `BLOCK_METADATA_ENDPOINTS` | `1` | Block cloud metadata endpoints (IMDS, GCP, Azure) as S3 endpoints |
| `S3_DENY_HOSTS` | empty | Extra comma-separated hostnames to deny as S3 endpoints |
| `S3_ALLOW_HOSTS` | empty | Opt-in allowlist: when set, **only** these hostnames are accepted as S3 endpoints (strongest SSRF posture) |

### Minimum IAM permissions (AWS)

Users without `s3:ListAllMyBuckets` can list their buckets explicitly in the connection form. The minimum per-bucket policy is:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "s3:ListBucket", "s3:ListBucketVersions",
      "s3:GetObject", "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:DeleteObject", "s3:DeleteObjectVersion",
      "s3:GetBucketVersioning", "s3:PutBucketVersioning"
    ],
    "Resource": ["arn:aws:s3:::my-bucket", "arn:aws:s3:::my-bucket/*"]
  }]
}
```

## Development

```bash
npm install
npm run build          # tsc -b → dist/ (server) + public/dist/ (SPA)
npm run typecheck      # tsc -b --noEmit
npm test               # vitest run (unit + integration, mocked S3)
npm run test:unit
npm run test:integration
npm run test:coverage
npm run watch          # incremental rebuild
```

Layout: server code in `src/` (Express, better-sqlite3 with versioned migrations, AWS SDK v3), frontend in `public/src/` (framework-less TypeScript SPA, no bundler), tests in `tests/`. See `CLAUDE.md` for an architecture walkthrough and `SECURITY.md` for the security model, deployment hardening checklist, and vulnerability reporting.

CI runs typecheck, the vitest suite, and secret scanning (gitleaks) on every push and pull request.

## License

[MIT](LICENSE) © 2026 Emmanuel Alanis
