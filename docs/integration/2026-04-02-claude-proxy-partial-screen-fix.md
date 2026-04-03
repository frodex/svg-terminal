# Claude-Proxy Integration: Partial Screen Fix

**Date:** 2026-04-02
**From:** claude-proxy implementing agent
**For:** svg-terminal PRD / next agent
**Full journal:** `/srv/claude-proxy/docs/research/2026-04-02-v0.6-partial-screen-on-startup-journal.md`

---

## Problem

Terminals backed by claude-proxy sessions (socket-based, `cp-*` on custom `-S *.sock`) render with partial or empty screen content in svg-terminal. Terminals lower in the thumbnail list are worse. Resize fixes it. The issue is permanent until forced redraw because delta updates build on the incomplete initial state.

Thumbnails are a separate issue — they're throttled and eventually catch up. Full terminal views never recover without resize.

## Root Cause (svg-terminal side)

In `server.mjs:551`, `sendSessionDiscovery()` handles two session types differently:

**Local tmux sessions:** `await capturePane()` → immediate screen data sent to browser. **Works correctly.**

**Claude-proxy sessions:** `bridgeClaudeProxySession()` → **NOT awaited**. Creates a WebSocket bridge to claude-proxy asynchronously. The initial `screen` message arrives later (50-200ms after bridge connects). Browser creates the card immediately on `session-add` but has no content until the bridge delivers the first screen.

```
Local session:  session-add → await capturePane → screen data → card rendered (complete)
CP session:     session-add → bridgeClaudeProxy (async) → card rendered (EMPTY) → screen arrives later
```

Cards lower in the list get bridges created later → screen data arrives later → more likely to be empty when first rendered.

### Secondary issue: /api/pane 500 errors

`tmuxAsync()` in `server.mjs:20` calls bare `tmux` (default server). Socket-based sessions use `-S /var/run/claude-proxy/sessions/<name>.sock`. Default tmux can't see them → 500 error on every `/api/pane` request for CP sessions.

## What Was Fixed in claude-proxy

Three changes on the `dev` branch:

1. **EventEmitter refactor** — SessionManager emits `client-session-change`, `client-detach`, `session-end`. Fixed a bug where fork (Ctrl+B f) routed input to the wrong session.

2. **Async screen cache (Option E)** — PtyMultiplexer warms a screen cache via async `capture-pane` on startup. `getInitialScreen()` returns: settled vterm (best) > cache (complete snapshot) > partial vterm (fallback). Zero event loop blocking, scales to 30 browsers × 60 sessions.

3. **Cache retention** — Cache persists as fallback instead of being invalidated on settle. Active sessions that cycle settle/unsettle keep their cache available.

### New endpoint available for svg-terminal

claude-proxy now has `getInitialScreen()` on PtyMultiplexer that returns the best available screen state. A new HTTP endpoint can expose this:

```
GET /api/sessions/:id/screen → { source, width, height, cursor, title, lines }
```

This would let svg-terminal fetch initial screen for CP sessions the same way it fetches for local sessions — HTTP request during discovery, no timing dependency.

## Recommended Fix for svg-terminal

### Primary: Fetch initial screen from claude-proxy API during discovery

Add to `sendSessionDiscovery()`:

```javascript
} else if (s.source === 'claude-proxy') {
  // Fetch initial screen via HTTP (like capturePane for local sessions)
  try {
    const screenRes = await fetch(CLAUDE_PROXY_API + '/api/sessions/' + s.name + '/screen');
    if (screenRes.ok) {
      const state = await screenRes.json();
      ws.send(JSON.stringify({ type: 'screen', session: s.name, pane: '0', ...state }));
    }
  } catch {}
  // Then set up bridge for ongoing deltas
  const watcher = bridgeClaudeProxySession(s.name);
  if (watcher) watcher.subscribers.add(ws);
}
```

This treats CP sessions identically to local sessions: synchronous HTTP fetch for initial screen, WebSocket bridge for ongoing deltas. No race condition.

**Requires:** New `GET /api/sessions/:id/screen` endpoint in claude-proxy (~10 lines).

### Secondary: Route socket-session tmux operations through claude-proxy

For `/api/pane`, scrollback, resize on socket sessions — don't call bare `tmux`. Either:
1. Add socket path awareness to `tmuxAsync()` (query metadata for socket path)
2. Route all CP session operations through claude-proxy's API (preferred — svg-terminal shouldn't need to know about tmux socket internals)

## File References

| File | What |
|------|------|
| `svg-terminal/server.mjs:551` | `sendSessionDiscovery()` — the race condition |
| `svg-terminal/server.mjs:493` | `bridgeClaudeProxySession()` — non-awaited bridge setup |
| `svg-terminal/server.mjs:20` | `tmuxAsync()` — bare tmux, no socket support |
| `svg-terminal/server.mjs:130` | `capturePane()` — also bare tmux |
| `claude-proxy/src/pty-multiplexer.ts:414` | `warmCache()` — async screen cache |
| `claude-proxy/src/pty-multiplexer.ts:436` | `getInitialScreen()` — best-available screen |
| `claude-proxy/src/api-server.ts:742` | WebSocket initial screen send (uses getInitialScreen) |
