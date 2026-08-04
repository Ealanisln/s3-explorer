import { describe, it, expect } from 'vitest';
import {
  loadConfigFromEnv,
  ConfigError,
  DEFAULT_MAX_UPLOAD_BYTES,
} from '../../../src/mcp/config';

// A minimal valid environment. Tests clone and mutate it.
function validEnv(): NodeJS.ProcessEnv {
  return {
    S3X_BASE_URL: 'http://127.0.0.1:4569',
    S3X_API_TOKEN: 's3x_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    S3X_S3_ACCESS_KEY_ID: 'AKIATEST',
    S3X_S3_SECRET_ACCESS_KEY: 'super-secret-value',
  };
}

describe('loadConfigFromEnv', () => {
  it('parses a minimal valid environment with defaults', () => {
    const cfg = loadConfigFromEnv(validEnv());
    expect(cfg.baseUrl).toBe('http://127.0.0.1:4569');
    expect(cfg.apiToken.startsWith('s3x_')).toBe(true);
    expect(cfg.s3.endpoint).toBeUndefined();
    expect(cfg.s3.region).toBe('us-east-1');
    expect(cfg.s3.pathStyle).toBe('true');
    expect(cfg.s3.sessionToken).toBeUndefined();
    expect(cfg.maxUploadBytes).toBe(DEFAULT_MAX_UPLOAD_BYTES);
  });

  it('honors the optional S3 variables', () => {
    const cfg = loadConfigFromEnv({
      ...validEnv(),
      S3X_S3_ENDPOINT: 'https://minio.example.com',
      S3X_S3_REGION: 'eu-west-1',
      S3X_S3_SESSION_TOKEN: 'sts-token',
      S3X_S3_PATH_STYLE: 'false',
      S3X_MAX_UPLOAD_BYTES: '1024',
    });
    expect(cfg.s3.endpoint).toBe('https://minio.example.com');
    expect(cfg.s3.region).toBe('eu-west-1');
    expect(cfg.s3.sessionToken).toBe('sts-token');
    expect(cfg.s3.pathStyle).toBe('false');
    expect(cfg.maxUploadBytes).toBe(1024);
  });

  it('lists every missing required variable in one error', () => {
    expect(() => loadConfigFromEnv({})).toThrow(ConfigError);
    try {
      loadConfigFromEnv({ S3X_BASE_URL: 'http://x' });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('S3X_API_TOKEN');
      expect(msg).toContain('S3X_S3_ACCESS_KEY_ID');
      expect(msg).toContain('S3X_S3_SECRET_ACCESS_KEY');
      expect(msg).not.toContain('S3X_BASE_URL,'); // present vars are not listed as missing
    }
  });

  it('treats empty / whitespace-only values as missing', () => {
    const env = { ...validEnv(), S3X_API_TOKEN: '   ' };
    expect(() => loadConfigFromEnv(env)).toThrow(/S3X_API_TOKEN/);
  });

  it('rejects a token that does not start with s3x_', () => {
    const env = { ...validEnv(), S3X_API_TOKEN: 'ghp_notAnS3xToken' };
    expect(() => loadConfigFromEnv(env)).toThrow(/s3x_/);
  });

  it('rejects an invalid base URL and strips trailing slashes from a valid one', () => {
    expect(() => loadConfigFromEnv({ ...validEnv(), S3X_BASE_URL: 'not a url' }))
      .toThrow(/S3X_BASE_URL/);
    expect(() => loadConfigFromEnv({ ...validEnv(), S3X_BASE_URL: 'ftp://x' }))
      .toThrow(/S3X_BASE_URL/);
    const cfg = loadConfigFromEnv({ ...validEnv(), S3X_BASE_URL: 'http://127.0.0.1:4569/' });
    expect(cfg.baseUrl).toBe('http://127.0.0.1:4569');
  });

  it('rejects invalid S3X_S3_PATH_STYLE and S3X_MAX_UPLOAD_BYTES values', () => {
    expect(() => loadConfigFromEnv({ ...validEnv(), S3X_S3_PATH_STYLE: 'yes' }))
      .toThrow(/S3X_S3_PATH_STYLE/);
    expect(() => loadConfigFromEnv({ ...validEnv(), S3X_MAX_UPLOAD_BYTES: '-5' }))
      .toThrow(/S3X_MAX_UPLOAD_BYTES/);
    expect(() => loadConfigFromEnv({ ...validEnv(), S3X_MAX_UPLOAD_BYTES: 'lots' }))
      .toThrow(/S3X_MAX_UPLOAD_BYTES/);
  });

  it('never leaks the token or secret key value in error messages', () => {
    // Force an error unrelated to the secret so the message is produced with
    // secrets present in the environment.
    const env = {
      ...validEnv(),
      S3X_S3_SECRET_ACCESS_KEY: 'TOP-SECRET-VALUE',
      S3X_S3_PATH_STYLE: 'nope',
    };
    try {
      loadConfigFromEnv(env);
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('TOP-SECRET-VALUE');
      expect(msg).not.toContain(env.S3X_API_TOKEN);
    }
  });
});
