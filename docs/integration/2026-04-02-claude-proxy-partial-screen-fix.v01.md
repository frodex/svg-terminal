# Claude-Proxy Integration: Partial Screen Fix — stepped v01

**Date:** 2026-04-02 (original) · **Stepped:** 2026-04-03  
**Preceding (frozen baseline):** `2026-04-02-claude-proxy-partial-screen-fix.md` — do not edit in place  
**Changes from baseline:** §0 unified-project documentation policy; living index; auth/API follow-up; screen endpoint path correction  

---

## 0. Unified project documentation

**Cross-repo planning and specs** (claude-proxy ↔ svg-terminal: integration, OAuth/API auth parity, PRD alignment) are **canonical under `/srv/svg-terminal`**, primarily in:

- **`/srv/svg-terminal/docs/integration/`** — integration notes, stepped files, handoff narratives  
- **`/srv/svg-terminal/docs/`** — PRD amendments that span both products  

**Process:** All **new** unified or stepped work related to this integration should be **created and versioned here** (`cp` → `.v01`, `.v02`, … per team convention). The claude-proxy repo keeps **service-specific** specs and `sessions.md`, and **points** here for the shared storyline.

### Living documentation index

| Topic | Location |
|-------|----------|
| **OAuth + HTTP/WebSocket auth wiring (clande-proxy server)** | `/srv/claude-proxy/docs/superpowers/specs/2026-04-03-oauth-web-api-wiring-spec.md` |
| **Launch profiles / orchestration vs API (research)** | `/srv/claude-proxy/docs/research/add-terminal.v03.md` |
| **WebSocket bridge (svg-terminal ↔ CP)** | `docs/superpowers/specs/2026-03-30-claude-proxy-websocket-integration-design.md` — **update when CP requires cookies on `/api/session/:id/stream`** |
| **User identity + typing indicators (browser → CP)** | `docs/PRD-amendment-005.md` |
| **claude-proxy session context** | `/srv/claude-proxy/sessions.md` |

### When claude-proxy enables `api.auth.required`

Today’s **unauthenticated** `fetch` to `http://127.0.0.1:3101/api/session/.../screen` and the **WS bridge** assume an open local API. After OAuth wiring lands, svg-terminal must attach **session cookie**, **trusted server-to-server credentials**, or a **reverse-proxy** contract — see the OAuth wiring spec. Update **this index** and the WebSocket integration spec in a **new stepped file** when that behavior is defined.

### Endpoint path (correction)

Initial screen HTTP API uses:

`GET /api/session/:id/screen`  

(not `/api/sessions/:id/screen`). Sample snippets in §Recommended Fix below should use that path when implemented.

---

## 1. Problem

Terminals backed by claude-proxy sessions (socket-based, `cp-*` on custom `-S *.sock`) render with partial or empty screen content in svg-terminal. Terminals lower in the thumbnail list are worse. Resize fixes it. The issue is permanent until forced redraw because delta updates build on the incomplete initial state.

Thumbnails are a separate issue — they're throttled and eventually catch up. Full terminal views never recover without resize.

## 2. Root Cause (svg-terminal side)

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

## 3. What Was Fixed in claude-proxy

Three changes on the `dev` branch:

1. **EventEmitter refactor** — SessionManager emits `client-session-change`, `client-detach`, `session-end`. Fixed a bug where fork (Ctrl+B f) routed input to the wrong session.

2. **Async screen cache (Option E)** — PtyMultiplexer warms a screen cache via async `capture-pane` on startup. `getInitialScreen()` returns: settled vterm (best) > cache (complete snapshot) > partial vterm (fallback). Zero event loop blocking, scales to 30 browsers × 60 sessions.

3. **Cache retention** — Cache persists as fallback instead of being invalidated on settle. Active sessions that cycle settle/unsettle keep their cache available.

### New endpoint available for svg-terminal

claude-proxy exposes the best available screen state via HTTP, e.g.:

```
GET /api/session/:id/screen → { source, width, height, cursor, title, lines }
```

This lets svg-terminal fetch initial screen for CP sessions the same way it fetches for local sessions — HTTP request during discovery, reduced timing dependency.

## 4. Recommended Fix for svg-terminal

### Primary: Fetch initial screen from claude-proxy API during discovery

Add to `sendSessionDiscovery()`:

```javascript
} else if (s.source === 'claude-proxy') {
  try {
    const screenRes = await fetch(CLAUDE_PROXY_API + '/api/session/' + encodeURIComponent(s.name) + '/screen');
    if (screenRes.ok) {
      const state = await screenRes.json();
      ws.send(JSON.stringify({ type: 'screen', session: s.name, pane: '0', ...state }));
    }
  } catch {}
  const watcher = bridgeClaudeProxySession(s.name);
  if (watcher) watcher.subscribers.add(ws);
}
```

**Note:** When claude-proxy requires auth, this `fetch` must include credentials (see §0).

### Secondary: Route socket-session tmux operations through claude-proxy

For `/api/pane`, scrollback, resize on socket sessions — don't call bare `tmux`. Either:
1. Add socket path awareness to `tmuxAsync()` (query metadata for socket path)
2. Route all CP session operations through claude-proxy's API (preferred — svg-terminal shouldn't need to know about tmux socket internals)

## 5. File References

| File | What |
|------|------|
| `svg-terminal/server.mjs:551` | `sendSessionDiscovery()` — the race condition |
| `svg-terminal/server.mjs:493` | `bridgeClaudeProxySession()` — non-awaited bridge setup |
| `svg-terminal/server.mjs:20` | `tmuxAsync()` — bare tmux, no socket support |
| `svg-terminal/server.mjs:130` | `capturePane()` — also bare tmux |
| `claude-proxy/src/pty-multiplexer.ts:414` | `warmCache()` — async screen cache |
| `claude-proxy/src/pty-multiplexer.ts:436` | `getInitialScreen()` — best-available screen |
| `claude-proxy/src/api-server.ts` | HTTP screen endpoint + WebSocket stream |

---

**Full journal (claude-proxy):** `/srv/claude-proxy/docs/research/2026-04-02-v0.6-partial-screen-on-startup-journal.md`

*Next stepped version: `cp` this file → `2026-04-02-claude-proxy-partial-screen-fix.v02.md`.*
