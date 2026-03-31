# PRD Amendment 003 — Single WebSocket + Shared Capture + Tunable Polling

**Date:** 2026-03-31
**Amends:** PRD v0.4.0 (2026-03-29)
**Supersedes:** PRD-amendment-001.md, PRD-amendment-002.md
**Status:** Proposed
**Journal:** docs/research/2026-03-31-v0.5-event-driven-terminal-updates-journal.md
**Full reasoning trail:** docs/research/2026-03-31-v0.1 through v0.5

---

## 1. Problem

The server crashed under load. Root cause: every browser terminal card opens its own WebSocket. Each WebSocket triggers its own 30ms poll loop on the server — spawning a child process (`tmux capture-pane`), parsing the result, diffing it, and sending changes. 30 browsers × 30 sessions = 900 independent captures every 30ms, producing identical data for the same session.

The problem is **per-connection duplication**, not polling itself. Benchmarks confirm that 30 shared captures (one per session) complete in ~16ms — well within a 30ms window.

**Target capacity:** 30 browsers running 30 Claude sessions.

---

## 2. Current Architecture (What Exists Today)

### 2.1 How a Terminal Card Gets Its Data

**Step 1 — Discovery:** Every 5 seconds, `dashboard.mjs` calls `GET /api/sessions`. Server returns session list from local tmux (`tmux list-sessions`) + claude-proxy API (`GET localhost:3101/api/sessions`). Dashboard creates a card for each new session.

**Step 2 — Card creation:** `addTerminal()` creates a card DOM with an `<object>` tag loading `terminal.svg?session=X&pane=0`. Also registers a `_screenCallback` on the SVG's `contentWindow` so dashboard receives screen data from the SVG.

**Step 3 — WebSocket per card:** terminal.svg opens `ws://host/ws/terminal?session=X&pane=Y`. Server calls `handleTerminalWs(ws, session, pane)`.

**Step 4 — Server poll loop starts:** `handleTerminalWs` does an immediate capture, then starts `setInterval(captureAndPush, 30)`. This timer runs until the browser disconnects.

**Step 5 — Every 30ms, `captureAndPush()` runs:**

1. **Spawn child process:** `execFile('tmux', ['display-message', ..., ';', 'capture-pane', '-p', '-e', '-t', 'session:pane'])`. This is an atomic tmux command (the `;` separator) that captures metadata (dimensions, cursor, title, pid, history size, dead flag) AND screen content in one call.

   **Why atomic:** Previously two separate calls. Cursor could move between them, causing the visual cursor to appear offset from where input goes. The `;` separator eliminates this race.

   **Why `-e`:** Preserves SGR escape codes (colors, bold, etc.) in the output. Without it, all styling is stripped. tmux has already interpreted all cursor movement, scroll regions, and clear commands — `capture-pane` returns the **rendered screen** with only SGR styling codes remaining.

   **Why `capture-pane` and not raw bytes:** Day-one decision (2026-03-27). `capture-pane` gives pre-rendered lines — tmux does the terminal emulation. The alternative (interpreting raw terminal bytes with cursor movement, scroll regions, etc.) requires building or importing a terminal emulator. Bibliography: "capture-pane -p -e gives SGR-only re-serialized screen state (no cursor movement codes)." Bibliography: tmux control mode "%output notifications — Not adopted for POC — capture-pane polling is simpler."

2. **Parse metadata:** First line: `80 24 15 5 12345 100 0 bash /home/user My Title` → `{ width, height, cursor: {x, y}, pid, historySize, dead, command, path, title }`

3. **Parse each screen line:** `parseLine()` from sgr-parser.mjs walks each character:
   - `ESC [ ... m` (SGR): updates style state (fg, bg, bold, italic, underline, dim, strikethrough, reverse, hidden, overline, underlineColor)
   - `ESC ] ... BEL/ST` (OSC): parses hyperlinks (OSC 8), strips other OSC sequences
   - Other `ESC` sequences: stripped (non-SGR control codes already interpreted by tmux)
   - Plain text: accumulated into Span objects with current style

   Output per line: `[{ text, cls, fg, bg, bgCls, bold, italic, underline, dim, strikethrough, url, ... }]`

   Standard colors (0-15) → CSS class names. Extended colors (16-255) → hex strings from color-table.mjs. Truecolor → hex directly.

   **Why the server parses:** Originally an HTTP API (`GET /api/pane`) returning JSON. REST endpoints return structured data. When WebSocket replaced HTTP, nobody revisited whether the server should still parse. The transport changed, the pipeline didn't. (See §5.4 for future direction.)

