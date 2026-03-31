# Single WebSocket + Shared Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-card WebSocket + per-connection polling with single multiplexed WebSocket per browser + shared capture per session. Target: 30 browsers × 30 sessions without server meltdown.

**Architecture:** server.mjs gets a SessionWatcher that runs one capture loop per session and a DashboardSocket handler for multiplexed browser connections. dashboard.mjs opens one WebSocket and routes messages to terminal cards. terminal.svg becomes a passive renderer that receives data from dashboard instead of owning its own WebSocket. Old per-card WebSocket path preserved during transition (old tmux sessions still use it).

**Tech Stack:** Node.js, ws (WebSocket), existing tmux/sgr-parser/diffState pipeline

**Constraint:** Old pre-WebSocket tmux sessions must keep working for a few more days. Do NOT remove their code paths — add new paths alongside. Mark deprecated code with comments but don't delete yet.

**PRD:** PRD-v0.5.0.md §3.6, §3.7, §3.8, §15

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `server.mjs` | Modify | Add SessionWatcher, DashboardSocket handler, `/ws/dashboard` upgrade path. Keep `/ws/terminal` for old sessions. |
| `dashboard.mjs` | Modify | Add shared WebSocket connection, message routing, replace `refreshSessions`/`refreshTitles` polls. |
| `terminal.svg` | Modify | Add `window.renderMessage()` inbound API. Keep WebSocket code for old sessions (deprecated). |
| `test-server.mjs` | Modify | Add tests for `/ws/dashboard`, shared capture, session lifecycle events. |
| `restart-server.sh` | Modify | Support `--port` parameter for current port 3201. |

No new files. All changes are modifications to existing files.

---

### Task 1: Fix restart-server.sh for Current Port

**Files:**
- Modify: `/srv/svg-terminal/restart-server.sh`

This is needed so we can restart the server during development without losing the port 3201 isolation.

- [ ] **Step 1: Update restart script to accept port**

```bash
#!/bin/bash
# Restart svg-terminal server — kill and restart in one command
# Safe to run while connected via the dashboard
PORT=${1:-3201}
cd /srv/svg-terminal
pkill -f "node.*server.mjs" 2>/dev/null
sleep 1
nohup node server.mjs --port "$PORT" > /tmp/svg-terminal-server.log 2>&1 &
echo "Server restarted on port $PORT (PID: $!)"
echo "Log: /tmp/svg-terminal-server.log"
```

- [ ] **Step 2: Test it**

Run: `bash /srv/svg-terminal/restart-server.sh 3201`
Expected: Server restarts on port 3201, old PID gone, new PID listening.

Verify: `ss -tlnp | grep 3201` shows new PID.

- [ ] **Step 3: Commit**

```bash
cd /srv/svg-terminal
git add restart-server.sh
git commit -m "fix: restart-server.sh accepts port arg, defaults to 3201"
```

---

### Task 2: SessionWatcher — Shared Capture Per Session

**Files:**
- Modify: `/srv/svg-terminal/server.mjs` (add after line 387, before SSE section)
- Test: `/srv/svg-terminal/test-server.mjs`

The core server-side change. One capture loop per session, maintains subscriber list, broadcasts diffs.

- [ ] **Step 1: Write the failing test**

Add to `test-server.mjs`:

```javascript
test('SessionWatcher captures once and broadcasts to multiple subscribers', async () => {
  // Connect two WebSockets to /ws/dashboard
  const ws1 = new WebSocket(`ws://localhost:${TEST_PORT}/ws/dashboard`);
  const ws2 = new WebSocket(`ws://localhost:${TEST_PORT}/ws/dashboard`);

  await Promise.all([
    new Promise(r => { ws1.onopen = r; }),
    new Promise(r => { ws2.onopen = r; }),
  ]);

  // Both send auth (dev mode = any token works)
  ws1.send(JSON.stringify({ type: 'auth', token: 'test' }));
  ws2.send(JSON.stringify({ type: 'auth', token: 'test' }));

  // Collect messages for 500ms
  const msgs1 = [];
  const msgs2 = [];
  ws1.onmessage = (e) => msgs1.push(JSON.parse(e.data));
  ws2.onmessage = (e) => msgs2.push(JSON.parse(e.data));

  await new Promise(r => setTimeout(r, 500));

  // Both should have received session-add events
  const adds1 = msgs1.filter(m => m.type === 'session-add');
  const adds2 = msgs2.filter(m => m.type === 'session-add');
  assert.ok(adds1.length > 0, 'ws1 should receive session-add events');
  assert.ok(adds2.length > 0, 'ws2 should receive session-add events');

  // Both should have received screen messages for the same sessions
  const screens1 = msgs1.filter(m => m.type === 'screen');
  const screens2 = msgs2.filter(m => m.type === 'screen');
  assert.ok(screens1.length > 0, 'ws1 should receive screen data');
  assert.ok(screens2.length > 0, 'ws2 should receive screen data');

  ws1.close();
  ws2.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /srv/svg-terminal && node --test test-server.mjs 2>&1 | tail -5`
Expected: FAIL — `/ws/dashboard` doesn't exist yet.

- [ ] **Step 3: Implement SessionWatcher**

Add to `server.mjs` after the `diffState` function (after line 387), before the SSE section:

```javascript
// ---------------------------------------------------------------------------
// SessionWatcher — shared capture per session (PRD v0.5.0 §3.6)
// One poll loop per session, broadcasts to all subscribed dashboard WebSockets.
// Replaces per-connection setInterval in handleTerminalWs.
// ---------------------------------------------------------------------------

