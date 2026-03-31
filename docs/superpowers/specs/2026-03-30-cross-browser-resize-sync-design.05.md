# Cross-Browser Terminal Resize Sync — Design Spec v05

**Date:** 2026-03-30
**Status:** In Progress (converging)
**Branch:** camera-only-test
**Preceding:** design.04.md → design.04-NOTES-01a.md → this file
**Journal:** docs/research/2026-03-30-v0.1-cross-browser-resize-sync-journal.md

---

## Changes from v04

1. Focused-card guard: confirmed — remove it, test, redesign flow if it breaks (not patch) (§2.3)
2. Z-plane eclipsing moved out of this spec → Task #10 + journal (off-topic, not a blocker)
3. Single-browser resize correctness confirmed as Phase 1 of implementation (§4 Q2)
4. Added §6: Testing — how to trigger/verify server-side resize events (§6)
5. Simplified §3 — removed Z-plane eclipsing section

---

## 1. Problem

The cross-browser problem reduces to: **does svg-terminal correctly handle server-side terminal dimension changes for a single browser?**

If yes, multi-browser works for free — tmux is the source of truth, the server polls at 30ms, `diffState` detects dimension changes and pushes a full `screen` message to every connected WebSocket.

If no, fix single-browser first. The multi-browser issue is a symptom, not the root cause.

---

## 2. Current Architecture

### 2.1 Resize token flow (SSH chain)

```
Terminal emulator → ioctl(TIOCSWINSZ) → SIGWINCH → SSH client
  → SSH_MSG_CHANNEL_REQUEST "window-change" (fire-and-forget, no ACK)
  → sshd → ioctl(TIOCSWINSZ) → SIGWINCH → tmux client
  → MSG_RESIZE → tmux server → ioctl on pane PTYs → re-render to all clients
```

No acknowledgment at any layer. We sit at the WebSocket layer — already the man-in-the-middle. Can suppress, debounce, or lock resize commands without protocol violations.

### 2.2 svg-terminal resize propagation

```
Browser sends { type: 'resize', cols, rows } via WebSocket
  → server.mjs calls `tmux resize-window`
  → tmux changes → server re-captures → pushes screen to THIS WS
  → all other WS connections pick up new dims within ~30ms via poll
```

### 2.3 `updateCardForNewSize` — callers and the focused-card guard

**Only 2 callers, both reactive, neither triggered by focus:**

| Caller | Line | Trigger | Sends outbound resize? |
|--------|------|---------|----------------------|
| `refreshSessions()` | 1494 | 5s HTTP poll | No |
| `_screenCallback` | 1692 | 30ms WebSocket screen data | No |

**The focused-card guard (line 1587):**
```js
if (t.dom.classList.contains('focused')) return;
```

**Origin:** Added to prevent `updateCardForNewSize` from fighting `calculateFocusedLayout()` — both change card DOM. Removed once (caused letterboxing), restored 11 minutes later when user clarified "card is my window, +/- is font size inside it."

**Decision: Remove the guard.** Test as a single-turn step. Focus should not mutate the card — this is the camera-only model. If the guard was preventing a real fight, we'll see it immediately and redesign the event flow rather than re-patching. The guard is likely deprecated cruft from the pre-camera-only era causing more problems than it solves.

---

## 3. What Actually Breaks

### 3.1 No outbound resize from incoming data (confirmed)

`updateCardForNewSize()` is purely receive-side. No feedback loop. Hard constraint:

> **Only user-initiated actions may send outbound resize commands. Incoming screen data with new dimensions NEVER triggers an outbound resize.**

### 3.2 Two humans fighting

Server-side resize lock (§5.3) rejects competing resizes for 500ms. Confirmed as reasonable solution.

### 3.3 Focused-card guard blocks ALL external resizes

Removing the guard (§2.3) fixes this for all cases — remote browser, SSH client, tmux command line.

---

## 4. Design Questions & Decisions

### Q1: Resolution model — A + C hybrid (confirmed)

Last-write-wins + 500ms server-side lock. No change.

### Q2: Single-browser resize correctness — Phase 1

Address before multi-browser. Clear known issues that prevent proper testing:
1. Remove the focused-card guard
2. Verify +/- works correctly (focused: font size change, unfocused: card reshapes)
3. Verify alt+drag resize works
4. Verify optimize-fit (⊡/⊞) works
5. Verify external tmux resize (from SSH or command line) updates the card

This is the first phase of implementation.

### Q3: Feedback — no change. Silent propagation today, command channel on roadmap.

