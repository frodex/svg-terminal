# Terminal Resize + Keybinding Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add terminal resize (font zoom + PTY resize) with title bar controls, Alt+wheel font zoom, Alt+drag card resize, and refactor all input bindings into a central keybinding config.

**Architecture:** Central `KEYBINDINGS` config replaces all hardcoded modifier checks. Font zoom is CSS scale on the terminal inner content. PTY resize sends `tmux resize-pane`. Title bar gets interactive +/- and optimize buttons.

**Tech Stack:** Three.js CSS3DRenderer, existing WebSocket, tmux resize-pane

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `dashboard.mjs` | Modify | KEYBINDINGS config, refactor input handlers, font scale, resize, title bar controls |
| `dashboard.css` | Modify | Title bar button styles |
| `server.mjs` | Modify | Handle resize WebSocket message → tmux resize-pane |

---

## Task 1: Central KEYBINDINGS config

**Files:**
- Modify: `/srv/svg-terminal/dashboard.mjs`

Replace all hardcoded modifier checks with a central config that all handlers reference.

- [ ] **Step 1: Add KEYBINDINGS config after SPECIAL_KEY_MAP**

After the `SPECIAL_KEY_MAP` definition (~line 103), add:

```js
// === Keybinding Config ===
// ALL input mappings are defined here. No hardcoded modifier checks elsewhere.
// To remap: change this config. Future: per-user preferences load into this.
// context: 'focused' = terminal focused, 'unfocused' = overview, 'any' = both
const KEYBINDINGS = {
  // Mouse drag actions (button 0 = left, 2 = right)
  orbit:         { mouse: 0, modifier: null,    context: 'unfocused', desc: 'Orbit camera' },
  selectText:    { mouse: 0, modifier: null,    context: 'focused',   desc: 'Select text' },
  resize:        { mouse: 0, modifier: 'alt',   context: 'focused',   desc: 'Resize terminal' },
  dollyXY:       { mouse: 0, modifier: 'shift', context: 'any',       desc: 'Pan X / Y' },
  rotateOrigin:  { mouse: 0, modifier: 'ctrl',  context: 'any',       desc: 'Rotate origin' },
  orbitRight:    { mouse: 2, modifier: null,     context: 'any',       desc: 'Orbit (right-click)' },
  orbitMiddle:   { mouse: 1, modifier: null,     context: 'any',       desc: 'Pan (middle-click)' },

  // Scroll actions
  scrollContent: { wheel: true, modifier: null,    context: 'focused',   desc: 'Scroll terminal' },
  fontZoom:      { wheel: true, modifier: 'alt',   context: 'focused',   desc: 'Font zoom' },
  zoomFOV:       { wheel: true, modifier: null,    context: 'unfocused', desc: 'Zoom' },
  zoomFOVCtrl:   { wheel: true, modifier: 'ctrl',  context: 'any',       desc: 'Zoom' },
  dollyZ:        { wheel: true, modifier: 'shift', context: 'any',       desc: 'Dolly' },

  // Keyboard shortcuts
  unfocus:       { key: 'Escape', modifier: null, context: 'focused',   desc: 'Unfocus' },
  help:          { key: '?',      modifier: null, context: 'unfocused', desc: 'Toggle help' },
};
```

- [ ] **Step 2: Add helper function to match keybindings**

```js
// Check if an event matches a keybinding entry
function matchBinding(binding, e, isFocused) {
  // Context check
  if (binding.context === 'focused' && !isFocused) return false;
  if (binding.context === 'unfocused' && isFocused) return false;

  // Modifier check
  if (binding.modifier === 'alt' && !e.altKey) return false;
  if (binding.modifier === 'shift' && !e.shiftKey) return false;
  if (binding.modifier === 'ctrl' && !(e.ctrlKey || ctrlHeld)) return false;
  if (binding.modifier === null && (e.altKey || e.shiftKey || e.ctrlKey)) return false;

  return true;
}

// Find which drag action an event maps to
function getDragAction(e, isFocused) {
  if (e.button === 2) return 'orbitRight';
  if (e.button === 1) return 'orbitMiddle';
  for (const [name, b] of Object.entries(KEYBINDINGS)) {
    if (b.mouse === undefined || b.mouse !== e.button) continue;
    if (!b.wheel && matchBinding(b, e, isFocused)) return name;
  }
  return null;
}

// Find which scroll action an event maps to
function getScrollAction(e, isFocused) {
  for (const [name, b] of Object.entries(KEYBINDINGS)) {
    if (!b.wheel) continue;
    if (matchBinding(b, e, isFocused)) return name;
  }
  return null;
}
```

