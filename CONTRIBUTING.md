# Contributing to S3 Explorer

Thanks for taking the time to contribute. [AGENTS.md](AGENTS.md) is the full contributor guide (layout, conventions, security invariants); this page covers the workflow.

## Before you start

- **Security issues:** never open a public issue. Report privately through GitHub's security advisories (see [SECURITY.md](SECURITY.md)).
- Read the **security invariants** in [AGENTS.md](AGENTS.md#security-invariants--do-not-weaken). PRs that weaken them (SSRF guard, transient S3 credentials, CSP, Host/Origin allowlists, rate limits, supply-chain policy) will not be merged.
- By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Node.js 22.5+ (CI and Docker use 24) and pnpm 11:

```bash
corepack enable        # installs the pnpm version pinned in package.json
pnpm install
pnpm run dev           # build + start on http://127.0.0.1:4569
```

There is no hot-reload dev server: the app needs real auth, the vault and an S3 backend, so functional checks run with `docker compose up -d --build`.

## Workflow

1. Open an issue first for anything beyond a trivial fix.
2. Branch from `main`: `feat/*`, `fix/*`, `security/*`, `docs/*`, `chore/*`.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `security:`, `docs:`, `ci:`, `chore:`). Releases follow Semantic Versioning and Renovate relies on these prefixes.
4. Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
5. Open the PR against `main` describing **what** changes and **why**; attach a screenshot if it touches the UI.

## Checks

CI must be green. Reproduce it locally before pushing:

```bash
pnpm audit --audit-level high
pnpm run typecheck
pnpm test
gitleaks git . --config .gitleaks.toml   # optional locally, always in CI
```

CodeQL also runs on every PR; it is not a required check yet, but new alerts should be triaged in the PR.

## Code expectations

- **TypeScript everywhere**: server in `src/`, SPA in `public/src/`.
- **Tests**: auth, security and route changes need tests — `tests/unit` for pure logic, `tests/integration` (supertest + mocked S3) for endpoints.
- **Dependencies**: the project is deliberately lean; justify any new dependency in the PR. If it has a build script, add it to `allowBuilds` in `pnpm-workspace.yaml` explicitly.
- **Errors and audit**: handlers go through `wrap()` / `sanitizeError()`; security-relevant actions emit `audit(event, fields)`. Never log passwords, TOTP secrets, S3 keys or tokens.
- **UI strings**: add both the `es` and `en` entries in `public/src/i18n/`.

## License

By submitting a pull request you agree that your contribution is released under the project's [MIT License](LICENSE).