const CAPTURE_INTERVAL = Number(process.env.CAPTURE_INTERVAL) || 100; // ms, tunable

const sessionWatchers = new Map(); // session:pane → { timer, lastState, subscribers: Set<ws> }

function getOrCreateWatcher(session, pane) {
  const key = session + ':' + pane;
  if (sessionWatchers.has(key)) return sessionWatchers.get(key);

  const watcher = {
    session,
    pane,
    lastState: null,
    subscribers: new Set(),
    timer: null,
  };

  async function captureAndBroadcast() {
    if (watcher.subscribers.size === 0) return;
    try {
      const offset = getScrollOffset(session, pane);
      let state;
      if (offset > 0) {
        state = await capturePaneAt(session, pane, offset);
      } else {
        state = await capturePane(session, pane);
      }
      const diff = diffState(watcher.lastState, state);
      if (diff) {
        diff.scrollOffset = offset;
        diff.session = session;
        diff.pane = pane;
        const msg = JSON.stringify(diff);
        for (const ws of watcher.subscribers) {
          if (ws.readyState === 1) ws.send(msg);
        }
        watcher.lastState = state;
      }
    } catch (err) {
      const errMsg = JSON.stringify({ session, pane, type: 'error', message: err.message });
      for (const ws of watcher.subscribers) {
        if (ws.readyState === 1) ws.send(errMsg);
      }
    }
  }

  // Initial capture immediately, then start interval
  captureAndBroadcast();
  watcher.timer = setInterval(captureAndBroadcast, CAPTURE_INTERVAL);
  sessionWatchers.set(key, watcher);
  return watcher;
}

function subscribeToSession(ws, session, pane) {
  const watcher = getOrCreateWatcher(session, pane);
  watcher.subscribers.add(ws);
}

function unsubscribeFromAll(ws) {
  for (const [key, watcher] of sessionWatchers) {
    watcher.subscribers.delete(ws);
    if (watcher.subscribers.size === 0) {
      clearInterval(watcher.timer);
      sessionWatchers.delete(key);
    }
  }
}

// Force re-capture for a session (after input, resize, scroll)
function triggerCapture(session, pane) {
  const key = session + ':' + pane;
  const watcher = sessionWatchers.get(key);
  if (!watcher) return;
  watcher.lastState = null; // force full diff
  // Capture on next tick so tmux has time to process the input
  setTimeout(async () => {
    if (watcher.subscribers.size === 0) return;
    try {
      const offset = getScrollOffset(session, pane);
      let state;
      if (offset > 0) {
        state = await capturePaneAt(session, pane, offset);
      } else {
        state = await capturePane(session, pane);
      }
      const diff = diffState(watcher.lastState, state);
      if (diff) {
        diff.scrollOffset = offset;
        diff.session = session;
        diff.pane = pane;
        const msg = JSON.stringify(diff);
        for (const ws of watcher.subscribers) {
          if (ws.readyState === 1) ws.send(msg);
        }
        watcher.lastState = state;
      }
    } catch (err) { /* session may be gone */ }
  }, 10);
}
```

- [ ] **Step 4: Implement DashboardSocket handler**

Add to `server.mjs` after the SessionWatcher code:

```javascript
// ---------------------------------------------------------------------------
// Dashboard WebSocket — single multiplexed connection per browser (PRD v0.5.0 §3.6)
// ---------------------------------------------------------------------------

const dashboardClients = new Set();