- [ ] **Step 3: Refactor onMouseDown to use getDragAction**

Replace the hardcoded modifier chain in `onMouseDown` (~lines 380-438) with:

```js
function onMouseDown(e) {
  const sidebar = document.getElementById('sidebar');
  mouseDownOnSidebar = sidebar && sidebar.contains(e.target);
  const isFocused = focusedSessions.size > 0;

  if (e.button === 0) {
    const action = getDragAction(e, isFocused);

    if (action === 'selectText') {
      // Text selection — handled by selection mousedown handler below
      return;
    } else if (action === 'resize') {
      isDragging = true;
      dragMode = 'resize';
      dragDistance = 0;
      dragStart.x = e.clientX;
      dragStart.y = e.clientY;
      e.preventDefault();
    } else if (action === 'rotateOrigin') {
      isDragging = true;
      dragMode = 'ctrlPending';
      dragDistance = 0;
      dragStart.x = e.clientX;
      dragStart.y = e.clientY;
    } else if (action === 'dollyXY') {
      isDragging = true;
      dragMode = 'dollyXY';
      dragStart.x = e.clientX;
      dragStart.y = e.clientY;
      e.preventDefault();
    } else if (action === 'orbit') {
      isDragging = true;
      dragMode = 'orbit';
      dragDistance = 0;
      syncOrbitFromCamera();
      dragStart.x = e.clientX;
      dragStart.y = e.clientY;
      e.preventDefault();
    }
  } else if (e.button === 1) {
    isDragging = true;
    dragMode = 'dollyXY';
    dragStart.x = e.clientX;
    dragStart.y = e.clientY;
    e.preventDefault();
  } else if (e.button === 2) {
    isDragging = true;
    dragMode = 'orbit';
    dragStart.x = e.clientX;
    dragStart.y = e.clientY;
    syncOrbitFromCamera();
    e.preventDefault();
  }
}
```

- [ ] **Step 4: Refactor onWheel to use getScrollAction**

Replace the hardcoded modifier chain in `onWheel` (~lines 600-637) with:

```js
function onWheel(e) {
  e.preventDefault();
  const delta = e.deltaY;
  const isFocused = focusedSessions.size > 0;
  const action = getScrollAction(e, isFocused);

  if (action === 'scrollContent' && activeInputSession) {
    const t = terminals.get(activeInputSession);
    if (t) {
      if (e.altKey) {
        // Alt+scroll when focused but scrollContent matched — shouldn't happen
        // with correct config, but fallback
        const key = delta > 0 ? 'Down' : 'Up';
        t.sendInput({ type: 'input', specialKey: key });
      } else {
        const absDelta = Math.abs(delta);
        const step = absDelta > 300 ? 12 : absDelta > 150 ? 6 : absDelta > 50 ? 3 : 1;
        t.scrollBy(delta < 0 ? step : -step);
      }
    }
    return;
  }

  if (action === 'fontZoom' && activeInputSession) {
    const t = terminals.get(activeInputSession);
    if (t) {
      const scaleDelta = delta > 0 ? 0.9 : 1.1;
      t.fontScale = (t.fontScale || 1.0) * scaleDelta;
      t.fontScale = Math.max(0.3, Math.min(3.0, t.fontScale));
      applyFontScale(t);
    }
    return;
  }

  if (action === 'dollyZ') {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    camera.position.addScaledVector(dir, -delta * 0.5);
    orbitDist = camera.position.distanceTo(currentLookTarget);
    camera.lookAt(currentLookTarget);
    return;
  }

  // Default: zoom FOV
  camera.fov = Math.max(10, Math.min(120, camera.fov + delta * 0.05));
  camera.updateProjectionMatrix();
}
```

