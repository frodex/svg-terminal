# Cross-Browser Terminal Resize Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix terminal resize propagation so dimension changes are correctly reflected across all connected browsers.

**Architecture:** Remove the focused-card guard that blocks external resize updates. Add server-side resize lock to prevent multi-browser fighting. The 30ms WebSocket poll + diffState already propagates dimensions — no broadcast mechanism needed.

**Tech Stack:** Node.js (server.mjs), vanilla JS (dashboard.mjs), tmux CLI

**Spec:** `docs/superpowers/specs/2026-03-30-cross-browser-resize-sync-design.06.md`

---

## File Map

| File | Changes |
|------|---------|
| `dashboard.mjs` | Remove focused-card guard, verify +/- and optimize paths, add re-layout after external resize |
| `server.mjs` | Add per-session resize lock |
| `test-resize-propagation.sh` | New: test script for server-side resize events |
| `test-server.mjs` | Add resize lock test |
| `PRD.md` | Add "no outbound resize from incoming data" constraint |

---

### Task 1: Verify and fix single-browser +/- and optimize behavior (prerequisite)

**Why first:** Clearing known single-browser resize issues before adding multi-browser complexity. If single-browser is broken, multi-browser tests are meaningless.

**Files:**
- Modify: `dashboard.mjs:1274-1295` (+/- button handlers)
- Modify: `dashboard.mjs:1156-1165` (alt+scroll fontZoom)
- Modify: `dashboard.mjs:208-225` (optimizeCardToTerm)
- Modify: `dashboard.mjs:175-206` (optimizeTermToCard)

- [ ] **Step 1: Create the test script for server-side resize events**

Create `test-resize-propagation.sh`:

```bash
#!/bin/bash
# Test resize propagation — run while watching the dashboard
SESSION=${1:-resize-test}
echo "Resizing $SESSION every 2 seconds. Watch the dashboard."
echo "Ctrl+C to stop."
while true; do
  echo "→ 100x30"
  tmux resize-window -t "$SESSION" -x 100 -y 30
  sleep 2
  echo "→ 80x24"
  tmux resize-window -t "$SESSION" -x 80 -y 24
  sleep 2
  echo "→ 120x40"
  tmux resize-window -t "$SESSION" -x 120 -y 40
  sleep 2
done
```

```bash
chmod +x test-resize-propagation.sh
```

- [ ] **Step 2: Manual test — verify current +/- behavior while focused**

Open the dashboard in a browser. Focus a terminal. Press +/- buttons. Observe:
1. Do cols/rows change? (Check via `tmux display-message -p '#{window_width} #{window_height}'`)
2. Does the card DOM stay the same size? (Expected: yes, per camera-only model)
3. Does the SVG text re-render at the new size inside the fixed card? (Expected: yes)
4. Does the card letterbox or clip? (Document what happens)

Record results as a comment in the commit.

- [ ] **Step 3: Manual test — verify +/- then unfocus**

While focused, press +/- several times (change cols/rows). Then press Escape to unfocus. Observe:
1. Does the card snap to match the new terminal dimensions?
2. Is the snap jarring or smooth?
3. Does the ring re-layout accommodate the new card shape?

Record results.

- [ ] **Step 4: Manual test — verify optimize buttons**

Focus a terminal. Press ⊡ (fit terminal to card). Observe:
1. Do cols/rows change to fill the card?
Press ⊞ (fit card to terminal). Observe:
2. Does the card reshape to wrap the terminal snugly?

Record results.

- [ ] **Step 5: Manual test — external resize while unfocused**

Run `test-resize-propagation.sh resize-test` in a separate terminal. Watch the dashboard with the resize-test card NOT focused. Observe:
1. Does the card reshape every 2 seconds? (Expected: yes — this already works)

- [ ] **Step 6: Manual test — external resize while focused**

Run `test-resize-propagation.sh resize-test`. Focus the resize-test card. Observe:
1. Does the card reshape? (Expected: NO — the focused-card guard blocks this. This is the bug.)

Record this as the baseline before the fix.

