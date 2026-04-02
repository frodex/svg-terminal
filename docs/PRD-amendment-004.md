# PRD Amendment 004 — Card-to-SVG Aspect Mismatch and Letterbox Gap

**Date:** 2026-04-01
**Status:** Investigation
**Relates to:** PRD §5 (Card Sizing), §2.1 (Rendering Pipeline)
**Discovered during:** Layout system design session (SESSION-001)

---

## 1. Problem

Terminal cards exhibit a visible gap (letterbox) between the SVG terminal content and the card edge. The gap appears on the right side and/or bottom of the card depending on terminal dimensions. At high column counts (200+), the terminal content can appear **clipped** instead of gapped.

### Evidence

Checkerboard alignment tests across 6 terminal sizes (20×8 through 200×60) show:
- At standard sizes (80×24): ~2-3px gap on right edge, constant regardless of column count
- At high column counts (200×60): content clips on right edge
- Gap size appears roughly constant across different column counts at similar aspect ratios

---

## 2. Root Cause

### 2.1 Two Different Cell Width Values

The card's DOM dimensions and the SVG's viewBox are computed using **different cell width values**:

| Component | Cell Width Source | Value | Used For |
|---|---|---|---|
| `calcCardSize()` in dashboard.mjs | Hardcoded constant `SVG_CELL_W` | 8.65 | Card DOM width = f(cols × 8.65) |
| SVG viewBox in terminal-renderer.mjs | Runtime `measureFont()` via `getBBox()` | ~8.61 (varies) | viewBox width = cols × measuredCellW |

The constant `SVG_CELL_W = 8.65` is larger than the typical runtime-measured value (~8.61). This means the card is proportionally wider than the SVG content.

### 2.2 SVG preserveAspectRatio

The SVG root element in both `terminal.svg` and the inline renderer (`terminal-renderer.mjs`) has **no explicit `preserveAspectRatio` attribute**. The SVG default is `xMidYMid meet` — the SVG preserves its viewBox aspect ratio, fits within the container, and centers the content.

The SVG does **not** stretch to fill the card. It letterboxes.

### 2.3 The Mismatch Chain

```
1. calcCardSize(80, 24):
   termAspect = (80 × 8.65) / (24 × 17) = 692 / 408 = 1.696
   → card DOM sized with this aspect

2. SVG viewBox (measured at runtime):
   viewBox width = 80 × 8.61 = 688.8
   viewBox height = 24 × 17.0 = 408
   viewBox aspect = 688.8 / 408 = 1.688

3. Card content area (cardW × (cardH - HEADER_H)):
   aspect = 1.696 (from step 1, using 8.65)

4. SVG fits inside card with preserveAspectRatio="xMidYMid meet":
   SVG aspect (1.688) < card aspect (1.696)
   → SVG fills full height, letterboxes horizontally
   → Gap on right side = card is slightly too wide for SVG content
```

At 200 columns: `200 × (8.65 - 8.61) = 8px` of aspect mismatch. Whether this manifests as gap or clip depends on which dimension is the limiting one for that terminal's proportions.

### 2.4 Runtime Measurement Variation

`measureFont()` returns slightly different values depending on terminal size:

| Terminal | measuredCellW | measuredCellH |
|---|---|---|
| 20×8 (minimal) | 8.6135 | 16.9973 |
| 80×24 (standard) | 8.6089 | 17.1772 |
| 200×60 (wide-hi) | 8.6145 | 17.1945 |
| 30×50 (tall-lo) | 8.6135 | 16.9973 |

The width varies by ~0.005 across sizes. The height varies by ~0.2 — significantly more. These variations are likely sub-pixel rounding artifacts from `getBBox()` at different viewBox scales, not actual font differences (the font is fixed, embedded, and monospace).

---

## 3. Current Sizing Flow

### 3.1 Card Creation (`addTerminal` → `calcCardSize`)

```
calcCardSize(cols, rows):
  termAspect = (cols × SVG_CELL_W) / (rows × SVG_CELL_H)   // uses 8.65, 17
  worldW = sqrt(TARGET_WORLD_AREA × termAspect)
  worldH = TARGET_WORLD_AREA / worldW
  cardW = round(worldW × 4)                                  // 4x scale trick
  cardH = round(worldH × 4) + HEADER_H                      // + 72px header
  clamp to [640..3200] × [496..2400]
```

### 3.2 SVG ViewBox (`terminal-renderer.mjs` → `initLayout`)

```
initLayout(cols, rows):
  viewBox = "0 0 " + (cols × measuredCellW) + " " + (rows × measuredCellH)
  // measuredCellW ≈ 8.61, measuredCellH ≈ 17.0 (from measureFont getBBox)
```

### 3.3 SVG in Card DOM

```html
<div class="terminal-3d" style="width:{cardW}px; height:{cardH}px">
  <div class="terminal-inner" style="width:100%; height:100%; flex-column">
    <header style="height:56px; padding:8px 24px">...</header>
    <object style="width:100%; flex:1; min-height:0">
      <!-- SVG with viewBox aspect ≠ card content aspect -->
      <!-- preserveAspectRatio defaults to xMidYMid meet -->
      <!-- SVG letterboxes inside the object element -->
    </object>
  </div>
</div>
```

