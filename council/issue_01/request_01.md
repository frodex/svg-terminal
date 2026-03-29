# Council Issue 01 — Terminal Resize Feature Fix

**From:** svg-terminal session (0317c840) — context-fatigued, needs fresh eyes
**To:** Fresh agent
**Date:** 2026-03-28
**Respond in:** `council/issue_01/request_01-RESPONSE-01.md`

---

## The Problem

I implemented a terminal resize feature (font zoom, optimize fit, alt+drag resize) but got lost in coordinate system bugs. The feature is broken. I need you to fix `applyFontScale()` and `optimizeTerminalFit()` in `/srv/svg-terminal/dashboard.mjs`.

## Background — READ FIRST

1. **Read `/srv/svg-terminal/docs/handoff-resize-fix.md`** — full explanation of what's broken and why
2. **Read the header comments (notes 1-8) in `/srv/svg-terminal/dashboard.mjs`** — critical anti-patterns
3. **Read `/srv/svg-terminal/resume-agent.md`** — full project context

## What I need from you

### 1. Fix `applyFontScale(t)` (~line 170 in dashboard.mjs)

**Current behavior:** Adjusts `<object>` width/height to prevent overflow, which causes SVG to rescale DOWN (text gets smaller — opposite of intent).

**Correct behavior:** Apply `transform: scale(fontScale)` with `transform-origin: 0 0` on the `<object>`. Do NOT adjust width/height. Let the overflow be clipped by `.terminal-3d` which has `overflow: hidden`. Text gets BIGGER when fontScale > 1, SMALLER when < 1. Fewer lines visible when zoomed in — that's correct (like browser zoom).

### 2. Fix `optimizeTerminalFit(t, sessionName)` (~line 182 in dashboard.mjs)

**Current behavior:** Uses `renderInfo.cols / scale` which gives more cols at higher font scale — backwards.

**Correct behavior:** Calculate how many cols/rows fit at the current font scale:
- Use `getTermRenderInfo(t)` to get rendered pixel area and cell sizes
- `new_cols = Math.round(renderInfo.cols / fontScale)`
- `new_rows = Math.round(renderInfo.rows / fontScale)`
- Wait — that's the same thing. Let me think...

Actually: `getTermRenderInfo` returns the CURRENT cols/rows based on the SVG viewBox. These are the terminal's actual dimensions. When fontScale is 1.5 (zoomed in), the user sees fewer cols/rows because text is bigger. Optimize should resize the PTY so the zoomed view fills the card exactly:
- Visible cols at fontScale = current_cols / fontScale
- Visible rows at fontScale = current_rows / fontScale
- But we want the terminal to have EXACTLY that many cols/rows (so zoomed view fills card)
- So: `new_cols = Math.round(current_cols / fontScale)`, `new_rows = Math.round(current_rows / fontScale)`
- Then reset fontScale to 1.0 (the terminal now has the right number of cols/rows to fill the card at normal scale)

Send `{ type: 'resize', cols: new_cols, rows: new_rows }` via WebSocket. Server runs `tmux resize-window`.

### 3. Verify alt+drag card resize works

The `onMouseMove` handler with `dragMode === 'resize'` changes the terminal DOM width/height. On mouseup, `optimizeTerminalFit` is called. If optimize is fixed, this should work.

### 4. Verify alt+scroll font zoom works

The KEYBINDINGS dispatch works (tested in puppeteer). It calls `applyFontScale`. If applyFontScale is fixed, this should work.

## Constraints — DO NOT VIOLATE

- **4x scale trick MUST be preserved.** DOM is 1280×992, CSS3DObject scale 0.25. fontScale is a SEPARATE CSS transform on the `<object>` child. Do not touch the DOM dimensions or CSS3DObject scale for font zoom.
- **Resize sends cols/rows, never pixels.** Server uses `tmux resize-window`.
- **Test in puppeteer before claiming it works.** The user is frustrated with untested changes.
- Run `cd /srv/svg-terminal && node --test test-server.mjs` — all 17 tests must pass.

## Test sessions

`resize-test` and `resize-test2` are tmux sessions that print their size every 2 seconds:
```
Size: 80x24 @ 14:30:05
```
Use these to verify resize actually changes the terminal dimensions.

## How to test in puppeteer

```js
const puppeteer = require('puppeteer');
// ... launch, navigate to http://localhost:3200/
// Focus a terminal via thumbnail click
// Test alt+scroll: page.keyboard.down('Alt'); page.mouse.wheel({deltaY: -300}); page.keyboard.up('Alt');
// Check: document.querySelector('.focused object').style.transform should show scale(>1)
// Test optimize button: click the ⊡ button in the controls overlay
// Check: terminal should resize (verify via the resize-test session output)
```

## Deliverables

1. Fixed `applyFontScale()` — just CSS scale, no width/height adjustment
2. Fixed `optimizeTerminalFit()` — correct cols/rows calculation
3. Puppeteer test results proving it works
4. Commit with descriptive message

Respond in `council/issue_01/request_01-RESPONSE-01.md` with:
- What you changed (exact code)
- Puppeteer test results
- Any concerns or questions
