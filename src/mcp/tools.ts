// MCP tool definitions: zod input schemas + handlers that call the S3 Explorer
// HTTP API through S3xClient. Handlers return plain JSON-serializable objects
// and throw Error/S3xApiError on failure; src/mcp/server.ts adapts both into
// MCP CallToolResult shapes. Tests exercise the handlers directly.
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as mime from 'mime-types';
import { S3xClient, seg } from './client';
import { aggregateSearchNdjson, type SearchAggregate } from './ndjson';

// Bounded result set for search_files — large enough to be useful, small
// enough to not blow up an agent's context window.
export const SEARCH_RESULT_CAP = 200;

export interface ToolDef<Shape extends z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: (args: z.output<z.ZodObject<Shape>>) => Promise<unknown>;
}

function tool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

// ---------- server response shapes (subset of docs/api.md) ----------

interface BucketsResponse {
  buckets: Array<{ Name?: string; CreationDate?: string }>;
}

interface ObjectsResponse {
  prefixes: string[];
  objects: Array<{ Key: string; Size: number; LastModified?: string; ETag?: string }>;
  isTruncated: boolean;
}

interface PresignResponse {
  url: string;
  expires: number;
  capped: boolean;
}

interface UploadResponse {
  ok: boolean;
  uploaded: Array<{ key: string; size: number }>;
}

interface VersionsResponse {
  versions: Array<{ VersionId?: string; IsLatest?: boolean; Type: 'version' | 'delete-marker' }>;
}

interface DeleteBatchResponse {
  deleted: Array<{ Key?: string; VersionId?: string }>;
  errors: Array<{ Key?: string; Code?: string; Message?: string }>;
}

export interface McpToolset {
  list_buckets: ToolDef<Record<string, never>>;
  browse: ToolDef<{
    bucket: z.ZodString;
    prefix: z.ZodOptional<z.ZodString>;
    maxKeys: z.ZodOptional<z.ZodNumber>;
  }>;
  search_files: ToolDef<{
    bucket: z.ZodString;
    query: z.ZodString;
    prefix: z.ZodOptional<z.ZodString>;
  }>;
  presign_url: ToolDef<{
    bucket: z.ZodString;
    key: z.ZodString;
    expiresSeconds: z.ZodOptional<z.ZodNumber>;
  }>;
  upload_file: ToolDef<{
    bucket: z.ZodString;
    key: z.ZodString;
    localPath: z.ZodString;
  }>;
  delete_object: ToolDef<{
    bucket: z.ZodString;
    key: z.ZodString;
    purge: z.ZodOptional<z.ZodBoolean>;
  }>;
}

