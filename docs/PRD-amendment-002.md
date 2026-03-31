# PRD Amendment 002 — Event-Driven Terminal Updates via tmux Control Mode

**Date:** 2026-03-31
**Amends:** PRD v0.4.0 (2026-03-29)
**Supersedes:** PRD-amendment-001.md (which proposed shared capture + adaptive backoff — replaced by this simpler approach)
**Status:** Proposed
**Journal:** docs/research/2026-03-31-v0.3-event-driven-terminal-updates-journal.md

---

## 1. How It Works Today — Complete Lifecycle

### 1.1 Discovery (dashboard.mjs → server.mjs)

Every 5 seconds, `dashboard.mjs` calls `GET /api/sessions`. Server returns a list of sessions from two sources:
- Local tmux: `tmux list-sessions -F '#{session_name} #{session_windows} #{window_width} #{window_height}'`
- Claude-proxy API: `GET http://127.0.0.1:3101/api/sessions` (2s timeout, silent failure)

Each session comes back as `{ name, windows, cols, rows, source }`. Dashboard compares to its current `terminals` Map, calls `addTerminal()` for new ones, `removeTerminal()` for gone ones.

### 1.2 Card Creation (dashboard.mjs)

`addTerminal(sessionName, cols, rows)` creates:
- A card DOM element with an `<object>` tag pointing to `terminal.svg?session=X&pane=0&server=...`
- A CSS3DObject at 0.25 scale (the 4x scale trick for text crispness)
- A thumbnail for the sidebar
- A `sendInput()` method that routes messages through the SVG's WebSocket via `contentWindow.sendToWs()`
- An HTTP POST fallback to `/api/input` if WebSocket isn't ready yet (legacy path)

When the `<object>` loads, dashboard registers a `_screenCallback` function on the SVG's `contentWindow`. This is how the dashboard receives screen data from the SVG.

Dashboard also calls `fetchTitle(sessionName)` which hits `GET /api/pane` to get the initial title. This is a legacy HTTP call — titles also arrive in every WebSocket message. Causes 500 errors on claude-proxy sessions.

### 1.3 WebSocket Connection (terminal.svg)

On load, terminal.svg calls `connectWebSocket()` which opens `ws://host/ws/terminal?session=X&pane=Y`.

It also calls `schedulePoll(pollInterval)` as a safety net — a 150ms HTTP poll that races with the WebSocket. If WebSocket connects first (it should), the poll is cancelled. If not, the poll hits `GET /api/pane` every 150ms. This legacy safety net causes 404/500 errors on sessions that only support WebSocket.

### 1.4 Server Handles WebSocket (server.mjs)

`server.on('upgrade')` fires. Server checks if the session exists in local tmux:
- **Yes (local tmux):** calls `handleTerminalWs(ws, session, pane)`
- **No (claude-proxy):** opens a WebSocket to `ws://127.0.0.1:3101/api/session/{id}/stream` and bridges messages bidirectionally. No polling — claude-proxy is already event-driven.

### 1.5 The 30ms Poll Loop (server.mjs — handleTerminalWs)

For local tmux sessions, `handleTerminalWs` does this:

**Immediate first capture:**
```
await captureAndPush()
```

**Then starts a timer:**
```
pollTimer = setInterval(captureAndPush, 30)
```

**Every 30ms, `captureAndPush()` runs:**

**Step 1 — Spawn child process:**
```
execFile('tmux', ['display-message', '-p', '-t', 'session:pane',
  '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{pane_pid} #{history_size} #{pane_dead} #{pane_current_command} #{pane_current_path} #{pane_title}',
  ';', 'capture-pane', '-p', '-e', '-t', 'session:pane'])
```
This is an atomic tmux command that captures metadata AND screen content in one call (the `;` separator). The `-e` flag preserves SGR escape codes (colors, bold, etc.). tmux has already interpreted all cursor movement, scroll regions, clear commands etc. — `capture-pane` returns the **rendered screen result**, not the raw byte stream. The only escape codes remaining are SGR styling codes.

**Step 2 — Parse metadata:**
First line is: `80 24 15 5 12345 100 0 bash /home/user My Title`
Parsed into: `{ width: 80, height: 24, cursor: {x:15, y:5}, pid, historySize, dead, command, path, title }`

