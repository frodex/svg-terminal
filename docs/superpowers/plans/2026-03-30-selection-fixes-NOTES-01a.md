# Selection Bug Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 
> **REQUIRED READING before any work:** /srv/PHAT-TOAD-with-Trails/steward/system.md, /srv/PHAT-TOAD-with-Trails/steward/agent-handoff.md, /srv/PHAT-TOAD-with-Trails/steward/advice-for-new-agents/READ-THIS-FIRST.md

**Goal:** Fix selection triggering from thumbnails, and make selection survive scrolling with valid highlight positions.

**Architecture:** Selection coordinates change from viewport-relative `{ row, col }` to absolute buffer positions `{ row, col, scrollOffset }`. Highlight drawing recalculates viewport rows from absolute positions on each render. Bounds check added to prevent selection from starting outside the card body.

**Tech Stack:** No new dependencies. Changes to `dashboard.mjs` only.

**Journal:** `docs/research/2026-03-30-v0.1-selection-bugs-journal.md`

---

## Constraint Declaration

### Hard Constraints

| Constraint                                                                 | Why                                                            | Breaks if violated               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| `pointer-events: none` on `<object>`                                       | CSS3DRenderer event routing                                    | All clicks/drags stop working    |
| Coordinate-based hit testing (no `e.target.closest`)                       | CSS3D 2D hit testing ignores Z depth (PRD §6.3)                | Wrong card intercepts clicks     |
| `screenToCell` uses `contentDocument` to read SVG viewBox and font metrics | Accurate cell mapping depends on SVG rendering context         | Selection highlights wrong cells |
| Selection highlight drawn inside SVG via `contentDocument` sel-layer       | Must be in SVG coordinate space to align with text             | Highlight misaligned             |
| `selTerminal = null` on mouseup stops drag tracking                        | Without this, mousemove keeps updating selection after release | "Keeps dragging" bug             |
| `selStart`/`selEnd` persist after mouseup for Ctrl+C                       | User-requested feature — highlight stays until next keystroke  | Copy stops working               |

### What Does NOT Change

- How selection is rendered (SVG rects in sel-layer via contentDocument)
- How text is extracted for copy (getSelectedTextFromSvg)
- How selection is cleared (keydown handler, clearSel)
- The mouseup behavior (selTerminal = null, highlight stays)
- Any rendering, font, or WebSocket code

---

## Task 1: Bounds Check — Prevent Selection from Sidebar

**Files:** `dashboard.mjs`

**What changes:** The capture-phase mousedown handler (line 2593) gains a bounds check that verifies the click is within the active terminal's `<object>` bounding rect before starting selection.

- [ ] **Step 1: Read the current mousedown handler**

Read `dashboard.mjs` lines 2590-2622 to understand the current flow.

- [ ] **Step 2: Add bounds check after `const t = terminals.get(activeInputSession)`**

After line 2611 (`if (!t) return;`), add:

```javascript
  // Don't start selection if click is outside the focused terminal's card body.
  // Without this, clicking on thumbnails or empty space starts selection on the
  // focused terminal because screenToCell clamps out-of-bounds coordinates.
  const selObj = t.dom ? t.dom.querySelector('object') : null;
  if (selObj) {
    const selObjRect = selObj.getBoundingClientRect();
    if (e.clientX < selObjRect.left || e.clientX > selObjRect.right ||
        e.clientY < selObjRect.top || e.clientY > selObjRect.bottom) return;
  }
```

- [ ] **Step 3: Test in puppeteer**

Verify: Focus a terminal. Simulate a click at coordinates in the sidebar area. Verify `selStart` is NOT set. Simulate a click on the terminal body. Verify selection starts.

- [ ] **Step 4: Commit**

```bash
git add dashboard.mjs
git commit -m "fix: selection only starts when clicking on the focused terminal's body, not sidebar"
```

---

## Task 2: Store Absolute Buffer Positions in Selection

**Files:** `dashboard.mjs`

**What changes:** `selStart` and `selEnd` include `scrollOffset` at time of selection. This makes them absolute buffer positions rather than viewport-relative.

