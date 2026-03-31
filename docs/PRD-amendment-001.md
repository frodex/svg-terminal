# PRD Amendment 001 — WebSocket-Only Architecture + Polling Deprecation

**Date:** 2026-03-31
**Amends:** PRD v0.4.0 (2026-03-29)
**Status:** Proposed
**Journal:** docs/research/2026-03-31-v0.2-event-driven-terminal-updates-journal.md

---

## 1. Context

Server meltdown on 2026-03-30 exposed scaling problems in the terminal update architecture. Root cause analysis revealed:

1. **Per-connection polling:** Each WebSocket connection runs an independent 30ms poll loop. N browsers × M sessions = N×M child process spawns every 30ms.
2. **Legacy HTTP fallback:** Code paths for pre-WebSocket sessions generate console errors (404/500) on new sessions and waste server resources.
3. **Previous agent's proposal (xterm/headless) was incorrect:** Would have degraded scrollback (xterm has no history in alternate screen mode) and added an unnecessary dependency. Claude-proxy itself had to fall back to tmux capture-pane for scrollback (commit 7aa1323).

**Target capacity:** 30 browsers × 30 sessions, zero CPU when idle.

---

## 2. Amendment: Deprecate HTTP Polling Path

### 2.1 Deprecated Code — Planned Removal

All terminal data and input now flows through WebSocket. The following HTTP-based code paths are **deprecated** and should be marked as such in-code. They will be removed once all pre-WebSocket sessions are terminated.

#### terminal.svg

| Code | Lines | Purpose | Replacement |
|------|-------|---------|-------------|
| `poll()` | 354-410 | HTTP polling via `GET /api/pane` | WebSocket screen/delta messages |
| `schedulePoll()` | 144-149 | Poll timer scheduling | Not needed — WS is persistent |
| `stopPolling()` | 151-156 | Poll timer cleanup | Not needed |
| `startPolling()` | 429-437 | Start poll with interval | Not needed |
| `pollInterval` / `pollTimer` / `RETRY_MS` | 120-122 | Poll state | Not needed |
| Tier measurement | 415-427 | Adaptive poll rate by visibility | Not needed — WS pushes only changes |
| IntersectionObserver polling | 439-465 | Stop/resume poll for offscreen cards | Not needed |
| `schedulePoll(pollInterval)` on line 608 | 608 | Safety net poll start | **Remove** — causes 404/500 on new sessions |

**Startup should be WebSocket-only:**
```javascript
// CURRENT (line 606-611):
if (SESSION) {
  connectWebSocket();
  schedulePoll(pollInterval);  // safety net — DEPRECATED, causes errors
} else {
  startPolling(150);           // no-session fallback — DEPRECATED
}

// TARGET:
if (SESSION) {
  connectWebSocket();
}
```

#### server.mjs

| Code | Lines | Purpose | Replacement |
|------|-------|---------|-------------|
| `handlePane()` | 202-214 | `GET /api/pane` endpoint | WebSocket screen/delta via `handleTerminalWs` |
| `handleInput()` | 241-286 | `POST /api/input` endpoint | WebSocket `{ type: 'input' }` messages |
| `/api/pane` route | 835-837 | HTTP route registration | Remove with endpoint |

**Note:** `capturePane()` and `capturePaneAt()` are NOT deprecated — they are used by the WebSocket handler and are core infrastructure.

#### dashboard.mjs

| Code | Lines | Purpose | Replacement |
|------|-------|---------|-------------|
| `fetchTitle()` | 1518-1525 | HTTP poll for title via `/api/pane` | Titles arrive in every WS screen/delta message `title` field |
| `refreshTitles()` | 1510-1515 | 10s title polling loop | WS-delivered titles |
| `setInterval(refreshTitles, 10000)` | 563 | Title poll timer | Remove |

---

## 3. Amendment: Shared Capture Architecture

### 3.1 Problem

PRD §2.1 describes:
> tmux session → server.mjs (30ms poll, line diff) → WebSocket → terminal.svg

This is per-connection. The actual behavior is:
> N WebSocket connections → N independent 30ms poll loops → N×(tmux capture-pane child processes)

### 3.2 New Architecture

**One watcher per session:pane, broadcasting to all connected clients.**

