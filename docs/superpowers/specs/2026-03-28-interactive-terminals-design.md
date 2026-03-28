# Interactive Terminals — Design Spec

## Goal

Replace the polling-based read-only terminal viewer with a real-time interactive terminal. Keystrokes go directly to tmux, output streams back instantly. Programs like vim, htop, and tab completion work naturally.

## Architecture

**SSE (Server-Sent Events) + POST** instead of WebSocket.

Why not WebSocket:
- Node.js 22 has no built-in WebSocket server
- The `ws` package works but adds a dependency (project policy: zero server deps)
- Implementing RFC 6455 framing from scratch is 300-500 lines of careful code
- WebSocket is bidirectional, but we don't need bidirectional — output is high-volume server→client, input is low-volume client→server

Why SSE + POST:
- SSE is trivial to implement (30 lines on server, built-in `EventSource` in browser)
- POST for keystrokes works with existing `/api/input` — just need to make it async
- Built-in browser reconnection (EventSource auto-reconnects on disconnect)
- Works through HTTP proxies without special configuration
- Zero new dependencies

The two channels:
```
Server → Client:  SSE stream (/api/stream?session=X&pane=Y)
                  Pushes screen state as JSON events whenever output changes.
                  Replaces 150ms polling entirely.

Client → Server:  POST /api/input (existing endpoint, made async)
                  Each keystroke sent immediately.
                  After processing input, server pushes updated screen via SSE.
```

## Server Changes (server.mjs)

### 1. Async tmux execution

**Current:** All tmux commands use `execFileSync` (blocking). One slow tmux command blocks all other requests.

**Change:** Switch to `execFile` (async, callback-based) wrapped in a Promise helper:

```js
const { execFile } = require('child_process');

function tmux(...args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
```

All routes become async. `/api/pane` still works (backward compat) but uses `await tmux(...)` instead of `execFileSync`.

### 2. SSE stream endpoint

**New route:** `GET /api/stream?session=X&pane=Y`

Server-side behavior:
1. Respond with `Content-Type: text/event-stream`
2. Immediately capture pane and send full screen state as first event
3. Start a server-side poll loop at **30ms** (not client-visible, just for change detection)
4. On each tick, capture pane, compare with previous state
5. If changed, send delta event (changed line indices + new spans)
6. Track connected clients — stop polling when no clients are connected to a pane

Event format:
```
event: screen
data: {"width":80,"height":24,"cursor":{"x":5,"y":12},"title":"...","lines":[...]}

event: delta
data: {"cursor":{"x":6,"y":12},"changed":{"3":[spans...],"12":[spans...]}}
```

First event is always `screen` (full state). Subsequent events are `delta` (only changed lines + cursor). If the terminal dimensions change, send a new `screen` event.

### 3. Input-triggered capture

When `/api/input` receives a keystroke:
1. Send keys to tmux (async)
2. Wait 5-10ms for tmux to process
3. Immediately capture pane
4. Push the result to all SSE clients connected to that session/pane

This gives near-instant feedback: keystroke → tmux processes → screen update pushed. The user sees the result within ~15-20ms instead of waiting up to 150ms for the next poll.

### 4. Client tracking

The server needs to track which SSE clients are connected to which session/pane:

```js
// Map<string, Set<Response>>  key = "session:pane"
const sseClients = new Map();
```

When a client connects to `/api/stream`, add their response to the set. When they disconnect (response `close` event), remove them. When pushing updates, iterate the set for that session/pane.

When no clients are connected to a pane, stop the server-side poll loop for that pane. Resume when a new client connects.

### 5. Server-side poll manager

A per-pane poll loop that runs at 30ms when clients are connected:

```js
const panePollers = new Map(); // key = "session:pane", value = { interval, lastState }

function startPoller(session, pane) {
  const key = session + ':' + pane;
  if (panePollers.has(key)) return;

  const poller = { lastState: null, timer: null };
  poller.timer = setInterval(async () => {
    const state = await capturePane(session, pane);
    const delta = diffState(poller.lastState, state);
    if (delta) {
      pushToClients(key, delta);
      poller.lastState = state;
    }
  }, 30);
  panePollers.set(key, poller);
}

function stopPoller(session, pane) {
  const key = session + ':' + pane;
  const poller = panePollers.get(key);
  if (poller) {
    clearInterval(poller.timer);
    panePollers.delete(key);
  }
}
```

### 6. Diff function

Same line-level JSON.stringify comparison the client currently uses, but on the server:

```js
function diffState(prev, curr) {
  if (!prev) return { type: 'screen', ...curr }; // full state
  if (prev.width !== curr.width || prev.height !== curr.height) {
    return { type: 'screen', ...curr }; // dimension change = full state
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
  if (!anyChanged && prev.cursor.x === curr.cursor.x && prev.cursor.y === curr.cursor.y) {
    return null; // no change
  }
  return { type: 'delta', cursor: curr.cursor, title: curr.title, changed };
}
```

## SVG Client Changes (terminal.svg / terminal.html)

### 1. SSE connection mode

On load, the SVG client attempts to open an SSE connection:

```js
const source = new EventSource('/api/stream?session=' + session + '&pane=' + pane);

source.addEventListener('screen', function(e) {
  const data = JSON.parse(e.data);
  initLayout(data.width, data.height);
  for (let i = 0; i < data.lines.length; i++) {
    updateLine(i, data.lines[i].spans);
  }
  rebuildBgLayer(data.lines);
  updateCursor(data.cursor);
});

source.addEventListener('delta', function(e) {
  const data = JSON.parse(e.data);
  for (const [idx, spans] of Object.entries(data.changed)) {
    updateLine(parseInt(idx), spans);
  }
  if (Object.keys(data.changed).length > 0) rebuildBgLayer(/* current lines */);
  updateCursor(data.cursor);
});

source.onerror = function() {
  // EventSource auto-reconnects. Optionally show error overlay.
};
```

