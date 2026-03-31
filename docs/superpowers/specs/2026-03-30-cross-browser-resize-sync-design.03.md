# Cross-Browser Terminal Resize Sync — Design Spec

**Date:** 2026-03-30
**Status:** In Progress (brainstorming)
**Branch:** camera-only-test
**Journal:** docs/research/2026-03-30-v0.1-cross-browser-resize-sync-journal.md

---

## 1. Problem

When two browsers view the same svg-terminal dashboard and one user resizes a terminal (rows/cols via +/-, alt+scroll, optimize-fit), the other browser must instantly reflect the new dimensions. Currently browsers fight — one user's resize doesn't propagate to focused cards on other browsers, and simultaneous resizes from multiple users overwrite each other.

---

## 2. Current Architecture (Code Trace)

### How resize propagates today:

```
User 1 resizes (+/-, alt+scroll, optimize-fit)
  → dashboard.mjs sends { type: 'resize', cols, rows } via WebSocket
  → server.mjs calls `tmux resize-window -t session -x cols -y rows`
  → tmux session changes size
  → server re-captures after 10ms, pushes `screen` to User 1's WS only
  → User 1's _screenCallback → updateCardForNewSize() → card reshapes
```

### How User 2 discovers the resize:

- **Path A (fast, ~30ms):** User 2's WebSocket polls tmux at 30ms. Next `screen` message has new width/height. `_screenCallback` → `updateCardForNewSize()`.
- **Path B (slow, 5s):** `refreshSessions()` polls `/api/sessions` every 5 seconds.

### Key code finding: No feedback loop exists

`updateCardForNewSize()` is receive-only — it updates the local card DOM but does NOT send a resize command back to the server. There is no automatic ping-pong.

### The focused-card guard (line 1587):

```js
if (t.dom.classList.contains('focused')) return;
```

When a card is focused, `updateCardForNewSize()` updates `baseCardW/baseCardH` silently but skips the DOM update. This was designed for single-user ("the card is the user's window, +/- is font size inside it"). In multi-user, this means User 2 won't SEE User 1's resize if they have the terminal focused.

---

## 3. What Actually Breaks

Two identified failure modes:

**Failure 1 — Two humans fighting:** Both users send resize commands for the same terminal. tmux flip-flops between their desired sizes. Each browser sees the other's resize arrive, but the user is still actively resizing, so they send another command. Human-level race condition.

**Failure 2 — Focused-card guard blocks remote resize:** If User 2 has the terminal focused, `updateCardForNewSize()` early-returns. User 1's resize is invisible to User 2 until they unfocus.

---

## 4. Design Questions & Decisions

### Q1: Which resolution model?

**Options presented:**

| Option | Description | Tradeoff |
|--------|-------------|----------|
| **A) Last-write-wins** | Most recent resize command wins. Fix the focused-card guard so remote resizes are visible. | Simple. Two users can still fight. |
| **B) Authority/ownership** | One browser controls resize, others are read-only for that terminal. Claim via first-to-focus or explicit button. | Clean. Requires ownership UI and protocol. |
| **C) Lock-on-resize** | Starting a resize locks the terminal dimensions server-side. Other browsers' resizes rejected until lock releases. | Prevents fighting. Adds server state. |
| **D) Something else** | User-defined approach. | — |

**Agent recommendation: A (last-write-wins) is sufficient. The real fix is the focused-card guard.**

**Reasoning:**

After verifying the code, the propagation path already works. `diffState()` (server.mjs:368) explicitly checks `prev.width !== curr.width || prev.height !== curr.height` and sends a full `screen` message when dimensions change. User 2's independent 30ms poll catches this within one cycle. No broadcast changes needed.

The only confirmed bug is the focused-card guard at `updateCardForNewSize()` line 1587:
```js
if (t.dom.classList.contains('focused')) return;
```
This blocks DOM updates for focused cards. When User 1 resizes and User 2 has the same terminal focused, User 2's card shape stays stale even though the terminal content updates.