4. **Diff against last state:** `diffState(prev, curr)` compares two state objects:
   - First capture (prev is null): returns `{ type: 'screen', ... }` with ALL lines
   - Dimensions changed: returns full `screen`
   - Otherwise: `JSON.stringify` each line's Spans, compare strings line-by-line
     - Nothing changed (no lines, cursor, or title differ): returns **null**
     - Something changed: returns `{ type: 'delta', changed: { lineIdx: {spans} } }` with only changed lines

   **Why diff exists:** tmux has no incremental API. `capture-pane` always returns the full screen. The diff prevents sending unchanged data. On idle terminals, diff returns null every time — **the diff IS the push notification.** Nothing changed = nothing sent.

   **The waste:** When diff returns null, the child process was already spawned, the parsing already happened, the JSON serialization already happened. All discarded. This is the cost of polling without change detection.

5. **Send or discard:**
   - null: nothing sent. WebSocket stays open. Timer fires again in 30ms.
   - screen/delta: `ws.send(JSON.stringify(diff))` with `scrollOffset` appended.

**This entire loop runs independently per WebSocket connection.** 5 browsers viewing session A = 5 child processes every 30ms capturing identical data from the same tmux session.

### 2.2 How the Browser Renders

terminal.svg `ws.onmessage` receives JSON:

**`type: 'screen'` (full):**
1. `initLayout(width, height)` if dimensions changed — creates one `<text>` SVG element per row, sets `viewBox`
2. For each line: `updateLine(i, spans)` — clears `<text>`, creates `<tspan>` per Span with `x` positioned at `charOffset × CELL_W`, `fill` for hex colors, `class` for CSS colors, `text-decoration` for underline/strikethrough
3. `rebuildBgLayer()` — clears and rebuilds all `<rect>` elements for background colors
4. `rebuildLinkLayer()` — clears and rebuilds blue underline `<line>` elements for URLs
5. Updates cursor position (`cursorEl` x/y)
6. Calls `window._screenCallback(msg)` → dashboard.mjs knows about the update

**`type: 'delta'` (changed lines):**
Same as above but only for lines in `msg.changed`. Background and link layers still fully rebuilt (known inefficiency).

**`type: 'error'`:**
Shows error overlay on the SVG.

### 2.3 How Input Flows Back

Keystrokes captured by dashboard's document-level `keydown` handler:
```
dashboard.mjs: t.sendInput({ type: 'input', keys: 'a' })
  → t.dom.querySelector('object').contentWindow.sendToWs(msg)
  → terminal.svg: ws.send(JSON.stringify(msg))
  → server.mjs: handleTerminalWs ws.on('message')
  → tmux send-keys -t session:pane -l 'a'
```

Key names translated from claude-proxy format to tmux format (Backspace→BSpace, Delete→DC, PageUp→PgUp, PageDown→PgDn, Insert→IC). After sending to tmux, scroll offset resets to 0 (snap to live view) and an extra capture fires after 5ms.

### 2.4 How Scrollback Works

**DO NOT CHANGE.** Scrollback uses tmux as the store. Survives server restarts.

Browser sends `{ type: 'scroll', offset: N }`. Server calls `capturePaneAt(session, pane, offset)` which runs `tmux capture-pane -p -e -S {-offset} -E {-offset+height-1}`. Negative line numbers reach into tmux's scrollback history. Depth = tmux `history-limit` (default 2000 lines).

Scroll offset is ephemeral in-memory state (`paneScrollOffsets` Map, keyed by `session:pane`). Resets on disconnect. Shared across all connections to the same pane.

Any keyboard input resets scroll to 0 — ensures user sees command output after typing.

**Why tmux and not xterm/headless:** xterm has no scrollback in alternate screen mode. Claude-proxy proved this — commit 7aa1323 ("fix: scroll uses tmux capture-pane instead of xterm buffer") fell back to tmux for scrollback. tmux scrollback is persistent, unlimited (within history-limit), and survives restarts.

### 2.5 How Resize Works

