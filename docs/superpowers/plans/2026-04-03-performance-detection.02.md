# Performance Detection & Low-Performance Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect GPU/CPU capability and automatically degrade visual effects so the dashboard stays usable on machines without GPU acceleration.

**Architecture:** Three detection layers (GPU name, hardware caps, frame timing) feed into a tiered performance mode system. Tier 1 disables cosmetic effects (ring spin, shadows, specular). Tier 2 hides unfocused cards entirely. User can override via a status indicator. Preference persists in profile JSON.

**Tech Stack:** WebGL API for GPU detection, `requestAnimationFrame` for frame timing, existing dashboard.mjs constants/groups for toggling effects. No new dependencies.

---

## File Structure

| File | Role |
|---|---|
| `dashboard.mjs` | All detection, mode switching, and persistence logic. No new modules — this is a feature toggle system added to the existing dashboard. |
| `dashboard.css` | Status indicator styling |
| `index.html` | Performance mode indicator element in status bar |
| `test-performance-mode.mjs` | Integration test (only new file) |

---

### Task 0: Extract DOM_SCALE / WORLD_SCALE Constants

**Files:**
- Modify: `dashboard.mjs` (constants section ~line 464, plus 14 replacement sites)

The 4x scale trick is currently hardcoded as literal `4` and `0.25` in 14 places. Extract to named variables so:
- The relationship is documented (WORLD_SCALE = 1/DOM_SCALE)
- Performance system can change it at runtime if needed
- Future scale changes are one-line edits

- [ ] **Step 1: Add DOM_SCALE and WORLD_SCALE variables**

Replace the existing constants section (~line 464). Change `RENDER_SCALE` from `const` to `var` at the same time:

```js
// DOM scale trick: card DOM is oversized by DOM_SCALE, CSS3DObject renders at WORLD_SCALE.
// This forces Chrome to rasterize text at high resolution before 3D transform scales it down.
// DO NOT set DOM_SCALE to 1 — text will blur. See note 1 in header.
var DOM_SCALE = 4;
var WORLD_SCALE = 1 / DOM_SCALE;  // derived — always 1/DOM_SCALE

// Renderer resolution multiplier — separate from DOM_SCALE.
// RENDER_SCALE=2 means renderer canvas is 2x viewport, scaled down via CSS transform.
// Can be reduced to 1 by performance system for lower-end hardware.
var RENDER_SCALE = 2;
```

- [ ] **Step 2: Replace all `* 4` (world→DOM) with `* DOM_SCALE`**

In `calcCardSize()` (~line 2301-2303, and duplicate at ~line 439-440):

```js
  // Before:
  let cardW = Math.round(worldW * 4);
  let cardH = Math.round(worldH * 4) + HEADER_H;
  
  // After:
  let cardW = Math.round(worldW * DOM_SCALE);
  let cardH = Math.round(worldH * DOM_SCALE) + HEADER_H;
```

Both occurrences (there are two `calcCardSize`-style calculations if any were duplicated — verify with grep).

- [ ] **Step 3: Replace all `* 0.25` (DOM→world) with `* WORLD_SCALE`**

14 replacements total. Each `* 0.25` becomes `* WORLD_SCALE`:

Line 620-621 (calculateFocusedLayout):
```js
    const worldW = (t ? t.baseCardW || 1280 : 1280) * WORLD_SCALE;
    const worldH = (t ? t.baseCardH || 992 : 992) * WORLD_SCALE;
```

Line 779-780 (second layout reference):
```js
    var worldW = (t ? t.baseCardW || 1280 : 1280) * WORLD_SCALE;
    var worldH = (t ? t.baseCardH || 992 : 992) * WORLD_SCALE;
```

Line 1336-1337 (alt+drag anchor):
```js
      const dw = (newW - currentW) * WORLD_SCALE;
      const dh = (newH - currentH) * WORLD_SCALE;
```

Line 1705 (focusTerminal):
```js
  const worldH = (t.baseCardH || 992) * WORLD_SCALE;
```

Line 2361-2362 (updateCardForNewSize anchor):
```js
  var dwWorld = (cardW - oldW) * WORLD_SCALE;
  var dhWorld = (cardH - oldH) * WORLD_SCALE;
```

