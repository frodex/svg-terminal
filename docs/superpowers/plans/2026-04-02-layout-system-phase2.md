# Layout System Phase 2 — Mutation Operations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add composable mutation operations that users can apply after positioning cards in a named layout: maximize card→slot (resize card DOM to fill the slot) and maximize terminal→card (resize tmux to fill the resized card). These are independent — user can apply either, both, or neither.

**Architecture:** Two new header buttons on focused cards: "⬜" (maximize card to slot) and "⊡" (maximize terminal to card — already exists but needs layout-aware behavior). When a card is in a named layout slot, "maximize card→slot" reads the slot dimensions and resizes the card DOM. The existing "fit terminal to card" (⊡) then works naturally on the resized card. Mutation state per-card tracks which operations have been applied.

**Tech Stack:** Pure JS in dashboard.mjs. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-01-layout-system-design.04.md` §3.1-3.2

**Depends on:** Phase 1 (named layouts with slot positioning) — complete.

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `dashboard.mjs` | Mutation logic, slot tracking, header button | Modify |

---

### Task 1: Track Slot Assignment Per Card

**Files:**
- Modify: `dashboard.mjs`

When `calculateSlotLayout` positions a card into a slot, save the slot's screen-pixel dimensions on the terminal object so mutation operations can reference them later.

- [ ] **Step 1: Save slot info on terminal during layout**

In `calculateSlotLayout()`, inside the placement loop (where `t.targetPos` is set), add after `t.morphStart = now;`:

```javascript
    // Save slot dimensions for mutation operations (maximize card→slot).
    // slotPx values are in screen pixels of the usable area.
    t._layoutSlot = { x: slotPxX, y: slotPxY, w: slotPxW, h: slotPxH };
    t._layoutFit = { w: fitW, h: fitH };  // card's fitted size within slot (aspect-preserved)
```

- [ ] **Step 2: Clear slot info on unfocus**

In `unfocusTerminal()`, after `activeLayout = 'auto';`, add:

```javascript
  // Clear layout slot assignments
  for (var entry of terminals) {
    entry[1]._layoutSlot = null;
    entry[1]._layoutFit = null;
  }
