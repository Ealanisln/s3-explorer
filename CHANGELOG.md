# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Dependencies refreshed: `pnpm audit` goes from 16 advisories (1 critical,
  9 high) to 0 — notably `proxy-addr` 2.0.8 (IP spoofing via IPv4-mapped
  IPv6), `body-parser`, `multer`, `zod`, `qs` and `@modelcontextprotocol/sdk`.
- Supply-chain policy in `pnpm-workspace.yaml`: 24 h minimum release age,
  no exotic transitive sources, `trustPolicy: no-downgrade`, and lifecycle
  scripts allowed only for `better-sqlite3`.
- CodeQL workflow and a narrower gitleaks allowlist (docs, changelog, tests
  and `.env.example` are scanned again; full history verified clean).
- Removed four polynomial-ReDoS regexes (CodeQL `js/polynomial-redos`) on
  user-controlled input: the `x-s3-endpoint` trailing-slash trim, the
  transfer source-folder name (a 5 MB JSON body could stall the event loop),
  and the MCP base-URL trims. Replaced by linear helpers in
  `src/util/strings.ts`, pinned to the old regex semantics by tests.
- `POST /auth/me/password` is now rate limited on wrong `currentPassword`
  (5 / 15 min per username+IP, audit event `password_change_rate_limited`),
  closing the last credential endpoint without backoff.

### Changed

- Package manager is now pnpm 11 (pinned via `packageManager`, use
  `corepack enable`). `package-lock.json` is replaced by `pnpm-lock.yaml`.
- Node.js 24 in the Docker image and CI (Node 20 reached end of life);
  local development needs Node 22.5+.
- CI runs `pnpm audit --audit-level high` before typecheck and tests.

## [1.4.0] - 2026-08-04

### Added

- Internationalized SPA UI: Spanish + English dictionaries
  (`public/src/i18n/`), auto-detected from `localStorage['s3x-lang']` →
  `navigator.language` (`es*` → Spanish, anything else → English), with a
  manual ES/EN toggle in the sidebar footer next to the theme toggle. Static
  HTML re-translates instantly on switch; dynamically rendered content picks
  up the new language on its next render. Known machine-readable API error
  `code`s (TOKEN_INVALID, TOKEN_SCOPE, TOKEN_LIMIT, NO_SESSION, USER_INVALID,
  TOTP_REQUIRED, PASSWORD_CHANGE_REQUIRED, BREACHED, ALREADY_ENROLLED,
  BAD_CONNECTION_ID) are localized client-side; unknown codes fall back to
  the server-provided message. Backend responses are unchanged.

## [1.3.0] - 2026-08-04

### Added

- MCP (Model Context Protocol) server (`s3-explorer-mcp`, stdio): lets AI
  agents such as Claude Code and Claude Desktop operate any S3-compatible
  storage through the S3 Explorer HTTP API, authenticating with a Personal
  Access Token. Six tools — `list_buckets`, `browse`, `search_files`
  (NDJSON stream aggregated to ≤200 results), `presign_url`, `upload_file`
  (local file, size-guarded), `delete_object` (delete-marker or full purge).
  Configured entirely via `S3X_*` environment variables that mirror the
  per-request `x-s3-*` credential header contract; write tools require a
  `write`-scope token. See `docs/mcp.md`.
- Personal Access Tokens (PATs) for machine/agent API access: `Authorization:
  Bearer s3x_...` on `/api/*` as an alternative to the session cookie, with
  `read` / `write` scopes enforced route-by-route, optional expiry (30/90
  days or never), a cap of 10 active tokens per user, and a "Tokens de API"
  section under "Mi cuenta" (create with one-time display, list, revoke).
  Only the SHA-256 hash of a token is stored; failed token authentications
  are rate limited per IP (10 / 15 min) and audited. Tokens are not accepted
  on `/auth/*` — token and user management remain session-only. Groundwork
  for the upcoming MCP server.

## [1.2.0] - 2026-08-03

First public release. Versions prior to this one were developed in a private
repository; the full pre-release commit history is preserved in this repo.

### Added

- Dual-pane explorer: independent per-pane navigation with back/forward history
  (Alt+←/→), "open in second pane", FileZilla-style synchronized navigation
  (anchor-delta model), and a close button on either pane.
- Uploads with conflict resolution: replace / rename (auto-suffix) / skip,
  including versioned buckets.
- Folder CRUD: create, rename, delete (delete-marker or purge) and restore,
  with DELETED badges on soft-deleted folders and bulk undo.
- Streaming recursive search (NDJSON) with prefix scoping and folder-name
  matching, backed by a per-user SQLite FTS5 key index.
- Object versioning views: previous versions, restore, show deleted objects.
  Suspending bucket versioning is rejected server-side.
- Inline previews for images, video, audio, PDF, and code; presigned share
  links with configurable TTL caps.
- Recursive cross-connection folder transfer with concurrency and safety caps.
- Admin user management UI (create, disable, reset password / TOTP) and a
  JSON-line audit log on stdout.
- Client-side encrypted credential vault (AES-256-GCM, PBKDF2) — S3 keys are
  never stored on the server.
- Collapsible sidebar, editable breadcrumb path, light/dark theming with
  self-hosted webfonts and an SVG line-icon system.

### Security

- Mandatory TOTP two-factor authentication with replay prevention — a used
  code cannot be reused within its validity window.
- argon2id password hashing with transparent upgrade of legacy bcrypt hashes;
  optional Have-I-Been-Pwned breach check for new passwords.
- 128-bit single-use recovery codes, bcrypt-hashed at rest.
- Login and TOTP rate limiting (5 attempts / 15 min per username + IP).
- SSRF hardening for user-supplied S3 endpoints: cloud metadata (IMDS)
  blocking across IP encodings (decimal/octal/hex/IPv4-mapped-IPv6, full
  `169.254.0.0/16`), plus opt-in `S3_ALLOW_HOSTS` allowlist and
  `S3_DENY_HOSTS` denylist.
- Fail-closed boot in production when `SESSION_SECRET` or
  `TOTP_ENCRYPTION_KEY` is missing.
- Strict CSP (no inline scripts), host/origin allowlists, HMAC-signed
  httpOnly cookies with SQLite-persisted revocation, TOTP secrets encrypted
  at rest (AES-256-GCM), hardened read-only container, guaranteed cleanup of
  upload temp files.
- `SECURITY.md` with reporting policy, threat model, and deployment
  hardening checklist.

### Changed

- Backend rewritten in TypeScript (`src/`, `tsc -b`); persistence migrated
  from a JSON file to SQLite with versioned migrations; vitest test suite
  (unit + integration with mocked S3).
- Static assets served with `Cache-Control: no-cache` (ETag revalidation) so
  new builds land without a hard refresh.
