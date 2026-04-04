# Partial Screen Fix — Implementation Plan

# REVIEW NOTES by agent 4 (2026-04-02)
# Overall: Good plan, correct root cause, right approach. A few gaps and one concern.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix empty/partial terminal rendering for claude-proxy sessions by fetching initial screen data synchronously during session discovery, and routing all socket-session operations through claude-proxy's API.

**Architecture:** Two changes across two codebases. (1) claude-proxy: update existing `/api/session/:id/screen` endpoint to use `getInitialScreen()` (cache-aware). (2) svg-terminal: fetch initial screen from claude-proxy API during discovery (same pattern as local tmux `capturePane`), eliminating the race where bridge WebSocket hasn't delivered first screen when browser creates the card.

**Tech Stack:** Node.js (ESM), raw HTTP server, WebSocket (ws module). No test framework in svg-terminal — manual verification.

# NOTE: "No test framework" is concerning. We have test-server.mjs (19 tests) and test-dashboard-e2e.mjs (22+ tests). The plan should verify these pass after changes. The statement may be from an agent unfamiliar with our test suite.

**Root cause doc:** `docs/integration/2026-04-02-claude-proxy-partial-screen-fix.md`

---

## File Map

| File | Codebase | Action | Responsibility |
|------|----------|--------|---------------|
| `src/api-server.ts` | claude-proxy | Modify | Update screen endpoint to use getInitialScreen() |
| `server.mjs` | svg-terminal | Modify | Fetch initial screen from CP API during discovery; add socket-aware tmux helper |

# NOTE: File map is accurate. I verified both files and the line numbers referenced.

---

## Task 1: Update claude-proxy screen endpoint to use getInitialScreen()

**Files:**
- Modify: `/srv/claude-proxy/src/api-server.ts:662-684`

# NOTE: Line numbers verified — correct. The existing endpoint is at 662-684.

The existing `GET /api/session/:id/screen` endpoint reads from `getBuffer()` directly. It should use `getInitialScreen()` so it returns cache data when vterm hasn't settled.

- [ ] **Step 1: Update the screen endpoint**

In `/srv/claude-proxy/src/api-server.ts`, find the screen endpoint (line ~662) and replace:

```typescript
// Current code:
const buffer = session.pty.getBuffer();
const dims = session.pty.getScreenDimensions();
const title = session.currentTitle || session.name;
const start = parseInt(url.searchParams.get('start') || String(dims.baseY));
const end = parseInt(url.searchParams.get('end') || String(dims.baseY + dims.rows));
const state = bufferToScreenState(buffer, dims.cols, end - start, title);
```

with:

```typescript
const dims = session.pty.getScreenDimensions();
const title = composeTitle(session);
const initial = session.pty.getInitialScreen();

let state: any;
if (initial.source === 'cache' && initial.text) {
  // Cache path — plain text from tmux capture-pane.
  // Parse with ANSI support to preserve colors.
  const textLines = initial.text.split('\n');
  const lines: Array<{ spans: Array<{ text: string }> }> = [];
  for (let i = 0; i < dims.rows; i++) {
    const text = textLines[i] || '';
    lines.push({ spans: text ? [{ text }] : [] });
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

# CONCERN: The cache path sends plain text spans `{ text: "line content" }` with NO color information. The cache comes from `tmux capture-pane -e` which DOES include ANSI escape codes. But this code does `initial.text.split('\n')` and wraps raw text into spans WITHOUT parsing the ANSI codes. Colors will be lost on cache-path responses, and ANSI escape sequences will appear as literal text in the terminal.
#
# The comment says "Parse with ANSI support to preserve colors" but the code does NOT parse ANSI. Either:
# 1. Use `parseAnsiLine()` (already exists in api-server.ts from the scroll fix, line ~105) to parse each line
# 2. Or strip ANSI codes at minimum so raw escape sequences don't display as garbage
#
# Suggested fix for the cache path:
# ```typescript
# const textLines = initial.text.split('\n');
# const lines = [];
# for (let i = 0; i < dims.rows; i++) {
#   const raw = textLines[i] || '';
#   lines.push({ spans: raw ? parseAnsiLine(raw) : [] });
# }
# ```
# This uses the existing parseAnsiLine function and preserves colors.

# MINOR: `composeTitle(session)` vs `session.currentTitle || session.name`. composeTitle adds user list and uptime. Make sure this is the intended title format for the HTTP endpoint (it differs from what the existing code returns). For initial screen display it should be fine.

