import { describe, expect, it } from 'vitest';
import { sanitizeError, type ErrorLike } from '../../../src/s3/errors';
import { newErrorId } from '../../../src/http/errors';

describe('sanitizeError (CD-SEC-005)', () => {
  it('maps known AWS error names to Spanish messages, preserves status', () => {
    const cases: Array<{ name: string; status: number; expect: string }> = [
      { name: 'NoSuchBucket', status: 404, expect: 'El bucket no existe.' },
      { name: 'NoSuchKey', status: 404, expect: 'El archivo no existe.' },
      { name: 'AccessDenied', status: 403, expect: 'Acceso denegado. Verifica los permisos del IAM para este bucket/objeto.' },
      { name: 'BucketNotEmpty', status: 409, expect: 'El bucket no está vacío.' },
      { name: 'InvalidAccessKeyId', status: 403, expect: 'Credenciales inválidas. Verifica access key y secret key.' },
      { name: 'SignatureDoesNotMatch', status: 403, expect: 'Credenciales inválidas. Verifica access key y secret key.' },
    ];
    for (const c of cases) {
      const e: ErrorLike = { name: c.name, status: c.status, message: 'leaky inner ARN' };
      const result = sanitizeError(e);
      expect(result.status).toBe(c.status);
      expect(result.body.error).toBe(c.name);
      expect(result.body.message).toBe(c.expect);
      // Critical: the original message must NEVER appear in the body.
      expect(result.body.message).not.toContain('leaky inner ARN');
    }
  });

  it('maps EndpointBlocked + MissingCredentials (our own errors)', () => {
    const blocked = sanitizeError({ name: 'EndpointBlocked', status: 403 });
    expect(blocked.body.error).toBe('EndpointBlocked');
    expect(blocked.body.message).toContain('bloqueado');

    const missing = sanitizeError({ name: 'MissingCredentials', status: 401 });
    expect(missing.body.error).toBe('MissingCredentials');
    expect(missing.body.message).toContain('credenciales');
  });

  it('collapses unknown 5xx errors to InternalError, hides original message', () => {
    const e: ErrorLike = {
      name: 'WeirdProviderError',
      status: 500,
      message: 'arn:aws:secret:internal-bucket-name/key',
    };
    const result = sanitizeError(e);
    expect(result.status).toBe(500);
    expect(result.body.error).toBe('InternalError');
    expect(result.body.message).toBe('Error interno del servidor.');
    expect(result.body.message).not.toContain('arn:');
    expect(result.body.message).not.toContain('internal-bucket-name');
  });

  it('reads status from $metadata.httpStatusCode when `status` is absent', () => {
    const result = sanitizeError({
      name: 'NoSuchBucket',
      $metadata: { httpStatusCode: 404 },
    });
    expect(result.status).toBe(404);
  });

  it('defaults to 500 / InternalError when no status info is present', () => {
    const result = sanitizeError({ name: 'SomethingUnexpected' });
    expect(result.status).toBe(500);
    expect(result.body.error).toBe('InternalError');
  });

  it('non-5xx unknown errors return a generic "Operación rechazada" with the original name', () => {
    const result = sanitizeError({ name: 'WeirdClientError', status: 422 });
    expect(result.status).toBe(422);
    expect(result.body.error).toBe('WeirdClientError');
    expect(result.body.message).toBe('Operación rechazada.');
  });

  it('attaches errorId to the body when provided', () => {
    const known = sanitizeError({ name: 'NoSuchKey', status: 404 }, 'err-abc12345');
    expect(known.body.errorId).toBe('err-abc12345');

    const unknown = sanitizeError({ name: 'X', status: 500 }, 'err-deadbeef');
    expect(unknown.body.errorId).toBe('err-deadbeef');

    const noId = sanitizeError({ name: 'NoSuchKey', status: 404 });
    expect(noId.body.errorId).toBeUndefined();
  });

  it('handles errors with no name field (defaults to "Error")', () => {
    const result = sanitizeError({ status: 400, message: 'leaky detail' });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('Error');
    expect(result.body.message).toBe('Operación rechazada.');
    expect(result.body.message).not.toContain('leaky detail');
  });
});

describe('newErrorId', () => {
  it('produces ids of shape err-<8 hex>', () => {
    for (let i = 0; i < 50; i++) {
      expect(newErrorId()).toMatch(/^err-[0-9a-f]{8}$/);
    }
  });

  it('produces distinct ids across calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(newErrorId());
    // With 32 bits of entropy, collisions in 100 samples are astronomically unlikely.
    expect(ids.size).toBe(100);
  });
});
