# Claude-Proxy WebSocket Integration — Design Spec

**Date:** 2026-03-30
**Status:** Draft
**Branch:** camera-only-test
**Goal:** Get claude-proxy sessions (like session 8) rendering and interactive in the svg-terminal dashboard

---

## Problem

claude-proxy sessions use custom tmux sockets (`-S /var/run/claude-proxy/sessions/...sock`). They're invisible to `tmux list-sessions`. Session discovery already works — `server.mjs` has uncommitted code that merges local tmux + `GET localhost:3101/api/sessions`, tagging each session with `source: "tmux"` or `source: "claude-proxy"`.

What's missing: when a claude-proxy session is focused, the WebSocket connection goes to `handleTerminalWs()` which polls local tmux — and the session isn't there. The connection needs to route to `ws://localhost:3101/api/session/:id/stream` instead.

---

## Approach: WebSocket Proxy in server.mjs

server.mjs acts as the single WebSocket endpoint for the dashboard. When a claude-proxy session connects, server.mjs opens a WebSocket to `localhost:3101` and bridges messages bidirectionally. The dashboard doesn't know which backend it's talking to.

**Why proxy instead of direct connection from dashboard:**
- Dashboard currently has one WebSocket URL pattern (`/ws/terminal?session=X&pane=Y`) — no routing logic needed in the client
- terminal.svg also connects to the same endpoint — would need changes in two places otherwise
- server.mjs already knows which sessions are from claude-proxy (the `source` field)
- Auth can be handled server-side later without changing the client

---

## Protocol Differences to Normalize

### 1. Delta format

| server.mjs (legacy) | claude-proxy |
|---------------------|-------------|
| `changed[idx] = [span, span, ...]` (raw array) | `changed[idx] = { spans: [span, span, ...] }` (wrapped) |

**Decision:** Adopt claude-proxy format as canonical. Fix server.mjs `diffState()` to wrap: `changed[i] = { spans: curr.lines[i].spans }`. Fix dashboard.mjs and terminal.svg to expect `{ spans }` wrapper.

### 2. Input key names

| Dashboard sends (tmux names) | claude-proxy expects |
|------------------------------|---------------------|
| `BSpace` | `Backspace` |
| `DC` | `Delete` |
| `PgUp` | `PageUp` |
| `PgDn` | `PageDown` |
| `IC` | `Insert` |
| `C-c` | `{ keys: "c", ctrl: true }` |

**Decision:** Adopt claude-proxy key names as canonical. Update `SPECIAL_KEY_MAP` in dashboard.mjs. server.mjs legacy handler translates back to tmux names for local sessions.

### 3. Span format

Already compatible. Both use `{ text, fg?, bg?, bold?, italic?, underline?, dim?, strikethrough? }`. svg-terminal also has `cls`, `bgCls`, `url` which claude-proxy doesn't send — those are additive, no conflict.

### 4. Screen message

Already compatible. Both send `{ type: "screen", width, height, cursor, title, lines }`.

### 5. Scroll

| server.mjs (legacy) | claude-proxy |
|---------------------|-------------|
| `{ type: "input", scrollTo: N }` | `{ type: "scroll", offset: N }` |

**Decision:** Adopt claude-proxy format. Dashboard sends `{ type: "scroll", offset: N }`. server.mjs legacy handler translates to `setScrollOffset()` + recapture.

### 6. Resize

Already compatible. Both use `{ type: "resize", cols, rows }`.

---

## Changes by File

### server.mjs

1. **WebSocket proxy for claude-proxy sessions:** In the upgrade handler, check if the session exists in a `cpSessions` set (populated by `handleSessions`). If yes, open a WebSocket to `ws://127.0.0.1:3101/api/session/${sessionId}/stream` and bridge messages bidirectionally (pipe incoming to upstream, pipe upstream to client). If no, use existing `handleTerminalWs`.

2. **Track claude-proxy session names:** `handleSessions` already fetches from both sources. Add a module-level `Set` that tracks which session names came from claude-proxy, updated on each refresh.

