# Single WebSocket Per Terminal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **REQUIRED READING before any work:** /srv/PHAT-TOAD-with-Trails/steward/system.md, /srv/PHAT-TOAD-with-Trails/steward/agent-handoff.md, /srv/PHAT-TOAD-with-Trails/steward/advice-for-new-agents/READ-THIS-FIRST.md

**Goal:** Eliminate the dual-WebSocket architecture so each terminal uses one bidirectional WebSocket for both rendering and input/scroll.

**Bugs this fixes:**
1. Scroll doesn't work on proxied (claude-proxy) sessions — scroll message goes to bridge A, terminal renders from bridge B
2. Keystroke ordering under load — input arrives on one connection, display updates on another, batching windows misalign
3. Silent `inputWs` death — no ping/pong, no reconnect, falls back to HTTP which doesn't work for proxied sessions

---

## 1. Constraint Declaration

### Hard Constraints (things that CANNOT change)

| Constraint | Why | What breaks if violated |
|-----------|-----|------------------------|
| SVG `<object>` with `pointer-events: none` | CSS3DRenderer event routing depends on this. All 21 event handlers use coordinate-based hit testing against the renderer container, not DOM event bubbling. | Clicks/drags/scrolls on terminals stop working |
| 4x scale trick (DOM oversized, CSS3DObject scale 0.25) | Chrome rasterizes text at 4x resolution before 3D transform. | Text blurs |
| Font measurement via getBBox() inside the SVG document | Cell dimensions (CELL_W, CELL_H) must come from the SVG's rendering context, not the parent page. HTML and SVG measure the same font differently (verified: 8.858 vs 8.610 per cell). | Text/cursor/selection misaligned |
| `screenLines` must be populated for copy/paste | `getSelectedTextFromSvg()` uses it as primary source, falls back to `contentDocument` text extraction | Copy/paste breaks |
| `updateCardForNewSize()` must be called when dimensions change | Dashboard's 3D layout (camera distance, card positioning) depends on knowing current cols/rows | Cards don't resize, layout breaks |
| HTTP POST `/api/input` fallback | Covers: SVG not loaded yet, WS reconnecting, `<object>` in error state | Keystrokes lost during edge cases |

### Known Anti-Patterns (things tried and failed)

| Approach | Why it failed | Date |
|----------|--------------|------|
| Inline SVG (replace `<object>`) | HTML and SVG measure fonts differently. getBBox() in inline SVG returns different metrics than in isolated `<object>` document. Days of font calibration lost. | 2026-03-30 |
| HTML text overlay on SVG | Same font measurement mismatch. Characters drift ~20px by column 80. | 2026-03-30 |
| `postMessage` for input (parent → SVG) | Works but unnecessary. Direct `contentWindow.sendToWs()` is simpler, synchronous, debuggable. | 2026-03-30 (reviewer recommendation) |

### Test Invariants

- 18 server tests (`node --test test-server.mjs`)
- 16 auth tests (`node --test test-auth.mjs`)
- 23 E2E tests (`node test-dashboard-e2e.mjs`)
- All must pass after changes

### Verified Assumptions (proof-of-concept 2026-03-30)

All tested in Chromium via puppeteer on the live dashboard:

| Assumption | Test | Result |
|-----------|------|--------|
| `obj.contentWindow` exists on SVG `<object>` | `typeof obj.contentWindow` | `"object"` — works |
| Can set function on SVG window and call from parent | `obj.contentDocument.defaultView.testFn = fn; obj.contentWindow.testFn(21)` | Returns `42` — works |
| `parent.postMessage` works from SVG `<object>` | SVG calls `parent.postMessage({type:'test'})`, parent listener receives it | Works |
| Parent can set callback on SVG window | `obj.contentWindow._cb = fn; SVG calls window._cb(data)` | Works |

---

## 2. Current System — How It Works Today

