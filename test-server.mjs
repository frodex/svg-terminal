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
