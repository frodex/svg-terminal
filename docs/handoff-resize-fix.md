# Handoff: Terminal Resize Feature — Fix Required

**Date:** 2026-03-28
**From:** svg-terminal session (0317c840)
**Status:** Broken — needs fresh eyes

---

## What exists and works (DO NOT TOUCH)

- 3D dashboard with Three.js CSS3DRenderer
- WebSocket streaming (server polls tmux at 30ms, pushes deltas)
- Direct keystroke capture (document-level keydown → tmux send-keys)
- Text selection (drag on focused terminal, Ctrl+C to copy, Ctrl+V to paste)
- Scrollback (scroll wheel → server-side offset → capture-pane -S/-E)
- Multi-focus (Ctrl+click thumbnails)
- Camera controls (drag orbit, shift+drag pan, ctrl+drag rotate, scroll zoom)
- Atomic tmux capture (cursor + content in one call)
- 4x scale trick: DOM 1280x992, CSS3DObject scale 0.25 — DO NOT CHANGE

## What's broken (the resize feature)

A KEYBINDINGS config and resize system were added but are not working correctly:

### Issues:
1. **Font zoom (+/- buttons and alt+scroll)**: `applyFontScale()` adjusts the `<object>` width/height to prevent overflow, but this causes the SVG to rescale DOWN (text gets smaller, opposite of intent). The fix: just `transform: scale(fontScale)` on the `<object>` with `transform-origin: 0 0`, let it overflow, `.terminal-3d` has `overflow: hidden` to clip it.

2. **Optimize button**: `optimizeTerminalFit()` calculates cols/rows wrong. Uses `renderInfo.cols / scale` which is backwards — at fontScale > 1 (zoomed in) you want FEWER cols, not more. Should be: read the `<object>` rendered pixel area, divide by cell pixel size × fontScale to get cols/rows.

3. **Alt+drag card resize**: Changes DOM width/height but doesn't update the title bar (header is inside the same container so it should auto-adjust — investigate why not). On mouseup calls optimizeTerminalFit which has the wrong calculation.

4. **Alt+scroll**: The KEYBINDINGS system dispatches correctly (tested in puppeteer — `getScrollAction` returns `fontZoom`), but `applyFontScale` has the bug described in #1.

5. **+/- buttons**: Were moved from CSS3DObject DOM to a fixed HTML overlay (`term-controls-bar`). The overlay works in puppeteer but user reports they "twitch but don't change" — the font scale IS changing but the visual effect is wrong because of the applyFontScale bug.

6. **Server resize**: Uses `tmux resize-window` (not `resize-pane` — pane doesn't work). Server handler exists and works. The WebSocket message is `{ type: 'resize', cols, rows }`.

### The coordinate system problem:

There are 4 coordinate spaces:
1. **SVG viewBox**: `cols * CELL_W` × `rows * CELL_H` (e.g., 1038 × 680 for 120×40 terminal)
2. **4x DOM pixels**: 1280 × 992 (the terminal-3d element)
3. **CSS3DObject world units**: 320 × 248 (DOM × 0.25 scale)
4. **Screen pixels**: whatever the browser renders after the 3D transform

`getTermRenderInfo()` correctly calculates the rendered SVG area within the `<object>` including aspect ratio correction. It returns `{ left, top, cellW, cellH, cols, rows }` in screen pixels.

The font scale should be a VISUAL-ONLY CSS transform that doesn't interact with any of these coordinate systems. It just makes the rendered SVG bigger/smaller within the clipped container.

The optimize/resize calculation should use `getTermRenderInfo()` to get rendered pixel area and cell sizes, then: `new_cols = rendered_width / (rendered_cellW * fontScale)`, `new_rows = rendered_height / (rendered_cellH * fontScale)`.

## Files to modify

- `/srv/svg-terminal/dashboard.mjs` — fix `applyFontScale()`, fix `optimizeTerminalFit()`, fix alt+drag resize
- `/srv/svg-terminal/server.mjs` — resize handler exists and works, no changes needed

## Key functions:

- `applyFontScale(t)` ~line 170 — needs rewrite
- `optimizeTerminalFit(t, sessionName)` ~line 182 — needs rewrite
- `getTermRenderInfo(t)` ~line 1480 — works correctly, use it
- `onWheel` ~line 751 — KEYBINDINGS dispatch works, just the applyFontScale call target is broken
- `onMouseMove` resize drag branch — needs to also resize PTY on completion
- `onMouseUp` — calls optimizeTerminalFit on resize drag end

## Critical constraints:

- READ dashboard.mjs header notes 1-8 before changing anything
- 4x scale trick (1280×992 DOM, 0.25 CSS3DObject scale) MUST be preserved
- fontScale is a SEPARATE CSS transform from the 4x trick
- Resize sends cols/rows to server, NEVER pixel dimensions
- Server uses `tmux resize-window` not `resize-pane`
- `.terminal-3d` has `overflow: hidden` — font zoom should overflow and clip

## Test sessions:

`resize-test` and `resize-test2` are tmux sessions not constrained by claude-proxy. They print their size every 2 seconds so you can see resize take effect. Use these for testing.

## How to test:

```bash
cd /srv/svg-terminal && node --test test-server.mjs  # 17 tests should pass
```

For visual testing use puppeteer — see examples in the codebase at various `/srv/svg-terminal/debug-*.png` screenshots.
