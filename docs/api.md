# HTTP API reference

Base URL: `http://127.0.0.1:4569` in dev (behind Caddy on `https://<DOMAIN>` in the Compose stack). All request/response bodies are JSON unless noted. User-facing `message` strings are Spanish.

## Auth model

- **Session**: HMAC-signed httpOnly cookie `s3x_session` issued after login + TOTP. Two-step flow: `POST /auth/login` (password) → short-lived `s3x_pending` cookie (120 s) → `POST /auth/totp` (6-digit code or a recovery code) → session cookie.
- **All `/api/*` routes require an authenticated session** and additionally reject users who have not enrolled TOTP (`403 TOTP_REQUIRED`) or still have an admin-issued initial password (`403 PASSWORD_CHANGE_REQUIRED`). Enforced in `src/server.ts` via `apiAuth` (session chain: `requireAuth` → `requireTotpEnrolled` → `requirePasswordCurrent`).
- **Personal Access Tokens (Bearer)**: `/api/*` alternatively accepts `Authorization: Bearer s3x_...` for machine/agent access — see below.
- **S3 credentials are per-request headers**, never stored server-side. Every `/api/*` call that touches S3 must include: `x-s3-endpoint`, `x-s3-region`, `x-s3-access-key`, `x-s3-secret-key`, optional `x-s3-session-token`, `x-s3-path-style` (default `true`). Endpoints are validated against an SSRF guard (cloud metadata hosts blocked). The `/api/index/*` routes require an `x-s3-conn-id` header (UUID minted by the client per connection).
- Requests must pass Host and Origin allowlists (`ALLOWED_HOSTS` / `ALLOWED_ORIGINS`).

`GET /healthz` is the only unauthenticated health probe (`{"ok":true}`).

### Authentication with Personal Access Tokens (Bearer)

For machine/agent access (scripts, CI, MCP servers), `/api/*` accepts a Personal Access Token instead of a session cookie:

```
Authorization: Bearer s3x_<43 base64url chars>
```

- **Format**: `s3x_` + 43 base64url chars (32 random bytes). The plaintext is shown **exactly once** at creation; only its SHA-256 hash is stored server-side.
- **Token auth replaces the session chain** — no cookie, TOTP, or password-rotation gate applies to a valid token. Tokens are rejected if revoked, expired, or if their owner no longer exists or is disabled (`401 TOKEN_INVALID`).
- **Scopes**:
  - `read` — browsing/inspection only: bucket list, object list/metadata, download, previews, presign, exists-check, search (stream + one-shot + FTS5 index read), versions list, connection probe (`POST /api/test`).
  - `write` — implies read, plus mutations: upload, delete/restore (object + folder), folder create, copy/rename, transfer, index rebuild/drop, bucket create/delete, versioning changes.
  - A `read` token hitting a write endpoint gets `403 TOKEN_SCOPE` (distinct from `401`). Session users are unaffected by scopes (full access).
- **Rate limiting**: failed token presentations are limited to 10 / 15 min per IP → `429`.
- **Tokens are NOT accepted on `/auth/*`** — token management and user management remain session-only.
- **S3 credentials still travel per-request** via `x-s3-*` headers on every call. A token only authenticates *who* is calling; it never grants access to stored S3 credentials, because none are stored server-side.

```bash
# List objects with a PAT (no cookies involved)
curl 'http://127.0.0.1:4569/api/objects/my-bucket?prefix=reports/' \
  -H 'Authorization: Bearer s3x_...' \
  -H 'x-s3-endpoint: https://s3.us-east-1.amazonaws.com' \
  -H 'x-s3-region: us-east-1' \
  -H 'x-s3-access-key: AKIA...' -H 'x-s3-secret-key: ...'
```

#### Token management (session-auth only, `/auth/tokens`)

| Method | Path | Description |
|---|---|---|
| GET | `/auth/tokens` | List own tokens: `{id, name, scope, createdAt, expiresAt, lastUsedAt, revokedAt}`. Never returns hashes or plaintext. |
| POST | `/auth/tokens` | Body `{name, scope: "read"\|"write", expiresInDays?: 30\|90\|null}`. Returns the plaintext `token` **once**. Cap: 10 active tokens per user → `409 TOKEN_LIMIT`. |
| DELETE | `/auth/tokens/:id` | Revoke own token (soft, immediate). Idempotent; `404` if the id belongs to another user. |

## Auth endpoints (`/auth/*`)

