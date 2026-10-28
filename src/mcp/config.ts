// Environment-driven configuration for the MCP server.
//
// The MCP server is a thin bridge: it authenticates against a running
// S3 Explorer instance with a Personal Access Token (S3X_API_TOKEN) and
// forwards S3 credentials on every request via the same transient x-s3-*
// headers the web UI uses. Nothing is persisted; secrets never get logged.

import { stripTrailingSlashes } from '../util/strings';

export interface McpConfig {
  /** Base URL of the running S3 Explorer instance, e.g. https://s3x.example.com */
  baseUrl: string;
  /** Personal Access Token (s3x_...), read or write scope. */
  apiToken: string;
  s3: {
    /** Maps to `x-s3-endpoint`. Optional — omitting it targets AWS S3. */
    endpoint?: string;
    /** Maps to `x-s3-region`. Defaults to us-east-1 (same as the server). */
    region: string;
    /** Maps to `x-s3-access-key`. */
    accessKey: string;
    /** Maps to `x-s3-secret-key`. */
    secretKey: string;
    /** Maps to `x-s3-session-token`. Optional (STS credentials). */
    sessionToken?: string;
    /** Maps to `x-s3-path-style`. Defaults to 'true' (same as the server). */
    pathStyle: 'true' | 'false';
  };
  /** Local-file size guard for upload_file. Default 100 MiB. */
  maxUploadBytes: number;
}

export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MiB

const REQUIRED_VARS = [
  'S3X_BASE_URL',
  'S3X_API_TOKEN',
  'S3X_S3_ACCESS_KEY_ID',
  'S3X_S3_SECRET_ACCESS_KEY',
] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function clean(v: string | undefined): string | undefined {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : undefined;
}

// Fail fast with a message that lists every missing variable at once, so the
// user fixes their MCP client config in one round trip. The message never
// contains the values of S3X_API_TOKEN or S3X_S3_SECRET_ACCESS_KEY.
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const missing = REQUIRED_VARS.filter((name) => !clean(env[name]));
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}.\n` +
      'Required: S3X_BASE_URL (S3 Explorer URL), S3X_API_TOKEN (s3x_... personal access token),\n' +
      'S3X_S3_ACCESS_KEY_ID / S3X_S3_SECRET_ACCESS_KEY (S3 credentials).\n' +
      'Optional: S3X_S3_ENDPOINT, S3X_S3_REGION, S3X_S3_SESSION_TOKEN, S3X_S3_PATH_STYLE, S3X_MAX_UPLOAD_BYTES.',
    );
  }

  const baseUrlRaw = clean(env.S3X_BASE_URL)!;
  let baseUrl: string;
  try {
    const parsed = new URL(baseUrlRaw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('not http(s)');
    }
    baseUrl = stripTrailingSlashes(baseUrlRaw);
  } catch {
    throw new ConfigError(`S3X_BASE_URL is not a valid http(s) URL: ${baseUrlRaw}`);
  }

  const apiToken = clean(env.S3X_API_TOKEN)!;
  if (!apiToken.startsWith('s3x_')) {
    // A non-s3x Bearer falls through to session auth server-side and always
    // fails — surface the misconfiguration now instead of on every tool call.
    throw new ConfigError(
      'S3X_API_TOKEN must be an S3 Explorer personal access token (it starts with "s3x_"). ' +
      'Create one in the UI under "Mi cuenta" → "Tokens de API".',
    );
  }

  const pathStyleRaw = clean(env.S3X_S3_PATH_STYLE) ?? 'true';
  if (pathStyleRaw !== 'true' && pathStyleRaw !== 'false') {
    throw new ConfigError(`S3X_S3_PATH_STYLE must be "true" or "false", got: ${pathStyleRaw}`);
  }

  let maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES;
  const maxUploadRaw = clean(env.S3X_MAX_UPLOAD_BYTES);
  if (maxUploadRaw !== undefined) {
    const parsed = Number(maxUploadRaw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new ConfigError(`S3X_MAX_UPLOAD_BYTES must be a positive integer, got: ${maxUploadRaw}`);
    }
    maxUploadBytes = parsed;
  }

  return {
    baseUrl,
    apiToken,
    s3: {
      endpoint: clean(env.S3X_S3_ENDPOINT),
      region: clean(env.S3X_S3_REGION) ?? 'us-east-1',
      accessKey: clean(env.S3X_S3_ACCESS_KEY_ID)!,
      secretKey: clean(env.S3X_S3_SECRET_ACCESS_KEY)!,
      sessionToken: clean(env.S3X_S3_SESSION_TOKEN),
      pathStyle: pathStyleRaw,
    },
    maxUploadBytes,
  };
}