- [ ] **Step 2: Build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: Build clean, all tests pass.

- [ ] **Step 3: Verify endpoint returns data**

Run: `curl -s http://127.0.0.1:3101/api/session/cp-AARON/screen | jq '.width, .height, (.lines | length)'`
Expected: Returns width, height, and correct number of lines.

# NOTE: Also verify that lines contain actual styled spans (not raw ANSI escape text). Add:
# curl -s http://127.0.0.1:3101/api/session/cp-AARON/screen | jq '.lines[0].spans[0]'
# Should show { "text": "...", "fg": "#...", ... } not { "text": "\x1b[32m..." }

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add src/api-server.ts && git commit -m "fix: screen endpoint uses getInitialScreen() — serves cache when vterm unsettled"
```

---

## Task 2: Fetch initial screen from claude-proxy API during svg-terminal discovery

**Files:**
- Modify: `/srv/svg-terminal/server.mjs:622-630`

# NOTE: Line numbers verified — correct. The claude-proxy branch is at 622-630.

This is the core fix. In `sendSessionDiscovery()`, the `claude-proxy` branch calls `bridgeClaudeProxySession()` without awaiting initial screen data. Add an HTTP fetch of the screen endpoint before setting up the bridge.

- [ ] **Step 1: Update the claude-proxy branch in sendSessionDiscovery()**

In `/srv/svg-terminal/server.mjs`, find the `else if (s.source === 'claude-proxy')` block inside `sendSessionDiscovery()` (around line 622). Replace:

```javascript
    } else if (s.source === 'claude-proxy') {
      const watcher = bridgeClaudeProxySession(s.name);
      if (watcher) {
        watcher.subscribers.add(ws);
        // Track reverse mapping for cleanup on disconnect
        if (!wsToWatcherKeys.has(ws)) wsToWatcherKeys.set(ws, new Set());
        wsToWatcherKeys.get(ws).add(s.name + ':0');
      }
    }
```

with:

```javascript
    } else if (s.source === 'claude-proxy') {
      // Fetch initial screen from claude-proxy HTTP API (like capturePane for local sessions).
      // This ensures the browser has complete screen data before the card renders.
      // The bridge WebSocket handles ongoing delta updates after this.
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
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
        // claude-proxy screen fetch failed — bridge will deliver screen eventually
      }

      // Set up bridge for ongoing delta updates
      const watcher = bridgeClaudeProxySession(s.name);
      if (watcher) {
        watcher.subscribers.add(ws);
        if (!wsToWatcherKeys.has(ws)) wsToWatcherKeys.set(ws, new Set());
        wsToWatcherKeys.get(ws).add(s.name + ':0');
      }
    }
```

# GOOD: This is the right approach. Fetch synchronously during discovery, then set up the bridge for ongoing updates. Mirrors the local tmux pattern exactly.
#
# CONCERN: The `await fetch()` blocks discovery for ALL remaining sessions while waiting for one CP session's screen. If claude-proxy is slow (3s timeout), all sessions after this one in the list wait. With 10 CP sessions, worst case = 30 seconds.
#
# Consider: Fire all CP screen fetches in parallel (Promise.allSettled) instead of sequentially in the for loop. Or at minimum, reduce timeout to 1 second — if CP can't respond in 1s, the bridge will deliver eventually.
#
# MINOR: The `CLAUDE_PROXY_API` constant — verified it exists in server.mjs (line ~252, set to 'http://127.0.0.1:3101'). Good.

- [ ] **Step 2: Verify server starts**

Run: `cd /srv/svg-terminal && node server.mjs --port 3200 &`
Wait 3 seconds, then: `curl -s http://127.0.0.1:3200/api/sessions | jq '.[].name'`
Expected: Lists all sessions (both local tmux and claude-proxy).
Kill the test server.

# NOTE: Server is currently on port 3201 per sessions.md (moved during connection cycling crash). Verify which port before testing.

- [ ] **Step 3: Manual test — open browser, verify all terminals have content**