- [ ] **Step 5: Refactor selection mousedown to use matchBinding**

Replace the hardcoded check in the selection mousedown handler (~line 1601-1605):

```js
document.addEventListener('mousedown', function(e) {
  if (e.button !== 0) return;
  if (!matchBinding(KEYBINDINGS.selectText, e, focusedSessions.size > 0)) return;
  if (!activeInputSession) return;
```

- [ ] **Step 6: Refactor onSceneClick modifier checks**

Replace `if (suppressNextClick || ctrlHeld || e.ctrlKey || altHeld)` (~line 552) with:

```js
  if (suppressNextClick || ctrlHeld || e.ctrlKey || altHeld || e.altKey) {
    suppressNextClick = false;
    return;
  }
```

(Keep this as-is — the scene click suppression is about event routing, not keybindings.)

- [ ] **Step 7: Update help panel to auto-generate from KEYBINDINGS**

In the `init()` function, after the help panel event listeners, auto-populate the help controls:

```js
// Auto-generate help panel from KEYBINDINGS
const helpControls = document.querySelector('.help-controls');
if (helpControls) {
  helpControls.innerHTML = '';
  const seen = new Set();
  for (const [name, b] of Object.entries(KEYBINDINGS)) {
    if (seen.has(b.desc)) continue;
    seen.add(b.desc);
    let kbd = '';
    if (b.modifier) kbd += b.modifier.charAt(0).toUpperCase() + b.modifier.slice(1) + ' + ';
    if (b.mouse !== undefined) kbd += 'Drag';
    else if (b.wheel) kbd += 'Scroll';
    else if (b.key) kbd += b.key;
    if (b.context !== 'any') kbd += ' (' + b.context + ')';
    const row = document.createElement('div');
    row.className = 'help-row';
    row.innerHTML = '<kbd>' + kbd + '</kbd><span>' + b.desc + '</span>';
    helpControls.appendChild(row);
  }
  // Add non-keybinding entries
  const extras = [
    ['Ctrl + C', 'Copy selection / Break'],
    ['Ctrl + V', 'Paste to terminal'],
    ['Ctrl + Click', 'Multi-focus'],
    ['Shift + Arrows', 'Select text'],
    ['PgUp / PgDn', 'Page scroll'],
  ];
  for (const [k, d] of extras) {
    const row = document.createElement('div');
    row.className = 'help-row';
    row.innerHTML = '<kbd>' + k + '</kbd><span>' + d + '</span>';
    helpControls.appendChild(row);
  }
}
```

Remove the static help rows from `index.html` (the `<div class="help-controls">` children). Keep the container but empty it — JS populates it.

- [ ] **Step 8: Run tests**

Run: `cd /srv/svg-terminal && node --test test-server.mjs`

Expected: All tests pass (keybinding refactor is client-side only).

- [ ] **Step 9: Commit**

```bash
cd /srv/svg-terminal
git add dashboard.mjs index.html
git commit -m "refactor: central KEYBINDINGS config replaces hardcoded modifier checks

All input mappings defined in one config object. getDragAction() and
getScrollAction() resolve events to actions. Help panel auto-generates
from config. No hardcoded modifier chains in handlers."
```

---

## Task 2: Font scale system

**Files:**
- Modify: `/srv/svg-terminal/dashboard.mjs`
- Modify: `/srv/svg-terminal/dashboard.css`

- [ ] **Step 1: Add fontScale to terminal object**

In `addTerminal()` where `terminals.set()` is called (~line 816), add `fontScale: 1.0` to the terminal object alongside `scrollOffset`:

```js
    fontScale: 1.0,
```

- [ ] **Step 2: Add applyFontScale function**

After the `KEYBINDINGS` config section, add:

```js
// Apply font scale to a terminal's <object> element.
// This is visual-only — does not change PTY cols/rows.
// The 4x scale trick is preserved: fontScale operates INSIDE the terminal panel,
// separate from the CSS3DObject.scale which handles the 4x rendering.
function applyFontScale(t) {
  const obj = t.dom.querySelector('object');
  if (!obj) return;
  obj.style.transformOrigin = '0 0';
  obj.style.transform = 'scale(' + t.fontScale + ')';
  // Adjust object container to prevent overflow
  obj.style.width = (100 / t.fontScale) + '%';
  obj.style.height = (936 / t.fontScale) + 'px'; // 936 = 4x content height (992 - 56 header)
}
```

