# Claude-Proxy WebSocket Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get claude-proxy sessions rendering and interactive in the svg-terminal dashboard by normalizing the WebSocket protocol and adding a proxy bridge in server.mjs.

**Architecture:** server.mjs is the single WebSocket endpoint. For claude-proxy sessions, it bridges to `ws://localhost:3101/api/session/:id/stream`. For local tmux sessions, it uses the existing handler with format translation. Dashboard and terminal.svg speak one protocol — the claude-proxy format.

**Tech Stack:** Node.js, WebSocket (ws package), existing server.mjs/dashboard.mjs/terminal.svg

**Spec:** `docs/superpowers/specs/2026-03-30-claude-proxy-websocket-integration-design.md`

---

## File Map

| File | Change | Responsibility |
|------|--------|---------------|
| `server.mjs` | Modify | Normalize delta format in `diffState()`, translate input key names and scroll format in `handleTerminalWs()` |
| `dashboard.mjs` | Modify | Update `SPECIAL_KEY_MAP` to claude-proxy key names, update delta handlers to expect `{ spans }` wrapper, update scroll format, update ctrl combo format |
| `terminal.svg` | Modify | Update delta handler to expect `{ spans }` wrapper |
| `test-server.mjs` | Modify | Update WebSocket test to expect new delta format |

Note: The WebSocket proxy bridge and session discovery merge in server.mjs are **already implemented** (uncommitted changes from a previous agent). This plan covers only the protocol normalization that's still missing.

---

### Task 1: Normalize delta format in server.mjs

The legacy `diffState()` sends `changed[i] = spans` (raw array). Claude-proxy sends `changed[i] = { spans }`. Normalize to claude-proxy format.

**Files:**
- Modify: `server.mjs:339`

- [ ] **Step 1: Change diffState to wrap spans in object**

In `server.mjs`, change line 339 from:

```javascript
      changed[i] = curr.lines[i].spans;
```

to:

```javascript
      changed[i] = { spans: curr.lines[i].spans };
```

- [ ] **Step 2: Verify server starts**

Run: `bash restart-server.sh`
Expected: `svg-terminal server listening on port 3200`

- [ ] **Step 3: Commit**

```bash
git add server.mjs
git commit -m "refactor: normalize delta format to claude-proxy standard (changed[idx] = { spans })"
```

---

### Task 2: Update terminal.svg delta handler

terminal.svg currently reads `msg.changed[key]` as a raw spans array. Update to unwrap from `{ spans }`.

**Files:**
- Modify: `terminal.svg:317-320`

- [ ] **Step 1: Update delta handler to unwrap { spans }**

In `terminal.svg`, change lines 317-320 from:

```javascript
              var spans = msg.changed[keys[k]];
              updateLine(idx, spans);
              allLines[idx] = { spans: spans };
              prevState[idx] = JSON.stringify(spans);
```

to:

```javascript
              var lineData = msg.changed[keys[k]];
              var spans = lineData.spans || lineData;
              updateLine(idx, spans);
              allLines[idx] = { spans: spans };
              prevState[idx] = JSON.stringify(spans);
```

The `lineData.spans || lineData` fallback handles both formats during the transition — if somehow a raw array arrives, it still works.

- [ ] **Step 2: Verify terminal renders**

Open `http://localhost:3200` in a browser. Click a local tmux session thumbnail. Terminal should render with no errors in the browser console.

- [ ] **Step 3: Commit**

```bash
git add terminal.svg
git commit -m "refactor: terminal.svg delta handler expects { spans } wrapper (claude-proxy format)"
```

---

### Task 3: Update dashboard.mjs delta handlers

Two WebSocket `onmessage` handlers in dashboard.mjs (in `focusTerminal` and `addToFocus`) read `msg.changed[idx]` as a raw spans array. Update both.

**Files:**
- Modify: `dashboard.mjs:1697-1698` and `dashboard.mjs:1781-1782`

- [ ] **Step 1: Update focusTerminal delta handler**

In `dashboard.mjs`, change lines 1697-1698 from:

```javascript
        for (const [idx, spans] of Object.entries(msg.changed)) {
          t.screenLines[parseInt(idx)] = { text: spans.map(function(s) { return s.text; }).join(''), spans: spans };
```

to:

```javascript
        for (const [idx, lineData] of Object.entries(msg.changed)) {
          const spans = lineData.spans || lineData;
          t.screenLines[parseInt(idx)] = { text: spans.map(function(s) { return s.text; }).join(''), spans: spans };
```

- [ ] **Step 2: Update addToFocus delta handler**

In `dashboard.mjs`, change lines 1781-1782 from:

```javascript
        for (const [idx, spans] of Object.entries(msg.changed)) {
          t.screenLines[parseInt(idx)] = { text: spans.map(function(s) { return s.text; }).join(''), spans: spans };
```

