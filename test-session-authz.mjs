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

describe('Unauthenticated access (302 redirects)', () => {
  it('GET /api/sessions redirects to /login', async () => {
    const res = await request('/api/sessions');
    assert.equal(res.status, 302, `Expected 302, got ${res.status}`);
    assert.ok(
      res.headers.location && res.headers.location.includes('/login'),
      `Expected redirect to /login, got Location: ${res.headers.location}`,
    );
  });

  it('GET /api/pane redirects to /login', async () => {
    const res = await request('/api/pane?session=test&pane=0');
    assert.equal(res.status, 302, `Expected 302, got ${res.status}`);
    assert.ok(
      res.headers.location && res.headers.location.includes('/login'),
      `Expected redirect to /login, got Location: ${res.headers.location}`,
    );
  });

  it('GET /api/cp/dead-sessions redirects to /login', async () => {
    const res = await request('/api/cp/dead-sessions');
    assert.equal(res.status, 302, `Expected 302, got ${res.status}`);
  });

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

describe('Authenticated access (STRICT_SESSION_AUTHZ=0, backwards compat)', () => {
  it('superadmin can list sessions (200)', async () => {
    const res = await request('/api/sessions', {
      headers: { Cookie: makeCookie(SUPERADMIN_EMAIL) },
    });
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const sessions = JSON.parse(res.body);
    assert.ok(Array.isArray(sessions), 'Response should be an array');
    assert.ok(sessions.length > 0, 'Should return at least one session');
  });

  it('regular user can list sessions (200)', async () => {
    const res = await request('/api/sessions', {
      headers: { Cookie: makeCookie(REGULAR_EMAIL) },
    });
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const sessions = JSON.parse(res.body);
    assert.ok(Array.isArray(sessions), 'Response should be an array');
  });

  it('superadmin can read a pane (200)', async () => {
    // First get a real session name from the sessions list
    const listRes = await request('/api/sessions', {
      headers: { Cookie: makeCookie(SUPERADMIN_EMAIL) },
    });
    const sessions = JSON.parse(listRes.body);
    assert.ok(sessions.length > 0, 'Need at least one session for pane test');
    const sessionName = sessions[0].name;

    const res = await request(`/api/pane?session=${encodeURIComponent(sessionName)}&pane=0`, {
      headers: { Cookie: makeCookie(SUPERADMIN_EMAIL) },
    });
    assert.equal(res.status, 200, `Expected 200 for pane read, got ${res.status}`);
  });

  it('regular user can read a pane (200)', async () => {
    const listRes = await request('/api/sessions', {
      headers: { Cookie: makeCookie(REGULAR_EMAIL) },
    });
    const sessions = JSON.parse(listRes.body);
    assert.ok(sessions.length > 0, 'Need at least one session for pane test');
    const sessionName = sessions[0].name;

    const res = await request(`/api/pane?session=${encodeURIComponent(sessionName)}&pane=0`, {
      headers: { Cookie: makeCookie(REGULAR_EMAIL) },
    });
    assert.equal(res.status, 200, `Expected 200 for pane read, got ${res.status}`);
  });
});

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
    const res = await request('/api/sessions', {
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
    const res = await request('/api/sessions', {
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
    const res = await request('/api/sessions', {
      headers: { Cookie: `cp_session=${token}` },
    });
    assert.equal(res.status, 302, `Expected 302 for wrong-secret cookie, got ${res.status}`);
  });

  it('nonexistent user email gets 302 redirect', async () => {
    // Valid signature but email not in the user store
    const res = await request('/api/sessions', {
      headers: { Cookie: makeCookie('nobody@nonexistent.example') },
    });
    assert.equal(res.status, 302, `Expected 302 for unknown user, got ${res.status}`);
  });
});

// ============================================================================
// 5. CSRF protection on state-changing endpoints
// ============================================================================

describe('CSRF protection on POST endpoints', () => {
  it('POST /api/cp/restart without CSRF token returns 403', async () => {
    const res = await request('/api/cp/restart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: makeCookie(SUPERADMIN_EMAIL),
      },
      body: JSON.stringify({ session: 'test' }),
    });
    assert.equal(res.status, 403, `Expected 403 (CSRF), got ${res.status}`);
  });

  it('POST /api/cp/fork without CSRF token returns 403', async () => {
    const res = await request('/api/cp/fork', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: makeCookie(SUPERADMIN_EMAIL),
      },
      body: JSON.stringify({ session: 'test' }),
    });
    assert.equal(res.status, 403, `Expected 403 (CSRF), got ${res.status}`);
  });

  it('POST /api/cp/create-session without CSRF token returns 403', async () => {
    const res = await request('/api/cp/create-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: makeCookie(SUPERADMIN_EMAIL),
      },
      body: JSON.stringify({ name: 'test' }),
    });
    assert.equal(res.status, 403, `Expected 403 (CSRF), got ${res.status}`);
  });
});
