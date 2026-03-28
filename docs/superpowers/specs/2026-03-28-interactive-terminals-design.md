# Interactive Terminals — Design Spec

## Goal

Replace the polling-based read-only terminal viewer with a real-time interactive terminal. Keystrokes go directly to tmux, output streams back instantly. Programs like vim, htop, and tab completion work naturally.

## Architecture

**WebSocket** using the `ws` package (already installed as a transitive dependency of puppeteer — no new dependency added).

Single bidirectional WebSocket connection per terminal:
```
Client ←→ Server:  ws://host:3200/ws/terminal?session=X&pane=Y

                   Client sends:  { type: "input", keys: "ls" }
                                  { type: "input", specialKey: "Enter" }
                                  { type: "resize", cols: 80, rows: 24 }

                   Server sends:  { type: "screen", width, height, cursor, title, lines }
                                  { type: "delta", cursor, title, changed: { "3": spans, "12": spans } }
                                  { type: "error", message: "Session ended" }
```

Why WebSocket over SSE + POST:
- Single connection instead of two channels — simpler client code
- `ws` package is already on disk (puppeteer dependency, zero deps itself)
- Bidirectional — ready for future features (resize, mouse events) without adding more endpoints
- Lower per-message overhead than HTTP POST for keystrokes
- Cleaner error handling — connection state is explicit

Why `ws` package over bare RFC 6455:
- Full spec compliance (handshake, framing, masking, fragmentation, ping/pong)
- Battle-tested, zero dependencies of its own
- Already in node_modules — not adding anything to the dependency tree

## Server Changes (server.mjs)

### 1. Async tmux execution

**Current:** All tmux commands use `execFileSync` (blocking). One slow tmux command blocks all other requests.

**Change:** Switch to `execFile` (async, callback-based) wrapped in a Promise helper:

```js
import { execFile } from 'child_process';

function tmux(...args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
```

All routes become async. `/api/pane` still works (backward compat) but uses `await tmux(...)`.

### 2. WebSocket server setup

Attach `ws` WebSocket server to the existing HTTP server using the `upgrade` event:

```js
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ws/terminal') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = url.searchParams.get('session');
      const pane = url.searchParams.get('pane') || '0';
      handleTerminalConnection(ws, session, pane);
    });
  } else {
    socket.destroy();
  }
});
```

No new port, no new server — shares the existing port 3200.

### 3. Per-connection terminal handler

Each WebSocket connection manages one terminal session/pane:

```js
async function handleTerminalConnection(ws, session, pane) {
  let lastState = null;
  let pollTimer = null;

  // Send full screen state immediately
  async function captureAndSend() {
    try {
      const state = await capturePane(session, pane);
      const diff = diffState(lastState, state);
      if (diff) {
        ws.send(JSON.stringify(diff));
        lastState = state;
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  }

  // Initial full capture
  await captureAndSend();

  // Server-side poll for background output changes
  pollTimer = setInterval(captureAndSend, 30);

  // Handle client messages (keystrokes)
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'input') {
        if (msg.specialKey) {
          await tmux('send-keys', '-t', session + ':' + pane, msg.specialKey);
        } else if (msg.keys) {
          await tmux('send-keys', '-t', session + ':' + pane, '-l', msg.keys);
        }
        // Immediate capture after input for fast feedback
        setTimeout(captureAndSend, 5);
      }
    } catch (err) {
      // Best effort — don't crash on bad input
    }
  });

  ws.on('close', () => {
    clearInterval(pollTimer);
  });
}
```

Key design choices:
- **30ms server-side poll** catches background output (other processes, long-running commands)
- **Immediate capture after input** (5ms delay for tmux to process) gives near-instant keystroke feedback
- **Per-connection state** — each WebSocket tracks its own `lastState` for diffing
- **Cleanup on close** — poll timer cleared when client disconnects

### 4. Diff function

Same line-level JSON.stringify comparison, moved to server:

```js
function diffState(prev, curr) {
  if (!prev) return { type: 'screen', ...curr };
  if (prev.width !== curr.width || prev.height !== curr.height) {
    return { type: 'screen', ...curr };
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

### 5. Shared pane poller (optimization)

When multiple WebSocket clients view the same session/pane (e.g., the dashboard `<object>` tag AND a focused view), they should share one capture loop instead of each polling independently:

```js
// Map<string, { lastState, clients: Set<ws>, timer }>
const paneStreams = new Map();
```

When a client connects, join the stream for that pane. When the last client disconnects, stop the poll. Each client still tracks its own `lastSentState` so it only receives diffs relative to what IT last saw (handles the case where a client reconnects mid-stream).

### 6. Keep existing HTTP API

`/api/pane`, `/api/input`, `/api/sessions` all remain for backward compatibility. The SVG viewer loaded via `<object>` in the dashboard overview still uses these (or can be upgraded to WebSocket independently). The WebSocket endpoint is an addition, not a replacement.

## SVG Client Changes (terminal.svg / terminal.html)

### 1. WebSocket connection mode

On load, the SVG client attempts a WebSocket connection. If it succeeds, polling is disabled:

```js
let ws = null;
let useWebSocket = false;

function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws/terminal?session=' + session + '&pane=' + pane);

  ws.onopen = function() {
    useWebSocket = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  };

  ws.onmessage = function(e) {
    const msg = JSON.parse(e.data);
    if (msg.type === 'screen') {
      initLayout(msg.width, msg.height);
      for (let i = 0; i < msg.lines.length; i++) {
        updateLine(i, msg.lines[i].spans);
      }
      allLines = msg.lines;
      rebuildBgLayer(msg.lines);
      updateCursor(msg.cursor);
    } else if (msg.type === 'delta') {
      for (const [idx, spans] of Object.entries(msg.changed)) {
        const i = parseInt(idx);
        updateLine(i, spans);
        allLines[i] = { spans };
      }
      if (Object.keys(msg.changed).length > 0) rebuildBgLayer(allLines);
      updateCursor(msg.cursor);
    } else if (msg.type === 'error') {
      showError(msg.message);
    }
  };

  ws.onclose = function() {
    useWebSocket = false;
    // Reconnect after delay, fall back to polling in the meantime
    schedulePoll(pollInterval);
    setTimeout(connectWebSocket, 2000);
  };
}
```

### 2. Send input via WebSocket

When the SVG client has a WebSocket connection, keystrokes go through it instead of POST:

```js
function sendInput(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    // Fallback to POST
    fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, pane, ...msg })
    });
  }
}
```

### 3. Fallback to polling

If WebSocket connection fails (proxy, firewall, etc.), the existing poll loop resumes. The client works in degraded mode — same as current behavior. No functionality lost, just higher latency.

### 4. Track full line state

Maintain `allLines` array that's updated incrementally from delta messages. Needed for `rebuildBgLayer` which requires all lines.

## Dashboard Changes (dashboard.mjs)

### 1. Direct keystroke capture

When a terminal is focused, capture ALL keyboard events and forward them to the active input session via the terminal's WebSocket connection (or POST fallback).

```js
document.addEventListener('keydown', function(e) {
  if (!activeInputSession) return;

  // Don't capture browser shortcuts
  if (e.ctrlKey && ['t', 'w', 'n'].includes(e.key)) return;
  if (e.altKey && e.key === 'F4') return;
  if (e.key === 'F5' || e.key === 'F12') return;

  // Don't capture when help panel is open
  if (document.getElementById('help-panel').classList.contains('visible')) return;

  // Don't capture when no terminal is focused
  if (focusedSessions.size === 0) return;

  e.preventDefault();

  const t = terminals.get(activeInputSession);
  if (!t) return;

  // Translate and send
  if (e.ctrlKey && e.key.length === 1) {
    t.sendInput({ type: 'input', specialKey: 'C-' + e.key.toLowerCase() });
  } else if (SPECIAL_KEY_MAP[e.key]) {
    t.sendInput({ type: 'input', specialKey: SPECIAL_KEY_MAP[e.key] });
  } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    t.sendInput({ type: 'input', keys: e.key });
  }
});
```

### 2. Key translation map

```js
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

### 3. Per-terminal WebSocket

Each terminal in the dashboard can optionally have its own WebSocket for sending input. The `<object>` tag's SVG has its own WebSocket for receiving output. Input from the dashboard goes through a separate lightweight connection (or through the SVG's connection via `postMessage`).

Simpler approach: the dashboard opens its own WebSocket for the `activeInputSession` and sends keystrokes through it. It doesn't need to receive output — the SVG `<object>` already handles rendering.