Browser sends `{ type: 'resize', cols, rows }`. Server checks a per-session resize lock (500ms, prevents multi-browser fighting), then calls `tmux resize-window -t session -x cols -y rows`.

**Why resize-window, not resize-pane:** resize-pane only works within the window's current size constraints. resize-window changes the window dimensions which allows the pane to fill them.

**Hard constraint:** Only user-initiated actions send outbound resize commands. Incoming screen data with new dimensions NEVER triggers an outbound resize. Violation creates cross-browser feedback loop. (See PRD v0.4.0 §8 Constraints.)

### 2.6 How Reconnection Works

**Browser closes WebSocket (intentional or network):** Server clears poll timer, resets scroll. terminal.svg starts HTTP poll fallback at 150ms (legacy) and WebSocket reconnect at 2s. On reconnect: server creates new poll loop, first capture sends full screen (lastState is null).

**Server restarts:** All WebSockets drop. terminal.svg reconnects at 2s intervals. tmux sessions survive (separate daemon). Full scrollback preserved.

### 2.7 Claude-Proxy Sessions

For sessions not in local tmux (prefixed `cp-`), server opens a WebSocket to `ws://127.0.0.1:3101/api/session/{id}/stream` and bridges messages bidirectionally. No polling — claude-proxy is already event-driven with its own xterm/headless + onWriteParsed + 30ms batch timer.

---

## 3. What Changes

### 3.1 Single WebSocket Per Browser

**Today:** Each terminal card (terminal.svg) opens its own WebSocket. 30 cards = 30 WebSockets.

**After:** Dashboard.mjs opens ONE WebSocket to the server. All session data flows on this connection, tagged with `session` and `pane` fields. Terminal.svg no longer owns a WebSocket — dashboard pushes data into it.

**Why:** 30 browsers × 30 sessions = 900 WebSocket connections today. With single WebSocket: 30 connections. Server tracks 30 clients instead of 900. Each session's data is captured once and sent to each browser that needs it.

**Wire format — every message is self-contained JSON:**

Server → Browser:
```json
{ "session": "cp-AARON", "pane": "0", "type": "screen",
  "width": 80, "height": 24, "cursor": {"x": 15, "y": 5},
  "title": "claude", "scrollOffset": 0,
  "lines": [{"spans": [{"text": "hello", "bold": true, "fg": "#5fff00"}]}] }

{ "session": "cp-AARON", "pane": "0", "type": "delta",
  "cursor": {"x": 3, "y": 5}, "title": "claude",
  "changed": {"5": {"spans": [{"text": "new output"}]}} }

{ "type": "session-add", "session": "cp-NEW", "cols": 120, "rows": 40,
  "title": "claude", "source": "claude-proxy" }

{ "type": "session-remove", "session": "cp-OLD" }

{ "session": "cp-AARON", "type": "error", "message": "session not found" }
```

Browser → Server:
```json
{ "type": "auth", "token": "session-cookie-value" }

{ "session": "cp-AARON", "pane": "0", "type": "input", "keys": "hello" }

{ "session": "cp-AARON", "pane": "0", "type": "input", "specialKey": "Enter" }

{ "session": "cp-AARON", "pane": "0", "type": "scroll", "offset": 24 }

{ "session": "cp-AARON", "pane": "0", "type": "resize", "cols": 100, "rows": 30 }
```

Messages for different sessions arrive interleaved on the same connection. No combining, no packaging, no reassembly. Each message is complete and independent.

**Browser-side routing:**
```javascript
ws.onmessage = function(e) {
  var msg = JSON.parse(e.data);
  if (msg.session) {
    var card = terminals.get(msg.session);
    if (card) card.render(msg);
    // no card → ignore (user doesn't have this session displayed)
  } else {
    // session-level events: session-add, session-remove, reload, throttle
    handleSystemMessage(msg);
  }
};
```

**Why server broadcasts everything (no per-user subscription filtering):**
Simpler server — no subscription list, no per-user state tracking. Browser renders what it has cards for, ignores the rest. Bandwidth is trivial on LAN (~5KB per screen × 30 sessions = ~150KB per update cycle at most). Security is enforced at session visibility level (server only reports sessions the user is authorized to see in session-add events) and at tmux Unix permissions (the actual security boundary — see PRD v0.4.0 §8), not at the data delivery level.