```
TERMINAL CARD
├── <object data="terminal.svg"> (pointer-events: none)
│   └── SVG document (isolated)
│       ├── WebSocket #1 to /ws/terminal?session=X (read-only)
│       │   ├── receives: screen, delta
│       │   └── renders: <text>, <tspan>, <rect> (backgrounds), cursor
│       └── Font measurement: getBBox() → CELL_W=8.61, CELL_H=17
│
└── Dashboard JS
    ├── WebSocket #2 (inputWs) — opened on focus, closed on unfocus
    │   ├── sends: input, scroll, resize
    │   └── receives: screen, delta → populates t.screenLines
    └── Falls back to HTTP POST /api/input when WS #2 unavailable
```

**The problem:** WS #1 and WS #2 are independent connections. For local tmux, server.mjs shares state (`paneScrollOffsets`) across both. For proxied sessions, each is a separate bridge to claude-proxy — no shared state.

## 3. Target System — Single WebSocket

```
TERMINAL CARD
├── <object data="terminal.svg"> (pointer-events: none)
│   └── SVG document (isolated)
│       ├── WebSocket (BIDIRECTIONAL) to /ws/terminal?session=X
│       │   ├── receives: screen, delta → renders SVG
│       │   └── sends: input, scroll, resize (via window.sendToWs)
│       ├── Exposes: window.sendToWs(msg) → ws.send()
│       ├── Exposes: window._wsReady (boolean)
│       ├── Calls: window._screenCallback(msg) after render
│       └── Font measurement: unchanged
│
└── Dashboard JS
    ├── sendInput() → obj.contentWindow.sendToWs(msg)
    │   └── Fallback: HTTP POST /api/input
    ├── obj.contentWindow._screenCallback = function(msg) {
    │     → populates t.screenLines
    │     → calls updateCardForNewSize
    │   }
    └── No inputWs. No second connection.
```

**Data flow for input:**
```
User types 'a' → dashboard keydown handler → t.sendInput({type:'input', keys:'a'})
  → obj.contentWindow.sendToWs({type:'input', keys:'a'})
  → SVG's ws.send(JSON.stringify(...))
  → server.mjs (or proxy bridge) → tmux/claude-proxy
  → terminal output changes
  → server sends delta on SAME WebSocket
  → SVG renders it + calls window._screenCallback(msg)
  → dashboard updates t.screenLines
```

**Data flow for scroll:**
```
User presses PageUp → dashboard handler → t.scrollBy(24)
  → t.sendInput({type:'scroll', offset: N})
  → obj.contentWindow.sendToWs(...)
  → server/proxy → returns scrolled screen on SAME connection
  → SVG renders + notifies dashboard
```

---

## 4. Error Handling at Every Boundary