- [ ] **Step 3: Alt+wheel already handled in Task 1**

The `onWheel` refactor in Task 1 Step 4 already handles the `fontZoom` action calling `applyFontScale(t)`. Verify it works.

- [ ] **Step 4: Reset font scale on unfocus**

In `restoreFocusedTerminal()`, reset the font scale:

```js
  // Reset font scale
  term.fontScale = 1.0;
  const obj = term.dom.querySelector('object');
  if (obj) {
    obj.style.transform = '';
    obj.style.width = '';
    obj.style.height = '';
  }
```

- [ ] **Step 5: Test manually**

Focus a terminal, Alt+scroll up/down — text should zoom in/out. Esc to unfocus — should reset.

- [ ] **Step 6: Commit**

```bash
cd /srv/svg-terminal
git add dashboard.mjs
git commit -m "feat: font scale — Alt+scroll zooms text in focused terminal"
```

---

## Task 3: Title bar controls (+/- and optimize)

**Files:**
- Modify: `/srv/svg-terminal/dashboard.mjs` (createTerminalDOM)
- Modify: `/srv/svg-terminal/dashboard.css`

- [ ] **Step 1: Add control buttons to createTerminalDOM**

In `createTerminalDOM` (~line 658), after the session name span is added to the header, add control buttons:

```js
  const controls = document.createElement('span');
  controls.className = 'term-controls';

  const btnMinus = document.createElement('button');
  btnMinus.className = 'term-ctrl-btn';
  btnMinus.textContent = '−';
  btnMinus.title = 'Decrease font';
  btnMinus.addEventListener('click', function(ev) {
    ev.stopPropagation();
    const t = terminals.get(sessionName);
    if (!t) return;
    t.fontScale = Math.max(0.3, (t.fontScale || 1.0) / 1.1);
    applyFontScale(t);
  });

  const btnPlus = document.createElement('button');
  btnPlus.className = 'term-ctrl-btn';
  btnPlus.textContent = '+';
  btnPlus.title = 'Increase font';
  btnPlus.addEventListener('click', function(ev) {
    ev.stopPropagation();
    const t = terminals.get(sessionName);
    if (!t) return;
    t.fontScale = Math.min(3.0, (t.fontScale || 1.0) * 1.1);
    applyFontScale(t);
  });

  const btnOptimize = document.createElement('button');
  btnOptimize.className = 'term-ctrl-btn';
  btnOptimize.textContent = '⊡';
  btnOptimize.title = 'Optimize — resize terminal to fill card';
  btnOptimize.addEventListener('click', function(ev) {
    ev.stopPropagation();
    const t = terminals.get(sessionName);
    if (!t) return;
    optimizeTerminalFit(t, sessionName);
  });

  controls.appendChild(btnMinus);
  controls.appendChild(btnPlus);
  controls.appendChild(btnOptimize);
  header.appendChild(controls);
```

- [ ] **Step 2: Add optimizeTerminalFit function**

```js
// Calculate cols/rows to fill the current card at the current font scale,
// then resize the PTY via tmux.
function optimizeTerminalFit(t, sessionName) {
  const obj = t.dom.querySelector('object');
  if (!obj) return;

  // Get the rendered cell dimensions from the SVG
  let cellW = 8.4, cellH = 17;
  try {
    const svgDoc = obj.contentDocument;
    if (svgDoc) {
      const measure = svgDoc.getElementById('measure');
      if (measure) {
        const bbox = measure.getBBox();
        if (bbox.width > 0) {
          cellW = bbox.width / 10;
          cellH = bbox.height;
        }
      }
    }
  } catch (err) {}

  // Card content area (4x size, minus header)
  const cardW = parseInt(t.dom.style.width) || 1280;
  const cardH = (parseInt(t.dom.style.height) || 992) - 56; // minus header
  const scale = t.fontScale || 1.0;

  // How many cols/rows fit at current font scale?
  // The SVG viewBox is cols*cellW × rows*cellH.
  // The <object> renders at cardW × cardH.
  // With fontScale, effective cell size is cellW*scale × cellH*scale in SVG coords.
  // But the <object> scales the SVG to fit... the relationship is:
  // cols = cardW / (cellW * scale * renderScale)
  // where renderScale = cardW / (cols * cellW) when scale=1
  // Simplification: at scale=1, viewBox fills card exactly.
  // At scale!=1, fewer/more cells fit.
  const cols = Math.max(20, Math.round(cardW / (cellW * scale)));
  const rows = Math.max(5, Math.round(cardH / (cellH * scale)));

  // Send resize to server
  t.sendInput({ type: 'input', specialKey: 'resize:' + cols + ':' + rows });
  // Alternative: direct tmux command via a new message type
}
```