**Tradeoff:** A browser receives data for sessions it doesn't currently have cards for. The data is discarded (`terminals.get()` returns null). This wastes some bandwidth but eliminates subscription management complexity. At 30 sessions × ~5KB = ~150KB per update cycle on a LAN, this is negligible. If session counts grow to hundreds, revisit.

### 3.2 Shared Capture Per Session

**Today:** N browsers × M sessions = N×M independent poll loops, each spawning `tmux capture-pane` every 30ms.

**After:** One poll loop per session. Captures once, broadcasts to all connected browsers.

**Implementation:** Server maintains a Map of active session watchers. Each watcher runs a `setInterval` that calls `captureAndPush` for its session. When a session is first discovered (via `session-add`), a watcher starts. When a session disappears, the watcher stops.

`handleTerminalWs` is replaced. The per-connection poll loop is gone. Input, scroll, and resize messages arrive on the shared WebSocket, tagged with session — server routes them to the right tmux session.

**Benchmarks (measured on this system, 2026-03-31):**

| Metric | Value |
|--------|-------|
| 30 sequential capture-pane calls | 58ms (~2ms each) |
| 30 concurrent capture-pane calls | 13ms (~0.4ms effective) |
| 30 screens SGR parsing | 2.6ms (0.09ms per screen) |
| Total per shared cycle (30 sessions) | ~16ms |

**Scaling comparison:**

| Architecture | Captures per cycle | Sessions × Browsers |
|---|---|---|
| Current (per-connection) | N × M | 30 × 30 = 900 |
| Shared (per-session) | M | 30 |
| Reduction | | **30×** |

### 3.3 Tunable Poll Interval

**Today:** Hardcoded `setInterval(captureAndPush, 30)`. No documentation exists for why 30ms was chosen.

**After:** Configurable, default 100ms.

**Why not 30ms:** 30ms = 33fps. Appropriate for video, overkill for terminal text. Terminal output appears in bursts (command finishes, Claude responds), not continuous animation. 100ms = 10fps, still feels responsive for typing and reading output. Nobody tested different values — 30ms was the first number that worked and was never revisited.

**Why not slower:** 200ms+ starts to feel sluggish when typing. The user expects to see their keystrokes reflected quickly. 100ms is a reasonable default — fast enough for interactivity, slow enough to cut capture volume by 3× vs 30ms.

**The interval is a tunable, not a constant.** Can be adjusted at runtime via server-side throttle (§3.4).

### 3.4 Server-Side Throttle via SSE

**Today:** SSE channel (`GET /api/events`) exists, supports `reload` and `dom` commands.

**After:** Add `throttle` command. Server monitors its own load and pushes interval adjustments:

```json
event: throttle
data: {"interval": 200}
```

Browser receives this and adjusts its behavior (e.g., how quickly it requests re-renders, or server adjusts its own capture interval and notifies browsers).

**Why SSE and not WebSocket:** SSE is the existing server-to-all-browsers push channel. It's separate from the per-browser data WebSocket. A throttle command applies to ALL browsers — SSE broadcasts to all. The WebSocket carries per-session data.

**Why server-side control:** The server knows its own load. Browsers don't. When 30 sessions are all active and the server is struggling, the server pushes `interval: 500` → captures slow down → load drops → server pushes `interval: 100` → captures speed up. The server is the authority on its own capacity.

### 3.5 Session Lifecycle via WebSocket

**Today:** Dashboard polls `GET /api/sessions` every 5 seconds to discover new/removed sessions.

**After:** Server pushes `session-add` and `session-remove` messages on the WebSocket when sessions appear or disappear. Dashboard creates/removes cards reactively. No 5-second poll.

**Why:** With a single WebSocket already open, session discovery is just another message type. No reason for a separate HTTP poll. Reduces latency for session discovery from up to 5 seconds to immediate.

**Auth integration:** Browser sends `{ type: "auth", token }` as first message on WebSocket connect. Server validates the session cookie, looks up the user, determines which sessions they can see. Server immediately sends `session-add` for all visible sessions, followed by initial `screen` messages for each.

---

## 4. What Does NOT Change

