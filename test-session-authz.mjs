// test-session-authz.mjs
// Integration tests for session authorization (Task 5).
// Runs against the LIVE server on port 3200. Read-only — does not modify state.
//
// Usage:  node --test test-session-authz.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { createSessionCookie } from './session-cookie.mjs';

// ---------------------------------------------------------------------------
// Config — reads the real AUTH_SECRET from the systemd environment
// ---------------------------------------------------------------------------
const LIVE_PORT = 3200;
const BASE = `http://localhost:${LIVE_PORT}`;

function readAuthSecret() {
  const env = execSync(
    'systemctl show svg-terminal -p Environment --no-pager',
    { encoding: 'utf8' },
  );
  const match = env.match(/AUTH_SECRET=(\S+)/);
  if (!match) throw new Error('Could not read AUTH_SECRET from systemd env');
  return match[1];
}

const AUTH_SECRET = readAuthSecret();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make an HTTP request and return { status, headers, body }. */
function request(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const req = http.request(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Build a valid cp_session cookie string for the given email. */
function makeCookie(email) {
  const token = createSessionCookie(
    { email, displayName: 'Test User' },
    AUTH_SECRET,
    3600,
  );
  return `cp_session=${token}`;
}

// Known users from the live database
const SUPERADMIN_EMAIL = 'frodex310@gmail.com';
const REGULAR_EMAIL    = 'aaronmbraskin@gmail.com';

// ============================================================================
// 1. Endpoint-removed verification (/api/input)
// ============================================================================

describe('/api/input endpoint removal', () => {
  it('GET /api/input returns 404 for authenticated superadmin', async () => {
    const res = await request('/api/input', {
      headers: { Cookie: makeCookie(SUPERADMIN_EMAIL) },
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it('GET /api/input returns 404 for authenticated regular user', async () => {
    const res = await request('/api/input', {
      headers: { Cookie: makeCookie(REGULAR_EMAIL) },
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it('POST /api/input is blocked by CSRF before routing (403)', async () => {
    // POST requests without a matching CSRF double-submit token get 403 from
    // the CSRF middleware, which fires before the router can return 404.
    const res = await request('/api/input', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: makeCookie(SUPERADMIN_EMAIL),
      },
      body: JSON.stringify({ session: 'test', keys: 'hello' }),
    });
    assert.equal(res.status, 403, `Expected 403 (CSRF block), got ${res.status}`);
  });
});

// ============================================================================
// 2. Unauthenticated access — should get 302 redirect to /login
// ============================================================================

// Unauthenticated redirect tests for /api/sessions, /api/pane, /api/cp/dead-sessions
// removed — those HTTP endpoints have been deleted.

describe('Unauthenticated access (302 redirects)', () => {
  it('GET /api/input redirects to /login (unauthenticated)', async () => {
    // Even though the endpoint is removed, auth middleware fires first and
    // sends a 302 before the router can return 404.
    const res = await request('/api/input');
    assert.equal(res.status, 302, `Expected 302, got ${res.status}`);
  });
});

// ============================================================================
// 3. Authenticated access — basic endpoint availability
//    (STRICT_SESSION_AUTHZ is off on the live server, so all authenticated
//    users should get 200 for session-listing endpoints.)
// ============================================================================

// Authenticated access tests for /api/sessions and /api/pane removed —
// those HTTP endpoints have been deleted (data now served over /ws/dashboard).

// ============================================================================
// 4. Invalid/expired cookie — treated as unauthenticated
// ============================================================================

describe('Invalid cookies treated as unauthenticated', () => {
  it('expired cookie gets 302 redirect', async () => {
    // Create a cookie that expired 1 hour ago
    const token = createSessionCookie(
      { email: SUPERADMIN_EMAIL, displayName: 'Test' },
      AUTH_SECRET,
      -3600, // negative maxAge = already expired
    );
    // Test against GET / which requires auth and redirects to /login
    const res = await request('/', {
      headers: { Cookie: `cp_session=${token}` },
    });
    assert.equal(res.status, 302, `Expected 302 for expired cookie, got ${res.status}`);
  });

  it('tampered cookie gets 302 redirect', async () => {
    const token = createSessionCookie(
      { email: SUPERADMIN_EMAIL, displayName: 'Test' },
      AUTH_SECRET,
      3600,
    );
    // Corrupt the signature
    const tampered = token.slice(0, -4) + 'XXXX';
    const res = await request('/', {
      headers: { Cookie: `cp_session=${tampered}` },
    });
    assert.equal(res.status, 302, `Expected 302 for tampered cookie, got ${res.status}`);
  });

  it('cookie signed with wrong secret gets 302 redirect', async () => {
    const token = createSessionCookie(
      { email: SUPERADMIN_EMAIL, displayName: 'Test' },
      'wrong-secret-value',
      3600,
    );
    const res = await request('/', {
      headers: { Cookie: `cp_session=${token}` },
    });
    assert.equal(res.status, 302, `Expected 302 for wrong-secret cookie, got ${res.status}`);
  });

  it('nonexistent user email gets 302 redirect', async () => {
    // Valid signature but email not in the user store
    const res = await request('/', {
      headers: { Cookie: makeCookie('nobody@nonexistent.example') },
    });
    assert.equal(res.status, 302, `Expected 302 for unknown user, got ${res.status}`);
  });
});

// CSRF protection tests for POST /api/cp/restart, /fork, /create-session removed —
// those HTTP endpoints have been deleted (actions now handled over /ws/dashboard).