```
Session "foo":pane "0"
  └── SessionWatcher (single 30ms loop)
        ├── capturePane() or capturePaneAt()
        ├── diffState()
        └── broadcast to all subscribed WebSocket clients
              ├── Browser A WebSocket
              ├── Browser B WebSocket
              └── Browser C WebSocket
```

When a new WebSocket connects for session:pane:
- If a watcher exists → subscribe to it, receive current state immediately
- If no watcher → create one, start polling

When last WebSocket disconnects:
- Tear down the watcher, stop polling

### 3.3 Adaptive Backoff

When `diffState` returns null (no changes) for consecutive cycles, back off:

| Consecutive nulls | Poll interval |
|-------------------|---------------|
| 0-5 | 30ms (active) |
| 6-20 | 100ms |
| 21-50 | 500ms |
| 51+ | 1000ms |

**Snap back to 30ms** when:
- Any client sends `input`, `scroll`, or `resize` for this session
- This propagates across all clients (input on one browser benefits all viewers)

### 3.4 Scroll Handling

Scroll offsets remain per-pane (shared across all clients viewing the same pane). This is existing behavior — `paneScrollOffsets` Map is already keyed by `session:pane`, not by WebSocket connection. No change needed.

---

## 4. Amendment: Correct PRD §2.1 Rendering Pipeline

Current PRD says:
> tmux session → server.mjs (30ms poll, line diff) → WebSocket → terminal.svg (SVG rendering)

Should say:
> tmux session → server.mjs (adaptive poll, shared per session:pane, line diff) → WebSocket broadcast → terminal.svg (SVG rendering)

---

## 5. What Does NOT Change

- sgr-parser.mjs (ANSI → Span conversion)
- terminal.svg rendering (updateLine, rebuildBgLayer, rebuildLinkLayer)
- WebSocket message format (`screen` / `delta`)
- Scrollback via `tmux capture-pane -S -E` (tmux is the scrollback store)
- SSE command channel (`/api/events`)
- Claude-proxy WebSocket proxy bridge
- Session discovery (`GET /api/sessions` + `refreshSessions()` 5s poll)
- 4x scale trick, camera-only focus, CSS3DRenderer
- tmux sessions (sacred — never kill)

---

## 6. Rejected Alternative: xterm/headless Adoption

Previous agent (journal v0.1) proposed adding `@xterm/headless` for event-driven updates. **Rejected** because:

1. **Loses scrollback:** xterm has no history in alternate screen mode. Claude-proxy proved this — commit 7aa1323 fell back to `tmux capture-pane` for scroll.
2. **Adds dependency:** svg-terminal server is zero-dep (Node built-ins + ws). Adding xterm/headless + maintaining a second vterm buffer per session is unnecessary complexity.
3. **Redundant rendering:** sgr-parser.mjs already converts ANSI → Spans. xterm/headless + `lineToSpans()` does the same thing differently. Two parsers for the same data.
4. **Shared capture + adaptive backoff achieves the goal:** Zero CPU on idle, same latency on active, no new dependencies, no scrollback regression.

---

## 7. Scaling Estimate

**Current (broken):** 30 browsers × 12 sessions × 33 polls/sec = ~12,000 child processes/sec

**After shared capture:** 12 sessions × 33 polls/sec = ~400 child processes/sec (30x reduction)

**After adaptive backoff (idle):** 12 idle sessions × 1 poll/sec = 12 child processes/sec

**Target capacity:** 30 browsers × 30 sessions:
- Active: 30 sessions × 33 polls/sec = ~1,000 child processes/sec (manageable)
- Idle: 30 sessions × 1 poll/sec = 30 child processes/sec (negligible)

---

## 8. Implementation Phases

| Phase | Description | Risk | Dependencies |
|-------|-------------|------|-------------|
| 1 | Shared capture per session:pane | Low — internal refactor, same external behavior | None |
| 2 | Adaptive backoff on idle | Low — performance optimization | Phase 1 |
| 3 | Mark deprecated code, remove safety-net poll | Low — reduces console errors | None (can parallel) |
| 4 | Remove deprecated HTTP endpoints + polling | Low — cleanup | Old sessions terminated |
| 5 (future) | True event-driven (tmux control mode) | Medium — new mechanism | Phase 1+2 validated at scale |
