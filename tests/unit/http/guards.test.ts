import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { hostAllowlist, originAllowlist, securityHeaders } from '../../../src/http/guards';

// Mini-app harness that wires a single guard around a probe endpoint.
function withGuards(...mws: express.RequestHandler[]) {
  const app = express();
  for (const mw of mws) app.use(mw);
  app.get('/probe', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('hostAllowlist', () => {
  it('rejects an unknown Host with 403', async () => {
    const app = withGuards(hostAllowlist);
    const res = await request(app).get('/probe').set('Host', 'evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Host not allowed/);
  });

  it('accepts an exact match (host:port) from ALLOWED_HOSTS', async () => {
    const app = withGuards(hostAllowlist);
    // tests/setup.ts pins ALLOWED_HOSTS=127.0.0.1,localhost,127.0.0.1:4569,localhost:4569
    const res = await request(app).get('/probe').set('Host', '127.0.0.1:4569');
    expect(res.status).toBe(200);
  });

  it('accepts a bare-host match even when ALLOWED_HOSTS entries include a port', async () => {
    const app = withGuards(hostAllowlist);
    const res = await request(app).get('/probe').set('Host', 'localhost:9999');
    // 'localhost' (bareHost) is in ALLOWED_HOSTS, so the request passes even
    // though 'localhost:9999' is not an exact entry.
    expect(res.status).toBe(200);
  });

  it('is case-insensitive on the Host header', async () => {
    const app = withGuards(hostAllowlist);
    const res = await request(app).get('/probe').set('Host', 'LOCALHOST');
    expect(res.status).toBe(200);
  });
});

describe('originAllowlist', () => {
  it('allows requests with no Origin (same-origin / non-browser)', async () => {
    const app = withGuards(originAllowlist);
    const res = await request(app).get('/probe');
    expect(res.status).toBe(200);
  });

  it('allows same-origin requests (Origin matches Host)', async () => {
    const app = withGuards(originAllowlist);
    const res = await request(app)
      .get('/probe')
      .set('Host', 'localhost:4569')
      .set('Origin', 'http://localhost:4569');
    expect(res.status).toBe(200);
  });

  it('allows an Origin that is in ALLOWED_ORIGINS', async () => {
    const app = withGuards(originAllowlist);
    // tests/setup.ts pins ALLOWED_ORIGINS=http://localhost:4569
    const res = await request(app)
      .get('/probe')
      .set('Host', 'other-host')
      .set('Origin', 'http://localhost:4569');
    expect(res.status).toBe(200);
  });

  it('rejects a foreign Origin with 403', async () => {
    const app = withGuards(originAllowlist);
    const res = await request(app)
      .get('/probe')
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Origin not allowed/);
  });
});

describe('securityHeaders', () => {
  it('sets the strict-CSP + hardening headers on regular routes', async () => {
    const app = withGuards(securityHeaders);
    const res = await request(app).get('/probe');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'"); // no inline scripts allowed
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    // never inline script: extract the script-src directive only
    const scriptSrc = csp.split(';').map((d: string) => d.trim()).find((d: string) => d.startsWith('script-src'));
    expect(scriptSrc).toBe("script-src 'self'");
  });

  it('skips the SPA-wide CSP on inline-preview download routes', async () => {
    const app = express();
    app.use(securityHeaders);
    app.get('/api/object/:bucket/download', (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/api/object/foo/download?inline=1');
    expect(res.status).toBe(200);
    // The inline route is expected to set its own scoped CSP elsewhere; the
    // SPA-wide CSP must NOT be applied here (would block the blob preview).
    expect(res.headers['content-security-policy']).toBeUndefined();
    // Other hardening headers still apply.
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});
