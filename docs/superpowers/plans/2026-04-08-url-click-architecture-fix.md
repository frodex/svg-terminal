# URL Click Architecture Fix — Implementation Plan

> **For the next agent:** This plan has full code references and line numbers verified against the current codebase as of commit e7ac8cc.

**Goal:** Fix URL click detection so clicks only trigger links when clicking actual URL text, not empty space on the same row or adjacent rows. Fix broken multi-line URL underlines.

**Bug report:** wiki.droidware.ai/projects/default/pages/bug-report-for-svg-terminal-url-decoder-clicks-on-card-send-link-when-they-shouldnt

---

## Problem Summary

1. **Clicking below a URL triggers the link** — `screenToCell` maps clicks on the row below a URL to the URL's row (letterbox/boundary rounding). When the URL fills the entire row width, any click on that row activates the link.

2. **Multi-line URL underlines may be broken** — the blue underline that shows where URLs are may not render correctly after recent changes to CELL_W measurement (10→100 char probe).

3. **URLs longer than terminal width overflow the card** — the clickable region extends beyond the visible card boundary.

---

## Current Architecture (What's Wrong)

### Click detection path (dashboard.mjs):
```
onSceneClick (line 3696)
  → screenToCell(e, t) (line 5980) — maps screen pixel to {row, col}
  → getUrlAtCell(t, row, col) (line 3630) — checks if URL exists at that cell
  → addBrowserCard(url) (line 4152) — opens browser card
```

### screenToCell (dashboard.mjs:5980-6017):
- Maps `e.clientX/Y` to SVG viewBox coordinates using letterbox-corrected proportional mapping
- Returns `{row, col}` clamped to `0..rows-1, 0..cols-1`
- **Bug:** Letterbox correction is approximate. At row boundaries, `Math.floor(svgY / cellH)` can return the wrong row.

### getUrlAtCell (dashboard.mjs:3630-3690):
- First checks server-tagged URLs (OSC 8 spans with `.url` property) — line 3636-3644
- Then falls back to client-side regex URL detection on `fullLine` text — line 3648-3690
- Has `col >= fullLine.trimEnd().length` guard (line 3650) but doesn't help when URL IS the full trimmed line
- Multi-line URL detection walks forward from the matched row — line 3657-3680

### URL underline rendering (terminal.svg:273-400):
- `rebuildLinkLayer(lines)` draws `<line>` elements in the SVG for each detected URL
- Multi-line detection at line 296-338: concatenates lines when URL wraps at terminal width
- Single-line detection at line 369-400: checks `span.url` (OSC 8) and `findUrlsInText()` (regex)
- Uses `CELL_W` for x-positioning — this was recently changed from 10-char to 100-char measurement

---

## Proposed Fix

### Approach: Pixel-Bound Clickable Regions

Instead of mapping screen clicks to cell coordinates and checking if a URL is there, **make the URL underline elements themselves clickable**. The underlines already exist at the exact pixel positions of URLs. Add click handlers to them.

### Task 1: Make URL underlines clickable in terminal.svg

**File:** `terminal.svg` — `rebuildLinkLayer()` at line 273

Currently draws `<line>` elements with `data-url` attribute. Change to:
- Make each underline `<line>` (or replace with `<rect>`) have `pointer-events: stroke` (or `all` for rect)
- Add click handler that calls `window._onUrlClick(url, e)` 
- The click area is the exact pixel bounds of the URL text — no cell mapping needed

**For multi-line URLs (line 341-358):**
Each segment already has exact `x1, y1, x2, y2` pixel coordinates. Make each segment clickable.

**For single-line URLs (line 369-400):**
Same — the underline `<line>` already has exact coordinates. Make it clickable.

**Code change in rebuildLinkLayer:**
For each `<line>` or `<rect>` element created:
```javascript
// Replace <line> with <rect> for better click target
var rect = document.createElementNS(SVG_NS, 'rect');
rect.setAttribute('x', (startCol * CELL_W).toFixed(2));
rect.setAttribute('y', (row * CELL_H).toFixed(2));
rect.setAttribute('width', ((endCol - startCol) * CELL_W).toFixed(2));
rect.setAttribute('height', CELL_H.toFixed(2));
rect.setAttribute('fill', 'transparent');
rect.setAttribute('data-url', url);
rect.style.cursor = 'pointer';
rect.style.pointerEvents = 'all';
// Draw underline as a separate visual element
var ul = document.createElementNS(SVG_NS, 'line');
ul.setAttribute('x1', (startCol * CELL_W).toFixed(2));
ul.setAttribute('y1', ((row + 1) * CELL_H - 1).toFixed(2));
ul.setAttribute('x2', (endCol * CELL_W).toFixed(2));
ul.setAttribute('y2', ((row + 1) * CELL_H - 1).toFixed(2));
ul.setAttribute('stroke', '#5c8fff');
ul.setAttribute('stroke-width', '1');
ul.setAttribute('opacity', '0.6');
ul.style.pointerEvents = 'none'; // clicks go to rect, not line
linkLayer.appendChild(rect);
linkLayer.appendChild(ul);
```

### Task 2: Handle URL clicks from SVG in dashboard.mjs

