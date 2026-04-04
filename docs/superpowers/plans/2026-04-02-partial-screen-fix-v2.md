# Partial Screen Fix — Implementation Plan v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Supersedes:** `2026-04-02-partial-screen-fix.md` (v1)
> **Review notes incorporated:** `2026-04-02-partial-screen-fix-NOTES-01a.md`

**Goal:** Fix empty/partial terminal rendering for claude-proxy sessions by fetching initial screen data synchronously during session discovery, and routing all socket-session operations through claude-proxy's API.

**Architecture:** Two changes across two codebases. (1) claude-proxy: add `-e` flag to cache capture for ANSI colors, update `/api/session/:id/screen` to use `getInitialScreen()` with `parseAnsiLine()`. (2) svg-terminal: fetch initial screen from claude-proxy API during discovery (parallel, not sequential), fix `/api/pane` routing for socket sessions.

**Tech Stack:** Node.js (ESM), raw HTTP server, WebSocket (ws module). svg-terminal has test-server.mjs (19 tests) and test-dashboard-e2e.mjs (22+ tests) — run after changes.

**Root cause doc:** `docs/integration/2026-04-02-claude-proxy-partial-screen-fix.md`

---

## File Map

| File | Codebase | Action | Responsibility |
|------|----------|--------|---------------|
| `src/pty-multiplexer.ts` | claude-proxy | Modify | Add `-e` to cache capture-pane for ANSI colors |
| `src/api-server.ts` | claude-proxy | Modify | Screen endpoint uses getInitialScreen() + parseAnsiLine() |
| `server.mjs` | svg-terminal | Modify | Parallel fetch initial screen during discovery; route /api/pane for socket sessions |

---

## Task 1: Add ANSI escape preservation to cache capture

**Files:**
- Modify: `/srv/claude-proxy/src/pty-multiplexer.ts:414-434`

The cache currently uses `capture-pane -p` which strips ANSI escape codes. Add `-e` flag to preserve colors so the screen endpoint can serve styled spans from cache.

- [ ] **Step 1: Add -e flag to capture-pane args in warmCache()**

In `/srv/claude-proxy/src/pty-multiplexer.ts`, find `warmCache()` (line ~414). Change the args:

From:
```typescript
const args = this.socketPath
  ? ['-S', this.socketPath, 'capture-pane', '-p', '-t', this.tmuxId]
  : ['capture-pane', '-p', '-t', this.tmuxId];
```

To:
```typescript
const args = this.socketPath
  ? ['-S', this.socketPath, 'capture-pane', '-p', '-e', '-t', this.tmuxId]
  : ['capture-pane', '-p', '-e', '-t', this.tmuxId];
```

Also update the remote path (line ~422):
From:
```typescript
const stdout = await execFileAsync('ssh', [this.remoteHost, 'tmux', ...args], ...);
```
The args already include the new `-e` flag via the spread, so no change needed for remote.

- [ ] **Step 2: Build and verify cache has ANSI**

Run: `cd /srv/claude-proxy && npm run build && systemctl restart claude-proxy`
Wait 2 seconds, then check logs:
```bash
journalctl -u claude-proxy --no-pager -n 20 | grep '\[warm-cache\]'
```
Expected: Cache sizes should be slightly larger than before (ANSI codes add bytes).

- [ ] **Step 3: Commit**

```bash
cd /srv/claude-proxy && git add src/pty-multiplexer.ts && git commit -m "fix: cache capture-pane uses -e flag to preserve ANSI colors"
```

---

## Task 2: Update claude-proxy screen endpoint to use getInitialScreen() + parseAnsiLine()

**Files:**
- Modify: `/srv/claude-proxy/src/api-server.ts:662-684`

- [ ] **Step 1: Update the screen endpoint**

In `/srv/claude-proxy/src/api-server.ts`, find the screen endpoint (line ~662). Replace the body (lines after the 404 check, before the `res.writeHead`):

