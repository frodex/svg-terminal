import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiKeyStore } from './api-key-store.mjs';

describe('ApiKeyStore', () => {
  it('issues a key and validates it', () => {
    const store = new ApiKeyStore({ secret: 'test-secret' });
    const key = store.issue('greg@example.com', 'root');
    const result = store.validate(key);
    assert.equal(result.email, 'greg@example.com');
    assert.equal(result.linuxUser, 'root');
  });

  it('rejects an invalid key', () => {
    const store = new ApiKeyStore({ secret: 'test-secret' });
    assert.equal(store.validate('garbage-key'), null);
  });

  it('rejects a revoked key', () => {
    const store = new ApiKeyStore({ secret: 'test-secret' });
    const key = store.issue('greg@example.com', 'root');
    store.revoke(key);
    assert.equal(store.validate(key), null);
  });

  it('revokes all keys for a user', () => {
    const store = new ApiKeyStore({ secret: 'test-secret' });
    const k1 = store.issue('greg@example.com', 'root');
    const k2 = store.issue('greg@example.com', 'root');
    const k3 = store.issue('aaron@example.com', 'cp-aaronb');
    store.revokeAllForUser('greg@example.com');
    assert.equal(store.validate(k1), null);
    assert.equal(store.validate(k2), null);
    assert.notEqual(store.validate(k3), null);
  });

  it('expires keys after idle timeout', () => {
    const store = new ApiKeyStore({ secret: 'test-secret', idleTimeoutMs: 100 });
    const key = store.issue('greg@example.com', 'root');
    store._keys.get(key).lastActivity = Date.now() - 200;
    assert.equal(store.validate(key), null);
  });

  it('expires keys after absolute timeout', () => {
    const store = new ApiKeyStore({ secret: 'test-secret', absoluteTimeoutMs: 100 });
    const key = store.issue('greg@example.com', 'root');
    store._keys.get(key).issuedAt = Date.now() - 200;
    assert.equal(store.validate(key), null);
  });

  it('enforces max keys per user', () => {
    const store = new ApiKeyStore({ secret: 'test-secret', maxKeysPerUser: 3 });
    const k1 = store.issue('greg@example.com', 'root');
    store.issue('greg@example.com', 'root');
    store.issue('greg@example.com', 'root');
    store.issue('greg@example.com', 'root');
    assert.equal(store.validate(k1), null);
  });

  it('rejects duplicate WS connection on same key', () => {
    const store = new ApiKeyStore({ secret: 'test-secret' });
    const key = store.issue('greg@example.com', 'root');
    assert.equal(store.claimWs(key), true);
    assert.equal(store.claimWs(key), false);
  });

  it('releases WS claim on disconnect', () => {
    const store = new ApiKeyStore({ secret: 'test-secret' });
    const key = store.issue('greg@example.com', 'root');
    store.claimWs(key);
    store.releaseWs(key);
    assert.equal(store.claimWs(key), true);
  });

  it('touch updates lastActivity', () => {
    const store = new ApiKeyStore({ secret: 'test-secret', idleTimeoutMs: 500 });
    const key = store.issue('greg@example.com', 'root');
    const before = store._keys.get(key).lastActivity;
    store.touch(key);
    assert.ok(store._keys.get(key).lastActivity >= before);
  });

  it('cleanup removes expired keys', () => {
    const store = new ApiKeyStore({ secret: 'test-secret', absoluteTimeoutMs: 100 });
    store.issue('greg@example.com', 'root');
    for (const [, entry] of store._keys) entry.issuedAt = Date.now() - 200;
    store.cleanup();
    assert.equal(store._keys.size, 0);
  });

  it('listForUser returns truncated keys', () => {
    const store = new ApiKeyStore({ secret: 'test-secret' });
    store.issue('greg@example.com', 'root');
    store.issue('greg@example.com', 'root');
    store.issue('aaron@example.com', 'cp-aaronb');
    const keys = store.listForUser('greg@example.com');
    assert.equal(keys.length, 2);
    assert.ok(keys[0].key.endsWith('...'));
  });
});
