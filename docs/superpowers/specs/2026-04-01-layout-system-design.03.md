# Layout System Design — svg-terminal

**Date:** 2026-04-01
**Status:** Draft v3
**Session:** SESSION-001
**Preceding:** 2026-04-01-layout-system-design.02.md
**Changes from .02:** Added §10 Gap Analysis — what exists, needs change, and needs building in current codebase

---

## 1. Purpose

A composable layout system for arranging terminal cards in the 3D scene. Users select a group of cards (ctrl+click thumbnails), apply a named layout, and optionally apply independent mutation operations to optimize the arrangement for readability and screen usage.

---

## 2. Architecture

### 2.1 Core Concept: Slot Map + Composable Mutations

A **layout** has two parts:

1. **Slot Map** — A named arrangement of rectangular bounding regions within usable space
2. **Mutation Operations** — Independent, composable transforms applied to cards in any order

Cards are assigned to slots. Each slot defines a maximum bounding region, not a required fill. The card fits within its slot at the best aspect ratio achievable within the automation defaults (see §4.2), centered if the aspect constraint prevents filling the slot entirely.

**Automation defaults vs user control:** The constraints in this document (aspect ratios, minimum sizes, font thresholds) are automation defaults — "bowling down the center of the lane" for auto-layouts. The design space is extremely flexible: 99.9% of possible configurations are not user-friendly. These defaults target the 0.1% that are convenient, usable tools out of the box. Users can override any automation default via direct manipulation or configuration. These are not software-enforced hard limits.

### 2.2 Usable Space

Usable space = viewport minus UI overlay footprint (sidebar, status bar). Defined by simple rectangle subtraction:

```
availW = window.innerWidth - SIDEBAR_WIDTH
availH = window.innerHeight - STATUS_BAR_H
```

UI elements remain CSS fixed overlays. This design is intentionally flexible — if thumbnails or other UI elements are later promoted to 3D frustum-positioned cards, usable space simply shrinks and the layout system works unchanged.

**Critical: Camera center ≠ usable-space center.** The 3D scene is rendered across the full browser window by the camera. The camera's optical center is the viewport center, but the user's perceived center is the center of the usable area (the region not obscured by UI). When dollying/zooming toward an object, the camera targets the viewport center, not the usable-area center. This causes the zoom target to appear off-center to the user. The problem is compounded with parallax on multi-card groupings where cards at different Z-depths shift at different rates relative to the perceived center. The current layout code compensates by placing cards asymmetrically in screen space (centered within `availW × availH`, then projected through the full viewport center), but this is a known tension in the architecture.

### 2.3 Slot Maps Are Percentage-Based

Slot positions and sizes are defined as percentages of usable space, so layouts scale with viewport. Each slot specifies:

```
slot: {
  x: <percent from left>,
  y: <percent from top>,
  w: <percent width>,
  h: <percent height>
}
```

Cards are assigned to slots in order (largest terminal first as calculated by `rows × cols`, or user-specified). See §6 for assignment strategy.

---

## 3. Mutation Operations

All operations are independent and composable. Any can be applied in any order, any combination. No operation requires another as a prerequisite.

### 3.1 Mutation Cost Hierarchy

Operations are ordered by cost. The system should prefer cheaper mutations first:

| Priority | Operation | Scope | Cost | Description |
|----------|-----------|-------|------|-------------|
| 1 | **Position into slot** | Per-browser | Free | Place card at Z-depth where it fills its slot via frustum projection. No state change. |
| 2 | **Maximize card→slot** | Per-browser | Low | Resize card DOM (x,y) to fill the slot bounding region. Letterbox only — must never clip the interior terminal object. See §3.2 for letterbox options. Saved in profile JSON. |
| 3 | **Font-size mutation** | Per-browser | Medium | Change SVG cell size (SVG_CELL_W, SVG_CELL_H) to fit more or fewer cols/rows in same card — smaller font packs more content, larger font improves readability. Doesn't touch tmux. |
| 4 | **Maximize terminal→card** | Global | High | Resize tmux session (cols/rows) to fill the current card size. Propagates to all connected browsers. |
| 5 | **Unify text size** | Varies | Varies | Equalize POV-FONT-SIZE (see §3.5) across all cards. Uses cheapest lever available. |

