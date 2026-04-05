// rate-limiter.mjs — configurable per-key rate limiter with lockout
export class RateLimiter {
  constructor({ maxAttempts = 10, windowMs = 60000, lockoutMs = 300000, lockoutAfter = 0 }) {
    this._maxAttempts = maxAttempts;
    this._windowMs = windowMs;
    this._lockoutMs = lockoutMs;
    this._lockoutAfter = lockoutAfter;
    this._entries = new Map();
    this._cleanupTimer = setInterval(() => this._cleanup(), 60000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  _getEntry(key) {
    let entry = this._entries.get(key);
    if (!entry) {
      entry = { attempts: 0, failures: 0, windowStart: Date.now(), lockedUntil: 0 };
      this._entries.set(key, entry);
    }
    if (Date.now() - entry.windowStart > this._windowMs) {
      entry.attempts = 0;
      entry.windowStart = Date.now();
    }
    return entry;
  }

  check(key) {
    const entry = this._getEntry(key);
    if (entry.lockedUntil && Date.now() < entry.lockedUntil) return false;
    if (entry.attempts >= this._maxAttempts) return false;
    entry.attempts++;
    return true;
  }

  recordFailure(key) {
    const entry = this._getEntry(key);
    entry.failures++;
    if (this._lockoutAfter && entry.failures >= this._lockoutAfter) {
      entry.lockedUntil = Date.now() + this._lockoutMs;
    }
  }

  recordSuccess(key) {
    const entry = this._getEntry(key);
    entry.failures = 0;
    entry.lockedUntil = 0;
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._entries) {
      if (now - entry.windowStart > this._windowMs * 2 && (!entry.lockedUntil || now > entry.lockedUntil)) {
        this._entries.delete(key);
      }
    }
  }
}
