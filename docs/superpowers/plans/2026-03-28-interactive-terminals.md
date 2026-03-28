# Interactive Terminals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace polling with WebSocket streaming and add direct keystroke capture so terminals are fully interactive (~15ms latency, vim/htop usable).

**Architecture:** WebSocket server (via `ws` package, already in node_modules) attached to existing HTTP server. Server polls tmux at 30ms, diffs, pushes deltas. Client sends keystrokes through same WebSocket. SVG client falls back to HTTP polling if WebSocket fails. Dashboard captures all keyboard events when a terminal is focused.

**Tech Stack:** Node.js built-in `http` + `ws` (already installed via puppeteer), browser-native `WebSocket`

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `server.mjs` | Modify | Add async tmux helper, WebSocket endpoint, shared pane poller, expanded key whitelist |
| `terminal.svg` | Modify | Add WebSocket client with fallback to polling |
| `dashboard.mjs` | Modify | Direct keystroke capture, per-terminal input WebSocket, paste support |
| `index.html` | Modify | Update input bar to status indicator |
| `dashboard.css` | Modify | Style changes for input status bar |
| `test-server.mjs` | Modify | Add WebSocket endpoint tests |

---

## Task 1: Async tmux helper

**Files:**
- Modify: `/srv/svg-terminal/server.mjs:5-8` (imports), new function after line 8
- Modify: `/srv/svg-terminal/test-server.mjs`

Currently all tmux calls use `execFileSync` which blocks the event loop. With WebSocket streaming and 30ms polling, blocking calls will stall all connections.

- [ ] **Step 1: Write test for async tmux helper**

Add to `/srv/svg-terminal/test-server.mjs`:

```js
test('GET /api/sessions returns valid JSON (async tmux)', async () => {
  const res = await get('/api/sessions');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  // Each session should have name and windows
  if (data.length > 0) {
    assert.ok(typeof data[0].name === 'string');
    assert.ok(typeof data[0].windows === 'number');
  }
});
```

- [ ] **Step 2: Run existing tests to verify they pass before changes**

Run: `cd /srv/svg-terminal && node --test test-server.mjs`

Expected: All existing tests pass.

- [ ] **Step 3: Add async execFile import and tmux helper**

In `/srv/svg-terminal/server.mjs`, change the import on line 7:

```js
// OLD:
import { execFileSync } from 'node:child_process';

// NEW:
import { execFileSync, execFile as execFileCb } from 'node:child_process';
```

Add after line 8 (after the `parseLine` import):

```js
// Async tmux command execution. Returns stdout as string.
// execFileSync is kept for backward compat during migration — remove once all callers are async.
function tmuxAsync(...args) {
  return new Promise((resolve, reject) => {
    execFileCb('tmux', args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
```

- [ ] **Step 4: Convert handlePane to async**

Replace the `handlePane` function (lines 89-145). Change `function handlePane` to `async function handlePane`. Replace all `execFileSync('tmux', [...])` calls with `await tmuxAsync(...)`:

```js
async function handlePane(req, res, params) {
  const session = params.get('session');
  const pane = params.get('pane') || '0';

  if (!session) return sendError(res, 400, 'Missing session parameter');
  if (!validateParam(session)) return sendError(res, 400, 'Invalid session name');
  if (!validateParam(pane)) return sendError(res, 400, 'Invalid pane identifier');

  const target = session + ':' + pane;

  try {
    const raw = await tmuxAsync('capture-pane', '-p', '-e', '-t', target);
    const metaRaw = await tmuxAsync('display-message', '-p', '-t', target,
      '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{pane_title}');

    const metaParts = metaRaw.trim().split(' ');
    const width = parseInt(metaParts[0], 10);
    const height = parseInt(metaParts[1], 10);
    const cursorX = parseInt(metaParts[2], 10);
    const cursorY = parseInt(metaParts[3], 10);
    const title = metaParts.slice(4).join(' ');

    const rawLines = raw.split('\n');
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

    const lines = rawLines.map((line) => ({ spans: parseLine(line) }));

    sendJson(res, 200, {
      width, height,
      cursor: { x: cursorX, y: cursorY },
      title,
      lines,
    });
  } catch (err) {
    sendError(res, 500, 'tmux error: ' + err.message);
  }
}
```

- [ ] **Step 5: Convert handleInput to async**

