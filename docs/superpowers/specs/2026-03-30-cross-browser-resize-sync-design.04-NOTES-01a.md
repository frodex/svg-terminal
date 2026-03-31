# Cross-Browser Terminal Resize Sync — Design Spec v04

**Date:** 2026-03-30
**Status:** In Progress (brainstorming)
**Branch:** camera-only-test
**Preceding:** design.03.md → design.03-NOTES-01a.md → this file
**Journal:** docs/research/2026-03-30-v0.1-cross-browser-resize-sync-journal.md

---

## Changes from v03

User's key insight: **We may be overthinking this.** When Browser A resizes a terminal, Browser B should see it as a normal server-side terminal resize event — the same thing that happens when an SSH client resizes. If we handle server-side resize events correctly for a single browser, multi-browser just works because the server already propagates dimension changes to all WebSockets via the 30ms poll.

Specific changes:

1. Reframed the problem as "fix single-browser resize handling, then multi-browser is free" (§1)
2. Investigated all callers of `updateCardForNewSize` — only 2, both reactive, neither on focus (§2.3)
3. Addressed the Z-plane eclipsing problem when dolly-sizing cards (§3.4, new)
4. Added text aliasing investigation as Task #9 (§7.4)
5. Questioned whether unfocused-card path is fully correct for single browser (§4 Q2)

---

## 1. Problem (Reframed)

The cross-browser problem reduces to: **does svg-terminal correctly handle server-side terminal dimension changes for a single browser?**

If yes, multi-browser works for free — tmux is the source of truth, the server polls at 30ms, `diffState` detects dimension changes and pushes a full `screen` message to every connected WebSocket.

If no, fix single-browser first. The multi-browser issue is a symptom, not the root cause.

---

## 2. Current Architecture (Code Trace)

### 2.1 How resize tokens flow (SSH chain)

```
Terminal emulator → ioctl(TIOCSWINSZ) → SIGWINCH → SSH client
  → SSH_MSG_CHANNEL_REQUEST "window-change" (fire-and-forget, no ACK)
  → sshd → ioctl(TIOCSWINSZ) → SIGWINCH → tmux client
  → MSG_RESIZE → tmux server → ioctl on pane PTYs → re-render to all clients
```

No acknowledgment at any layer. We sit at the WebSocket layer and are already the man-in-the-middle. We can suppress, debounce, or lock resize commands without protocol violations.

### 2.2 How resize propagates in svg-terminal

```
Browser sends { type: 'resize', cols, rows } via WebSocket
  → server.mjs calls `tmux resize-window`
  → tmux changes → server re-captures → pushes screen to THIS WS
  → all other WS connections pick up new dims within ~30ms via poll
```

### 2.3 `updateCardForNewSize` — what calls it and when

**Only 2 callers, both reactive:**

| Caller              | Line | Trigger                                               | Sends outbound resize? |
| ------------------- | ---- | ----------------------------------------------------- | ---------------------- |
| `refreshSessions()` | 1494 | 5s HTTP poll of `/api/sessions`                       | No                     |
| `_screenCallback`   | 1692 | 30ms WebSocket `screen` message with new width/height | No                     |

**Neither is triggered by focus events.** Focus/unfocus does not call `updateCardForNewSize`. The function is purely reactive to dimension data arriving from the server.

**The focused-card guard (line 1587):**

```js
if (t.dom.classList.contains('focused')) return;
```

This guard exists to prevent `updateCardForNewSize` from fighting `calculateFocusedLayout()` — both change card DOM. The design intent (PRD §5.2): "card is the user's window, +/- is font size inside it." When the user presses +/-, tmux cols/rows change, but the card DOM stays the same size — the SVG re-renders with bigger/smaller text inside the fixed card shape.

**User's challenge to the guard:** Why prevent card mutation during focus? Users should be able to mutate if they want. Card size mutation does not take place on focus (camera-only). The guard should only apply to prevent the specific fight between `updateCardForNewSize` and `calculateFocusedLayout`, not broadly block all card resizing while focused.

**Agent analysis:** The user is right that the guard is overly broad. The guard prevents ALL dimension-driven card reshaping while focused, including:

