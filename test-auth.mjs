import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCookie, validateSessionCookie } from './session-cookie.mjs';

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
