import type { Request } from 'express';

// Express types `req.query[k]` as `string | string[] | ParsedQs | ParsedQs[]`.
// For our routes we only ever expect a single string value; this coerces
// safely and falls back when the param is missing or arrived as an array
// (e.g. `?key=a&key=b` — we take nothing rather than guessing).
export function q(req: Request, name: string, fallback = ''): string {
  const v = req.query[name];
  return typeof v === 'string' ? v : fallback;
}