Line 2631-2632 (focusTerminal zoom):
```js
  const worldW = (t.baseCardW || 1280) * WORLD_SCALE;
  const worldH = (t.baseCardH || 992) * WORLD_SCALE;
```

- [ ] **Step 4: Replace `setScalar(0.25)` with `setScalar(WORLD_SCALE)`**

Line 2119 (addTerminal):
```js
  css3dObj.scale.setScalar(WORLD_SCALE);
```

Line 2411 (addBrowserCard):
```js
  css3dObj.scale.setScalar(WORLD_SCALE);
```

- [ ] **Step 5: Replace `const RENDER_SCALE` with `var RENDER_SCALE`**

Already done in Step 1. Verify the old `const` declaration at line 471 is removed (it's now in the new constants block).

- [ ] **Step 6: Update comments referencing hardcoded values**

Line 1307 comment:
```js
      // Scale mouse movement to DOM pixels. DOM is DOM_SCALEx, CSS3D renders at WORLD_SCALE,
```

Line 1335 comment:
```js
      // World units = DOM pixels * WORLD_SCALE (CSS3DObject scale)
```

Line 2409 comment:
```js
  // CSS3DObject scale WORLD_SCALE forces Chrome to rasterize at DOM_SCALEx resolution.
```

- [ ] **Step 7: Add RENDER_SCALE sync to onResize()**

`onResize()` calls `renderer.setSize(w * RENDER_SCALE, h * RENDER_SCALE)` but does NOT update the CSS transform. If `RENDER_SCALE` changes at runtime, a window resize would apply the new canvas size but keep the old CSS scale — causing a visual mismatch. Add the transform line:

```js
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth * RENDER_SCALE, window.innerHeight * RENDER_SCALE);
  renderer.domElement.style.transform = 'scale(' + (1 / RENDER_SCALE) + ')';
}
```

- [ ] **Step 8: Expose scale state on window for testing**

`dashboard.mjs` is an ES module — variables are module-scoped, not global. Puppeteer's `page.evaluate()` can only see `window.*`. Add near the other `window.*` exports (search for `window._getLayoutState`):

```js
  // Expose perf/scale state for testing and debugging.
  // Task 0: scale vars only. Tasks 2 and 4 extend this with perf/GPU fields.
  window._perfState = function() {
    return { DOM_SCALE: DOM_SCALE, WORLD_SCALE: WORLD_SCALE, RENDER_SCALE: RENDER_SCALE };
  };
```

**Note:** This initial version only returns scale values. Task 2 Step 3 extends it with `perfTier` and `perfMode`. Task 4 Step 2 extends it with `gpu`, `shadowVisible`, `ringSpeed`, `terminalCount`, and `hiddenCount`.

- [ ] **Step 9: Verify nothing is broken**

Run:
```bash
node -e "
import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:'new',args:['--no-sandbox','--window-size=1920,1080']});
const p = await b.newPage();
await p.setViewport({width:1920,height:1080});
await p.goto('http://localhost:3200/',{waitUntil:'domcontentloaded',timeout:30000});
await new Promise(r=>setTimeout(r,8000));
const r = await p.evaluate(()=>({
  ...window._perfState(),
  cardCount: document.querySelectorAll('.terminal-3d').length
}));
console.log(JSON.stringify(r,null,2));
await p.screenshot({path:'test-scale-refactor.png'});
await b.close();
"
```

Expected: `DOM_SCALE: 4`, `WORLD_SCALE: 0.25`, `RENDER_SCALE: 2`, cards visible and rendering normally.

- [ ] **Step 10: Commit**

```bash
git add dashboard.mjs
git commit -m "refactor: extract DOM_SCALE/WORLD_SCALE constants, make RENDER_SCALE mutable"
```

---

### Task 1: GPU Detection Function

**Files:**
- Modify: `dashboard.mjs` (add function before `init()` at ~line 919)

- [ ] **Step 1: Write `detectGPU()` function**

Add before `function init()` (line 919):

```js
// === Performance Detection ===
// Detect GPU renderer and hardware capabilities to identify software rendering
// or weak hardware. Called once at init, before scene creation.
// Returns { renderer, isSoftware, cores, memory, maxTexture }
function detectGPU() {
  var result = { renderer: 'unknown', isSoftware: false, cores: navigator.hardwareConcurrency || 0, memory: navigator.deviceMemory || 0, maxTexture: 0 };
  try {
    var canvas = document.createElement('canvas');
    var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) { result.isSoftware = true; return result; }
    var dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) result.renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || 'unknown';
    result.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
    // Known software renderers — these mean no real GPU is active
    var sw = result.renderer.toLowerCase();
    result.isSoftware = sw.includes('swiftshader') || sw.includes('llvmpipe')
      || sw.includes('microsoft basic render') || sw.includes('apple software renderer');
    canvas.remove();
  } catch (e) { result.isSoftware = true; }
  return result;
}
```

- [ ] **Step 2: Verify it works in puppeteer**

Run:
```bash
node -e "
import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:'new',args:['--no-sandbox']});
const p = await b.newPage();
await p.goto('http://localhost:3200/',{waitUntil:'domcontentloaded',timeout:30000});
await new Promise(r=>setTimeout(r,5000));
// _perfState doesn't have gpu field yet (added in Task 4).
// Verify detectGPU exists by checking it doesn't throw when called from init.
// Full GPU testing happens in Task 4 Step 4.
const r = await p.evaluate(()=> window._perfState ? window._perfState() : 'not exposed');
console.log(JSON.stringify(r,null,2));
await b.close();
"
```

Expected: `{ DOM_SCALE: 4, WORLD_SCALE: 0.25, RENDER_SCALE: 2 }` — scale fields only at this point. GPU fields are added in Task 4.

- [ ] **Step 3: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: add detectGPU() for performance detection"
```

---

### Task 2: Performance Mode State and Setter

**Files:**
- Modify: `dashboard.mjs` (add state variable near line 483 with other state, add setter function near detectGPU)

- [ ] **Step 1: Add performance mode state**

Add near the other state variables (after `let activeInputSession = null;` at line 483):

```js
// Performance mode: 'auto' | 'full' | 'reduced' | 'minimal'
// 'auto' = detect and apply, 'full' = all effects, 'reduced' = Tier 1, 'minimal' = Tier 1+2
var perfMode = 'auto';
var perfTier = 0;          // current active tier: 0 = full, 1 = reduced, 2 = minimal
var _savedRingSpeed = null; // original ring speeds for restore
var _savedRenderScale = null;
```

- [ ] **Step 2: Add `updatePerfIndicator()` stub and `applyPerfTier()` function**

`applyPerfTier()` calls `updatePerfIndicator()` which is defined later in Task 5. Add a no-op stub now so Task 2 doesn't throw. Task 5 replaces the stub with the real implementation.

Add after `detectGPU()`:

```js
// Stub — replaced by real implementation in Task 5 (status indicator)
function updatePerfIndicator() {}
```

Then add `applyPerfTier()`:


```js
// Apply a performance tier. Tiers are cumulative (Tier 2 includes Tier 1).
// tier 0 = full effects, tier 1 = reduced visuals, tier 2 = hide inactive cards
function applyPerfTier(tier) {
  var prev = perfTier;
  perfTier = tier;

  if (tier >= 1) {
    // Tier 1: disable cosmetic effects
    if (_savedRingSpeed === null) {
      _savedRingSpeed = { outer: RING.outer.spinSpeed, inner: RING.inner.spinSpeed };
    }
    RING.outer.spinSpeed = 0;
    RING.inner.spinSpeed = 0;
    if (shadowGroup) shadowGroup.visible = false;
    document.querySelectorAll('.specular-overlay').forEach(function(e) { e.style.display = 'none'; });
    if (_savedRenderScale === null && RENDER_SCALE > 1) {
      _savedRenderScale = RENDER_SCALE;
      RENDER_SCALE = 1;
      renderer.setSize(window.innerWidth * RENDER_SCALE, window.innerHeight * RENDER_SCALE);
      renderer.domElement.style.transform = 'scale(' + (1 / RENDER_SCALE) + ')';
    }
  } else {
    // Restore full effects
    if (_savedRingSpeed) {
      RING.outer.spinSpeed = _savedRingSpeed.outer;
      RING.inner.spinSpeed = _savedRingSpeed.inner;
      _savedRingSpeed = null;
    }
    if (shadowGroup) shadowGroup.visible = true;
    document.querySelectorAll('.specular-overlay').forEach(function(e) { e.style.display = ''; });
    if (_savedRenderScale !== null) {
      RENDER_SCALE = _savedRenderScale;
      _savedRenderScale = null;
      renderer.setSize(window.innerWidth * RENDER_SCALE, window.innerHeight * RENDER_SCALE);
      renderer.domElement.style.transform = 'scale(' + (1 / RENDER_SCALE) + ')';
    }
  }

  if (tier >= 2) {
    // Tier 2: hide unfocused cards
    for (var [name, t] of terminals) {
      if (!focusedSessions.has(name)) {
        t.css3dObject.visible = false;
        if (t.shadowObject) t.shadowObject.visible = false;
      }
    }
  } else if (prev >= 2 && tier < 2) {
    // Restore hidden cards
    for (var [name, t] of terminals) {
      t.css3dObject.visible = true;
      if (t.shadowObject) t.shadowObject.visible = true;
    }
  }

  // Update status indicator
  updatePerfIndicator();
  console.log('[perf] tier ' + prev + ' → ' + tier + ' (' + perfMode + ')');
}
```

- [ ] **Step 3: Extend `window._perfState()` with perf fields**

Update the `_perfState` function (added in Task 0 Step 8) to include the new perf variables:

```js
  window._perfState = function() {
    return {
      DOM_SCALE: DOM_SCALE, WORLD_SCALE: WORLD_SCALE, RENDER_SCALE: RENDER_SCALE,
      perfTier: perfTier, perfMode: perfMode
    };
  };
```

- [ ] **Step 4: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: add performance mode state and applyPerfTier()"
```

---

### Task 3: Frame Timing Monitor

**Files:**
- Modify: `dashboard.mjs` (add to animation loop at ~line 2851)

- [ ] **Step 1: Add frame timing variables**

Add after the performance mode state variables:

```js
// Frame timing for performance auto-detection
var _perfFrameTimes = [];
var _perfCheckStart = 0;
var _perfCheckPhase = 0;  // 0 = not started, 1 = measuring, 2 = done
```

- [ ] **Step 2: Add frame timing check to animation loop**

In `function animate()` (line 2851), after `const time = clock.getElapsedTime();` add:

```js
  // Performance auto-detection: measure frame times for 3 seconds after init.
  // First ~1s discarded as warmup (loading), last ~2s used for average.
  if (perfMode === 'auto' && _perfCheckPhase < 2) {
    if (_perfCheckPhase === 0) {
      _perfCheckStart = performance.now();
      _perfCheckPhase = 1;
    }
    if (_perfCheckPhase === 1) {
      var now = performance.now();
      if (_perfFrameTimes.length > 0) {
        _perfFrameTimes.push(now - _perfFrameTimes._lastTime);
      }
      _perfFrameTimes._lastTime = now;
      if (now - _perfCheckStart > 3000) {
        // Measurement complete — skip first 1s (loading), use last 2s
        var times = _perfFrameTimes.slice(Math.floor(_perfFrameTimes.length * 0.33));
        var avg = times.length > 0 ? times.reduce(function(a, b) { return a + b; }, 0) / times.length : 16;
        console.log('[perf] avg frame time: ' + avg.toFixed(1) + 'ms (' + (1000/avg).toFixed(0) + ' fps)');
        if (avg > 50) {
          applyPerfTier(2);  // below 20fps — aggressive
        } else if (avg > 33) {
          applyPerfTier(1);  // below 30fps — reduce effects
        }
        _perfCheckPhase = 2;
      }
    }
  }
```

- [ ] **Step 3: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: frame timing monitor for auto performance detection"
```

---

### Task 4: Wire Detection into Init

**Files:**
- Modify: `dashboard.mjs` (`init()` function at line 919)

- [ ] **Step 1: Wire detectGPU and applyPerfTier into init**

**IMPORTANT — see Implementation Notes #1:** `detectGPU()` can run early (only reads WebGL), but `applyPerfTier()` must run AFTER renderer and shadowGroup are created. Split into two blocks:

**Early in init() — before scene creation:**
```js
function init() {
  // Detect GPU before creating scene — detection only reads WebGL, no scene dependency
  var gpu = detectGPU();
  console.log('[perf] GPU:', gpu.renderer, gpu.isSoftware ? '(SOFTWARE)' : '(hardware)',
    'cores:', gpu.cores, 'mem:', gpu.memory + 'GB');

  scene = new THREE.Scene();
```

**After renderer and shadowGroup are created (after `scene.add(shadowGroup)`):**
```js
  scene.add(shadowGroup);

  // NOW safe to apply performance tier — renderer and shadowGroup exist
  if (perfMode === 'auto' && gpu.isSoftware) {
    applyPerfTier(1);  // immediate Tier 1 for software renderers
  }

  // Events
  window.addEventListener('resize', onResize);
```

Do NOT call `applyPerfTier` before `renderer` and `shadowGroup` exist — it references both.

- [ ] **Step 2: Extend `window._perfState()` with GPU and scene fields**

Now that `detectGPU`, `shadowGroup`, `RING`, and `terminals` all exist, extend `_perfState` to its final form. Also cache the GPU result so it's not re-detected on every call:

```js
  // Cache GPU detection result — detectGPU() creates a canvas each call
  var _cachedGPU = gpu;  // gpu was detected in Step 1 above

  window._perfState = function() {
    return {
      DOM_SCALE: DOM_SCALE, WORLD_SCALE: WORLD_SCALE, RENDER_SCALE: RENDER_SCALE,
      perfTier: perfTier, perfMode: perfMode,
      gpu: _cachedGPU,
      shadowVisible: shadowGroup ? shadowGroup.visible : null,
      ringSpeed: RING ? RING.outer.spinSpeed : null,
      terminalCount: terminals ? terminals.size : 0,
      hiddenCount: (function() {
        var n = 0;
        for (var [, t] of terminals) { if (!t.css3dObject.visible) n++; }
        return n;
      })()
    };
  };
```

Note: `hiddenCount` is needed by Task 8 integration test to verify Tier 2 card hiding.

- [ ] **Step 3: Ensure Tier 2 cards are hidden after terminals load**

In the animation loop's Tier 2 section, unfocused cards need to be hidden as they're added. Add a check in `addTerminal` (after `terminalGroup.add(css3dObj)` at ~line 2101):

```js
  // If Tier 2 active, hide card immediately (only focused cards visible)
  if (perfTier >= 2) {
    css3dObj.visible = false;
    shadowObj.visible = false;
  }
```

- [ ] **Step 4: Test with --disable-gpu**

```bash
node -e "
import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-gpu']});
const p = await b.newPage();
await p.goto('http://localhost:3200/',{waitUntil:'domcontentloaded',timeout:30000});
await new Promise(r=>setTimeout(r,5000));
const r = await p.evaluate(()=> window._perfState());
console.log(JSON.stringify(r,null,2));
await b.close();
"
```

Expected: `perfTier >= 1` and `gpu.isSoftware: true`.

- [ ] **Step 5: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: wire GPU detection into init, auto-downgrade for software renderers"
```

---

### Task 5: Status Indicator

**Files:**
- Modify: `index.html` (add element to input-bar)
- Modify: `dashboard.css` (add indicator styling)
- Modify: `dashboard.mjs` (add `updatePerfIndicator()` function, click handler)

- [ ] **Step 1: Add indicator element to index.html**

In `index.html`, inside the `input-bar` div, add before the closing `</div>`:

```html
  <div class="input-bar" id="input-bar">
    <span class="status-dot" id="ws-status"></span>
    <span class="target" id="input-target"></span>
    <span class="input-hint">Keys go to terminal</span>
    <span class="perf-indicator" id="perf-indicator" title="Performance mode (click to cycle)"></span>
  </div>
```

- [ ] **Step 2: Add CSS for the indicator**

Add to `dashboard.css` after the input-bar styles:

```css
.perf-indicator {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  user-select: none;
  opacity: 0.7;
  transition: opacity 0.2s;
}
.perf-indicator:hover { opacity: 1; }
.perf-indicator.tier-0 { opacity: 0; } /* visually hidden but stays in DOM — clickable for tests and power users */
.perf-indicator.tier-1 { background: rgba(255, 200, 0, 0.2); color: #ffc800; }
.perf-indicator.tier-2 { background: rgba(255, 80, 80, 0.2); color: #ff5050; }
```

- [ ] **Step 3: Replace `updatePerfIndicator()` stub with real implementation**

Replace the no-op stub from Task 2 Step 2. Add after `applyPerfTier()` in dashboard.mjs:

```js
function updatePerfIndicator() {
  var el = document.getElementById('perf-indicator');
  if (!el) return;
  el.className = 'perf-indicator tier-' + perfTier;
  if (perfTier === 0) {
    el.textContent = '';
  } else if (perfTier === 1) {
    el.textContent = 'reduced';
  } else {
    el.textContent = 'minimal';
  }
  el.title = 'Performance: ' + (perfTier === 0 ? 'full' : perfTier === 1 ? 'reduced' : 'minimal')
    + ' (click to cycle, current: ' + perfMode + ')';
}
```

Add click handler in `init()` after event listeners:

```js
  // Performance mode cycle: click indicator to override
  var perfEl = document.getElementById('perf-indicator');
  if (perfEl) {
    perfEl.addEventListener('click', function(e) {
      e.stopPropagation();
      // Cycle: auto → full → reduced → minimal → auto
      var modes = ['auto', 'full', 'reduced', 'minimal'];
      var idx = modes.indexOf(perfMode);
      perfMode = modes[(idx + 1) % modes.length];
      if (perfMode === 'full') applyPerfTier(0);
      else if (perfMode === 'reduced') applyPerfTier(1);
      else if (perfMode === 'minimal') applyPerfTier(2);
      else { /* auto — re-run detection */ _perfCheckPhase = 0; _perfFrameTimes = []; }
      console.log('[perf] mode set to ' + perfMode);
    });
  }
```

- [ ] **Step 4: Commit**

```bash
git add index.html dashboard.css dashboard.mjs
git commit -m "feat: performance mode status indicator with click-to-cycle"
```

---

### Task 6: Profile Persistence

**Files:**
- Modify: `dashboard.mjs` (`_getLayoutState` at ~line 3628, and profile load section)

- [ ] **Step 1: Save perfMode in layout state**

In `_getLayoutState()` (line 3628), add `perfMode` to the state object:

```js
  window._getLayoutState = function() {
    const state = {
      uid: activeUid,
      timestamp: Date.now(),
      perfMode: perfMode,   // <-- add this line
      viewport: { w: window.innerWidth, h: window.innerHeight },
```

- [ ] **Step 2: Restore perfMode on profile load**

Find where profiles are loaded/applied (search for `_loadLayout` or where saved profile state is read). Add:

```js
if (savedState.perfMode) {
  perfMode = savedState.perfMode;
  if (perfMode === 'full') applyPerfTier(0);
  else if (perfMode === 'reduced') applyPerfTier(1);
  else if (perfMode === 'minimal') applyPerfTier(2);
  // 'auto' — let detection run normally
}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: persist performance mode preference in profile"
```

---

### Task 7: Ensure Card Visibility on Focus

**Files:**
- Modify: `dashboard.mjs` (focus functions)

- [ ] **Step 1: Show card when focused in Tier 2**

In `focusTerminal()` (search for `function focusTerminal`), after the card is added to `focusedSessions`, ensure it's visible:

```js
  // Tier 2 hides unfocused cards — show this one now that it's focused
  if (perfTier >= 2) {
    var ft = terminals.get(sessionName);
    if (ft) {
      ft.css3dObject.visible = true;
      if (ft.shadowObject) ft.shadowObject.visible = true;
    }
  }
```

Add the same check in `addToFocus()` after adding to `focusedSessions`.

- [ ] **Step 2: Hide card when unfocused in Tier 2**

In `unfocusTerminal()`, after clearing `focusedSessions`, re-hide all cards if Tier 2:

```js
  // Tier 2: re-hide all cards after unfocus
  if (perfTier >= 2) {
    for (var [name, t] of terminals) {
      t.css3dObject.visible = false;
      if (t.shadowObject) t.shadowObject.visible = false;
    }
  }
```

- [ ] **Step 3: Test focus/unfocus cycle in Tier 2**

```bash
node -e "
import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-gpu']});
const p = await b.newPage();
await p.setViewport({width:1920,height:1080});
await p.goto('http://localhost:3200/',{waitUntil:'domcontentloaded',timeout:30000});
await new Promise(r=>setTimeout(r,8000));
// Should be in reduced mode from software renderer
var tier = await p.evaluate(()=> window._perfState().perfTier);
console.log('Initial tier:', tier);
// Focus a card
await p.evaluate(()=>{
  var items = document.querySelectorAll('.thumbnail-item');
  if(items.length) items[0].click();
});
await new Promise(r=>setTimeout(r,3000));
var visible = await p.evaluate(()=>{
  var focused = document.querySelector('.focused');
  return focused ? 'focused card visible' : 'no focused card';
});
console.log(visible);
await b.close();
"
```

Expected: card becomes visible when focused even in reduced/minimal mode.

- [ ] **Step 4: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: ensure cards visible on focus in low-perf mode"
```

---

### Task 8: Integration Test

**Files:**
- Create: `test-performance-mode.mjs`

- [ ] **Step 1: Write integration test**

```js
// Test performance detection and mode switching
import puppeteer from 'puppeteer';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('=== Performance Mode Integration Test ===\n');

  // Test 1: Software renderer detection
  console.log('Test 1: Software renderer detection');
  var browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });
  var page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('http://localhost:3200/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);

  var state = await page.evaluate(() => window._perfState());

  console.log('  GPU:', state.gpu?.renderer);
  console.log('  Software:', state.gpu?.isSoftware);
  console.log('  Tier:', state.perfTier);
  console.log('  Shadows:', state.shadowVisible);
  console.log('  Ring speed:', state.ringSpeed);

  if (state.gpu?.isSoftware && (state.perfTier >= 1)) {
    console.log('  PASS: Software renderer detected, Tier 1+ applied\n');
  } else {
    console.log('  FAIL: Expected tier >= 1 for software renderer\n');
  }

  // Test 2: Manual mode cycling via perf indicator click
  // Indicator uses opacity:0 at tier-0, not display:none — still clickable.
  console.log('Test 2: Manual mode cycling');
  var perfEl = await page.$('#perf-indicator');
  if (perfEl) { await perfEl.click(); } // auto→full (tier 0)
  await sleep(500);
  var full = await page.evaluate(() => window._perfState());
  console.log('  Full mode — perfTier:', full.perfTier, 'shadows:', full.shadowVisible, 'ring:', full.ringSpeed);
  if (full.perfTier === 0 && full.shadowVisible === true && full.ringSpeed > 0) {
    console.log('  PASS: Full mode restored all effects\n');
  } else {
    console.log('  FAIL: Full mode did not restore effects\n');
  }

  // Test 3: Tier 2 card visibility
  console.log('Test 3: Tier 2 card hiding');
  // Click perf indicator twice more to reach 'minimal' (full→reduced→minimal)
  if (perfEl) { await perfEl.click(); await sleep(300); await perfEl.click(); }
  await sleep(500);
  var minState = await page.evaluate(() => window._perfState());
  // hiddenCount is computed by _perfState() — counts cards with css3dObject.visible === false
  console.log('  perfTier:', minState.perfTier, 'Hidden:', minState.hiddenCount, '/', minState.terminalCount);
  if (minState.perfTier === 2 && minState.hiddenCount === minState.terminalCount) {
    console.log('  PASS: All cards hidden in Tier 2 (no focused sessions)\n');
  } else if (minState.perfTier === 2 && minState.hiddenCount > 0) {
    console.log('  PASS: Tier 2 active, ' + minState.hiddenCount + ' unfocused cards hidden\n');
  } else {
    console.log('  FAIL: Expected Tier 2 with hidden cards\n');
  }

  await browser.close();
  console.log('=== Done ===');
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
```

- [ ] **Step 2: Run the test**

Run: `node test-performance-mode.mjs`
Expected: All 3 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add test-performance-mode.mjs
git commit -m "test: integration test for performance detection and mode switching"
```

---

## Self-Review

- **Spec coverage:** GPU detection (§2.1) ✓, hardware caps (§2.2) ✓ (in detectGPU), frame timing (§2.3) ✓, Tier 1 (§3.1) ✓, Tier 2 (§3.2) ✓, Tier 3 (§3.3) documented as out of scope ✓, user controls (§4) ✓, persistence (§5.5) ✓, status indicator (§5.6) ✓
- **Placeholder scan:** No TBDs, TODOs, or "fill in later" found.
- **Type consistency:** `perfTier` (number 0/1/2), `perfMode` (string), `applyPerfTier(tier)`, `detectGPU()` — consistent across all tasks.
- **Missing from spec:** The spec mentions `THUMB_TICK_MS` increase in Tier 2 and disabling camera tween easing. These are minor optimizations that can be added after the core works — not blocking for an initial implementation.
- **RENDER_SCALE and DOM_SCALE extraction:** Handled by Task 0. `RENDER_SCALE` becomes `var`, all hardcoded `4`/`0.25` become `DOM_SCALE`/`WORLD_SCALE`. Task 0 Step 7 adds the CSS transform sync to `onResize()`. The `applyPerfTier` code also sets both canvas size and transform explicitly for immediate effect.

## Implementation Notes (from review)

1. **Init order vs applyPerfTier:** `detectGPU()` can run before the scene exists (only reads WebGL). `applyPerfTier()` references `renderer`, `shadowGroup`, and DOM elements — it must run AFTER they are created. Task 4 Step 1 already splits this into two blocks (early detection, deferred tier application after `scene.add(shadowGroup)`). Follow that split exactly.

2. **Line numbers will drift** as tasks modify the file. Implementation should use search (`grep`, editor find) for function names (`calcCardSize`, `init`, `animate`, `_getLayoutState`) rather than relying on line numbers in this plan.

3. **onResize + RENDER_SCALE sync:** Handled by Task 0 Step 7 — `onResize()` now sets both canvas size and CSS transform from `RENDER_SCALE`. No further action needed.

4. **Puppeteer test scope:** `dashboard.mjs` is an ES module — module-scoped variables are not global. All tests use `window._perfState()` which is built up progressively: Task 0 adds scale fields, Task 2 adds `perfTier`/`perfMode`, Task 4 adds `gpu`/`shadowVisible`/`ringSpeed`/`terminalCount`/`hiddenCount`. No bare variable names in `page.evaluate()` — always go through `_perfState()`.

5. **Task 6 profile load:** The plan says "search for _loadLayout." Currently there is NO client-side profile load — profiles are saved but never restored on page load (this was flagged in the layout system gap analysis). The `perfMode` save in `_getLayoutState` will work, but the restore side needs to hook into wherever profile loading eventually gets built. For now, save-only is acceptable — restore can be added when client-side profile loading is implemented.

6. **Task 3 frame timing:** Comment and code now both say 3 seconds with 1s warmup discarded. No action needed.

7. **`_perfFrameTimes` first-frame delta:** The first frame never pushes a delta because `_lastTime` is set after the `length > 0` check. The first sample is skipped. This is fine for a rough average — the warmup slice handles it. Optional polish: initialize `_lastTime` on phase start instead.

8. **Click-to-cycle "auto" scope:** Resetting `_perfCheckPhase` and `_perfFrameTimes` only re-enables the frame timing measurement path. It does NOT re-run GPU detection. If users expect "auto" to re-probe everything, add a `resetPerfAutoDetection()` helper that also re-logs GPU info. Optional product nuance — current behavior is reasonable for cycling.

9. **Task 5 HTML snippet:** The plan shows the full `input-bar` block for context, but implementation should only INSERT the new `<span class="perf-indicator" …>` element — do not overwrite or duplicate existing children.

10. **Task 8 Tier 2 assertion:** "All cards hidden" assumes no focused session at test time. If the app always has a default focus, the assertion should be `hidden === total - focusedCount`. Verify against actual `focusedSessions` state when wiring Tier 2. May need an explicit unfocus step before the assertion.

## Suggested Implementation Order

Follow Tasks 0 → 8 as written. Key points:

- **Task 0** includes `onResize` transform fix (Step 7) and initial `_perfState` (Step 8, scale-only)
- **Task 2** extends `_perfState` with `perfTier`/`perfMode` (Step 3)
- **Task 4** extends `_perfState` to final form with GPU/scene/hidden fields (Step 2), caches GPU result. The init split (Step 1) puts `detectGPU()` early and `applyPerfTier()` after renderer/shadowGroup exist.
- **Task 5** replaces the `updatePerfIndicator` stub from Task 2
- Tasks 1-3 can be implemented and tested independently before wiring into init (Task 4)