- [ ] **Step 1: Add scrollOffset when setting selStart/selEnd**

In the mousedown handler (line 2618-2620), change:

```javascript
  selTerminal = t;
  selStart = cell;
  selEnd = cell;
```

to:

```javascript
  selTerminal = t;
  selStart = { ...cell, scrollOffset: t.scrollOffset || 0 };
  selEnd = { ...cell, scrollOffset: t.scrollOffset || 0 };
```

- [ ] **Step 2: Add scrollOffset in mousemove**

In the mousemove handler (line 2624-2627), change:

```javascript
  selEnd = screenToCell(e, selTerminal);
```

to:

```javascript
  const newEnd = screenToCell(e, selTerminal);
  if (newEnd) {
    const t = terminals.get(activeInputSession);
    selEnd = { ...newEnd, scrollOffset: t ? (t.scrollOffset || 0) : 0 };
  }
```

- [ ] **Step 3: Add scrollOffset in mouseup**

In the mouseup handler (line 2632), change:

```javascript
  selEnd = screenToCell(e, selTerminal);
```

to:

```javascript
  const finalEnd = screenToCell(e, selTerminal);
  if (finalEnd) {
    const t = terminals.get(activeInputSession);
    selEnd = { ...finalEnd, scrollOffset: t ? (t.scrollOffset || 0) : 0 };
  }
```

- [ ] **Step 4: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: selection coordinates store scrollOffset for absolute buffer positions"
```

---

## Task 3: Highlight Drawing Accounts for Scroll Position

**Files:** `dashboard.mjs`

**What changes:** `drawSelHighlight` converts absolute positions back to viewport rows using the current scroll offset. Rows that have scrolled off screen are skipped.

- [ ] **Step 1: Read drawSelHighlight**

Read the current `drawSelHighlight` function to understand how it draws rects.

- [ ] **Step 2: Add viewport conversion**

At the top of `drawSelHighlight(t)`, after the null checks and before drawing rects, compute viewport-relative rows:

```javascript
  // Convert absolute buffer positions to viewport-relative for drawing
  const currentOffset = t.scrollOffset || 0;
  const startAbs = (selStart.row || 0) + (selStart.scrollOffset || 0);
  const endAbs = (selEnd.row || 0) + (selEnd.scrollOffset || 0);
  const startViewRow = startAbs - currentOffset;
  const endViewRow = endAbs - currentOffset;

  // If entire selection is off screen, clear and return
  const maxRow = t.screenRows || 24;
  if ((startViewRow >= maxRow && endViewRow >= maxRow) ||
      (startViewRow < 0 && endViewRow < 0)) {
    // Selection scrolled off screen — clear highlight but keep selStart/selEnd valid
    return;
  }
```

Then modify the drawing loop to use `startViewRow`/`endViewRow` instead of `selStart.row`/`selEnd.row`, clamping to `0..maxRow-1`.

NOTE: The exact modification depends on how `drawSelHighlight` currently iterates rows. Read the function first, then adapt. The key change is: replace `selStart.row` with `startViewRow` and `selEnd.row` with `endViewRow` in the drawing loop, and clamp both to the visible viewport.

- [ ] **Step 3: Update the scroll handler to redraw selection**

In the `scrollBy` function (line 1622), after changing `scrollOffset`, add a call to redraw the selection if one exists:

```javascript
    scrollBy: function(lines) {
      this.scrollOffset = Math.max(0, this.scrollOffset + lines);
      this.sendInput({ type: 'scroll', offset: this.scrollOffset });
      // Redraw selection highlight at new scroll position
      if (selStart && selEnd) {
        drawSelHighlight(this);
      }
    },
```

- [ ] **Step 4: Test in puppeteer**

Test sequence:

1. Focus terminal, select text on row 5-8

2. Verify highlight visible

3. Trigger scroll (PageUp equivalent)

4. Verify highlight moved or disappeared (if scrolled off screen)

5. Scroll back to original position

6. Verify highlight reappears at original position
- [ ] **Step 5: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: selection highlight scrolls with terminal content"
```

