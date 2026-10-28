# AGENTS.md

Guidance for AI coding agents and human contributors working on S3 Explorer.

## Project overview

S3 Explorer is a self-hosted, multi-user web console for any S3-compatible storage (AWS S3, MinIO, R2, B2, Wasabi, etc.). Node 24 + TypeScript + Express backend, framework-less vanilla TypeScript SPA in `public/`, SQLite (better-sqlite3) for user accounts and the per-user search index. The server never stores S3 credentials — each request carries them in transient `x-s3-*` headers, encrypted client-side at rest.

## Dev environment

```bash
# Node.js 22.5+ (24 in CI/Docker) + pnpm 11 via `corepack enable`
pnpm install
cp .env.example .env      # fill SESSION_SECRET / TOTP_ENCRYPTION_KEY (openssl rand -hex 32)
pnpm run dev               # build (tsc -b) + start on http://127.0.0.1:4569
```

## Build and test commands

```bash
pnpm run build             # tsc -b → dist/ (server) + public/dist/ (SPA)
pnpm run typecheck         # tsc -b --noEmit
pnpm test                  # vitest run (unit + integration, S3 mocked via aws-sdk-client-mock)
pnpm run test:unit         # tests/unit only
pnpm run test:integration  # tests/integration only
pnpm exec vitest run tests/integration/api/objects.test.ts   # single file
```

## Architecture map

- `src/server.ts` — Express wiring; middleware order matters (`securityHeaders` → `hostAllowlist` → `originAllowlist`; all `/api/*` behind `apiAuth`: Bearer PAT (`Authorization: Bearer s3x_...`) or the session chain `requireAuth` + `requireTotpEnrolled` + `requirePasswordCurrent`).
- `src/auth/` — login, sessions (HMAC cookie + SQLite revocation), TOTP, recovery codes, personal access tokens (`tokens-store.ts` + `token-auth.ts`, scoped `read`/`write` via `requireScope` declared route-by-route), rate limiting, admin routes, audit log.
- `src/s3/` — `client.ts` builds a per-request S3Client from `x-s3-*` headers (SSRF guard lives here); `routes/` for buckets, objects, presign, upload, search.
- `src/index/` — per-user SQLite FTS5 key index; `src/transfer/` — SSE-streamed cross-connection copy/move.
- `src/mcp/` — stdio MCP server (`s3-explorer-mcp` bin → `dist/mcp/cli.js`) exposing the HTTP API as agent tools; env-driven config (`S3X_*`), Bearer PAT auth + per-request `x-s3-*` headers. See `docs/mcp.md`.
- `src/http/` — security headers/CSP, `wrap()` + `sanitizeError` error handling, zod validation.
- `src/db/migrations/` — versioned schema; add `00N_name.ts` and register it in `src/db/migrations.ts`.
- `public/src/` — SPA (no framework, no bundler); `public/index.html` loads `/dist/main.js` as an ES module.
- `tests/` — vitest unit + integration; SQLite at `${DATA_DIR}/app.db`.

## Code conventions

- TypeScript `strict: true` across all three tsconfig projects (server, web, test). No transpiler besides `tsc`.
- Frontend is dependency-free vanilla TS — do not introduce a framework or bundler.
- Backend deps are deliberately minimal — no new dependencies without justification.
- API error messages are Spanish (plus a machine-readable `code`); code comments are mixed Spanish/English.
- The SPA UI is bilingual (Spanish/English) via `public/src/i18n/`. New UI strings MUST go through the i18n dictionaries (`es.ts` + `en.ts`, then `t('key')` or `data-i18n` attributes) — never hardcoded in TS or HTML. The `MsgKey` type makes a missing `en` entry a compile error.
- Async route handlers go through `wrap()` from `src/http/errors.ts` so errors are sanitized and correlated with an `errorId`.
- Auth-relevant or destructive actions emit `audit(event, fields)` JSON lines to stdout. Never log passwords, TOTP secrets, or `x-s3-*` header values.

## Security invariants — do not weaken

- **SSRF / IMDS blocking** (`src/s3/client.ts`): user-supplied endpoints are validated; cloud metadata hosts and `169.254.0.0/16` are blocked across all IP encodings (decimal/octal/hex/IPv4-mapped-IPv6). `S3_ALLOW_HOSTS` / `S3_DENY_HOSTS` refine this. Keep the guard on every code path that builds a client (including `dual-client.ts`).
- **Credentials are transient** — `buildClient(req)` reads S3 creds from headers only. Never persist, log, or cookie them.
- **Rate limiting** (`src/auth/rate-limit.ts`): 5 attempts / 15 min per username+IP on the password and TOTP steps and on `currentPassword` in `POST /auth/me/password`; 10 failed Bearer-token presentations / 15 min per IP (`src/auth/token-auth.ts`).
- **PAT plaintext is never stored** (`src/auth/tokens-store.ts`): only the SHA-256 hash of a personal access token is persisted; the plaintext is returned once at creation. Tokens are never accepted on `/auth/*` routes.
- **argon2id hashing** (`src/auth/passwords.ts`) with silent upgrade of legacy bcrypt hashes on login; constant-time behavior via a sentinel hash for unknown users.
- **TOTP replay prevention** (`src/auth/totp.ts`, `src/auth/routes.ts`): a verified code's timestep is burned (`lastTotpStep`); any step `<=` the stored one is rejected — including the enrollment confirmation code.
- **Fail-closed boot**: with `NODE_ENV=production`, missing `SESSION_SECRET` (`src/auth/sessions.ts`) or `TOTP_ENCRYPTION_KEY` (`src/auth/totp.ts`) throws at startup.
- **Error sanitization** (`src/http/errors.ts`, `src/s3/errors.ts`): clients get generic messages + `errorId`; full detail goes to server logs only.
- **Inline preview XSS defense** (`src/s3/routes/presign.ts`): HTML/SVG/XML/JS content types are rewritten to `text/plain` when served with `?inline=1`.
- **Versioning suspend is rejected** at the schema level (`PUT /api/buckets/:bucket/versioning` accepts `enabled: true` only).
- `hostAllowlist` must run before `originAllowlist`; both must stay mounted before routes.
- **No ReDoS-prone regexes on user input**: trim/split paths with the linear helpers in `src/util/strings.ts`, not `/\/+$/`-style patterns (CodeQL `js/polynomial-redos`).
- **Supply-chain policy** (`pnpm-workspace.yaml`): `minimumReleaseAge: 1440`, `blockExoticSubdeps`, `trustPolicy: no-downgrade`, and lifecycle scripts only for packages listed in `allowBuilds`. A new dependency with a build script needs an explicit `allowBuilds` entry; never relax the policy to make an install pass — investigate the flagged package first.

## Testing expectations

Before opening a PR, run `pnpm run typecheck` and `pnpm test` locally — CI (GitHub Actions) runs `pnpm audit --audit-level high`, typecheck and the vitest suite, plus a gitleaks secret scan over full history and CodeQL. New endpoints or auth behavior need integration tests under `tests/integration/`; the existing suites there are the executable spec of the API surface.

## PR guidelines

- Conventional commits, as seen in history: `feat(scope): ...`, `fix: ...`, `security: ...`, `docs: ...`, `ci: ...`, `chore: ...`.
- PR-only workflow: `main` is protected; branch as `feat/*`, `fix/*`, `chore/*`, `security/*`, `docs/*`. CI must be green; squash-merge preferred.
- See `docs/api.md` for the HTTP API reference and `SECURITY.md` for the security policy and accepted trade-offs.