From:
```typescript
const buffer = session.pty.getBuffer();
const dims = session.pty.getScreenDimensions();
const title = session.currentTitle || session.name;
const start = parseInt(url.searchParams.get('start') || String(dims.baseY));
const end = parseInt(url.searchParams.get('end') || String(dims.baseY + dims.rows));
const state = bufferToScreenState(buffer, dims.cols, end - start, title);
res.writeHead(200, { 'Content-Type': 'application/json' });
res.end(JSON.stringify(state));
```

To:
```typescript
const dims = session.pty.getScreenDimensions();
const title = composeTitle(session);
const initial = session.pty.getInitialScreen();

let state: any;
if (initial.source === 'cache' && initial.text) {
  // Cache path — ANSI-escaped text from tmux capture-pane -e.
  // Parse with parseAnsiLine() to produce styled spans.
  const textLines = initial.text.split('\n');
  const lines: Array<{ spans: any[] }> = [];
  for (let i = 0; i < dims.rows; i++) {
    const raw = textLines[i] || '';
    lines.push({ spans: raw ? parseAnsiLine(raw) : [] });
  }
  state = {
    width: dims.cols,
    height: dims.rows,
    cursor: { x: 0, y: 0 },
    title,
    lines,
  };
} else {
  // vterm path — respect line range query params
  const buffer = initial.buffer ?? session.pty.getBuffer();
  const start = parseInt(url.searchParams.get('start') || String(dims.baseY));
  const end = parseInt(url.searchParams.get('end') || String(dims.baseY + dims.rows));
  state = bufferToScreenState(buffer, dims.cols, end - start, title);
}

res.writeHead(200, { 'Content-Type': 'application/json' });
res.end(JSON.stringify(state));
```

Note: `parseAnsiLine` already exists in this file at line ~110.

- [ ] **Step 2: Also update the WebSocket initial screen send (line ~742)**

The WebSocket handler already uses `getInitialScreen()` from our earlier work. Update its cache path to also use `parseAnsiLine()`:

Find the cache branch (around line 748):
From:
```typescript
if (initial.source === 'cache' && initial.text) {
  const textLines = initial.text.split('\n');
  const lines: Array<{ spans: Array<{ text: string }> }> = [];
  for (let i = 0; i < dims.rows; i++) {
    const text = textLines[i] || '';
    lines.push({ spans: text ? [{ text }] : [] });
  }
```

To:
```typescript
if (initial.source === 'cache' && initial.text) {
  const textLines = initial.text.split('\n');
  const lines: Array<{ spans: any[] }> = [];
  for (let i = 0; i < dims.rows; i++) {
    const raw = textLines[i] || '';
    lines.push({ spans: raw ? parseAnsiLine(raw) : [] });
  }
```

- [ ] **Step 3: Build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: Build clean, all 250 tests pass.

- [ ] **Step 4: Verify endpoint returns styled spans**

