# Keyboard Selection Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **REQUIRED READING before any work:** /srv/PHAT-TOAD-with-Trails/steward/system.md, /srv/PHAT-TOAD-with-Trails/steward/agent-handoff.md, /srv/PHAT-TOAD-with-Trails/steward/advice-for-new-agents/READ-THIS-FIRST.md

**Goal:** Make keyboard selection (Shift+Arrow) work with the same lifecycle as mouse selection — Shift release triggers auto-copy + fade, matching the mouseup behavior.

**Architecture:** Add Shift key tracking. Shift+Arrow extends selection (existing). Shift keyup triggers auto-copy to clipboard + flash + 2s fade + clearSel — same code path as mouse selection mouseup. Add `selMode` flag to prevent mouse fade from clearing a keyboard selection and vice versa.

**Tech Stack:** No new dependencies. Changes to `dashboard.mjs` only.

**Journal:** `docs/research/2026-03-30-v0.7-selection-bugs-journal.md`

---

## Constraint Declaration

| Constraint | Why | Breaks if violated |
|-----------|-----|-------------------|
| Cursor does NOT advance during Shift+Arrow | Terminal cursor belongs to the running process, not the dashboard. Arrow keys have application-specific meaning. Selection is a read-only overlay. | Unpredictable cursor behavior in non-readline contexts |
| Shift+Tab must NOT trigger selection complete | Shift+Tab cycles focused terminals (line 2154). Shift release after Shift+Tab must not auto-copy. | Terminal cycling breaks |
| `selMode` must distinguish mouse from keyboard | Mouse fade timer calls `clearSel()` after 2s. If keyboard selection started during fade, `clearSel()` would kill it. | Keyboard selection randomly disappears |
| Window blur must clear selection state | If user switches apps while Shift is held, keyup never fires. | Orphaned selection state |

## What Does NOT Change

- Mouse selection (drag → auto-copy → fade) — working, don't touch
- How highlight rects are drawn (`drawSelHighlight` via contentDocument sel-layer)
- How text is extracted (`getSelectedTextFromSvg`)
- How the terminal cursor works
- Ctrl+C behavior (sends C-c to terminal — no selection involvement)
- Any rendering, font, WebSocket, or CSS code

---

### Task 1: Add selMode flag and Shift tracking

**Files:** `dashboard.mjs`

- [ ] **Step 1:** Near the existing selection globals (line ~2272), add:

```javascript
let selMode = null;  // 'mouse' | 'keyboard' | null
```

- [ ] **Step 2:** In the mouse selection mousedown handler (line ~2605, after `selTerminal = t;`), add:

```javascript
  selMode = 'mouse';
```

- [ ] **Step 3:** In the Shift+Arrow handler (line ~2162, inside the `if (e.shiftKey && [...].includes(e.key))` block), after setting `selEnd` and before `drawSelHighlight`, add:

```javascript
    selMode = 'keyboard';
```

- [ ] **Step 4:** Add Shift keyup handler. After the existing keyup handler (line ~927), add:

```javascript
document.addEventListener('keyup', function(e) {
  if (e.key === 'Shift' && selMode === 'keyboard' && selStart && selEnd) {
    // Keyboard selection complete — same lifecycle as mouse selection mouseup
    var t = activeInputSession ? terminals.get(activeInputSession) : null;
    if (!t) { clearSel(); selMode = null; return; }

    // Auto-copy to clipboard
    var text = getSelectedTextFromSvg(t);
    if (text) copyToClipboard(text);

    // Flash bright then fade out over 2 seconds
    var layer = getSelOverlay(t);
    if (layer && layer.children.length > 0) {
      for (var fi = 0; fi < layer.children.length; fi++) {
        layer.children[fi].setAttribute('fill', 'rgba(200, 200, 255, 0.6)');
      }
      var fadeStart = performance.now();
      selMode = 'keyboard-fading';
      function fadeKbSel() {
        var elapsed = performance.now() - fadeStart;
        var progress = Math.min(1, elapsed / 2000);
        var opacity = 0.6 * (1 - progress);
        for (var fj = 0; fj < layer.children.length; fj++) {
          layer.children[fj].setAttribute('opacity', String(opacity));
        }
        if (progress < 1) {
          requestAnimationFrame(fadeKbSel);
        } else {
          if (selMode === 'keyboard-fading') {
            clearSel();
            selMode = null;
          }
        }
      }
      requestAnimationFrame(fadeKbSel);
    } else {
      clearSel();
      selMode = null;
    }
  }
});
```

