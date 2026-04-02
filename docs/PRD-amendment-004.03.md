# PRD Amendment 004 — Card-to-SVG Sizing: Root Cause, Fix, and UI Improvements

**Date:** 2026-04-02
**Status:** Implemented (testing)
**Relates to:** PRD §5 (Card Sizing), §2.1 (Rendering Pipeline), §2.2 (4x Scale Trick), §4.2 (Card Manipulation)
**Discovered during:** Layout system design session (SESSION-001)
**Preceding:** PRD-amendment-004.02.md
**Changes from .02:** Moved from investigation to implementation. Documented the fix, additional UI improvements (directional resize, aspect-preserving +/-, anchor pinning). Removed options section — Option D implemented.

---

## 1. Problems Found

### 1.1 Letterbox Gap and Clipping

Terminal cards had a visible gap between SVG terminal content and card edge. At high column counts (200+), content was clipped instead. The gap was constant regardless of column count, suggesting a fixed offset rather than cumulative error.

### 1.2 Blurry Text

Cards intermittently rendered with blurry text. Pressing +/− (triggering card DOM resize and Chrome re-rasterization) made text crisp. The blur was caused by the card DOM dimensions not aligning with the SVG content, leading to sub-optimal rasterization under the 4x scale trick.

### 1.3 Cursor Drift on Right Side

The cursor position drifted from text on long lines, worse on the right side. Caused by the SVG being non-uniformly scaled to fit a card whose aspect didn't match the viewBox aspect.

### 1.4 +/− Aspect Drift

Repeated +/− presses caused the card to progressively letterbox. The +4 cols / +2 rows increments didn't preserve aspect ratio — integer rounding accumulated.

### 1.5 Card Bounce on +/−

Pressing +/− caused the card to jump/bounce because `calculateFocusedLayout` re-ran after each resize, repositioning the card in the viewport.

### 1.6 Alt+Drag Resize UX

Alt+drag resize was center-anchored (all edges moved), felt uncontrollable (4x scaling mismatch), and didn't support directional resize from specific edges.

---

## 2. Root Cause

All sizing symptoms traced to one fundamental issue: **the card DOM and SVG content were sized using different cell dimension values.**

### The Mismatch

| Component | Cell Width Source | Value |
|---|---|---|
| `calcCardSize()` (dashboard.mjs) | Hardcoded `SVG_CELL_W` | 8.65 |
| SVG viewBox (terminal.svg) | Runtime `getBBox()` | ~8.61 |
| SVG viewBox fallback (terminal.svg) | Hardcoded | 8.4 |

The SVG sets `preserveAspectRatio` to the default (`xMidYMid meet`) — it preserves its viewBox aspect and letterboxes inside the card rather than stretching. The aspect mismatch between card (computed from 8.65) and SVG (measured at ~8.61) produced the gap.

### First-Principles Diagnosis

The font is fixed. The cell size is a physical property of that font. There should be **one source of truth**: the runtime measurement. Every component that needs cell dimensions should read from that single measurement. The hardcoded constants were a workaround for a timing problem (card created before SVG measures its font), not a design decision.

---

## 3. Fix Implemented

### 3.1 Measured Cell Dimensions Flow (Note 12 in dashboard.mjs header)

New function `getMeasuredCellSize(t)` reads actual cell dimensions from a terminal's SVG `<object>` via `getBBox()` on the measure element.

**Sizing flow after fix:**

1. `addTerminal`: card sized with hardcoded constants (approximate), `_needsMeasuredCorrection = true`
2. SVG `<object>` loads: after 100ms delay (font rendering time), card corrected using measured values
3. First `screen` message: `updateCardForNewSize` runs, `_needsMeasuredCorrection` allows it through even if cols/rows unchanged, applies measured correction, clears flag
4. All subsequent resizes: `updateCardForNewSize`, `optimizeCardToTerm`, `optimizeTermToCard`, `calculateFocusedLayout` all use measured values via `getMeasuredCellSize()` when available, falling back to hardcoded constants only when SVG hasn't loaded yet

**`calcCardSize(cols, rows, cellW, cellH)`** now accepts optional measured cell dimensions. When provided, card aspect matches SVG viewBox exactly.

### 3.2 Flags on Terminal Object

| Flag | Set By | Cleared By | Purpose |
|---|---|---|---|
| `_needsMeasuredCorrection` | `addTerminal` | `updateCardForNewSize` (after measured values applied) | Allows correction pass even when cols/rows haven't changed |
| `_lockCardSize` | `optimizeTermToCard` (⊡) | `updateCardForNewSize` (one-shot) | Prevents card recalculation when user's card size is the authority |
| `_suppressRelayout` | +/− buttons | `_screenCallback` (one-shot) | Prevents re-layout after +/− so header/buttons don't jump |
| `_resizeAnchorFx/Fy` | +/− click, alt+drag | `updateCardForNewSize` (after use) | Fraction (0-1) of card where user clicked — pins that point during resize |
| `_origColRowRatio` | First +/− press, alt+drag, ⊡, ⊞ | Never (overwritten) | Preserved col/row ratio for aspect-stable +/− scaling |
| `_resizeEdge` | Alt+drag mousedown | Never (overwritten per drag) | Which edge/corner was grabbed: `{ left, right, top, bottom }` |

