# Selection Bug Fixes — Implementation Plan (v3 — Fade on Release)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **REQUIRED READING before any work:** /srv/PHAT-TOAD-with-Trails/steward/system.md, /srv/PHAT-TOAD-with-Trails/steward/agent-handoff.md, /srv/PHAT-TOAD-with-Trails/steward/advice-for-new-agents/READ-THIS-FIRST.md

**Goal:** Fix selection triggering from thumbnails, add minimum drag distance to prevent accidental selections, and add fade-out animation on release.

**Architecture:** Selection is ephemeral — auto-copies to clipboard on mouseup, flashes bright, fades to transparent over 2 seconds, then clears. No persistent capture state. No scroll tracking. Bounds check prevents selection starting from outside the terminal body.

**Tech Stack:** No new dependencies. Changes to `dashboard.mjs` only.

**Journal:** `docs/research/2026-03-30-v0.5-selection-bugs-journal.md`

---

## Constraint Declaration

| Constraint | Why | Breaks if violated |
|-----------|-----|-------------------|
| Coordinate-based hit testing only | CSS3D ignores Z depth (PRD §6.3) | Wrong card intercepts |
| Selection highlight in SVG sel-layer via contentDocument | Must align with SVG text coordinates | Misaligned highlight |
| `selTerminal = null` on mouseup | Stops mousemove from extending after release | "Keeps dragging" bug |
| Auto-copy on mouseup | User expects clipboard populated immediately | Must re-select to copy |

---

### Task 1: Bounds check — selection only starts on terminal body

**Files:** `dashboard.mjs`

- [ ] **Step 1:** In the capture-phase mousedown handler (line ~2593), after `const t = terminals.get(activeInputSession);` and `if (!t) return;`, add:

```javascript
  // Don't start selection if click is outside the focused terminal's card body
  var selObj = t.dom ? t.dom.querySelector('object') : null;
  if (selObj) {
    var selObjRect = selObj.getBoundingClientRect();
    if (e.clientX < selObjRect.left || e.clientX > selObjRect.right ||
        e.clientY < selObjRect.top || e.clientY > selObjRect.bottom) return;
  }
```

- [ ] **Step 2:** Also store pixel start position for drag distance check:

```javascript
  t._selDragStartX = e.clientX;
  t._selDragStartY = e.clientY;
```

- [ ] **Step 3:** Commit:
```bash
git add dashboard.mjs
git commit -m "fix: selection only starts on focused terminal body, not sidebar"
```

---

### Task 2: Minimum drag distance — prevent accidental selections

**Files:** `dashboard.mjs`

- [ ] **Step 1:** In the mouseup handler (line ~2635), replace the `isRealSelection` check:

FROM:
```javascript
  const isRealSelection = selStart && selEnd && (selStart.row !== selEnd.row || selStart.col !== selEnd.col);
```

TO:
```javascript
  var isRealSelection = false;
  if (selStart && selEnd) {
    var t2 = terminals.get(activeInputSession);
    if (t2) {
      var dx = e.clientX - (t2._selDragStartX || 0);
      var dy = e.clientY - (t2._selDragStartY || 0);
      var pixelDist = Math.sqrt(dx * dx + dy * dy);
      var renderInfo = getTermRenderInfo(t2);
      var minDragPx = renderInfo ? renderInfo.cellW * 1.5 : 15;
      isRealSelection = pixelDist > minDragPx;
    }
  }
```

- [ ] **Step 2:** Commit:
```bash
git add dashboard.mjs
git commit -m "fix: require minimum drag distance (1.5 cells) to start text selection"
```

---

### Task 3: Fade animation on mouseup

**Files:** `dashboard.mjs`

- [ ] **Step 1:** In the mouseup handler, in the `isRealSelection` branch, AFTER copying to clipboard and drawing the final highlight, add the fade animation:

Replace the current real-selection block:
```javascript
  if (isRealSelection) {
    const text = getSelectedTextFromSvg(selTerminal);
    if (text) {
      copyToClipboard(text);
    }
  }

  // Stop the selection drag
  selTerminal = null;
  // Keep selStart/selEnd/highlight visible for Ctrl+C. clearSel() on next keystroke.
  suppressNextClick = true;
```