**Step 3 — Parse each screen line through sgr-parser:**
Each line of raw ANSI text like `\x1b[1m\x1b[38;5;82mhello\x1b[0m world` goes through `parseLine()` which:
- Walks character by character
- On `ESC [` ... `m`: parses SGR parameters, updates a style object (fg, bg, bold, italic, underline, dim, strikethrough, reverse, hidden, overline, underlineColor)
- On `ESC ]` ... `BEL/ST`: parses OSC sequences (OSC 8 for hyperlinks, others silently stripped)
- On any other `ESC`: skips the escape (non-SGR control codes stripped)
- Accumulates plain text between escapes, pushes Span objects when style changes

Output per line: array of Spans: `[{ text: 'hello', bold: true, fg: '#5fff00', ... }, { text: ' world', ... }]`

Standard colors (0-15) → CSS class names (`c0`-`c7`, `cb0`-`cb7`). Extended colors (16-255) → hex strings from color-table.mjs. Truecolor → hex string directly. URLs from OSC 8 → `url` property. Plain-text URL detection (`http://`/`https://`) also adds `url` property via `tagPlainUrls()`.

Result: `{ width, height, cursor, title, path, command, pid, historySize, dead, lines: [{ spans: [...] }, ...] }`

**Step 4 — Diff against last state:**
`diffState(lastState, currentState)` compares the two state objects:

- If `lastState` is null (first capture, or forced re-capture after scroll/resize): returns `{ type: 'screen', ... }` with ALL lines. Full screen message.
- If dimensions changed: returns `{ type: 'screen', ... }`. Full screen message.
- Otherwise: `JSON.stringify` each line's spans and compare string-by-string against last capture. Collect changed line indices. Also check cursor position and title.
  - If nothing changed (no lines, cursor, or title differ): returns **null**.
  - If anything changed: returns `{ type: 'delta', cursor, title, changed: { "3": {spans: [...]}, "7": {spans: [...]} } }` with only the changed lines.

**Step 5 — Send or discard:**
- If diff returned **null**: nothing is sent. The WebSocket stays open and idle. The child process was spawned, the parsing happened, the stringify comparison happened — all for nothing. **This is the waste.** No reconnection needed — the WebSocket connection is persistent. The timer fires again in 30ms.
- If diff returned a message: `ws.send(JSON.stringify(diff))` sends the screen or delta message with `scrollOffset` appended.
- `lastState` is updated to `currentState` for next comparison.

**This entire loop runs independently for each WebSocket connection.** 5 browsers viewing the same session = 5 independent child processes every 30ms capturing identical screen data.

### 1.6 Browser Receives Data (terminal.svg)

`ws.onmessage` fires with the JSON message.

**For `type: 'screen'` (full screen):**
1. If dimensions changed: `initLayout(width, height)` rebuilds the SVG — creates one `<text>` element per row, sets `viewBox` to `cols × CELL_W` by `rows × CELL_H`, resizes cursor rect
2. Stores `allLines = msg.lines`
3. For each line: `updateLine(i, spans)` clears the `<text>` element's children, creates one `<tspan>` per Span with:
   - `x` attribute positioned at `charOffset × CELL_W` (explicit character positioning, no CSS layout)
   - `fill` attribute for hex colors, `class` attribute for standard color CSS classes
   - `class` for bold/italic/dim
   - `text-decoration` for underline/strikethrough
4. `rebuildBgLayer(lines)` clears and rebuilds all background `<rect>` elements for spans with `bg` or `bgCls`
5. `rebuildLinkLayer(lines)` clears and rebuilds blue underline `<line>` elements for spans with `url`
6. Updates cursor position: `cursorEl` x/y attributes
7. Stores `prevState[i] = JSON.stringify(spans)` per line (used only by the legacy HTTP poll path)
8. Calls `window._screenCallback(msg)` — this notifies dashboard.mjs

**For `type: 'delta'` (changed lines only):**
1. For each key in `msg.changed`: `updateLine(idx, spans)` — same as above but only for changed lines
2. Updates `allLines[idx]` in place
3. Rebuilds ALL backgrounds and ALL link underlines (not just changed lines — this is a known inefficiency)
4. Updates cursor
5. Stores `prevState[idx]`
6. Calls `window._screenCallback(msg)`