- [ ] **Step 7: Commit baseline test results**

```bash
git add test-resize-propagation.sh
git commit -m "test: add resize propagation test script, document baseline behavior"
```

---

### Task 2: Remove the focused-card guard

**Files:**
- Modify: `dashboard.mjs:1577-1595` (updateCardForNewSize)

- [ ] **Step 1: Remove the guard**

In `dashboard.mjs`, change `updateCardForNewSize`:

```js
// BEFORE (line 1585-1587):
  // When focused: don't reshape the card. +/- changes font size inside the same card.
  // The card is the user's chosen window — only explicit actions (alt+drag, ⊞) change it.
  if (t.dom.classList.contains('focused')) return;

// AFTER:
  // Guard removed: card DOM always updates to match terminal dimensions.
  // External resizes (other browsers, SSH clients, tmux CLI) must be visible.
  // +/- changes cols/rows AND card reshapes — the camera-only model handles
  // apparent size via camera distance, not by freezing card dimensions.
```

The full function becomes:

```js
function updateCardForNewSize(t, newCols, newRows) {
  if (newCols === t.screenCols && newRows === t.screenRows) return;
  t.screenCols = newCols;
  t.screenRows = newRows;
  const { cardW, cardH } = calcCardSize(newCols, newRows);
  t.baseCardW = cardW;
  t.baseCardH = cardH;
  t.dom.style.width = cardW + 'px';
  t.dom.style.height = cardH + 'px';
  const inner = t.dom.querySelector('.terminal-inner');
  if (inner) {
    inner.style.width = cardW + 'px';
    inner.style.height = cardH + 'px';
  }
}
```

- [ ] **Step 2: Re-run external resize test while focused**

Run `test-resize-propagation.sh resize-test`. Focus the resize-test card. Observe:
1. Does the card now reshape every 2 seconds? (Expected: YES)
2. Does the card fight with `calculateFocusedLayout`? (Watch for jitter/oscillation)
3. Does text stay crisp? (4x scale trick preserved?)

- [ ] **Step 3: Re-run +/- test while focused**

Focus a terminal. Press +/- buttons. Observe:
1. Do cols/rows change AND card reshape? (Expected: yes — guard is removed, card follows terminal)
2. Does this feel right? Or does the user want the old "font size inside fixed card" behavior?

**If card reshaping on +/- is unwanted:** We need to re-add a narrow guard — but ONLY for local +/- actions, not for external resizes. See Task 3 alternative path.

- [ ] **Step 4: Re-run all manual tests from Task 1**

Verify:
- T1: External resize, card NOT focused → reshapes (should still work)
- T2: External resize, card focused → reshapes (NEW — should work now)
- T3: +/- then unfocus → card shape should match terminal
- T4: Optimize buttons → should work
- T5: Alt+drag resize → should work
- T6: Alt+scroll fontZoom → should work

- [ ] **Step 5: Commit**

```bash
git add dashboard.mjs
git commit -m "fix: remove focused-card guard — external resizes now visible on focused cards"
```

---

### Task 3: Re-layout focused cards after external dimension change

**Files:**
- Modify: `dashboard.mjs:1685-1700` (_screenCallback)

- [ ] **Step 1: Add re-layout trigger in _screenCallback**

After `updateCardForNewSize` is called in the `_screenCallback`, check if the card is focused and re-layout if needed:

```js
// In _screenCallback, after the updateCardForNewSize call at line 1692:
updateCardForNewSize(t, msg.width || 80, msg.height || 24);
// Re-layout if dimensions changed and card is focused
if ((msg.width !== prevCols || msg.height !== prevRows) && focusedSessions.has(sessionName)) {
  if (focusedSessions.size > 1) {
    calculateFocusedLayout();
  } else {
    // Single focus — re-tween camera to re-center on reshaped card
    focusTerminal(sessionName);
  }
}
```

This requires capturing prevCols/prevRows before the update:

