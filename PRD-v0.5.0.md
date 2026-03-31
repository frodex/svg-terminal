# svg-terminal — Product Requirements Document

**Version:** 0.5.0
**Last updated:** 2026-03-31 by agent 6 (crisis recovery session)
**Previous version:** PRD v0.4.0 (2026-03-29, agent 3)
**Branch:** `camera-only-test`
**Research trail:** docs/research/2026-03-31-v0.1 through v0.5-event-driven-terminal-updates-journal.md
**Amendment detail:** docs/PRD-amendment-003.md

### Changes from v0.4.0

- §2.1: Rendering pipeline rewritten — documents complete data lifecycle from tmux to SVG pixel
- §3: Server API — §3.2 `GET /api/pane`, §3.3 `POST /api/input`, §3.4 per-card WebSocket marked **DEPRECATED**
- §3.6–3.8: New — single multiplexed WebSocket, wire format, SSE throttle
- §5.4: Reactive sizing — `refreshSessions` HTTP poll replaced by WebSocket session events
- §8: Constraints — added 6 new constraints from crash investigation and benchmarking
- §9: Anti-patterns — added 5 entries from v0.5 research (per-connection polling, xterm/headless, etc.)
- §10: Break tests — added shared capture and single WebSocket entries
- §12: Integration — updated for single WebSocket architecture
- §13: Roadmap — reprioritized for stability (single WS + shared capture before features)
- §15: New — scaling analysis with benchmarks

---

## 1. Purpose

A 3D terminal dashboard that renders tmux sessions as floating cards in a Three.js CSS3DRenderer scene. Terminals are interactive — keystrokes, scrollback, copy/paste, resize. Cards can be focused, multi-selected, dragged, and arranged spatially. The system is evolving toward a workspace orchestrator with named scenes, persistent layouts, and heterogeneous card types (terminals, browsers, status panels).

---

## 2. Architecture

### 2.1 Rendering Pipeline — Complete Data Lifecycle

```
tmux session
  → server.mjs (shared capture per session, tunable interval, line diff)
  → single multiplexed WebSocket per browser
  → dashboard.mjs (routes by session tag)
  → terminal.svg (SVG rendering)
  → <object> element inside card DOM
  → CSS3DRenderer (matrix3d)
  → Chrome GPU compositor
  → screen
```

**The 4x scale trick:** Card DOM is oversized (e.g., 1290×1056 pixels). CSS3DObject scale = 0.25. This forces Chrome to rasterize text at high resolution before the 3D transform scales it down. DO NOT remove — text blurs without it.

#### Step 1 — Server captures tmux screen

`execFile('tmux', ['display-message', ..., ';', 'capture-pane', '-p', '-e', '-t', 'session:pane'])`

One child process per capture. The `;` separator makes this atomic — metadata and screen content captured in a single tmux command. Without `;`, cursor position and screen content can get out of sync (cursor moves between two separate calls).

The `-e` flag is mandatory — preserves SGR escape codes (colors, bold, underline, etc.). Without it, all styling is stripped.

**Why capture-pane:** tmux has already interpreted all raw terminal control codes (cursor movement, scroll regions, clear screen). `capture-pane` returns the **rendered screen** with only SGR styling codes remaining. The alternative — interpreting raw terminal bytes — requires a terminal emulator (xterm/headless). Day-one decision (2026-03-27 bibliography): "capture-pane -p -e gives SGR-only re-serialized screen state (no cursor movement codes)." Still correct. See §9 anti-pattern: xterm/headless.

Metadata captured in same call: `width, height, cursor {x,y}, pid, historySize, dead, command, path, title`.

#### Step 2 — Server parses ANSI into Spans

`parseLine()` from sgr-parser.mjs walks each character of each line:
- `ESC [ ... m` (SGR): updates style state → Span properties (fg, bg, bold, italic, underline, dim, strikethrough, reverse, hidden, overline, underlineColor)
- `ESC ] ... BEL/ST` (OSC): hyperlinks via OSC 8 → `url` property. Other OSC stripped.
- Other `ESC` sequences: stripped. tmux already interpreted them.
- Plain text: accumulated into Span objects with current style.

Standard colors (0-15) → CSS class names (`c0`-`c7`, `cb0`-`cb7`). Extended (16-255) → hex strings from color-table.mjs. Truecolor → hex directly. URLs also detected in plain text via `tagPlainUrls()`.

**Why server parses (historical):** Originally an HTTP API (`GET /api/pane`) returning JSON. When WebSocket replaced HTTP, the pipeline wasn't revisited. May move to browser in future (§5.4 note in amendment-003). Not blocking.

#### Step 3 — Server diffs against previous state

`diffState(prev, curr)` compares two state objects via `JSON.stringify` per line:
- First capture / dimension change: full `screen` message (all lines)
- Nothing changed (lines, cursor, title all identical): returns **null** — nothing sent
- Something changed: `delta` message with only changed line indices

**The diff IS the push notification.** When nothing changed, nothing is sent. The WebSocket stays open and idle. The server only pushes data when there's actual new content.

**Why diff exists:** tmux has no incremental API. `capture-pane` always returns the full screen. Without diff, we'd send the entire screen every cycle whether it changed or not.

#### Step 4 — Server sends on multiplexed WebSocket

Tagged with `session` and `pane` fields. Each message is self-contained JSON. Messages for different sessions arrive interleaved on the same browser connection. See §3.6 for wire format.

#### Step 5 — Dashboard routes to card

`dashboard.mjs` receives message, looks up `terminals.get(msg.session)`. If card exists, pushes data into terminal.svg via `contentWindow.renderMessage(msg)`. If no card, message is ignored.

#### Step 6 — terminal.svg renders SVG