1. Restart svg-terminal: `bash /srv/svg-terminal/restart-server.sh` (or however it's launched)
2. Open browser to the svg-terminal dashboard
3. All terminal cards — including claude-proxy sessions (socket-based) — should render with content immediately
4. No empty cards that only fill in after a delay

- [ ] **Step 4: Commit**

```bash
cd /srv/svg-terminal && git add server.mjs && git commit -m "fix: fetch initial screen from claude-proxy API during discovery — eliminates empty card race"
```

---

## Task 3: Handle span format difference between claude-proxy and local tmux

**Files:**
- Modify: `/srv/svg-terminal/server.mjs` (in the new fetch block from Task 2)

claude-proxy's `/api/session/:id/screen` returns spans in claude-proxy format: `{ text, fg: '#hex', bg: '#hex', bold, ... }`. svg-terminal's local `capturePane()` returns spans in sgr-parser format: `{ text, cls: 'c-fg-1', fg: null, ... }`. The terminal renderer (`terminal-renderer.mjs`) may handle both, but we need to verify and normalize if needed.

# NOTE: terminal-renderer.mjs is DEAD CODE from the abandoned inline SVG experiment. The actual renderer is terminal.svg's built-in updateLine() function. It reads: span.text, span.cls, span.fg, span.bold, span.italic, span.dim, span.underline, span.strikethrough. It handles BOTH cls-based and hex-based colors (checks cls first, then fg). The formats are already compatible — this task may be a no-op.
#
# However: the sgr-parser.mjs output includes `cls` and `bgCls` for the standard 16 ANSI colors (e.g., cls: 'c2' for green). claude-proxy's screen-renderer.ts outputs hex for everything (#00cd00 for green). The SVG renderer handles both. So no normalization needed.
#
# Recommendation: Verify in step 1, document in step 2, skip step 3 code changes if confirmed compatible. Don't write dead normalization code.

- [ ] **Step 1: Check what format the terminal renderer expects**

Read `/srv/svg-terminal/terminal-renderer.mjs` to understand what span properties it reads. Look for how it handles `fg`, `bg`, `cls`, `bold`, etc.

# WRONG FILE — terminal-renderer.mjs is dead code. Read terminal.svg lines 161-186 (updateLine function) instead.

- [ ] **Step 2: If normalization is needed, add it to the fetch block**

If the renderer expects sgr-parser format (with `cls` property), add a conversion in the fetch block from Task 2:

```javascript
// After: const state = await screenRes.json();
// Normalize claude-proxy spans to local format if needed
if (state.lines) {
  for (const line of state.lines) {
    if (line.spans) {
      for (const span of line.spans) {
        // claude-proxy sends hex colors; terminal.svg expects cls or inline fg/bg
        // The SVG renderer handles both — it checks span.cls first, then span.fg
        // No conversion needed if renderer supports hex fg/bg directly.
      }
    }
  }
}
```

If the renderer already handles both formats, this step is a no-op (just verify and document).

# AGREE this is likely a no-op. The plan even acknowledges it. Consider merging this into Task 2's verification step rather than a separate task.

- [ ] **Step 3: Manual test — compare a local tmux terminal with a CP terminal**

Open both a local tmux session and a claude-proxy session in the dashboard. Verify:
- Colors render correctly on both
- Bold/dim/italic attributes work on both
- Cursor position is correct on both

- [ ] **Step 4: Commit (if changes were needed)**

```bash
cd /srv/svg-terminal && git add server.mjs && git commit -m "fix: normalize claude-proxy span format for terminal renderer"
```

---

## Task 4: Route /api/pane through claude-proxy for socket sessions

**Files:**
- Modify: `/srv/svg-terminal/server.mjs:203-215` (handlePane function)

# NOTE: Line numbers need verification — server.mjs has been heavily modified since the PRD. The handlePane function may have moved. Search for `function handlePane` or `async function handlePane`.

The current `handlePane()` calls `capturePane()` which uses bare `tmux` — can't reach socket-based sessions. For claude-proxy sessions, route through the HTTP screen endpoint instead.

- [ ] **Step 1: Update handlePane to detect and route CP sessions**

In `/srv/svg-terminal/server.mjs`, replace `handlePane()`:

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
        // Add fields that capturePane returns but the CP endpoint doesn't
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

# GOOD: This fixes the 500 errors on /api/pane for cp-* sessions — a known issue documented in startup-errors-journal v0.1.
#
# CONCERN: `tmux has-session` is a synchronous-ish check (execFileSync under tmuxAsync). It runs on EVERY /api/pane request. For a session that doesn't exist locally, it waits for tmux to respond "no such session" before falling through to the CP path. This adds ~5-10ms latency per request.
#
# Alternative: Check the `cpSessions` set (or the session source from the last discovery) instead of calling tmux. But the current approach is more reliable — the session source can change between discoveries.
#
# MINOR: `tmuxAsync('has-session', '-t', session)` may match partial names. tmux uses prefix matching by default. If you have sessions "foo" and "foobar", `has-session -t foo` matches both. Use exact match: `has-session -t '=session'` (the '=' prefix forces exact match in tmux). Actually, for our use case this is fine — cp-* names are unique.

- [ ] **Step 2: Test — verify /api/pane works for socket sessions**

Run: `curl -s 'http://127.0.0.1:3200/api/pane?session=cp-AARON&pane=0' | jq '.width, .height, (.lines | length)'`
Expected: Returns data (previously returned 500).

Run: `curl -s 'http://127.0.0.1:3200/api/pane?session=cp-fix_SVG-Terminal&pane=0' | jq '.width, .height, (.lines | length)'`
Expected: Also returns data (local tmux session, should still work as before).

- [ ] **Step 3: Commit**

```bash
cd /srv/svg-terminal && git add server.mjs && git commit -m "fix: route /api/pane through claude-proxy API for socket-based sessions"
```

---

## Task 5: Deploy and verify

- [ ] **Step 1: Deploy claude-proxy changes**

```bash
cd /srv/claude-proxy && npm run build && systemctl restart claude-proxy
```

Wait 3 seconds, verify: `journalctl -u claude-proxy --no-pager -n 5 | grep 'listening'`

- [ ] **Step 2: Deploy svg-terminal changes**

```bash
cd /srv/svg-terminal && bash restart-server.sh
```

Or however svg-terminal is restarted.

# NOTE: Check which port the server should be on. sessions.md says port 3201 (moved during crash). May need to move back to 3200.

- [ ] **Step 3: Open fresh browser — verify all terminals render**

1. Open a new browser window to the svg-terminal dashboard
2. All terminal cards should have content — no empty cards
3. Cards lower in the thumbnail list should render at the same time as cards higher up
4. No `/api/pane` 500 errors in browser console
5. No `/api/layout` 404 errors (those are a separate issue — layout persistence)

- [ ] **Step 4: Restart claude-proxy while browser is open — verify recovery**

1. Run `systemctl restart claude-proxy`
2. svg-terminal should reconnect (SSE reconnect + dashboard WS reconnect)
3. After reconnect, all terminals should re-render with full content
4. Check server logs: `journalctl -u claude-proxy --no-pager -n 20 | grep '\[initial-screen\]'`
5. All sessions should show `source=vterm` or `source=cache` — no `source=vterm-partial`

- [ ] **Step 5: Remove diagnostic logging from claude-proxy**

Remove the `console.log('[initial-screen]...')` line from `src/api-server.ts` and the `console.log('[warm-cache]...')` line from `src/pty-multiplexer.ts`. Keep `[vterm-settle]` logging as it's useful for ongoing monitoring.

Actually — keep all diagnostic logging behind a debug flag or remove entirely. These are temporary:
- `[initial-screen]` in api-server.ts
- `[warm-cache]` in pty-multiplexer.ts

```bash
cd /srv/claude-proxy && npm run build && git add src/api-server.ts src/pty-multiplexer.ts && git commit -m "chore: remove diagnostic logging from screen cache"
```

- [ ] **Step 6: Final commit and push**

```bash
cd /srv/claude-proxy && git push
cd /srv/svg-terminal && git push
```

# NOTE: Run test suites before pushing:
# cd /srv/svg-terminal && node --test test-server.mjs && node --test test-auth.mjs && node test-dashboard-e2e.mjs
# cd /srv/claude-proxy && npx vitest run

---

# SUMMARY OF REVIEW NOTES

## Critical (must fix before implementing):
1. **Task 1 cache path drops ANSI colors** — `initial.text.split('\n')` wraps raw ANSI text into spans without parsing. Use `parseAnsiLine()` (already exists in api-server.ts) to preserve colors.

## Important (should fix):
2. **Task 2 sequential fetch blocks discovery** — await in a for loop means each CP session fetch blocks the next. Consider parallel fetch or 1s timeout instead of 3s.
3. **Task 3 references dead code** — terminal-renderer.mjs is abandoned. The actual renderer is terminal.svg's updateLine(). Formats are likely compatible (both handle hex fg/bg), but verify against the correct file.
4. **Missing test verification** — Plan says "no test framework" but we have 57+ tests. Run them.

## Minor:
5. Port number (3200 vs 3201) needs verification before deployment.
6. Task 5 Step 6 pushes without running tests — add test step.
7. `composeTitle` vs `session.currentTitle` — minor format difference, document the choice.