| Method | Path | Description |
|---|---|---|
| GET | `/auth/me` | Session info: `{authenticated, username, role, totpEnrolled, mustChangePassword}`. Never 401s. |
| POST | `/auth/login` | Body `{username, password}`. Returns `{step: "totp"}` (sets `s3x_pending`) or `{step: "enroll_totp"}` (full session, TOTP not yet enrolled). Rate limited: 5 attempts / 15 min per username+IP → `429`. |
| POST | `/auth/totp` | Body `{code}` — 6-digit TOTP or a recovery code (recovery codes are single-use). Sets `s3x_session`. A TOTP code's timestep cannot be replayed. Rate limited like login. |
| POST | `/auth/logout` | Revokes the session (jti persisted in SQLite) and clears the cookie. |
| POST | `/auth/totp/setup` | Auth required. Starts (or resumes) enrollment; returns `{otpauth, qrSvg, secret}`. `409 ALREADY_ENROLLED` if confirmed; `?regenerate=1` forces a new secret. |
| POST | `/auth/totp/confirm` | Auth required. Body `{code}`. Confirms enrollment; returns `{ok, recoveryCodes}` (8 codes, shown once). |
| POST | `/auth/me/password` | Auth required. Body `{currentPassword, newPassword}`. New passwords are checked against HIBP (`400 BREACHED`). Wrong `currentPassword` attempts are rate limited: 5 / 15 min per username+IP → `429`. |
| POST | `/auth/me/recovery` | Auth + TOTP required. Regenerates and returns 8 recovery codes (invalidates old ones). |

### Admin (`role: "admin"` required)

| Method | Path | Description |
|---|---|---|
| GET | `/auth/admin/users` | List users with status fields. |
| POST | `/auth/admin/users` | Body `{username, password, role?}`. New users get `mustChangePassword: true`. `409` on duplicate. |
| POST | `/auth/admin/users/:username/disable` | Disable account (cannot disable yourself). |
| POST | `/auth/admin/users/:username/enable` | Re-enable account. |
| POST | `/auth/admin/users/:username/reset-password` | Body `{newPassword}`; forces change on next login. |
| POST | `/auth/admin/users/:username/reset-totp` | Clears TOTP secret and recovery codes; forces re-enrollment. |

## S3 proxy endpoints (`/api/*`)

### Buckets

| Method | Path | Description |
|---|---|---|
| POST | `/api/test` | Connection probe. With body `{bucket}` runs HeadBucket; without, ListBuckets and returns the count. |
| GET | `/api/buckets` | List buckets. |
| POST | `/api/buckets` | Body `{name}`. Create bucket. |
| DELETE | `/api/buckets/:bucket` | Delete bucket. |
| GET | `/api/buckets/:bucket/versioning` | Returns `{status}` (`Enabled` / `Suspended` / `Disabled`). |
| PUT | `/api/buckets/:bucket/versioning` | Body `{enabled: true}` — **enable only**; suspending is rejected at the schema level to prevent data loss. |

### Objects and folders

| Method | Path | Description |
|---|---|---|
| GET | `/api/objects/:bucket` | Folder listing. Query: `prefix`, `showDeleted=1`, `pageCap` (default 50), `max` (default 50000). With `showDeleted=1` it lists object versions, dedupes to the latest per key (delete markers surface as tombstones) and computes `deletedPrefixes` (folders whose every key is deleted). |
| POST | `/api/objects/:bucket/exists` | Body `{keys: string[]}` (max 100). Pre-upload conflict check; per-key HeadObject, fails open to `exists: false`. |
| GET | `/api/object/:bucket/head` | Query `key`, optional `versionId`. Object metadata. |
| GET | `/api/object/:bucket/versions` | Query `key`. All versions + delete markers, newest first. |
| POST | `/api/object/:bucket/restore` | Body `{key, versionId?}`. Deletes a delete marker, restoring the prior version. |
| DELETE | `/api/object/:bucket` | Body `{key, versionId?}`. Delete one object (creates a delete marker on versioned buckets; with `versionId`, deletes that version permanently). |
| POST | `/api/object/:bucket/delete-batch` | Body `{keys: (string \| {key, versionId?})[]}`. Batch delete; returns `{deleted, errors}`. |
| POST | `/api/object/:bucket/copy` | Body `{sourceKey, destKey, sourceVersionId?}`. Server-side copy within the bucket. |
| POST | `/api/object/:bucket/rename` | Body `{sourceKey, destKey}`. Copy + delete source. |
| POST | `/api/object/:bucket/folder` | Body `{prefix?, name}`. Creates an empty `<prefix><name>/` marker object. |
| GET | `/api/object/:bucket/folder/count` | Query `prefix` (must end in `/`). Returns `{count, totalBytes, truncated}` — capped at 5 pages (~5000 keys). |
| POST | `/api/object/:bucket/folder/delete` | **SSE stream.** Body `{prefix, purgeVersions?}`. Recursive delete in batches of 1000. Default creates delete markers (recoverable); `purgeVersions: true` permanently removes every version and marker. Frames: `progress`, `done`, `fatal`. Root prefix rejected. |
| POST | `/api/object/:bucket/folder/restore` | **SSE stream.** Body `{prefix}`. Removes delete markers whose version is the latest for a key — the inverse of a marker-mode folder delete. No-op on unversioned buckets. |