WITH:
```javascript
  if (isRealSelection) {
    if (selEnd) drawSelHighlight(selTerminal);
    var text = getSelectedTextFromSvg(selTerminal);
    if (text) {
      copyToClipboard(text);
    }
    // Flash bright then fade out over 2 seconds
    var fadeTerminal = selTerminal;
    var layer = getSelOverlay(fadeTerminal);
    if (layer) {
      // Flash to bright
      for (var i = 0; i < layer.children.length; i++) {
        layer.children[i].setAttribute('fill', 'rgba(200, 200, 255, 0.6)');
      }
      // Fade out
      var fadeStart = performance.now();
      function fade() {
        var elapsed = performance.now() - fadeStart;
        var progress = Math.min(1, elapsed / 2000);
        var opacity = 0.6 * (1 - progress);
        for (var j = 0; j < layer.children.length; j++) {
          layer.children[j].setAttribute('opacity', String(opacity));
        }
        if (progress < 1) {
          requestAnimationFrame(fade);
        } else {
          clearSel();
        }
      }
      requestAnimationFrame(fade);
    } else {
      clearSel();
    }
  } else {
    clearSel();
  }

  selTerminal = null;
  suppressNextClick = true;
```

- [ ] **Step 2:** Remove the keystroke-clear handler. Find the `document.addEventListener('keydown', function(e) {` block near line 2677 that calls `clearSel()` on non-modifier keys. Remove or comment out the entire handler — selection now clears via fade, not keystroke.

- [ ] **Step 3:** Also remove the `clearSel()` call from the Ctrl+C handler. Ctrl+C with no selection should just send C-c to the terminal. The selection is already gone (faded out).

In the main keydown handler, the Ctrl+C block becomes:
```javascript
  if (e.ctrlKey && e.key.toLowerCase() === 'c') {
    // No persistent selection — just send C-c to terminal
    t.sendInput({ type: 'input', keys: e.key.toLowerCase(), ctrl: true });
    return;
  }
```

Wait — the original Ctrl+C also checks for browser text selection (selStart). Since selections now fade out, by the time the user presses Ctrl+C the selection is probably gone. But if they're fast (within 2 seconds), we should still check. Actually, the auto-copy on mouseup already put it on the clipboard. Ctrl+C within the fade window should just send C-c to the terminal — the text is already copied.

Simplify:
```javascript
  if (e.ctrlKey && e.key.toLowerCase() === 'c') {
    t.sendInput({ type: 'input', keys: e.key.toLowerCase(), ctrl: true });
    return;
  }
```

- [ ] **Step 4:** Commit:
```bash
git add dashboard.mjs
git commit -m "feat: selection fades out over 2s after auto-copy, remove keystroke-clear"
```

---

### Task 4: Fix clearSel to actually remove SVG rects

**Files:** `dashboard.mjs`

The current `clearSel` function may not clear the SVG sel-layer rects because `selOverlay` may be null. It needs to actually reach into the contentDocument.

- [ ] **Step 1:** Read the current `clearSel` function and `getSelOverlay` function. Verify whether `selOverlay` is ever set.

- [ ] **Step 2:** Fix `clearSel` to clear the SVG sel-layer via contentDocument:

```javascript
function clearSel() {
  // Clear the SVG sel-layer rects on the terminal that had the selection
  if (selStart && activeInputSession) {
    var t = terminals.get(activeInputSession);
    if (t) {
      var layer = getSelOverlay(t);
      if (layer) while (layer.firstChild) layer.removeChild(layer.firstChild);
    }
  }
  selTerminal = null;
  selStart = null;
  selEnd = null;
}
```

- [ ] **Step 3:** Commit:
```bash
git add dashboard.mjs
git commit -m "fix: clearSel actually removes SVG sel-layer rects via contentDocument"
```

---

### Task 5: Run tests + manual verification