- Remote resize from another browser (the bug we're fixing)
- SSH client resize changing tmux dimensions
- Any external dimension change

UNDER WHAT CIRCUMSTANCES WOULD A CARD FOCUS MUTATE THE CARD? THIS SHOULD NOT HAPPEN. IF IT DOES, IT WAS INTENDED. FOR EXAMPLE IF USER HAD A GROUP WHERE THEY SPECIFIC LOCATIONS,SIZES AND TERMINAL(ROW/COL) WERE SAVED, YES, THIS SHOULD BE ALLWOED TO BE RECALLED - THIS BLOCK WAS A PATCH AND SHOULD BE REMOVED AND TESTED AS A SINGLE TURN STEP, IF THINGS WORK, WE CLEAR THIS BLOCK, IF THINGS BREAK WE RE-THINK WHAT'S GOING ON AND WHAT WE NEED TO RE-DESIGN THE FLOW SO THERE'S A CORRECT PATH THROUGH THE EVENTS TO UN-BREAK IT. MY GUESS IS THIS IS LEFT OVER CRAP AND IS DEPRECTED BUT NOT REMOVED AND IS NOW CAUSING ISSUES.The guard should be narrowed: only suppress `updateCardForNewSize` during the specific window where `calculateFocusedLayout` is actively positioning cards. Or better: let `updateCardForNewSize` always update the DOM, and have `calculateFocusedLayout` run after to repack if needed.

---

## 3. What Actually Breaks

### 3.1 No outbound resize from incoming data (confirmed)

`updateCardForNewSize()` is purely receive-side. No outbound resize commands. No feedback loop risk. Documented as hard constraint.

### 3.2 Two humans fighting

Server-side lock (§5.4) prevents interleaved resize commands. WE HAVE REASONABLE SOLUTION WITH THIS

### 3.3 Focused-card guard blocks ALL external resizes

The guard blocks not just multi-browser resizes but also SSH client resizes, tmux resize from command line, etc. Any dimension change from outside this browser's own actions is invisible while focused. SEE ABOVE

### 3.4 Z-plane eclipsing when dolly-sizing cards (NEW)

MAKE NOTE OF THIS ISSUE AND MOVE THIS INTO A TODO LIST WITH A REFFERENCE TO THE DOCUMENT YOU PLACE THIS INTO. MAKE A JOURNAL ENTRY FOR THIS ALSO. Z-plane-eclipsing-when-scaling-cards-with-camera-TO-DO.md DEALING WITH THIS IS OFF TOPIC FOR THIS SUB-PROJECT AND NOT A BLOCKER

**The problem:** In a camera-only model, making a card "larger" means dollying it closer to the camera (smaller Z distance). But a large card far away (high Z) can appear large in the viewport while being geometrically behind small cards that are close (low Z). The large-far card renders behind the small-close card — eclipsed.

**Can z-index solve this?** CSS3DRenderer renders cards as DOM elements with `matrix3d` transforms. The browser composites based on the transform's Z component. `z-index` on a CSS3D element would override the natural depth sorting.

**The z-index problem cascade:**

1. Set z-index on the large-far card to render in front → works for that card
2. But now it renders in front of ALL closer cards, not just the ones eclipsing it
3. Is it permanent? When do we clear it?
4. What triggers the clear? Unfocus? Deselect? Ring return?
5. Do we need to poll all on-screen cards to compute correct z-index ordering?
6. For a focus group, do we z-index sort all members?

**Agent analysis — proposal:**

z-index is the wrong tool here. CSS3DRenderer already handles depth sorting via the `matrix3d` transform's Z translation. The real problem is that "make this card appear larger" via dolly conflicts with "depth ordering matches visual intent."

**Three approaches:**

**A) Accept the constraint.** In a true 3D space, closer objects occlude farther ones. This is correct behavior. Users learn that "larger" means "closer" and occluding is expected. The card IS in front — that's what larger means in 3D.

**B) Scale the card DOM instead of dollying.** When the user wants a card "bigger," actually resize the card DOM (change `calcCardSize` parameters or the CSS3DObject scale). This breaks the camera-only model but is more intuitive — the card gets bigger without changing its Z position, so depth ordering is preserved.

**C) Hybrid: dolly within focus group, z-index managed per group.** Within a multi-focus group, all cards share a narrow Z band. The active card gets z-index boost within the group. On unfocus/return-to-ring, z-index is cleared. Managed per focus group, not globally.