Replace the `handleInput` function (lines 152-197). Change to `async function handleInput`:

```js
async function handleInput(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'POST only');

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const session = data.session;
      const pane = data.pane || '0';
      if (!session || !validateParam(session) || !validateParam(pane)) {
        return sendError(res, 400, 'Invalid session or pane');
      }

      const target = session + ':' + pane;

      if (data.specialKey) {
        if (!isAllowedKey(data.specialKey)) {
          return sendError(res, 400, 'Invalid special key');
        }
        await tmuxAsync('send-keys', '-t', target, data.specialKey);
      } else if (data.keys != null) {
        await tmuxAsync('send-keys', '-t', target, '-l', String(data.keys));
      } else {
        return sendError(res, 400, 'No keys or specialKey provided');
      }

      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendError(res, 500, 'tmux error: ' + err.message);
    }
  });
}
```

- [ ] **Step 6: Convert handleSessions to async**

Replace the `handleSessions` function (lines 199-221):

```js
async function handleSessions(req, res) {
  try {
    const raw = await tmuxAsync('list-sessions', '-F', '#{session_name} #{session_windows}');
    const sessions = raw.trim().split('\n')
      .filter(line => line.length > 0)
      .map(line => {
        const parts = line.split(' ');
        return { name: parts[0], windows: parseInt(parts[1], 10) || 1 };
      });
    sendJson(res, 200, sessions);
  } catch (err) {
    sendJson(res, 200, []);
  }
}
```

- [ ] **Step 7: Update router to handle async handlers**

The `router` function calls handlers directly. Async handlers return promises that need error handling. Wrap the router's handler calls:

In the router function, anywhere that calls `handlePane`, `handleInput`, or `handleSessions`, wrap with `.catch()`:

```js
// In the router, change direct calls like:
//   handlePane(req, res, params);
// to:
//   handlePane(req, res, params).catch(err => sendError(res, 500, err.message));
```

Apply this pattern to all three async handler calls in the router.

- [ ] **Step 8: Expand allowed special keys**

Replace the `ALLOWED_SPECIAL_KEYS` array (lines 147-150) and add `isAllowedKey`:

```js
const ALLOWED_SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'BSpace', 'DC', 'IC', 'Space',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PgUp', 'PgDn',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

function isAllowedKey(key) {
  return ALLOWED_SPECIAL_KEYS.has(key) || /^C-[a-z]$/.test(key);
}
```

Update the validation in `handleInput` to use `isAllowedKey(data.specialKey)` instead of `ALLOWED_SPECIAL_KEYS.includes(data.specialKey)`.

- [ ] **Step 9: Run tests**

Run: `cd /srv/svg-terminal && node --test test-server.mjs`

Expected: All tests pass (existing + new).

- [ ] **Step 10: Commit**

```bash
cd /srv/svg-terminal
git add server.mjs test-server.mjs
git commit -m "feat: async tmux execution, expanded key whitelist

Switch execFileSync to async execFile for all tmux commands.
Unblocks the event loop for WebSocket streaming.
Expand special key whitelist: F1-F12, PgUp/PgDn, IC, Space, C-a through C-z."
```

---

## Task 2: WebSocket server endpoint

**Files:**
- Modify: `/srv/svg-terminal/server.mjs` (add WebSocket setup after HTTP server creation)
- Modify: `/srv/svg-terminal/test-server.mjs` (add WebSocket tests)

- [ ] **Step 1: Write WebSocket connection test**

Add to `/srv/svg-terminal/test-server.mjs`:

```js
test('WebSocket /ws/terminal connects and receives screen event', async () => {
  // Get a real session name first
  const sessRes = await get('/api/sessions');
  const sessions = await sessRes.json();
  if (sessions.length === 0) {
    // Skip if no tmux sessions
    return;
  }
  const session = sessions[0].name;

  const ws = new WebSocket('ws://127.0.0.1:' + TEST_PORT + '/ws/terminal?session=' + session + '&pane=0');

  const firstMsg = await new Promise((resolve, reject) => {
    ws.onmessage = (e) => resolve(JSON.parse(e.data));
    ws.onerror = (e) => reject(new Error('WebSocket error'));
    setTimeout(() => reject(new Error('Timeout waiting for screen event')), 5000);
  });

  assert.equal(firstMsg.type, 'screen');
  assert.ok(typeof firstMsg.width === 'number');
  assert.ok(typeof firstMsg.height === 'number');
  assert.ok(Array.isArray(firstMsg.lines));
  assert.ok(firstMsg.cursor);

  ws.close();
});
```