### 3.2 Operation Details

#### Position into slot (Z-depth relocation)

The current `calculateFocusedLayout` approach: compute the Z-depth where a card's world size fills its allocated screen rectangle through perspective projection. Card DOM is unchanged. This is the default behavior — always applied.

#### Maximize card→slot

Resize card DOM (x,y) to fill the slot's bounding region. Card is centered in slot if the aspect constraint prevents full fill. Updates `baseCardW/baseCardH`. Per-browser only — doesn't affect co-browsers.

**Letterbox rule:** The card resize must never clip the interior terminal object. When the slot's aspect ratio doesn't match the terminal's aspect ratio, the card letterboxes — the terminal is fully visible with unused card area around it.

**Letterbox option:** Whether to letterbox or allow clipping could be a per-object parameter:

```
card.fitMode = 'letterbox' | 'fill'
```

- `letterbox` (default): card resizes to fit the slot, terminal interior is never clipped, unused card area visible
- `fill`: card fills the slot entirely, terminal interior may be clipped at edges

Implementation suggestion: This maps to CSS `object-fit: contain` (letterbox) vs `object-fit: cover` (fill) semantics, though the actual implementation is card DOM sizing, not CSS object-fit. The parameter should be settable per-card and overridable by the user.

#### Font-size mutation

Change the SVG rendering cell size (currently fixed at `SVG_CELL_W = 8.65`, `SVG_CELL_H = 17`) for a specific card. A smaller font fits more cols/rows in the same card area. A larger font improves readability at the cost of fewer visible cols/rows. Must stay above minimum POV-FONT-SIZE threshold (see §3.5). Per-browser — doesn't touch tmux.

#### Maximize terminal→card

Resize the tmux session (cols/rows) so terminal content fills the current card dimensions. This is the existing "fit terminal to card" (⊡) operation. **Global** — propagates to all connected browsers via WebSocket. Other browsers receive the resize via `updateCardForNewSize`.

#### Unify text size

Target: all cards in the layout show identical POV-FONT-SIZE (see §3.5) as seen by the user.

The unification algorithm should prefer cheaper levers:
1. First try Z-depth adjustment alone
2. Then card resize
3. Then font-size mutation
4. Terminal resize as last resort

### 3.3 Co-Browser Politeness

When one user's layout triggers a terminal mutation that propagates to co-browsers:

1. Co-browser accepts the new terminal size (cols/rows) — shared tmux reality
2. Recalculates card size via `calcCardSize`
3. Compensates via Z-depth repositioning to keep card's apparent screen size/position stable
4. Does NOT rerun the co-browser's layout

The co-browser sees content reflow (terminal resized) but their layout doesn't jump.

### 3.4 Card Mutation and Co-Browsers

Card-only mutations (x,y without terminal change) don't trigger `updateCardForNewSize` on co-browsers. Their cards stay as-is. However:

- The 3D space is now divergent between viewers (already the case with per-browser profiles)
- If a co-browser's layout system auto-repositions on card-size changes, it could trigger a reposition event

Documented as a known edge case — may need a "reposition reason" flag or suppression logic if this becomes a problem in practice.

### 3.5 POV-FONT-SIZE — Apparent Font Size Metric

**POV-FONT-SIZE** is a computed metric that maps the apparent character size as seen by the user to the equivalent CSS font-size in pixels — as if the terminal text were rendered as plain HTML on the browser at that size.

This gives users an intuitive control: "set font size to 11" means the system calculates whatever mutations are needed so the text appears as an 11px font would in a normal HTML page.

#### Calculation

