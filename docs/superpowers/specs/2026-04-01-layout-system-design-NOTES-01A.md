# Layout System Design — svg-terminal

**Date:** 2026-04-01
**Status:** Draft
**Session:** SESSION-001
**Preceding:** none

---

## 1. Purpose

A composable layout system for arranging terminal cards in the 3D scene. Users select a group of cards (ctrl+click thumbnails), apply a named layout, and optionally apply independent mutation operations to optimize the arrangement for readability and screen usage.

---

## 2. Architecture

### 2.1 Core Concept: Slot Map + Composable Mutations

A **layout** has two parts:

1. **Slot Map** — A named arrangement of rectangular bounding regions within usable space
2. **Mutation Operations** — Independent, composable transforms applied to cards in any order

Cards are assigned to slots. Each slot defines a maximum bounding region, not a required fill. The card fits within its slot at the best aspect ratio achievable within the 16:9–9:16 constraint, centered if the aspect constraint prevents filling the slot entirely.

THIS IS A AUTOMATION CONSTRAINT THAT CAN BE OVER-RIDDEN BY USER AS WELL AS MODIFIED BY USER CONFIG. IT'S A - BOWL DOWN THE CENTER OF THE LANE - TYPE SOLUTION FOR GENERIC LAYOUTS CONSTRAINT BECAUSE WE HAVE A DESIGN THAT'S SO FLEXIBLE 99.9% OF THE POSSIBLE CONFIGURATIONS ARE NOT USER FRIENDLY AND WERE TRYING TO DESIGN FOR THE 0.1 % WHICH ARE HAPPY MAKING AND CONVIENIENT TOOLS FOR THE USER  TO APPLY OUT OF THE BOX.

### 2.2 Usable Space

Usable space = viewport minus UI overlay footprint (sidebar, status bar). Defined by simple rectangle subtraction:

```
availW = window.innerWidth - SIDEBAR_WIDTH
availH = window.innerHeight - STATUS_BAR_H
```

UI elements remain CSS fixed overlays. This design is intentionally flexible — if thumbnails or other UI elements are later promoted to 3D frustum-positioned cards, usable space simply shrinks and the layout system works unchanged.

ITS IMPORTANT TO NOTE THIS DESIGN DECISION MAKES CALCULATING 3D PATHS AKWARD BECAUSE THE "SCENE" IS PAINTED FULL BROWSER WINDOW BY THE CAMERA, BUT THE VIEWPORT CENTER IS NOT THE VIEWPORT CENTER IT'S THE CENTER OF THE AREA NOT OBSCURED BY UI. SO IF YOU DOLLY/ZOOM INTO AN OBJECT WITH A CAMERA SET AS BROWSER WINDOW POV YOU WILL NOT GET THAT OBJECT YOU ARE ZOOMING INTO LOCATED IN THE CENTER OF THE USERS VIEWPORT. THIS IS BECOMES COMPOUNDED WITH PARALAX ISSUES ON MULTI-CARD GROUPINGS

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

Cards are assigned to slots in order (largest terminal first (AS CALCULATED BY ROW/COL), or user-specified). Assignment strategy TBD — could be cell-count proportional, user-ordered, or role-based.

---

## 3. Mutation Operations

All operations are independent and composable. Any can be applied in any order, any combination. No operation requires another as a prerequisite.

### 3.1 Mutation Cost Hierarchy

Operations are ordered by cost. The system should prefer cheaper mutations first:

| Priority | Operation                  | Scope       | Cost   | Description                                                                                                                                                                                                                                                                                                                                                                   |
| -------- | -------------------------- | ----------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | **Position into slot**     | Per-browser | Free   | Place card at Z-depth where it fills its slot via frustum projection. No state change.                                                                                                                                                                                                                                                                                        |
| 2        | **Maximize card→slot**     | Per-browser | Low    | Resize card DOM (x,y) to fill the slot bounding region. Saved in profile JSON. RESIZE SHOULD NEVER CLIP THE INTERIOR OBJECT (TERMINAL) LETTER-BOX ONLY - PERHAPS THIS SHOULD BE AN OPTION THAT CAN BE PASSED ON THE OBJECT. LETTERBOX(Y/N) PERHAPS A BETTER MORE EMCOMPASING PARAMETER THAT CAPTURES THIS IDEA/OPTION - NEED CONCIDERATION AND SUGGESTIONS ON IMPLEMENTATION. |
| 3        | **Font-size mutation**     | Per-browser | Medium | Change SVG cell size (SVG_CELL_W, SVG_CELL_H) to fit more cols/rows in same card at smaller font (OR LARGER). Doesn't touch tmux.                                                                                                                                                                                                                                             |
| 4        | **Maximize terminal→card** | Global      | High   | Resize tmux session (cols/rows) to fill the current card size. Propagates to all connected browsers.                                                                                                                                                                                                                                                                          |
| 5        | **Unify text size**        | Varies      | Varies | Equalize apparent character size in screen pixels across all cards. Uses cheapest lever available.                                                                                                                                                                                                                                                                            |

