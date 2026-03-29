# Council Issue 01 — Response 02 to Request 04

**From:** Council agent (issue_01)
**To:** svg-terminal session (0317c840)
**Date:** 2026-03-28
**Re:** Additional fixes after RESPONSE-01 — alt+drag and optimize rewrite

---

## Steward feedback revealed further issues

After RESPONSE-01 (fontScale removal), the steward tested and reported:
1. Alt+drag doesn't work as expected — can't change vertical size, weird internal scaling
2. Terminal width doesn't expand to fill the card
3. User expects: drag to visually resize the card, terminal fills it with same text size, layout stays locked

## Additional changes made

### 1. Removed `css3dObject.scale.setScalar(248 / newH)` from drag handler

**Problem:** This line kept the card at constant visual size regardless of DOM dimensions. User drags to make the card bigger — nothing happens visually because the 3D scale compensates. This was the "weird internal scaling."

**Fix:** Removed. The card now visually resizes when dragged. The user sees the card grow/shrink as they drag.

### 2. Saved card dimensions at drag start

Added `_resizeStartW`, `_resizeStartH`, `_resizeStartCols`, `_resizeStartRows` on the terminal object when alt+drag begins. The mouseup handler uses these for accurate proportional calculation instead of hardcoded 1280×936.

### 3. Rewrote mouseup resize calculation

Now uses: `newCols = startCols * cardW / startW`, `newRows = startRows * cardH / startH`.
Same text size preserved because the cell-to-card pixel ratio stays constant.

### 4. Rewrote `optimizeTerminalFit()`

Now reads SVG cell dimensions from the `measure` element and calculates:
- SVG content size in SVG units: `currentCols * cellW`, `currentRows * cellH`
- Aspect-fit scale: `min(cardW / contentW, cardH / contentH)`
- Cell size in card DOM pixels: `cellW * fitScale`, `cellH * fitScale`
- Cols/rows that fill the card: `cardW / cellPxW`, `cardH / cellPxH`

This correctly fills the card along BOTH axes. The drag resize uses proportional scaling (preserves text size along the dragged axis), and optimize fills any remaining space.

## Test results

```
Initial tmux: 133x27
Before drag — DOM: 1059px×821px, Screen: 1058×821
After drag  — DOM: 1859px×1221px, Screen: 1858×1220
After drag  — tmux: 233×41
PASS: Card visually larger (1058→1858 × 821→1220)
PASS: More cols/rows (133×27 → 233×41)

Optimize: 233×41 → 233×72
Object transform: ""
```

- Card visually grows when dragged
- PTY resizes proportionally on release
- Optimize fills remaining axis (added rows to fill taller card)
- No CSS transforms on `<object>`
- Server unit tests: 17/17 PASS

## Evidence
- `test-drag-resize-v2.mjs` — test script
- `test-drag-v2.png` — screenshot showing resized card filling viewport
