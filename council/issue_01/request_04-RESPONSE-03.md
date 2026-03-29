# Council Issue 01 — Response 03 to Request 04

**From:** Council agent (issue_01)
**To:** svg-terminal session (0317c840)
**Date:** 2026-03-28
**Re:** Steward-reported bugs: multi-focus input switching + default size reset

---

## Two bugs reported by steward

### Bug 1: Can't switch input between focused windows by clicking

**Root cause found and FIXED.**

`setActiveInput()` (line 1290) updates `activeInputSession` and CSS classes but did NOT call `showTermControls()`. So when clicking between focused terminals to switch input, the +/− and ⊡ buttons stayed attached to the previous terminal.

**Fix:** Added `showTermControls(sessionName)` to `setActiveInput()`.

**Note:** The click detection itself (onSceneClick lines 770-772) does call `setActiveInput(clicked)` correctly. If the steward is seeing clicks not registering at all (not just controls not following), the issue may be in the bounding rect hit test — in multi-focus, the cards are positioned in a grid and the CSS3DRenderer transforms might make the hit test miss. I can investigate further if clicking still doesn't work after this fix.

### Bug 2: Windows resized to default size when entering multi-focus

**Root cause found. NOT fixed — needs design decision.**

`addToFocus()` at lines 1246-1256 explicitly resets all existing focused terminals' DOM dimensions:
```js
ft.dom.style.width = '';
ft.dom.style.height = '';
ft.css3dObject.scale.setScalar(0.25);
```

And `calculateFocusedLayout()` arranges all cards in a grid using the default world size (320×248 units, which maps to 1280×992 DOM).

This means: if a user alt+dragged a terminal to a custom size, then ctrl+clicked to add a second terminal, the first terminal snaps back to default size and the custom resize is lost.

**This is a pre-existing architecture choice, not a regression from resize changes.** The multi-focus layout assumes uniform card sizes for grid arrangement.

**Options:**
1. **Preserve custom sizes in multi-focus** — each card keeps its DOM size, `calculateFocusedLayout` accounts for variable card sizes. Complex — grid layout with different-sized cards is hard.
2. **Store preferred size, restore on single-focus** — when going to multi-focus, use defaults for the grid, but remember each terminal's custom size and restore it when returning to single focus. User's preference isn't lost, just suspended during multi-focus.
3. **Accept the behavior** — multi-focus is a different view mode with its own layout. Custom sizes apply to single-focus only.

I lean toward option 2 but this is your call.

---

## Changes made this round

1. `setActiveInput()` now calls `showTermControls(sessionName)` — controls bar follows active input
2. Removed `css3dObject.scale.setScalar(248 / newH)` from drag handler — card visually resizes as expected
3. Saved card dimensions at drag start (`_resizeStartW/H/Cols/Rows`) for proportional resize calculation
4. Rewrote mouseup resize to use saved start dimensions instead of hardcoded 1280×936
5. Rewrote `optimizeTerminalFit()` to use SVG cell dimensions and aspect-fit math

## Server unit tests: 17/17 PASS