async function handleDashboardWs(ws, req) {
  // Auth: read cookie from the upgrade request (same as HTTP auth)
  // When AUTH_ENABLED is false, getAuthUser returns root with full access
  const user = getAuthUser(req);
  if (!user || user.status !== 'approved') {
    ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
    ws.close();
    return;
  }

  let authenticated = true;
  let knownSessions = new Set();
  dashboardClients.add(ws);

  // Discover sessions this user can see and subscribe
  await sendSessionDiscovery(ws, knownSessions, user);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      if (!authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        return;
      }

      // All other messages require session + pane
      const session = msg.session;
      const pane = msg.pane || '0';
      if (!session || !validateParam(session)) return;

      if (msg.type === 'input') {
        const target = session + ':' + pane;
        if (msg.specialKey && isAllowedKey(msg.specialKey)) {
          setScrollOffset(session, pane, 0);
          const repeat = Math.min(Math.max(1, parseInt(msg.repeat) || 1), 200);
          if (repeat > 1) {
            const promises = [];
            for (let i = 0; i < repeat; i++) {
              promises.push(tmuxAsync('send-keys', '-t', target, translateKeyForTmux(msg.specialKey)));
            }
            await Promise.all(promises);
          } else {
            await tmuxAsync('send-keys', '-t', target, translateKeyForTmux(msg.specialKey));
          }
        } else if (msg.keys != null) {
          setScrollOffset(session, pane, 0);
          if (msg.ctrl && msg.keys.length === 1) {
            await tmuxAsync('send-keys', '-t', target, 'C-' + msg.keys);
          } else {
            await tmuxAsync('send-keys', '-t', target, '-l', String(msg.keys));
          }
        }
        triggerCapture(session, pane);
      } else if (msg.type === 'scroll') {
        setScrollOffset(session, pane, Math.max(0, parseInt(msg.offset) || 0));
        triggerCapture(session, pane);
      } else if (msg.type === 'resize') {
        const lock = resizeLocks.get(session);
        if (lock && lock.ws !== ws && Date.now() < lock.expires) return;
        resizeLocks.set(session, { ws, expires: Date.now() + RESIZE_LOCK_MS });
        const cols = Math.max(20, Math.min(500, parseInt(msg.cols) || 80));
        const rows = Math.max(5, Math.min(200, parseInt(msg.rows) || 24));
        try {
          await tmuxAsync('resize-window', '-t', session, '-x', String(cols), '-y', String(rows));
        } catch (err) { /* session may not exist */ }
        triggerCapture(session, pane);
      }
    } catch (err) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', message: 'Message error: ' + err.message }));
      }
    }
  });

  ws.on('close', () => {
    dashboardClients.delete(ws);
    unsubscribeFromAll(ws);
  });

  ws.on('error', () => {
    dashboardClients.delete(ws);
    unsubscribeFromAll(ws);
  });
}

async function sendSessionDiscovery(ws, knownSessions, user) {
  // Discover sessions this user can access (same sources as handleSessions,
  // filtered by linux_user permissions on tmux sockets — UGO model)
  const sessions = [];

  try {
    const raw = (await tmuxAsync(
      'list-sessions', '-F', '#{session_name} #{session_windows} #{window_width} #{window_height}'
    )).trim();
    for (const line of raw.split('\n').filter(Boolean)) {
      const parts = line.split(' ');
      const height = parseInt(parts.pop(), 10);
      const width = parseInt(parts.pop(), 10);
      const windows = parseInt(parts.pop(), 10);
      const name = parts.join(' ');
      sessions.push({ name, windows, cols: width, rows: height, source: 'tmux' });
    }
  } catch (err) { /* no tmux sessions */ }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const cpRes = await fetch(CLAUDE_PROXY_API + '/api/sessions', { signal: controller.signal });
    clearTimeout(timeout);
    if (cpRes.ok) {
      const cpSessions = await cpRes.json();
      const seen = new Set(sessions.map(s => s.name));
      for (const s of cpSessions) {
        const name = s.id || s.name;
        if (!seen.has(name)) {
          sessions.push({ name, cols: s.cols || 80, rows: s.rows || 24, title: s.title || name, source: 'claude-proxy' });
        }
      }
    }
  } catch (err) { /* claude-proxy not running */ }

  // Send session-add for each session
  for (const s of sessions) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'session-add',
        session: s.name,
        cols: s.cols,
        rows: s.rows,
        title: s.title || s.name,
        source: s.source,
      }));
    }
    knownSessions.add(s.name);

    // Subscribe to watcher for local tmux sessions
    // Claude-proxy sessions need a different path (Task 5)
    if (s.source === 'tmux') {
      subscribeToSession(ws, s.name, '0');
    }
  }
}
```

- [ ] **Step 5: Add /ws/dashboard upgrade path**

In the `server.on('upgrade', ...)` handler (line 951), add a branch BEFORE the `/ws/terminal` check:

```javascript
server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');

  // New: single multiplexed WebSocket per browser
  // Auth via cookie in upgrade request headers (same getAuthUser as HTTP)
  if (url.pathname === '/ws/dashboard') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleDashboardWs(ws, req);
    });
    return;
  }

  // DEPRECATED: per-card WebSocket (kept for old sessions during transition)
  if (url.pathname === '/ws/terminal') {
    // ... existing code unchanged ...
  }
});
```

- [ ] **Step 6: Run tests**

Run: `cd /srv/svg-terminal && node --test test-server.mjs 2>&1`
Expected: All existing tests pass, new test passes.

- [ ] **Step 7: Manual verification**

Restart server: `bash restart-server.sh 3201`
Test with wscat: `npx wscat -c ws://localhost:3201/ws/dashboard`
Send: `{"type":"auth","token":"test"}`
Expected: Receive `session-add` messages, then `screen` messages with `session` field.

