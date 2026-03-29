# Council Issue 01 — Response to Request 04

**From:** Council agent (issue_01)
**To:** svg-terminal session (0317c840)
**Date:** 2026-03-28
**Re:** request_04.md — COURSE CORRECTION: No CSS font scaling

---

## Done. All CSS fontScale removed. Everything goes through tmux resize.

### Changes made:

**1. Deleted `applyFontScale()`** — function removed entirely.

**2. Deleted all `fontScale` references:**
- Removed `fontScale: 1.0` from terminal object creation in `addTerminal()`
- Removed `term.fontScale = 1.0` from `restoreFocusedTerminal()`
- Removed `_fontZoomTimer` debounce logic

**3. Rewrote alt+scroll (`fontZoom` action in onWheel):**
```js
const step = delta > 0 ? 2 : -2;
const newCols = Math.max(20, Math.min(300, (t.screenCols || 80) + step));
const newRows = Math.max(5, Math.min(100, (t.screenRows || 24) + Math.round(step / 2)));
t.sendInput({ type: 'resize', cols: newCols, rows: newRows });
```
Scroll up = fewer cols (bigger text). Scroll down = more cols (smaller text). Direct tmux resize, no debounce.

**4. Rewrote +/− button handlers:**
- `+` button: `cols - 4, rows - 2` (bigger text = fewer chars)
- `−` button: `cols + 4, rows + 2` (smaller text = more chars)

**5. Alt+drag mouseup:** Kept the proportional resize from request_03 (unchanged).

**6. Rewrote `optimizeTerminalFit()`:** Now reads SVG cell dimensions from the `measure` element, calculates cols/rows from card DOM size and cell pixel size. No fontScale involved.

**7. No CSS transform on `<object>`:** Verified — transform is empty after all operations.

---

## Puppeteer results: 7/7 PASS

```
Initial: 38x32
PASS: Alt+scroll UP (zoom in) — 38x32 → 32x29
PASS: Alt+scroll DOWN (zoom out) — 32x29 → 44x35
PASS: No CSS transform on <object> — transform=""
PASS: + button (bigger text) — 44x35 → 40x33
PASS: − button (smaller text) — 40x33 → 44x35
PASS: Alt+drag resize — 44x35 → 57x41
PASS: ⊡ Optimize — 57x41 → 124x41
```

All size changes verified via `tmux display-message` — real PTY dimensions, not DOM inspection.

## Server unit tests: 17/17 PASS

## Evidence:
- `test-request04.mjs` — puppeteer test script
- `test-request04.png` — screenshot

## Note on optimize result

`⊡ Optimize` went from 57x41 → 124x41. The cols tripled because the card was wider from the alt+drag test. Rows stayed at 41 (card height similar). This is correct — optimize fills the card at whatever size it currently is.

## Ready to commit on your approval.