- [ ] **Step 5:** Update the window blur handler (line ~931) to also clear keyboard selection:

```javascript
window.addEventListener('blur', function() {
  ctrlHeld = false; altHeld = false;
  if (selMode === 'keyboard') {
    clearSel();
    selMode = null;
  }
});
```

- [ ] **Step 6:** Commit:

```bash
git add dashboard.mjs
git commit -m "feat: Shift release triggers auto-copy + fade for keyboard selection"
```

---

### Task 2: Protect keyboard selection from mouse fade race

**Files:** `dashboard.mjs`

- [ ] **Step 1:** In the mouse selection mouseup handler, update the fade completion to check `selMode`:

Find the fade completion in the mouseup handler (the `if (progress < 1)` else branch). Change:

```javascript
        } else {
          clearSel();
        }
```

to:

```javascript
        } else {
          // Don't clear if keyboard selection started during mouse fade
          if (selMode !== 'keyboard' && selMode !== 'keyboard-fading') {
            clearSel();
            selMode = null;
          } else {
            // Just remove the fading mouse rects, redraw keyboard selection
            while (layer.firstChild) layer.removeChild(layer.firstChild);
            if (selStart && selEnd) drawSelHighlight(fadeTerminal);
          }
        }
```

- [ ] **Step 2:** Similarly, in the keyboard fade completion (from Task 1), it already checks `selMode === 'keyboard-fading'` before clearing. But also protect against mouse selection starting during keyboard fade:

The keyboard fade already has:
```javascript
if (selMode === 'keyboard-fading') {
  clearSel();
  selMode = null;
}
```
This is correct — if `selMode` changed to `'mouse'` during the fade, the clear is skipped.

- [ ] **Step 3:** Commit:

```bash
git add dashboard.mjs
git commit -m "fix: mouse and keyboard selection fades don't interfere with each other"
```

---

### Task 3: Handle edge cases

**Files:** `dashboard.mjs`

- [ ] **Step 1: Shift+Tab must not trigger selection complete**

The Shift+Tab handler (line ~2154) returns before reaching the Shift+Arrow check, so Shift+Arrow selection never starts during Shift+Tab. But Shift release after Shift+Tab would trigger the keyup handler.

Fix: the keyup handler checks `selMode === 'keyboard' && selStart && selEnd`. After Shift+Tab, `selStart` is null (no selection was started), so the handler does nothing. **No change needed** — already safe.

Verify this is correct by reading the code flow.

- [ ] **Step 2: Mouse click clears keyboard selection**

If keyboard selection is active (highlight visible, fading or not) and user clicks, the mouse selection mousedown handler fires. It sets `selMode = 'mouse'`. But it should also clear any existing keyboard highlight first.

In the mouse selection mousedown handler, before `selMode = 'mouse'`, add:

```javascript
  // Clear any existing keyboard selection
  if (selMode === 'keyboard' || selMode === 'keyboard-fading') {
    clearSel();
  }
```

- [ ] **Step 3: Escape clears keyboard selection**

In the main keydown handler, the Escape check (line ~2151). Change:

```javascript
  if (e.key === 'Escape') return;
```

to:

```javascript
  if (e.key === 'Escape') {
    if (selMode === 'keyboard' || selMode === 'keyboard-fading') {
      clearSel();
      selMode = null;
      e.preventDefault();
      return;
    }
    return;
  }
```

- [ ] **Step 4:** Commit:

```bash
git add dashboard.mjs
git commit -m "fix: mouse click and Escape clear keyboard selection, Shift+Tab safe"
```

