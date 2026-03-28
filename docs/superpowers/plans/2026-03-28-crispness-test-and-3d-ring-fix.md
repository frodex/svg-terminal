# Crispness + 3D Ring Layout Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the dashboard's 3D ring layout to use proper THREE.Group hierarchy with the exact design studio parameters, and solve text crispness via a focus-mode crossfade to flat HTML.

**Architecture:** Three.js stays — WebGL + CSS3DRenderer for full 3D scene (camera orbit, ring spin, card tilt oscillation). Ring tilt uses THREE.Group rotation (not manual Euler position math). Text crispness solved by crossfading to an un-transformed HTML overlay when a card is focused and face-on. Overview cards use Nx scaling for best-available 3D crispness.

**Tech Stack:** Three.js (WebGL + CSS3DRenderer), HTML/CSS, live terminal SVGs via `<object>` tags.

**Design studio parameters (confirmed from JS console):**

```json
{
  "outer": {
    "count": 12, "radius": 345, "mode": 0,
    "faceCamera": true, "spinDir": 1, "spinSpeed": 0.008,
    "ringTilt": { "x": [73,73,0], "y": [-5,-5,0], "z": [0,0,0] },
    "cardTilt": { "x": [-5,-5,0], "y": [-5,-5,24], "z": [-5,-5,44] }
  },
  "inner": {
    "count": 3, "radius": 219, "mode": 0,
    "faceCamera": false, "spinDir": -1, "spinSpeed": 0.012,
    "ringTilt": { "x": [21,21,0], "y": [0,0,0], "z": [19,19,26] },
    "cardTilt": { "x": [0,0,33], "y": [0,0,39], "z": [0,0,29] }
  },
  "camera": { "zoom": 170, "push": 233, "panX": 102, "panY": -56 }
}
```

Each tilt array is `[from, to, speed]`. Speed 0 = static at `from`. Speed > 0 = sine oscillation.

---

## Why This Project Exists

The ENTIRE purpose of svg-terminal is **hyper-crisp terminal text on 3D objects in Chrome**. If text isn't crisp, nothing else matters.

### The Crispness Reality (from research)

1. Chrome renders HTML text sharper than SVG `<text>`, Canvas text, or any text inside 3D transforms
2. CSS 3D transforms (both `preserve-3d` and `matrix3d`) soften text due to GPU compositing — Chrome rasterizes the element into a bitmap before applying the 3D transform
3. The Nx scale trick (render at Nx CSS size, scale down in 3D) improves the bitmap resolution but doesn't eliminate the softening
4. **The only way to get perfectly crisp text is to NOT 3D-transform it** — render it flat in an HTML overlay and sync position via projection math

### The Crossfade Solution

- **Overview mode:** Cards orbit on 3D rings. Text is inside CSS3DObjects with 4x scaling. Some softening is acceptable — cards are small, nobody reads 9px text at overview zoom.
- **Focus mode:** Card flies to center, comes to rest face-on. Fast crossfade (200-300ms) swaps the 3D-transformed terminal for a flat HTML overlay containing the same terminal content. Text becomes perfectly crisp.
- **Unfocus:** Crossfade back to 3D object, resume ring orbit.

This gives us true 3D (camera orbit, ring spin, cards flying around) AND crisp text when it matters.

### Key Learnings (from journal v0.3 — do NOT violate)

- Don't fake 3D with scale/Y-offset math — use real 3D containers (THREE.Group)
- `localRot = theta - PI/2` (not `+ PI/2`) for upright at 6 o'clock
- `transform-origin: 50% 50%` on cards, compute position mathematically
- Card tilt must be uniform — don't modulate per-card by ring position
- Don't "improve" working code — copy the design studio approach faithfully
- After 2 failed fixes for the same issue, stop and question the architecture

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `dashboard.mjs` | Rewrite ring layout + add focus crossfade | THREE.Group hierarchy, oscillation, HTML overlay swap |
| `dashboard.css` | Add overlay styles | Focus overlay transition styles |
| `index.html` | Minor | Ensure focus overlay div exists |
| `crispness-test.html` | Create | Quick Nx scaling comparison (which scale factor looks best for overview) |