to:

```javascript
        for (const [idx, lineData] of Object.entries(msg.changed)) {
          const spans = lineData.spans || lineData;
          t.screenLines[parseInt(idx)] = { text: spans.map(function(s) { return s.text; }).join(''), spans: spans };
```

- [ ] **Step 3: Commit**

```bash
git add dashboard.mjs
git commit -m "refactor: dashboard delta handlers expect { spans } wrapper (claude-proxy format)"
```

---

### Task 4: Update SPECIAL_KEY_MAP to claude-proxy key names

Dashboard currently translates browser keys to tmux names. Switch to claude-proxy names (which are closer to browser names anyway).

**Files:**
- Modify: `dashboard.mjs:95-113`

- [ ] **Step 1: Replace SPECIAL_KEY_MAP**

In `dashboard.mjs`, replace lines 95-113:

```javascript
const SPECIAL_KEY_MAP = {
  'Enter': 'Enter',
  'Tab': 'Tab',
  'Escape': 'Escape',
  'Backspace': 'BSpace',
  'Delete': 'DC',
  'ArrowUp': 'Up',
  'ArrowDown': 'Down',
  'ArrowLeft': 'Left',
  'ArrowRight': 'Right',
  'Home': 'Home',
  'End': 'End',
  'PageUp': 'PgUp',
  'PageDown': 'PgDn',
  'Insert': 'IC',
  'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
  'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
  'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
  ' ': 'Space',
```

with:

```javascript
const SPECIAL_KEY_MAP = {
  'Enter': 'Enter',
  'Tab': 'Tab',
  'Escape': 'Escape',
  'Backspace': 'Backspace',
  'Delete': 'Delete',
  'ArrowUp': 'Up',
  'ArrowDown': 'Down',
  'ArrowLeft': 'Left',
  'ArrowRight': 'Right',
  'Home': 'Home',
  'End': 'End',
  'PageUp': 'PageUp',
  'PageDown': 'PageDown',
  'Insert': 'Insert',
  'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
  'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
  'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
  ' ': 'Space',
```

- [ ] **Step 2: Update ctrl combo format**

In `dashboard.mjs`, change line 2256 from:

```javascript
    t.sendInput({ type: 'input', specialKey: 'C-' + e.key.toLowerCase() });
```

to:

```javascript
    t.sendInput({ type: 'input', keys: e.key.toLowerCase(), ctrl: true });
```

- [ ] **Step 3: Commit**

```bash
git add dashboard.mjs
git commit -m "refactor: SPECIAL_KEY_MAP uses claude-proxy key names, ctrl combos use { keys, ctrl }"
```

---

### Task 5: Translate input in server.mjs for legacy tmux sessions

`handleTerminalWs` receives claude-proxy format input and must translate back to tmux send-keys names for local sessions.

**Files:**
- Modify: `server.mjs:399-427`

- [ ] **Step 1: Add key name translation map**

In `server.mjs`, add after the `ALLOWED_SPECIAL_KEYS` set (after line 196):

```javascript
// Translate claude-proxy key names to tmux send-keys names for local sessions
const CP_TO_TMUX_KEYS = {
  'Backspace': 'BSpace',
  'Delete': 'DC',
  'PageUp': 'PgUp',
  'PageDown': 'PgDn',
  'Insert': 'IC',
};

function translateKeyForTmux(key) {
  return CP_TO_TMUX_KEYS[key] || key;
}
```

- [ ] **Step 2: Update isAllowedKey to accept claude-proxy names**

In `server.mjs`, change `isAllowedKey` (line 198-199) from:

```javascript
function isAllowedKey(key) {
  return ALLOWED_SPECIAL_KEYS.has(key) || /^C-[a-z]$/.test(key);
}
```

to:

```javascript
function isAllowedKey(key) {
  return ALLOWED_SPECIAL_KEYS.has(key) || Object.keys(CP_TO_TMUX_KEYS).includes(key) || /^C-[a-z]$/.test(key);
}
```

- [ ] **Step 3: Update handleTerminalWs input handler**

In `server.mjs`, replace the input handling block (lines 399-427) with:

```javascript
      if (msg.type === 'input') {
        const target = session + ':' + pane;
        if (msg.scrollTo != null) {
          // Legacy scrollTo — still supported for transition
          setScrollOffset(session, pane, Math.max(0, msg.scrollTo));
          lastState = null;
          await captureAndPush();
          return;
        } else if (msg.specialKey && isAllowedKey(msg.specialKey)) {
          // Any keystroke snaps back to live view
          setScrollOffset(session, pane, 0);
          const tmuxKey = translateKeyForTmux(msg.specialKey);
          const repeat = Math.min(Math.max(1, parseInt(msg.repeat) || 1), 200);
          if (repeat > 1) {
            const promises = [];
            for (let i = 0; i < repeat; i++) {
              promises.push(tmuxAsync('send-keys', '-t', target, tmuxKey));
            }
            await Promise.all(promises);
          } else {
            await tmuxAsync('send-keys', '-t', target, tmuxKey);
          }
        } else if (msg.keys != null) {
          setScrollOffset(session, pane, 0);
          if (msg.ctrl && msg.keys.length === 1) {
            // Ctrl combo: { keys: "c", ctrl: true } → tmux "C-c"
            await tmuxAsync('send-keys', '-t', target, 'C-' + msg.keys);
          } else {
            await tmuxAsync('send-keys', '-t', target, '-l', String(msg.keys));
          }
        }
        setTimeout(captureAndPush, 5);
      }
```

- [ ] **Step 4: Verify server starts**

Run: `bash restart-server.sh`
Expected: `svg-terminal server listening on port 3200`

- [ ] **Step 5: Commit**

```bash
git add server.mjs
git commit -m "feat: translate claude-proxy key names to tmux send-keys for local sessions"
```

---

### Task 6: Update scroll format

Dashboard currently sends `{ type: 'input', scrollTo: N }`. Switch to claude-proxy format `{ type: 'scroll', offset: N }`. server.mjs handles both for local sessions.

**Files:**
- Modify: `dashboard.mjs:1621-1623`
- Modify: `server.mjs:399` (add scroll handler)

- [ ] **Step 1: Update dashboard scrollBy**

In `dashboard.mjs`, change lines 1621-1623 from:

```javascript
    scrollBy: function(lines) {
      this.scrollOffset = Math.max(0, this.scrollOffset + lines);
      this.sendInput({ type: 'input', scrollTo: this.scrollOffset });
```

to:

```javascript
    scrollBy: function(lines) {
      this.scrollOffset = Math.max(0, this.scrollOffset + lines);
      this.sendInput({ type: 'scroll', offset: this.scrollOffset });
```

- [ ] **Step 2: Handle scroll message type in server.mjs**

In `server.mjs`, in `handleTerminalWs`, add a handler for `msg.type === 'scroll'` **before** the `msg.type === 'input'` block. Inside the `ws.on('message', ...)` handler, after line 382:

```javascript
      if (msg.type === 'scroll') {
        setScrollOffset(session, pane, Math.max(0, parseInt(msg.offset) || 0));
        lastState = null;
        await captureAndPush();
        return;
      }
```

- [ ] **Step 3: Commit**

```bash
git add dashboard.mjs server.mjs
git commit -m "refactor: scroll uses { type: 'scroll', offset } (claude-proxy format)"
```

---

### Task 7: Update server test for new delta format

The WebSocket test in test-server.mjs expects the old delta format. Update it.

**Files:**
- Modify: `test-server.mjs`

- [ ] **Step 1: Find and read the WebSocket delta test**

Run: `grep -n 'delta\|changed' test-server.mjs` to find the relevant test.

- [ ] **Step 2: Update the test assertion**

If the test checks `msg.changed[idx]` as a raw array, update to expect `msg.changed[idx].spans`. The exact change depends on what the test asserts — read it first, then update.

- [ ] **Step 3: Run all server tests**

Run: `node --test test-server.mjs`
Expected: All 18 tests pass.

- [ ] **Step 4: Commit**

```bash
git add test-server.mjs
git commit -m "test: update WebSocket test for new delta format"
```

---

### Task 8: Run E2E tests and verify claude-proxy session

Full validation pass.

**Files:** None (testing only)

- [ ] **Step 1: Run server tests**

Run: `node --test test-server.mjs`
Expected: All 18 tests pass.

- [ ] **Step 2: Run E2E tests**

Run: `node test-dashboard-e2e.mjs`
Expected: All 23 tests pass.

- [ ] **Step 3: Test claude-proxy session manually**

Open `http://localhost:3200` in browser. Look for `cp-SVG-Terminal_CLAUD-PROXY_integration_01` in the sidebar. Click it. Verify:
- Terminal content renders (not blank)
- Typing sends keystrokes
- Ctrl+C works
- PgUp/PgDn scrolls

- [ ] **Step 4: Test local tmux session still works**

Click `resize-test` in the sidebar. Verify:
- Terminal renders
- Typing works
- +/- resize works

- [ ] **Step 5: Commit server.mjs session discovery (if not already committed)**

The session discovery merge and WebSocket proxy in server.mjs are uncommitted from a previous agent. Commit them now that they're validated:

```bash
git add server.mjs
git commit -m "feat: merge session discovery from claude-proxy API + WebSocket proxy bridge"
```

Note: If server.mjs was already committed in earlier tasks, skip this step.