```bash
curl -s http://127.0.0.1:3101/api/session/cp-AARON/screen | jq '.lines[5].spans[0]'
```
Expected: Span with `text` and possibly `fg`, `bold`, etc. — NOT raw `\x1b[` escape sequences in the text.

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/api-server.ts && git commit -m "fix: screen endpoint uses getInitialScreen() + parseAnsiLine() for styled cache spans"
```

---

## Task 3: Parallel fetch initial screen during svg-terminal discovery

**Files:**
- Modify: `/srv/svg-terminal/server.mjs:597-631`

This is the core fix. Restructure `sendSessionDiscovery()` to: (1) process local tmux sessions sequentially (with capturePane, as before), (2) then fetch ALL claude-proxy sessions' initial screens in parallel, (3) then set up bridges.

- [ ] **Step 1: Restructure the discovery loop**

In `/srv/svg-terminal/server.mjs`, replace the `for (const s of sessions)` loop (lines ~597-631) with:

```javascript
  // Phase 1: Send session-add messages for all sessions
  for (const s of sessions) {
    if (knownSessions.has(s.name)) continue;
    knownSessions.add(s.name);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'session-add', session: s.name, pane: '0', ...s }));
    }
  }

  // Phase 2: Fetch initial screens
  // Local tmux: sequential (capturePane is fast, ~5ms each)
  for (const s of sessions) {
    if (s.source !== 'tmux') continue;
    subscribeToSession(ws, s.name, '0');
    try {
      const state = await capturePane(s.name, '0');
      if (ws.readyState === 1) {
        const msg = { type: 'screen', session: s.name, pane: '0',
          width: state.width, height: state.height,
          cursor: state.cursor, title: state.title, lines: state.lines,
          scrollOffset: 0 };
        ws.send(JSON.stringify(msg));
      }
    } catch (err) {
      // Session may have disappeared
    }
  }

  // Claude-proxy: parallel fetch (all at once, ~50-200ms total)
  const cpSessions = sessions.filter(s => s.source === 'claude-proxy');
  if (cpSessions.length > 0) {
    const screenPromises = cpSessions.map(async (s) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        const screenRes = await fetch(
          CLAUDE_PROXY_API + '/api/session/' + encodeURIComponent(s.name) + '/screen',
          { signal: controller.signal }
        );
        clearTimeout(timeout);
        if (screenRes.ok) {
          const state = await screenRes.json();
          if (ws.readyState === 1) {
            const msg = { type: 'screen', session: s.name, pane: '0',
              width: state.width, height: state.height,
              cursor: state.cursor, title: state.title, lines: state.lines,
              scrollOffset: 0 };
            ws.send(JSON.stringify(msg));
          }
        }
      } catch (err) {
        // CP unreachable for this session — bridge will deliver eventually
      }
    });
    await Promise.allSettled(screenPromises);
  }

  // Phase 3: Set up bridges for ongoing delta updates (after initial screens sent)
  for (const s of cpSessions) {
    const watcher = bridgeClaudeProxySession(s.name);
    if (watcher) {
      watcher.subscribers.add(ws);
      if (!wsToWatcherKeys.has(ws)) wsToWatcherKeys.set(ws, new Set());
      wsToWatcherKeys.get(ws).add(s.name + ':0');
    }
  }