### 2. Fallback to polling

If SSE connection fails (e.g., behind a proxy that strips it), fall back to current polling behavior. The poll code stays in the file, just gated:

```js
let useSSE = true;
source.onerror = function() {
  if (source.readyState === EventSource.CLOSED) {
    useSSE = false;
    schedulePoll(pollInterval); // fall back to polling
  }
};
```

### 3. Remove poll loop when SSE is active

When SSE is connected, `pollTimer` is cleared. No concurrent polling.

### 4. Track full line state for background rebuild

Currently the poll response includes all lines. With delta events, we only get changed lines. The client needs to maintain a full `lines` array and update it incrementally so `rebuildBgLayer` can access all lines.

## Dashboard Changes (dashboard.mjs)

### 1. Direct keystroke capture

When a terminal is focused (single or multi-focus), capture ALL keyboard events and forward them to the active input session.

Replace the input bar's `keydown` handler with a document-level handler:

```js
document.addEventListener('keydown', function(e) {
  if (!activeInputSession) return;

  // Don't capture browser shortcuts
  if (e.ctrlKey && ['t', 'w', 'n', 'Tab'].includes(e.key)) return;
  if (e.altKey && e.key === 'F4') return;
  if (e.key === 'F5' || e.key === 'F11' || e.key === 'F12') return;

  // Don't capture when help panel is open
  if (document.getElementById('help-panel').classList.contains('visible')) return;

  e.preventDefault();

  const tmuxKey = translateKey(e);
  if (tmuxKey) {
    sendSpecialKey(activeInputSession, tmuxKey);
  }
});
```

### 2. Key translation

Map browser `KeyboardEvent` to tmux `send-keys` arguments:

```js
function translateKey(e) {
  // Ctrl combos
  if (e.ctrlKey && e.key.length === 1) {
    return 'C-' + e.key.toLowerCase();
  }

  // Special keys
  const MAP = {
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
  };

  if (MAP[e.key]) return MAP[e.key];

  // Regular characters — send as literal text
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
    return null; // handled separately as literal text
  }

  return null;
}
```

For regular character keys, send via `sendKeys(session, key)` (literal text, not special key).

### 3. Paste support

Handle Ctrl+V paste:

```js
document.addEventListener('paste', function(e) {
  if (!activeInputSession) return;
  const text = e.clipboardData.getData('text');
  if (text) {
    sendKeys(activeInputSession, text);
  }
});
```

### 4. Input bar becomes optional

Keep the input bar as a visible indicator of which session is active (shows the session name). But keystrokes no longer go through the input text field — they're captured at the document level.

The input `<input>` element can be removed or hidden. The session name indicator stays.

### 5. Update allowed special keys on server

The current server whitelist for special keys is limited. Expand it:

```js
const ALLOWED_SPECIAL = new Set([
  'Enter', 'Tab', 'Escape', 'BSpace', 'DC', 'IC',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PgUp', 'PgDn',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'C-a', 'C-b', 'C-c', 'C-d', 'C-e', 'C-f',
  'C-g', 'C-h', 'C-i', 'C-j', 'C-k', 'C-l',
  'C-m', 'C-n', 'C-o', 'C-p', 'C-q', 'C-r',
  'C-s', 'C-t', 'C-u', 'C-v', 'C-w', 'C-x',
  'C-y', 'C-z',
  'Space',
]);
```

## Error Handling

### SSE disconnection
- `EventSource` auto-reconnects with exponential backoff (browser built-in)
- On reconnect, server sends full `screen` event (not delta) as first message
- Client shows subtle "reconnecting..." indicator during disconnect

### tmux session disappears
- Server's poll loop catches the error, sends an `error` event via SSE
- Client shows "Session ended" overlay
- Dashboard removes the terminal from the 3D scene

### Input errors
- POST `/api/input` returns error → client ignores (best effort for keystrokes)
- No retry on input errors — the next keystroke will work or not

## Performance

### Server-side polling at 30ms
- `tmux capture-pane` takes ~1-3ms per call (it's a local IPC to the tmux server)
- At 30ms with 7 terminals, that's ~230 captures/second — negligible CPU
- The diff comparison (JSON.stringify per line) is cheap for 24-line terminals
- Only changed lines are serialized and sent over SSE

### Bandwidth
- Full screen event: ~5-10KB (80x24 terminal with colors)
- Delta event: ~100-500 bytes (typically 1-3 changed lines)
- At active typing speed (~10 chars/sec), that's ~5KB/sec — negligible

### Latency budget
```
Keystroke → POST to server:      ~1ms (localhost)
Server → tmux send-keys:         ~1ms
tmux processes input:             ~1-5ms
Wait for tmux:                    ~5-10ms (built-in delay)
Server captures pane:             ~1-3ms
Diff + SSE push:                  ~1ms
Browser receives + renders:       ~1-5ms
                                  --------
Total:                            ~10-25ms
```

Compare to current: up to **150ms** (poll interval).

## Scope Boundaries

### In scope
- SSE streaming endpoint
- Async tmux execution
- Server-side diff + push
- Direct keystroke capture in dashboard
- Key translation (browser → tmux)
- Paste support
- Expanded special key whitelist
- Fallback to polling if SSE fails

### Out of scope (future work)
- Mouse events in terminal (scrollback, text selection)
- Terminal resize (sending SIGWINCH)
- Multiple panes per session
- tmux control mode integration
- Audio bell notification
- Terminal scrollback buffer access
