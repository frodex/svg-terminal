# PRD Amendment 004 — Card-to-SVG Sizing Mismatch: Gap, Clipping, and Blur

**Date:** 2026-04-01
**Status:** Investigation
**Relates to:** PRD §5 (Card Sizing), §2.1 (Rendering Pipeline), §2.2 (4x Scale Trick)
**Discovered during:** Layout system design session (SESSION-001)
**Preceding:** PRD-amendment-004.md
**Changes from .01:** Added §1.2 blur symptom, §2.5 three divergent default values, §2.6 blur mechanism, §3.6 terminal.svg measurement, updated recommendation

---

## 1. Problem

### 1.1 Gap and Clipping

Terminal cards exhibit a visible gap (letterbox) between the SVG terminal content and the card edge. The gap appears on the right side and/or bottom of the card depending on terminal dimensions. At high column counts (200+), the terminal content can appear **clipped** instead of gapped.

#### Evidence

Checkerboard alignment tests across 6 terminal sizes (20×8 through 200×60) show:
- At standard sizes (80×24): ~2-3px gap on right edge, constant regardless of column count
- At high column counts (200×60): content clips on right edge
- Gap size appears roughly constant across different column counts at similar aspect ratios

### 1.2 Blurry Cards

Cards sometimes render with blurry text. Pressing +/− (which changes terminal cols/rows, triggering a card DOM resize and Chrome re-rasterization) makes the card crisp again. This suggests the blur is caused by Chrome rasterizing the card at a slightly wrong scale — the 4x scale trick depends on the card DOM being sized such that Chrome's rasterization aligns with pixel boundaries.

#### Evidence

User-reported: blurry cards become crisp after pressing +/− (terminal resize). The +/− triggers `updateCardForNewSize` → `calcCardSize` → new card DOM dimensions → Chrome re-rasterizes at the new size.

---

## 2. Root Cause

All three symptoms (gap, clipping, blur) trace to the same fundamental issue: **the card DOM and SVG content are sized using different cell dimension values.**

### 2.1 Two Different Cell Width Values

The card's DOM dimensions and the SVG's viewBox are computed using **different cell width values**:

| Component | Cell Width Source | Value | Used For |
|---|---|---|---|
| `calcCardSize()` in dashboard.mjs | Hardcoded constant `SVG_CELL_W` | 8.65 | Card DOM width = f(cols × 8.65) |
| SVG viewBox in terminal.svg | Runtime `getBBox()` measurement | ~8.61 (varies) | viewBox width = cols × CELL_W |
| SVG viewBox in terminal-renderer.mjs | Runtime `getBBox()` measurement | ~8.61 (varies) | viewBox width = cols × measuredCellW |

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

### 2.5 Three Divergent Default/Fallback Values

Three different places define cell dimension defaults or fallbacks, and they don't agree:

| Source | File | cellW default | cellH default |
|---|---|---|---|
| Card sizing constants | dashboard.mjs L1735-1736 | `SVG_CELL_W = 8.65` | `SVG_CELL_H = 17` |
| terminal.svg fallback | terminal.svg L75, L77 | `8.4` | `17` |
| terminal-renderer.mjs default | terminal-renderer.mjs L8-9 | `DEFAULT_CELL_W = 8.65` | `DEFAULT_CELL_H = 17` |

Three different values for cellW (8.65, 8.4, 8.65) and the runtime measurement returns ~8.61. None of these agree with each other or with the measured value.

### 2.6 Blur Mechanism

The 4x scale trick (PRD §2.1) works by:
1. Card DOM is oversized (e.g., 1290×1056 pixels)
2. CSS3DObject scale = 0.25
3. Chrome rasterizes the DOM at full 4x size, then the 3D transform scales it down

Chrome's rasterization of text under CSS3D transforms is sensitive to the exact DOM dimensions. When the card DOM dimensions don't cleanly align with the SVG's actual content dimensions (because of the cellW mismatch), Chrome may rasterize at a sub-optimal scale. The result: blurry text.

When +/− is pressed:
1. Terminal cols/rows change → `updateCardForNewSize()` → `calcCardSize()` → new card DOM
2. Chrome re-rasterizes the entire card at the new DOM dimensions
3. The fresh rasterization is sharp — but only because Chrome snapped to new pixel boundaries, not because the underlying mismatch was fixed

The blur is intermittent because it depends on whether the specific combination of card dimensions and 3D transform scale lands on clean pixel boundaries. Some sizes are lucky, some aren't.

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

### 3.2 SVG ViewBox — terminal-renderer.mjs (`initLayout`)

```
initLayout(cols, rows):
  viewBox = "0 0 " + (cols × measuredCellW) + " " + (rows × measuredCellH)
  // measuredCellW ≈ 8.61, measuredCellH ≈ 17.0 (from measureFont getBBox)
```

### 3.3 SVG ViewBox — terminal.svg (`initLayout`)

