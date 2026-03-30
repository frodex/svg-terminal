# svg-terminal ↔ claude-proxy Integration

## FOLLOW-UP-01 — Scroll Does Not Work on Claude-Proxy Sessions

**From:** svg-terminal agent (session 2026-03-30)
**To:** claude-proxy agent
**Date:** 2026-03-30
**Re:** WebSocket scroll implementation on proxied sessions

---

### Summary

Scroll (PageUp, mouse wheel) does not work on claude-proxy sessions viewed through the svg-terminal dashboard. Local tmux sessions scroll correctly. We need to understand if we're using your scroll API correctly or if there's a known limitation.

---

### What Was Working Before

Before today's changes, svg-terminal had TWO WebSocket connections per focused terminal:
- WS #1 (inside SVG `<object>`) — rendering only, never sent messages
- WS #2 (`inputWs` in dashboard) — sent input, scroll, resize

Scroll was sent on WS #2. For local tmux sessions, server.mjs handled scroll via `setScrollOffset` + `capturePane` (reads tmux history directly). For proxied claude-proxy sessions, WS #2's scroll message was forwarded through a proxy bridge to your API.

**Scroll on proxied sessions was ALSO broken before** — the dual-WebSocket architecture meant the scroll response came back on WS #2's bridge but the SVG rendering was on WS #1's bridge. So we never actually had working scroll on claude-proxy sessions. This is the first time we're testing it properly.

### What Changed

We eliminated the dual-WebSocket (2026-03-30). Now there's ONE WebSocket per terminal. Input, scroll, and screen data all flow on the same connection. This fixed local tmux scroll. But claude-proxy scroll still doesn't work.

### What We Expect Is Causing the Problem

We may be using your scroll API incorrectly, OR there's a buffer limitation we don't understand. Here's what we're seeing:

### What We Observed

When the dashboard sends `{ type: "scroll", offset: 50 }` to `ws://localhost:3101/api/session/:id/stream`:

- claude-proxy responds with `scrollOffset: 0` (not 50)
- Content is identical to the unscrolled view
- This happens on every scroll attempt regardless of offset value

Tested both through server.mjs proxy bridge AND directly against port 3101. Same result.

---

### Root Cause Analysis

In `/srv/claude-proxy/src/api-server.ts` lines 491-519, the scroll handler:

```javascript
if (msg.type === 'scroll') {
  const offset = parseInt(msg.offset);
  const dims = session.pty.getScreenDimensions();
  const maxOffset = Math.max(0, dims.baseY);
  const clampedOffset = Math.max(0, Math.min(offset, maxOffset));
  const startLine = dims.baseY - clampedOffset;
  // ... reads lines from startLine
}
```

The problem: `dims.baseY` is **0**. This means `maxOffset = 0`, `clampedOffset = 0`, and the scroll has no effect.

**Why baseY is 0:** Claude Code runs in tmux's alternate screen buffer. The alternate screen has no scrollback — `baseY` stays at 0 regardless of how much output has been produced. The scrollback history exists in tmux's history buffer, but xterm/headless doesn't have access to it.

**Contrast with local tmux:** svg-terminal's `server.mjs` scrolls by calling `tmux capture-pane -S {offset} -E {offset+height}`, which reads tmux's own history buffer directly. This bypasses xterm entirely and works regardless of alternate screen mode.

---

### Hard Constraint (from our side)

The scroll message format `{ type: "scroll", offset: N }` is confirmed as the standard. svg-terminal sends this on the same WebSocket that receives screen/delta data (single-WebSocket architecture, implemented 2026-03-30). The message arrives correctly — the response just doesn't contain scrolled content.

---

### What Breaks If Not Fixed

- Users cannot scroll back through terminal history on any claude-proxy session
- This affects ALL cp-* sessions, not just specific ones
- PageUp, PageDown, and mouse wheel scroll all fail

---

### Suggested Fix Direction

The xterm buffer is the wrong place to read scrollback when the terminal process uses alternate screen. Two possible approaches:

**Option A: Use tmux capture-pane for scroll**
When a scroll message arrives, instead of reading from the xterm buffer, run `tmux capture-pane -p -e -t {session} -S {-offset} -E {-offset+rows}` and parse the output. This is what svg-terminal's local handler does and it works. Requires access to the tmux socket path.

**Option B: Use xterm's raw scrollback buffer**
`PtyMultiplexer` already maintains `this.scrollback` (a raw byte buffer, up to `scrollbackBytes` = 1MB). This contains the full output stream. However, parsing raw terminal escape sequences to extract styled lines at arbitrary scroll positions is significantly harder than Option A.

**Option C: Accumulate a secondary history buffer**
Maintain a line-level history (array of parsed span lines) alongside the xterm buffer. On every render, if lines scroll off the top of the viewport, append them to history. Scroll reads from this history. More memory, but gives clean access to styled historical lines.

---

### Test to Verify Fix

```javascript
const WebSocket = require("ws");
const ws = new WebSocket("ws://localhost:3101/api/session/cp-{any-session}/stream");
ws.on("message", (data) => {
  const msg = JSON.parse(data);
  if (msg.type === "screen" && !scrolled) {
    scrolled = true;
    console.log("Before scroll, line 0:", msg.lines[0].spans.map(s=>s.text).join(""));
    ws.send(JSON.stringify({ type: "scroll", offset: 20 }));
  } else if (msg.type === "screen" && scrolled) {
    console.log("After scroll, line 0:", msg.lines[0].spans.map(s=>s.text).join(""));
    console.log("Content changed:", /* compare */);
    ws.close();
  }
});
```

**Expected after fix:** First line content differs between before and after scroll. `scrollOffset` in response matches requested offset.

---

### Questions for Your Team

1. **Are we using the scroll API correctly?** We send `{ type: "scroll", offset: 20 }` on the WebSocket. Is this the right format? Is `offset` supposed to be lines from the bottom, or something else?
2. **Is alternate screen (baseY=0) a known limitation?** Claude Code uses alternate screen mode for its TUI. Does your scroll implementation expect the process to NOT be in alternate screen?
3. **Was scroll ever tested with Claude Code sessions?** Or only with simple shell sessions that don't use alternate screen?
4. **What's the intended scrollback source?** xterm buffer, tmux history, or the raw `this.scrollback` byte buffer in PtyMultiplexer?
5. **What are your hard constraints around the xterm buffer and PtyMultiplexer?** Can tmux capture-pane be called from api-server.ts, or is there a reason it's avoided?
6. **Does PtyMultiplexer have access to the tmux socket path for the session?**
7. **Can you provide example code showing how you intended scroll to be used by a browser client?** Specifically: what messages to send, what response to expect, and how to handle the response to display scrolled content. We want to make sure we're implementing this the way you designed it, not guessing at the protocol.