Wait — we need a proper resize message. Let me use the WebSocket protocol's resize type.

Actually, the server doesn't handle resize yet. That's Task 4. For now, the optimize button sends the resize request; Task 4 makes the server handle it.

Update `optimizeTerminalFit` to use a `resize` message:

```js
function optimizeTerminalFit(t, sessionName) {
  const obj = t.dom.querySelector('object');
  if (!obj) return;

  let cellW = 8.4, cellH = 17;
  try {
    const svgDoc = obj.contentDocument;
    if (svgDoc) {
      const measure = svgDoc.getElementById('measure');
      if (measure) {
        const bbox = measure.getBBox();
        if (bbox.width > 0) { cellW = bbox.width / 10; cellH = bbox.height; }
      }
    }
  } catch (err) {}

  const cardW = parseInt(t.dom.style.width) || 1280;
  const cardH = (parseInt(t.dom.style.height) || 992) - 56;
  const scale = t.fontScale || 1.0;

  const cols = Math.max(20, Math.round(cardW / (cellW * scale)));
  const rows = Math.max(5, Math.round(cardH / (cellH * scale)));

  t.sendInput({ type: 'resize', cols: cols, rows: rows });
}
```

- [ ] **Step 3: Add CSS for title bar controls**

Add to `/srv/svg-terminal/dashboard.css`:

```css
/* Terminal title bar controls */
.term-controls {
  margin-left: auto;
  display: flex;
  gap: 8px;
  align-items: center;
}

.term-ctrl-btn {
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: #999;
  font-size: 24px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
  transition: background 0.15s, color 0.15s;
}

.term-ctrl-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}
```

Note: sizes are 4x because of the 4x scale trick (40px button = 10px rendered).

- [ ] **Step 4: Make header a flex row to push controls right**

Update the header styles. Find the existing header rule in dashboard.css and ensure it has flexbox:

```css
.terminal-3d header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 24px;
  background: #2a2a2c;
  height: 56px;
}
```

- [ ] **Step 5: Test manually**

Focus a terminal. The header should show `● ● ● session-name  [−] [+] [⊡]`. Click +/- to zoom. Optimize button won't work yet (needs Task 4).

- [ ] **Step 6: Commit**

```bash
cd /srv/svg-terminal
git add dashboard.mjs dashboard.css
git commit -m "feat: title bar controls — +/- font zoom and optimize button"
```

---

## Task 4: Server-side resize handler

**Files:**
- Modify: `/srv/svg-terminal/server.mjs`
- Modify: `/srv/svg-terminal/test-server.mjs`

- [ ] **Step 1: Add resize message handler in WebSocket handler**

In `handleTerminalWs`, in the `ws.on('message')` handler, add a `resize` type check before the `input` check:

```js
      if (msg.type === 'resize') {
        const target = session + ':' + pane;
        const cols = Math.max(20, Math.min(500, parseInt(msg.cols) || 80));
        const rows = Math.max(5, Math.min(200, parseInt(msg.rows) || 24));
        try {
          await tmuxAsync('resize-pane', '-t', target, '-x', String(cols), '-y', String(rows));
        } catch (err) {
          // resize may fail if pane doesn't exist — ignore
        }
        // Force re-capture to get new dimensions
        lastState = null;
        setTimeout(captureAndPush, 10);
        return;
      }
```