**File:** `dashboard.mjs`

The SVG `<object>` has `pointer-events: none` on the element itself (CSS), so clicks pass through to the 3D scene. URL clicks inside the SVG need a different path.

**Option A:** Use `window._onUrlClick` callback (like `_screenCallback`):
In terminal.svg, when a URL rect is clicked:
```javascript
rect.addEventListener('click', function(ev) {
  ev.stopPropagation();
  if (window.parent && window.parent._onUrlClick) {
    window.parent._onUrlClick(url);
  }
});
```

In dashboard.mjs, register handler:
```javascript
// In addTerminal, after SVG loads:
termObj.contentWindow._onUrlClick = function(url) {
  if (e.altKey) window.open(url, '_blank');
  else addBrowserCard(url);
};
```

**Problem:** The SVG `<object>` has `pointer-events: none` in CSS, so clicks never reach the SVG elements. 

**Option B (recommended):** Keep click detection in dashboard.mjs but use the URL underline pixel bounds instead of cell-based detection.

After `rebuildLinkLayer` runs, the SVG has `<rect>` elements with `data-url` attributes at exact pixel positions. When `screenToCell` is called, ALSO check if the click falls within any URL rect's bounds:

In dashboard.mjs, replace the URL click logic in `onSceneClick` (line 3778-3791):

```javascript
// Instead of getUrlAtCell, check SVG link layer rects directly
var obj = t.dom.querySelector('object');
if (obj && obj.contentDocument) {
  var linkRects = obj.contentDocument.querySelectorAll('[data-url]');
  var objRect = obj.getBoundingClientRect();
  // Convert click to SVG coordinates (same letterbox math as screenToCell)
  // ... compute svgX, svgY ...
  for (var i = 0; i < linkRects.length; i++) {
    var r = linkRects[i];
    var rx = parseFloat(r.getAttribute('x'));
    var ry = parseFloat(r.getAttribute('y'));
    var rw = parseFloat(r.getAttribute('width'));
    var rh = parseFloat(r.getAttribute('height'));
    if (svgX >= rx && svgX <= rx + rw && svgY >= ry && svgY <= ry + rh) {
      var url = r.getAttribute('data-url');
      if (e.altKey || altHeld) window.open(url, '_blank');
      else addBrowserCard(url);
      return;
    }
  }
}
```

### Task 3: Remove getUrlAtCell from click path

**File:** `dashboard.mjs`

- Remove the `getUrlAtCell` call from `onSceneClick` (line 3778-3791)
- Replace with the SVG rect-based detection from Task 2
- Keep `getUrlAtCell` for non-click uses (if any) or remove entirely

### Task 4: Verify multi-line URL underlines

**File:** `terminal.svg` — `rebuildLinkLayer()` line 296-338

- The multi-line URL detection concatenates lines when a URL wraps at terminal width
- Verify this still works correctly with the 100-char CELL_W measurement
- Test with a URL that wraps across 2+ lines
- Check that underline segments appear on each line portion

### Task 5: Prevent URL overflow beyond card width

**File:** `terminal.svg` — `rebuildLinkLayer()`

- URL rects/underlines should be clamped to the viewBox width
- If a URL's `endCol * CELL_W > vbW`, clamp to `vbW`
- This prevents clickable areas from extending beyond the visible card

---

## Key Files and Line Numbers

| File | Function | Line | Purpose |
|------|----------|------|---------|
| `dashboard.mjs` | `onSceneClick` | 3696 | Main click handler — URL detection here |
| `dashboard.mjs` | `getUrlAtCell` | 3630 | Cell-based URL lookup (to be replaced) |
| `dashboard.mjs` | `screenToCell` | 5980 | Screen→cell coordinate mapping |
| `dashboard.mjs` | `addBrowserCard` | 4152 | Opens URL in browser card |
| `terminal.svg` | `rebuildLinkLayer` | 273 | Draws URL underlines in SVG |
| `terminal.svg` | `findUrlsInText` | ~405 | Regex URL detection helper |
| `terminal.svg` | `updateLine` | 192 | Line rendering (tspan positioning) |

## Test Plan

1. Click on a URL in a card → should open browser card
2. Click on empty space on the same row as a URL → should NOT open browser card, should focus card
3. Click on the row below a URL → should NOT open browser card
4. Multi-line URL: underlines appear on all line segments
5. Multi-line URL: clicking any segment opens the correct full URL
6. URL at terminal width boundary: no overflow beyond card edge
7. Drag-to-select still works correctly (screenToCell not broken)

## Wiki Bug Report Reference

Internal: wiki.droidware.ai/projects/default/pages/bug-report-for-svg-terminal-url-decoder-clicks-on-card-send-link-when-they-shouldnt
(Access via 192.168.22.56:8082 internally)

---

## User Note

Drag-to-select uses the same `screenToCell` + character range logic. It works correctly. The difference is selection tolerates ±1 row error (barely visible during drag), URL clicks don't (wrong row = wrong link). If `screenToCell` were pixel-perfect, both would work through the same path. The SVG rect approach bypasses `screenToCell` for URL clicks — a workaround. Consider fixing `screenToCell` row precision as an alternative.