**For `type: 'error'`:**
Shows a "Connection lost" error overlay on the SVG.

### 1.7 Dashboard Receives Screen Callback (dashboard.mjs)

`_screenCallback(msg)` fires on the dashboard side:

**For `type: 'screen'`:**
1. Populates `t.screenLines` — plain text + spans per line (used for copy/paste and text selection)
2. Calls `updateCardForNewSize(t, msg.width, msg.height)` — if terminal dimensions changed, reshapes the card DOM to match. Updates `baseCardW`, `baseCardH`. If focused, triggers re-layout.
3. Stores cursor position

**For `type: 'delta'`:**
1. Updates individual entries in `t.screenLines`
2. Stores cursor position

### 1.8 Browser Sends Input (dashboard.mjs → terminal.svg → server.mjs)

Keystrokes captured by dashboard's document-level `keydown` handler. Routed through:
```
dashboard.mjs: t.sendInput({ type: 'input', keys: 'a' })
  → t.dom.querySelector('object').contentWindow.sendToWs(msg)
  → terminal.svg: ws.send(JSON.stringify(msg))
  → server.mjs: handleTerminalWs ws.on('message')
```

Server handles input:
- `{ type: 'input', specialKey: 'Enter' }` → `tmux send-keys -t session:pane Enter`
- `{ type: 'input', keys: 'hello' }` → `tmux send-keys -t session:pane -l 'hello'`
- `{ type: 'input', keys: 'c', ctrl: true }` → `tmux send-keys -t session:pane C-c`
- Key names translated from claude-proxy format to tmux format (Backspace→BSpace, Delete→DC, PageUp→PgUp, PageDown→PgDn, Insert→IC)

After sending keys to tmux: `setScrollOffset(session, pane, 0)` (snap to live view) then `setTimeout(captureAndPush, 5)` (extra capture 5ms later to pick up the result).

### 1.9 Scroll (dashboard.mjs → server.mjs → tmux)

Mouse wheel or PgUp/PgDn in dashboard → `t.scrollBy(±lines)` → sends `{ type: 'scroll', offset: N }` through the WebSocket.

Server receives scroll: `setScrollOffset(session, pane, N)`, nulls `lastState` (force full re-capture), then calls `captureAndPush()` which uses `capturePaneAt(session, pane, offset)` instead of `capturePane()`.

`capturePaneAt` runs: `tmux capture-pane -p -e -t session:pane -S {-offset} -E {-offset+height-1}`. The `-S`/`-E` flags request specific line ranges — negative numbers reach into tmux's scrollback history. tmux stores scrollback independently (survives server restart). This is the scrollback mechanism — it's just tmux being asked for different line ranges.

Cursor is set to `{x: -1, y: -1}` when viewing history (not meaningful).

### 1.10 Resize (dashboard.mjs → server.mjs → tmux)

+/- buttons or alt+drag → sends `{ type: 'resize', cols: N, rows: M }` through WebSocket.

Server receives resize:
- Checks resize lock (500ms per-session lock prevents multi-browser fighting)
- Calls `tmux resize-window -t session -x cols -y rows` (resize-window, not resize-pane — resize-pane fails without attached client)
- Nulls `lastState`, captures after 10ms

The 30ms poll on every other connected browser picks up the new dimensions via `diffState` detecting a dimension change → sends full `screen` message → browser `initLayout()` rebuilds SVG → `_screenCallback` → `updateCardForNewSize` reshapes card.

### 1.11 Disconnect and Reconnect

**Browser closes WebSocket (intentional or network):**
- server.mjs `ws.on('close')`: clears the `setInterval` poll timer, resets scroll offset to 0
- terminal.svg `ws.onclose`: sets `useWebSocket = false`, starts HTTP poll fallback at 150ms, starts `setTimeout(connectWebSocket, 2000)` for WebSocket reconnect
- On successful reconnect: WebSocket `onopen` cancels the HTTP poll, server creates new poll loop