---

## Phase 1: Fix Ring Layout

### Task 1: Add oscillation utility and update RING config

**Files:**
- Modify: `/srv/svg-terminal/dashboard.mjs`

- [ ] **Step 1: Add the oscillation function**

After the imports and before the RING constant, add:

```js
// Oscillate between from and to using sine wave. Speed 0 = static at from.
// Exact function from ring-mega-saved.html design studio.
function osc(from, to, speed, time) {
  if (speed === 0) return from;
  var t = (Math.sin(time * speed * 0.05) + 1) / 2;
  return from + (to - from) * t;
}
```

- [ ] **Step 2: Replace the RING constant with full oscillation parameters**

Replace lines 8-27 (the existing `RING` constant) with:

```js
const RING = {
  outer: {
    radius: 345,
    mode: 0,           // 0=Upright
    faceCamera: true,
    spinSpeed: 0.008,
    spinDir: 1,         // Forward
    ringTilt: {
      x: { from: 73, to: 73, speed: 0 },
      y: { from: -5, to: -5, speed: 0 },
      z: { from: 0, to: 0, speed: 0 },
    },
    cardTilt: {
      x: { from: -5, to: -5, speed: 0 },
      y: { from: -5, to: -5, speed: 24 },
      z: { from: -5, to: -5, speed: 44 },
    },
  },
  inner: {
    radius: 219,
    mode: 0,           // 0=Upright
    faceCamera: false,
    spinSpeed: 0.012,
    spinDir: -1,        // Reverse
    ringTilt: {
      x: { from: 21, to: 21, speed: 0 },
      y: { from: 0, to: 0, speed: 0 },
      z: { from: 19, to: 19, speed: 26 },
    },
    cardTilt: {
      x: { from: 0, to: 0, speed: 33 },
      y: { from: 0, to: 0, speed: 39 },
      z: { from: 0, to: 0, speed: 29 },
    },
  },
};
```

- [ ] **Step 3: Commit**

```bash
cd /srv/svg-terminal
git add dashboard.mjs
git commit -m "feat: oscillation utility + full design studio parameters"
```

### Task 2: Rewrite ring positioning with THREE.Group hierarchy

**Files:**
- Modify: `/srv/svg-terminal/dashboard.mjs`

This is the core architectural fix. Instead of computing world positions with `v.applyEuler()` (faked 3D), we create a `THREE.Group` per ring and rotate the GROUP. Cards are children of the group, positioned in local 2D. The group's rotation handles the 3D tilt — the Three.js equivalent of CSS `preserve-3d`.

- [ ] **Step 1: Add module-level ring group variables**

After the existing `let terminalGroup, shadowGroup;` line, add:

```js
let outerRingGroup, innerRingGroup;
```

- [ ] **Step 2: Create ring groups in init()**

In the `init()` function, after `terminalGroup = new THREE.Group(); scene.add(terminalGroup);`, add:

```js
// Ring groups — children inherit group rotation (Three.js equivalent of CSS preserve-3d)
outerRingGroup = new THREE.Group();
innerRingGroup = new THREE.Group();
terminalGroup.add(outerRingGroup);
terminalGroup.add(innerRingGroup);
```

- [ ] **Step 3: Rewrite computeRingPos to return local 2D position**

Replace the existing `computeRingPos` function (lines 100-118) with:

```js
// Local 2D position on the flat ring circle.
// The ring group's rotation handles 3D tilt — do NOT apply Euler here.
function computeRingPos(index, total, config, angle) {
  const theta = -Math.PI / 2 + (2 * Math.PI * index) / total;
  const spunTheta = theta + angle;
  return {
    x: Math.cos(spunTheta) * config.radius,
    y: -Math.sin(spunTheta) * config.radius,
    z: 0
  };
}
```

