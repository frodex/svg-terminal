// test-server.mjs
// Tests for server.mjs HTTP server

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

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

test('returns 404 or 500 for nonexistent session', async () => {
  const res = await get('/api/pane?session=nonexistent_session_xyz&pane=0');
  assert.ok(res.status === 404 || res.status === 500, `Expected 404 or 500, got ${res.status}`);
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