```js
// In addTerminal():
terminals.set(sessionName, {
  // ... existing fields ...
  inputWs: null,  // WebSocket for sending input (opened on focus)
  sendInput: function(msg) {
    if (this.inputWs && this.inputWs.readyState === WebSocket.OPEN) {
      this.inputWs.send(JSON.stringify(msg));
    } else {
      // POST fallback
      fetch('/api/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionName, pane: '0', ...msg })
      });
    }
  }
});
```

Open the input WebSocket when terminal is focused, close when unfocused:

```js
// In focusTerminal() / addToFocus():
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
t.inputWs = new WebSocket(proto + '//' + location.host + '/ws/terminal?session=' + sessionName + '&pane=0');

// In unfocusTerminal() / restoreFocusedTerminal():
if (t.inputWs) { t.inputWs.close(); t.inputWs = null; }
```

The server treats this connection like any other — it'll send screen updates too, but the dashboard ignores them (the SVG `<object>` handles rendering).

### 4. Paste support

```js
document.addEventListener('paste', function(e) {
  if (!activeInputSession) return;
  e.preventDefault();
  const text = e.clipboardData.getData('text');
  if (text) {
    const t = terminals.get(activeInputSession);
    if (t) t.sendInput({ type: 'input', keys: text });
  }
});
```

### 5. Input bar changes

Keep the input bar as a status indicator showing which session is active. Remove the `<input>` text field — keystrokes are captured at the document level.

```html
<div class="input-bar" id="input-bar">
  <span class="status-dot"></span>
  <span class="target" id="input-target"></span>
  <span class="input-hint">Type directly — keys go to terminal</span>
</div>
```

### 6. Expand server special key whitelist

Update server.mjs `ALLOWED_SPECIAL` to accept all Ctrl combos and function keys:

```js
const ALLOWED_SPECIAL = new Set([
  'Enter', 'Tab', 'Escape', 'BSpace', 'DC', 'IC', 'Space',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PgUp', 'PgDn',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);
// Also accept any 'C-X' pattern:
function isAllowedKey(key) {
  return ALLOWED_SPECIAL.has(key) || /^C-[a-z]$/.test(key);
}
```

## Error Handling

### WebSocket disconnection
- Client reconnects after 2s delay
- Falls back to HTTP polling during reconnection
- Server cleans up poll timer on connection close

### tmux session disappears
- Server's capture catches the error, sends `{ type: 'error', message: '...' }`
- Client shows "Session ended" overlay
- Dashboard removes the terminal from the 3D scene on next refresh cycle

### Input errors
- Best effort — keystroke send failures are silently ignored
- The next keystroke either works or the WebSocket reconnects

### Shared poller edge cases
- If all clients for a pane disconnect simultaneously, poller stops
- If a new client connects before poller cleanup, it reuses the existing state
- Server-side `lastState` is per-stream, not per-client

## Performance

### Server-side polling at 30ms
- `tmux capture-pane` takes ~1-3ms per call (local IPC to tmux server)
- At 30ms with 7 terminals, that's ~230 captures/second — negligible CPU
- Diff comparison (JSON.stringify per line) is cheap for 24-line terminals
- Only changed lines sent over WebSocket

### Bandwidth
- Full screen message: ~5-10KB (80x24 terminal with colors)
- Delta message: ~100-500 bytes (typically 1-3 changed lines)
- WebSocket framing overhead: 2-6 bytes per message
- At active typing speed (~10 chars/sec), ~5KB/sec — negligible

### Latency budget
```
Keystroke → WebSocket send:       ~0.5ms (already connected)
Server receives + tmux send-keys: ~1-2ms
tmux processes input:             ~1-5ms
Wait for tmux:                    ~5ms (setTimeout)
Server captures pane:             ~1-3ms
Diff + WebSocket push:            ~0.5ms
Browser receives + renders:       ~1-5ms
                                  --------
Total:                            ~10-22ms
```

Compare to current: up to **150ms** (poll interval) + HTTP POST overhead.

## Scope Boundaries

### In scope
- WebSocket server endpoint (`/ws/terminal`)
- Async tmux execution
- Server-side diff + push
- Shared pane poller
- Direct keystroke capture in dashboard
- Key translation (browser → tmux)
- Paste support
- Expanded special key whitelist
- Fallback to HTTP polling if WebSocket fails
- Keep existing HTTP API for backward compat

### Out of scope (future work)
- Mouse events in terminal (scrollback, text selection)
- Terminal resize (sending SIGWINCH)
- Multiple panes per session
- tmux control mode integration
- Audio bell notification
- Terminal scrollback buffer access
