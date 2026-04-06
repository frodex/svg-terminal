// test-server.mjs
// Tests for server.mjs HTTP server

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const TEST_PORT = 3299;
const BASE = `http://localhost:${TEST_PORT}`;

const DEV_PASSWORD = 'test-pass-' + Date.now();
let serverProcess;
let apiKeys = []; // Pool of WS auth keys (one per WS test)
let apiKeyIdx = 0;

before(async () => {
  serverProcess = spawn(process.execPath, ['server.mjs', '--port', String(TEST_PORT)], {
    cwd: new URL('.', import.meta.url).pathname,
    stdio: 'pipe',
    env: {
      ...process.env,
      AUTH_MODE: 'dev',
      DEV_PASSWORD,
      DEV_LOCALHOST_ONLY: '0',
    },
  });
  serverProcess.stderr.on('data', (d) => process.stderr.write(d));
  // Wait for startup
  await new Promise((resolve) => setTimeout(resolve, 800));

  // Authenticate: GET /login to obtain CSRF cookie, then POST /login with dev password
  const loginPage = await fetch(`${BASE}/login`);
  const csrfCookie = (loginPage.headers.get('set-cookie') || '').match(/cp_csrf=([^;]+)/)?.[1];
  assert.ok(csrfCookie, 'Should receive CSRF cookie from GET /login');
  const cookies = loginPage.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

  const loginRes = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfCookie,
      Cookie: cookies,
    },
    body: JSON.stringify({ password: DEV_PASSWORD }),
    redirect: 'manual',
  });
  assert.equal(loginRes.status, 200, `Login failed: ${loginRes.status}`);
  const allCookies = loginRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    + '; ' + cookies;

  // Fetch multiple API keys for WebSocket tests (one per WS test, to avoid
  // claimWs/releaseWs timing issues between sequential tests)
  for (let i = 0; i < 5; i++) {
    const keyRes = await fetch(`${BASE}/auth/api-key?uid=test-${i}`, {
      headers: { Cookie: allCookies },
    });
    assert.equal(keyRes.status, 200, `API key fetch failed: ${keyRes.status}`);
    const keyData = await keyRes.json();
    assert.ok(keyData.key, 'Should receive an API key');
    apiKeys.push(keyData.key);
  }
});

after(() => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return res;
}

/** Build a WS URL with API key auth (uses a fresh key from the pool each call) */
function wsUrl(path) {
  const key = apiKeys[apiKeyIdx++ % apiKeys.length];
  const sep = path.includes('?') ? '&' : '?';
  return `ws://127.0.0.1:${TEST_PORT}${path}${sep}key=${key}`;
}

/** Close a WS and wait for the close handshake to complete (server releases API key). */
function closeWs(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.addEventListener('close', () => setTimeout(resolve, 100));
    ws.close();
    setTimeout(resolve, 3000); // fallback
  });
}

