import { describe, expect, it } from 'vitest';
import { hashPasswordSync } from '../../../src/auth/passwords';
import { createUser, findUser, listUsers, updateUser } from '../../../src/auth/users-store';
import type { User } from '../../../src/types';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    username: 'alice',
    passwordHash: hashPasswordSync('pw-' + Math.random()),
    totpSecret: null,
    totpConfirmed: false,
    recoveryCodesHashed: [],
    role: 'user',
    disabled: false,
    mustChangePassword: false,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
    ...overrides,
  };
}

describe('users-store', () => {
  it('createUser inserts a new user and findUser returns it', () => {
    const user = makeUser({ username: 'u-create-1' });
    expect(createUser(user)).toBe(false); // no conflict
    const found = findUser('u-create-1');
    expect(found).toBeDefined();
    expect(found?.username).toBe('u-create-1');
    expect(found?.role).toBe('user');
    expect(found?.disabled).toBe(false);
  });

  it('createUser returns true on duplicate (case-insensitive)', () => {
    createUser(makeUser({ username: 'u-dup' }));
    expect(createUser(makeUser({ username: 'u-dup' }))).toBe(true);
    // CD-SEC: username UNIQUE collation is NOCASE in the schema.
    expect(createUser(makeUser({ username: 'U-DUP' }))).toBe(true);
  });

  it('findUser is case-insensitive', () => {
    createUser(makeUser({ username: 'CaseUser' }));
    expect(findUser('caseuser')?.username).toBe('CaseUser');
    expect(findUser('CASEUSER')?.username).toBe('CaseUser');
    expect(findUser('CaseUser')?.username).toBe('CaseUser');
  });

  it('findUser returns undefined for missing / empty input', () => {
    expect(findUser('nope-' + Date.now())).toBeUndefined();
    expect(findUser('')).toBeUndefined();
    expect(findUser(null)).toBeUndefined();
    expect(findUser(undefined)).toBeUndefined();
  });

  it('updateUser applies a partial patch and persists', async () => {
    createUser(makeUser({ username: 'u-patch' }));
    const updated = await updateUser('u-patch', {
      passwordHash: 'NEW_HASH',
      mustChangePassword: true,
      lastLoginAt: '2026-05-13T12:00:00Z',
    });
    expect(updated).not.toBeNull();
    expect(updated?.passwordHash).toBe('NEW_HASH');
    expect(updated?.mustChangePassword).toBe(true);
    expect(updated?.lastLoginAt).toBe('2026-05-13T12:00:00Z');

    const refetched = findUser('u-patch');
    expect(refetched?.passwordHash).toBe('NEW_HASH');
    expect(refetched?.mustChangePassword).toBe(true);
  });

  it('updateUser leaves unspecified fields alone', async () => {
    createUser(makeUser({ username: 'u-partial', role: 'admin' }));
    await updateUser('u-partial', { disabled: true });
    const after = findUser('u-partial');
    expect(after?.disabled).toBe(true);
    expect(after?.role).toBe('admin'); // unchanged
  });

  it('updateUser returns null for unknown usernames', async () => {
    const result = await updateUser('definitely-not-a-user', { disabled: true });
    expect(result).toBeNull();
  });

  it('updateUser with an empty patch is idempotent', async () => {
    createUser(makeUser({ username: 'u-noop' }));
    const result = await updateUser('u-noop', {});
    expect(result).not.toBeNull();
    expect(result?.username).toBe('u-noop');
  });

  it('updateUser serializes recoveryCodesHashed as JSON', async () => {
    createUser(makeUser({ username: 'u-codes' }));
    const codes = ['hashA', 'hashB', null, 'hashC'];
    await updateUser('u-codes', { recoveryCodesHashed: codes });
    const after = findUser('u-codes');
    expect(after?.recoveryCodesHashed).toEqual(codes);
  });

  it('listUsers returns rows sorted by username', () => {
    createUser(makeUser({ username: 'zzz-last' }));
    createUser(makeUser({ username: 'aaa-first' }));
    const users = listUsers();
    const usernames = users.map((u) => u.username);
    // Test users from other test cases above also exist; just check ORDER among
    // the two distinctive sentinels we added.
    expect(usernames.indexOf('aaa-first')).toBeLessThan(usernames.indexOf('zzz-last'));
  });

  it('boolean columns round-trip through SQLite integers', async () => {
    createUser(makeUser({ username: 'u-bool', disabled: true, totpConfirmed: true }));
    const u = findUser('u-bool');
    expect(u?.disabled).toBe(true);
    expect(u?.totpConfirmed).toBe(true);

    await updateUser('u-bool', { disabled: false, totpConfirmed: false });
    const u2 = findUser('u-bool');
    expect(u2?.disabled).toBe(false);
    expect(u2?.totpConfirmed).toBe(false);
  });
});