**Server restarts:**
- All WebSocket connections drop
- terminal.svg sees `onclose`, starts reconnect cycle (2s retry)
- When server comes back: new WebSocket, new `handleTerminalWs`, new poll loop, first capture sends full `screen` (lastState is null)
- tmux sessions survive (separate daemon) — full scrollback preserved

---

## 2. The Problem

### 2.1 What's expensive

Every 30ms, per WebSocket connection:
1. **Child process spawn:** `execFile('tmux', [...])` — forks a process, runs tmux, captures stdout
2. **SGR parsing:** `parseLine()` walks every character of every line through the escape code parser
3. **JSON serialization for diff:** `JSON.stringify()` on every line's Span array, twice (prev and curr)
4. **String comparison:** line-by-line string equality check

Steps 1-3 happen whether anything changed or not. Step 4 (the diff) just decides whether to transmit the result. When nothing changed, all that work is discarded.

### 2.2 What multiplies it

Each WebSocket connection gets its own poll loop. N browsers × M sessions = N×M independent loops, each spawning a child process every 30ms.

Current state: 25 connections on port 3201, ~40% CPU, server mostly idle.
Target: 30 browsers × 30 sessions.

### 2.3 What's wasted

On an idle terminal (no output): every 30ms the server spawns a child process, parses the screen, serializes it, compares it to last time, gets null, discards everything. Repeats forever. 33 times per second per connection, producing nothing.

---

## 3. The Fix

**Replace the trigger. Keep the pipeline.**

The pipeline — `capturePane()` → `parseLine()` → `diffState()` → WebSocket send — is correct and stays. Only what starts it changes.

### Current: Timer Trigger (per connection)

```
Every 30ms, unconditionally:
  │
  ├─ execFile('tmux', ['capture-pane', ...])        ← child process spawned
  ├─ parseLine() on each line                        ← SGR parsing
  ├─ diffState(): JSON.stringify + compare per line  ← serialization
  │    ├─ null → discard all work, wait 30ms, repeat
  │    └─ changed → ws.send() to THIS one client
  │
  └─ repeat in 30ms

× N connections to the same session = N copies of this
```

### Target: Event Trigger (per session, shared)

```
Persistent process:
  tmux -C attach-session -t SESSION
  stdin: refresh-client -A '%PANE_ID:on'

tmux stdout emits %output when pane has new data:
  │
  ├─ execFile('tmux', ['capture-pane', ...])        ← SAME child process
  ├─ parseLine() on each line                        ← SAME SGR parsing
  ├─ diffState(): JSON.stringify + compare per line  ← SAME serialization
  │    └─ changed → ws.send() to ALL clients         ← broadcast, not one
  │
  └─ wait for next %output (no timer, no wasted work)

× 1 per session regardless of browser count
```

### What's Different

Two things. Everything else is identical.

1. **Trigger:** `%output` event from a persistent `tmux -C` process replaces `setInterval(30ms)`. The same pipeline runs, but only when there's something to capture. Zero work when idle.

2. **Fan-out:** One capture per change, broadcast to all connected WebSocket clients for that session:pane. Instead of N independent captures of the same data.

`tmux -C` (control mode) is a persistent connection to tmux that receives structured notifications on stdout. We send `refresh-client -A '%PANE_ID:on'` to enable output notifications for specific panes. When a pane produces output, tmux writes `%output %PANE_ID escaped-data` to stdout. We use this purely as a trigger — we don't parse the `%output` data, we just know it's time to capture.

Tested on this system (tmux 3.5a). Sub-millisecond notification latency. Must keep stdin open or control client dies.

---

## 4. Legacy Code Being Removed

All of this was built before WebSocket existed in the system, or as safety nets during the transition. None of it is needed for new sessions. Old pre-WebSocket sessions are still alive but will be terminated soon — no new ones will be created.