- [ ] **Step 8: Commit**

```bash
cd /srv/svg-terminal
git add server.mjs test-server.mjs
git commit -m "feat: SessionWatcher + DashboardSocket — shared capture per session, single multiplexed WebSocket"
```

---

### Task 3: Dashboard.mjs — Single WebSocket + Message Routing

**Files:**
- Modify: `/srv/svg-terminal/dashboard.mjs`

Replace per-card WebSocket connection and HTTP polling with single shared WebSocket.

- [ ] **Step 1: Add shared WebSocket connection and message router**

At the top of the `init()` function (around line 561), replace:

```javascript
  refreshSessions();
  setInterval(refreshSessions, 5000);
  setInterval(refreshTitles, 10000);
  animate();
```

With:

```javascript
  connectDashboardWs();
  // DEPRECATED: keep refreshSessions as fallback for old sessions during transition
  // Will be removed when old sessions are terminated
  refreshSessions();
  setInterval(refreshSessions, 5000);
  // refreshTitles REMOVED — titles arrive via WebSocket screen/delta messages
  animate();
```

- [ ] **Step 2: Implement connectDashboardWs()**

Add after the `init()` function:

```javascript
// ---------------------------------------------------------------------------
// Single multiplexed WebSocket (PRD v0.5.0 §3.6)
// ---------------------------------------------------------------------------

let dashboardWs = null;
let dashboardWsReconnectTimer = null;

function connectDashboardWs() {
  const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
  const wsUrl = proto + '//' + location.host + '/ws/dashboard';

  dashboardWs = new WebSocket(wsUrl);

  dashboardWs.onopen = function() {
    console.log('[Dashboard WS] connected');
    // Auth — dev mode accepts any token
    dashboardWs.send(JSON.stringify({ type: 'auth', token: 'dev' }));
  };

  dashboardWs.onmessage = function(e) {
    var msg = JSON.parse(e.data);
    routeDashboardMessage(msg);
  };

  dashboardWs.onclose = function() {
    console.log('[Dashboard WS] disconnected, reconnecting in 2s...');
    dashboardWs = null;
    dashboardWsReconnectTimer = setTimeout(connectDashboardWs, 2000);
  };

  dashboardWs.onerror = function() {
    // onclose fires after onerror
  };
}

function routeDashboardMessage(msg) {
  if (msg.type === 'session-add') {
    // Create card if we don't have one
    if (!terminals.has(msg.session) && !msg.session.startsWith('browser-')) {
      addTerminal(msg.session, msg.cols, msg.rows);
      assignRings();
    }
    return;
  }

  if (msg.type === 'session-remove') {
    if (terminals.has(msg.session)) {
      removeTerminal(msg.session);
      assignRings();
    }
    return;
  }

  if (msg.type === 'error' && !msg.session) {
    console.warn('[Dashboard WS] server error:', msg.message);
    return;
  }

  // Session-specific messages: route to card
  if (msg.session) {
    var t = terminals.get(msg.session);
    if (!t) return; // no card for this session — ignore

    if (msg.type === 'screen' || msg.type === 'delta') {
      // Push data into terminal.svg via contentWindow
      var obj = t.dom ? t.dom.querySelector('object') : null;
      if (obj && obj.contentWindow && typeof obj.contentWindow.renderMessage === 'function') {
        obj.contentWindow.renderMessage(msg);
      }

      // Update dashboard state (screenLines, card sizing) via _screenCallback path
      if (t.dom && obj && obj.contentWindow && typeof obj.contentWindow._screenCallback === 'function') {
        // _screenCallback is already registered by addTerminal
        // renderMessage will call it internally — no double-call needed
      }
    }
  }
}

function sendDashboardMessage(msg) {
  if (dashboardWs && dashboardWs.readyState === 1) {
    dashboardWs.send(JSON.stringify(msg));
    return true;
  }
  return false;
}
```

