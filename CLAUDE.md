# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Also read **[AGENTS.md](AGENTS.md)** — the canonical contributor guide (setup, commands, conventions, security invariants) — and **[docs/api.md](docs/api.md)** for the full HTTP API surface. This file adds architecture context on top of those; it does not duplicate them.

## Project Purpose

MinIO-like web console for any S3-compatible backend (AWS S3, MinIO, Vultr, Wasabi, B2, R2, Spaces). Each user supplies their own S3 endpoints/credentials; the server itself stores no S3 keys — only user accounts.

Deployed as a two-container compose stack (Node app + Caddy reverse proxy).

## Stack

- **Backend:** Node.js 20, Express 4, **TypeScript** compiled with `tsc -b` to `dist/`. Source lives under `src/` (see Layout). Entry point `src/server.ts`.
- **Frontend:** Plain **TypeScript** SPA (no framework, no bundler) under `public/src/`, compiled to `public/dist/`. Loaded by `public/index.html` via `<script type="module" src="/dist/main.js">`.
- **Storage:** **SQLite** (`better-sqlite3`) at `${DATA_DIR}/app.db` (`/data` in Docker). Schema is migration-driven (`src/db/migrations/`). There is **no** `users.json` — a one-time importer (`src/startup/migrate-users-json.ts`) absorbs a legacy file if present and renames it to `users.json.bak`.
- **Tests:** **vitest** (`tests/unit`, `tests/integration`) with mocked S3 (`aws-sdk-client-mock`).
- **Reverse proxy / TLS:** Caddy (`Caddyfile`) — Let's Encrypt auto or `tls internal` for intranet.

> Note: earlier revisions of this file described a `server.js` / `auth.js` + `users.json` layout with "no build step / no test suite". That is obsolete — the codebase is the TypeScript `src/` tree backed by SQLite, with a vitest suite.

## Commands

```bash
# Local dev (no Docker)
npm install
npm run build          # tsc -b → dist/ + public/dist/
npm start              # node dist/server.js  (listens on 127.0.0.1:4569 by default)
npm run dev            # build + start

# Quality gates (reproduce CI locally)
npm run typecheck      # tsc -b --noEmit
npm test               # vitest run (unit + integration)
npm run test:unit
npm run test:integration
npm run test:coverage

# Full stack
docker compose up -d --build
docker compose logs -f s3-explorer
docker compose down                  # preserves users_data volume
docker compose down -v               # DESTRUCTIVE: wipes app.db + Caddy certs

# Required env (see .env.example)
openssl rand -hex 32                 # SESSION_SECRET
openssl rand -hex 32                 # TOTP_ENCRYPTION_KEY (NEVER rotate after first enrollment)

# Other CI checks
caddy validate --config Caddyfile     # needs DOMAIN env set
hadolint Dockerfile
npm audit --audit-level=high
gitleaks detect --source . --config .gitleaks.toml
```

CI (GitHub Actions, `.github/workflows/ci.yml`) runs typecheck + the vitest suite plus a gitleaks secret scan on every push to `main` and every PR. The commands above reproduce the same gates locally.

> **Deploy/verify loop:** there is no dev-server preview; this app needs real auth + vault + S3. Verify changes by `docker compose up -d --build` and confirming the container reports `Healthy`, plus `npm test`.

## Layout

