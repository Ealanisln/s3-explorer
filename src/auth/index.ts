// Aggregator: re-exports the surface that server.js (and future src/server.ts)
// needs from the auth subsystem. Mirrors the public API of the old auth.js so
// server.js can swap `require('./auth')` for `require('./dist/auth')` cleanly.
export { register } from './routes';
export {
  requireAuth,
  requireAdmin,
  requireTotpEnrolled,
  requirePasswordCurrent,
} from './middleware';
export { audit } from './audit';
