# Cross-Browser Terminal Resize Sync — Design Spec v03

**Date:** 2026-03-30
**Status:** In Progress (brainstorming)
**Branch:** camera-only-test
**Preceding:** design.02.md → design.02-NOTES-01a.md → this file
**Journal:** docs/research/2026-03-30-v0.1-cross-browser-resize-sync-journal.md

---

##WE MAY BE OVER-THINKING THIS, WHEN WE CHANGE OUR TERMINAL LOCALLY, REMOTE BROWSERS SHOULD SIMPLY SEE THIS AS A SERVER SIDE TERMINAL RESIZE EVENT. WE SHOULD ALREADY BE ADJUSTING FOR THESE LOCALLY AND MY GUESS IS WE AREN'T. IF WE FIX SERVER SIDE TERMINAL REQUESTS PROPERLY FOR SINGLE USER, THEN ALL WE NEED TO DO IS MAKE SURE OUR CHANGE IS PROPAGATED TO THE OTHER BROWSER AS IT WOULD BE IF WE ARE THE SERVER AND THIS WORKS.  Changes from v02

Incorporating all 7 feedback items from NOTES-01a:

1. Added SSH resize token flow research (§2.1)
2. Added focused-card guard origin investigation (§2.3)
3. Addressed "suppress outbound resize if not user-initiated" idea (§3.1)
4. Resolution model updated: A+C hybrid per user preference (§4 Q1)
5. Q2 reworded, expanded to cover non-focused cards and lock/unlock icon (§4 Q2)
6. Q3 updated with command channel / screencap roadmap item (§4 Q3)
7. Added session-level resize permissions as roadmap item (§7)

---

## 1. Problem

When two browsers view the same svg-terminal dashboard and one user resizes a terminal (rows/cols via +/-, alt+scroll, optimize-fit), the other browser must instantly reflect the new dimensions. Currently browsers fight — one user's resize doesn't propagate to focused cards on other browsers, and simultaneous resizes from multiple users overwrite each other.

---

## 2. Current Architecture (Code Trace)

### 2.1 How resize tokens flow (full chain)

When an SSH user resizes their terminal window:

```
Terminal emulator (iTerm, PuTTY)
  → ioctl(TIOCSWINSZ) on local PTY master
  → kernel sends SIGWINCH to SSH client

SSH client
  → ioctl(TIOCGWINSZ) reads new size
  → SSH_MSG_CHANNEL_REQUEST "window-change" (RFC 4254 §6.7)
    cols, rows, xpixel, ypixel — want-reply=FALSE (fire-and-forget, no ACK)

SSH server (sshd)
  → ioctl(TIOCSWINSZ) on remote PTY master
  → kernel sends SIGWINCH to tmux client

tmux client
  → ioctl(TIOCGWINSZ) reads new size
  → MSG_RESIZE over Unix socket to tmux server

tmux server
  → recalculates window size (min of all attached clients)
  → ioctl(TIOCSWINSZ) on each affected pane's PTY master
  → re-renders, writes escape sequences back to all clients
```

**Key insight: No acknowledgment flows back at any layer.** Resize is fire-and-forget from terminal emulator to tmux server. Suppressing or modifying resizes has zero protocol-level side effects — the only consequence is whether the running program redraws correctly for the actual display size.

**Man-in-the-middle opportunity:** Since we control the WebSocket layer between browser and server.mjs, we are already the routing point. server.mjs receives `{ type: 'resize', cols, rows }` and decides whether to call `tmux resize-window`. We can suppress, debounce, lock, or route resize commands here without protocol violations.

### 2.2 How resize propagates in svg-terminal today

```
Browser sends { type: 'resize', cols, rows } via WebSocket
  → server.mjs handleTerminalWs receives it
  → server calls `tmux resize-window -t session -x cols -y rows`
  → server re-captures after 10ms, pushes `screen` to THIS WebSocket only
  → _screenCallback → updateCardForNewSize() → card reshapes
```