```
// 1. SVG cell height in card DOM pixels
svgCellH = SVG_CELL_H  // default 17, or mutated value

// 2. Card's apparent height on screen (from frustum projection)
cardScreenH = cardWorldH * (viewportH / (2 * Z_depth * tan(fov / 2)))

// 3. Apparent character height in screen pixels
apparentCharH = (svgCellH / cardDOMH) * cardScreenH

// 4. Map to CSS font-size equivalent
// A 14px CSS font has ~17px line height (1.2× ratio)
// POV-FONT-SIZE = apparent character height / line-height ratio
povFontSize = apparentCharH / 1.2
```

All inputs are available from the browser: `window.innerHeight` for viewportH, `camera.fov`, card Z-depth from the frustum projection, `cardDOMH` from the card's style, and `svgCellH` from the terminal renderer.

#### Usage

- **Unify text size:** Calculate POV-FONT-SIZE for each card, then adjust mutations so all cards converge on the same value
- **User-specified target:** User says "POV font size = 11" → system solves for the cheapest mutation combination that delivers `povFontSize = 11` for all cards in the layout
- **Font size floor:** Minimum POV-FONT-SIZE is a tunable parameter (TBD from usage data). Auto-layouts must not produce a POV-FONT-SIZE below this threshold.

---

## 4. Constraints

All constraints in this section are **automation defaults** for auto-calculated layouts. They are not software-enforced hard limits. Users can override any of these via direct manipulation or configuration. Special use cases may have legitimate reasons to exceed these bounds.

### 4.1 Minimum Terminal Size

VT100 (80×24) is the recommended minimum for auto-layouts. This is close to minimum usable height AND minimum usable width in terms of cols/rows. Auto-layouts should not size terminals smaller than this without explicit user action.

### 4.2 Card Aspect Ratio

Automation default range: **16:9** (widest landscape, ~1.78:1) to **9:16** (tallest portrait, ~0.56:1). Even in layouts with full-width slots (N-stacked-rows), cards should be narrower at a comfortable aspect rather than letterboxed to full width. Cards center within their slot if the aspect constraint prevents filling it.

VT100's natural aspect: (80 × 8.65) / (24 × 17 + 72) ≈ 1.44:1, comfortably within range.

### 4.3 Font Size Floor

Auto-layouts are constrained by two independent minimums:

1. **Minimum terminal size** — auto-layouts should not produce terminals smaller than VT100 (80×24). Decreasing font size increases the number of cols/rows that fit in a card, so font-size mutation should not be used to justify a smaller terminal.

2. **Minimum POV-FONT-SIZE** — auto-layouts should not produce a POV-FONT-SIZE below the readability threshold, regardless of terminal size. A terminal could have 200 cols × 60 rows but if the apparent font is 4px, it's unreadable.

Both constraints must be satisfied simultaneously. The exact minimum POV-FONT-SIZE value is TBD from usage data — this is a tunable parameter.

### 4.4 Aspect Expansion with Size

At minimum terminal size (VT100), the card is naturally landscape (~4:3). As terminals grow (more total cells), the card aspect ratio can vary — but auto-layouts should keep cards within the 16:9 to 9:16 range. Small terminals should not be placed in portrait slots.

---

## 5. Layout Catalog

### 5.1 Standard Layouts

| Name | Slots | Use Case |
|------|-------|----------|
| `2up-h` | 2 side by side | Diff view, pair comparison |
| `2up-v` | 2 stacked top/bottom | Log tailing, output monitoring |
| `1main-2side` | 1 large left + 2 stacked right | IDE-style: editor + terminals |
| `3col` | 3 equal columns | Multi-agent monitoring, triple comparison |
| `2x2` | 4-slot quadrant grid | Dashboard monitoring, multi-agent workspace |
| `2top-1bottom` | 2 top + 1 wide bottom | Comparison above, output below |
| `1main-4mini` | 1 large left + 2×2 grid right | Command center |
| `n-stacked` | N rows, full width | Log monitoring, sequential output (cards narrower than slot, centered) |

### 5.2 Slot Definitions