### 3.4 Fit Terminal to Card (`optimizeTermToCard` — ⊡ button)

```
optimizeTermToCard(t):
  cardW = current card DOM width
  cardH = current card DOM height - HEADER_H
  cellW = measureFont getBBox width / 10          // runtime measured
  cellH = measureFont getBBox height               // runtime measured
  scaleW = cardW / (cols × cellW)
  scaleH = cardH / (rows × cellH)
  fitScale = min(scaleW, scaleH)
  newCols = round(cardW / (cellW × fitScale))
  newRows = round(cardH / (cellH × fitScale))
  → sends resize to tmux
```

This function uses **runtime-measured** cell dimensions, not the hardcoded constants. After optimization, the terminal cols/rows match the card size based on actual font metrics. But the card itself was sized using `SVG_CELL_W = 8.65`, so the card is still proportionally wrong for the new terminal. The viewBox updates to match the new cols/rows with measured values, and the mismatch persists.

### 3.5 Fit Card to Terminal (`optimizeCardToTerm` — ⊞ button)

```
optimizeCardToTerm(t):
  → calls calcCardSize(currentCols, currentRows)
  → sets card DOM to result
```

This recalculates the card from the hardcoded constants. It reintroduces the same aspect mismatch because `calcCardSize` uses `SVG_CELL_W = 8.65` while the SVG viewBox uses `measuredCellW ≈ 8.61`.

---

## 4. Why Selection Alignment Still Works

Despite the letterbox gap, text selection aligns correctly because `screenToCell()` maps coordinates through the SVG's **actual rendered bounding rect and viewBox**, not through the card dimensions or hardcoded constants:

```
screenToCell(e, t):
  fracX = (clientX - objRect.left) / objRect.width    // fraction within SVG's rendered rect
  fracY = (clientY - objRect.top) / objRect.height
  svgX = fracX × viewBoxWidth                          // map to viewBox coords
  svgY = fracY × viewBoxHeight
  cellH = r1.y - r0.y                                  // from actual SVG element positions
  cellW = viewBoxWidth / cols
  row = floor(svgY / cellH)
  col = floor(svgX / cellW)
```

The letterbox gap is **outside** the SVG's bounding rect, so clicks in the gap don't map to any cell. The coordinate mapping within the SVG is accurate because it reads from the SVG DOM, not from constants.

---

## 5. Options

### Option A: Use Runtime-Measured Values in calcCardSize

Replace `SVG_CELL_W`/`SVG_CELL_H` with values read from the terminal renderer's `measureFont()` result after font load. This eliminates the source of mismatch.

**Challenge:** `calcCardSize` is called during `addTerminal` before the SVG `<object>` has loaded and measured its font. The measured values aren't available yet. Would need a deferred resize after font measurement completes.

### Option B: Set preserveAspectRatio="none" on SVG

Force the SVG to stretch-fill the card container, eliminating the letterbox. 

**Risk:** Distorts character proportions if the aspect mismatch is significant. Characters would appear slightly wider or narrower than natural. May affect selection alignment since the coordinate mapping assumes uniform scaling.

### Option C: Recalculate Card Size After Font Measurement

After `measureFont()` fires (on `document.fonts.ready` or WebSocket open), recalculate card dimensions using the actual measured values. This is a deferred correction — card starts at approximate size, then snaps to exact size.

**Risk:** Visible card resize after initial render. Could be mitigated by delaying card visibility until measurement completes.

### Option D: Make calcCardSize Read from Renderer API

Add a `getCellSize()` API to the terminal renderer. `calcCardSize` calls it when available, falls back to constants when not yet measured. Combined with Option C for the initial load case.

### Option E: Accept the Gap

The gap is 2-3px at typical terminal sizes. It's cosmetic. Document it and move on. Only matters for the layout system if "maximize card to slot" needs pixel-perfect fills.

---

## 6. Recommendation

[UNVERIFIED — needs discussion with user]

Option D + C appears cleanest: renderer exposes measured cell size, card sizing uses it, deferred correction handles the initial load race. But this needs validation against the font loading timeline and whether the card resize flash is acceptable.

For the layout system, this matters because "maximize card→slot" (letterbox mode) will inherit whatever gap exists between card and SVG. If the gap is unacceptable at larger layout slot sizes, it needs to be fixed first.

---

## 7. Open Questions

1. Is the 2-3px gap at standard sizes actually bothering users, or is this only visible with the debug background color (`#2e2e32` vs production `#1c1c1e`)?
2. At production background color, would the gap be invisible (SVG background matches card background)?
3. Does `optimizeTermToCard` (⊡) reduce the gap by re-fitting with measured values, or does it just shift the mismatch to a different dimension?
4. Should `preserveAspectRatio` be explicitly set to a known value rather than relying on the default?