| Code | File | Lines | Why it existed | Why it's removed |
|------|------|-------|---------------|-----------------|
| `poll()` | terminal.svg | 354-410 | HTTP polling before WebSocket existed | WebSocket is the only path |
| `schedulePoll()`, `stopPolling()` | terminal.svg | 144-156 | Poll timer management | No polling |
| `startPolling()` | terminal.svg | 429-437 | Start poll with interval | No polling |
| `pollInterval`, `pollTimer`, `RETRY_MS` | terminal.svg | 120-122 | Poll state | No polling |
| Tier measurement | terminal.svg | 415-427 | Adaptive poll rate by SVG visibility | No polling |
| IntersectionObserver | terminal.svg | 439-465 | Stop poll for offscreen cards | No polling |
| Safety-net `schedulePoll()` on startup | terminal.svg | 608 | Fallback if WebSocket failed | Causes 404/500 on new sessions |
| `handlePane()` — `GET /api/pane` | server.mjs | 202-214 | HTTP polling endpoint | WebSocket delivers data |
| `handleInput()` — `POST /api/input` | server.mjs | 241-286 | HTTP input endpoint | WebSocket delivers input |
| `fetchTitle()` | dashboard.mjs | 1518-1525 | Title fetch via `/api/pane` | Titles in every WS message |
| `refreshTitles()` + setInterval | dashboard.mjs | 1510-1515, 563 | 10s title poll | Not needed |
| HTTP POST fallback in `sendInput()` | dashboard.mjs | 1659-1663 | Fallback when WS unavailable | WS is the only path |

---

## 5. What Does NOT Change

- `capturePane()` / `capturePaneAt()` — same tmux child process, same command
- `sgr-parser.mjs` / `parseLine()` — same ANSI parsing
- `diffState()` — same delta computation
- WebSocket message format (`screen` / `delta`)
- Span data shape (text, cls, fg, bg, bgCls, bold, italic, underline, dim, strikethrough, url, etc.)
- terminal.svg rendering (updateLine → tspan creation, rebuildBgLayer → rect creation, rebuildLinkLayer)
- `_screenCallback` bridge from terminal.svg to dashboard.mjs
- Scrollback — `tmux capture-pane -S -E`, tmux is the store, survives restarts
- Claude-proxy WS proxy bridge — already event-driven
- SSE command channel
- Session discovery — `refreshSessions()` 5s poll
- 3D dashboard, camera-only focus, CSS3DRenderer, 4x scale trick

---

## 6. Open Design Questions

| Question | Notes |
|----------|-------|
| One control client per session or shared? | `tmux -C` attaches to a session. Need to test if one can watch panes across sessions. |
| Debouncing | High-throughput output (e.g. `cat bigfile`) fires many `%output` events. Capture once after burst settles. ~30ms window likely right. |
| Control client lifecycle | Track session creation/destruction. Subscribe/unsubscribe panes dynamically. |
| SSE role | WebSocket carries terminal data. SSE could carry session-level events (new/removed sessions) — potentially replaces 5s `refreshSessions` poll. |
| diffState necessity | With event-driven triggers, we know something changed. Could simplify or remove diffState and just send full screen every time. Bandwidth cost on LAN is trivial (~5KB per screen). |
| Raw string diff | If keeping diff: could compare raw ANSI strings from tmux before parsing, only parse changed lines. Saves parser + JSON.stringify work on unchanged lines. |

---

## 7. Scaling

**Current:** N browsers × M sessions × 33 polls/sec = N×M×33 child processes/sec

**Target:** M sessions × (changes/sec) child processes. Zero when idle. Broadcast is free regardless of browser count.

| Scenario | Current | Target |
|----------|---------|--------|
| 30 browsers × 30 sessions, all idle | ~30,000 captures/sec | 0 |
| 30 browsers × 30 sessions, all active | ~30,000 captures/sec | ~30 (one per session per change) |

---

## 8. Rejected Alternatives

| Alternative | Why Rejected |
|-------------|-------------|
| xterm/headless (journal v0.1) | Loses scrollback in alternate screen mode. Claude-proxy proved this — commit 7aa1323 fell back to tmux capture-pane. Adds dependency for no benefit. |
| Adaptive backoff (journal v0.2) | Optimizes polling instead of eliminating it. Adds complexity (backoff curves, snap-back logic) for an incomplete fix. |
| Shared capture with timer trigger (amendment 001) | Right idea (shared), wrong trigger (timer). Still polls blindly, just less. |
| inotify on PTY devices | Tested on this system: doesn't work. inotify doesn't monitor character devices. |
| PTY fd watching | tmux owns the PTY. Two readers would race. |