#### 2up-h (2 side by side)
```
slot 0: { x: 0%, y: 0%, w: 50%, h: 100% }
slot 1: { x: 50%, y: 0%, w: 50%, h: 100% }
```

#### 2up-v (2 stacked)
```
slot 0: { x: 0%, y: 0%, w: 100%, h: 50% }
slot 1: { x: 0%, y: 50%, w: 100%, h: 50% }
```

#### 1main-2side (1 + 2 stack)
```
slot 0 (main): { x: 0%, y: 0%, w: 66%, h: 100% }
slot 1:        { x: 66%, y: 0%, w: 34%, h: 50% }
slot 2:        { x: 66%, y: 50%, w: 34%, h: 50% }
```

#### 3col (3 equal columns)
```
slot 0: { x: 0%, y: 0%, w: 33%, h: 100% }
slot 1: { x: 33%, y: 0%, w: 34%, h: 100% }
slot 2: { x: 67%, y: 0%, w: 33%, h: 100% }
```

#### 2x2 (quadrant grid)
```
slot 0: { x: 0%, y: 0%, w: 50%, h: 50% }
slot 1: { x: 50%, y: 0%, w: 50%, h: 50% }
slot 2: { x: 0%, y: 50%, w: 50%, h: 50% }
slot 3: { x: 50%, y: 50%, w: 50%, h: 50% }
```

#### 2top-1bottom (2 + 1 wide)
```
slot 0: { x: 0%, y: 0%, w: 50%, h: 50% }
slot 1: { x: 50%, y: 0%, w: 50%, h: 50% }
slot 2: { x: 0%, y: 50%, w: 100%, h: 50% }
```

#### 1main-4mini (1 + 2×2 grid)
```
slot 0 (main): { x: 0%, y: 0%, w: 66%, h: 100% }
slot 1:        { x: 66%, y: 0%, w: 17%, h: 50% }
slot 2:        { x: 83%, y: 0%, w: 17%, h: 50% }
slot 3:        { x: 66%, y: 50%, w: 17%, h: 50% }
slot 4:        { x: 83%, y: 50%, w: 17%, h: 50% }
```

#### n-stacked (N rows)
```
For N cards:
slot i: { x: 0%, y: (100/N * i)%, w: 100%, h: (100/N)% }
Cards centered within slot at comfortable aspect (not letterboxed to full width)
```

---

## 6. Card Assignment

When a layout is applied to a focus group, cards must be assigned to slots.

### 6.1 Default Strategy: Maximize Minimum POV-FONT-SIZE

The goal is to assign cards to slots such that the card with the **smallest POV-FONT-SIZE** is as large as possible. This means the largest terminal (by `rows × cols` cell count) receives the largest layout slot, since it needs the most screen space to maintain readable text.

1. Sort cards by cell count (`cols × rows`), largest first
2. Sort slots by area (width × height percentage), largest first
3. Assign cards to slots in matching order (largest card → largest slot)
4. User can manually reassign by dragging

On layouts that allow card mutation, card aspect ratio should also be considered during assignment — a wide terminal may fit better in a wide slot even if it's not the largest by cell count. Rules for this need experimentation.

### 6.2 Overflow: More Cards Than Slots

When the focus group has more cards than the layout has slots, the layout shrinks proportionally to make space outside the layout region. The excess cards are positioned in the freed space, as large as possible, using the same frustum projection. This keeps all cards visible and usable rather than hiding them in the sidebar or subdividing slots into unusably small regions.

### 6.3 Underflow: Fewer Cards Than Slots

If fewer cards than slots, empty slots are collapsed and remaining slots expand proportionally.

---

## 7. Future: Smart Scaling (Out of Scope)

Once the building blocks are built, add a "smart scaling" one-button feature that analyzes the current group (card sizes, terminal sizes, viewport dimensions) and automatically selects a layout + mutation combination. User tunes by toggling individual mutation layers on/off.

This is the reason operations must be independent and composable — smart scaling orchestrates them. Not in scope for this design.

---

