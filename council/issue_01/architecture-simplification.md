# Architecture Simplification: Camera-Only Focus

**Date:** 2026-03-29
**Status:** Proposal
**Problem:** Focus changes DOM size, creating parallel state that every operation must handle

---

## The Bug Pattern

Every feature that touches card sizing breaks something else:
- Alt+drag during focus: inner scale transform prevents content from filling
- +/- during focus: should it reshape the card? Both answers cause problems
- Optimize during focus: which direction? Card fights terminal
- Unfocus: must restore exact pre-focus state or dimensions mutate
- Title bar drag: text selection capture-phase intercepts mousedown
- Header buttons: intercept mousedown, breaking title bar drag

All trace to ONE root cause: focus changes the DOM, creating a state that differs from the ring state.

## Current Architecture (Two States)

```
Ring state:
  DOM = baseCardW × baseCardH
  inner = baseCardW × baseCardH, no transform
  css3dObject.scale = 0.25

Focus state:
  DOM = screenW × screenH (viewport-filling)
  inner = baseW × baseH, transform: scale(innerScale)
  css3dObject.scale = worldH / screenH (variable)
```

Every operation must ask "am I focused?" and handle both states.

## Proposed Architecture (One State)

```
Always:
  DOM = baseCardW × baseCardH
  inner = baseCardW × baseCardH, no transform
  css3dObject.scale = 0.25

Focus = camera moves closer to the card
Unfocus = camera moves back to ring view
```

The card NEVER changes. The camera changes. The card appears bigger on screen because the camera is closer. This is already how the frustum layout works for multi-focus.

## What Changes

### focusTerminal(sessionName)
BEFORE: Resize DOM to fill viewport, set inner scale, recalculate css3dObject scale, morph position to center.
AFTER: Morph card position to center (z=0), camera flies to distance where card fills viewport. Done.

### restoreFocusedTerminal(name)
BEFORE: Restore DOM to baseCardW/baseCardH, clear inner transform, reset css3dObject scale.
AFTER: Nothing to restore on the card. It never changed. Just close WebSocket and morph back to ring.

### addToFocus(sessionName)
BEFORE: Reset all existing focused cards' DOM to baseCardW/baseCardH, clear transforms.
AFTER: Nothing to reset. Cards are already at base size. Just add to focused set and recalculate layout.

### calculateFocusedLayout()
BEFORE: Complex frustum projection with screen pixel allocation.
AFTER: Same frustum projection — cards at base size, camera positioned to see them all.

### updateCardForNewSize(t, newCols, newRows)
BEFORE: Must check if focused to decide whether to update DOM.
AFTER: Always update DOM. Card is always at base size. No focus check needed.

### Alt+drag
BEFORE: Changes DOM, clears inner transform, updates baseCardW/baseCardH.
AFTER: Changes baseCardW/baseCardH and DOM directly. No transform to clear. No state difference.

### +/- buttons
BEFORE: Send resize to tmux. updateCardForNewSize must decide whether to reshape card.
AFTER: Send resize to tmux. Card reshapes or not based on clear, simple logic (not focus-dependent).

## What We Lose

1:1 pixel mapping on single focus. The DOM has fewer pixels when the card stays at base size. Chrome rasterizes the base-size DOM, then the 3D transform scales it up on screen.

## Why It Might Be Fine

- The 4x trick already gives 4x resolution. A 1400px-wide card at 4x has 5600 effective pixels of width for text rasterization. That's plenty.
- The frustum depth means the card is at the exact Z where its world size maps to the right screen size. Chrome's compositor handles the perspective projection.
- We can test this visually — if text is noticeably less crisp, we reconsider. If it's equivalent, we've eliminated an entire category of bugs.

## Implementation Plan

1. Remove DOM resizing from focusTerminal — just position + camera
2. Remove DOM restoring from restoreFocusedTerminal — just morph back
3. Remove DOM resetting from addToFocus
4. Remove inner.style.transform from all code paths
5. Remove focus-state checks from updateCardForNewSize
6. Test crispness visually
7. If acceptable, clean up all dead code
8. Run E2E tests