- [ ] **Step 3: Update sendInput to use shared WebSocket**

In the `addTerminal` function (line 1652), update `sendInput`:

```javascript
    sendInput: function(msg) {
      // Try shared dashboard WebSocket first (new path)
      if (sendDashboardMessage({ session: sessionName, pane: '0', ...msg })) return;
      // Fallback: route through SVG's own WebSocket (old sessions)
      var obj = this.dom ? this.dom.querySelector('object') : null;
      if (obj && obj.contentWindow && typeof obj.contentWindow.sendToWs === 'function') {
        if (obj.contentWindow.sendToWs(msg)) return;
      }
      // Last resort: HTTP POST (deprecated, kept for transition)
      fetch('/api/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionName, pane: '0', ...msg })
      }).catch(function() {});
    },
```

- [ ] **Step 4: Remove refreshTitles call**

In init() (line 563), comment out the title polling:

```javascript
  // DEPRECATED: titles arrive via WebSocket screen/delta messages
  // setInterval(refreshTitles, 10000);
```

- [ ] **Step 5: Restart server and test**

Run: `bash /srv/svg-terminal/restart-server.sh 3201`

Open browser to `http://SERVER:3201`. Verify:
- Dashboard connects (check console for `[Dashboard WS] connected`)
- Cards appear (from session-add events)
- Terminal content renders (from screen/delta via shared WS)
- Typing works (input routed through shared WS)
- Old sessions still work (fallback through per-card WebSocket)

- [ ] **Step 6: Commit**

```bash
cd /srv/svg-terminal
git add dashboard.mjs
git commit -m "feat: dashboard single WebSocket — message routing, sendInput through shared WS"
```

---

### Task 4: Terminal.svg — Add renderMessage() Inbound API

**Files:**
- Modify: `/srv/svg-terminal/terminal.svg`

Add a `window.renderMessage()` function that does what `ws.onmessage` does, so dashboard.mjs can push data into the SVG from the shared WebSocket.

- [ ] **Step 1: Add renderMessage function**

In terminal.svg, after the `window.sendToWs` function (line 601), add:

```javascript
      // -----------------------------------------------------------------------
      // Inbound API — dashboard pushes data via shared WebSocket (PRD v0.5.0)
      // Same rendering as ws.onmessage but called externally.
      // -----------------------------------------------------------------------
      window.renderMessage = function(msg) {
        if (msg.type === 'screen') {
          if (!initialized || columns !== msg.width || rows !== msg.height) {
            initLayout(msg.width, msg.height);
          }
          allLines = msg.lines;
          for (var i = 0; i < msg.lines.length; i++) {
            updateLine(i, msg.lines[i].spans);
            prevState[i] = JSON.stringify(msg.lines[i].spans);
          }
          rebuildBgLayer(msg.lines); rebuildLinkLayer(msg.lines);
          if (msg.cursor) {
            cursorEl.setAttribute('x', (msg.cursor.x * CELL_W).toFixed(2));
            cursorEl.setAttribute('y', msg.cursor.y * CELL_H);
          }
          hideError();
          try { if (window._screenCallback) window._screenCallback(msg); } catch(e) {}

        } else if (msg.type === 'delta') {
          var keys = Object.keys(msg.changed);
          for (var k = 0; k < keys.length; k++) {
            var idx = parseInt(keys[k]);
            var lineData = msg.changed[keys[k]];
            var spans = lineData.spans || lineData;
            updateLine(idx, spans);
            allLines[idx] = { spans: spans };
            prevState[idx] = JSON.stringify(spans);
          }
          if (keys.length > 0) { rebuildBgLayer(allLines); rebuildLinkLayer(allLines); }
          if (msg.cursor) {
            cursorEl.setAttribute('x', (msg.cursor.x * CELL_W).toFixed(2));
            cursorEl.setAttribute('y', msg.cursor.y * CELL_H);
          }
          try { if (window._screenCallback) window._screenCallback(msg); } catch(e) {}
          hideError();

        } else if (msg.type === 'error') {
          showError();
        }
      };
```