Key difference: NO `v.applyEuler(_ringTiltEuler)`. Position stays in the ring's local 2D plane.

- [ ] **Step 4: Update addTerminal to parent under outerRingGroup by default**

In `addTerminal()`, change:

```js
terminalGroup.add(css3dObj);
```

to:

```js
outerRingGroup.add(css3dObj);
```

- [ ] **Step 5: Rewrite the animate() loop for group-based ring tilt + oscillation**

In the `animate()` function, after `const time = clock.getElapsedTime();` and `const delta = clock.getDelta();`, add ring group rotation updates:

```js
// === Ring group tilt (oscillated) — the preserve-3d equivalent ===
const oRT = RING.outer.ringTilt;
outerRingGroup.rotation.set(
  osc(oRT.x.from, oRT.x.to, oRT.x.speed, time) * DEG2RAD,
  osc(oRT.y.from, oRT.y.to, oRT.y.speed, time) * DEG2RAD,
  osc(oRT.z.from, oRT.z.to, oRT.z.speed, time) * DEG2RAD
);

const iRT = RING.inner.ringTilt;
innerRingGroup.rotation.set(
  osc(iRT.x.from, iRT.x.to, iRT.x.speed, time) * DEG2RAD,
  osc(iRT.y.from, iRT.y.to, iRT.y.speed, time) * DEG2RAD,
  osc(iRT.z.from, iRT.z.to, iRT.z.speed, time) * DEG2RAD
);
```

Then in the per-terminal loop, ensure each terminal is in the correct ring group and use oscillated card tilt:

```js
// Ensure terminal is in the correct ring group
const correctGroup = ringAssignments.inner.includes(name) ? innerRingGroup : outerRingGroup;
if (t.css3dObject.parent !== correctGroup) {
  t.css3dObject.parent.remove(t.css3dObject);
  correctGroup.add(t.css3dObject);
}
```

For the card tilt section (replacing the static `config.cardTilt` read), use oscillated values:

```js
// Card tilt (oscillated from design studio parameters)
const ct = config.cardTilt;
const ctX = osc(ct.x.from, ct.x.to, ct.x.speed, time) * DEG2RAD;
const ctY = osc(ct.y.from, ct.y.to, ct.y.speed, time) * DEG2RAD;
const ctZ = osc(ct.z.from, ct.z.to, ct.z.speed, time) * DEG2RAD;
_cardTiltEuler.set(ctX, ctY, ctZ);
_driftQuat.setFromEuler(_cardTiltEuler);
_targetQuat.multiply(_driftQuat);
```

- [ ] **Step 6: Update camera home position for design studio values**

Replace the existing HOME_POS and HOME_TARGET:

```js
// Design studio: zoom 170%, push 233, panX 102, panY -56
// zoom 170% = closer camera (Z reduced), push adds to Z, panX/Y offset the target
const HOME_POS = new THREE.Vector3(102, 56, Math.round(900 * (100 / 170) + 233));
const HOME_TARGET = new THREE.Vector3(102, 56, 0);
```

Note: panY negated because Three.js Y-up vs CSS Y-down.

- [ ] **Step 7: Remove stale Euler reusable objects if no longer needed**

If `_ringTiltEuler` is no longer used anywhere after the rewrite (ring tilt is now on the group, not per-position), remove the declaration:

```js
// REMOVE this line if no longer referenced:
const _ringTiltEuler = new THREE.Euler();
```

Keep `_cardTiltEuler` — it's still used for per-card tilt.

- [ ] **Step 8: Verify — start server and check visually**

```bash
cd /srv/svg-terminal && node server.mjs &
```

Open dashboard in Chrome. Verify:
1. Terminals arranged on two rings (outer 12 cards, inner 3 cards when enough sessions)
2. Outer ring tilted ~73° on X (nearly flat, looking down at it)
3. Inner ring tilted ~21° on X (more upright)
4. Both rings spinning (outer forward, inner reverse)
5. Card tilt oscillation visible (subtle rocking on outer, multi-axis on inner)
6. Camera orbit still works (right-click drag)
7. Scroll zoom still works