```
// Measured once at SVG parse time (before any data arrives):
var measureBBox = measureEl.getBBox();
var CELL_W = measureBBox.width / 10;        // ~8.61
if (!CELL_W || CELL_W <= 0) CELL_W = 8.4;  // fallback ≠ dashboard's 8.65
var CELL_H = measureBBox.height;             // ~17.0
if (!CELL_H || CELL_H <= 0) CELL_H = 17;

initLayout(width, height):
  viewBox = "0 0 " + (width × CELL_W) + " " + (height × CELL_H)
  // Uses runtime-measured values, not dashboard constants
```

**Key difference from terminal-renderer.mjs:** In terminal.svg, `CELL_W`/`CELL_H` are measured **once at parse time** in the `<script>` block. They are `var` declarations, not re-measured later. Both WebSocket and HTTP polling paths call `initLayout()` using these same values. The fallback for CELL_W is `8.4` (not 8.65).

### 3.4 SVG in Card DOM

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

### 3.5 Fit Terminal to Card (`optimizeTermToCard` — ⊡ button)

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

### 3.6 Fit Card to Terminal (`optimizeCardToTerm` — ⊞ button)

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

## 5. First-Principles Design

The font is fixed. The cell size is a physical property of that font at that size. From first principles, the correct design is:

1. **One source of truth:** Measure the font once at runtime. Every component that needs cell dimensions reads from that single measurement.
2. **No hardcoded cell constants:** `SVG_CELL_W`, `SVG_CELL_H`, `DEFAULT_CELL_W`, `DEFAULT_CELL_H`, and the `8.4` fallback in terminal.svg should not exist as separate values. They are workarounds for a timing problem.
3. **Solve the timing problem:** The card needs to be sized before the font is measured. The fix is to defer card sizing (or do a correction pass after measurement), not to approximate with constants.
4. **Card sizing uses measured values:** `calcCardSize()` reads from the renderer's measured cell dimensions. Card aspect perfectly matches SVG viewBox aspect. No letterbox, no clipping, no aspect-related blur.

---

## 6. Options

### Option A: Deferred Correction

1. Create card at approximate size using constants (current behavior)
2. After SVG `<object>` loads and measures font, read actual `CELL_W`/`CELL_H` from the SVG
3. Recalculate card DOM to match measured values
4. Chrome re-rasterizes at corrected size

**Pro:** Minimal change to init flow. **Con:** Visible card resize flash after load.

### Option B: Delay Card Visibility

1. Create card hidden (or at 0 opacity)
2. Wait for SVG to load and measure font
3. Size card using measured values
4. Show card

**Pro:** No flash. **Con:** Delayed appearance, more complex init sequence.

### Option C: Measure Font in Dashboard Context

Measure the font independently in the dashboard (create a hidden SVG text element, measure `getBBox()`), before creating any cards. Use that measurement for all card sizing.

**Pro:** One measurement, available synchronously, no timing race. **Con:** Dashboard measurement might differ from terminal.svg measurement (different SVG contexts — this was documented in the inline-svg-event-analysis journal: "inline SVG measures 9.13×21.66 vs `<object>` 8.5×25.5 for same font at same size").

### Option D: Read from SVG After Load + Correction

Add a message channel: after terminal.svg measures its font, it sends `CELL_W`/`CELL_H` back to the dashboard. Dashboard corrects card size using the actual values from the specific SVG context that will render the content.

**Pro:** Uses the exact values from the rendering context. **Con:** Requires message passing between SVG `<object>` and dashboard.

### Option E: Accept and Document

The gap is 2-3px at typical sizes. The blur is intermittent and fixable with +/−. Document both as known issues and move on.

---

## 7. Recommendation

[UNVERIFIED — needs discussion with user]

**Option D** is the most correct: the SVG that renders the content reports its actual cell dimensions, and the card sizes itself to match. This eliminates the mismatch at the source.

For the layout system, this matters because:
- "Maximize card→slot" (letterbox mode) will inherit whatever gap exists
- "Unify text size" (POV-FONT-SIZE) calculations depend on card-to-terminal aspect being accurate
- Blur at certain card sizes undermines the 4x scale trick that the entire rendering pipeline depends on

**Fixing this before building the layout system would give us a solid foundation.** But it could also be fixed as the first implementation step of the layout work, since the layout system needs accurate card-to-SVG correspondence anyway.

---

## 8. Open Questions

1. Is the 2-3px gap at standard sizes visible at production background color (`#1c1c1e` vs debug `#2e2e32`)?
2. Does `optimizeTermToCard` (⊡) reduce the gap by re-fitting with measured values, or does it just shift the mismatch to a different dimension?
3. Should `preserveAspectRatio` be explicitly set to a known value rather than relying on the default?
4. The inline-svg-event-analysis journal documented that inline SVG and `<object>` SVG measure different cell dimensions for the same font. If we move to inline rendering, the measured values will change — the fix needs to work for both paths.
5. Can the font measurement be made deterministic (same value every time, regardless of SVG context size) by measuring at a fixed reference viewBox size?