For `screen` (full): `initLayout()` creates `<text>` per row, then `updateLine()` per line creates `<tspan>` per Span with explicit `x` positioning at `charOffset × CELL_W`. `rebuildBgLayer()` creates `<rect>` for backgrounds. `rebuildLinkLayer()` creates `<line>` for URL underlines. Cursor position set on `cursorEl`.

For `delta` (changed lines): same rendering but only for lines in `changed`. Background and link layers fully rebuilt (known inefficiency).

**DO NOT change the SVG rendering.** The updateLine/rebuildBgLayer/rebuildLinkLayer pipeline is fragile and correct. Span format, cell dimensions, font metrics, and the `<object>` isolation context are all calibrated together. See §9 anti-patterns: inline SVG, HTML overlay.

### 2.2 Camera-Only Focus

**Current approach.** Cards are ALWAYS at their base DOM size. Focus = camera moves closer. Unfocus = camera moves back. No DOM changes on focus/unfocus. No inner scale transform. No state to restore.

**Why:** The previous approach (DOM resize on focus, inner scale transform, CSS3DObject scale recalculation) created a two-state architecture where every feature that touched card sizing had to handle both ring state and focus state. Alt+drag, +/-, optimize, unfocus — all fought each other. Camera-only eliminated the entire category of bugs.

**Abandoned approach: DOM resize on focus.** Resized the card DOM to fill the viewport for "1:1 pixel mapping." Set `inner.style.transform = scale(innerScale)`. Recalculated `css3dObject.scale`. Required restore on unfocus. Every resize operation needed focus-state branching. Abandoned 2026-03-29.

### 2.3 Frustum-Projected Layout

Multi-focus layout computes in screen pixels, projects into 3D. Each card at its own Z depth where its world size fills its allocated screen rectangle through perspective.

1. Allocate screen area proportional to cell count (cols × rows)
2. Masonry bin-pack into columns
3. Scale to fit usable viewport area
4. Project each card's screen position to world position at its frustum depth
5. Camera pulls back far enough that all focused cards are in front of the ring

**Why cell-count proportional:** Terminals with more content get more screen space. A 120×40 terminal gets ~2.5x the area of a 40×12 terminal.

### 2.4 Card Factory

`createCardDOM(config)` — generic factory for any card type. Config: `{ id, title, type, controls[], contentEl }`. Both terminal and browser cards use the same factory. Header, dots, controls, drag — all inherited.

- `createTerminalDOM(sessionName)` — `<object>` with SVG
- `createBrowserDOM(cardId, url)` — `<iframe>` with URL

### 2.5 Node Model (Target Architecture)

Everything is a node with the same structure:

```
node: {
  id, parent, position, rotation, scale, children,
  terminal: { sessionName, fontSize, cardW, cardH } | null,
  camera: { fov, aspect, active } | null
}
```

Parent determines coordinate space: camera (HUD), group (rigid body), world (pinned), ring (auto-layout). NOT YET IMPLEMENTED — current code uses flat maps, not a tree.

---

## 3. Server API

### 3.1 GET /api/sessions

**DEPRECATED — replaced by session-add/session-remove events on WebSocket (§3.7).**

Returns tmux session list with dimensions. Still used during transition while HTTP discovery poll exists.

```json
[{ "name": "resize-test", "windows": 1, "cols": 80, "rows": 24 }]
```

Source: `tmux list-sessions -F '#{session_name} #{session_windows} #{window_width} #{window_height}'` merged with `GET localhost:3101/api/sessions` (claude-proxy).

### 3.2 GET /api/pane?session=X&pane=Y — DEPRECATED

**DEPRECATED — replaced by WebSocket screen/delta messages (§3.6).**