test('unauthenticated /terminal.svg redirects to /login (auth enabled)', async () => {
  const res = await fetch(`${BASE}/terminal.svg`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(
    res.headers.get('location').includes('/login'),
    `Expected redirect to /login, got: ${res.headers.get('location')}`
  );
});

test('unauthenticated / redirects to /login', async () => {
  const res = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(
    res.headers.get('location').includes('/login'),
    `Expected redirect to /login, got: ${res.headers.get('location')}`
  );
});

// /api/pane and /api/sessions HTTP endpoint tests removed — endpoints deleted
// Validation, CORS, session list, pane capture, and cache-control tests for
// those endpoints are no longer applicable.

// CORS headers on /terminal.svg test removed — with auth enabled, unauthenticated
// requests get a 302 redirect before the CORS handler is reached.

// Input API tests removed — /api/input endpoint deleted (Task 3, session authz hardening)
// /ws/terminal tests removed — endpoint returns 410 Gone (Task 8, session authz hardening)

test('WebSocket /ws/terminal is rejected (410 or 401)', async () => {
  // The per-card terminal WS endpoint is deprecated; server rejects the upgrade.
  // We do NOT pass an API key here to avoid permanently claiming the key
  // (the 410 path destroys the socket without calling releaseWs).
  const ws = new WebSocket('ws://127.0.0.1:' + TEST_PORT + '/ws/terminal?session=test&pane=0');
  const closeCode = await new Promise((resolve) => {
    ws.onerror = () => {};
    ws.onclose = (e) => resolve(e.code);
    setTimeout(() => resolve('timeout'), 3000);
  });
  // WebSocket will get a non-101 response, which triggers an error/close
  assert.ok(closeCode !== 'timeout', 'Connection should be rejected, not hang');
});

// GET /api/pane metadata test removed — endpoint deleted

// WebSocket resize + resize-lock tests removed — /ws/terminal returns 410 (Task 8)

// ---------------------------------------------------------------------------
// DashboardSocket tests
// ---------------------------------------------------------------------------

function parseWsMsg(e) {
  return JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
}

test('/ws/dashboard receives session-add and screen messages', async () => {
  const ws = new WebSocket(wsUrl('/ws/dashboard'));

  // Collect messages until we see at least one session-add and one screen
  const msgs = await new Promise((resolve, reject) => {
    const collected = [];
    let gotAdd = false, gotScreen = false;
    ws.onmessage = (e) => {
      const msg = parseWsMsg(e);
      collected.push(msg);
      if (msg.type === 'session-add') gotAdd = true;
      if (msg.type === 'screen') gotScreen = true;
      if (gotAdd && gotScreen) resolve(collected);
    };
    ws.onerror = () => reject(new Error('WebSocket error'));
    setTimeout(() => {
      if (gotAdd || gotScreen) resolve(collected);
      else reject(new Error('Timeout — no session-add or screen received'));
    }, 5000);
  });

  const adds = msgs.filter(m => m.type === 'session-add');
  assert.ok(adds.length > 0, 'Should receive at least one session-add');

  const screens = msgs.filter(m => m.type === 'screen');
  assert.ok(screens.length > 0, 'Should receive at least one screen');

  // Screen messages must have session and pane tags
  assert.ok(screens[0].session, 'screen should have session field');
  assert.ok(screens[0].pane, 'screen should have pane field');

  await closeWs(ws);
});

test('/ws/dashboard input sends keys without error', async () => {
  const ws = new WebSocket(wsUrl('/ws/dashboard'));

  // Wait for a session-add with source=tmux to discover a local session
  const localSession = await new Promise((resolve, reject) => {
    ws.onmessage = (e) => {
      const msg = parseWsMsg(e);
      if (msg.type === 'session-add' && msg.source === 'tmux') resolve(msg);
    };
    ws.onerror = () => reject(new Error('WebSocket error'));
    setTimeout(() => resolve(null), 5000);
  });
  if (!localSession) { ws.close(); return; } // skip if no local sessions

  // Wait for initial screen for our session
  await new Promise((resolve, reject) => {
    ws.onmessage = (e) => {
      const msg = parseWsMsg(e);
      if (msg.type === 'screen' && msg.session === localSession.session) resolve();
    };
    ws.onerror = () => reject(new Error('WebSocket error'));
    setTimeout(() => reject(new Error('Timeout waiting for screen')), 5000);
  });

  // Send input — should not cause an error response
  ws.send(JSON.stringify({ type: 'input', session: localSession.session, pane: '0', keys: ' ' }));

  // Wait briefly and check we get screen/delta, not error
  const response = await new Promise((resolve, reject) => {
    ws.onmessage = (e) => {
      const msg = parseWsMsg(e);
      resolve(msg);
    };
    setTimeout(() => resolve(null), 2000);
  });

  if (response) {
    assert.notEqual(response.type, 'error', 'Should not receive error after input: ' + JSON.stringify(response));
  }

  await closeWs(ws);
});

test('/ws/dashboard handles claude-proxy sessions gracefully', async () => {
  // This test verifies the dashboard doesn't crash when claude-proxy sessions
  // are discovered but not locally accessible. We just need to confirm the
  // connection succeeds and session-add messages are sent.
  const ws = new WebSocket(wsUrl('/ws/dashboard'));

  const msgs = await new Promise((resolve, reject) => {
    const collected = [];
    ws.onmessage = (e) => {
      collected.push(parseWsMsg(e));
    };
    ws.onerror = () => reject(new Error('WebSocket error'));
    // Collect for 2 seconds
    setTimeout(() => resolve(collected), 2000);
  });

  // Should have at least one session-add (from local tmux)
  const adds = msgs.filter(m => m.type === 'session-add');
  assert.ok(adds.length > 0, 'Should receive session-add messages');

  // All session-add messages should have required fields
  for (const add of adds) {
    assert.ok(add.session, 'session-add should have session field');
    assert.ok(add.source, 'session-add should have source field');
  }

  // No errors should have been sent
  const errors = msgs.filter(m => m.type === 'error');
  assert.equal(errors.length, 0, 'Should not receive any errors: ' + JSON.stringify(errors));

  await closeWs(ws);
});

test('/ws/dashboard full path: session-add → screen → input → delta', async () => {
  const ws = new WebSocket(wsUrl('/ws/dashboard'));
  await new Promise(r => { ws.onopen = r; });

  const msgs = [];
  ws.onmessage = (e) => msgs.push(JSON.parse(e.data));

  // Wait for session-add and initial screen messages
  await new Promise(r => setTimeout(r, 500));

  const adds = msgs.filter(m => m.type === 'session-add');
  assert.ok(adds.length > 0, 'Should receive session-add events');

  const screens = msgs.filter(m => m.type === 'screen');
  assert.ok(screens.length > 0, 'Should receive initial screen data');

  // Verify screen messages have required fields
  const screen = screens[0];
  assert.ok(screen.session, 'screen must have session field');
  assert.ok(screen.pane !== undefined, 'screen must have pane field');
  assert.ok(screen.width > 0, 'screen must have width');
  assert.ok(screen.height > 0, 'screen must have height');
  assert.ok(Array.isArray(screen.lines), 'screen must have lines array');
  assert.ok(screen.lines.length === screen.height, 'lines count must match height');
  assert.ok(screen.lines[0].spans, 'each line must have spans');

  // Send input to first local tmux session
  const localAdd = adds.find(a => a.source === 'tmux');
  if (localAdd) {
    ws.send(JSON.stringify({
      session: localAdd.session,
      pane: '0',
      type: 'input',
      keys: ' '  // space — harmless
    }));

    // Wait for response
    await new Promise(r => setTimeout(r, 300));

    // No errors should have been received
    const errors = msgs.filter(m => m.type === 'error');
    assert.equal(errors.length, 0, 'No errors: ' + JSON.stringify(errors));
  }

  await closeWs(ws);
});