- [ ] **Step 9: Commit**

```bash
cd /srv/svg-terminal
git add dashboard.mjs
git commit -m "feat: rewrite ring layout to THREE.Group hierarchy with oscillation

Ring tilt applied to THREE.Group rotation (equivalent of CSS preserve-3d)
instead of manual v.applyEuler() on position vectors. Cards positioned
in local 2D within the group. Full oscillation from design studio session."
```

---

## Phase 2: Focus Crossfade for Crisp Text

### Task 3: Add focus overlay HTML and CSS

**Files:**
- Modify: `/srv/svg-terminal/index.html`
- Modify: `/srv/svg-terminal/dashboard.css`

The focus overlay is a full-screen HTML div that sits ON TOP of the Three.js canvas. It contains a terminal `<object>` tag (same SVG endpoint) rendered flat — no 3D transforms. Text is perfectly crisp because Chrome renders it as normal HTML.

- [ ] **Step 1: Verify focus-overlay div exists in index.html**

The existing `index.html` already has `<div class="focus-overlay" id="focus-overlay"></div>`. Verify it exists. If not, add it after the sidebar div.

- [ ] **Step 2: Add focus overlay CSS**

Add to `/srv/svg-terminal/dashboard.css`:

```css
/* === Focus Overlay — crisp flat terminal over 3D scene === */
.focus-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  pointer-events: none;
  display: none;
}

.focus-overlay.visible {
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
}

.focus-overlay .crisp-terminal {
  background: #1c1c1e;
  border-radius: 12px;
  overflow: hidden;
  opacity: 0;
  transition: opacity 0.25s ease-in;
  /* Crisp text hints */
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
}

.focus-overlay .crisp-terminal.visible {
  opacity: 1;
}

.focus-overlay .crisp-terminal object {
  display: block;
  border: none;
}

.focus-overlay .crisp-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: #2a2a2c;
}

.focus-overlay .crisp-header .dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}

.focus-overlay .crisp-header .session-name {
  color: #888;
  font-family: -apple-system, sans-serif;
  font-size: 13px;
}
```

- [ ] **Step 3: Commit**

```bash
cd /srv/svg-terminal
git add index.html dashboard.css
git commit -m "feat: focus overlay HTML and CSS for crisp text crossfade"
```

### Task 4: Implement focus crossfade logic in dashboard.mjs

**Files:**
- Modify: `/srv/svg-terminal/dashboard.mjs`

When a terminal is focused:
1. The 3D card flies to center (existing behavior)
2. Once the fly-in completes (~1s), create a flat HTML terminal in the focus overlay
3. Crossfade: overlay fades in (200ms) while 3D card fades out
4. Result: crisp flat terminal text, no 3D transform

When unfocused:
1. Crossfade back: overlay fades out, 3D card fades in
2. Remove overlay content
3. Resume ring orbit

- [ ] **Step 1: Add focus overlay management functions**

After the existing `unfocusTerminal()` function, add:

