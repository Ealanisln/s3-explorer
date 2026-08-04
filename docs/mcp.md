# MCP server

S3 Explorer ships a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server so AI agents (Claude Code, Claude Desktop, or any MCP client) can operate your S3-compatible storage through a running S3 Explorer instance — browse, search, presign, upload, and delete, using the same audited HTTP API and Personal Access Token auth as any other API client.

```
AI agent (MCP client)
   │  stdio
   ▼
s3-explorer-mcp        ← runs on YOUR machine; reads local files for uploads
   │  HTTPS: Authorization: Bearer s3x_... + transient x-s3-* credential headers
   ▼
S3 Explorer instance   ← authn/authz, scopes, rate limits, SSRF guard, audit log
   │
   ▼
Any S3-compatible storage (AWS S3, MinIO, R2, B2, Wasabi, ...)
```

## Prerequisites

1. A running S3 Explorer instance you can reach over HTTP(S).
2. A **Personal Access Token**: log into the web UI → **Mi cuenta** → **Tokens de API** → create a token. The plaintext (`s3x_...`) is shown **once** — copy it then. Pick the scope deliberately:
   - `read` — browse, search, presign. Enough for most agent workflows.
   - `write` — additionally upload and delete.
3. The S3 credentials (endpoint, access key, secret key) of the storage you want the agent to operate. As everywhere in S3 Explorer, these are **never stored server-side** — the MCP server sends them per-request as transient `x-s3-*` headers.

## Setup

The server is part of the `s3-explorer` package (binary `s3-explorer-mcp`, built to `dist/mcp/cli.js`). From a checkout: `npm ci && npm run build`.

### Claude Code

```bash
claude mcp add s3-explorer \
  --env S3X_BASE_URL=https://s3x.example.com \
  --env S3X_API_TOKEN=s3x_... \
  --env S3X_S3_ENDPOINT=https://minio.example.com \
  --env S3X_S3_ACCESS_KEY_ID=AKIA... \
  --env S3X_S3_SECRET_ACCESS_KEY=... \
  -- node /path/to/s3-explorer/dist/mcp/cli.js
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "s3-explorer": {
      "command": "node",
      "args": ["/path/to/s3-explorer/dist/mcp/cli.js"],
      "env": {
        "S3X_BASE_URL": "https://s3x.example.com",
        "S3X_API_TOKEN": "s3x_...",
        "S3X_S3_ENDPOINT": "https://minio.example.com",
        "S3X_S3_ACCESS_KEY_ID": "AKIA...",
        "S3X_S3_SECRET_ACCESS_KEY": "..."
      }
    }
  }
}
```

The server fails fast at startup with a message listing any missing variables. Diagnostics go to stderr; stdout is reserved for the MCP protocol. Token and secret-key values are never logged.

## Configuration (environment variables)

Each `S3X_S3_*` variable maps 1:1 to the transient credential header the S3 Explorer API expects (see `docs/api.md`).

| Variable | Required | Maps to | Description |
|---|---|---|---|
| `S3X_BASE_URL` | yes | — | Base URL of the S3 Explorer instance, e.g. `https://s3x.example.com` |
| `S3X_API_TOKEN` | yes | `Authorization: Bearer` | Personal Access Token (`s3x_...`), `read` or `write` scope |
| `S3X_S3_ACCESS_KEY_ID` | yes | `x-s3-access-key` | S3 access key id |
| `S3X_S3_SECRET_ACCESS_KEY` | yes | `x-s3-secret-key` | S3 secret access key |
| `S3X_S3_ENDPOINT` | no | `x-s3-endpoint` | S3 endpoint URL. Omit for AWS S3 |
| `S3X_S3_REGION` | no | `x-s3-region` | Region (default `us-east-1`) |
| `S3X_S3_SESSION_TOKEN` | no | `x-s3-session-token` | STS session token, if using temporary credentials |
| `S3X_S3_PATH_STYLE` | no | `x-s3-path-style` | `true` (default) or `false`. MinIO and most self-hosted providers need `true` |
| `S3X_MAX_UPLOAD_BYTES` | no | — | Local-file size guard for `upload_file` (default 104857600 = 100 MiB) |

## Tools

| Tool | Scope | Input | Returns |
|---|---|---|---|
| `list_buckets` | read | — | `{buckets: [{name, createdAt}]}` |
| `browse` | read | `bucket`, `prefix?`, `maxKeys?` | Objects + folders (common prefixes) under the prefix, with `truncated` flag |
| `search_files` | read | `bucket`, `query`, `prefix?` | Recursive key-substring + folder-name search, aggregated from the server's NDJSON stream; capped at 200 results with a `truncated` flag |
| `presign_url` | read | `bucket`, `key`, `expiresSeconds?` | Temporary GET URL (`{url, expiresSeconds, capped}`); TTL clamped server-side |
| `upload_file` | **write** | `bucket`, `key`, `localPath` | Uploads a local file from the machine running the MCP server. Overwrites existing keys |
| `delete_object` | **write** | `bucket`, `key`, `purge?` | Default: soft delete (delete marker on versioned buckets, recoverable). `purge: true`: permanently removes **every** version and delete marker of the key — irreversible |

Error results distinguish an invalid/revoked/expired token (fix `S3X_API_TOKEN`) from a read-scope token hitting a write tool (create a `write`-scope token).

## Security notes

- **Least privilege**: use a `read`-scope token unless the agent genuinely needs to upload or delete. You can keep two MCP entries (read-only default, write for special sessions).
- **Credentials stay local**: the S3 access key/secret live only in your MCP client config and travel per-request over HTTPS to your S3 Explorer instance. The server never stores them; the MCP server never logs them.
- **Revocation is instant**: revoke the token in the UI (**Mi cuenta** → **Tokens de API**) and every MCP call fails from that moment.
- **Everything is audited**: token-authenticated calls hit the same audit log and rate limits as the web UI.
- **`purge` and `upload_file` are destructive/overwriting** — on shared buckets, prefer a read token plus manual review of anything the agent proposes to change.