### 3.3 +/− Aspect Preservation

Previously: +4 cols, +2 rows (fixed increments, aspect drifts with each press).

Now: `_origColRowRatio` captures the col/row ratio on first +/− press (or after drag/optimize). Subsequent presses compute: `newRows = round(newCols / _origColRowRatio)`. Rounding error stays bounded (±0.5 row) instead of accumulating.

The ratio is reset by:
- Alt+drag card resize (user's new shape intent)
- Fit-terminal-to-card (⊡)
- Fit-card-to-terminal (⊞)

### 3.4 +/− Suppress Re-layout

`_suppressRelayout` flag set on +/− press, checked in `_screenCallback` where re-layout would normally trigger. One-shot: cleared after use, so external resizes still trigger re-layout.

### 3.5 +/− Anchor Pinning

On +/− click, the click position is captured as a fraction of the card (`_resizeAnchorFx/Fy`). When `updateCardForNewSize` resizes the card, it shifts the 3D position so the clicked point stays fixed on screen:

```
shift_x = -(anchor_fx - 0.5) * size_change_world
shift_y = +(anchor_fy - 0.5) * size_change_world  // Y inverted
```

At center (0.5), no shift. At right edge (1.0), card shifts left by half the width change. ~2-3px residual drift from integer rounding in `calcCardSize`.

### 3.6 Directional Alt+Drag Resize (Note 13 in dashboard.mjs header)

On alt+drag mousedown, the cursor position within the card determines which edge/corner was grabbed (5% edge zone from each side — planned, currently 20% until hover-to-activate is built). Only the grabbed edges move; opposite edges stay anchored by shifting the card's 3D position by half the size change.

Scale factor is now dynamic: `DOM_width / screen_bounding_rect_width`. This adapts to the card's apparent size at any Z-depth, so mouse movement tracks 1:1 regardless of camera distance.

### 3.7 Fit-Terminal-to-Card (⊡) Fix

Previously: used `min(scaleW, scaleH)` which only filled the smaller dimension, leaving letterbox on the other.

Now: computes cols and rows independently to fill both dimensions: `newCols = round(cardW / cellW)`, `newRows = round(cardH / cellH)`. Sets `_lockCardSize` flag so the subsequent `updateCardForNewSize` doesn't recalculate the card — the user's card size is the authority.

### 3.8 Fit-Card-to-Terminal (⊞) Fix

Now uses measured cell dimensions via `getMeasuredCellSize()` instead of hardcoded constants. Resets `_origColRowRatio` so subsequent +/− preserves the new shape.

---

## 4. What SVG_CELL_W / SVG_CELL_H Are Now

The hardcoded constants `SVG_CELL_W = 8.65` and `SVG_CELL_H = 17` remain in the code as **fallbacks only**. They are used when:
- The SVG `<object>` hasn't loaded yet (initial card creation)
- `getMeasuredCellSize()` returns null (SVG document not accessible)

All sizing paths prefer measured values. The constants no longer determine the card's final dimensions for any terminal that has loaded and measured its font.

---

## 5. Remaining Issues

1. **+/− anchor drift:** ~2-3px residual drift per press from integer rounding in `calcCardSize`. Acceptable but not perfect.
2. **Edge zone for directional resize:** Currently 20%, planned to move to 5% with hover-to-activate visual handles (diagonal stripe animation on edge, appears after 1s hover).
3. **Large col/row → small col/row aspect drift:** Going from very small to very large terminals via repeated +/− still shows some aspect deterioration. The `_origColRowRatio` helps but integer rounding over large ranges accumulates.
4. **`preserveAspectRatio` not explicitly set:** SVG still relies on the default (`xMidYMid meet`). Should be explicitly set to document the expected behavior.

---

## 6. Planned: Hover-to-Activate Resize Handles

Not yet implemented. Design:
1. Mouse within 5% of card edge while focused
2. After 1 second hover, visual handle appears: ~10px extension outside the card on active edge(s)
3. Diagonal stripe animation (dark gray/black, subtle)
4. Corner: both adjacent edges extend
5. Click+drag in activated zone = resize from that edge/corner (replaces alt+drag for that interaction)
6. Mouse leaves edge zone → handle fades
7. Alt+drag remains as power-user fallback

---

## 7. Files Modified

| File | Changes |
|---|---|
| `dashboard.mjs` | `calcCardSize` accepts measured values; `getMeasuredCellSize` helper; `updateCardForNewSize` uses measured values + anchor pinning + lock/suppress flags; `optimizeTermToCard` fills both dimensions + lock; `optimizeCardToTerm` uses measured values; +/− preserves aspect ratio + anchor pinning + suppress relayout; alt+drag directional resize with edge detection + dynamic scale factor + 3D position anchoring; SVG load handler corrects card size; header comment notes 12-14 |
| `terminal.svg` | No functional changes (debug rect added and removed) |
| `dashboard.css` | No functional changes (debug borders added and removed) |
