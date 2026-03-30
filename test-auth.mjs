import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCookie, validateSessionCookie } from './session-cookie.mjs';
import { UserStore } from './user-store.mjs';
import { unlinkSync } from 'node:fs';

describe('session-cookie', () => {
  const SECRET = 'test-secret-key-min-32-chars-long!!';

  it('creates and validates a cookie', () => {
    const cookie = createSessionCookie({ email: 'user@test.com', displayName: 'Test' }, SECRET, 3600);
    const payload = validateSessionCookie(cookie, SECRET);
    assert.equal(payload.email, 'user@test.com');
    assert.equal(payload.displayName, 'Test');
  });

  it('rejects tampered cookie', () => {
    const cookie = createSessionCookie({ email: 'user@test.com', displayName: 'Test' }, SECRET, 3600);
    const tampered = cookie.slice(0, -1) + 'X';
    assert.equal(validateSessionCookie(tampered, SECRET), null);
  });

  it('rejects expired cookie', () => {
    const cookie = createSessionCookie({ email: 'user@test.com', displayName: 'Test' }, SECRET, -1);
    assert.equal(validateSessionCookie(cookie, SECRET), null);
  });

  it('rejects wrong secret', () => {
    const cookie = createSessionCookie({ email: 'user@test.com', displayName: 'Test' }, SECRET, 3600);
    assert.equal(validateSessionCookie(cookie, 'wrong-secret-key-also-32-chars!!'), null);
  });

  it('rejects garbage input', () => {
    assert.equal(validateSessionCookie('garbage', SECRET), null);
    assert.equal(validateSessionCookie('', SECRET), null);
    assert.equal(validateSessionCookie('a.b.c', SECRET), null);
  });
});

describe('user-store', () => {
  let store;
  const DB_PATH = '/tmp/test-user-store.db';

  it('creates database and tables', () => {
    try { unlinkSync(DB_PATH); } catch {}
    store = new UserStore(DB_PATH);
    assert.ok(store);
  });

  it('creates a pending user', () => {
    store.createPendingUser({
      email: 'student@school.edu',
      displayName: 'Test Student',
      provider: 'google',
      providerId: 'goog-123',
    });
    const user = store.findByEmail('student@school.edu');
    assert.equal(user.status, 'pending');
    assert.equal(user.linux_user, null);
  });

  it('approves a user', () => {
    store.approveUser('student@school.edu', 'root');
    const user = store.findByEmail('student@school.edu');
    assert.equal(user.status, 'approved');
    assert.equal(user.approved_by, 'root');
  });

  it('denies a user', () => {
    store.createPendingUser({ email: 'bad@school.edu', displayName: 'Bad Actor', provider: 'github', providerId: 'gh-999' });
    store.denyUser('bad@school.edu');
    const user = store.findByEmail('bad@school.edu');
    assert.equal(user.status, 'denied');
  });

  it('lists pending users', () => {
    store.createPendingUser({ email: 'pending@school.edu', displayName: 'Pending', provider: 'google', providerId: 'goog-456' });
    const pending = store.listPending();
    assert.ok(pending.length >= 1);
    assert.ok(pending.every(u => u.status === 'pending'));
  });

  it('pre-approves by email', () => {
    store.preApprove(['future1@school.edu', 'future2@school.edu'], 'root');
    const u1 = store.findByEmail('future1@school.edu');
    assert.equal(u1.status, 'approved');
    assert.equal(u1.approved_by, 'root');
    assert.equal(u1.provider, null);
  });

  it('finds by provider', () => {
    const user = store.findByProvider('google', 'goog-123');
    assert.equal(user.email, 'student@school.edu');
  });

  it('updates approval flags', () => {
    store.updateFlags('student@school.edu', { can_approve_users: 1 });
    const user = store.findByEmail('student@school.edu');
    assert.equal(user.can_approve_users, 1);
    assert.equal(user.can_approve_admins, 0);
  });

  it('sets linux_user on approve', () => {
    store.setLinuxUser('student@school.edu', 'student');
    const user = store.findByEmail('student@school.edu');
    assert.equal(user.linux_user, 'student');
  });

  it('lists all users', () => {
    const users = store.listUsers();
    assert.ok(users.length >= 3);
  });

  it('cleans up', () => {
    store.close();
    unlinkSync(DB_PATH);
  });
});
