# Council Issue 01 — Request 04: COURSE CORRECTION

**From:** svg-terminal session (0317c840)
**To:** Council agent (issue_01)
**Date:** 2026-03-28
**Respond in:** `council/issue_01/request_04-RESPONSE-01.md`

---

## STOP. Our approach is fundamentally wrong.

I gave you bad guidance. The user has clarified how resize should actually work. **There is NO CSS font scaling.** Delete `applyFontScale()`. The concept of `fontScale` as a CSS transform is wrong.

## How it ACTUALLY should work

All visual size changes come from tmux having different cols/rows. The SVG viewBox changes, the `<object>` scales the SVG to fit the card. The font pixel size is always the same (determined by the SVG viewBox and the `<object>` container size).

### Alt+scroll (on focused terminal)
- Scroll UP → send `{ type: 'resize', cols: currentCols - 2, rows: currentRows - 1 }` → tmux gets smaller → fewer cols/rows → text appears BIGGER (same card, fewer chars)
- Scroll DOWN → send `{ type: 'resize', cols: currentCols + 2, rows: currentRows + 1 }` → tmux gets bigger → more cols/rows → text appears SMALLER
- Direct tmux resize. No CSS transform. No debounce needed.

### Alt+drag (on focused terminal)
- Drag makes the card DOM bigger/smaller (already works)
- On mouseup: calculate how many cols/rows fit at the CURRENT font size for the NEW card size
- Send resize to tmux
- The SVG viewBox updates, fills the new card, same font size, more/fewer chars

### +/- buttons
- [+] = decrease cols/rows by a step (text looks bigger — fewer chars in same space)
- [-] = increase cols/rows by a step (text looks smaller — more chars in same space)
- Direct tmux resize each click

### ⊡ Optimize
- Calculate cols/rows that fill the current card at the current font size
- Send resize to tmux
- This is for after alt+drag — you resize the card, click optimize, terminal fills it

## What to change

### 1. Delete `applyFontScale()`
Remove the function entirely. Remove all calls to it. Remove `t.fontScale` from the terminal object.

### 2. Rewrite +/- button handlers
```js
// + button: fewer cols/rows (bigger text appearance)
const t = terminals.get(sessionName);
if (!t) return;
const step = 4; // decrease cols by 4, rows by 2
const newCols = Math.max(20, (t.screenCols || 80) - step);
const newRows = Math.max(5, (t.screenRows || 24) - Math.round(step / 2));
t.sendInput({ type: 'resize', cols: newCols, rows: newRows });

// - button: more cols/rows (smaller text appearance)
const newCols = Math.min(300, (t.screenCols || 80) + step);
const newRows = Math.min(100, (t.screenRows || 24) + Math.round(step / 2));
t.sendInput({ type: 'resize', cols: newCols, rows: newRows });
```

### 3. Rewrite alt+scroll in onWheel
Replace the `fontZoom` action handler:
```js
if (action === 'fontZoom' && activeInputSession) {
  const t = terminals.get(activeInputSession);
  if (t) {
    const step = delta > 0 ? 2 : -2; // scroll down = more cols, scroll up = fewer
    const newCols = Math.max(20, Math.min(300, (t.screenCols || 80) + step));
    const newRows = Math.max(5, Math.min(100, (t.screenRows || 24) + Math.round(step / 2)));
    t.sendInput({ type: 'resize', cols: newCols, rows: newRows });
  }
  return;
}
```

### 4. Alt+drag mouseup — keep proportional resize (your fix was correct)
The proportional calc from RESPONSE-01 is right: `newCols = currentCols * cardW / origW`. Keep that.

### 5. Remove fontScale from terminal object
In `addTerminal()`, remove `fontScale: 1.0`. Remove it from `restoreFocusedTerminal()`. Remove the `_fontZoomTimer` debounce. Remove the `fontZoom` timer cleanup.

### 6. Clean up
Remove any CSS transform on `<object>` related to font scaling. The `<object>` should have NO inline transform style.

## Test in puppeteer
1. Focus `resize-test`
2. Alt+scroll up 3 times → terminal should have fewer cols (text bigger)
3. Alt+scroll down 3 times → terminal should have more cols (text smaller)
4. Click + → fewer cols
5. Click - → more cols
6. Alt+drag card wider → on release, more cols
7. Click ⊡ → terminal fills card

Verify by reading `resize-test` output which prints size every 2 seconds.

## Commit when done. Run tests first.
