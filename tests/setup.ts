import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Stable secrets for the run. Generated once per test file process (forks pool
// gives each test file a fresh module graph anyway).
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

// Each fork gets a unique tmp dir so the connection.ts mkdirSync side-effect
// doesn't pollute the repo. DB_PATH=:memory: makes the actual DB ephemeral.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3x-test-'));

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = SESSION_SECRET;
process.env.TOTP_ENCRYPTION_KEY = TOTP_ENCRYPTION_KEY;
process.env.DATA_DIR = tmpDataDir;
process.env.DB_PATH = ':memory:';
process.env.HOST = '127.0.0.1';
process.env.PORT = process.env.PORT || '4569';
process.env.ALLOWED_HOSTS = '127.0.0.1,localhost,127.0.0.1:4569,localhost:4569';
process.env.ALLOWED_ORIGINS = 'http://localhost:4569';
process.env.SECURE_COOKIE = '0';
process.env.TRUST_PROXY = '0';
process.env.CHECK_HIBP = '0';

// Suppress the noisy ephemeral-key warnings: we intentionally use stable
// per-run keys above, so the warning is misleading in tests.
const origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const msg = String(args[0] ?? '');
  if (msg.includes('TOTP_ENCRYPTION_KEY not set')) return;
  if (msg.includes('SESSION_SECRET env var not set')) return;
  if (msg.includes('ADMIN_USER/ADMIN_PASS not set')) return;
  origWarn(...args);
};
