import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from './rate-limiter.mjs';

describe('RateLimiter', () => {
  it('allows requests under the limit', () => {
    const rl = new RateLimiter({ maxAttempts: 5, windowMs: 60000 });
    for (let i = 0; i < 5; i++) assert.equal(rl.check('1.2.3.4'), true);
  });

  it('blocks requests over the limit', () => {
    const rl = new RateLimiter({ maxAttempts: 3, windowMs: 60000 });
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), false);
  });

  it('tracks different keys independently', () => {
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 60000 });
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), false);
    assert.equal(rl.check('5.6.7.8'), true);
  });

  it('applies lockout after max failures', () => {
    const rl = new RateLimiter({ maxAttempts: 10, windowMs: 60000, lockoutMs: 5000, lockoutAfter: 3 });
    rl.recordFailure('1.2.3.4');
    rl.recordFailure('1.2.3.4');
    rl.recordFailure('1.2.3.4');
    assert.equal(rl.check('1.2.3.4'), false);
  });

  it('resets after window expires', () => {
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 100 });
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), false);
    rl._entries.get('1.2.3.4').windowStart = Date.now() - 200;
    assert.equal(rl.check('1.2.3.4'), true);
  });

  it('recordSuccess resets failure count', () => {
    const rl = new RateLimiter({ maxAttempts: 10, windowMs: 60000, lockoutAfter: 3, lockoutMs: 5000 });
    rl.recordFailure('1.2.3.4');
    rl.recordFailure('1.2.3.4');
    rl.recordSuccess('1.2.3.4');
    assert.equal(rl.check('1.2.3.4'), true);
  });

  it('cleanup removes old entries', () => {
    const rl = new RateLimiter({ maxAttempts: 10, windowMs: 100 });
    rl.check('1.2.3.4');
    rl._entries.get('1.2.3.4').windowStart = Date.now() - 300;
    rl._cleanup();
    assert.equal(rl._entries.size, 0);
  });
});