- [ ] **Step 1:** Run all tests:
```bash
node --test test-server.mjs && node --test test-auth.mjs && node test-dashboard-e2e.mjs
```

- [ ] **Step 2:** Manual test matrix:

- [ ] Click on sidebar thumbnail with focused terminal → NO selection appears
- [ ] Small mouse wiggle on click (< 1.5 cells) → treated as click, no selection
- [ ] Real drag on terminal body → selection highlight appears + text on clipboard
- [ ] Release mouse → highlight flashes bright then fades over 2 seconds
- [ ] After fade → highlight gone, no trace
- [ ] Paste in another app → selected text pastes correctly
- [ ] Ctrl+C after fade → sends C-c to terminal (no selection interference)
- [ ] Click-to-move-cursor still works (short click, no drag)

- [ ] **Step 3:** Commit any fixes

---

## References

### Research Journals (reasoning trail for how we arrived at this design)

| Version | File | Key Content |
|---------|------|-------------|
| v0.1 | `docs/research/2026-03-30-v0.1-selection-bugs-journal.md` | Initial bug analysis: sidebar triggering selection (missing bounds check), highlight persisting after release (user likes), highlight not surviving scroll. Root cause analysis of all 3 bugs. |
| v0.2 | `docs/research/2026-03-30-v0.2-selection-bugs-journal.md` | User rejected re-read approach for copy. Introduced "capture once, store as string" model. State map of all situations (new output, scroll, resize, focus/unfocus). User workflow: select → switch to Word → paste → come back → Ctrl+C re-copy. Led to per-terminal `textCaptureValue` concept. |
| v0.3 | `docs/research/2026-03-30-v0.3-selection-bugs-journal.md` | Per-terminal capture model (`textCaptureActive`, `textCaptureValue`). Minimum drag distance (1.5 cell widths) to prevent accidental 1-char selections. State transition table. Clear conditions defined. Workflow verification. |
| v0.4 | `docs/research/2026-03-30-v0.4-selection-bugs-journal.md` | Two new issues: typing doesn't clear selection (possible `clearSel` bug — `selOverlay` may be null, SVG rects never removed). New output doesn't move selection (fundamentally different from scroll — needs `baseY`/`historySize` from server). Four approaches evaluated for output tracking. |
| v0.5 | `docs/research/2026-03-30-v0.5-selection-bugs-journal.md` | **Direction confirmed.** User concluded: if we can't track new output moving content, clear on mouseup with fade animation. Abandoned persistent capture. Final design: auto-copy → flash bright → 2s fade → clear. Simplest approach that gives good UX feedback. |

### Key Design Decisions and Who Made Them

| Decision | Who | Journal |
|----------|-----|---------|
| Highlight should stay after release | User (liked the behavior) | v0.1 |
| Capture text once, never re-read | User ("no re-read required unless new selection") | v0.2 |
| Per-terminal capture, not global | User ("terminal as object, stores text-capture-active") | v0.3 |
| Minimum drag distance for selection | User ("prevent single character selections, minimum > 1 char < 1.5 char width") | v0.3 |
| Typing should NOT clear selection | User ("selecting then typing does not clear... makes sense to me") | v0.4 |
| New output must move selection, or clear it | User ("if we don't clear the selection we MUST track it") | v0.4 |
| Can't track new output → clear on mouseup with fade | User ("clear the selection on MOUSE UP but use a 2 second fade") | v0.5 |
| Flash bright gray then fade to transparent | User ("flash the highlight on mouse up to a bright gray and fade to transparent before it's removed") | v0.5 |
| Clipboard retains text until user replaces | User ("the clip stays in keyboard buffer until replaced by user") | v0.5 |

### Plan Version History

| Version | Status | Notes |
|---------|--------|-------|
| v1 | In `selection-fixes-NOTES-01a.md` | User's annotated copy with feedback |
| v2 | **LOST** — overwritten by v3 (violated no-mutate rule) | Had per-terminal persistent capture, scroll-aware highlight, Ctrl+C re-copy |
| v3 | Current file | Simplified: fade-on-release, no persistent state, no scroll tracking |