Other browsers discover the resize within ~30ms via their own independent WebSocket poll loop. `diffState()` (server.mjs:368) explicitly checks width/height changes and sends a full `screen` message when dimensions differ.

### 2.3 The focused-card guard — origin and reasoning

**Code:** `updateCardForNewSize()` dashboard.mjs:1587

WE NEED TO ABANDON THIS CALL TO THIS FUNCTION IF IT'S X,Y PIXEL MUTATION WHAT OTHER CALLS USE THIS, WHAT'S TRIGGERING IT ON FOCUS, THIS SHOULD ONLY BE CALLED IF CARD IS BEING MUTATED IN PHYSICAL SIZE (CHECK ME ON THIS, I SEE NO REASON FOR THIS TO BE CALLED OR PREVENT USERS FROM MUATING A CARD IN FOCUS MODE) MUTATE IF YOU NEED/WANT TO MUTATE. CAMERA FOCUS IS THE WAY FORWARD, CARD SIZE MUTATION DOES NOT TAKE PLACE ON FOCUS. - CAVEAT I HAVE FOUND A POTENTIAL ISSUE WITH RENDERING CLARITY DUE TO THE 3D. I THINK WE SHOULD TRY TO LAND THE CARDS WHEN FOCUSED AT INTEGERS OR WHERE WE DON'T HAVE SOME FRACTIONAL NUMBERS FOR THEIR SIZES, THIS MIGHT BE IMPOSSIBLE, IT COULD REQUIRE MUTATING THE ROW/COL AND CARD SIZES TO QUANTIZED AMOUNTS WHEN IN GROUPS OR WHEN FOCUSED SO THERES NO ALISIAING ON THE TEXT. MAKE A NOTE ABOUT THIS AS A NEED TO LOOK INTO IN OUR TASK LIST AND IN THE NOTES FOR THIS PDR PLEASE.

```js
if (t.dom.classList.contains('focused')) return;
```

**History (3 versions in git):**

1. **Introduced** (commit `661514`, 2026-03-29 00:18) — Part of frustum-projected layout. Guard prevents `updateCardForNewSize` from fighting `calculateFocusedLayout()`. Both change card DOM — without the guard, they overwrite each other.

2. **Removed** (commit `cd042ee`, 2026-03-29 09:40) — Caused letterboxing: +/- changed cols/rows but card kept old shape. Removed so card reshapes on +/-.

3. **Restored** (commit `29ff07d`, 2026-03-29 09:51, 11 minutes later) — User clarified the design intent: **"the card is my window, +/- is font size inside it."** The letterboxing was actually desired behavior. The card is a fixed viewport; content scales inside it. Only explicit actions (alt+drag, ⊞ button) change card DOM during focus.

**PRD codification:** §5.2 "During Focus": "Card size does NOT change. +/− changes cols/rows inside the same card (font size change)."

