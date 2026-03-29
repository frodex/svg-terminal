# Card Sizing — First Principles Design

**Date:** 2026-03-28
**Context:** After multiple patch attempts, stepping back to design the correct system.

---

## The Three States a Card Can Be In

### 1. Ring (unfocused)
- Card lives in the spinning ring
- Sized from tmux cols×rows to match terminal aspect ratio
- All cards have similar visual weight (world-space area)
- CSS3DObject scale = 0.25 (the 4x trick)
- DOM = baseCardW × baseCardH
- inner = baseCardW × baseCardH, no transform
- Billboard slerp faces camera

### 2. Single Focus
- Card flies to center, fills viewport
- Text should be crisp — maximize DOM pixels for this card
- DOM = screenW × screenH (calculated from viewport)
- inner = baseCardW × baseCardH, with scale transform to fit
- CSS3DObject scale = worldH / screenH (smaller than 0.25, because DOM is bigger)
- This is the 1:1 pixel mapping trick — bigger DOM = more pixels for Chrome to rasterize

### 3. Multi Focus
- Multiple cards in a grid layout
- Each card at its BASE size (not viewport-filling)
- CSS3DObject scale = 0.25
- DOM = baseCardW × baseCardH
- inner = baseCardW × baseCardH, no transform
- Camera pulls back to see the grid

## State Transitions

### Ring → Single Focus (click thumbnail)
1. Save baseCardW/baseCardH (already set)
2. Calculate viewport-filling DOM size preserving aspect
3. Set DOM to screenW × screenH
4. Set inner to baseCardW × baseCardH with scale(innerScale)
5. Set CSS3DObject scale to worldH / screenH
6. Animate position to center

### Single Focus → Multi Focus (ctrl+click second thumbnail)
1. Restore first card: DOM → baseCardW × baseCardH, inner clear transform, scale → 0.25
2. Add second card to focused set
3. Calculate grid layout using baseCardW/baseCardH for all cards
4. Animate positions to grid

### Multi Focus → Multi Focus (ctrl+click another thumbnail)
1. Add card to focused set (no restore needed — existing cards already at base size)
2. Recalculate grid layout
3. Animate positions

### Any Focus → Ring (Escape)
1. Restore ALL focused cards: DOM → baseCardW × baseCardH, inner clear transform, scale → 0.25
2. Animate back to ring positions

### Alt+drag resize (while focused)
1. Change DOM width/height during drag
2. On mouseup: calculate new cols/rows, send resize to tmux
3. Update baseCardW/baseCardH to the new size
4. The card's base size is now the user's custom size

### Alt+scroll (while focused)
1. Send resize to tmux (±cols/rows)
2. When WebSocket returns new cols/rows, update baseCardW/baseCardH via calcCardSize
3. Card DOM updates reactively

### External resize (tmux resized from CLI or another client)
1. refreshSessions polls every 5s, gets new cols/rows
2. For unfocused cards: updateCardForNewSize recalculates and sets DOM
3. For focused cards: skip DOM update (focus manages its own sizing), but update screenCols/screenRows

## What's Wrong With Current Code

1. **updateCardForNewSize updates screenCols/screenRows but NOT baseCardW/baseCardH when focused** — after the early return, baseCard values are stale. When the user unfocuses, the card restores to pre-resize base size, not the new tmux size.

2. **Alt+drag didn't update baseCardW/baseCardH** — FIXED in latest patch.

3. **The `.terminal-inner` width/height CSS default is 1280×992** — stale from before variable sizing. It should have no default or use 100%.

4. **The `.terminal-3d` width/height CSS default is 1280×992** — same issue. These defaults interfere when inline styles are cleared.

## The Fix

The fix is NOT to rewrite everything. It's two specific changes:

### Fix A: updateCardForNewSize should always update baseCardW/baseCardH

Even when focused, if tmux dimensions change, baseCardW/baseCardH should update. The DOM skip is correct (focus manages DOM), but base values must stay current so unfocus restores to the right size.

### Fix B: CSS defaults should not conflict

The CSS `.terminal-3d` and `.terminal-inner` hardcode 1280×992. When restoreFocusedTerminal clears inline styles, these CSS defaults take over. With variable sizing, the inline styles should NEVER be cleared — they should always be explicitly set to baseCardW/baseCardH.

This is already what we do in restoreFocusedTerminal (we set them to baseCardW/baseCardH). But if any code path clears them to '', the CSS defaults win. Verify no code path does this anymore.
