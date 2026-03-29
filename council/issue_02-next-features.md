# Next Features — Ready to Implement

## 1. URL Detection + Browser Cards (Priority)

**Terminal SVG:** Detect URLs (http/https) in terminal text spans. Style them as clickable links (underline, blue).

**Alt+click link:** Creates a new card with `<iframe src="url">` instead of `<object type="image/svg+xml">`. Same card structure — header, controls, drag, resize all work because they're on the card wrapper.

**Implementation:**
- `terminal.svg`: regex URL detection in span text, wrap in `<a>` with `data-url` attribute
- `dashboard.mjs`: detect alt+click on links in terminal SVG, call `addBrowserCard(url)`
- `addBrowserCard(url)`: same as `addTerminal` but `<iframe>` instead of `<object>`, no WebSocket
- Card gets header with URL as title, minimize/close buttons
- Same node model — position, size, drag all inherited

## 2. Cursor Offset Fix

Cursor leading text too far right after resize. Likely `CELL_W` measured once at SVG load, stale after resize changes the viewBox.

## 3. Merge camera-only-test → dev

The camera-only architecture is working. 20/20 E2E. Should merge to dev after user validates crispness.

## 4. localStorage Persistence

Phase 2 of design spec. Save per-terminal fontSize, cardW, cardH. Restore on reload.

## 5. ThinkOrSwim Workspace System

Named workspaces, quick-switch toolbar, color tag bindings.