---

## Task 4: Copy Reads from Correct Absolute Positions

**Files:** `dashboard.mjs`

I DON'T LOVE THIS APPROACH - WHEN THE TEXT IS INITIALLY HIGHLIGHTED, WE CAPTURE THE TEXT, WE CAN ASSUME THAT TEXT DOES NOT CHANGE WHEN SCROLLED IN THIS SITUATION. NO RE-READ IS REQUIRED UNLESS A NEW SELECTION IS MADE. -NEW QUESTION, ARE THE HIGHLIGHTED SECTION AND THE KEYBOARD BUFFER THE "SAME" THING WHEN WE HAVE SOMETHING HIGHLIGHTED, OR ARE THEY DIFFERENT. CAN THEY MUTATE INDEPEDENTLY OF EACH OTHER, HOW DO WE KNOW ONE OR THE OTHER HAS CHANGED AND WHAT SHOULD WE DO IF SO. MAP THE STATES, SUGGEST OPTIONS. OBSERVER AS IF YOU WERE USE USER TO DEFINE WHAT INTENT SHOULD BE IN EACH SITUATUION. AND WHAT SOLUTION SHOULD BE.



**What changes:** When copying selected text (Ctrl+C), if the selection spans a different scroll position than the current view, copy from `screenLines` only if the selection is visible. If the selection has scrolled off screen, attempt to restore it by scrolling to the selection's position first (or just read from `contentDocument` which shows the current viewport).

**Simplification for initial implementation:** Copy only works when the selection is visible in the current viewport. If the user scrolled away from the selection, Ctrl+C copies nothing (or shows a brief "scroll to selection to copy" message). This avoids the complexity of fetching arbitrary buffer positions from the server.

- [ ] **Step 1: Add visibility check in copy handler**

In the Ctrl+C handler (in the main keydown handler), before calling `getSelectedTextFromSvg`, check if the selection is in the current viewport:

```javascript
  if (e.ctrlKey && e.key.toLowerCase() === 'c' && selStart) {
    const currentOffset = t.scrollOffset || 0;
    const startAbs = (selStart.row || 0) + (selStart.scrollOffset || 0);
    const endAbs = (selEnd.row || 0) + (selEnd.scrollOffset || 0);
    const startView = startAbs - currentOffset;
    const endView = endAbs - currentOffset;
    const maxRow = t.screenRows || 24;

    // Only copy if selection is at least partially visible
    if (startView < maxRow && endView >= 0) {
      const text = getSelectedTextFromSvg(t);
      if (text) copyToClipboard(text);
    }
    clearSel();
    return;
  }
```

- [ ] **Step 2: Test**
1. Select text, Ctrl+C → copies (same as before)

2. Select text, scroll away, Ctrl+C → does NOT copy wrong text

3. Select text, scroll away, scroll back, Ctrl+C → copies correctly
- [ ] **Step 3: Commit**

```bash
git add dashboard.mjs
git commit -m "fix: copy only reads selected text when selection is visible in viewport"
```

---

## Pre-Implementation Reflection

**What didn't I mention?**

- The keyboard selection (Shift+Arrow) also stores `selStart`/`selEnd` without scrollOffset. It needs the same treatment. However, keyboard selection is typically done without scrolling, so this is lower priority.
- `getSelectedTextFromSvg` reads text from the SVG `contentDocument` by element ID (`r0`, `r1`, ...). These IDs are viewport-relative. If the selection's absolute rows don't match the current viewport rows, the wrong text is read. The visibility check in Task 4 prevents this — but a future improvement could request specific buffer lines from the server.

**What constraint did I consider too obvious?**

- The `_render` property on `selStart`/`selEnd` (added by `screenToCell`) stores cols/rows at the time of selection. If the terminal resizes between selection and drawing, the highlight could be wrong. This is pre-existing and not addressed here.

**What do I still not fully understand?**

- How `drawSelHighlight` calculates rect positions. I need to read it carefully before modifying the row calculation in Task 3. The plan gives the approach but the exact code depends on the current implementation.
