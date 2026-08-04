#!/usr/bin/env node
// stdio entry point for the S3 Explorer MCP server.
//
// Configuration is environment-only (see docs/mcp.md):
//   S3X_BASE_URL, S3X_API_TOKEN,
//   S3X_S3_ACCESS_KEY_ID, S3X_S3_SECRET_ACCESS_KEY,
//   S3X_S3_ENDPOINT?, S3X_S3_REGION?, S3X_S3_SESSION_TOKEN?, S3X_S3_PATH_STYLE?,
//   S3X_MAX_UPLOAD_BYTES?
//
// All diagnostics go to stderr — stdout belongs to the MCP protocol.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfigFromEnv, ConfigError, type McpConfig } from './config';
import { createMcpServer } from './server';

async function main(): Promise<void> {
  let cfg: McpConfig;
  try {
    cfg = loadConfigFromEnv(process.env);
  } catch (e) {
    // ConfigError messages name variables, never their values — safe to print.
    const message = e instanceof ConfigError ? e.message : String(e);
    console.error(`s3-explorer-mcp: configuration error\n${message}`);
    process.exit(1);
  }

  const server = createMcpServer(cfg);
  await server.connect(new StdioServerTransport());
  console.error(`s3-explorer-mcp: connected (instance: ${cfg.baseUrl})`);
}

main().catch((e: unknown) => {
  console.error('s3-explorer-mcp: fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