export function buildTools(client: S3xClient, maxUploadBytes: number): McpToolset {
  return {
    list_buckets: tool({
      name: 'list_buckets',
      description: 'List every bucket visible to the configured S3 credentials.',
      inputSchema: {},
      handler: async () => {
        const out = await client.requestJson<BucketsResponse>('GET', '/api/buckets');
        return {
          buckets: (out.buckets ?? []).map((b) => ({ name: b.Name, createdAt: b.CreationDate })),
        };
      },
    }),

    browse: tool({
      name: 'browse',
      description:
        'List objects and folders (common prefixes) under a prefix in a bucket, like a directory listing. ' +
        'Folders end with "/". Use the returned prefixes to navigate deeper.',
      inputSchema: {
        bucket: z.string().min(1).describe('Bucket name'),
        prefix: z.string().optional().describe('Key prefix to list under (e.g. "reports/"). Empty = bucket root.'),
        maxKeys: z.number().int().min(1).max(50000).optional()
          .describe('Maximum number of entries to return (default 1000)'),
      },
      handler: async (args) => {
        const out = await client.requestJson<ObjectsResponse>('GET', `/api/objects/${seg(args.bucket)}`, {
          query: {
            prefix: args.prefix ?? '',
            max: args.maxKeys ?? 1000,
          },
        });
        return {
          prefixes: out.prefixes,
          objects: (out.objects ?? []).map((o) => ({
            key: o.Key,
            size: o.Size,
            lastModified: o.LastModified,
          })),
          truncated: out.isTruncated,
        };
      },
    }),

    search_files: tool({
      name: 'search_files',
      description:
        'Recursively search a bucket for objects whose key contains the query (case-insensitive), plus ' +
        `folders whose name matches. Returns at most ${SEARCH_RESULT_CAP} results; "truncated" flags a cut-off list.`,
      inputSchema: {
        bucket: z.string().min(1).describe('Bucket name'),
        query: z.string().min(1).describe('Substring to search for in object keys and folder names'),
        prefix: z.string().optional().describe('Restrict the search to keys under this prefix'),
      },
      handler: async (args): Promise<SearchAggregate> => {
        const stream = await client.requestNdjson(`/api/search-stream/${seg(args.bucket)}`, {
          q: args.query,
          prefix: args.prefix ?? '',
          limit: SEARCH_RESULT_CAP,
        });
        const agg = await aggregateSearchNdjson(stream, SEARCH_RESULT_CAP);
        if (agg.error) {
          throw new Error(`Search failed server-side: ${agg.error}`);
        }
        return agg;
      },
    }),

    presign_url: tool({
      name: 'presign_url',
      description:
        'Generate a temporary presigned GET URL for an object. Anyone with the URL can download the ' +
        'object until it expires. TTL is clamped server-side (default 5 min, max 24 h unless reconfigured).',
      inputSchema: {
        bucket: z.string().min(1).describe('Bucket name'),
        key: z.string().min(1).describe('Full object key'),
        expiresSeconds: z.number().int().min(60).max(604800).optional()
          .describe('Requested TTL in seconds (server clamps to its configured range)'),
      },
      handler: async (args) => {
        const out = await client.requestJson<PresignResponse>(
          'GET',
          `/api/object/${seg(args.bucket)}/presign`,
          { query: { key: args.key, expires: args.expiresSeconds } },
        );
        return { url: out.url, expiresSeconds: out.expires, capped: out.capped };
      },
    }),

    upload_file: tool({
      name: 'upload_file',
      description:
        'Upload a local file (from the machine running this MCP server) to a bucket under the given key. ' +
        'Overwrites an existing object with the same key. Requires a write-scope API token.',
      inputSchema: {
        bucket: z.string().min(1).describe('Destination bucket'),
        key: z.string().min(1).describe('Full destination key, e.g. "reports/q1.pdf"'),
        localPath: z.string().min(1).describe('Absolute path of the local file to upload'),
      },
      handler: async (args) => {
        if (args.key.endsWith('/')) {
          throw new Error(`Invalid key "${args.key}": must not end with "/" (it must name a file, not a folder).`);
        }
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(args.localPath);
        } catch {
          throw new Error(`Local file not found: ${args.localPath}`);
        }
        if (!stat.isFile()) {
          throw new Error(`Not a regular file: ${args.localPath}`);
        }
        if (stat.size > maxUploadBytes) {
          throw new Error(
            `File too large: ${stat.size} bytes exceeds the local upload guard of ${maxUploadBytes} bytes ` +
            '(override with S3X_MAX_UPLOAD_BYTES).',
          );
        }

        // The upload endpoint computes the object key as `prefix + filename`,
        // so split the requested key into those two parts.
        const slash = args.key.lastIndexOf('/');
        const prefix = slash >= 0 ? args.key.slice(0, slash + 1) : '';
        const filename = args.key.slice(slash + 1);

        const contentType = mime.lookup(filename) || 'application/octet-stream';
        const data = await fs.promises.readFile(args.localPath);
        const form = new FormData();
        form.append('prefix', prefix);
        form.append('files', new Blob([new Uint8Array(data)], { type: contentType as string }), filename);

        const out = await client.requestJson<UploadResponse>(
          'POST',
          `/api/object/${seg(args.bucket)}/upload`,
          { body: form },
        );
        const uploaded = out.uploaded?.[0];
        return {
          ok: true,
          key: uploaded?.key ?? args.key,
          size: stat.size,
          source: path.resolve(args.localPath),
        };
      },
    }),

    delete_object: tool({
      name: 'delete_object',
      description:
        'Delete an object. Default: a soft delete — on versioned buckets this creates a delete marker and ' +
        'the object stays recoverable. With purge=true, every version and delete marker of the key is ' +
        'permanently removed (irreversible). Requires a write-scope API token.',
      inputSchema: {
        bucket: z.string().min(1).describe('Bucket name'),
        key: z.string().min(1).describe('Full object key to delete'),
        purge: z.boolean().optional()
          .describe('true = permanently delete every version of the key (irreversible). Default false.'),
      },
      handler: async (args) => {
        if (!args.purge) {
          await client.requestJson<{ ok: boolean }>('DELETE', `/api/object/${seg(args.bucket)}`, {
            body: { key: args.key },
          });
          return {
            ok: true,
            key: args.key,
            mode: 'delete-marker',
            note: 'On versioned buckets the object is recoverable (delete marker). Use purge=true to remove permanently.',
          };
        }

        // Purge: enumerate every version + delete marker of the key, then
        // batch-delete them all — mirrors the app's "purge" semantics for
        // folders, applied to a single key.
        const versions = await client.requestJson<VersionsResponse>(
          'GET',
          `/api/object/${seg(args.bucket)}/versions`,
          { query: { key: args.key } },
        );
        const records = (versions.versions ?? []).filter((v) => v.VersionId);
        if (records.length === 0) {
          // Unversioned bucket (or no version records) — a plain delete removes the object.
          await client.requestJson<{ ok: boolean }>('DELETE', `/api/object/${seg(args.bucket)}`, {
            body: { key: args.key },
          });
          return { ok: true, key: args.key, mode: 'purge', purgedVersions: 1 };
        }
        const out = await client.requestJson<DeleteBatchResponse>(
          'POST',
          `/api/object/${seg(args.bucket)}/delete-batch`,
          { body: { keys: records.map((v) => ({ key: args.key, versionId: v.VersionId })) } },
        );
        return {
          ok: (out.errors ?? []).length === 0,
          key: args.key,
          mode: 'purge',
          purgedVersions: (out.deleted ?? []).length,
          errors: out.errors ?? [],
        };
      },
    }),
  };
}