**Recommendation: A for now, C as future refinement.** The Z-slide removal (Task #4) already reduces Z manipulation in focus groups. With all focused cards at similar Z depths (frustum layout), eclipsing is minimal. If it becomes a UX problem in practice, C adds a bounded z-index solution per group.

This is a deeper UX question that overlaps with Task #5 (intuitive card sizing). Captured as a discussion point there, not solved in this spec.

---

## 4. Design Questions & Decisions

### Q1: Resolution model — A + C hybrid (confirmed from v03)

Last-write-wins + 500ms server-side lock. No change from v03.

### Q2: Single-browser resize correctness

WE WILL ADDRESS THIS BEFORE WE START AS PART OF THIS PROJECT. CLEARING KNOWN ISSUES THAT PROHIBIT PROPER TESTING. FIRST PHASE IN IMPLEMENATION

**User's concern:** The unfocused-card path may not be fully debugged. Specifically: after +/- changes terminal cols/rows on an unfocused card, the terminal should be "optimized to card" — meaning the card reshapes to match the new terminal dimensions.

**Code trace:**

1. +/- is only active when a card is focused (the keydown handler checks `activeInputSession`)
2. When the user presses +/-, it sends a resize command changing cols/rows
3. If the user then unfocuses, the card's `baseCardW/baseCardH` were updated by `updateCardForNewSize` (the base values update even when the guard blocks DOM changes)
4. On unfocus, `restoreFocusedTerminal()` applies `baseCardW/baseCardH` to the DOM

**Potential bug:** If the user presses +/- while focused (cols/rows change, card shape stays), then unfocuses, the card snaps to the new shape based on `baseCardW/baseCardH`. This is correct — the card reshapes to match the terminal on unfocus. But:

- Is the snap jarring? Should it tween?
- What if `baseCardW/baseCardH` were updated by a REMOTE resize while focused? On unfocus, the card snaps to the remote size — is that what the user expects?

**Action:** Verify this path works correctly in single-browser before adding multi-browser complexity. This is Step 1.

### Q3: Feedback — no change from v03.

---

## 5. Proposed Design (Simplified)

The user's reframing simplifies the design: **fix single-browser handling of server-side dimension changes, then multi-browser is free.**

### 5.1 Remove the focused-card guard (or narrow it)

**Option A (remove):** Delete the `if (focused) return` guard entirely. Let `updateCardForNewSize` always update the card DOM. If this fights with `calculateFocusedLayout`, add a debounce or let the layout recalculate after the dimension update.

**Option B (narrow):** Keep the guard but only for LOCAL resizes where the user's intent is "font size change inside fixed card." Bypass for remote/external dimension changes. This is the `remote` parameter approach from v03.

**Agent recommendation: Start with Option A (remove the guard).** Test single-browser: press +/-, resize via alt+scroll, resize via SSH. See if anything fights. If `calculateFocusedLayout` conflicts, add the narrow guard (Option B). Don't preemptively protect against a fight that may not happen.

### 5.2 Detect remote resize (if Option B needed)

Same as v03 §5.2 — track `_lastSentResize`, detect when incoming dimensions don't match.

### 5.3 Track last sent resize

Same as v03 §5.3.

### 5.4 Server-side resize lock

Same as v03 §5.4. Per-session, 500ms expiry, lightweight Map.

### 5.5 Re-layout after dimension change

After any `updateCardForNewSize` changes card DOM during focus:

- Multi-focus: `calculateFocusedLayout()`
- Single-focus: re-tween camera

### 5.6 Hard constraint preserved

No outbound resize from incoming data. Add to PRD §8.

---

## 6. Constraints

| Constraint                            | Reason                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Camera-only focus model               | Cards don't resize on focus. But terminal cols/rows CAN change, and card DOM should reflect reality. |
| 4x scale trick                        | Card DOM is 4x, CSS3DObject 0.25 scale. Resize must preserve this.                                   |
| `<object>` isolation                  | Resize propagation goes through contentWindow._screenCallback                                        |
| No border on .terminal-3d             | Re-rasterization under CSS3D.                                                                        |
| No outbound resize from incoming data | Prevents cross-browser feedback loop.                                                                |
| Depth ordering is Z-based             | CSS3DRenderer sorts by transform Z. No z-index manipulation on cards.                                |

---

##INSERT SECTION - HOW DO WE TRIGGER/TEST SERVER SIDE RESIZE EVENTS. WE NEED A TEST APPLICATION THAT CAN SEND SERVER SIDE RESIZE EVENTS.

## 7. Roadmap Items

### 7.1 Session-level resize permissions (UGO)

Per-session config: owner view-only, admin-only resize, or all-resize. Maps to claude-proxy UGO model.

### 7.2 Mutation lock icon (recursive)

Lock/unlock on title bar. Locked = remote resizes suppressed. Recursive for groups.

### 7.3 Cross-browser command channel

Browser count, screencaps, mutation source. Foundation for follow-along (Task #8).

### 7.4 Text aliasing from fractional sizes (Task #9)

Cards at fractional pixel dimensions under CSS3D may cause text aliasing. Investigate quantizing card sizes, row/col counts to integers when focused or in groups. May require adjusting `calcCardSize()` or frustum projection to land on integer boundaries.

### 7.5 Z-plane eclipsing in focus groups

When cards at different Z depths overlap in screen space, depth sorting may not match user intent. Three approaches documented in §3.4. Deferred — overlaps with Task #5 (intuitive card sizing UX).