## 8. Interaction with Existing System

### 8.1 Relationship to calculateFocusedLayout

The current `calculateFocusedLayout` (masonry bin-packing with frustum projection) becomes one layout option — effectively an "auto" layout that picks column count for best coverage. Named layouts replace the masonry algorithm with explicit slot maps but reuse the same frustum projection math for Z-depth positioning.

### 8.2 Existing Mutations Map to Operations

| Existing Feature | Maps To |
|-----------------|---------|
| `calculateFocusedLayout` masonry | Position into slot (auto layout) |
| Alt+drag card body | Manual card resize (maximize card→slot, user-driven) |
| ⊡ Fit terminal to card | Maximize terminal→card |
| ⊞ Fit card to terminal | Inverse — restore card to match terminal |
| +/− header buttons | Manual terminal resize |
| Alt+scroll font size | Font-size mutation |

### 8.3 Profile Persistence

Per-browser state (card positions, card sizes, active layout, applied mutations) is saved to profile JSON via the existing `/api/layout` endpoint. Terminal state (cols/rows) is shared via tmux.

---

## 9. Open Questions

1. **Card assignment optimization:** Cell-count sorting is the default. Should aspect-ratio matching between cards and slots also be considered? Needs experimentation.
2. **Layout switching animation:** Animate cards morphing between layouts, or instant snap?
3. **Gap/padding:** Fixed pixel gap between slots, or percentage-based?
4. **Minimum POV-FONT-SIZE threshold:** Exact value TBD from usage data.
5. **Z-compensation limits:** Can Z-depth alone absorb arbitrary terminal resize changes from co-browsers, or are there extreme cases where it fails?
6. **POV-FONT-SIZE line-height ratio:** Using 1.2× as the CSS font-size to line-height mapping. Needs validation against actual SVG cell metrics and common terminal fonts.
7. **Letterbox option scope:** Should `fitMode` be per-card, per-layout, or a global default with per-card override?

---

## 10. Gap Analysis — Current Codebase

Assessment of what exists, needs modification, and needs building in the current svg-terminal codebase to support this design.

### 10.1 Exists — Can Reuse

| Capability | Location | Notes |
|---|---|---|
| Frustum projection (Z-depth positioning) | `dashboard.mjs` `calculateFocusedLayout()` L441-474 | Core math for projecting screen rectangles to 3D positions. Reusable as-is. |
| Maximize terminal→card | `dashboard.mjs` `optimizeTermToCard()` L180, wired to ⊡ header button | Existing operation, maps directly to mutation. |
| Card cell-count sorting | `dashboard.mjs` L376 | Already sorts `cards` by `cells` descending. |
| Profile save/load endpoints | `server.mjs` L1264-1299 | Dumb JSON store (`GET/POST /api/layout?uid=`). Extensible — new fields require no server changes. |
| Per-terminal measured cell size | `terminal-renderer.mjs` L95-96 | Each terminal instance has private `measuredCellW`/`measuredCellH` in its closure. |
| Usable space calculation | `dashboard.mjs` L355-357 | `availW = screenW - SIDEBAR_WIDTH`, `availH = screenH - STATUS_BAR_H`. |
| Camera tween animation | `dashboard.mjs` L479-488 | Existing morph/tween system for card and camera animation. |

### 10.2 Needs Change

