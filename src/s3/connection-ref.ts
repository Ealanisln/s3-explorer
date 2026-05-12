import type { Request, Response } from 'express';

// The SPA generates a UUID per connection in the encrypted vault and sends it
// as the `x-s3-conn-id` header. The server uses it (together with the
// authenticated username) to scope index rows so two connections to the same
// physical bucket don't share index state.
//
// It is NOT a secret — clients can change theirs. The protection comes from
// pairing it with `username` in every query, so a user can only see their own
// rows. Lower-case hex UUIDs (8-4-4-4-12) are accepted; the SPA uses
// `crypto.randomUUID()`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getConnectionId(req: Request, res: Response): string | null {
  const raw = req.header('x-s3-conn-id');
  if (!raw || !UUID_RE.test(raw)) {
    res.status(400).json({
      message: 'Falta o es inválido el header x-s3-conn-id (UUID requerido).',
      code: 'BAD_CONNECTION_ID',
    });
    return null;
  }
  return raw.toLowerCase();
}