**Conclusion:** The guard is correct for local resizes (single-user design intent). For remote resizes (another browser changed the tmux session), the guard should be bypassed — the card must reshape to match the new terminal reality.

        THANK YOU, THIS REQUIRES ADDITIONAL THOUGHT. IF I UNDERSTAND THIS CORRECTLY, A CARD HAS TO PATHS TO MUTATE IT'S APPERANCE TO THE USERS PERSPECTIVE, BY RELATIONSHIP TO THE CAMERA (AND PERHAPS LENS ON CAMERA) AND VIA IT'S PHYSICAL SHAPE(X,Y SIZE IN PIXLES) THIS WAS TO PREVENT A RUNWAY RESIZING RACE BETWEEN THE FRUSTUM SIZING AND CARD-SIZE-MUTATION WHICH WAS THE PRIOR WAY. THIS DEBATE AND OUR CHOSEN PATH HAS INTRODUCED SOME SERIOUS CONFLICTS WITH USERS ABILITY TO LAYOUT AND CONTROL THE ORGINIZATION OF THE SCREEN TO THEIR DESIRED INTENT EASILY. PARTICULERY THE ABILITY TO ENLAGE A CARD RELATIVE TO THEIR POINT OF VIEW. A PURE CAMERA ONLY SOLUTION WOULD SIMPLY DOLLY THE CARD TOWARDS THE CAMERA AND I THINK THIS IS THE CORRECT SOLUTION, BUT WE HAVE A Z PLANE ISSUE WHEN SIZING A VERY LARGE CARD VERY FAR AWAY TO BE LARGER, IT'S QUITE POSSIBLE THAT IT ENLARGES BEHIND VERY SMALL CARDS THAT ARE LARGE IN THE USERS VIEW, SO APPEARING ECLIPSED BEHIND OTHER CARDS. MY SUGGESTION IS THIS VERY MUCH WOULD BE SEEN AS "STRANGE UI BEHAVIOR" AND WE DID SOME PRIOR RESEARCH ON Z-INDEX FOR 3D OBJECTS AND IT APPEARS IT'S POSSIBLE TO SIMULATE THE LARGER BUT FARTHER OBJECT APPEARING IN FRONT OF THE SMALER BUT CLOSER ECLIPSING OBJECT BY USING Z-INDEX MAKING THE FARTHER OBJECT RENDER IN FRONT OF THE CLOSER OBJECT BU SETTING A LARGER Z-INDEX. WHERE OUR RESEARCH STARTED TO HURT MY BRAIN WAS WHAT HAPPEND TO THIS "PATCH Z-INDEX" ON THE LARGER CARD? IS THIS NOW PERMIMENT? DO WE NOW FOREVER MORE HAVE A "WHAT'S WROGN WITH THAT CARD THAT'S RENDERING IN FRONT OF ALL THE OTHER CARDS" ISSUE? OR DO WE CLEAR THE Z-INDEX AT SOME TRIGGERING EVENT? WHAT IS THAT EVENT? HOW DO WE KNOW WHAT TO SET THE Z-INDEX AT? WHAT IS THE USERS INTENT? DO WE NEED TO POLL EVERYTHING ON THE SCREEN TO SET Z-INDEX FOR EVERY OBJECT? EVERY OBJECT IN THE FOCUS GROUP? YOUR INPUT WOULD BE APPRECIATED HERE.

---

## 3. What Actually Breaks

### 3.1 The user's primary concern: resize token echo loop

The concern is: receiving a resize from another browser could trigger an outbound resize back, creating a feedback loop.

**Code verification: This does NOT happen today.** `updateCardForNewSize()` is purely receive-side — it updates the local card DOM but never sends `{ type: 'resize' }` back to the server. There is no automatic echo.

**But this is worth protecting against as a hard constraint.** As we modify the focused-card guard, we must ensure no code path turns an incoming dimension change into an outgoing resize command. The rule:

> **Only user-initiated actions (mouse gestures, button clicks, keyboard shortcuts) may send outbound resize commands. Incoming screen data with new dimensions NEVER triggers an outbound resize.**

This is already true in the current code. It must be documented as a constraint and preserved.

### 3.2 Two humans fighting (simultaneous resize)

Both users send resize commands for the same terminal. tmux flip-flops. Each browser sees the other's resize arrive via the 30ms poll. If both users are actively dragging/scrolling, their resize commands interleave.

**Resolution:** Server-side resize lock (§5.4).

### 3.3 Focused-card guard blocks remote resize

Covered in §2.3. Fix in §5.1.

---

## 4. Design Questions & Decisions

### Q1: Which resolution model?

**Options considered:**

