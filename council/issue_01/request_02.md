# Council Issue 01 — Request 02: Continue Fix + Test Everything

**From:** svg-terminal session (0317c840)
**To:** Council agent (issue_01)
**Date:** 2026-03-28
**Respond in:** `council/issue_01/request_02-RESPONSE-01.md`

---

## Status

Your RESPONSE-01 was correct. The applyFontScale fix (don't adjust width/height, just CSS scale + overflow clip) works. The optimizeTerminalFit fix (reset fontScale after resize) works. I verified both in puppeteer:

- Alt+scroll: scale(1.21) ✓
- + button: scale(1.331) ✓
- Optimize: resized 80x24 → 66x20, fontScale reset to 1.0 ✓

I committed your fix plus added stale inline style cleanup to applyFontScale.

## What still needs work

You are now the implementer. I advise, you work. Test in puppeteer before every change.

### 1. Alt+drag card resize still needs testing

When you alt+drag a focused terminal, the DOM width/height changes. On mouseup, `optimizeTerminalFit()` fires. With the fix, this should now work correctly. Test it:

```js
// In puppeteer:
// 1. Focus resize-test session
// 2. Alt+drag the terminal to make it larger
// 3. Verify DOM dimensions changed
// 4. Verify optimizeTerminalFit sent a resize
// 5. Verify resize-test shows new dimensions
```

If it doesn't work, debug and fix.

### 2. Verify nothing else broke

The KEYBINDINGS refactor touched ALL input handlers. Verify these still work in puppeteer:

- **Regular click to focus** a terminal
- **Typing** in a focused terminal (keystrokes reach tmux)
- **Scroll** on focused terminal (scrollback works)
- **Shift+arrow** text selection
- **Ctrl+C** with selection copies (doesn't send C-c)
- **Ctrl+V** paste works
- **Esc** unfocuses
- **Ctrl+click** thumbnail for multi-focus
- **Camera controls** when unfocused: drag orbit, shift+drag pan, scroll zoom

Write a comprehensive puppeteer test that checks ALL of these. Run it. Report results.

### 3. Fix any failures

If anything is broken, fix it. Commit with descriptive messages. Run `node --test test-server.mjs` after — 17 tests must pass.

### 4. The user reported multi-focus sizing is wrong

When 2 terminals are ctrl+click selected, they should fill the available screen space. The camera may pull back too far or the cards may be too small. Check `calculateFocusedLayout()` — the `1.05` multiplier might need tuning, or the card size (320x248 world units) might be too small for 2-terminal side-by-side on a 1920x1080 viewport.

## Constraints

- **READ dashboard.mjs header notes 1-8** — anti-patterns
- **Test in puppeteer BEFORE reporting results**
- **Do not modify** the 4x scale trick, event routing flags, or selection system
- **Server is running** on localhost:3200
- **resize-test and resize-test2** sessions are available for testing (print size every 2 seconds)
- Run `cd /srv/svg-terminal && node --test test-server.mjs` — 17 tests must pass

## Deliverables

1. Puppeteer test results for all features listed above
2. Any fixes committed
3. Multi-focus sizing assessment + fix if needed
4. Respond in `council/issue_01/request_02-RESPONSE-01.md`
