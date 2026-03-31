# Design.01 Notes — 01a (Agent Analysis)

**Re:** design.01.md — Resolution Model Q1
**Author:** Agent (proposal, not declaration — correct me)

---

## Q1 Response: Recommended Resolution Model

**Recommendation: Hybrid of B + C — Authority with implicit lock**

### Why not A (last-write-wins):
Last-write-wins is what we have today. It "works" for single user. For multi-user it means the terminal oscillates when two users resize simultaneously. Fixing the focused-card guard alone doesn't solve the fighting — it just makes both users see the fight happening. That's worse, not better.

### Why not pure C (lock-on-resize):
Server-side locks add state, timeouts, and edge cases (browser crashes mid-lock, lock expiry races). It's infrastructure for a problem that might be better solved by social contract (who owns what).

### Why B+C hybrid:
The real-world scenario is a classroom or team dashboard. One person (teacher, lead) is driving. Others are watching. This maps naturally to:

1. **tmux is the source of truth** — it already has one size. Whoever resized it last, that's the size.
2. **Server broadcasts dimension changes to ALL connected WebSockets** — not just the one that triggered the resize. This is the missing piece. Currently the server only pushes the re-capture to the triggering WebSocket.
3. **The focused-card guard gets a carve-out for remote resizes** — when the dimension change came from another browser (not from this browser's own resize action), update the card DOM even if focused.
4. **Optional: resize authority flag per terminal** — if we want to prevent fighting, a terminal can be "locked" by the browser that's actively resizing it. Other browsers see a brief lock indicator instead of being able to resize. Lock auto-releases on mouseup / 2s timeout.

### What this actually requires in code:

The core fix is small:
- **server.mjs:** When a resize comes in on one WebSocket, after re-capturing, broadcast the new `screen` message to ALL WebSockets watching that same session — not just the one that sent the resize.
- **dashboard.mjs:** Distinguish "I triggered this resize" from "another browser triggered this resize." For remote resizes, skip the focused-card guard.

The authority/lock layer is optional and can be added later. The broadcast fix alone may be sufficient.

---

## Open: Does the 30ms poll already handle this?

Re-reading the code: each WebSocket connection has its own 30ms poll loop (`setInterval(captureAndPush, 30)`). So User 2's connection IS already polling tmux independently and WILL pick up the new dimensions within 30ms.

**If this is true, the only real bug is the focused-card guard.** The 30ms poll makes the broadcast redundant for dimension changes — User 2 already gets the new screen data.

But: the 30ms poll uses `diffState()` which compares against `lastState`. If only dimensions changed but no content changed, does the diff catch it?

**Verified:** `diffState()` (server.mjs:368) explicitly checks `prev.width !== curr.width || prev.height !== curr.height`. When dimensions change, it sends a full `screen` message (not a delta). User 2's 30ms poll WILL detect the resize and push a full screen update within one poll cycle.

---

## Revised Analysis

**The propagation path already works.** User 2 gets the new dimensions within ~30ms via their independent poll loop + diffState width/height check.

**The only confirmed bug is the focused-card guard** (dashboard.mjs:1587):
```js
if (t.dom.classList.contains('focused')) return;
```

When User 2 has the terminal focused, `updateCardForNewSize()` silently updates `baseCardW/baseCardH` but skips the DOM update. The terminal content updates (new lines render), but the card shape stays stale.

**Proposed fix (minimal):**
- Distinguish "resize I initiated" from "resize that arrived from the server"
- For server-originated resizes, update the card DOM even when focused
- This requires a flag or a comparison: if the incoming `width/height` differs from what this browser last sent, it's a remote resize

**Question for user:** Is this the full scope of the problem, or is there a fighting scenario beyond the focused-card guard that needs addressing?