```js
// Add before updateCardForNewSize call:
var prevCols = t.screenCols;
var prevRows = t.screenRows;
updateCardForNewSize(t, msg.width || 80, msg.height || 24);
if ((msg.width !== prevCols || msg.height !== prevRows) && focusedSessions.has(sessionName)) {
  if (focusedSessions.size > 1) {
    calculateFocusedLayout();
  } else {
    focusTerminal(sessionName);
  }
}
```

- [ ] **Step 2: Test with external resize in multi-focus**

Focus 2+ terminals. Run `test-resize-propagation.sh` targeting one of them. Observe:
1. Does the resized card change shape?
2. Does the layout repack to accommodate the new shape?
3. Do other focused cards stay in place?

- [ ] **Step 3: Test with external resize in single-focus**

Focus one terminal. Run `test-resize-propagation.sh`. Observe:
1. Does the card change shape?
2. Does the camera re-center on the reshaped card?

- [ ] **Step 4: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: re-layout focused cards when terminal dimensions change externally"
```

---

### Task 4: Server-side resize lock (prevents multi-browser fighting)

**Files:**
- Modify: `server.mjs:419-437` (handleTerminalWs resize handler)
- Modify: `test-server.mjs` (add lock test)

- [ ] **Step 1: Write the failing test**

Add to `test-server.mjs`:

```js
test('resize lock — second WebSocket rejected during lock window', async (t) => {
  // Open two WebSocket connections to the same session
  const ws1 = new WebSocket(`ws://localhost:${PORT}/ws/terminal?session=resize-test&pane=0`);
  const ws2 = new WebSocket(`ws://localhost:${PORT}/ws/terminal?session=resize-test&pane=0`);

  await Promise.all([
    new Promise(r => ws1.on('open', r)),
    new Promise(r => ws2.on('open', r)),
  ]);

  // Skip initial screen messages
  await new Promise(r => ws1.once('message', r));
  await new Promise(r => ws2.once('message', r));

  // WS1 sends resize — should succeed
  ws1.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));

  // Wait for WS1's resize to take effect
  await new Promise(r => setTimeout(r, 50));

  // WS2 sends different resize within lock window — should be rejected
  ws2.send(JSON.stringify({ type: 'resize', cols: 60, rows: 15 }));

  // Wait and check: tmux should still be at 100x30 (WS1's resize), not 60x15
  await new Promise(r => setTimeout(r, 100));

  const result = await tmuxAsync('display-message', '-t', 'resize-test', '-p', '#{window_width} #{window_height}');
  const [width] = result.stdout.trim().split(' ').map(Number);

  // Width should be 100 (WS1's resize stuck), not 60 (WS2's was rejected)
  assert.strictEqual(width, 100, 'WS2 resize should have been rejected during lock window');

  ws1.close();
  ws2.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test-server.mjs --test-name-pattern="resize lock"