| Option                     | Description                                              | Tradeoff                                      |
| -------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| **A) Last-write-wins**     | Most recent resize command wins. Fix focused-card guard. | Simple. Two users can still fight.            |
| **B) Authority/ownership** | One browser controls resize, others read-only.           | Too restrictive. Rejected unless last resort. |
| **C) Lock-on-resize**      | Server rejects competing resizes for Xms.                | Prevents fighting. Small server state.        |

**Decision: A + C hybrid.**

- Last-write-wins as the base (simple, convergent)
- Server-side lock when a browser is actively resizing — other browsers' resize commands rejected for 500ms
- Lock auto-expires, no cleanup needed
- No authority/ownership model

### Q2: When a terminal's dimensions are remotely changed, what updates?

This applies to ALL cards showing that terminal, regardless of focus state:

| Browser              | Card state  | What happens on remote resize                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A (triggered resize) | Any         | Normal — own echo, card already correct                                                                                                                                                                                                                                                                                                                                       |
| B                    | NOT focused | `updateCardForNewSize()` reshapes card (already works)LETS INVESTIGATE THIS WORKFLOW TO MAKE SURE WE UNDERSTAND IF THIS IS ACTUALLY CORRECT I DON'T BELEIVE WE HAVE THIS FULLY DEBUGGED FOR SINGLE BROWSER USE. SO THAT'S STEP 1. I CAN THINK OF ONE CASE THIS IS NOT CORRECT AND THAT IS WITH +/- AFTER A TERMINAL MUTATE LIKE +/- THE TERMINAL SHOULD BE OPTIMIZED TO CARD. |
| B                    | Focused     | **Fix:** detect remote, bypass guard, reshape card                                                                                                                                                                                                                                                                                                                            |
| C (3rd browser)      | NOT focused | Same as B unfocused (already works)                                                                                                                                                                                                                                                                                                                                           |
| C                    | Focused     | Same as B focused (needs fix)                                                                                                                                                                                                                                                                                                                                                 |

**Re-layout after remote resize:**

- Multi-focus: call `calculateFocusedLayout()` to repack
- Single-focus: re-tween camera to re-center on reshaped card

**Lock/unlock icon (roadmap, §7.2):** All objects (cards, groups — recursive) get a mutation lock. Locked = remote resizes suppressed. Displayed as lock/open-lock icon on title bar.

### Q3: Should the resizing user see feedback about other browsers?

**Decision for today:** No feedback UI. Resize propagates silently.