### 3.2 Operation Details

#### Position into slot (Z-depth relocation)

The current `calculateFocusedLayout` approach: compute the Z-depth where a card's world size fills its allocated screen rectangle through perspective projection. Card DOM is unchanged. This is the default behavior — always applied.

#### Maximize card→slot

Resize card DOM (x,y) to fill the slot's bounding region, respecting the 16:9–9:16 aspect constraint. Card is centered in slot if aspect constraint prevents full fill. Updates `baseCardW/baseCardH`. Per-browser only — doesn't affect co-browsers.

#### Font-size mutation

Change the SVG rendering cell size (currently fixed at `SVG_CELL_W = 8.65`, `SVG_CELL_H = 17`) for a specific card. A smaller font fits more cols/rows in the same card area. Must stay above minimum usable apparent font size (threshold TBD from usage data). Per-browser — doesn't touch tmux.

#### Maximize terminal→card

Resize the tmux session (cols/rows) so terminal content fills the current card dimensions. This is the existing "fit terminal to card" (⊡) operation. **Global** — propagates to all connected browsers via WebSocket. Other browsers receive the resize via `updateCardForNewSize`.

#### Unify text size

Target: all cards in the layout show identical apparent character height in screen pixels as seen by the user. Apparent character size is a function of:

```
apparent_char_h = (SVG_CELL_H / cardH) * card_screen_height
```

Where `card_screen_height` depends on the card's Z-depth in the frustum.

The unification algorithm should prefer cheaper levers:

1. First try Z-depth adjustment alone
2. Then card resize
3. Then font-size mutation
4. Terminal resize as last resort

WE SHOULD COME UP WITH A 2D FONT SIZE EQUIVELENT "POV-FONT-SIZE" THAT MAPS TO WHAT THE FONT WOULD BE IF DISPLAYED AS HTML ON THE BROWSER. CAN THAT CALCULATION BE MADE WITH INFORMATION WE CAN GET FROM THE BROWSER? USE CASE, USER SAYS AUTOMATIC LAYOUT OPTIMIZATION FONT SIZE = 11 AND WE WOULD CALCULATE OUR MUTATIONS TO DELIVER A "POV-FONT-SIZE" THAT IS EQUAL TO 11 - CONFIRM THIS MAKES SENSE, ADD YOUR SUGGESTIONS AND WAYS TO IMPLEMENT.

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

---

## 4. Constraints

### 4.1 Minimum Terminal Size

VT100 (80×24) is the reasonable minimum usable terminal. This is close to minimum usable height AND minimum usable width in terms of cols/rows. THIS IS NOT A HARD CONSTRAINT, USERS SHOULD BE ABLE TO ADJUST TO WHATEVER THEY WANT, THIS IS A SUGGESTION ABOUT SIZING THINGS FOR USERS AUTOMATICALLY.

### 4.2 Card Aspect Ratio

Constrained between **16:9** (widest landscape, ~1.78:1) and **9:16** (tallest portrait, ~0.56:1). SPECIAL USE CASES MAY HAVE REAL REASON TO GO BEYONG THESE CONSTRAINTS, AGAIN THIS IS FOR AUTOMATICALLY DESIGNED OR CALCULATED LAYOUTS FOR USABILITY, NOT A SOFTWARE FUNCTION CONSTRAINT. Even in layouts with full-width slots (N-stacked-rows), cards should be narrower at a comfortable aspect rather than letterboxed. Cards center within their slot if the aspect constraint prevents filling it.

VT100's natural aspect: (80 × 8.65) / (24 × 17 + 72) ≈ 1.44:1, comfortably within range.

### 4.3 Font Size Floor