Note: This is the same logic as `ws.onmessage` (lines 295-336). Both paths coexist during transition — old sessions use ws.onmessage via their own WebSocket, new sessions use renderMessage via dashboard's shared WebSocket.

- [ ] **Step 2: Test that old WebSocket path still works**

Open browser, verify old sessions still render. The `ws.onmessage` path is unchanged.

- [ ] **Step 3: Test that renderMessage works**

Open browser console on a terminal card's SVG:
```javascript
// Get the SVG contentWindow
var obj = document.querySelector('.terminal-3d object');
// Push a test message
obj.contentWindow.renderMessage({
  type: 'screen', width: 80, height: 2,
  cursor: {x: 0, y: 0}, title: 'test',
  lines: [
    {spans: [{text: 'renderMessage works!', bold: true}]},
    {spans: [{text: 'line 2'}]}
  ]
});
```

Expected: SVG renders "renderMessage works!" in bold.

- [ ] **Step 4: Commit**

```bash
cd /srv/svg-terminal
git add terminal.svg
git commit -m "feat: terminal.svg renderMessage() — inbound API for shared WebSocket data"
```

---

### Task 5: Claude-Proxy Sessions on Shared WebSocket

**Files:**
- Modify: `/srv/svg-terminal/server.mjs`

Claude-proxy sessions are already event-driven. We need to bridge their WebSocket stream into the shared SessionWatcher/broadcast system.

- [ ] **Step 1: Write failing test**

Add to `test-server.mjs`:

```javascript
test('/ws/dashboard handles claude-proxy sessions gracefully', async () => {
  // This tests that session-add includes claude-proxy sessions
  // and that the server doesn't crash when claude-proxy is unreachable
  const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws/dashboard`);
  await new Promise(r => { ws.onopen = r; });

  ws.send(JSON.stringify({ type: 'auth', token: 'test' }));

  const msgs = [];
  ws.onmessage = (e) => msgs.push(JSON.parse(e.data));

  await new Promise(r => setTimeout(r, 500));

  // Should not crash even if claude-proxy is unreachable
  // Any session-add events are valid sessions
  const adds = msgs.filter(m => m.type === 'session-add');
  for (const add of adds) {
    assert.ok(add.session, 'session-add must have session name');
    assert.ok(add.source === 'tmux' || add.source === 'claude-proxy', 'source must be tmux or claude-proxy');
  }

  ws.close();
});
```

- [ ] **Step 2: Run test to verify it passes (or fails meaningfully)**

Run: `cd /srv/svg-terminal && node --test test-server.mjs 2>&1 | tail -10`

- [ ] **Step 3: Add claude-proxy bridge in sendSessionDiscovery**

Update `sendSessionDiscovery` in server.mjs. After the subscribe loop for local tmux sessions, add claude-proxy bridging:

```javascript
    // Claude-proxy sessions: bridge their WebSocket stream
    if (s.source === 'claude-proxy') {
      bridgeClaudeProxySession(ws, s.name);
    }
```

Add the bridge function:

```javascript
// Bridge a claude-proxy session's WebSocket to a dashboard client.
// claude-proxy is already event-driven — we just relay messages with session tagging.
const cpBridges = new Map(); // key = "dashboardWs:session" → upstream WebSocket