Was the HTTP polling endpoint. Built before WebSocket existed. Returns captured pane content with cursor, title, lines, spans. Causes 500 errors on claude-proxy sessions (calls `capturePane()` which can't find them in local tmux).

**Removal:** Delete `handlePane()` in server.mjs (lines 202-214) and route in router.

### 3.3 POST /api/input — DEPRECATED

**DEPRECATED — replaced by WebSocket input messages (§3.6).**

Was the HTTP keystroke endpoint. Built before WebSocket existed. Body: `{ session, pane, keys?, specialKey? }`

**Removal:** Delete `handleInput()` in server.mjs (lines 241-286) and route in router.

### 3.4 WebSocket /ws/terminal?session=X&pane=Y — DEPRECATED

**DEPRECATED — replaced by single multiplexed WebSocket (§3.6).**

One WebSocket per terminal card. Each connection triggers its own 30ms poll loop on the server. N browsers × M sessions = N×M independent captures. This was the architecture that caused the server meltdown on 2026-03-30.

**Why it was built this way:** Simplest thing that worked for one browser. Each terminal.svg opened its own connection, server polled on its behalf. Nobody rethought it when multiple browsers connected.

**Why it's being replaced:** 30 browsers × 30 sessions = 900 independent poll loops, each spawning a child process every 30ms. Server hit 55% CPU with 25 connections on idle terminals. Would not survive 30×30.

### 3.5 GET/POST /api/layout?uid=X

Browser layout profiles. GET returns saved state, POST saves state. Stored at `profiles/<uid>.json`.

### 3.6 WebSocket /ws/dashboard — NEW

**Single multiplexed WebSocket per browser.** Replaces per-card WebSocket (§3.4). All session data, input, scroll, and resize messages flow on this one connection, tagged with `session` and `pane` fields.

**Why single WebSocket:** 30 browsers × 30 sessions = 900 connections under old model. With single WebSocket: 30 connections. Server captures each session once and sends to all browsers, instead of capturing N times for N connections to the same session. See §15 scaling analysis.

**Per-user session filtering:** Server determines which sessions the authenticated user can access and only subscribes their WebSocket to those session watchers. Auth flow: cookie from WebSocket upgrade request headers → `getAuthUser()` → `linux_user` → check tmux socket permissions (UGO model). When `AUTH_ENABLED` is false (dev mode), user is root with access to all sessions. Each browser only receives data for sessions its user is authorized to see. Terminal output (which may contain passwords, keys, private data) never reaches unauthorized browsers. The SessionWatcher `subscribers` Set naturally handles this — each watcher only broadcasts to WebSockets that were explicitly subscribed via the auth-filtered discovery.

**Connection lifecycle:**

1. Browser opens WebSocket to `/ws/dashboard` (browser sends cookies automatically on upgrade)
2. Server reads session cookie from upgrade request headers via `getAuthUser(req)`
3. Server validates cookie, determines user via `linux_user`, determines visible sessions via tmux socket permissions (UGO)
4. Server sends `session-add` for each visible session
5. Server sends initial `screen` message for each session (full content)
6. Ongoing: server sends `delta`/`screen` messages as sessions produce output
7. Browser sends `input`, `scroll`, `resize` messages tagged with session

**On disconnect/reconnect:** Dashboard handles reconnection with backoff. On reconnect, server re-authenticates and sends full `screen` for all sessions (re-sync).

**Tradeoff — single point of failure:** If the WebSocket drops, all terminals go dark. Under old model, each card reconnected independently. On a LAN, WebSocket drops are rare and reconnection is fast. The simplicity of one connection outweighs the resilience of N connections.

#### Wire Format

Every message is self-contained JSON. `session` + `pane` identify the target. Messages for different sessions arrive interleaved — no combining, no packaging, no reassembly.

**Server → Browser:**

```
Session screen (full refresh):
{ "session": "cp-AARON", "pane": "0", "type": "screen",
  "width": 80, "height": 24,
  "cursor": { "x": 15, "y": 5 },
  "title": "claude --model opus",
  "scrollOffset": 0,
  "lines": [
    { "spans": [{"text": "hello", "bold": true, "fg": "#5fff00"}, {"text": " world"}] },
    { "spans": [{"text": "$ ", "cls": "c2"}] }
  ] }

Session delta (changed lines only):
{ "session": "cp-AARON", "pane": "0", "type": "delta",
  "cursor": { "x": 3, "y": 5 },
  "title": "claude --model opus",
  "changed": {
    "5": { "spans": [{"text": "new output", "fg": "#ff0000"}] },
    "6": { "spans": [{"text": "$ ", "cls": "c2"}] }
  } }

Session discovered:
{ "type": "session-add", "session": "cp-NEW",
  "cols": 120, "rows": 40, "title": "claude", "source": "claude-proxy" }

Session gone:
{ "type": "session-remove", "session": "cp-OLD" }

Error on specific session:
{ "session": "cp-AARON", "type": "error", "message": "session not found" }
```

**Browser → Server:**

```
Keystroke:
{ "session": "cp-AARON", "pane": "0", "type": "input", "keys": "hello" }

Special key:
{ "session": "cp-AARON", "pane": "0", "type": "input", "specialKey": "Enter" }

Ctrl combo:
{ "session": "cp-AARON", "pane": "0", "type": "input", "keys": "c", "ctrl": true }

Scroll:
{ "session": "cp-AARON", "pane": "0", "type": "scroll", "offset": 24 }

Resize:
{ "session": "cp-AARON", "pane": "0", "type": "resize", "cols": 100, "rows": 30 }
```

### 3.7 Session Lifecycle Events — NEW

**Replaces `GET /api/sessions` polling (§3.1).**

Server pushes `session-add` when a new session appears that the user can see. Pushes `session-remove` when a session disappears. Dashboard creates/removes cards reactively.

**Why:** With a WebSocket already open, session discovery is just another message type. The 5-second HTTP poll added latency (up to 5s to discover a new session) and an unnecessary HTTP endpoint.

### 3.8 SSE Throttle — NEW

**Endpoint:** `GET /api/events` (existing SSE channel)

**New event type:**
```
event: throttle
data: {"interval": 200}
```

Server monitors its own load and pushes interval adjustments to all browsers. Browsers adjust accordingly. When load drops, server pushes a faster interval.

**Why SSE, not WebSocket:** The throttle applies to ALL browsers. SSE broadcasts to all connected clients. The WebSocket carries per-browser session data. Different concerns, different channels.

**Why server-side control:** The server knows its load. Browsers don't. The server is the authority on its own capacity.

---

## 4. Client Interactions

### 4.1 Focus System

| Action | Effect |
|--------|--------|
| Click thumbnail | Single focus — camera zooms to card |
| Ctrl+click thumbnail | Add to multi-focus group |
| Click focused card body | Switch active input to that card |
| Click empty space | Deselect — remove input, cards stay in place |
| Escape (from zoomed) | Return to multi-focus grid |
| Escape (from grid) | Full unfocus — cards return to ring |
| Shift+Tab | Cycle zoom through focused cards |

### 4.2 Card Manipulation

| Action | Effect |
|--------|--------|
| Drag title bar | Move card in 3D (camera-relative vectors) |
| Ctrl+drag title bar | Dolly camera toward/away from card |
| Alt+drag card body | Resize card DOM |
| Alt+scroll | Change terminal cols/rows (font size) |
| +/− header buttons | Change cols/rows by ±4/±2 |
| ⊡ header button | Fit terminal to card (resize tmux) |
| ⊞ header button | Fit card to terminal (reshape card) |
| ⌊ header button | Minimize — remove from focus group |

### 4.3 Camera

| Action | Effect |
|--------|--------|
| Scroll wheel (unfocused) | Dolly toward mouse pointer |
| Shift+scroll | Faster dolly toward mouse pointer |
| Drag (unfocused) | Orbit camera |
| Shift+drag | Pan camera X/Y |
| Ctrl+drag | Rotate around origin |
| Right-click drag | Orbit |
| Middle-click drag | Pan |

### 4.4 Terminal

| Action | Effect |
|--------|--------|
| Type | Keystrokes sent to tmux |
| Scroll (focused) | Terminal scrollback |
| Ctrl+C (with selection) | Copy to clipboard |
| Ctrl+C (no selection) | Send C-c to terminal |
| Ctrl+V | Paste from clipboard |
| Shift+arrow | Text selection |

### 4.5 URL Detection

terminal.svg detects `http://` and `https://` URLs in terminal output. Blue underline overlay. Click opens in new tab. Alt+click creates a browser card in the 3D scene.

---

## 5. Card Sizing

### 5.1 Startup

`calcCardSize(cols, rows)` derives card DOM dimensions from terminal aspect ratio. All ring cards have uniform visual weight (`TARGET_WORLD_AREA = 320 × 248`), different shapes.

Constants: `SVG_CELL_W = 8.65`, `SVG_CELL_H = 17`, `HEADER_H = 72`.

### 5.2 During Focus

Card DOM always reflects current terminal dimensions. +/− changes cols/rows, and the card reshapes to match. The camera-only model handles apparent size via camera distance. External resizes (other browsers, SSH clients) are immediately visible. Alt+drag changes card DOM directly. `updateCardForNewSize` skips DOM updates when focused — only updates `baseCardW/baseCardH` so unfocus restores correctly.

### 5.3 Optimize (Two Directions)

- **⊡ Fit terminal to card:** Resize tmux so content fills current card. Card stays.
- **⊞ Fit card to terminal:** Reshape card to wrap current content. Same as startup `calcCardSize`.

### 5.4 Reactive Sizing

**Previously:** `refreshSessions` polled `GET /api/sessions` every 5s and called `updateCardForNewSize` for dimension changes.

**Now:** Dimension changes arrive via the multiplexed WebSocket in every `screen` message (width/height fields). `_screenCallback` calls `updateCardForNewSize`. No HTTP poll needed for sizing — it's part of the data stream.

For unfocused cards, `updateCardForNewSize` reshapes the card when tmux dimensions change (from any source). For focused cards, `baseCardW/baseCardH` update silently.

---

## 6. Event Routing

### 6.1 Three Click Paths

1. `onMouseUp` (document) — ctrl+click for multi-focus via `handleCtrlClick`
2. `onSceneClick` (renderer.domElement) — regular click, focus switch, deselect
3. Thumbnail click (sidebar) — direct `focusTerminal` or `addToFocus`

### 6.2 Flags

| Flag | Purpose |
|------|---------|
| `mouseDownOnSidebar` | Prevents `handleCtrlClick` firing on sidebar ctrl+clicks |
| `suppressNextClick` | Prevents `onSceneClick` after `handleCtrlClick` (only set for 3D scene ctrl+clicks) |
| `lastAddToFocusTime` | 200ms guard prevents `focusTerminal` after `addToFocus` |
| `ctrlHeld` / `altHeld` | Tracked via keydown/keyup (e.ctrlKey unreliable on Windows) |
| `_lastDragWasReal` | Set in `onMouseUp`, cleared in `onSceneClick` — replaces stale `dragDistance` |
| `_userPositioned` | Set by drag/resize — prevents `calculateFocusedLayout` from overriding |
| `_savedZ` | Tracks pre-slide Z for active card — prevents Z creep on deselect/re-select |

### 6.3 CSS3D Hit Testing Is 2D

**CRITICAL.** `e.target.closest()` and `getBoundingClientRect()` do not respect Z depth in CSS3DRenderer. A large card behind a small card can intercept clicks meant for the small card.

**Solution:** Coordinate-based hit testing. Check click position against all focused card header rects manually instead of relying on DOM event targeting.

**Abandoned approach:** `e.target.closest('.terminal-3d header')` — fails when cards overlap in screen space at different Z depths. Discovered 2026-03-29.

### 6.4 Text Selection

Capture-phase mousedown listener. Must skip header clicks (coordinate check, not `e.target.closest`). `screenToCell` maps screen coordinates to terminal character grid.

**Known bug:** Selection overlay is misaligned under CSS3D transforms. Needs `screenToCardCoords()` that inverts the matrix3d. Same fix benefits header hit testing.

---

## 7. Visual Design

### 7.1 Ring Layout

Cards orbit in two rings (outer radius 500, inner radius 300). Ring tilt, card tilt, spin speed configurable via `RING` constant. Billboard slerp faces cards toward camera.

### 7.2 Ring During Focus

Ring Z offset eases to `RING_Z_BACK = -800` during focus. Cards fade to 30% opacity. On unfocus, ring eases back to Z=0. Rate: 0.05 per frame.

### 7.3 Active Card Indicator

Gold header background (`#4a4020`) with subtle box-shadow. NO border or box-shadow on `.terminal-3d` — triggers Chrome to re-rasterize the entire card under matrix3d transforms, causing visible text sharpness mutation.

**Abandoned approach:** Gold neon border on `.terminal-3d.input-active`. Caused re-rasterization. Discovered 2026-03-29.

### 7.4 Active Card Z-Slide

Active card slides forward by `READING_Z_OFFSET = 25` world units. `_savedZ` tracks pre-slide position. Cleared on deselect. Prevents Z creep on select/deselect cycles.

### 7.5 Debug Background

Card background is `#2e2e32` (lightened from `#1c1c1e`) to see card vs terminal edges during development. Revert to `#1c1c1e` for production.

---

## 8. Constraints

| Constraint | Reason | Violation consequence | Verified by |
|-----------|--------|----------------------|-------------|
| 4x scale trick (oversized DOM, 0.25 CSS3DObject scale) | Chrome rasterization quality | Text blurs | agent 1 (discovered), agent 3 (confirmed) |
| SVG rendering target | Cross-browser universality | Edge/Chrome render HTML overlays differently | `[UNVERIFIED]` agent 1 — user directive, not tested cross-browser by agent 3 |
| Camera-only focus (no DOM resize) | Eliminates two-state sizing bugs | Every feature fights focus state | agent 3 (designed and validated) |
| No per-terminal DOM click handlers | Double-fire with ctrl+click | Multi-focus breaks | `[UNVERIFIED]` agent 1 |
| Coordinate-based hit testing in CSS3D | 2D hit testing ignores Z depth | Wrong card intercepts clicks | agent 3 (discovered and fixed) |
| No CSS border/box-shadow on .terminal-3d | Triggers GPU re-rasterization | Text sharpness mutation | agent 3 (user reported, fixed) |
| Atomic tmux capture (`;` separator) | Race condition between cursor and content | Cursor offset | `[UNVERIFIED]` agent 1 |
| `tmux resize-window` not `resize-pane` | resize-pane fails without attached client | Silent resize failure | `[UNVERIFIED]` agent 2 |
| `cp-*` sessions don't accept resize | Managed by claude-proxy with SSH clients | Test only with standalone sessions | agent 3 (confirmed empirically) |
| No outbound resize from incoming data | updateCardForNewSize and _screenCallback must never send a resize command. Only user gestures trigger outbound resizes. Violation creates cross-browser feedback loop. | agent 5 (2026-03-30) |
| DO NOT kill tmux sessions | Sessions are the product. They survive server restarts. The svg-terminal server can be restarted freely. Killing tmux kills active agent work with no recovery. | Operations — all sessions (agent 6) |
| DO NOT replace scrollback with xterm buffer | xterm/headless has no scrollback in alternate screen mode. Claude Code uses alternate screen. Claude-proxy proved this — commit 7aa1323 fell back to tmux capture-pane for scroll. Scrollback MUST use tmux. | Tested, proven failure. Journal v0.1. agent 6 (2026-03-31) |
| capture-pane `;` separator is load-bearing | Atomic metadata + screen capture prevents cursor/content race condition. Two separate tmux calls = cursor can move between them = cursor offset bug. | server.mjs comment, historical bug. agent 6 (2026-03-31) |
| capture-pane `-e` flag is mandatory | Without it, SGR codes are stripped. All color and styling information lost. sgr-parser receives plain text with no escape codes to parse. | tmux man page. agent 6 (2026-03-31) |
| Shared captures MUST be async (execFile) | Synchronous capture (execFileSync) blocks the Node.js event loop. With 30 sessions, synchronous = 58ms blocked. Async = 13ms concurrent. Benchmarked 2026-03-31. | Benchmarked. agent 6 (2026-03-31) |
| Poll interval MUST be tunable at runtime | Server needs to adjust capture rate under load. Hardcoded intervals cannot respond to changing conditions. SSE throttle pushes new interval to browsers. | Architecture decision §3.8. agent 6 (2026-03-31) |

---

## 9. Anti-Patterns (Tried and Abandoned)

Each entry notes whether the change was due to **misunderstood intent** (agents assumed wrong mechanism for the right goal) or **changed intent** (user's goal itself evolved).

| Approach | Problem | Replacement | Intent |
|----------|---------|-------------|--------|
| CSS `transform: scale()` for font zoom | Width/height adjustment counteracted scale | Change tmux cols/rows directly | **Misunderstood intent.** User always wanted font size change. Agents assumed CSS transform; user corrected: "ALL visual size changes come from tmux cols/rows." |
| DOM resize on focus (1:1 pixel mapping) | Two-state architecture, every feature breaks | Camera-only focus | **Misunderstood intent.** Goal was crisp text. Agents assumed bigger DOM = crisper. True, but the two-state complexity was worse than the marginal crispness gain. Understanding of the tradeoff changed. |
| Camera offset for sidebar | Every sign combination wrong | No offset, sidebar is overlay | **Misunderstood intent.** User said "everything is a card in one frustum." Agents were treating the sidebar as a subtracted region. User's spatial model was simpler. |
| Card reshaping on +/- | Card morphs shape on every +/- press | Card stays, font changes inside | **Changed intent.** Originally +/- was "resize terminal" (card follows). User clarified: "the card is my window, +/- is font size inside it." The distinction between window and content crystallized during testing. |
| `focusedSessions.clear()` on deselect | Cards fly to ring | Keep focusedSessions intact | **Changed intent.** Originally deselect meant "return to overview." User clarified: "I want to stay where I am, just release input." Deselect vs unfocus became two separate actions. |
| `e.target.closest` in CSS3D | 2D hit testing picks wrong card | Coordinate-based rect checking | **Misunderstood constraint.** Agents assumed DOM event targeting worked in CSS3D. It doesn't — browser uses 2D bounding rects, ignores Z depth. |
| Border/box-shadow active indicator | Chrome re-rasterizes card | Header background only | **Misunderstood constraint.** CSS changes on a matrix3d-transformed element trigger full re-rasterization. Only discovered by user observing sharpness mutation on focus switch. |
| `_layoutZ` for Z-slide restore | Stale after user moves card | `_savedZ` captures current Z | **Misunderstood intent.** Agents assumed cards return to layout position. User expected cards to stay where they were put. |
| Floating overlay controls bar | Positioning unreliable, intercepts header clicks | Controls inline in card header | **Misunderstood constraint.** Originally thought CSS3D DOM couldn't receive button clicks (getBoundingClientRect returns NaN). Testing proved buttons inside headers work fine. |
| Hardcoded 1280×992 for all cards | Letterboxing, aspect mismatch | `calcCardSize` from tmux cols/rows | **Misunderstood intent.** User expected cards shaped by their terminal content. "You're killing that when you start by forcing all terminals into a forced aspect." |
| Smooth scroll with CSS translateY | Transform and content update overlap, bounce | No animation, 30ms server response sufficient | **Misunderstood constraint.** `[UNVERIFIED]` agent 1 — 8+ iterations tried. The 30ms server response makes animation unnecessary. |
| Inline SVG (replace `<object>`) | Font metrics differ between inline SVG and `<object>` isolated document. getBBox() returns 9.13x21.66 inline vs 8.5x25.5 in `<object>` for same font at same size. Cursor drifts, backgrounds misaligned. | Keep `<object>` isolation, use contentWindow bridge for input | **Misunderstood constraint.** HTML and SVG rendering contexts produce different font measurements. The `<object>` isolation isn't just for font loading — it creates the rendering context that makes the font calibration work. agent 4 (2026-03-30) |
| HTML text overlay on SVG `<object>` | HTML monospace character advance differs from SVG `<tspan>` explicit x-positioning. 0.248px/char drift, ~20px off by column 80. Red text flashing test proved misalignment. | Same as above — SVG is the sole renderer | **Misunderstood constraint.** Even with same font at same size, HTML `getBoundingClientRect()` and SVG `getBBox()` produce different results. Fundamental browser rendering engine difference, not a calibration problem. agent 4 (2026-03-30) |
| Dual WebSocket per terminal (inputWs) | Scroll broken on proxied sessions, keystroke ordering under load, silent connection death | Single WebSocket via contentWindow.sendToWs bridge | **Leftover patch.** Dual WS was added when SVG cards were read-only with a text input bar. When direct keystroke capture replaced the input bar, the second WS should have been removed. Never was. agent 4 (2026-03-30) |
| Focused-card guard blocking external resizes | Prevented external dimension changes from updating focused cards. Multi-browser resize invisible. | Guard removed — card DOM always updates | **Misunderstood constraint.** Guard was added to prevent fight with calculateFocusedLayout. The real fix is re-layout after dimension change, not blocking the update. agent 5 (2026-03-30) |
| Per-connection poll loop (setInterval per WebSocket) | N browsers × M sessions = N×M independent captures of identical data. 30×30 = 900 child processes every 30ms. Melted the server at 25 connections. | Shared capture: one poll per session, broadcast to all browsers | **Never rethought.** Per-connection polling was the simplest thing that worked for one browser. When multiple browsers connected, nobody questioned it. The problem was duplication (900 captures of the same data), not polling itself. Benchmarks: 30 shared captures = 16ms, well within budget. agent 6 (2026-03-31) |
| Hardcoded 30ms poll interval | 33fps, appropriate for video, overkill for terminal text. No documentation for why 30ms was chosen. Wastes 3× the CPU of 100ms for imperceptible difference in text display. | Tunable interval, default 100ms, adjustable via SSE throttle | **POC default never revisited.** Terminal output is bursty (commands finish, Claude responds), not continuous animation. 100ms = 10fps is responsive for typing. 200ms+ feels sluggish. 30ms was the first number tried. agent 6 (2026-03-31) |
| xterm/headless for terminal rendering | Loses scrollback in alternate screen mode. Claude-proxy proved this — commit 7aa1323. Adds dependency. Requires maintaining second buffer per session. Still needs tmux for session management and scrollback. | Keep capture-pane. tmux does the terminal emulation. | **Wrong data source.** Previous agent proposed without verifying scrollback behavior. Admitted mid-session: "I don't have a clear enough understanding of how these pieces fit together to be designing this right now." Journal v0.1. agent 6 (2026-03-31) |
| tmux -C control mode as event trigger | Sends raw bytes (%output) that we'd throw away, then calls capture-pane anyway for rendered lines. Two connections to tmux where one suffices. Persistent process per session with lifecycle management. | Shared polling with diff-as-push-notification. diffState already returns null when nothing changed = nothing sent. | **Solving the wrong problem.** The bottleneck was duplication (900→30), not polling frequency (30→0). Marginal gain (0ms idle vs 16ms) doesn't justify persistent process management. Day-one bibliography: "Not adopted for POC — capture-pane polling is simpler." Still true. agent 6 (2026-03-31) |
| Adaptive backoff (30ms → 100ms → 500ms → 1000ms) | Optimizes polling frequency instead of fixing duplication. Adds backoff curves, snap-back logic across clients. Incomplete fix — still polls N×M times. | Fix the duplication first (shared capture). Then tune the interval. | **Optimizing the wrong dimension.** The problem was 900 captures, not the interval. Shared capture alone = 30× reduction. agent 6 (2026-03-31) |

---

## 10. Break Tests

Items tagged `[UNVERIFIED]` were inherited from agent 1/2 resume docs and not independently tested by agent 3. They were true when written but may have drifted.

| Mutation | What breaks | Detection | Verified by |
|----------|------------|-----------|-------------|
| Remove `syncOrbitFromCamera()` on orbit start | Camera snaps to stale position | Visual: camera jumps | `[UNVERIFIED]` agent 1 |
| Remove `focusQuatFrom` on focus | Card snaps flat before fly-in | Visual: rotation snap | `[UNVERIFIED]` agent 1 |
| Change CSS3DObject scale from 0.25 | Text blurs | Visual: fuzzy text | agent 3 (confirmed) |
| Add per-terminal click handlers | Ctrl+click double-fire | Terminal count wrong | `[UNVERIFIED]` agent 1 |
| Remove event routing flags | Various click/focus bugs | Multi-focus breaks | agent 3 (hit multiple times) |
| Clear `focusedSessions` on deselect | Cards scatter to ring | Visual: cards fly away | agent 3 (discovered and fixed) |
| Don't delete `_savedZ` on deselect | Z accumulates per cycle | Card creeps toward camera | agent 3 (discovered and fixed) |
| Use `e.target.closest` for header hits | Wrong card intercepts | Drag fails on overlapping cards | agent 3 (discovered and fixed) |
| Add border to `.terminal-3d.input-active` | Text sharpness mutation | Visual: text changes on focus switch | agent 3 (user reported, fixed) |
| Use `resize-pane` instead of `resize-window` | Silent failure | Terminal size unchanged | `[UNVERIFIED]` agent 2 |
| Use execFileSync instead of execFile for captures | Event loop blocked for 58ms (30 sessions). All WebSocket sends stall. Browser sees frozen terminals. | Measure: 30 sequential=58ms, 30 concurrent=13ms | agent 6 (benchmarked 2026-03-31) |
| Remove `;` separator in capturePane tmux command | Cursor position captured separately from screen. Cursor can move between calls. Visual cursor offset from actual input position. | Visual: cursor appears in wrong position | agent 6 (code review 2026-03-31) |
| Remove `-e` flag from capture-pane | All SGR codes stripped. sgr-parser receives plain text. No colors, no bold, no styling. | Visual: all terminals monochrome, no styling | agent 6 (code review 2026-03-31) |
| Restore per-connection poll loop | N×M captures instead of M. Server melts at scale. | Monitor: CPU % and child process count | agent 6 (root cause of 2026-03-30 crash) |
| Remove diffState | Full screen sent every cycle regardless of changes. 30 sessions × ~5KB × 10/sec = 1.5MB/sec per browser. Bandwidth not critical on LAN but wasteful. | Monitor: network bandwidth | agent 6 (2026-03-31) |

---

## 11. Testing

### 11.1 Server Tests

`node --test test-server.mjs` — 17 tests. HTTP API, WebSocket, CORS, validation.

### 11.2 E2E Dashboard Tests

`node test-dashboard-e2e.mjs` — 20 tests. Puppeteer headless. Covers: focus, multi-focus, input switching, title bar drag, minimize, shift+tab, resize, card sizing, header controls.

**Rule:** Run E2E with haiku subagent before asking user to test.

### 11.3 Test Gaps

- URL detection and browser cards
- Deselect/re-select Z stability
- Selection overlay alignment
- Camera dolly toward cursor

---

## 12. Integration: claude-proxy

### 12.1 Status

Session discovery works — `server.mjs` merges local tmux + `GET localhost:3101/api/sessions` (uncommitted). WebSocket proxy for claude-proxy sessions is the next step.

### 12.2 Integration Approach (Updated 2026-03-31)

**Spec:** `docs/superpowers/specs/2026-03-30-claude-proxy-websocket-integration-design.md`

**Strategy:** Code to the claude-proxy protocol standard. server.mjs acts as adapter for local tmux sessions. With the single multiplexed WebSocket (§3.6), both session types flow on the same connection:

- **claude-proxy sessions:** server.mjs maintains a WebSocket to `ws://localhost:3101/api/session/{id}/stream` per active cp-* session. Messages are tagged with session name and forwarded to all browsers. Already event-driven — no polling needed on this path.
- **Local tmux sessions:** Shared capture loop (one per session). capturePane → parseLine → diffState → tag with session → send to all browsers. Format translated to match claude-proxy protocol.

**Protocol normalization (adopt claude-proxy as canonical):**
- Delta: `changed[idx] = { spans: [...] }` (wrapped, not raw array)
- Input: Browser key names (`Backspace`, `Delete`, `PageUp`), not tmux names (`BSpace`, `DC`, `PgUp`)
- Ctrl combos: `{ keys: "c", ctrl: true }`, not `{ specialKey: "C-c" }`
- Scroll: `{ type: "scroll", offset: N }`, not `{ type: "input", scrollTo: N }`

**Verified with claude-proxy agent (2026-03-30):**
- No auth needed for localhost WebSocket
- `ws://localhost:3101/api/session/{id}/stream` — id is full tmux id
- Delta, input, resize, scroll formats confirmed against `src/api-server.ts`

### 12.3 Phases

- Phase B (in progress): WebSocket proxy + protocol normalization in server.mjs, dashboard.mjs, terminal.svg
- Phase C: Merge, QC, code style unification
- Phase D (future): Remove server.mjs entirely — claude-proxy serves static files and all sessions

---

## 13. Roadmap

### Now — Stability (server meltdown recovery)
- **S1: Shared capture** — one poll loop per session, broadcast to all browsers. Replaces per-connection setInterval. The fix for the 900→30 capture reduction.
- **S2: Single WebSocket per browser** — dashboard.mjs owns connection, routes to cards. terminal.svg becomes passive renderer. Replaces per-card WebSocket.
- **S3: Session lifecycle events** — server pushes session-add/session-remove on WebSocket. Replaces 5s refreshSessions HTTP poll.
- **S4: Tunable poll interval + SSE throttle** — default 100ms, server pushes throttle under load.
- **S5: Remove legacy HTTP paths** — delete dead code (handlePane, handleInput, poll, refreshTitles, fetchTitle).

### Next — Features (after stability validated at 30×30)
- I1: claude-proxy WebSocket integration (spec written, adapt for single WS)
- F1: Merge camera-only-test → dev (after S1-S5 and I1 validated)
- B1: Fix selection overlay alignment (screenToCardCoords)
- F2: Test URL detection + browser cards
- F3: localStorage persistence (save/restore card prefs)

### Later
- F4: Big bang startup animation (size morph)
- F5: Functional dots (close/minimize/optimize)
- F6: ThinkOrSwim workspace system (named scenes, color tags)
- F7: Mobile support (touch, virtual keys)
- F8: Terminal pinning (world position persistence)
- F9: Groups (rigid body collections)
- F10: Named scenes (camera snapshots)

### Future Optimizations (not blocking)
- Move SGR parsing from server to browser (server becomes pass-through)
- Raw ANSI string diff before parsing (only parse changed lines)
- Explore pipe-pane or tmux hooks if polling at 100ms proves insufficient

---

## 14. File Map

| File | Purpose |
|------|---------|
| `dashboard.mjs` | 3D scene, camera, focus, layout, events, cards (~2300 lines) |
| `dashboard.css` | Card styling, header, controls, indicators, debug background |
| `server.mjs` | HTTP + WebSocket server, tmux integration, layout profiles |
| `terminal.svg` | SVG terminal renderer, WebSocket client, URL detection, selection |
| `index.html` | Page shell, sidebar, help panel, input bar |
| `polyhedra.mjs` | Vertex math, easing functions |
| `test-server.mjs` | 17 server tests |
| `test-dashboard-e2e.mjs` | 20 E2E puppeteer tests |
| `restart-server.sh` | Kill + restart in one command |
| `PRD.md` | Previous version (v0.4.0) — preserved |
| `PRD-v0.5.0.md` | This file — source of truth |
| `TASKLIST.md` | Current bugs, features, priorities |
| `docs/PRD-amendment-001.md` | Superseded — shared capture + backoff proposal |
| `docs/PRD-amendment-002.md` | Superseded — tmux -C proposal |
| `docs/PRD-amendment-003.md` | Supporting detail for v0.5.0 changes |
| `docs/research/2026-03-31-v0.*.md` | Research trail — five iterations of analysis |

---

## 15. Scaling Analysis

### 15.1 The Problem (Measured 2026-03-30)

Server on port 3201, 25 WebSocket connections from one IP (192.168.23.70), terminals mostly idle: **39.9% CPU**. This is 25 connections × 33 captures/sec = 825 child processes/sec producing mostly null diffs.

Server meltdown that triggered port isolation: 170 TCP connections from 4 IPs, 55% CPU, connection cycling. Root cause: stale 4-day-old browser clients + updated server code (see journal: 2026-03-30-v0.1-connection-cycling-crash-journal.md).

### 15.2 Benchmarks (Measured 2026-03-31)

All measurements on production server (droidware), tmux 3.5a, Node.js v22.22.1.

| Operation | Sequential (30×) | Concurrent (30×) | Per unit |
|---|---|---|---|
| `tmux capture-pane -p -e` | 58ms | 13ms | ~0.4ms effective |
| `parseLine()` (41-line screen) | — | 2.6ms total | 0.09ms per screen |

**Key finding:** Parsing is essentially free (0.09ms/screen). The cost is child process spawn, and it parallelizes well (58ms sequential → 13ms concurrent for 30 calls).

### 15.3 Architecture Comparison

| Architecture | Captures/cycle | At 10Hz (100ms) | At 33Hz (30ms) |
|---|---|---|---|
| Current: per-connection (30 browsers × 30 sessions) | 900 | 9,000/sec | 29,700/sec |
| Current: per-connection (1 browser × 25 sessions) | 25 | 250/sec | 825/sec |
| **Proposed: shared (30 sessions)** | **30** | **300/sec** | **990/sec** |

Shared capture at 10Hz = 300 captures/sec. Each takes ~0.4ms concurrent. Total wall time: ~16ms per 100ms cycle = **16% duty cycle**. 84ms idle per cycle.

### 15.4 Bandwidth

| Scenario | Per cycle | At 10Hz | Notes |
|---|---|---|---|
| Full screen per session (no diff) | ~5KB × 30 = 150KB | 1.5 MB/sec per browser | Upper bound, wasteful |
| With diffState (typical, most idle) | ~200B × 5 active = 1KB | 10 KB/sec per browser | Realistic |
| 30 browsers × realistic | — | 300 KB/sec total | Trivial on LAN |

### 15.5 Why Not Event-Driven (tmux -C)

| Metric | Shared polling (100ms) | Event-driven (tmux -C) |
|---|---|---|
| All idle | 300 captures/sec (16ms/cycle) | 0 captures/sec |
| 5 active | 300 captures/sec | ~50 captures/sec |
| All active | 300 captures/sec | ~300 captures/sec |
| Added complexity | None — same execFile | Persistent process per session, lifecycle management, stdin handling, %output parsing |
| Data used from trigger | N/A | Discarded (raw bytes, need terminal emulator to interpret) |

The marginal CPU savings (16ms/cycle → 0ms when idle) doesn't justify persistent process management. And when sessions are active, the capture rate converges anyway. See §9 anti-pattern: tmux -C.

### 15.6 Headroom

At 30 sessions, 100ms interval, shared capture:
- 16ms of the 100ms cycle used for captures + parsing
- 84ms available for diff, serialization, WebSocket send, other server work
- Could support ~180 sessions before captures alone fill the 100ms window (theoretical limit, untested)

If 30 sessions proves tight, first lever: increase interval to 200ms (still responsive, halves capture load). Second lever: SSE throttle under load (§3.8). Third: move parsing to browser (§13 future optimizations).