```
src/
  server.ts            Express app wiring, middleware order, static serving
  config.ts            env parsing + boot warnings
  db/
    connection.ts      better-sqlite3 handle + ensureDbInit()
    migrations.ts      migration runner (schema_version table)
    migrations/        001_init, 002_index, 003_totp_step, ...
  auth/
    routes.ts          /auth/* (login, totp, recovery, account, admin)
    sessions.ts        HMAC cookie sign/verify, jti revocation (SQLite)
    totp.ts            AES-256-GCM secret at rest; checkTotpCode (step-based)
    passwords.ts       argon2id (+ legacy bcrypt verify/upgrade)
    recovery-codes.ts  128-bit codes, bcrypt-hashed
    rate-limit.ts      in-memory attempt limiter
    users-store.ts     prepared statements over the users table
    middleware.ts      requireAuth / requireAdmin / requireTotpEnrolled / requirePasswordCurrent
    audit.ts           JSON-line audit events to stdout
  http/
    guards.ts          security headers, CSP, host/origin allowlists
    errors.ts          wrap() + sanitizeError, never leaks detail to client
    validate.ts        zod body validation
  s3/
    client.ts          buildClient(req) from x-s3-* headers; SSRF endpoint guard
    dual-client.ts     source+dest clients for transfer
    errors.ts          sanitizeError mapping for S3
    routes/            buckets, objects, presign, upload, search
  index/               per-user SQLite file index + FTS5 search
  transfer/            recursive copy/move (lib-storage)
public/src/            frontend SPA (state, panes, objects, connections, vault, util)
tests/                 unit + integration (vitest)
```

## Architecture

```
Browser (SPA in public/, compiled to public/dist/)
   │
   │  cookie session (s3x_session, HMAC-SHA256, jti)
   │  + x-s3-* headers carrying decrypted creds per request
   ▼
Caddy :443 ──► Express :4569
                  │
                  ├─ /auth/*   auth/routes.ts   cookies, TOTP, recovery, admin
                  │            SQLite app.db     argon2id hashes, AES-256-GCM TOTP secrets
                  │
                  └─ /api/*    s3/routes/*       buildClient(req) → @aws-sdk/client-s3
                                                 presign, multipart upload, search, transfer
```

**Credentials never live on the server.** The client encrypts the S3 connection list with AES-256-GCM (PBKDF2 from a user passphrase) and stores it in browser `localStorage`. Each S3 API call from the SPA includes `x-s3-endpoint`, `x-s3-region`, `x-s3-access-key`, `x-s3-secret-key`, `x-s3-session-token`, `x-s3-path-style` headers. The server uses them transiently in `buildClient(req)` (`src/s3/client.ts`) and discards.

**Auth flow:** username + password → pending token (120s) → TOTP code → session cookie. First login forces TOTP enrollment and (for admin-created users) password change. Rate limit 5 attempts / 15 min per username+IP, in-memory.

**TOTP:** secrets AES-256-GCM at rest. A used TOTP timestep cannot be replayed within its validity window — `checkTotpCode` returns the matched absolute step and the verifier rejects any step `<=` the user's stored `last_totp_step` (migration 003).

**Recovery codes:** 128-bit, bcrypt-hashed, single-use (burned). The login verifier accepts both the current 128-bit and the legacy 40-bit format so previously-issued codes keep working.

**Session model:** HMAC-signed cookie carrying `{uid, role, jti, exp}`. Revocation list persisted in SQLite (`revoked_sessions`). Restarting the server does NOT invalidate existing cookies unless `SESSION_SECRET` changes — rotate it to mass-revoke during an incident.

**Versioning policy:** `PUT /api/buckets/:bucket/versioning` only allows `enabled=true`. Suspending is rejected at the API level to prevent accidental data loss.

**Search:** bounded one-shot + an NDJSON streaming endpoint (progress + hits + done frames) with prefix scoping and folder-name matching. A per-user SQLite FTS5 index (`src/index/`) backs fast key search, scoped by `(username, connection_id, bucket)`.

**Object listing with deletions:** `?showDeleted=1` uses `ListObjectVersionsCommand` and dedupes by latest version per key; otherwise plain `ListObjectsV2Command`.

