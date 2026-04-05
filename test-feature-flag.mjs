import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UserStore } from './user-store.mjs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Superadmin role', () => {
  it('is_superadmin defaults to 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-'));
    const store = new UserStore(join(dir, 'test.db'));
    store.createPendingUser({ email: 'test@test.com', displayName: 'Test' });
    const user = store.findByEmail('test@test.com');
    assert.equal(user.is_superadmin, 0);
  });

  it('setSuperadmin sets the flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-'));
    const store = new UserStore(join(dir, 'test.db'));
    store.createPendingUser({ email: 'admin@test.com', displayName: 'Admin' });
    store.setSuperadmin('admin@test.com', true);
    const user = store.findByEmail('admin@test.com');
    assert.equal(user.is_superadmin, 1);
  });

  it('setSuperadmin can unset the flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-'));
    const store = new UserStore(join(dir, 'test.db'));
    store.createPendingUser({ email: 'admin@test.com', displayName: 'Admin' });
    store.setSuperadmin('admin@test.com', true);
    store.setSuperadmin('admin@test.com', false);
    const user = store.findByEmail('admin@test.com');
    assert.equal(user.is_superadmin, 0);
  });
});