- [ ] **Step 2: Add resize test**

Add to `test-server.mjs`:

```js
test('WebSocket resize message changes pane dimensions', async () => {
  const sessRes = await get('/api/sessions');
  const sessions = await sessRes.json();
  if (sessions.length === 0) return;
  const session = sessions[0].name;

  const ws = new WebSocket('ws://127.0.0.1:' + TEST_PORT + '/ws/terminal?session=' + session + '&pane=0');

  // Wait for initial screen
  const first = await new Promise((resolve, reject) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
      if (msg.type === 'screen') resolve(msg);
    };
    setTimeout(() => reject(new Error('Timeout')), 5000);
  });

  const origCols = first.width;
  const origRows = first.height;

  // Send resize
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));

  // Wait for updated screen with new dimensions
  const resized = await new Promise((resolve, reject) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
      if (msg.type === 'screen' && (msg.width === 100 || msg.height === 30)) resolve(msg);
    };
    setTimeout(() => reject(new Error('No resize response')), 3000);
  });

  assert.equal(resized.width, 100);
  assert.equal(resized.height, 30);

  // Restore original size
  ws.send(JSON.stringify({ type: 'resize', cols: origCols, rows: origRows }));
  await new Promise(r => setTimeout(r, 500));

  ws.close();
});
```

- [ ] **Step 3: Run tests**

Run: `cd /srv/svg-terminal && node --test test-server.mjs`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
cd /srv/svg-terminal
git add server.mjs test-server.mjs
git commit -m "feat: WebSocket resize message — tmux resize-pane"
```

---

## Task 5: Alt+drag card resize

**Files:**
- Modify: `/srv/svg-terminal/dashboard.mjs`

- [ ] **Step 1: Handle resize drag in onMouseMove**

In `onMouseMove`, add a handler for `dragMode === 'resize'`. This needs to go in the `if (isDragging && dragMode)` block alongside orbit/dollyXY/rotateOrigin:

```js
    } else if (dragMode === 'resize') {
      // Alt+drag: resize the focused terminal card
      if (!activeInputSession) return;
      const t = terminals.get(activeInputSession);
      if (!t) return;
      // Scale the drag delta to 4x (since DOM is 4x)
      const scaleF = 4;
      const currentW = parseInt(t.dom.style.width) || 1280;
      const currentH = parseInt(t.dom.style.height) || 992;
      const newW = Math.max(640, currentW + dx * scaleF);
      const newH = Math.max(496, currentH + dy * scaleF);
      t.dom.style.width = newW + 'px';
      t.dom.style.height = newH + 'px';
      // Update CSS3DObject scale to maintain world-size consistency
      t.css3dObject.scale.setScalar(248 / newH);
    }
```

- [ ] **Step 2: On resize drag end, send resize to server**

In `onMouseUp`, after the existing ctrlPending check, add:

```js
  // After resize drag, calculate optimal cols/rows and send resize
  if (dragMode === 'resize' && activeInputSession) {
    const t = terminals.get(activeInputSession);
    if (t) {
      optimizeTerminalFit(t, activeInputSession);
    }
  }
```

- [ ] **Step 3: Test manually**

Focus a terminal. Alt+drag on the terminal — it should resize the card. On release, the PTY resizes to match.

- [ ] **Step 4: Commit**

```bash
cd /srv/svg-terminal
git add dashboard.mjs
git commit -m "feat: Alt+drag resizes focused terminal card + PTY"
```

---

## Execution Notes

- **Task 1 must complete first** — it refactors all input handlers that Tasks 2-5 depend on.
- **Task 2 and Task 3 are independent** — font scale and title bar can be built in parallel.
- **Task 4 must complete before Task 3's optimize button works** — the server needs the resize handler.
- **Task 5 depends on Tasks 1 and 4** — needs the resize drag mode and server handler.
- **Read dashboard.mjs header notes 1-8** before modifying — critical anti-patterns.
- **DO NOT change the 4x scale trick** — fontScale is a SEPARATE layer that operates inside the terminal panel.
- **Resize sends cols/rows, never pixels** — the server clamps to sane ranges (20-500 cols, 5-200 rows).