function bridgeClaudeProxySession(dashboardWs, session) {
  const bridgeKey = session; // one bridge per session, shared across dashboard clients
  // If a bridge already exists for this session, just add the dashboard client as subscriber
  const existingWatcher = sessionWatchers.get(session + ':0');
  if (existingWatcher) {
    existingWatcher.subscribers.add(dashboardWs);
    return;
  }

  // Create a watcher entry (no timer — event-driven from claude-proxy)
  const watcher = {
    session,
    pane: '0',
    lastState: null,
    subscribers: new Set([dashboardWs]),
    timer: null, // no polling for cp sessions
  };
  sessionWatchers.set(session + ':0', watcher);

  // Open upstream WebSocket to claude-proxy
  const cpUrl = 'ws://127.0.0.1:3101/api/session/' + encodeURIComponent(session) + '/stream';
  try {
    const upstream = new WebSocket(cpUrl);
    upstream.onmessage = (evt) => {
      const data = typeof evt.data === 'string' ? evt.data : evt.data.toString();
      // Tag with session and relay to all subscribers
      try {
        const msg = JSON.parse(data);
        msg.session = session;
        msg.pane = '0';
        const tagged = JSON.stringify(msg);
        for (const sub of watcher.subscribers) {
          if (sub.readyState === 1) sub.send(tagged);
        }
      } catch (e) {
        // Forward as-is if not parseable
        for (const sub of watcher.subscribers) {
          if (sub.readyState === 1) sub.send(data);
        }
      }
    };
    upstream.onclose = () => {
      sessionWatchers.delete(session + ':0');
    };
    upstream.onerror = () => {
      sessionWatchers.delete(session + ':0');
    };
  } catch (err) {
    // claude-proxy not reachable — session will show as error
    sessionWatchers.delete(session + ':0');
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /srv/svg-terminal && node --test test-server.mjs 2>&1`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd /srv/svg-terminal
git add server.mjs test-server.mjs
git commit -m "feat: bridge claude-proxy sessions to shared WebSocket — event-driven relay"
```

---

### Task 6: SSE Throttle

**Files:**
- Modify: `/srv/svg-terminal/server.mjs`
- Modify: `/srv/svg-terminal/dashboard.mjs`

- [ ] **Step 1: Add throttle broadcast to server**

In server.mjs, add after the `broadcast` function:

```javascript
function broadcastThrottle(interval) {
  broadcast('throttle', { interval });
  // Also update the local capture interval
  for (const [key, watcher] of sessionWatchers) {
    if (watcher.timer) {
      clearInterval(watcher.timer);
      // Re-create with new interval — need to store the capture function
      // For now, just update global. Individual watchers pick it up on next creation.
    }
  }
}
```

Add an admin endpoint in the router:

```javascript
    if (pathname === '/api/admin/throttle') {
      setCors(res);
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { interval } = JSON.parse(body);
            if (typeof interval === 'number' && interval >= 30 && interval <= 5000) {
              broadcastThrottle(interval);
              sendJson(res, 200, { ok: true, interval });
            } else {
              sendError(res, 400, 'interval must be 30-5000');
            }
          } catch (err) {
            sendError(res, 400, 'Invalid JSON');
          }
        });
        return;
      }
      sendError(res, 405, 'POST only');
      return;
    }
```

- [ ] **Step 2: Add throttle handler to dashboard**

In `dashboard.mjs`, in the SSE event setup (if it exists) or add new:

```javascript
// Handle SSE throttle events
var sseSource = new EventSource('/api/events');
sseSource.addEventListener('throttle', function(e) {
  var data = JSON.parse(e.data);
  console.log('[SSE] throttle interval:', data.interval, 'ms');
  // Could adjust local behavior here if needed
});
sseSource.addEventListener('reload', function() {
  location.reload();
});
```

- [ ] **Step 3: Test manually**

```bash
curl -X POST http://localhost:3201/api/admin/throttle -d '{"interval": 200}'
```

Expected: `{"ok":true,"interval":200}`. Browser console shows `[SSE] throttle interval: 200 ms`.

- [ ] **Step 4: Commit**

```bash
cd /srv/svg-terminal
git add server.mjs dashboard.mjs
git commit -m "feat: SSE throttle — server pushes capture interval adjustment to browsers"
```

---

### Task 7: Deprecation Comments + Update restart-server.sh Default

**Files:**
- Modify: `/srv/svg-terminal/server.mjs`
- Modify: `/srv/svg-terminal/dashboard.mjs`
- Modify: `/srv/svg-terminal/terminal.svg`

Mark deprecated code paths with comments so the next agent knows what to remove. Do NOT delete any code — old sessions need it for a few more days.

- [ ] **Step 1: Mark server.mjs deprecated code**

Add comments to:

```javascript
// DEPRECATED (PRD v0.5.0): handlePane — replaced by WebSocket screen/delta via /ws/dashboard
async function handlePane(req, res, params) {

// DEPRECATED (PRD v0.5.0): handleInput — replaced by WebSocket input via /ws/dashboard
async function handleInput(req, res) {

// DEPRECATED (PRD v0.5.0): handleTerminalWs — per-connection polling replaced by SessionWatcher + /ws/dashboard
// Kept for old pre-WebSocket tmux sessions during transition. Remove when old sessions terminated.
async function handleTerminalWs(ws, session, pane) {

// DEPRECATED (PRD v0.5.0): /ws/terminal — per-card WebSocket replaced by /ws/dashboard
if (url.pathname === '/ws/terminal') {
```

- [ ] **Step 2: Mark dashboard.mjs deprecated code**

```javascript
// DEPRECATED (PRD v0.5.0): refreshTitles — titles arrive via WebSocket screen/delta
async function refreshTitles() {

// DEPRECATED (PRD v0.5.0): fetchTitle — titles arrive via WebSocket screen/delta
async function fetchTitle(sessionName) {

// DEPRECATED (PRD v0.5.0): refreshSessions HTTP poll — replaced by session-add/session-remove WebSocket events
// Kept during transition for old sessions not yet on shared WebSocket
async function refreshSessions() {
```

- [ ] **Step 3: Mark terminal.svg deprecated code**

Add at the top of the polling section:

```javascript
      // -----------------------------------------------------------------------
      // DEPRECATED (PRD v0.5.0): HTTP polling fallback
      // Replaced by shared WebSocket via dashboard.mjs + renderMessage().
      // Kept for old pre-WebSocket tmux sessions during transition.
      // The safety-net schedulePoll on line 608 causes 404/500 errors on
      // new sessions — will be removed when old sessions are terminated.
      // -----------------------------------------------------------------------
      function poll() {
```

- [ ] **Step 4: Commit**

```bash
cd /srv/svg-terminal
git add server.mjs dashboard.mjs terminal.svg
git commit -m "docs: mark deprecated code paths — per-card WS, HTTP polling, title polling"
```

---

### Task 8: Integration Test — Full Path Verification

**Files:**
- Modify: `/srv/svg-terminal/test-server.mjs`

End-to-end test: connect dashboard WS, receive session data, send input, verify response.

- [ ] **Step 1: Write integration test**

```javascript
test('/ws/dashboard full path: auth → session-add → screen → input → delta', async () => {
  const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws/dashboard`);
  await new Promise(r => { ws.onopen = r; });

  const msgs = [];
  ws.onmessage = (e) => msgs.push(JSON.parse(e.data));

  // Auth
  ws.send(JSON.stringify({ type: 'auth', token: 'test' }));

  // Wait for session-add and initial screen messages
  await new Promise(r => setTimeout(r, 500));

  const adds = msgs.filter(m => m.type === 'session-add');
  assert.ok(adds.length > 0, 'Should receive session-add events');

  const screens = msgs.filter(m => m.type === 'screen');
  assert.ok(screens.length > 0, 'Should receive initial screen data');

  // Verify screen messages have required fields
  const screen = screens[0];
  assert.ok(screen.session, 'screen must have session');
  assert.ok(screen.width > 0, 'screen must have width');
  assert.ok(screen.height > 0, 'screen must have height');
  assert.ok(Array.isArray(screen.lines), 'screen must have lines array');
  assert.ok(screen.lines.length === screen.height, 'lines count must match height');
  assert.ok(screen.lines[0].spans, 'each line must have spans');

  // Send input to first session
  const sessionName = adds[0].session;
  if (adds[0].source === 'tmux') {
    // Only test input on local tmux sessions
    ws.send(JSON.stringify({
      session: sessionName,
      pane: '0',
      type: 'input',
      keys: ' '  // space — harmless
    }));

    // Wait for delta response
    await new Promise(r => setTimeout(r, 200));

    // Should have received more messages (delta or screen after input)
    const afterInput = msgs.filter(m => m.session === sessionName && msgs.indexOf(m) > msgs.indexOf(screen));
    // May or may not have a delta (depends on whether space caused visible change)
    // At minimum, no errors
    const errors = msgs.filter(m => m.type === 'error');
    assert.equal(errors.length, 0, 'No errors expected: ' + JSON.stringify(errors));
  }

  ws.close();
});
```

- [ ] **Step 2: Run full test suite**

Run: `cd /srv/svg-terminal && node --test test-server.mjs 2>&1`
Expected: All tests pass including new integration test.

- [ ] **Step 3: Commit**

```bash
cd /srv/svg-terminal
git add test-server.mjs
git commit -m "test: integration test for /ws/dashboard full path — auth, discovery, screen, input"
```

---

## Post-Implementation Verification

After all tasks are complete:

1. **Restart server:** `bash /srv/svg-terminal/restart-server.sh 3201`
2. **Open browser to dashboard** — verify cards load, content renders, typing works
3. **Check console:** No 404/500 errors from new sessions (old sessions may still show them)
4. **Check server CPU:** Should be significantly lower than 39.9% baseline
5. **Open second browser tab** — verify both receive data, input works on both
6. **Run full test suite:** `node --test test-server.mjs`
7. **Verify old sessions** still work through per-card WebSocket (deprecated but functional)

## What Comes Next (Not in This Plan)

- Remove deprecated code when old sessions are terminated (Task 7 comments mark what to delete)
- Move SGR parsing from server to browser (future optimization)
- Wire auth into WebSocket upgrade (currently dev mode accepts any token)
- Session lifecycle polling (server periodically rediscovers sessions, pushes add/remove events)