| Component | Why it stays |
|---|---|
| `capture-pane -e` as data source | tmux does the terminal emulation. Gives pre-rendered lines with SGR only. No terminal emulator needed. Day-one decision, still correct. |
| `sgr-parser.mjs` / `parseLine()` | ANSI → Spans conversion. Works correctly. May move to browser later (§5.4) but not in this change. |
| `diffState()` | tmux has no incremental API — always returns full screen. Diff prevents sending unchanged data. The diff IS the push notification: null = nothing to send. |
| terminal.svg SVG rendering | updateLine → tspan creation, rebuildBgLayer → rect creation, rebuildLinkLayer. Fragile, correct, do not touch. |
| Span data format | `{ text, cls, fg, bg, bgCls, bold, italic, underline, dim, strikethrough, url, ... }`. Standard colors → CSS classes. Extended → hex. This is the contract between parser and renderer. |
| Scrollback | `tmux capture-pane -S -E`. tmux is the store. Survives restarts. DO NOT replace with xterm buffer — loses history in alternate screen mode (proven by claude-proxy commit 7aa1323). |
| Claude-proxy WS bridge | Already event-driven. Server proxies to `ws://localhost:3101/api/session/{id}/stream`. |
| Resize lock | 500ms per-session lock prevents multi-browser fighting. |
| tmux sessions | **SACRED. Never kill.** Sessions survive server restarts. The server and svg-terminal can be restarted freely. |

---

## 5. Open Design Questions

### 5.1 Terminal.svg Becomes a Passive Renderer

Today terminal.svg is self-contained — it connects its own WebSocket, receives data, renders. After this change, dashboard.mjs owns the WebSocket and pushes data into terminal.svg.

Terminal.svg needs an inbound API — something like `window.renderMessage(msg)` that does what `ws.onmessage` currently does. Dashboard calls `cardObject.contentWindow.renderMessage(msg)`.

Input reverses too: today terminal.svg sends input on its own WebSocket via `sendToWs`. After, dashboard sends directly on the shared WebSocket. Terminal.svg doesn't need to send anything.

**Risk:** terminal.svg stops working standalone. You can't load it in a browser tab and see a terminal — it needs dashboard.mjs to feed it. Is that acceptable?

### 5.2 Reconnection

Single WebSocket failure = all terminals go dark at once. Today each card reconnects independently — one can work while others recover.

Dashboard must handle reconnection for everything: exponential backoff, re-auth on connect, server sends full `screen` for all sessions on reconnect (re-sync).

**Tradeoff:** Simpler architecture (one connection) vs less resilient (one failure point). On a LAN, WebSocket drops are rare and reconnection is fast.

### 5.3 What Depends on the Poll

The capture returns more than screen content: cursor position, title, dimensions, dead flag, historySize, command, path. All come from the same `display-message` + `capture-pane` call.

If we slow the poll to 100ms, these all update at 100ms instead of 30ms. Cursor blink would be slower. External resize detection takes longer. Session death detection takes longer.

**Assessment:** 100ms is fine for all of these. Cursor blink at 10fps is indistinguishable from 33fps. External resizes are rare. Session death detection at 100ms vs 30ms is imperceptible.

### 5.4 Server-Side Parsing May Move to Browser (Future)

Server currently runs `parseLine()` on every line before sending. This was natural when the system was an HTTP API returning JSON. With WebSocket, the server could send raw ANSI strings and let the browser parse.

**Advantages:** Server becomes a pure pass-through (capture → tag → send). Raw ANSI strings are smaller than JSON Span arrays — less bandwidth. Parsing work distributed across 30 browsers instead of one server.

**Disadvantages:** terminal.svg expects pre-parsed Spans. Need to embed or load sgr-parser in the browser. More browser-side code.

**Decision:** Not in this change. Server continues parsing. Revisit when server CPU becomes the bottleneck after shared capture is implemented.

### 5.5 Raw String Diff Optimization (Future)

`diffState` currently parses all lines, then `JSON.stringify`s all Spans to compare. Could instead compare raw ANSI strings before parsing — only parse lines that actually changed. Saves parser + serialization cost on unchanged lines.

**Decision:** Optimization. Not blocking. Revisit after measuring real-world diff costs with shared capture.

---

## 6. Legacy Code Removal

All built before WebSocket existed or as safety nets during the WebSocket transition. None needed for new sessions. Old pre-WebSocket sessions are still alive but will be terminated — no new ones will be created.

### 6.1 terminal.svg — HTTP Polling Fallback