---

### Task 4: Test with puppeteer + run test suite

- [ ] **Step 1:** Run all tests:

```bash
node --test test-server.mjs && node --test test-auth.mjs && node test-dashboard-e2e.mjs
```

All must pass.

- [ ] **Step 2:** Puppeteer test — verify Shift keyup fires and selMode transitions work. Since CSS3D makes interactive testing hard in headless, focus on verifying no JS errors and the code paths exist.

- [ ] **Step 3:** Commit any fixes.

---

## Anti-Patterns Considered and Rejected

| Approach | Why rejected | Journal |
|----------|-------------|---------|
| Keystroke-clear handler (clear selection when user types) | Removed in v3 mouse rework. Conflicts with user workflow — typing while selection visible should not destroy the selection. Also doesn't apply to keyboard selection which IS typing. | v0.5 |
| Ctrl+C to copy selection | Ctrl+C sends SIGINT to terminal — destructive. User spent time highlighting with Shift+Arrow, presses Ctrl+C expecting "copy", kills their process instead. Dangerous UX conflict. | v0.6, v0.7 |
| Persistent selection with Ctrl+C re-copy | Required tracking selection through scroll and new output. Content moves when new lines arrive, making highlight stale. Tracking needs server-side `baseY`/`historySize` — scope creep. Abandoned in favor of ephemeral selection with auto-copy. | v0.2 → v0.3 → v0.4 → abandoned v0.5 |
| Shift+Arrow advances terminal cursor | Arrow keys have application-specific meaning (vim navigates, less scrolls, Claude Code does menus). Can't assume arrow = "move cursor right by one character." Selection is a read-only overlay — cursor belongs to the process. | v0.7 |
| Send plain Arrow to terminal during Shift+Arrow | Same problem — we'd need to wait for terminal response, re-read cursor, and assume the arrow key moved it predictably. Fragile. | v0.7 |
| Keyboard selection persists until explicit dismiss | No natural "end" event for keyboard selection. Removed keystroke-clear, so nothing clears it. Highlight orphaned forever. The Shift-release insight solved this — Shift keyup IS the natural end event. | v0.6 → v0.7 |
| Two separate selection systems (mouse ephemeral, keyboard persistent) | Added complexity with `selMode` flag, different Ctrl+C behavior per mode, different clear logic per mode. Shift-release unifies them — both types have the same lifecycle: extend → release → auto-copy → fade. | v0.6 → rejected for unified model v0.7 |

## How We Arrived at This Design

1. **v0.1-v0.3:** Explored persistent selection with per-terminal capture. Complex state management.
2. **v0.4:** Discovered tracking selection through live output is not feasible without server changes.
3. **v0.5:** User chose ephemeral selection — auto-copy on mouseup, flash, fade, clear. Simple.
4. **v0.5 implemented:** Mouse selection works. But keyboard selection broke — no clear mechanism, no copy mechanism.
5. **v0.6:** Proposed `selMode` flag with separate mouse/keyboard lifecycles. Two systems = complex.
6. **v0.7:** User asked "do we get Shift release?" — yes. Shift release = keyboard equivalent of mouseup. Unifies both selection types into one lifecycle.

The design evolved through 7 journal versions, each responding to user testing and feedback. The final design is the simplest that works — same lifecycle for both input methods, no persistent state, no Ctrl+C conflict.

---

## References

| Document | Relevance |
|----------|-----------|
| `docs/research/2026-03-30-v0.5-selection-bugs-journal.md` | Direction confirmed: fade-on-release model for mouse selection |
| `docs/research/2026-03-30-v0.6-selection-bugs-journal.md` | Identified keyboard selection broken by mouse rework, proposed selMode |
| `docs/research/2026-03-30-v0.7-selection-bugs-journal.md` | Shift-release as "selection complete", tmux Shift+Arrow passthrough confirmed, cursor-doesn't-advance is correct |
| `docs/superpowers/plans/2026-03-30-selection-fixes.md` | v3 plan for mouse selection (bounds check, min drag, fade) — implemented |
