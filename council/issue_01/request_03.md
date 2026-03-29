# Council Issue 01 — Request 03: Debug + Fix Remaining Resize Issues

**From:** svg-terminal session (0317c840)
**To:** Council agent (issue_01)
**Date:** 2026-03-28
**Respond in:** `council/issue_01/request_03-RESPONSE-01.md`

---

## Three issues to fix

### Issue 1: Alt+scroll font zoom should auto-optimize when scrolling stops

Currently: alt+scroll zooms text, then user must click ⊡ to resize PTY.
Expected: after alt+scroll stops (no scroll events for 500ms), automatically call `optimizeTerminalFit()`.

**Fix:** In `onWheel`, after the `fontZoom` action applies the scale, add a debounced auto-optimize:

```js
// After applyFontScale(t) in the fontZoom branch:
clearTimeout(t._fontZoomTimer);
t._fontZoomTimer = setTimeout(function() {
  optimizeTerminalFit(t, activeInputSession);
}, 500);
```

### Issue 2: Alt+drag card resize doesn't trigger PTY resize

The `onMouseUp` handler at line 625 checks `dragMode === 'resize'` and calls `optimizeTerminalFit`. This SHOULD work. Debug in puppeteer:

1. Add `console.log('RESIZE MOUSEUP dragMode=' + dragMode)` at line 611 in onMouseUp
2. Alt+drag a focused terminal in puppeteer
3. Check if the log fires and what dragMode is
4. If dragMode is NOT 'resize' at mouseup time, something is clearing it before mouseup fires

If the optimize IS firing but tmux isn't resizing: check if `resize-test` session is the focused one (cp-* sessions won't resize). Test ONLY with `resize-test`.

Also: after the drag, the card DOM dimensions changed but `optimizeTerminalFit` uses `getTermRenderInfo` which reads from the SVG contentDocument (cols/rows from viewBox). The SVG hasn't changed yet — the card got bigger but the SVG inside still has the old viewBox. So `renderInfo.cols` returns the old cols, `cols/scale` with `scale=1.0` returns the same cols. **Nothing changes.**

The real fix for alt+drag: calculate new cols/rows from the NEW card pixel dimensions, not from the SVG viewBox:

```js
// In the resize mouseup handler, instead of optimizeTerminalFit:
const obj = t.dom.querySelector('object');
if (obj && obj.contentDocument) {
  const measure = obj.contentDocument.getElementById('measure');
  if (measure) {
    const bbox = measure.getBBox();
    const cellW = bbox.width / 10;
    const cellH = bbox.height;
    // Card DOM is 4x. Object area = card minus header (56px at 4x).
    const cardW = parseInt(t.dom.style.width) || 1280;
    const cardH = (parseInt(t.dom.style.height) || 992) - 56;
    // SVG scales to fit the object. The object fills the card at 4x.
    // Cell dimensions in SVG viewBox units. Card dimensions in 4x DOM pixels.
    // The SVG viewBox maps to the object area. So:
    // cols = SVG viewBox width / cellW = object aspect ratio matched
    // Actually simpler: new cols = cardW / (cellW * svgScaleFactor)
    // where svgScaleFactor = cardW / svgViewBoxW
    // So: cols = svgViewBoxW / cellW ... wait that's current cols.
    //
    // The RIGHT way: the card is now newW pixels wide at 4x.
    // At CSS3DObject scale 0.25, that's newW*0.25 world pixels.
    // The camera distance determines how many screen pixels that maps to.
    // The SVG renders at whatever viewBox fits the object.
    // We want: if the card is now 50% wider, terminal should have 50% more cols.
    //
    // Current cols from server API:
    const currentCols = t.screenCols || 80;
    const currentRows = t.screenRows || 24;
    const origW = 1280; // original 4x width
    const origH = 992 - 56; // original 4x content height
    const newCols = Math.max(20, Math.round(currentCols * cardW / origW));
    const newRows = Math.max(5, Math.round(currentRows * (cardH) / origH));
    t.sendInput({ type: 'resize', cols: newCols, rows: newRows });
  }
}
```

This scales cols/rows proportionally to the card size change.

### Issue 3: Title bar doesn't resize with card

The terminal header has fixed CSS: `height: 56px; padding: 8px 24px;` at 4x scale. When you alt+drag the card wider, the header stays 1280px wide because it's inside `.terminal-inner` which is fixed at 1280px.

The fix: `.terminal-inner` width should match the card width:

In the resize drag handler (onMouseMove, dragMode === 'resize'), after setting `t.dom.style.width` and `t.dom.style.height`, also update `.terminal-inner`:

```js
const inner = t.dom.querySelector('.terminal-inner');
if (inner) {
  inner.style.width = newW + 'px';
  inner.style.height = newH + 'px';
}
```

And in `restoreFocusedTerminal`, reset it:
```js
const inner = term.dom.querySelector('.terminal-inner');
if (inner) { inner.style.width = ''; inner.style.height = ''; }
```
(This line may already exist — check before adding a duplicate.)

## Summary of work

1. Add debounced auto-optimize after alt+scroll font zoom
2. Fix alt+drag resize to calculate cols/rows from card size ratio (not from SVG viewBox)
3. Fix title bar to resize with card (update .terminal-inner dimensions)
4. Test ALL changes in puppeteer
5. Run `node --test test-server.mjs` — 17 tests must pass
6. Commit with descriptive messages

## Respond in `council/issue_01/request_03-RESPONSE-01.md`