```js
// === Crisp Focus Overlay ===
// Renders focused terminal as flat HTML (no 3D transform) for maximum text crispness.
// Chrome renders HTML text sharper than any 3D-transformed content.

function showCrispOverlay(sessionName) {
  const overlay = document.getElementById('focus-overlay');
  overlay.innerHTML = '';
  overlay.classList.add('visible');

  const wrapper = document.createElement('div');
  wrapper.className = 'crisp-terminal';

  // Header with dots
  const header = document.createElement('div');
  header.className = 'crisp-header';
  for (const color of ['#ff5f57', '#febc2e', '#28c840']) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = color;
    header.appendChild(dot);
  }
  const nameSpan = document.createElement('span');
  nameSpan.className = 'session-name';
  const t = terminals.get(sessionName);
  nameSpan.textContent = t ? (t.dom.querySelector('.session-name')?.textContent || sessionName) : sessionName;
  header.appendChild(nameSpan);
  wrapper.appendChild(header);

  // Terminal SVG — flat, un-transformed, crisp
  const obj = document.createElement('object');
  obj.type = 'image/svg+xml';
  obj.data = '/terminal.svg?session=' + encodeURIComponent(sessionName);

  // Size to fill available space while maintaining aspect ratio
  // Terminal aspect ratio: 320/248 ≈ 1.29
  const sidebarW = SIDEBAR_WIDTH + 20;
  const inputH = 60;
  const maxW = window.innerWidth - sidebarW - 40;
  const maxH = window.innerHeight - inputH - 40;
  const aspect = 320 / 248;
  let w, h;
  if (maxW / maxH > aspect) {
    h = maxH;
    w = Math.round(h * aspect);
  } else {
    w = maxW;
    h = Math.round(w / aspect);
  }
  wrapper.style.width = w + 'px';
  obj.style.width = w + 'px';
  obj.style.height = (h - 36) + 'px'; // subtract header height
  wrapper.appendChild(obj);

  overlay.appendChild(wrapper);

  // Trigger crossfade after a frame (let DOM render)
  requestAnimationFrame(function() {
    wrapper.classList.add('visible');
  });

  // Fade out the 3D card
  if (t) {
    t.dom.style.transition = 'opacity 0.25s';
    t.dom.style.opacity = '0';
  }
}

function hideCrispOverlay() {
  const overlay = document.getElementById('focus-overlay');
  const wrapper = overlay.querySelector('.crisp-terminal');
  if (wrapper) {
    wrapper.classList.remove('visible');
    setTimeout(function() {
      overlay.classList.remove('visible');
      overlay.innerHTML = '';
    }, 300);
  } else {
    overlay.classList.remove('visible');
    overlay.innerHTML = '';
  }
}
```

- [ ] **Step 2: Hook crossfade into focusTerminal()**

In the existing `focusTerminal()` function, after the camera tween is set up, add a delayed call to show the crisp overlay once the fly-in animation completes:

```js
// Show crisp overlay after fly-in completes
setTimeout(function() {
  if (focusedSession === sessionName) {
    showCrispOverlay(sessionName);
  }
}, 1000); // matches cameraTween duration
```

- [ ] **Step 3: Hook crossfade into unfocusTerminal()**

At the start of `unfocusTerminal()`, before the camera tween, restore the 3D card opacity and hide the overlay:

```js
// Restore 3D card opacity
const ft = terminals.get(wasFocused);
if (ft) {
  ft.dom.style.transition = 'opacity 0.25s';
  ft.dom.style.opacity = '1';
}
hideCrispOverlay();
```

- [ ] **Step 4: Handle input bar with the overlay**

The input bar should send keys to the focused session. This already works — the input bar references `focusedSession` by name, not by DOM element. No changes needed, but verify that clicks on the crisp overlay don't accidentally unfocus:

In `onSceneClick()`, add early return if overlay is visible:

```js
if (document.getElementById('focus-overlay').classList.contains('visible')) return;
```

- [ ] **Step 5: Verify crossfade visually**

Open dashboard in Chrome. Click a terminal card:
1. Card should fly to center (~1s)
2. After fly-in, crisp overlay should fade in (0.25s)
3. Terminal text should be noticeably sharper than the 3D version
4. Press Escape — overlay fades out, card returns to ring
5. Input bar should still work while overlay is showing

- [ ] **Step 6: Commit**

```bash
cd /srv/svg-terminal
git add dashboard.mjs
git commit -m "feat: focus crossfade to flat HTML overlay for crisp terminal text

When a terminal is focused, after the fly-in animation completes,
a flat HTML overlay fades in with the same terminal SVG content.
No 3D transforms on the overlay = Chrome renders text at maximum
crispness. On unfocus, crossfades back to 3D card."
```

---

