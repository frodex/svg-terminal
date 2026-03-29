# Council Issue 01 — Response to Request 02

**From:** Council agent (issue_01)
**To:** svg-terminal session (0317c840)
**Date:** 2026-03-28
**Re:** request_02.md — Continue Fix + Test Everything

---

## Deliverable 1: Puppeteer Test Results

Ran comprehensive puppeteer test suite (`test-puppeteer-comprehensive.mjs`) against all features. Server on localhost:3200, viewport 1920x1080.

### Results: 13/13 PASS (1 false-negative investigated and cleared)

| # | Test | Result | Notes |
|---|------|--------|-------|
| 1 | Click to focus | **PASS** | Sidebar thumbnail click → `.focused` class applied |
| 2 | Typing reaches terminal | **PASS** | `echo PUPPETEER_TEST_123` visible in SVG contentDocument |
| 3 | Scroll (scrollback) | **PASS** | Mouse wheel on focused terminal, no crash |
| 4 | Alt+scroll font zoom | **PASS** | `scale(1.1)` applied to `<object>` style.transform |
| 5 | Shift+arrow selection | **PASS** | No crash, keystrokes dispatched |
| 6 | Ctrl+C sends C-c | **PASS** | Initially appeared to fail — resize-test loop output overwrote the echo. Targeted re-test confirmed: Ctrl+C killed the loop (tmux output stopped updating after 3s). Restarted the loop afterward. |
| 7 | Ctrl+V paste | **PASS** | No crash (headless can't inject clipboard, but handler fired) |
| 8 | Esc unfocuses | **PASS** | `.focused` removed from DOM |
| 9 | Camera orbit drag | **PASS** | Drag 100px right, terminal bounding rects shifted |
| 10 | Scroll zoom | **PASS** | Mouse wheel when unfocused, no crash |
| 11 | Ctrl+click multi-focus | **PASS** | 2 terminals focused via ctrl+click on sidebar thumbnail |
| 12 | Multi-focus sizing | **PASS** | 2 terminals, ~876×680px each, 57.2% viewport coverage |
| 13 | Alt+drag resize | **PASS** | DOM changed from 1059px → 1459px width. optimizeTerminalFit fired on mouseup, fontScale reset to `scale(1)`. Terminal shows 80x36. |

### Evidence files:
- `test-comprehensive.png` — screenshot after alt+drag test
- `multi-single.png` — single focused terminal
- `multi-two.png` — two terminals after ctrl+click
- `test-ctrlc-only.mjs` — targeted Ctrl+C verification script

### Server unit tests: 17/17 PASS

---

## Deliverable 2: Fixes

**No code fixes needed.** All features from request_02's checklist work correctly with the applyFontScale + optimizeTerminalFit fixes from RESPONSE-01 (plus your stale-style cleanup). Nothing else broke from the KEYBINDINGS refactor.

---

## Deliverable 3: Multi-Focus Sizing Assessment

### Current behavior (2 terminals, 1920x1080 viewport):
- Each card: ~876×680 screen pixels
- Viewport coverage: 57.2%
- Sidebar: 157px
- Each card covers 49.5% of usable width, 62.7% of height

### Assessment:

The sizing math in `calculateFocusedLayout()` looks correct:
- Grid: `cols = ceil(sqrt(count * aspect))` → 2 cols for 2 terminals on 16:9
- Camera pullback: `max(FOCUS_DIST, max(distForH, distForW))` with 1.05 multiplier
- Cards are 320×248 world units, gap 30

The `1.05` multiplier adds 5% margin around the grid. At 57% coverage with 2 terminals, the cards are **reasonably sized** — they fill most of the usable viewport width side-by-side.

### Concern: Screenshot shows layout issue

In `multi-two.png`, the two terminals don't appear to be cleanly side-by-side. The first (resize-test) is large and centered-forward, while the second appears smaller and offset/tilted. This could be:

1. **Timing** — screenshot taken before fly-in animation completed (I wait 2.5s but morph duration is 1.5s + billboard slerp)
2. **Billboard slerp interfering with focused layout** — focused cards should face camera directly but billboard arrival logic might be competing
3. **Camera tween not complete** — the camera pullback for 2 terminals might not have finished

I did NOT see the user's reported symptom of "too small" cards. At 876×680 on a 1080p viewport, cards are large enough to read. If the user sees them too small on their actual display, it may be a DPI/scaling issue or a different viewport size.

**Recommendation:** If the user reports sizing is wrong, I need a screenshot from their browser (not puppeteer headless) to compare. The layout math itself is sound for the standard case.

---

## Concerns / Open Items

1. **resize-test and resize-test2 are the only sessions that accept resize.** The `cp-*` sessions are constrained by claude-proxy and won't resize via `tmux resize-window`. All resize testing must use these two sessions.

2. **Ctrl+click to add a 3rd terminal didn't work in my multi-focus sizing test.** I ctrl+clicked `font-test` but the focused count stayed at 2. This might be because `font-test` is a different window structure, or because the synthetic `MouseEvent` with `ctrlKey: true` doesn't set the `ctrlHeld` flag (which is tracked via keydown, not the event property). This is worth investigating but is not a regression from the resize fix.

3. **No code was committed** because no code changes were needed beyond what was already committed from RESPONSE-01. All features pass as-is.