**Two-pane explorer:** the right pane is a DOM clone of the left; per-pane state lives in `PaneState` (`public/src/state.ts`), addressed via a Proxy that redirects pane-scoped reads/writes to the active pane. Features: independent per-pane back/forward history, "open in second pane", FileZilla-style synchronized navigation (anchor-delta), and a close-(×) button on either pane (closing the left migrates the right pane's state into the single view).

## Security model — things to preserve

These are non-obvious invariants. Don't regress them:

- `buildClient(req)` reads S3 creds from headers, never from server state. Never persist `x-s3-*` headers, log them, or set them in cookies.
- `sanitizeError(e)` (`src/s3/errors.ts`, `src/http/errors.ts`) maps known AWS error names to generic Spanish messages; unknown 5xx collapse to `InternalError`. Full detail goes to `console.error` only. Always go through `wrap(fn)`.
- CSP for SPA pages is strict (`script-src 'self'`, no inline). Inline previews (`/api/object/...?inline=1`) force `text/plain` for HTML/SVG/JS/XML to prevent same-origin XSS via blobs.
- Host allowlist (`ALLOWED_HOSTS`) + Origin allowlist (`ALLOWED_ORIGINS`) provide DNS-rebinding and CSRF protection. `hostAllowlist` must run before `originAllowlist`.
- **SSRF:** the endpoint guard (`src/s3/client.ts`) blocks cloud metadata across all IP encodings (link-local `169.254.0.0/16` after canonicalizing decimal/octal/hex/IPv4-mapped-IPv6). Internal/RFC1918 endpoints are allowed by design. `S3_ALLOW_HOSTS` opt-in switches to allowlist mode; `S3_DENY_HOSTS` adds denies.
- **Fail closed in production:** missing `SESSION_SECRET` / `TOTP_ENCRYPTION_KEY` with `NODE_ENV=production` throws at boot (no ephemeral fallback).
- `TRUST_PROXY=1` is required when bound to `0.0.0.0` behind Caddy; Caddy overwrites inbound `X-Forwarded-For`. The server warns at boot if misconfigured.
- `users` table writes go through `updateUser` / `createUser` prepared statements; `updateUser` only touches whitelisted columns (`COLUMN_MAP`) — no mass-assignment.
- Argon2id hash upgrades on legacy bcrypt logins are silent and intentional.
- Container is `read_only: true` with `tmpfs` mounts and `cap_drop: ALL`. Don't introduce features that need writes outside `/data` or `/tmp/s3-explorer-uploads`. Upload tmp files are always unlinked (iterate `req.files` in `finally`).

See `SECURITY.md` for the vulnerability reporting policy, scope, deployment hardening checklist, and accepted trade-offs.

## Conventions

- **Branches:** PR-only workflow. `main` is protected; work on `feat/*`, `fix/*`, `chore/*`, `security/*`, `docs/*` and open a pull request. CI must be green before merge; squash-merge preferred.
- **Migrations:** add a `src/db/migrations/00N_name.ts` exporting `version` + `sql`, register it in `src/db/migrations.ts`. Runs once, atomically. Use `ALTER TABLE ... ADD COLUMN ... DEFAULT` for additive changes (safe on existing rows).
- **UI strings:** Spanish (user-facing errors, modals, audit hints). Code comments mixed Spanish/English.
- **Audit events:** `audit(event, fields)` emits JSON lines to stdout. New auth-relevant or destructive actions should emit an event (`login_ok`, `totp_fail`, `totp_replay_blocked`, `versioning_enabled`, `user_created`, `s3_endpoint_blocked`, etc.). Never log passwords, TOTP secrets, or other users' jtis.
- **No new dependencies without justification.** This is deliberately a thin app.
- **Static assets** are served with `Cache-Control: no-cache` (revalidate via ETag) so new builds land without a hard refresh.
- **Hairpin NAT:** the container can't reach its own public hostname. Server-to-S3 calls in dev should use the provider's real endpoint, not the Caddy-fronted URL.

## Files of note

- `src/server.ts` — Express app, middleware order, static serving, S3 router mounts.
- `src/auth/` — users, sessions, TOTP, recovery codes, admin, rate limiting, audit.
- `src/s3/client.ts` — `buildClient(req)` + SSRF endpoint guard.
- `src/db/migrations/` — schema; bump here for any DB change.
- `public/src/main.ts` — SPA entry: dependency wiring + boot.
- `public/src/state.ts` — pane model (Proxy over `PaneState`).
- `Caddyfile` — two TLS modes (Let's Encrypt vs `tls internal`); see README §3.
- `.env.example` — required env vars with generation commands.
- `.github/workflows/ci.yml` — CI pipeline (typecheck + tests, gitleaks secret scan).
- `SECURITY.md` — security policy + posture.