---

## 5. Proposed Design

### 5.1 Phase 1: Fix single-browser resize handling

1. **Remove the focused-card guard** — delete `if (t.dom.classList.contains('focused')) return;` from `updateCardForNewSize()`
2. **Test all resize paths** using the test harness (§6)
3. If `calculateFocusedLayout` fights with `updateCardForNewSize`, resolve by having layout run AFTER the dimension update (not by blocking the update)

### 5.2 Phase 2: Server-side resize lock

Add per-session lock in `handleTerminalWs`:

```js
const resizeLocks = new Map(); // session → { ws, expires }
const RESIZE_LOCK_MS = 500;

if (msg.type === 'resize') {
  const lock = resizeLocks.get(session);
  if (lock && lock.ws !== ws && Date.now() < lock.expires) {
    return; // another browser holds the lock
  }
  resizeLocks.set(session, { ws, expires: Date.now() + RESIZE_LOCK_MS });
  // proceed with tmux resize-window
}
```

### 5.3 Phase 3: Multi-browser verification

Open two browsers, resize from one, verify the other updates. The 30ms poll + diffState should handle everything with no additional code if Phase 1 is correct.

### 5.4 Hard constraint

No outbound resize from incoming data. Add to PRD §8 Constraints table.

---

## 6. Testing — Server-Side Resize Events

### 6.1 The problem

We need to simulate server-side terminal resize events (as if an SSH client or another process resized the tmux session) to verify that the browser correctly handles dimension changes it didn't initiate.

### 6.2 Test tool: `tmux resize-window` from command line

The simplest approach — run tmux commands directly:

```bash
# Resize a session to 100x30
tmux resize-window -t resize-test -x 100 -y 30

# Resize back to 80x24
tmux resize-window -t resize-test -x 80 -y 24
```

This triggers the exact same code path as an SSH client resize. The server's 30ms poll detects the new dimensions via `diffState`.

### 6.3 Test script: `test-resize-propagation.sh`

A simple script that cycles through resize events:

```bash
#!/bin/bash
# Test resize propagation — run while watching the dashboard
SESSION=${1:-resize-test}
echo "Resizing $SESSION every 2 seconds. Watch the dashboard."
while true; do
  tmux resize-window -t "$SESSION" -x 100 -y 30
  sleep 2
  tmux resize-window -t "$SESSION" -x 80 -y 24
  sleep 2
  tmux resize-window -t "$SESSION" -x 120 -y 40
  sleep 2
done
```

### 6.4 Test matrix

| Test | Action | Expected result |
|------|--------|-----------------|
| T1 | Run test script, card NOT focused | Card reshapes every 2s |
| T2 | Run test script, card focused | Card reshapes every 2s (after guard removal) |
| T3 | Run test script, card in multi-focus | Card reshapes, layout repacks |
| T4 | Two browsers open, resize from Browser A | Browser B card updates within ~30ms |
| T5 | Two browsers, both resize simultaneously | Server lock prevents fighting, last-write-wins after lock expires |
| T6 | +/- while focused, then unfocus | Card snaps to match new terminal dims |

---

## 7. Constraints

| Constraint | Reason |
|-----------|--------|
| Camera-only focus model | Cards don't resize on focus. Terminal cols/rows CAN change, card DOM should reflect reality. |
| 4x scale trick | Card DOM is 4x, CSS3DObject 0.25 scale. Resize must preserve this. |
| `<object>` isolation | Resize propagation goes through contentWindow._screenCallback |
| No border on .terminal-3d | Re-rasterization under CSS3D. |
| No outbound resize from incoming data | Prevents cross-browser feedback loop. |
| Depth ordering is Z-based | CSS3DRenderer sorts by transform Z. |

---

## 8. Roadmap Items

### 8.1 Session-level resize permissions (UGO)

Per-session config: owner view-only, admin-only resize, or all-resize. Maps to claude-proxy UGO model.

### 8.2 Mutation lock icon (recursive)

Lock/unlock on title bar. Locked = remote resizes suppressed. Recursive for groups.

### 8.3 Cross-browser command channel

Browser count, screencaps, mutation source. Foundation for follow-along (Task #8).

### 8.4 Text aliasing from fractional sizes (Task #9)

Investigate quantizing card sizes to integers under CSS3D. May require adjusting `calcCardSize()` or frustum projection.

### 8.5 Z-plane eclipsing (Task #10)

Deferred. Journal: `docs/research/2026-03-30-v0.1-z-plane-eclipsing-journal.md`