**Roadmap (§7.3):** Command channel for cross-browser awareness — connected browser count, screencap/thumbnail requests, mutation source visibility. Ties into follow-along mode (Task #8).

---

## 5. Proposed Design

### 5.1 Bypass focused-card guard for remote resizes

Add a `remote` parameter to `updateCardForNewSize()`:

```js
function updateCardForNewSize(t, newCols, newRows, remote) {
  if (newCols === t.screenCols && newRows === t.screenRows) return;
  t.screenCols = newCols;
  t.screenRows = newRows;
  const { cardW, cardH } = calcCardSize(newCols, newRows);
  t.baseCardW = cardW;
  t.baseCardH = cardH;
  // The focused-card guard: card is the user's window, +/- is font size inside it.
  // ONLY applies to local resizes (this browser changed cols/rows).
  // Remote resizes (another browser changed the tmux session) must update the card
  // because the terminal content no longer matches the old card shape.
  if (!remote && t.dom.classList.contains('focused')) return;
  t.dom.style.width = cardW + 'px';
  t.dom.style.height = cardH + 'px';
  const inner = t.dom.querySelector('.terminal-inner');
  if (inner) {
    inner.style.width = cardW + 'px';
    inner.style.height = cardH + 'px';
  }
}
```

### 5.2 Detect remote resize in _screenCallback

```js
termObj.contentWindow._screenCallback = function(msg) {
  if (msg.type === 'screen' && msg.lines) {
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
        t._lastSentResize = null; // our resize was overridden
      }
    }
    updateCardForNewSize(t, msg.width || 80, msg.height || 24, isRemote);
    // Re-layout if this was a remote resize on a focused card
    if (isRemote && focusedSessions.has(sessionName)) {
      if (focusedSessions.size > 1) {
        calculateFocusedLayout();
      } else {
        // Single focus — re-tween camera to re-center on reshaped card
        focusTerminal(sessionName);
      }
    }
    // ... existing screenLines population
  }
};
```

### 5.3 Track last sent resize

Wherever the browser sends `{ type: 'resize', cols, rows }`:

```js
t._lastSentResize = { cols, rows };
clearTimeout(t._lastSentResizeTimeout);
t._lastSentResizeTimeout = setTimeout(function() { t._lastSentResize = null; }, 2000);
```

### 5.4 Server-side resize lock (prevents fighting)

In `handleTerminalWs` in server.mjs, add a per-session lock:

```js
// Per-session resize lock: when one WebSocket is actively resizing,
// other WebSockets' resize commands are rejected for LOCK_DURATION_MS.
const resizeLocks = new Map(); // session → { ws, expires }
const RESIZE_LOCK_MS = 500;

// In the resize handler:
if (msg.type === 'resize') {
  const lock = resizeLocks.get(session);
  if (lock && lock.ws !== ws && Date.now() < lock.expires) {
    // Another browser holds the lock — reject this resize
    return;
  }
  resizeLocks.set(session, { ws, expires: Date.now() + RESIZE_LOCK_MS });
  // ... proceed with tmux resize-window
}
```

Lightweight: one Map entry per active resize, auto-expires. No cleanup — stale entries overwritten on next resize.

### 5.5 Hard constraint: No outbound resize from incoming data

```
CONSTRAINT: updateCardForNewSize() and _screenCallback must NEVER send
a { type: 'resize' } message. Only user-initiated gestures (mouse,
keyboard, button) may trigger outbound resize commands. Violation
creates a cross-browser feedback loop.
```

Add to PRD §8 Constraints table.

### 5.6 No other server changes required

The 30ms poll + diffState width/height check already propagates dimension changes to all connected WebSockets within one poll cycle. No broadcast mechanism needed beyond the lock in §5.4.

---

## 6. Constraints

| Constraint                                     | Reason                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Camera-only focus model                        | Cards don't resize on focus — but terminal cols/rows CAN change inside a focused card                       |
| 4x scale trick                                 | Card DOM is 4x, CSS3DObject 0.25 scale. Resize must preserve this.                                          |
| `<object>` isolation                           | Resize propagation goes through contentWindow._screenCallback                                               |
| No border on .terminal-3d                      | Re-rasterization. Resize indicators must avoid this.                                                        |
| Single WebSocket per terminal                  | Resize commands and screen data share one connection per terminal per browser                               |
| No outbound resize from incoming data          | Prevents cross-browser feedback loop. Only user gestures trigger resize commands.                           |
| Focused-card guard preserved for local resizes | User design intent: card is the window, +/- is font size inside it. Guard only bypassed for remote resizes. |

---

## 7. Roadmap Items (captured, not implemented today)

### 7.1 Session-level resize permissions

Per-session config controlling who can resize. Maps to UGO permission model from claude-proxy auth:

- Owner can share as view-only (no resize allowed)
- Admin can resize but others cannot
- All users can resize (current default)

Preserve in PRD as future constraint.

### 7.2 Mutation lock icon (recursive)

All objects (cards, groups — recursive) get a lock/unlock property:

- **Locked:** remote resizes suppressed, card keeps current size
- **Unlocked (default):** remote resizes propagate
- Displayed as small lock/open-lock icon on title bar
- Applies to magnetic groups recursively — lock the group, all children locked

### 7.3 Cross-browser command channel

A status/feedback channel for connected browsers:

- Count of connected browsers
- Request screencap/thumbnail of another user's viewport
- See which browser triggered a mutation
- Foundation for follow-along mode (Task #8)