| What | Why | Location | Impact |
|---|---|---|---|
| `calculateFocusedLayout()` | Masonry bin-packing (tries 1-4 columns) needs to accept named slot maps. The column loop (L389-420) is incompatible with pre-defined rectangular slots. | `dashboard.mjs` L389-420 | **High** — core layout function. Masonry becomes one layout option ("auto"), named layouts use slot maps with the same frustum projection. |
| `SVG_CELL_W` / `SVG_CELL_H` | Module-global constants. Font-size mutation requires per-card values. All references must read from the terminal object instead. | `dashboard.mjs` L1735-1736, referenced at L368, L1752 | **High** — threads through every function that touches cell sizing. |
| `calcCardSize()` | Only sizes card from terminal dimensions. Needs a slot-aware variant that sizes card to fill a slot rectangle (letterbox mode). | `dashboard.mjs` L1751-1766 | **Medium** — new function, existing one stays for default card sizing. |
| `updateCardForNewSize()` | Always resizes DOM unconditionally. Needs a Z-compensation path: when a co-browser's terminal resize arrives, adjust Z-depth to maintain apparent size instead of rerunning layout. | `dashboard.mjs` L1773-1791 | **Medium** — add conditional branch, don't break existing reactive path. |
| `createInlineTerminal()` API | No `setCellSize(w, h)` method. Closure variables `measuredCellW`/`measuredCellH` are private — dashboard can't change cell size from outside. | `terminal-renderer.mjs` L275-315 | **Medium** — add setter, call `initLayout()` to rebuild viewBox. |
| `measureFont()` | Would overwrite intentional cell-size overrides on reconnect. Needs distinction between "user-set" and "measured" cell size. | `terminal-renderer.mjs` L104-112 | **Low** — add a flag to skip measurement when cell size is explicitly set. |
| Profile state | Saves camera/card positions but not: layout name, slot assignments, per-card cell sizes, per-card letterbox/fill mode, POV-FONT-SIZE. No client-side restore on page load. | `dashboard.mjs` L2991-3026 | **Medium** — extend `_getLayoutState()`, add `_loadLayout()`. |

### 10.3 Missing — Needs Building

| Capability | Description | Estimated Complexity |
|---|---|---|
| **Slot-map registry** | Named layout definitions (`2up-h`, `3col`, `2x2`, etc.) with percentage-based slot rectangles. Data structure + lookup. | Low — pure data, no logic |
| **Slot-based layout function** | Replaces masonry packer for named layouts. Takes a slot map + card list, assigns cards to slots, computes frustum positions. Reuses existing projection math. | Medium — new function, existing math |
| **Slot assignment algorithm** | Largest terminal (by `rows × cols`) → largest slot. With optional aspect-ratio matching. | Low — sorting + matching |
| **POV-FONT-SIZE calculation** | `apparentCharH = (svgCellH / cardDOMH) * cardScreenH`, then `/ 1.2`. Needs all inputs wired together. | Low — formula, all inputs available |
| **Unify text size algorithm** | Calculate POV-FONT-SIZE per card, solve for cheapest mutation combination to equalize. | Medium — optimization logic |
| **Per-card font-size mutation** | `setCellSize()` in renderer + per-card `svgCellW`/`svgCellH` fields on terminal data structure + dashboard wiring. | Medium — cross-file change |
| **Letterbox/fill mode** | Per-card `fitMode` field + card-to-slot sizing logic that respects the mode. | Low — new field + sizing branch |
| **Overflow handling** | Shrink layout proportionally, place excess cards in freed space via frustum projection. | Medium — layout math |
| **Z-compensation function** | Given a slot's target screen fraction and card's new world size, compute new Z-depth so apparent size stays constant. Extract from existing frustum math. | Low — extract existing formula |
| **Resize source attribution** | Server adds `source` field to resize broadcasts so co-browsers know whether to re-layout or Z-compensate. | Low — add field to WebSocket message |
| **Client-side layout restore** | On page load, read profile JSON, apply saved layout name, slot assignments, cell sizes, card positions. | Medium — new init path |

### 10.4 Biggest Structural Change

**Making cell size per-card instead of global** is the most cross-cutting change. It touches:
- `dashboard.mjs`: `SVG_CELL_W`/`SVG_CELL_H` constants → per-terminal fields
- `dashboard.mjs`: `calcCardSize()`, `calculateFocusedLayout()`, card assignment — all read cell size
- `terminal-renderer.mjs`: new `setCellSize()` API, `measureFont()` override protection
- Terminal data structure: new `svgCellW`/`svgCellH` fields initialized from defaults

Everything else builds on top of existing patterns or is additive (new functions, new data structures).