```

- [ ] **Step 3: Commit**

```bash
git add dashboard.mjs
git commit -m "feat(layout): track slot assignment per card for mutation operations"
```

---

### Task 2: Maximize Card→Slot Operation

**Files:**
- Modify: `dashboard.mjs`

Add a function that resizes a card's DOM to fill its assigned layout slot. The card aspect ratio is preserved (letterbox — terminal content is never clipped). The card is centered in the slot if aspects don't match.

- [ ] **Step 1: Add maximizeCardToSlot function**

Add near the other optimize functions (`optimizeTermToCard`, `optimizeCardToTerm`):

```javascript
// Maximize card→slot: resize card DOM to fill its assigned layout slot.
// Preserves terminal aspect ratio (letterbox, never clip).
// Uses measured cell dimensions for accurate aspect calculation.
// Per-browser only — doesn't affect co-browsers or tmux.
//
// The slot is in screen pixels. The card DOM is at 4x scale (CSS3DObject scale 0.25).
// To make the card fill the slot's screen area at a given Z-depth:
//   cardDOMW = slotScreenW / (CSS3DObject_scale * perspective_scale_at_Z)
// But since we're using frustum projection (card's Z-depth is chosen so its world size
// fills the slot), we can work backwards: compute what card DOM size would make the
// world size fill the slot exactly.
function maximizeCardToSlot(t) {
  if (!t._layoutSlot) return;  // not in a named layout slot

  var slot = t._layoutSlot;
  var fit = t._layoutFit;
  if (!slot || !fit) return;

  var m = getMeasuredCellSize(t);
  var cw = m ? m.cellW : SVG_CELL_W;
  var ch = m ? m.cellH : SVG_CELL_H;
  var cols = t.screenCols || 80;
  var rows = t.screenRows || 24;

  // Terminal's natural aspect (from SVG viewBox)
  var termAspect = (cols * cw) / (rows * ch);

  // Slot aspect
  var slotAspect = slot.w / slot.h;

  // Card should fill the slot while preserving terminal aspect (letterbox).
  // The "fit" dimensions tell us how much of the slot the card currently fills.
  // But for maximize, we want the card to fill the FULL slot — meaning the card
  // can be larger than the terminal content (letterbox padding around terminal).
  //
  // To avoid clipping: card aspect should match terminal aspect.
  // Card width and height in DOM pixels (4x scale) that would fill the slot:
  // We need to compute what DOM size makes the card's world size fill the slot.
  //
  // Current: worldW = baseCardW * 0.25, and the frustum puts the card at Z where
  // worldH fills fitH screen pixels. If we change cardW/H, the world size changes,
  // so the Z-depth calculation would place it differently.
  //
  // Simpler approach: compute card DOM dimensions from the slot's proportions,
  // maintaining TARGET_WORLD_AREA for consistent visual weight, but using slot
  // aspect instead of terminal aspect.
  var slotW = slot.w;
  var slotH = slot.h;

  // Card should match slot aspect while preserving terminal content (letterbox).
  // If slot is wider than terminal: card is slot-width, terminal letterboxed horizontally
  // If slot is taller than terminal: card is slot-height, terminal letterboxed vertically
  var worldArea = TARGET_WORLD_AREA;
  var cardAspect = slotAspect;  // card fills the slot

  var worldW = Math.sqrt(worldArea * cardAspect);
  var worldH = worldArea / worldW;
  var cardW = Math.round(worldW * 4);
  var cardH = Math.round(worldH * 4) + HEADER_H;
  cardW = Math.max(MIN_CARD_W, Math.min(MAX_CARD_W, cardW));
  cardH = Math.max(MIN_CARD_H, Math.min(MAX_CARD_H, cardH));

  // Apply the new card size
  t.baseCardW = cardW;
  t.baseCardH = cardH;
  t.dom.style.width = cardW + 'px';
  t.dom.style.height = cardH + 'px';
  var inner = t.dom.querySelector('.terminal-inner');
  if (inner) {
    inner.style.width = cardW + 'px';
    inner.style.height = cardH + 'px';
  }

  // Reset +/- ratio to match new card shape
  t._origColRowRatio = cols / rows;

  // Re-run layout to reposition at correct Z-depth for new world size
  calculateFocusedLayout();
}
```

- [ ] **Step 2: Add the ⬜ button to card header**

In `createTerminalDOM`, add to the controls array AFTER the `⊞` (fit card to terminal) button and BEFORE the `▦` (cycle layout) button:

```javascript
      { label: '⬜', title: 'Maximize card to layout slot', fn: function() {
        var t = terminals.get(sessionName);
        if (t) maximizeCardToSlot(t);
      }},
```

- [ ] **Step 3: Commit**

```bash
git add dashboard.mjs
git commit -m "feat(layout): maximize card→slot operation with header button"
```

---

### Task 3: Layout-Aware Fit Terminal to Card

**Files:**
- Modify: `dashboard.mjs`

The existing `optimizeTermToCard` (⊡ button) already works — it reads the current card DOM size and fits the terminal to it. After the user applies "maximize card→slot" (which changes the card DOM), pressing ⊡ will naturally fit the terminal to the larger card.

However, we need to ensure the `_lockCardSize` flag works correctly with the layout system. After ⊡ resizes the terminal, `updateCardForNewSize` should NOT recalculate the card (since the user maximized it to the slot).

- [ ] **Step 1: Verify _lockCardSize works in sequence**

The current `optimizeTermToCard` already sets `t._lockCardSize = true`. When the terminal resize arrives via WebSocket, `updateCardForNewSize` checks this flag and skips card recalculation. This should work correctly in the layout context.

Test manually:
1. Multi-focus 2+ terminals
2. Select a named layout (click ▦)
3. Click ⬜ (maximize card to slot) — card fills the slot
4. Click ⊡ (fit terminal to card) — terminal fills the larger card
5. Verify: card stays the slot size, terminal content fills it

If this works correctly, no code changes needed — just verification.

- [ ] **Step 2: Commit (if changes were needed)**

If verification passes with no changes, skip this commit.

---

### Task 4: Integration Test

- [ ] **Step 1: Manual test sequence**

1. Hard refresh browser
2. Ctrl+click 3 terminals to multi-focus
3. Click ▦ to switch to "1 Main + 2 Side" layout
4. Verify: 3 cards positioned in slots (1 large left, 2 stacked right)
5. Click ⬜ on the main card — it should fill its slot completely
6. Click ⊡ on the same card — terminal should fill the expanded card
7. Click ▦ to switch to "3 Columns" — cards reposition, card sizes may reset
8. Press Escape — unfocus, layout resets

- [ ] **Step 2: Push**

```bash
git push
```