Options B (authority) and C (lock) add server state and protocol complexity for a problem that may not exist in practice — two users simultaneously resizing the same terminal is an edge case, and last-write-wins converges naturally once both stop resizing. Authority/lock can be layered on later via the follow-along mode (Task #8) if needed.

**Proposed fix (minimal, ~15 lines changed):**
1. Track `_lastSentResize = { cols, rows }` on each terminal object when this browser sends a resize command
2. In `_screenCallback`, when a `screen` message arrives with dimensions different from `_lastSentResize`, treat it as a remote resize
3. For remote resizes, call `updateCardForNewSize()` WITHOUT the focused-card guard — update the card DOM even when focused
4. Clear `_lastSentResize` after the server acknowledges (or after a short timeout)

---

## Q2: Should remote resize also re-layout focused cards?

When User 2's focused card gets remotely resized, the card DOM changes shape. If User 2 has multiple cards in multi-focus, the layout may need recalculating.

**Agent recommendation: Yes — call `calculateFocusedLayout()` after a remote resize changes card dimensions in multi-focus.**

If only one card is focused, the camera is already aimed at it — the card shape changes but the camera doesn't need to move. In multi-focus, the masonry packing should recompute to accommodate the new card shape.

---

## Q3: Should the user who triggered the resize see any indication that other browsers were affected?

**Agent recommendation: No — keep it invisible.** The resize just propagates. Adding notifications ("2 other browsers updated") is noise. The user expects the terminal to be the same size everywhere — that's the default behavior, not something to announce.

---

## 5. Proposed Design

### 5.1 Change to dashboard.mjs — updateCardForNewSize

Add a `remote` parameter:

```js
function updateCardForNewSize(t, newCols, newRows, remote) {
  if (newCols === t.screenCols && newRows === t.screenRows) return;
  t.screenCols = newCols;
  t.screenRows = newRows;
  const { cardW, cardH } = calcCardSize(newCols, newRows);
  t.baseCardW = cardW;
  t.baseCardH = cardH;
  // Skip DOM update for focused cards ONLY if this browser triggered the resize.
  // Remote resizes (from another browser) must update even when focused.
  if (!remote && t.dom.classList.contains('focused')) return;
  t.dom.style.width = cardW + 'px';
  t.dom.style.height = cardH + 'px';
  // ... inner element update
}
```

### 5.2 Change to _screenCallback — detect remote resize

```js
termObj.contentWindow._screenCallback = function(msg) {
  if (msg.type === 'screen' && msg.lines) {
    // Determine if this dimension change came from another browser.
    // If _lastSentResize is null, this browser hasn't resized — any dimension
    // change is remote. If _lastSentResize exists and dimensions match, it's
    // our own resize echoing back.
    var dimsChanged = (msg.width !== t.screenCols || msg.height !== t.screenRows);
    var isRemote = false;
    if (dimsChanged) {
      if (!t._lastSentResize) {
        // This browser didn't resize — change came from elsewhere
        isRemote = true;
      } else if (msg.width === t._lastSentResize.cols && msg.height === t._lastSentResize.rows) {
        // Matches what we sent — our own echo, not remote
        t._lastSentResize = null;
        isRemote = false;
      } else {
        // Dimensions changed but don't match what we sent — remote override
        isRemote = true;
        t._lastSentResize = null; // our resize was overridden, clear stale flag
      }
    }
    updateCardForNewSize(t, msg.width || 80, msg.height || 24, isRemote);
    // ...
  }
};
```

### 5.3 Change to resize senders — track last sent

Wherever the browser sends `{ type: 'resize', cols, rows }`, also set:
```js
t._lastSentResize = { cols, rows };
// Safety: clear after 2s in case server never echoes back (silent resize failure)
clearTimeout(t._lastSentResizeTimeout);
t._lastSentResizeTimeout = setTimeout(function() { t._lastSentResize = null; }, 2000);
```

### 5.4 Multi-focus re-layout

After a remote resize updates a focused card's dimensions, trigger layout recalculation:
```js
if (remote && focusedSessions.size > 1) calculateFocusedLayout();
```

### 5.5 Single-focus camera adjustment

In single focus, a remote resize changes the card's aspect ratio. The camera position may no longer center the card well. Minimal fix: after remote resize in single focus, re-run the camera tween to FOCUS_DIST from the card's updated center. This reuses existing focus animation code.

### 5.6 No server changes required

The 30ms poll + diffState width/height check already propagates dimension changes to all connected WebSockets. No broadcast, no lock, no authority protocol needed.

---

## 6. Constraints

| Constraint | Reason |
|-----------|--------|
| Camera-only focus model | Cards don't resize on focus — but terminal cols/rows CAN change inside a focused card |
| 4x scale trick | Card DOM is 4x, CSS3DObject 0.25 scale. Resize must preserve this. |
| `<object>` isolation | Resize propagation goes through contentWindow._screenCallback |
| No border on .terminal-3d | Re-rasterization. Resize indicators must avoid this. |
| Single WebSocket per terminal | Resize commands and screen data share one connection per terminal per browser |
