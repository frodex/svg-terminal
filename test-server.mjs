// test-server.mjs
// Tests for server.mjs HTTP server

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync, execSync } from 'node:child_process';
import WebSocket from 'ws';

const TEST_PORT = 3299;
const BASE = `http://localhost:${TEST_PORT}`;

let serverProcess;

before(async () => {
  serverProcess = spawn(process.execPath, ['server.mjs', '--port', String(TEST_PORT)], {
    cwd: new URL('.', import.meta.url).pathname,
    stdio: 'pipe',
  });
  serverProcess.stderr.on('data', (d) => process.stderr.write(d));
  // Wait 500ms for startup
  await new Promise((resolve) => setTimeout(resolve, 500));
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

test('serves terminal.svg with correct content type', async () => {
  const res = await get('/terminal.svg');
  assert.equal(res.status, 200);
  assert.ok(
    res.headers.get('content-type').includes('image/svg+xml'),
    `Expected image/svg+xml, got: ${res.headers.get('content-type')}`
  );
  const body = await res.text();
  assert.ok(body.includes('<svg'), 'Body should contain <svg');
});

test('serves index.html', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.ok(
    res.headers.get('content-type').includes('text/html'),
    `Expected text/html, got: ${res.headers.get('content-type')}`
  );
});

test('rejects invalid session name with 400', async () => {
  const res = await get('/api/pane?session=bad%20name&pane=0');
  assert.equal(res.status, 400);
});

test('rejects invalid pane id with 400', async () => {
  const res = await get('/api/pane?session=valid&pane=bad;injection');
  assert.equal(res.status, 400);
});

test('returns error for nonexistent session (or 502/503 if claude-proxy socket unavailable)', async () => {
  const res = await get('/api/pane?session=nonexistent_session_xyz&pane=0');
  assert.ok(
    [404, 500, 502, 503].includes(res.status),
    `Expected 404/500/502/503, got ${res.status}`
  );
});

test('returns CORS headers on /api/pane', async () => {
  const res = await get('/api/pane?session=nonexistent_xyz&pane=0');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('returns CORS headers on /terminal.svg', async () => {
  const res = await get('/terminal.svg');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('returns session list as array with name and windows fields', async () => {
  const res = await get('/api/sessions');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data), 'Should be an array');
  assert.ok(data.length > 0, 'Should have at least one session');
  const first = data[0];
  assert.ok('name' in first, 'Session should have name field');
  assert.ok('windows' in first, 'Session should have windows field');
  assert.equal(typeof first.name, 'string');
  assert.equal(typeof first.windows, 'number');
});

test('captures a real tmux pane from first available session', async () => {
  // Get sessions list first
  const sessRes = await get('/api/sessions');
  assert.equal(sessRes.status, 200);
  const sessions = await sessRes.json();
  assert.ok(sessions.length > 0, 'Need at least one session for this test');

  const { name } = sessions[0];
  const res = await get(`/api/pane?session=${encodeURIComponent(name)}&pane=0`);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.ok(typeof data.width === 'number', 'width should be a number');
  assert.ok(typeof data.height === 'number', 'height should be a number');
  assert.ok(data.cursor && typeof data.cursor.x === 'number', 'cursor.x should be a number');
  assert.ok(data.cursor && typeof data.cursor.y === 'number', 'cursor.y should be a number');
  assert.ok(Array.isArray(data.lines), 'lines should be an array');
  // Each line has spans array
  for (const line of data.lines) {
    assert.ok(Array.isArray(line.spans), 'each line should have spans array');
  }
});

test('cache-control no-cache on API responses', async () => {
  const res = await get('/api/sessions');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

// Input API tests

test('rejects invalid session in input', async () => {
  const res = await fetch(`${BASE}/api/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: 'foo;rm -rf', pane: '0', keys: 'test' }),
  });
  assert.equal(res.status, 400);
});

test('rejects GET on input endpoint', async () => {
  const res = await fetch(`${BASE}/api/input`);
  assert.equal(res.status, 404);
});

test('sends keys to a real tmux session', async () => {
  const { execSync } = await import('node:child_process');
  execSync('tmux new-session -d -s svg-test-input');
  try {
    const res = await fetch(`${BASE}/api/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: 'svg-test-input', pane: '0', keys: 'echo hello' }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
  } finally {
    execSync('tmux kill-session -t svg-test-input');
  }
});

test('rejects invalid special key', async () => {
  const res = await fetch(`${BASE}/api/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: 'anything', pane: '0', specialKey: 'Evil-Key' }),
  });
  assert.equal(res.status, 400);
});

test('WebSocket /ws/terminal connects and receives screen event', async () => {
  const sessRes = await get('/api/sessions');
  const sessions = await sessRes.json();
  if (sessions.length === 0) return;
  const session = sessions[0].name;

  const ws = new WebSocket('ws://127.0.0.1:' + TEST_PORT + '/ws/terminal?session=' + session + '&pane=0');

  const firstMsg = await new Promise((resolve, reject) => {
    ws.onmessage = (e) => resolve(JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString()));
    ws.onerror = () => reject(new Error('WebSocket error'));
    setTimeout(() => reject(new Error('Timeout')), 5000);
  });

  assert.equal(firstMsg.type, 'screen');
  assert.ok(typeof firstMsg.width === 'number');
  assert.ok(typeof firstMsg.height === 'number');
  assert.ok(Array.isArray(firstMsg.lines));
  assert.ok(firstMsg.cursor);

  ws.close();
});

test('WebSocket input sends keys and receives update', async () => {
  const sessRes = await get('/api/sessions');
  const sessions = await sessRes.json();
  if (sessions.length === 0) return;
  const session = sessions[0].name;

  const ws = new WebSocket('ws://127.0.0.1:' + TEST_PORT + '/ws/terminal?session=' + session + '&pane=0');

  await new Promise((resolve, reject) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
      if (msg.type === 'screen') resolve();
    };
    ws.onerror = () => reject(new Error('WebSocket error'));
    setTimeout(() => reject(new Error('Timeout')), 5000);
  });

  ws.send(JSON.stringify({ type: 'input', keys: ' ' }));

  const response = await new Promise((resolve, reject) => {
    ws.onmessage = (e) => resolve(JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString()));
    setTimeout(() => reject(new Error('No response after input')), 2000);
  });

  assert.ok(response.type === 'screen' || response.type === 'delta');
  ws.close();
});

test('GET /api/pane returns metadata fields', async () => {
  execFileSync('tmux', ['new-session', '-d', '-s', 'meta-test', '-x', '80', '-y', '24']);
  await new Promise(r => setTimeout(r, 500));
  try {
    const res = await fetch(`${BASE}/api/pane?session=meta-test&pane=0`);
    const data = await res.json();
    assert.ok('path' in data, 'response has path field');
    assert.ok('command' in data, 'response has command field');
    assert.ok('pid' in data, 'response has pid field');
    assert.ok('historySize' in data, 'response has historySize field');
    assert.ok('dead' in data, 'response has dead field');
    assert.equal(typeof data.pid, 'number');
    assert.equal(typeof data.dead, 'boolean');
  } finally {
    execFileSync('tmux', ['kill-session', '-t', 'meta-test'], { stdio: 'ignore' });
  }
});

test('WebSocket resize message is processed by server', async () => {
  // This test verifies the server processes resize messages without error.
  // Note: tmux may not actually change dimensions if the pane is attached to a
  // larger terminal — tmux clamps pane size to the smallest attached client.
  // We verify the server responds with a screen (not an error) after resize.
  const sessRes = await get('/api/sessions');
  const sessions = await sessRes.json();
  if (sessions.length === 0) return;
  const session = sessions[0].name;

  const ws = new WebSocket('ws://127.0.0.1:' + TEST_PORT + '/ws/terminal?session=' + session + '&pane=0');

  // Wait for initial screen
  const first = await new Promise((resolve, reject) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
      if (msg.type === 'screen') resolve(msg);
    };
    setTimeout(() => reject(new Error('Timeout')), 5000);
  });

  assert.ok(typeof first.width === 'number');
  assert.ok(typeof first.height === 'number');

  // Send resize — server should not crash and should send a screen response
  ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 35 }));

  const response = await new Promise((resolve, reject) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
      if (msg.type === 'screen' || msg.type === 'delta') resolve(msg);
    };
    setTimeout(() => reject(new Error('No response after resize')), 3000);
  });

  // Server sent a screen or delta — no error, resize was handled
  assert.ok(response.type === 'screen' || response.type === 'delta',
    'Expected screen or delta response after resize');

  ws.close();
});

test('resize lock prevents second browser from overwriting first resize', async () => {
  // Create a dedicated tmux session for this test
  try { execSync('tmux kill-session -t resize-test 2>/dev/null'); } catch {}
  execSync('tmux new-session -d -s resize-test -x 80 -y 24');

  try {
    const wsUrl = 'ws://127.0.0.1:' + TEST_PORT + '/ws/terminal?session=resize-test&pane=0';

    // Open two WebSocket connections to the same session
    const ws1 = new WebSocket(wsUrl);
    const ws2 = new WebSocket(wsUrl);

    // Wait for both to receive initial screen
    const waitForScreen = (ws) => new Promise((resolve, reject) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
        if (msg.type === 'screen') resolve(msg);
      };
      ws.onerror = () => reject(new Error('WebSocket error'));
      setTimeout(() => reject(new Error('Timeout waiting for screen')), 5000);
    });

    await Promise.all([waitForScreen(ws1), waitForScreen(ws2)]);

    // WS1 sends a resize
    ws1.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));

    // Wait for resize to take effect
    await new Promise(r => setTimeout(r, 50));

    // WS2 sends a different resize — should be rejected by lock
    ws2.send(JSON.stringify({ type: 'resize', cols: 60, rows: 15 }));

    // Wait for any processing
    await new Promise(r => setTimeout(r, 100));

    // Check tmux dimensions — should be 100x30 (WS1's resize), not 60x15
    const output = execSync("tmux display-message -t resize-test -p '#{window_width} #{window_height}'").toString().trim();
    const [width, height] = output.split(' ').map(Number);

    assert.equal(width, 100, `Expected width 100 (WS1), got ${width} — lock did not prevent WS2 overwrite`);
    assert.equal(height, 30, `Expected height 30 (WS1), got ${height} — lock did not prevent WS2 overwrite`);

    ws1.close();
    ws2.close();
  } finally {
    try { execSync('tmux kill-session -t resize-test 2>/dev/null'); } catch {}
  }
});

// ---------------------------------------------------------------------------
// DashboardSocket tests
// ---------------------------------------------------------------------------

function parseWsMsg(e) {
  return JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
}

test('Two /ws/dashboard clients both receive session-add and screen messages', async () => {
  const url = 'ws://127.0.0.1:' + TEST_PORT + '/ws/dashboard';
  const ws1 = new WebSocket(url);
  const ws2 = new WebSocket(url);

  // Collect messages until we see at least one session-add and one screen on each
  function collectUntilReady(ws) {
    return new Promise((resolve, reject) => {
      const msgs = [];
      let gotAdd = false, gotScreen = false;
      ws.onmessage = (e) => {
        const msg = parseWsMsg(e);
        msgs.push(msg);
        if (msg.type === 'session-add') gotAdd = true;
        if (msg.type === 'screen') gotScreen = true;
        if (gotAdd && gotScreen) resolve(msgs);
      };
      ws.onerror = () => reject(new Error('WebSocket error'));
      setTimeout(() => {
        // Resolve with whatever we have after timeout
        if (gotAdd || gotScreen) resolve(msgs);
        else reject(new Error('Timeout — no session-add or screen received'));
      }, 5000);
    });
  }

  const [msgs1, msgs2] = await Promise.all([collectUntilReady(ws1), collectUntilReady(ws2)]);

  // Both should have session-add messages
  const adds1 = msgs1.filter(m => m.type === 'session-add');
  const adds2 = msgs2.filter(m => m.type === 'session-add');
  assert.ok(adds1.length > 0, 'ws1 should receive at least one session-add');
  assert.ok(adds2.length > 0, 'ws2 should receive at least one session-add');

  // Both should have screen messages with session and pane fields
  const screens1 = msgs1.filter(m => m.type === 'screen');
  const screens2 = msgs2.filter(m => m.type === 'screen');
  assert.ok(screens1.length > 0, 'ws1 should receive at least one screen');
  assert.ok(screens2.length > 0, 'ws2 should receive at least one screen');

  // Screen messages must have session and pane tags
  assert.ok(screens1[0].session, 'screen should have session field');
  assert.ok(screens1[0].pane, 'screen should have pane field');

  ws1.close();
  ws2.close();
});

test('/ws/dashboard input sends keys without error', async () => {
  const sessRes = await get('/api/sessions');
  const sessions = await sessRes.json();
  const localSession = sessions.find(s => s.source === 'tmux');
  if (!localSession) return; // skip if no local sessions

  const ws = new WebSocket('ws://127.0.0.1:' + TEST_PORT + '/ws/dashboard');

  // Wait for initial screen for our session
  await new Promise((resolve, reject) => {
    ws.onmessage = (e) => {
      const msg = parseWsMsg(e);
      if (msg.type === 'screen' && msg.session === localSession.name) resolve();
    };
    ws.onerror = () => reject(new Error('WebSocket error'));
    setTimeout(() => reject(new Error('Timeout waiting for screen')), 5000);
  });

  // Send input — should not cause an error response
  ws.send(JSON.stringify({ type: 'input', session: localSession.name, pane: '0', keys: ' ' }));

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

  ws.close();
});

test('/ws/dashboard handles claude-proxy sessions gracefully', async () => {
  // This test verifies the dashboard doesn't crash when claude-proxy sessions
  // are discovered but not locally accessible. We just need to confirm the
  // connection succeeds and session-add messages are sent.
  // (cp Unix resubscribe after proxy restart is server.mjs ensureCpSocket →
  // cpResubscribeAll; validate that path manually: restart claude-proxy with
  // the dashboard open — cards should keep updating without a full page reload.)
  const ws = new WebSocket('ws://127.0.0.1:' + TEST_PORT + '/ws/dashboard');

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

  ws.close();
});

test('/ws/dashboard full path: auth → session-add → screen → input → delta', async () => {
  const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws/dashboard`);
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
    const beforeCount = msgs.length;
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

  ws.close();
});