| Code | Lines | Purpose | Why remove |
|------|-------|---------|-----------|
| `poll()` | 354-410 | HTTP polling via `GET /api/pane` | WebSocket is the only path. Predates WebSocket. |
| `schedulePoll()` | 144-149 | Poll timer scheduling | No polling. |
| `stopPolling()` | 151-156 | Poll timer cleanup | No polling. |
| `startPolling()` | 429-437 | Start poll with interval | No polling. |
| `pollInterval`, `pollTimer`, `RETRY_MS` | 120-122 | Poll state | No polling. |
| Tier measurement | 415-427 | Adaptive poll rate by SVG visibility | No polling. Was clever — adjusts rate based on how large the SVG is rendered. But irrelevant when server pushes. |
| IntersectionObserver | 439-465 | Stop poll for offscreen cards | No polling. |
| Safety-net `schedulePoll()` | 608 | Fallback if WebSocket failed | **Actively harmful.** Fires before WebSocket connects, hits `/api/pane` for sessions that only support WebSocket. Causes 404/500 errors in console on every new session. |

### 6.2 server.mjs — HTTP Data Endpoints

| Code | Lines | Purpose | Why remove |
|------|-------|---------|-----------|
| `handlePane()` | 202-214 | `GET /api/pane` | Was for HTTP polling. WebSocket delivers screen data. |
| `handleInput()` | 241-286 | `POST /api/input` | Was for HTTP keystroke input. WebSocket delivers input. |
| Per-connection `setInterval` in `handleTerminalWs` | 442 | Per-connection poll loop | Replaced by shared per-session watcher. |

**`capturePane()` and `capturePaneAt()` stay** — called by the shared watcher and scroll handler. Core infrastructure.

### 6.3 dashboard.mjs — HTTP Title Polling

| Code | Lines | Purpose | Why remove |
|------|-------|---------|-----------|
| `fetchTitle()` | 1518-1525 | Title via `GET /api/pane` | Titles arrive in every WebSocket screen/delta message. This HTTP call is redundant AND broken — returns 500 for claude-proxy sessions because `capturePane()` can't find them in local tmux. |
| `refreshTitles()` + `setInterval` | 1510-1515, 563 | 10s title poll | Not needed. |
| HTTP POST fallback in `sendInput()` | 1659-1663 | Fallback when WS unavailable | WS is the only path. |

---

## 7. Rejected Alternatives

Each was considered during the research process (journals v0.1–v0.4). Included here with reasoning so future agents don't re-propose them.

### 7.1 xterm/headless as Data Source (Journal v0.1)

**Proposal:** Replace tmux capture-pane with xterm/headless terminal emulator. Use `onWriteParsed` events for change detection.

**Rejected because:**
- **Loses scrollback in alternate screen mode.** Claude-proxy proved this — commit 7aa1323 ("fix: scroll uses tmux capture-pane instead of xterm buffer") fell back to tmux. Claude Code runs in alternate screen.
- Adds a dependency to a zero-dep server
- Requires maintaining a second buffer per session
- Has its own ANSI parser (`lineToSpans`) doing the same job as sgr-parser.mjs
- Still needs tmux for session management and scrollback anyway

### 7.2 Adaptive Backoff (Journal v0.2)

**Proposal:** When `diffState` returns null repeatedly, slow the poll from 30ms → 100ms → 500ms → 1000ms. Snap back to 30ms on input.

**Rejected because:**
- Optimizes polling frequency instead of fixing the duplication problem
- The problem was 900 captures (N×M), not the interval
- Adds complexity (backoff curves, snap-back propagation across clients) for an incomplete fix
- Shared capture alone reduces captures 30× — backoff becomes unnecessary

### 7.3 tmux Control Mode as Event Trigger (Journal v0.3)

**Proposal:** Run `tmux -C attach-session` per session. Use `%output` notifications as trigger instead of `setInterval`. Only capture when something actually changed.

**Rejected because:**
- `%output` sends raw terminal bytes (cursor movement, scroll regions, everything) — data we can't use directly without a terminal emulator
- We throw away the `%output` data and call `capture-pane` anyway for rendered lines
- Adds a persistent process per session with lifecycle management (stdin must stay open, handle errors, track session creation/destruction)
- Two connections to tmux where one suffices
- Day-one bibliography entry (2026-03-27): "Not adopted for POC — capture-pane polling is simpler." The reasoning still holds.
- Benchmarks show shared polling handles 30 sessions in 16ms — the marginal gain of event-driven (0ms when idle vs 16ms) doesn't justify the added complexity

