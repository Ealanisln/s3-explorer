// Wires the tool definitions into an McpServer instance. Kept separate from
// cli.ts so tests (and future embeddings) can build a server without touching
// stdio or process-level concerns.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import type { McpConfig } from './config';
import { S3xClient } from './client';
import { buildTools, type ToolDef } from './tools';

// Resolve the package version at runtime (dist/mcp/ → ../../package.json is
// the repo/package root). A JSON import would violate the server tsconfig's
// rootDir, so read it with fs instead.
import * as fs from 'fs';
import * as path from 'path';

function packageVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function register(server: McpServer, def: ToolDef<z.ZodRawShape>): void {
  server.registerTool(
    def.name,
    { description: def.description, inputSchema: def.inputSchema },
    async (args: Record<string, unknown>) => {
      try {
        const result = await def.handler(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
      }
    },
  );
}

export function createMcpServer(cfg: McpConfig): McpServer {
  const server = new McpServer({ name: 's3-explorer-mcp', version: packageVersion() });
  const client = new S3xClient(cfg);
  const tools = buildTools(client, cfg.maxUploadBytes);
  for (const def of Object.values(tools)) {
    register(server, def as unknown as ToolDef<z.ZodRawShape>);
  }
  return server;
}