```

Expected: FAIL — no lock exists yet, WS2's resize overwrites WS1's.

- [ ] **Step 3: Implement the resize lock**

In `server.mjs`, add before `handleTerminalWs`:

```js
// Per-session resize lock: when one WebSocket is actively resizing,
// other WebSockets' resize commands are rejected for RESIZE_LOCK_MS.
const resizeLocks = new Map(); // session → { ws, expires }
const RESIZE_LOCK_MS = 500;
```

In the resize handler inside `handleTerminalWs` (line 422), wrap the existing code:

```js
if (msg.type === 'resize') {
  const lock = resizeLocks.get(session);
  if (lock && lock.ws !== ws && Date.now() < lock.expires) {
    // Another browser holds the lock — reject this resize
    return;
  }
  resizeLocks.set(session, { ws, expires: Date.now() + RESIZE_LOCK_MS });
  const cols = Math.max(20, Math.min(500, parseInt(msg.cols) || 80));
  const rows = Math.max(5, Math.min(200, parseInt(msg.rows) || 24));
  try {
    await tmuxAsync('resize-window', '-t', session, '-x', String(cols), '-y', String(rows));
  } catch (err) {
    // resize may fail if session doesn't exist — ignore
  }
  lastState = null;
  setTimeout(captureAndPush, 10);
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test-server.mjs --test-name-pattern="resize lock"
```

Expected: PASS

- [ ] **Step 5: Run all existing server tests**

```bash
node --test test-server.mjs
```

Expected: All tests pass (existing + new).

- [ ] **Step 6: Commit**

```bash
git add server.mjs test-server.mjs
git commit -m "feat: server-side resize lock — prevents multi-browser resize fighting"
```

---

### Task 5: Multi-browser verification

**Files:** None changed — this is manual testing.

- [ ] **Step 1: Open two browser windows to the same dashboard**

Both should show the same set of terminal cards.

- [ ] **Step 2: Test T4 — resize from Browser A, observe Browser B**

In Browser A, focus a terminal and press +/- or alt+scroll. Observe Browser B:
1. Does Browser B's card update within ~30ms?
2. If Browser B has the same card focused, does it reshape?
3. Is the transition smooth?

- [ ] **Step 3: Test T5 — simultaneous resize from both browsers**

Both browsers focus the same terminal. Both press +/- rapidly. Observe:
1. Does the server lock prevent fighting? (One browser's resizes should be rejected for 500ms after the other's)
2. Do both browsers converge to the same size after both stop?

- [ ] **Step 4: Run external resize while both browsers watch**

Run `test-resize-propagation.sh`. Both browsers should show the card reshaping every 2 seconds, regardless of focus state.

- [ ] **Step 5: Document results and commit**

```bash
git commit --allow-empty -m "test: multi-browser resize sync verified manually — all scenarios pass"
```

---

### Task 6: Update PRD with new constraint

**Files:**
- Modify: `PRD.md` (§8 Constraints table)

- [ ] **Step 1: Add the no-outbound-resize constraint**

Add to the constraints table in PRD.md §8:

```markdown
| No outbound resize from incoming data | updateCardForNewSize and _screenCallback must never send a resize command. Only user gestures trigger outbound resizes. Violation creates cross-browser feedback loop. | agent 5 (2026-03-30) |
```

- [ ] **Step 2: Update §5.2 to reflect guard removal**

Update PRD.md §5.2 "During Focus" to reflect the new behavior:

Replace:
> Card size does NOT change. +/− changes cols/rows inside the same card (font size change).

With:
> Card DOM always reflects current terminal dimensions. +/− changes cols/rows, and the card reshapes to match. The camera-only model handles apparent size via camera distance. External resizes (other browsers, SSH clients) are immediately visible.

- [ ] **Step 3: Update anti-patterns table**

Add to PRD.md §9:

```markdown
| Focused-card guard blocking external resizes | Prevented external dimension changes from updating focused cards. Multi-browser resize invisible. | Guard removed — card DOM always updates | **Misunderstood constraint.** Guard was added to prevent fight with calculateFocusedLayout. The real fix is re-layout after dimension change, not blocking the update. agent 5 (2026-03-30) |
```

- [ ] **Step 4: Commit**

```bash
git add PRD.md
git commit -m "docs: update PRD — remove focused-card guard, add no-outbound-resize constraint"
```

---

### Task 7: Run full test suite

**Files:** None changed — verification only.

- [ ] **Step 1: Run server tests**

```bash
node --test test-server.mjs
```

Expected: All tests pass (including new resize lock test).

- [ ] **Step 2: Run E2E dashboard tests**

```bash
node test-dashboard-e2e.mjs
```

Expected: All 20+ tests pass. The guard removal may affect E2E tests that relied on cards NOT reshaping during focus — if any fail, investigate and fix.

- [ ] **Step 3: Run auth tests**

```bash
node --test test-auth.mjs
```

Expected: All pass (unrelated to resize changes, but verify no regressions).

- [ ] **Step 4: Document any E2E failures and fixes**

If E2E tests fail due to the guard removal, document what changed and why the test expectation was wrong (it was testing the buggy behavior).

- [ ] **Step 5: Final commit if any test fixes were needed**

```bash
git add -A
git commit -m "fix: update E2E tests for new resize behavior"
```