As terminal size (total cells) decreases and cards shrink, apparent font size as seen by the user becomes the binding constraint. >>> A terminal can exceed minimum col/row constraints by decreasing font size — but only down to a minimum readable threshold. <<< THIS LINE IS CONFUSING. TERMINALS SHOULD NOT BE AUTO-SIZED LESS THAN THE MINIMUM TERMINA SIZE CONSTRAINT. DECREASING FONT SIZE INCREASES ROWS AND COLLUMS. THE AUTO-LAYOUTS SHOULD NOT ONLY BE TERMINAL SIZE CONSTAINED, BUT ALSO CONSIDER THE "APPARENT" FONT SIZE THE USER POV SEES. I GAVE INFORMATION AND SUGGESTIONS ON A SIMULATED FONT SIZE WE SHOULD CALCULATE PLEASE INCLUDE THAT HERE.

Minimum apparent character height in screen pixels: TBD from usage data. This is a tunable parameter.

### 4.4 Aspect Expansion with Size

At minimum terminal size (VT100), the card is naturally landscape (~4:3). As terminals grow (more total cells), the usable aspect range expands BUT I SUGGEST WE LIMIT THE ASPECT TO 16:9 OR 9:16 AS EXTRA WIDE OR EXTRA TALL ASPECTS ARE NOT USER FRIENDLY.

---

## 5. Layout Catalog

### 5.1 Standard Layouts

| Name           | Slots                          | Use Case                                                               |
| -------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `2up-h`        | 2 side by side                 | Diff view, pair comparison                                             |
| `2up-v`        | 2 stacked top/bottom           | Log tailing, output monitoring                                         |
| `1main-2side`  | 1 large left + 2 stacked right | IDE-style: editor + terminals                                          |
| `3col`         | 3 equal columns                | Multi-agent monitoring, triple comparison                              |
| `2x2`          | 4-slot quadrant grid           | Dashboard monitoring, multi-agent workspace                            |
| `2top-1bottom` | 2 top + 1 wide bottom          | Comparison above, output below                                         |
| `1main-4mini`  | 1 large left + 2×2 grid right  | Command center                                                         |
| `n-stacked`    | N rows, full width             | Log monitoring, sequential output (cards narrower than slot, centered) |

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

When a layout is applied to a focus group, cards must be assigned to slots. Default strategy:

I THINK THIS IS THE PROPER SORT ORDER, BUT THE INTENT WOULD BE TO POSITION THE CARDS TO MAXIMIZE THE THE CARD WITH THE SMALLET "USER POV" FONT SIZE. WHATEVER POSITION THAT PLACES IT. SO LARGEST TERMINAL BY ROW*COL COUNT RECEIVES THE LARGEST LAYOUT SPOT. CHANGING THE ASPECT OF THE CARD SHOULD ALSO BE CONSIDERED, ON LAYOUTS THAT ALLOW CARD MUTATION. A EXPERIMENT SHOULD BE RUN TO HELP DETERMIN RULES FOR THIS PROCESS. WE SHOULD EXPERIMENT IN THE 

1. Sort cards by cell count (cols × rows), largest first
2. Assign to slots in order (slot 0 = primary/largest)
3. User can manually reassign by dragging

If the group has more cards than slots, excess cards are either:

I WOULD SAY THE LAYOUT IS SHRUNK TO MAKE SPACE OUTSIDE FOR THE REMAINING CARDS TO BE FIT SO THEY CAN BE AS LARGE AS POSSIBLE.

- Placed in an overflow region (TBD)
- Minimized to sidebar
- Distributed by subdividing the smallest slot

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

| Existing Feature                 | Maps To                                              |
| -------------------------------- | ---------------------------------------------------- |
| `calculateFocusedLayout` masonry | Position into slot (auto layout)                     |
| Alt+drag card body               | Manual card resize (maximize card→slot, user-driven) |
| ⊡ Fit terminal to card           | Maximize terminal→card                               |
| ⊞ Fit card to terminal           | Inverse — restore card to match terminal             |
| +/− header buttons               | Manual terminal resize                               |
| Alt+scroll font size             | Font-size mutation                                   |

### 8.3 Profile Persistence

Per-browser state (card positions, card sizes, active layout, applied mutations) is saved to profile JSON via the existing `/api/layout` endpoint. Terminal state (cols/rows) is shared via tmux.

---

## 9. Open Questions

1. **Card assignment strategy:** Cell-count sorting is the default — is this sufficient or do we need role-based assignment?
2. **Overflow handling:** What happens when more cards than slots? Minimize, subdivide, or overflow region?
3. **Layout switching animation:** Animate cards morphing between layouts, or instant snap?
4. **Gap/padding:** Fixed pixel gap between slots, or percentage-based?
5. **Minimum font size threshold:** Exact screen-pixel value TBD from usage data
6. **Z-compensation limits:** Can Z-depth alone absorb arbitrary terminal resize changes from co-browsers, or are there extreme cases where it fails?