Add the WebSocket import at the top of test-server.mjs if not already present. Node.js 22 has a built-in WebSocket client:

```js
// No import needed — WebSocket is global in Node.js 22
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /srv/svg-terminal && node --test test-server.mjs`

Expected: New test fails (WebSocket endpoint doesn't exist yet).

- [ ] **Step 3: Add ws import and WebSocket server setup**

At the top of `/srv/svg-terminal/server.mjs`, add the import:

```js
import { WebSocketServer } from 'ws';
```

After the line where the HTTP server is created (`const server = http.createServer(router);`), add:

```js
// === WebSocket Server ===
// Attached to existing HTTP server — shares port, no new listener needed.
// Uses 'ws' package (already in node_modules via puppeteer — zero new dependencies).
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ws/terminal') {
    const session = url.searchParams.get('session');
    const pane = url.searchParams.get('pane') || '0';
    if (!session || !validateParam(session) || !validateParam(pane)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleTerminalWs(ws, session, pane);
    });
  } else {
    socket.destroy();
  }
});
```

- [ ] **Step 4: Add capturePane helper (extract from handlePane)**

Add a reusable async function that captures pane state and returns the parsed object. This is used by both the HTTP `/api/pane` endpoint and the WebSocket poller:

```js
// Capture tmux pane and return parsed state object.
// Used by both /api/pane HTTP endpoint and WebSocket streaming.
async function capturePane(session, pane) {
  const target = session + ':' + pane;
  const raw = await tmuxAsync('capture-pane', '-p', '-e', '-t', target);
  const metaRaw = await tmuxAsync('display-message', '-p', '-t', target,
    '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{pane_title}');

  const metaParts = metaRaw.trim().split(' ');
  const width = parseInt(metaParts[0], 10);
  const height = parseInt(metaParts[1], 10);
  const cursorX = parseInt(metaParts[2], 10);
  const cursorY = parseInt(metaParts[3], 10);
  const title = metaParts.slice(4).join(' ');

  const rawLines = raw.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const lines = rawLines.map((line) => ({ spans: parseLine(line) }));

  return { width, height, cursor: { x: cursorX, y: cursorY }, title, lines };
}
```

Update `handlePane` to use this helper:

```js
async function handlePane(req, res, params) {
  const session = params.get('session');
  const pane = params.get('pane') || '0';
  if (!session) return sendError(res, 400, 'Missing session parameter');
  if (!validateParam(session)) return sendError(res, 400, 'Invalid session name');
  if (!validateParam(pane)) return sendError(res, 400, 'Invalid pane identifier');

  try {
    const state = await capturePane(session, pane);
    sendJson(res, 200, state);
  } catch (err) {
    sendError(res, 500, 'tmux error: ' + err.message);
  }
}
```

- [ ] **Step 5: Add diff function**

```js
// Compare two pane states. Returns null if identical, {type:'screen',...} for full refresh,
// or {type:'delta', changed:{lineIdx: spans}, cursor, title} for incremental update.
function diffState(prev, curr) {
  if (!prev) return { type: 'screen', width: curr.width, height: curr.height,
    cursor: curr.cursor, title: curr.title, lines: curr.lines };
  if (prev.width !== curr.width || prev.height !== curr.height) {
    return { type: 'screen', width: curr.width, height: curr.height,
      cursor: curr.cursor, title: curr.title, lines: curr.lines };
  }
  const changed = {};
  let anyChanged = false;
  for (let i = 0; i < curr.lines.length; i++) {
    const a = JSON.stringify(prev.lines[i]);
    const b = JSON.stringify(curr.lines[i]);
    if (a !== b) {
      changed[i] = curr.lines[i].spans;
      anyChanged = true;
    }
  }
  if (!anyChanged && prev.cursor.x === curr.cursor.x && prev.cursor.y === curr.cursor.y
      && prev.title === curr.title) {
    return null;
  }
  return { type: 'delta', cursor: curr.cursor, title: curr.title, changed };
}
```

- [ ] **Step 6: Add WebSocket terminal handler**

```js
// Per-connection WebSocket handler for a terminal session/pane.
// Sends screen state immediately, then polls at 30ms and pushes deltas.
// Receives input messages and forwards to tmux.
async function handleTerminalWs(ws, session, pane) {
  let lastState = null;
  let pollTimer = null;

  async function captureAndPush() {
    try {
      const state = await capturePane(session, pane);
      const diff = diffState(lastState, state);
      if (diff && ws.readyState === 1) { // 1 = OPEN
        ws.send(JSON.stringify(diff));
        lastState = state;
      }
    } catch (err) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    }
  }

  // Send initial full state
  await captureAndPush();

  // Poll for background output changes
  pollTimer = setInterval(captureAndPush, 30);

  // Handle client input messages
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'input') {
        const target = session + ':' + pane;
        if (msg.specialKey && isAllowedKey(msg.specialKey)) {
          await tmuxAsync('send-keys', '-t', target, msg.specialKey);
        } else if (msg.keys != null) {
          await tmuxAsync('send-keys', '-t', target, '-l', String(msg.keys));
        }
        // Immediate capture after input for fast feedback
        setTimeout(captureAndPush, 5);
      }
    } catch (err) {
      // Best effort — don't crash on bad input
    }
  });

  ws.on('close', () => {
    clearInterval(pollTimer);
    pollTimer = null;
  });

  ws.on('error', () => {
    clearInterval(pollTimer);
    pollTimer = null;
  });
}
```

- [ ] **Step 7: Run tests**

Run: `cd /srv/svg-terminal && node --test test-server.mjs`

Expected: All tests pass including the new WebSocket test.

- [ ] **Step 8: Write WebSocket input test**

Add to test-server.mjs:

```js
test('WebSocket input sends keys and receives delta', async () => {
  const sessRes = await get('/api/sessions');
  const sessions = await sessRes.json();
  if (sessions.length === 0) return;
  const session = sessions[0].name;

  const ws = new WebSocket('ws://127.0.0.1:' + TEST_PORT + '/ws/terminal?session=' + session + '&pane=0');

  // Wait for initial screen event
  await new Promise((resolve, reject) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'screen') resolve();
    };
    ws.onerror = () => reject(new Error('WebSocket error'));
    setTimeout(() => reject(new Error('Timeout')), 5000);
  });

  // Send a keystroke
  ws.send(JSON.stringify({ type: 'input', keys: ' ' }));

  // Should receive a delta or screen within 100ms
  const response = await new Promise((resolve, reject) => {
    ws.onmessage = (e) => resolve(JSON.parse(e.data));
    setTimeout(() => reject(new Error('No response after input')), 1000);
  });

  assert.ok(response.type === 'screen' || response.type === 'delta');
  ws.close();
});
```

- [ ] **Step 9: Run tests**

Run: `cd /srv/svg-terminal && node --test test-server.mjs`

Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
cd /srv/svg-terminal
git add server.mjs test-server.mjs
git commit -m "feat: WebSocket terminal endpoint with server-side diff

/ws/terminal?session=X&pane=Y — bidirectional WebSocket per terminal.
Server polls tmux at 30ms, diffs line-by-line, pushes deltas.
Input messages forwarded to tmux with immediate re-capture for
~15ms keystroke feedback. Shares capturePane() with HTTP endpoint."
```

---

## Task 3: SVG client WebSocket support

**Files:**
- Modify: `/srv/svg-terminal/terminal.svg` (JavaScript section inside CDATA)

The SVG client currently polls `/api/pane` at 150ms. Add WebSocket connection as primary mode with automatic fallback to polling.

- [ ] **Step 1: Add WebSocket connection variables**

After the existing state variables (`var pollTimer = null;` etc.), add:

```js
var ws = null;
var useWebSocket = false;
var allLines = [];  // full line state for delta updates + rebuildBgLayer
var wsReconnectTimer = null;
```

- [ ] **Step 2: Add WebSocket connect function**

Add before the `poll()` function:

```js
function connectWebSocket() {
  var proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
  var host = SERVER ? SERVER.replace(/^https?:\/\//, '') : location.host;
  var wsUrl = proto + '//' + host + '/ws/terminal?session=' + encodeURIComponent(SESSION) + '&pane=' + encodeURIComponent(PANE);

  ws = new WebSocket(wsUrl);

  ws.onopen = function() {
    useWebSocket = true;
    // Stop polling — WebSocket handles updates now
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    hideError();
  };

  ws.onmessage = function(e) {
    var msg = JSON.parse(e.data);

    if (msg.type === 'screen') {
      if (!initialized || columns !== msg.width || rows !== msg.height) {
        initLayout(msg.width, msg.height);
      }
      allLines = msg.lines;
      for (var i = 0; i < msg.lines.length; i++) {
        updateLine(i, msg.lines[i].spans);
        prevState[i] = JSON.stringify(msg.lines[i].spans);
      }
      rebuildBgLayer(msg.lines);
      if (msg.cursor) {
        cursorEl.setAttribute('x', (msg.cursor.x * CELL_W).toFixed(2));
        cursorEl.setAttribute('y', msg.cursor.y * CELL_H);
      }
      hideError();

    } else if (msg.type === 'delta') {
      var keys = Object.keys(msg.changed);
      for (var k = 0; k < keys.length; k++) {
        var idx = parseInt(keys[k]);
        var spans = msg.changed[keys[k]];
        updateLine(idx, spans);
        allLines[idx] = { spans: spans };
        prevState[idx] = JSON.stringify(spans);
      }
      if (keys.length > 0) rebuildBgLayer(allLines);
      if (msg.cursor) {
        cursorEl.setAttribute('x', (msg.cursor.x * CELL_W).toFixed(2));
        cursorEl.setAttribute('y', msg.cursor.y * CELL_H);
      }

    } else if (msg.type === 'error') {
      showError();
    }
  };

  ws.onclose = function() {
    useWebSocket = false;
    ws = null;
    // Fall back to polling, attempt reconnect after 2s
    if (pollTimer === null) schedulePoll(pollInterval);
    wsReconnectTimer = setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = function() {
    // onclose will fire after onerror — reconnect handled there
  };
}
```

- [ ] **Step 3: Add sendInput function**

```js
function sendInput(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  } else {
    // Fallback to POST
    var url = apiUrl('/api/input');
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: SESSION, pane: PANE, keys: msg.keys, specialKey: msg.specialKey })
    }).catch(function() {});
  }
}
```

- [ ] **Step 4: Modify startup to try WebSocket first**

At the bottom of the script where polling is initiated (the line that calls `schedulePoll(pollInterval)` or `poll()`), change to:

```js
// Try WebSocket first, fall back to polling if it fails
if (SESSION) {
  connectWebSocket();
  // Also start polling as safety net — WebSocket onopen will stop it
  schedulePoll(pollInterval);
}
```

- [ ] **Step 5: Update poll() to skip if WebSocket is active**

At the top of the `poll()` function, add:

```js
function poll() {
  // Skip if WebSocket is handling updates
  if (useWebSocket) return;

  pollTimer = null;
  // ... rest of existing poll code
```

- [ ] **Step 6: Test manually**

Start the server and open a terminal SVG in the browser:

```bash
cd /srv/svg-terminal && node server.mjs &
```

Open `http://localhost:3200/terminal?session=<session_name>` in Chrome. Open DevTools Network tab — you should see a WebSocket connection to `/ws/terminal`. Terminal output should update without HTTP polling.

- [ ] **Step 7: Test fallback**

Temporarily break the WebSocket URL (e.g., change the path) and verify the terminal falls back to polling. Fix after testing.

- [ ] **Step 8: Commit**

```bash
cd /srv/svg-terminal
git add terminal.svg
git commit -m "feat: WebSocket streaming in SVG client with polling fallback

SVG terminal connects via WebSocket for real-time output.
Falls back to HTTP polling if WebSocket fails.
allLines[] tracks full state for delta updates.
Reconnects automatically after 2s on disconnect."
```

---

## Task 4: Direct keystroke capture in dashboard

**Files:**
- Modify: `/srv/svg-terminal/dashboard.mjs`
- Modify: `/srv/svg-terminal/index.html`
- Modify: `/srv/svg-terminal/dashboard.css`

Replace the input bar text field with direct keystroke capture. When a terminal is focused, ALL keyboard events go to tmux.

- [ ] **Step 1: Add key translation map**

In `/srv/svg-terminal/dashboard.mjs`, add after the existing constants section:

```js
// === Key Translation (browser KeyboardEvent → tmux send-keys) ===
// Maps browser key names to tmux special key names.
// Regular printable characters are sent as literal text, not through this map.
const SPECIAL_KEY_MAP = {
  'Enter': 'Enter',
  'Tab': 'Tab',
  'Escape': 'Escape',
  'Backspace': 'BSpace',
  'Delete': 'DC',
  'ArrowUp': 'Up',
  'ArrowDown': 'Down',
  'ArrowLeft': 'Left',
  'ArrowRight': 'Right',
  'Home': 'Home',
  'End': 'End',
  'PageUp': 'PgUp',
  'PageDown': 'PgDn',
  'Insert': 'IC',
  'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
  'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
  'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
  ' ': 'Space',
};
```

- [ ] **Step 2: Add per-terminal sendInput method and inputWs**

In `addTerminal()`, add `inputWs` and `sendInput` to the terminal object:

```js
terminals.set(sessionName, {
  // ... existing fields ...
  inputWs: null,
  sendInput: function(msg) {
    if (this.inputWs && this.inputWs.readyState === WebSocket.OPEN) {
      this.inputWs.send(JSON.stringify(msg));
    } else {
      // POST fallback
      fetch('/api/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionName, pane: '0', ...msg })
      }).catch(function() {});
    }
  }
});
```

- [ ] **Step 3: Open/close input WebSocket on focus/unfocus**

In `focusTerminal()`, after setting `activeInputSession`, open an input WebSocket:

```js
// Open input WebSocket for focused terminal
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
t.inputWs = new WebSocket(proto + '//' + location.host + '/ws/terminal?session=' + encodeURIComponent(sessionName) + '&pane=0');
```

In `addToFocus()`, do the same for the newly added terminal:

```js
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
t.inputWs = new WebSocket(proto + '//' + location.host + '/ws/terminal?session=' + encodeURIComponent(sessionName) + '&pane=0');
```

In `restoreFocusedTerminal()`, close the WebSocket:

```js
if (term.inputWs) {
  term.inputWs.close();
  term.inputWs = null;
}
```

- [ ] **Step 4: Replace input bar keydown handler with document-level keystroke capture**

Remove the existing `inputBox` keydown handler (the `if (inputBox)` block near the bottom of dashboard.mjs). Replace with:

```js
// === Direct Keystroke Capture ===
// When a terminal is focused, ALL keyboard events go to tmux via WebSocket.
// Browser shortcuts (Ctrl+T, Ctrl+W, etc.) are excluded.
// This replaces the input bar text field.
document.addEventListener('keydown', function(e) {
  if (!activeInputSession) return;
  if (focusedSessions.size === 0) return;

  // Don't capture when help panel is open
  if (document.getElementById('help-panel').classList.contains('visible')) return;

  // Let browser shortcuts through
  if ((e.ctrlKey || e.metaKey) && ['t', 'w', 'n', 'r'].includes(e.key.toLowerCase())) return;
  if (e.altKey && e.key === 'F4') return;
  if (e.key === 'F12') return; // DevTools

  // Don't interfere with our own ctrl+click / shift+drag controls
  // Only pass through to terminal if it's a terminal-relevant key
  if (e.ctrlKey && e.key === 'Control') return; // bare Ctrl press
  if (e.shiftKey && e.key === 'Shift') return;  // bare Shift press

  e.preventDefault();

  const t = terminals.get(activeInputSession);
  if (!t) return;

  // Ctrl combos
  if (e.ctrlKey && e.key.length === 1) {
    t.sendInput({ type: 'input', specialKey: 'C-' + e.key.toLowerCase() });
    return;
  }

  // Special keys
  if (SPECIAL_KEY_MAP[e.key]) {
    t.sendInput({ type: 'input', specialKey: SPECIAL_KEY_MAP[e.key] });
    return;
  }

  // Regular printable characters
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    t.sendInput({ type: 'input', keys: e.key });
  }
});

// Paste support
document.addEventListener('paste', function(e) {
  if (!activeInputSession) return;
  if (focusedSessions.size === 0) return;
  e.preventDefault();
  const text = e.clipboardData.getData('text');
  if (text) {
    const t = terminals.get(activeInputSession);
    if (t) t.sendInput({ type: 'input', keys: text });
  }
});
```

- [ ] **Step 5: Update input bar HTML**

In `/srv/svg-terminal/index.html`, replace the input bar:

```html
<!-- Input status bar (shows active terminal, keystrokes captured at document level) -->
<div class="input-bar" id="input-bar">
  <span class="status-dot" id="ws-status"></span>
  <span class="target" id="input-target"></span>
  <span class="input-hint">Keys go to terminal</span>
</div>
```

- [ ] **Step 6: Update input bar CSS**

In `/srv/svg-terminal/dashboard.css`, add styles for the status dot and hint:

```css
.input-bar .status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #28c840;
  display: inline-block;
  flex-shrink: 0;
}

.input-bar .status-dot.disconnected {
  background: #ff5f57;
}

.input-bar .input-hint {
  color: #555;
  font-size: 11px;
  margin-left: auto;
}
```

Remove the old `input-bar input` and `input-bar input:focus` CSS rules since the text field is gone.

- [ ] **Step 7: Remove old sendKeys/sendSpecialKey functions**

The old `sendKeys` and `sendSpecialKey` functions at the bottom of dashboard.mjs are no longer needed — input goes through `t.sendInput()`. Remove them:

```js
// REMOVE these functions:
// async function sendKeys(session, keys) { ... }
// async function sendSpecialKey(session, key) { ... }
```

- [ ] **Step 8: Test manually**

Open the dashboard, click a terminal to focus it, type characters. They should appear in the terminal. Test:
- Regular text input
- Enter, Tab, Backspace
- Ctrl+C, Ctrl+D
- Arrow keys
- Paste (Ctrl+V)
- Escape to unfocus

- [ ] **Step 9: Commit**

```bash
cd /srv/svg-terminal
git add dashboard.mjs index.html dashboard.css
git commit -m "feat: direct keystroke capture replaces input bar

All keyboard events forwarded to tmux when terminal is focused.
Per-terminal WebSocket for input. Key translation map for special
keys and Ctrl combos. Paste support via clipboard API.
Input bar becomes status indicator (green dot + session name)."
```

---

## Task 5: Version bump and documentation

**Files:**
- Modify: `/srv/svg-terminal/package.json`
- Modify: `/srv/svg-terminal/sessions.md`
- Create: `/srv/svg-terminal/docs/research/2026-03-28-v0.5-svg-terminal-viewer-journal.md`
- Modify: `/srv/svg-terminal/docs/bibliography.md`

- [ ] **Step 1: Bump version to 0.3.0**

In `/srv/svg-terminal/package.json`, change `"version": "0.2.0"` to `"version": "0.3.0"`.

- [ ] **Step 2: Create journal v0.5**

Create `/srv/svg-terminal/docs/research/2026-03-28-v0.5-svg-terminal-viewer-journal.md`:

Document:
- WebSocket architecture decision (SSE considered, rejected for ws package)
- The ws package was already installed (puppeteer dep)
- Server-side diff moved from client to server
- 30ms server poll + immediate capture after input = ~15ms latency
- Direct keystroke capture replacing input bar
- Key translation challenges

- [ ] **Step 3: Update sessions.md**

Add to Key Technical Decisions:
```
[2026-03-28] Interactive terminals: WebSocket via ws package (already in node_modules via puppeteer)
[2026-03-28] Server-side diff: server polls tmux at 30ms, pushes only changed lines
[2026-03-28] Direct keystroke capture: document-level keydown handler replaces input bar text field
[2026-03-28] Async tmux: execFileSync → async execFile to unblock event loop for WebSocket
```

- [ ] **Step 4: Update bibliography**

Add rows for ws package and RFC 6455 if referenced during implementation.

- [ ] **Step 5: Commit**

```bash
cd /srv/svg-terminal
git add package.json sessions.md docs/
git commit -m "docs: v0.3.0 — interactive terminals journal, sessions update

Version bump to 0.3.0 for WebSocket interactive terminals.
Journal v0.5 documents architecture decisions.
Sessions.md updated with key technical decisions."
```

---

## Execution Notes

- **Task 1 must complete first** — Tasks 2-4 depend on async tmux and expanded key whitelist.
- **Task 2 must complete before Task 3** — SVG client needs the WebSocket endpoint to exist.
- **Task 3 and Task 4 are independent** — they can be implemented in parallel after Task 2.
- **Task 5 is documentation** — do after all code tasks complete.
- **The existing HTTP API stays** — backward compat for any clients not upgraded to WebSocket.
- **Read the header comments in dashboard.mjs** before modifying — they document critical anti-patterns and bugs that were hard to fix. See notes 1-8 in the file header.
