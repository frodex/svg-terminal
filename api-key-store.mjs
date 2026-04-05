// api-key-store.mjs — Server-side API key management for WebSocket authentication
import { randomBytes, createHmac } from 'node:crypto';

export class ApiKeyStore {
  constructor({ secret, idleTimeoutMs = 30 * 60 * 1000, absoluteTimeoutMs = 24 * 60 * 60 * 1000, maxKeysPerUser = 10 }) {
    this._secret = secret;
    this._idleTimeoutMs = idleTimeoutMs;
    this._absoluteTimeoutMs = absoluteTimeoutMs;
    this._maxKeysPerUser = maxKeysPerUser;
    this._keys = new Map(); // key → { email, linuxUser, browserUid, issuedAt, lastActivity, wsClaimed }
    this._cleanupTimer = setInterval(() => this.cleanup(), 60000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  issue(email, linuxUser, browserUid) {
    // Enforce max keys per user — revoke oldest if over limit
    const userKeys = [];
    for (const [k, e] of this._keys) {
      if (e.email === email) userKeys.push({ key: k, issuedAt: e.issuedAt });
    }
    if (userKeys.length >= this._maxKeysPerUser) {
      userKeys.sort((a, b) => a.issuedAt - b.issuedAt);
      for (let i = 0; i <= userKeys.length - this._maxKeysPerUser; i++) {
        this._keys.delete(userKeys[i].key);
      }
    }

    const raw = randomBytes(32).toString('base64url');
    const hmac = createHmac('sha256', this._secret).update(raw).digest('base64url');
    const key = raw + '.' + hmac;
    this._keys.set(key, {
      email,
      linuxUser,
      browserUid: browserUid || null,
      issuedAt: Date.now(),
      lastActivity: Date.now(),
      wsClaimed: false,
    });
    return key;
  }

  validate(key) {
    const entry = this._keys.get(key);
    if (!entry) return null;
    const parts = key.split('.');
    if (parts.length !== 2) return null;
    const [raw, hmac] = parts;
    const expected = createHmac('sha256', this._secret).update(raw).digest('base64url');
    if (hmac !== expected) { this._keys.delete(key); return null; }
    if (Date.now() - entry.lastActivity > this._idleTimeoutMs) { this._keys.delete(key); return null; }
    if (Date.now() - entry.issuedAt > this._absoluteTimeoutMs) { this._keys.delete(key); return null; }
    return { email: entry.email, linuxUser: entry.linuxUser, browserUid: entry.browserUid };
  }

  touch(key) {
    const entry = this._keys.get(key);
    if (entry) entry.lastActivity = Date.now();
  }

  claimWs(key) {
    const entry = this._keys.get(key);
    if (!entry) return false;
    if (entry.wsClaimed) return false;
    entry.wsClaimed = true;
    return true;
  }

  releaseWs(key) {
    const entry = this._keys.get(key);
    if (entry) entry.wsClaimed = false;
  }

  revoke(key) {
    this._keys.delete(key);
  }

  revokeAllForUser(email) {
    for (const [key, entry] of this._keys) {
      if (entry.email === email) this._keys.delete(key);
    }
  }

  listForUser(email) {
    const result = [];
    for (const [key, entry] of this._keys) {
      if (entry.email === email) {
        result.push({
          key: key.slice(0, 8) + '...',
          browserUid: entry.browserUid,
          issuedAt: entry.issuedAt,
          lastActivity: entry.lastActivity,
          wsClaimed: entry.wsClaimed,
        });
      }
    }
    return result;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._keys) {
      if (now - entry.lastActivity > this._idleTimeoutMs || now - entry.issuedAt > this._absoluteTimeoutMs) {
        this._keys.delete(key);
      }
    }
  }
}
