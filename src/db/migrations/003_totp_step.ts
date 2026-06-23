// TOTP replay prevention (security audit follow-up):
//
// A 6-digit TOTP code stays valid for its whole ~30s timestep, and the
// verifier had no record of which step a user last authenticated with — so a
// code observed/intercepted within its window could be replayed to complete a
// second login. We now persist the last consumed timestep per user and reject
// any code whose step is <= the stored one (monotonic step enforcement).
//
// Default 0 means "nothing consumed yet" — the first real login (current step
// is ~epoch/30, a large positive number) always passes.

export const version = 3;

export const sql = `
ALTER TABLE users ADD COLUMN last_totp_step INTEGER NOT NULL DEFAULT 0;
`;