### Upload, download, presign

| Method | Path | Description |
|---|---|---|
| POST | `/api/object/:bucket/upload` | `multipart/form-data`: `files` (max 10 per request, `MAX_UPLOAD_BYTES` per file) + `prefix` field. Streams to S3 via multipart upload (8 MB parts). Uploads overwrite existing keys — the replace/rename/skip conflict flow is driven client-side using `/api/objects/:bucket/exists`. |
| GET | `/api/object/:bucket/download` | Query `key`, optional `versionId`, `inline=1`. Streams the object. With `inline=1`, script-bearing content types (HTML/SVG/XML/JS) are rewritten to `text/plain` and a strict CSP is attached (stored-XSS defense). |
| GET | `/api/object/:bucket/presign` | Query `key`, optional `versionId`, `expires` (seconds). Returns `{url, expires, capped}`. TTL clamped to `[60, MAX_PRESIGN_SECONDS]` (default cap 24 h, default TTL 5 min). |

### Search

| Method | Path | Description |
|---|---|---|
| GET | `/api/search-stream/:bucket` | **NDJSON stream.** Query `q` (required), `prefix`, `limit` (default 2000, max 10000). Two concurrent walks: recursive key-substring match plus folder-name match. Frames: `hit`, `folder-hit`, `progress`, `done`, `error`. |
| GET | `/api/search/:bucket` | Bounded one-shot search. Query `q`, `prefix`, `limit` (max 2000), `scan` (max 200000). Returns `{results, scanned, truncated}`. |

### Search index (FTS5) — requires `x-s3-conn-id` header

| Method | Path | Description |
|---|---|---|
| POST | `/api/index/:bucket/rebuild` | Rebuild the per-user key index by walking the bucket. |
| GET | `/api/index/:bucket/search` | Query `q`, `limit` (max 5000), `prefix`. Pure SQLite FTS5 read, no S3 call. |
| GET | `/api/index/:bucket/status` | `{last_indexed_at, object_count, last_error, stale}` — used to pick FTS5 vs stream search. |
| DELETE | `/api/index/:bucket` | Drop the index rows for this connection+bucket. Idempotent. |

### Transfer

| Method | Path | Description |
|---|---|---|
| POST | `/api/transfer` | **SSE stream.** Copy/move between two S3 locations, each with its own header set (`x-s3-source-*` and `x-s3-dest-*`). Body `{sourceBucket, destBucket, mode: "copy"\|"move"}` plus either `items` (explicit key list, max 1000) or `prefix: {source, dest, flatten?}` for recursive transfers. Same-connection transfers use server-side CopyObject; cross-connection streams bytes through the server. Recursive self-nesting (dest inside source) is rejected with `400 InvalidTransfer`. |

## Examples

```bash
# Login (step 1 + step 2), keeping cookies
curl -c jar -X POST http://127.0.0.1:4569/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"..."}'
curl -b jar -c jar -X POST http://127.0.0.1:4569/auth/totp \
  -H 'Content-Type: application/json' -d '{"code":"123456"}'

# List objects under a prefix
curl -b jar 'http://127.0.0.1:4569/api/objects/my-bucket?prefix=reports/' \
  -H 'x-s3-endpoint: https://s3.us-east-1.amazonaws.com' \
  -H 'x-s3-region: us-east-1' \
  -H 'x-s3-access-key: AKIA...' -H 'x-s3-secret-key: ...'

# Presigned link (1 hour)
curl -b jar 'http://127.0.0.1:4569/api/object/my-bucket/presign?key=reports/q1.pdf&expires=3600' \
  -H 'x-s3-endpoint: https://s3.us-east-1.amazonaws.com' \
  -H 'x-s3-region: us-east-1' \
  -H 'x-s3-access-key: AKIA...' -H 'x-s3-secret-key: ...'
```

## Errors

S3-facing endpoints return a consistent sanitized shape (`src/http/errors.ts`, `src/s3/errors.ts`):

```json
{ "error": "AccessDenied", "message": "Acceso denegado. ...", "errorId": "err-1a2b3c4d" }
```

- `error` is a known AWS error name (e.g. `NoSuchBucket`, `InvalidAccessKeyId`, `EndpointBlocked`) or `InternalError` for unknown 5xx. Raw SDK messages never reach the client; full detail is logged server-side under the same `errorId`.
- Auth endpoints return `{message, code?}` with codes such as `NO_SESSION`, `TOTP_REQUIRED`, `PASSWORD_CHANGE_REQUIRED`, `ALREADY_ENROLLED`, `BREACHED`, `TOKEN_INVALID`, `TOKEN_SCOPE`, `TOKEN_LIMIT`.
- Streaming endpoints (SSE/NDJSON) report failures as in-stream frames (`{"t":"fatal",...}` / `{"t":"error",...}`) once headers are sent; client/credential errors detected before streaming return normal JSON status codes.