```

Key differences from v1 plan:
- **Parallel fetch** via `Promise.allSettled` — all CP screens fetched at once (~200ms total, not 200ms × N)
- **1.5s timeout** instead of 3s — if CP can't respond in 1.5s, bridge delivers eventually
- **Three phases**: session-add messages first (cards created), then screens (cards filled), then bridges (ongoing updates)
- Local tmux sessions still sequential (capturePane is local, ~5ms each)

- [ ] **Step 2: Verify server starts and serves all sessions**

```bash
cd /srv/svg-terminal
# Check current port
grep -n 'port' server.mjs | head -5
# Start test instance
node server.mjs --port 3202 &
sleep 3
curl -s http://127.0.0.1:3202/api/sessions | jq '.[].name' | head -10
kill %1
```

- [ ] **Step 3: Manual test — open browser, verify all terminals have content**

1. Restart svg-terminal with its normal restart script
2. Open browser to the svg-terminal dashboard
3. All terminal cards should render with content immediately — no empty cards
4. Cards at the bottom of the list should render at the same time as cards at the top
5. Check browser console — no `/api/pane` 500 errors for cp-* sessions

- [ ] **Step 4: Run svg-terminal tests**

```bash
cd /srv/svg-terminal
node --test test-server.mjs
node --test test-auth.mjs
node test-dashboard-e2e.mjs
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd /srv/svg-terminal && git add server.mjs && git commit -m "fix: parallel fetch initial screen from claude-proxy during discovery — eliminates empty card race"
```

---

## Task 4: Route /api/pane through claude-proxy for socket sessions

**Files:**
- Modify: `/srv/svg-terminal/server.mjs` (handlePane function, search for `async function handlePane`)

- [ ] **Step 1: Update handlePane to detect and route CP sessions**

Find `async function handlePane(req, res, params)` in `/srv/svg-terminal/server.mjs`. Replace the entire function:

```javascript
async function handlePane(req, res, params) {
  const session = params.get('session');
  const pane = params.get('pane') || '0';
  if (!session) return sendError(res, 400, 'Missing session parameter');
  if (!validateParam(session)) return sendError(res, 400, 'Invalid session name');
  if (!validateParam(pane)) return sendError(res, 400, 'Invalid pane identifier');

  // Check if session is on local tmux (default server)
  let isLocal = false;
  try {
    await tmuxAsync('has-session', '-t', session);
    isLocal = true;
  } catch {}

  if (isLocal) {
    // Local tmux — direct capture
    try {
      const state = await capturePane(session, pane);
      sendJson(res, 200, state);
    } catch (err) {
      sendError(res, 500, 'tmux error: ' + err.message);
    }
  } else {
    // Claude-proxy session (socket-based) — proxy through CP API
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const cpRes = await fetch(
        CLAUDE_PROXY_API + '/api/session/' + encodeURIComponent(session) + '/screen',
        { signal: controller.signal }
      );
      clearTimeout(timeout);
      if (cpRes.ok) {
        const state = await cpRes.json();
        state.path = state.path || '';
        state.command = state.command || '';
        state.pid = state.pid || 0;
        state.historySize = state.historySize || 0;
        state.dead = false;
        sendJson(res, 200, state);
      } else {
        sendError(res, 502, 'claude-proxy returned ' + cpRes.status);
      }
    } catch (err) {
      sendError(res, 502, 'claude-proxy unreachable: ' + err.message);
    }
  }
}
```

- [ ] **Step 2: Test socket and local sessions**

```bash
# Socket session (previously 500)
curl -s 'http://127.0.0.1:3201/api/pane?session=cp-AARON&pane=0' | jq '.width, .height, (.lines | length)'

# Local session (should still work)
curl -s 'http://127.0.0.1:3201/api/pane?session=cp-fix_SVG-Terminal&pane=0' | jq '.width, .height, (.lines | length)'
```
Expected: Both return data. First one no longer returns 500.

- [ ] **Step 3: Commit**

```bash
cd /srv/svg-terminal && git add server.mjs && git commit -m "fix: route /api/pane through claude-proxy API for socket-based sessions — fixes 500 errors"
```

---

## Task 5: Deploy, test, clean up

- [ ] **Step 1: Deploy claude-proxy**

```bash
cd /srv/claude-proxy && npm run build && npx vitest run && systemctl restart claude-proxy
```
Wait 3 seconds, verify warm-cache logs.

- [ ] **Step 2: Deploy svg-terminal**

```bash
cd /srv/svg-terminal && bash restart-server.sh
```

- [ ] **Step 3: Run svg-terminal tests**

```bash
cd /srv/svg-terminal && node --test test-server.mjs && node --test test-auth.mjs
```

- [ ] **Step 4: Browser verification**

1. Open fresh browser to svg-terminal dashboard
2. All cards render with content — no empty cards
3. No `/api/pane` 500 errors in console
4. Restart claude-proxy (`systemctl restart claude-proxy`) — verify terminals recover with full content

- [ ] **Step 5: Remove diagnostic logging from claude-proxy**

Remove these temporary log lines:
- `console.log('[initial-screen]...')` from `src/api-server.ts`
- `console.log('[warm-cache]...')` from `src/pty-multiplexer.ts`

```bash
cd /srv/claude-proxy && npm run build && npx vitest run
git add src/api-server.ts src/pty-multiplexer.ts && git commit -m "chore: remove diagnostic logging from screen cache"
```

- [ ] **Step 6: Push both repos**

```bash
cd /srv/claude-proxy && git push
cd /srv/svg-terminal && git push
```
