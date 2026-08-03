# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