### 7.4 inotify on PTY Devices (Journal v0.3)

**Proposal:** Use inotify to watch PTY devices for write activity as change detection.

**Rejected because:** Tested on this system — inotify doesn't monitor character devices. tmux screen state lives in process memory, not on disk. Nothing for inotify to watch.

### 7.5 Per-Session WebSocket with Subscription Management

**Proposal:** Keep one WebSocket per browser, but server tracks which sessions each browser subscribes to. Only send data for subscribed sessions.

**Rejected because:** Adds subscription state management on the server for negligible bandwidth savings. On LAN, broadcasting 30 sessions × ~5KB = ~150KB per cycle is trivial. Browser ignores data for sessions it doesn't have cards for (`terminals.get()` returns null → skip). If session counts reach hundreds, revisit.

---

## 8. Constraints (New and Carried Forward)

| Constraint | Reason | Source |
|---|---|---|
| **DO NOT kill tmux sessions** | Sessions are the product. They survive server restarts. Killing them kills active work. | Operations (all sessions) |
| **DO NOT replace scrollback with xterm buffer** | xterm has no scrollback in alternate screen mode. Claude Code uses alternate screen. Claude-proxy proved this — commit 7aa1323. | Tested, proven failure (v0.1 journal) |
| **DO NOT send outbound resize from incoming data** | Creates cross-browser feedback loop. Only user-initiated resize actions may send resize commands. | PRD v0.4.0 §8, proven via resize sync spec v06 |
| **DO NOT change terminal.svg SVG rendering** | The updateLine/rebuildBgLayer/rebuildLinkLayer pipeline is fragile and correct. Changes here break visual output. | Operations (rendering is fragile) |
| **DO NOT add CSS border/box-shadow on `.terminal-3d`** | Triggers Chrome GPU re-rasterization of the entire card under matrix3d transforms. Visible text sharpness mutation. | PRD v0.4.0 §8, user-reported |
| **Capture-pane `;` separator is load-bearing** | Atomic metadata + screen capture prevents cursor/content race condition. Two separate calls = cursor offset bug. | server.mjs comment, historical bug |
| **capture-pane `-e` flag is mandatory** | Without it, SGR codes are stripped. All color and styling lost. | tmux man page, sgr-parser depends on it |
| **Shared poll captures must be async (execFile, not execFileSync)** | Synchronous capture blocks the Node.js event loop. With 30 sessions, 30 synchronous calls would stall all WebSocket sends for 58ms. Async calls parallelize in the OS and complete in ~13ms wall time. | Benchmarked 2026-03-31: sequential=58ms, concurrent=13ms |
| **Poll interval must be tunable at runtime** | Server needs to adjust capture rate under load via SSE throttle. Hardcoded intervals cannot respond to changing conditions. | Architecture decision (§3.4) |

---

## 9. Implementation Phases

| Phase | Description | Risk | What Changes |
|---|---|---|---|
| **1** | Shared capture: one poll loop per session, broadcast to all browser WebSockets | Low — server internal refactor, same data format | server.mjs: replace per-connection setInterval with per-session watcher |
| **2** | Single WebSocket per browser: dashboard.mjs owns connection, routes to cards | Medium — browser-side restructuring, terminal.svg becomes passive renderer | dashboard.mjs: WebSocket management. terminal.svg: add renderMessage API, remove WebSocket code |
| **3** | Session lifecycle events: server pushes session-add/session-remove | Low — replaces 5s HTTP poll with WebSocket messages | server.mjs: push events. dashboard.mjs: remove refreshSessions poll |
| **4** | Tunable interval + SSE throttle | Low — add config + one SSE message type | server.mjs: configurable interval, throttle broadcast. dashboard.mjs: handle throttle event |
| **5** | Remove legacy HTTP paths | Low — delete dead code | terminal.svg: remove poll code. server.mjs: remove handlePane, handleInput. dashboard.mjs: remove fetchTitle, refreshTitles |
| **Future** | Move parsing to browser | Medium — browser-side sgr-parser, server becomes pass-through | server.mjs: send raw ANSI. terminal.svg or dashboard.mjs: parse client-side |