3. **Normalize legacy delta format:** In `diffState()`, change line 339 from `changed[i] = curr.lines[i].spans` to `changed[i] = { spans: curr.lines[i].spans }`.

4. **Translate input for legacy sessions:** In `handleTerminalWs`, translate claude-proxy key names back to tmux names before `send-keys`. Map: `Backspace→BSpace`, `Delete→DC`, `PageUp→PgUp`, `PageDown→PgDn`, `Insert→IC`. Handle `{ keys, ctrl }` → `C-${key}`.

5. **Translate scroll for legacy sessions:** In `handleTerminalWs`, handle `{ type: "scroll", offset }` by calling `setScrollOffset()` + recapture (same as current `scrollTo` logic).

### dashboard.mjs

1. **Update SPECIAL_KEY_MAP:** Change to claude-proxy key names (`Backspace`, `Delete`, `PageUp`, `PageDown`, `Insert`).

2. **Update delta handler:** Both WebSocket `onmessage` handlers (in `focusTerminal` and `addToFocus`) change from `msg.changed[idx]` (raw array) to `msg.changed[idx].spans`.

3. **Update Ctrl combo format:** Send `{ type: "input", keys: key, ctrl: true }` instead of `{ type: "input", specialKey: "C-" + key }`.

4. **Update scroll format:** `scrollBy()` sends `{ type: "scroll", offset: N }` instead of `{ type: "input", scrollTo: N }`.

### terminal.svg

1. **Update delta handler:** Change `msg.changed[keys[k]]` (raw array) to `msg.changed[keys[k]].spans`.

---

## What Does NOT Change

- Session discovery (already works)
- Card creation, 3D scene, focus system, layout
- terminal.svg WebSocket connection URL (still `/ws/terminal?session=X&pane=Y`)
- terminal.svg rendering pipeline (spans → tspan elements)
- E2E tests (they test via the dashboard, which routes through server.mjs)
- The 4x scale trick, camera-only focus, coordinate-based hit testing

---

## Testing

1. **Verify session 8 loads:** Focus `cp-SVG-Terminal_CLAUD-PROXY_integration_01` in the dashboard — should render terminal content
2. **Verify input works:** Type in session 8 — keystrokes should appear
3. **Verify local sessions still work:** Focus `resize-test` — should work as before
4. **Run existing tests:** 18 server tests + 23 E2E tests must still pass
5. **Verify scroll:** PgUp/PgDn in both session types

---

## Risks

- **WebSocket proxy adds latency:** One extra hop for claude-proxy sessions. At localhost this should be <1ms. Monitor for dropped frames.
- **Connection lifecycle:** If upstream WS closes, client WS must close too (and vice versa). Need clean teardown.
- **Session name mismatch:** claude-proxy returns `id` (e.g. `cp-SVG-Terminal_CLAUD-PROXY_integration_01`), local tmux returns `name`. The merge logic in `handleSessions` already handles this with `s.id || s.name`.

## Notes from claude-proxy agent review (2026-03-30)

1. **Alt key combos:** claude-proxy supports `{ keys: "x", alt: true }` → ESC+x. Dashboard currently does NOT send alt combos (alt is reserved for text selection, card resize, browser cards). No translation needed now. If alt terminal input is added later, use `{ keys, alt: true }` format.

2. **Title field updates every delta:** claude-proxy includes `title` in every 30ms delta (uptime ticks). Dashboard must not trigger full re-renders on title change. Current implementation only uses title for the sidebar — should be fine, but verify.

3. **Delta changed keys are strings:** JSON object keys are always strings (`"5"` not `5`). Dashboard already uses `Object.entries()` / `Object.keys()` which return strings. terminal.svg uses `parseInt(keys[k])` for indexing. No issue, but noted for clarity.

---

## Future (Out of Scope)

- Auth headers on proxied WebSocket (not needed yet — localhost is trusted)
- Removing server.mjs entirely (Phase C — after claude-proxy serves static files)
- Adapting terminal.svg to connect directly to claude-proxy (eliminates proxy hop)