| Boundary | Error condition | Handling |
|----------|----------------|----------|
| Parent → `contentWindow.sendToWs` | SVG not loaded (`contentWindow` null) | Fall back to HTTP POST `/api/input` |
| Parent → `contentWindow.sendToWs` | WS not connected (`sendToWs` returns false) | Fall back to HTTP POST `/api/input` |
| Parent → `contentWindow.sendToWs` | `sendToWs` not defined (SVG script error) | `typeof` check, fall back to HTTP POST |
| SVG → `window._screenCallback` | Callback not set (parent hasn't registered yet) | Silent no-op (check `typeof` before calling) |
| SVG → `window._screenCallback` | Callback throws | try/catch around the call |
| SVG WebSocket closes | WS drops | `_wsReady = false`, reconnect after 2s (existing behavior). During gap, parent HTTP fallback handles input. |
| `<object>` removed from DOM | Terminal removed/unfocused | `sendInput` queries `this.dom.querySelector('object')` each time — returns null, falls to HTTP |

---

## 5. What Changes for Users

Nothing visible. Same rendering, same interactions, same dashboard. The fix is internal plumbing.

**What improves:**
- Scroll works on proxied (claude-proxy) sessions
- Keystroke ordering is consistent under load
- No more "can't type until I refocus" timeout issue

---

## 6. Rollback Plan

Revert two files: `terminal.svg` and `dashboard.mjs`. The changes are additive in terminal.svg (new exports) and surgical in dashboard.mjs (sendInput routing + remove inputWs). Git revert of the commits restores the dual-WebSocket behavior.

---

## 7. Implementation Tasks

### Task 1: Add exports to terminal.svg

**Files:** `terminal.svg`

**What changes:** Add three things inside the existing IIFE (where `var ws` is in scope):
1. `window._wsReady` flag — set true in `ws.onopen`, false in `ws.onclose`
2. `window.sendToWs(msg)` — sends on `ws` if connected, returns true/false
3. After rendering screen/delta in `ws.onmessage`, call `window._screenCallback(msg)` if set

**What does NOT change:** All rendering code, font measurement, WebSocket connection logic, reconnect logic, poll fallback.

- [ ] **Step 1:** In `ws.onopen` (line 285), add `window._wsReady = true;` after `useWebSocket = true;`

- [ ] **Step 2:** In `ws.onclose` (line 334), add `window._wsReady = false;` after `useWebSocket = false;`

- [ ] **Step 3:** Before the `// Start` section (line 587), add inside the IIFE:

```javascript
      // --- Parent integration (single-WebSocket architecture) ---
      // Expose send function so parent can route input/scroll through this WS
      window.sendToWs = function(msg) {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify(msg));
          return true;
        }
        return false;
      };
```

- [ ] **Step 4:** In `ws.onmessage`, after the screen rendering block (after `hideError();` ~line 311), add:

```javascript
            try { if (window._screenCallback) window._screenCallback(msg); } catch(e) {}
```

- [ ] **Step 5:** In `ws.onmessage`, after the delta rendering block (after cursor update ~line 327), add the same line:

```javascript
            try { if (window._screenCallback) window._screenCallback(msg); } catch(e) {}
```

- [ ] **Step 6:** Restart server, verify rendering still works in puppeteer. Verify `obj.contentWindow.sendToWs` exists and `obj.contentWindow._wsReady === true` after load.

- [ ] **Step 7:** Commit:
```bash
git add terminal.svg
git commit -m "feat: expose sendToWs and _screenCallback on terminal.svg for single-WebSocket input"
```

---

### Task 2: Wire sendInput through contentWindow

**Files:** `dashboard.mjs`

**What changes:** The `sendInput` method on each terminal object. Currently routes through `inputWs` → HTTP fallback. Changes to: `contentWindow.sendToWs` → HTTP fallback.

- [ ] **Step 1:** In `addTerminal()` (~line 1608), replace the `sendInput` method:

FROM:
```javascript
    sendInput: function(msg) {
      if (this.inputWs && this.inputWs.readyState === WebSocket.OPEN) {
        this.inputWs.send(JSON.stringify(msg));
      } else {
        fetch('/api/input', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: sessionName, pane: '0', ...msg })
        }).catch(function() {});
      }
    },
```

TO:
```javascript
    sendInput: function(msg) {
      // Route through SVG's single WebSocket via contentWindow
      var obj = this.dom ? this.dom.querySelector('object') : null;
      if (obj && obj.contentWindow && typeof obj.contentWindow.sendToWs === 'function') {
        if (obj.contentWindow.sendToWs(msg)) return;
      }
      // Fallback: HTTP POST (SVG not loaded, WS disconnected, reconnecting)
      fetch('/api/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionName, pane: '0', ...msg })
      }).catch(function() {});
    },
```

- [ ] **Step 2:** Test in puppeteer: focus a terminal, type characters, verify they appear in the terminal. Verify on both a local tmux session and the claude-proxy session.

- [ ] **Step 3:** Commit:
```bash
git add dashboard.mjs
git commit -m "feat: sendInput routes through SVG's WebSocket via contentWindow.sendToWs"
```

---

### Task 3: Register screen callback for screenLines + resize

**Files:** `dashboard.mjs`

**What changes:** After the `<object>` loads, set `_screenCallback` on its window. This replaces what `inputWs.onmessage` used to do: populate `t.screenLines` and call `updateCardForNewSize`.

- [ ] **Step 1:** In `addTerminal()`, after the terminal object is added to the `terminals` Map (~line 1627, after `fetchTitle`), add:

```javascript
  // Register screen callback on the SVG's <object> once it loads
  var obj = dom.querySelector('object');
  if (obj) {
    obj.addEventListener('load', function() {
      try {
        obj.contentWindow._screenCallback = function(msg) {
          var t = terminals.get(sessionName);
          if (!t) return;
          if (msg.type === 'screen' && msg.lines) {
            t.screenLines = msg.lines.map(function(l) {
              return { text: l.spans.map(function(s) { return s.text; }).join(''), spans: l.spans };
            });
            updateCardForNewSize(t, msg.width || 80, msg.height || 24);
            if (msg.cursor) t._lastCursor = msg.cursor;
          } else if (msg.type === 'delta' && msg.changed) {
            for (var idx in msg.changed) {
              var lineData = msg.changed[idx];
              var spans = lineData.spans || lineData;
              t.screenLines[parseInt(idx)] = { text: spans.map(function(s) { return s.text; }).join(''), spans: spans };
            }
            if (msg.cursor) t._lastCursor = msg.cursor;
          }
        };
      } catch (e) {}
    });
  }
```

- [ ] **Step 2:** Test in puppeteer: focus a terminal, verify `t.screenLines` is populated. Test copy/paste (Ctrl+C with selection). Verify `updateCardForNewSize` fires when terminal dimensions change.

- [ ] **Step 3:** Commit:
```bash
git add dashboard.mjs
git commit -m "feat: register _screenCallback on SVG load for screenLines and resize tracking"
```

---

### Task 4: Remove inputWs

**Files:** `dashboard.mjs`

**What changes:** Remove the second WebSocket opening from `focusTerminal()` and `addToFocus()`. Remove `inputWs.close()` from unfocus/restore code.

- [ ] **Step 1:** In `focusTerminal()` (~line 1711), remove the entire `inputWs` opening block:
```javascript
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  t.inputWs = new WebSocket(...);
  t.inputWs.onmessage = function(e) { ... };
```
Replace with a comment: `// Input routed via contentWindow.sendToWs, screen data via _screenCallback`

- [ ] **Step 2:** In `addToFocus()` (~line 1803), remove the same `inputWs` opening block. Replace with the same comment.

- [ ] **Step 3:** Search for all `inputWs` references:
```bash
grep -n 'inputWs' dashboard.mjs
```
Remove or nullify each one:
- `inputWs: null` in the terminal object → keep (no-op reference)
- `inputWs.close()` in unfocus code → remove
- Any `inputWs.readyState` checks → remove (sendInput no longer checks it)

- [ ] **Step 4:** Run ALL tests:
```bash
node --test test-server.mjs
node --test test-auth.mjs
node test-dashboard-e2e.mjs
```
All must pass.

- [ ] **Step 5:** Manual test matrix in puppeteer:
- [ ] Focus local tmux terminal → type → characters appear
- [ ] Focus claude-proxy terminal → type → characters appear
- [ ] PageUp/PageDown scroll on local terminal
- [ ] PageUp/PageDown scroll on claude-proxy terminal
- [ ] Mouse wheel scroll on focused terminal
- [ ] Ctrl+C with selection → copies text
- [ ] Unfocus → refocus → type still works
- [ ] Multi-focus (Ctrl+click) → switch active → type on each

- [ ] **Step 6:** Commit:
```bash
git add dashboard.mjs
git commit -m "feat: remove inputWs — single WebSocket per terminal"
```

---

## 8. Pre-Implementation Reflection

**What didn't I mention during planning?**
- The `<object>` `load` event may fire before the SVG's WebSocket connects. The `_screenCallback` would be set but `sendToWs` would return false during that gap. HTTP fallback covers input; screenLines stays empty until first screen message arrives.

**What constraint did I consider too obvious to declare?**
- The `<object>` must be same-origin for `contentWindow` access. This is true today (served by the same server.mjs). If the SVG is ever served from a CDN, this breaks.

**What about the current system do I still not fully understand?**
- The exact timing of `<object>` load vs SVG WebSocket connect vs user interaction. The readiness sequence: DOM creates `<object>` → browser fetches terminal.svg → SVG script runs → font measured → WebSocket opened → onopen fires. How long each step takes and whether the user can focus before it completes.