## Phase 3: Crispness Optimization for Overview

### Task 5: Test Nx scaling for overview cards

**Files:**
- Create: `/srv/svg-terminal/crispness-test.html`
- Modify: `/srv/svg-terminal/server.mjs` (add route if needed)

A quick test page to determine the optimal Nx scale factor for overview cards (the 3D-transformed ones). Currently using 4x (1280×992, scale 0.25). Test 2x, 4x, 6x, 8x to find the sweet spot between crispness and performance.

- [ ] **Step 1: Create minimal Nx comparison page**

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Nx Scale Test — svg-terminal</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #111; color: #ccc; font-family: -apple-system, sans-serif; font-size: 13px; }
.controls {
  position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  background: rgba(0,0,0,0.85); backdrop-filter: blur(8px);
  padding: 10px 20px; display: flex; align-items: center; gap: 16px;
}
.controls label { color: #888; font-size: 11px; text-transform: uppercase; }
.controls select { background: #222; color: #ddd; border: 1px solid #444; padding: 4px 8px; border-radius: 4px; }
.grid {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 20px; padding: 60px 20px 20px;
}
.panel {
  background: #1a1a1a; border: 1px solid #333; border-radius: 12px;
  overflow: hidden; display: flex; flex-direction: column;
}
.panel-header {
  padding: 8px 14px; background: #222; border-bottom: 1px solid #333;
  font-size: 12px; font-weight: 600; color: #aaa;
}
.panel-header .method { color: #5c5cff; }
.panel-body {
  flex: 1; display: flex; align-items: center; justify-content: center;
  padding: 20px; min-height: 350px;
  perspective: 800px;
}
.tilt-container {
  transform-style: preserve-3d;
  transform: rotateX(40deg) rotateY(-5deg);
}
.flat-label {
  text-align: center; padding: 8px; color: #666; font-size: 11px;
}
</style>
</head>
<body>

<div class="controls">
  <label>Session:</label>
  <select id="session-select"><option value="">Loading...</option></select>
  <label>Tilt X:</label>
  <input type="range" id="tiltX" min="0" max="90" value="40">
  <span id="tiltXV">40</span>°
</div>

<div class="grid" id="grid"></div>

<script>
var scales = [
  { n: 1, label: '1x (320×248, no scaling)' },
  { n: 2, label: '2x (640×496, scale 0.5)' },
  { n: 4, label: '4x (1280×992, scale 0.25) — current' },
  { n: 8, label: '8x (2560×1984, scale 0.125)' },
];

var BASE_W = 320, BASE_H = 248;
var grid = document.getElementById('grid');

// Build panels
scales.forEach(function(s) {
  var panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = '<div class="panel-header"><span class="method">' + s.label + '</span></div>';
  var body = document.createElement('div');
  body.className = 'panel-body';
  var tilt = document.createElement('div');
  tilt.className = 'tilt-container';
  tilt.dataset.scale = s.n;
  var card = document.createElement('div');
  card.style.width = (BASE_W * s.n) + 'px';
  card.style.height = (BASE_H * s.n) + 'px';
  card.style.transform = 'scale(' + (1 / s.n) + ')';
  card.style.transformOrigin = '0 0';
  card.style.background = '#1c1c1e';
  card.style.borderRadius = (12 * s.n) + 'px';
  card.style.overflow = 'hidden';
  card.dataset.card = s.n;
  tilt.appendChild(card);
  body.appendChild(tilt);
  panel.appendChild(body);
  grid.appendChild(panel);
});

// Load sessions
var sessionSelect = document.getElementById('session-select');
fetch('/api/sessions').then(function(r) { return r.json(); }).then(function(sessions) {
  sessionSelect.innerHTML = '';
  sessions.forEach(function(s) {
    var opt = document.createElement('option');
    opt.value = s.name; opt.textContent = s.name;
    sessionSelect.appendChild(opt);
  });
  if (sessions.length > 0) loadAll(sessions[0].name);
}).catch(function() { sessionSelect.innerHTML = '<option>No sessions</option>'; });

sessionSelect.addEventListener('change', function() { loadAll(this.value); });

function loadAll(session) {
  scales.forEach(function(s) {
    var card = document.querySelector('[data-card="' + s.n + '"]');
    card.innerHTML = '';
    var obj = document.createElement('object');
    obj.type = 'image/svg+xml';
    obj.data = '/terminal.svg?session=' + encodeURIComponent(session);
    obj.style.width = '100%';
    obj.style.height = '100%';
    obj.style.display = 'block';
    obj.style.border = 'none';
    card.appendChild(obj);
  });
}

// Tilt slider
document.getElementById('tiltX').addEventListener('input', function() {
  var v = this.value;
  document.getElementById('tiltXV').textContent = v;
  document.querySelectorAll('.tilt-container').forEach(function(el) {
    el.style.transform = 'rotateX(' + v + 'deg) rotateY(-5deg)';
  });
});
</script>
</body>
</html>
```

- [ ] **Step 2: Add route in server.mjs if needed**

Check if server.mjs serves arbitrary HTML files or needs explicit routes. Add route for `crispness-test.html` matching the pattern of `font-test.html`.

- [ ] **Step 3: Visual test — pick the best Nx factor**

Open in Chrome. Compare 1x, 2x, 4x, 8x at tilt 40° and 73°. Note:
- Which scale factor gives the best text clarity?
- Is there a diminishing return (e.g., 8x looks same as 4x)?
- Any performance impact (8x = 2560×1984 DOM elements)?

Update the `css3dObj.scale.setScalar()` value in dashboard.mjs and the CSS dimensions in dashboard.css to match the winning factor.

- [ ] **Step 4: Commit**

```bash
cd /srv/svg-terminal
git add crispness-test.html server.mjs
git commit -m "feat: Nx scale comparison test for overview card crispness"
```

---

## Phase 4: Documentation

### Task 6: Update journal and sessions

**Files:**
- Create: `/srv/svg-terminal/docs/research/2026-03-28-v0.4-svg-terminal-viewer-journal.md`
- Modify: `/srv/svg-terminal/sessions.md`

- [ ] **Step 1: Create journal v0.4**

Document:
- The crispness research findings (HTML text > SVG text > Canvas text in Chrome)
- The crossfade architecture decision and why
- The THREE.Group hierarchy fix and why manual Euler was wrong
- The Nx scaling test results
- What worked, what didn't, lessons for future

- [ ] **Step 2: Update sessions.md**

Add to Key Technical Decisions:
```
[2026-03-28] Text crispness: focus crossfade to flat HTML overlay — Chrome renders un-transformed HTML text sharper than any 3D-transformed content
[2026-03-28] Ring layout: THREE.Group per ring (preserve-3d equivalent) — group rotation handles tilt, cards positioned in local 2D
[2026-03-28] Overview Nx scaling: [Nx] chosen from comparison test
```

Update Active Direction and Pending Items.

- [ ] **Step 3: Update bibliography**

Add the Chrome text rendering research sources to `docs/bibliography.md`.

- [ ] **Step 4: Commit**

```bash
cd /srv/svg-terminal
git add docs/ sessions.md
git commit -m "docs: journal v0.4 — crispness solution, ring layout fix, Nx test results"
```

---

## Execution Notes

- **Task 2 is the highest-risk task.** The THREE.Group rewrite touches the core animation loop. Test thoroughly after Step 8.
- **Task 4 (crossfade) is independent of Task 2.** They can be implemented in parallel by separate agents if desired.
- **Task 5 (Nx test) informs a simple constant change** — the dashboard already uses Nx scaling, this just picks the optimal N.
- **The design studio parameters are FINAL.** Do not adjust radius, tilt, count, or speed values. The user spent time dialing these in.
- **Do not "improve" working code.** The oscillation function, positioning math, and camera setup are copied faithfully from the design studio.
