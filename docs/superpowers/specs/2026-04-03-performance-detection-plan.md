# Performance Detection and Low-Performance Mode — Plan

**Date:** 2026-04-03
**Status:** Planned
**Relates to:** PRD §2.1 (Rendering Pipeline), §7.1 (Ring Layout)
**Session:** 206fe1ef

---

## 1. Problem

Browsers without GPU acceleration (or with weak GPUs) become CPU-saturated rendering the 3D scene — spinning ring, floating cards, shadows, specular overlays. The dashboard becomes unresponsive. Users on these machines can't use the tool at all.

---

## 2. Detection Strategy

Three layers of detection, from fastest to most accurate:

### 2.1 Instant: GPU Identification (frame 0)

On page load, before any rendering, query WebGL for the GPU renderer:

```js
const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl');
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
```

**Software renderers** (immediate low-perf mode):
- `SwiftShader` — Chrome's CPU fallback
- `llvmpipe` — Mesa's CPU fallback (Linux)
- `Microsoft Basic Render Driver` — Windows without GPU drivers
- `Apple Software Renderer` — macOS fallback

**Weak GPUs** (flag for monitoring, don't immediately downgrade):
- Intel HD Graphics (pre-Gen 9)
- Any integrated GPU with < 1GB VRAM (not directly queryable, use renderer name heuristics)

### 2.2 Early: Hardware Capabilities (frame 0)

```js
navigator.hardwareConcurrency  // CPU cores — < 4 is concerning
navigator.deviceMemory         // RAM in GB (Chrome only) — < 4 is concerning
gl.getParameter(gl.MAX_TEXTURE_SIZE)  // < 4096 suggests weak GPU
```

These are supplementary signals, not decisive on their own.

### 2.3 Runtime: Frame Timing (first 2 seconds)

The most honest signal. Measure actual performance after the scene is running:

```js
let frameTimes = [];
let perfCheckStart = performance.now();

function perfCheck(timestamp) {
  if (frameTimes.length > 0) {
    frameTimes.push(timestamp - lastFrame);
  }
  lastFrame = timestamp;
  
  if (performance.now() - perfCheckStart < 2000) {
    requestAnimationFrame(perfCheck);
  } else {
    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    if (avg > 33) activateLowPerfMode();  // below 30fps
  }
}
```

This catches cases where the GPU looks fine on paper but can't handle the workload (too many cards, high resolution, browser throttling).

---

## 3. Low-Performance Mode

### 3.1 Tier 1: Reduce Visual Cost (soft downgrade)

Apply first. Minimal visual impact, significant performance gain:

- **Disable ring spin** — cards stay at fixed positions, no per-frame rotation math
- **Disable shadows** — remove shadow group from render, `shadowGroup.visible = false`
- **Disable specular overlays** — hide `.specular-overlay` elements
- **Reduce RENDER_SCALE** — from 2 to 1 (half-resolution rendering, text slightly softer)
- **Disable billboard slerp** — cards don't smoothly face camera, just face forward

### 3.2 Tier 2: Hide Inactive Cards (aggressive downgrade)

Apply if Tier 1 isn't enough (still below 30fps after 2 more seconds):

- **Hide unfocused cards** — set `display: none` on unfocused `.terminal-3d` elements. CSS3DRenderer won't render them at all. Ring becomes invisible.
- **Or: move behind camera** — position unfocused cards at Z far behind the camera. They're culled by the frustum but remain in the DOM (faster to restore).
- **Reduce thumbnail update rate** — `THUMB_TICK_MS` from 50 to 500
- **Disable camera tween easing** — instant camera jumps instead of smooth animation

### 3.3 Tier 3: Flat Mode (emergency fallback)

If performance is still unacceptable:

- **Disable CSS3DRenderer entirely** — render cards as flat DOM elements in a CSS grid
- **No 3D scene, no camera, no transforms** — just a tiled layout of SVG terminals
- This is essentially a completely different rendering path
- Out of scope for this plan — document as a future option

---

## 4. User Controls

### 4.1 Automatic vs Manual

- Detection runs automatically on page load
- User can override: force low-perf mode on or off
- Store preference in profile JSON via `/api/layout`
- Show a subtle indicator when low-perf mode is active (e.g., icon in status bar)

### 4.2 Settings

```js
perfMode: 'auto' | 'full' | 'reduced' | 'minimal'
```

- `auto` — detect and apply appropriate tier
- `full` — all effects enabled regardless of performance
- `reduced` — Tier 1 always active
- `minimal` — Tier 1 + 2 always active

---

## 5. Implementation Steps

### Step 1: GPU Detection Function

Add `detectGPU()` to dashboard.mjs. Returns `{ renderer, isSoftware, cores, memory }`.
Called once at init, before scene creation.

**Files:** dashboard.mjs
**Complexity:** Low

### Step 2: Frame Timing Monitor

Add `PerfMonitor` class that measures frame times during the first 2 seconds, then optionally re-checks after mode changes.

**Files:** dashboard.mjs
**Complexity:** Low

### Step 3: Tier 1 — Reduce Visual Cost

Add `setPerformanceMode(tier)` function that toggles:
- `RING.outer.spinSpeed = 0`, `RING.inner.spinSpeed = 0`
- `shadowGroup.visible = false`
- `document.querySelectorAll('.specular-overlay').forEach(e => e.style.display = 'none')`
- `RENDER_SCALE = 1` + resize renderer
- `BILLBOARD_SLERP = 0`

**Files:** dashboard.mjs, dashboard.css
**Complexity:** Low — all these are existing constants/elements being toggled

### Step 4: Tier 2 — Hide Inactive Cards

Extend `setPerformanceMode` for Tier 2:
- In animation loop, skip rendering unfocused cards (`css3dObject.visible = false`)
- Increase `THUMB_TICK_MS`
- Replace `easeInOutCubic` tween with instant position set

**Files:** dashboard.mjs
**Complexity:** Medium — need to ensure cards restore correctly when focused

### Step 5: Profile Persistence

Add `perfMode` field to profile save/load. User's preference survives page reload.

**Files:** dashboard.mjs (profile section)
**Complexity:** Low

### Step 6: Status Indicator

Add a small icon in the status bar or near the help button showing current performance mode. Click to cycle through modes.

**Files:** dashboard.mjs, dashboard.css, index.html
**Complexity:** Low

---

## 6. Testing

1. **Software renderer:** Launch Chrome with `--disable-gpu` flag. Verify auto-detection triggers Tier 1.
2. **Frame timing:** Artificially slow the animation loop (add `sleep`). Verify Tier 2 activates.
3. **Manual override:** Set `perfMode: 'full'` in profile. Verify detection is bypassed.
4. **Card restore:** Activate Tier 2 (cards hidden), then focus a card. Verify it appears and is interactive.
5. **Profile persistence:** Set performance mode, reload page. Verify mode is restored.

---

## 7. Risks

- **Tier 2 card hiding** could confuse users — cards disappear from the ring. Need a visual cue that cards exist but are hidden for performance.
- **Frame timing measurement** during the first 2 seconds may not be representative — page is still loading, WebSocket connections opening, SVGs loading. May need to delay measurement or re-check after initial load settles.
- **RENDER_SCALE change** requires renderer resize, which may cause a flash. Should be done before first render if possible.

---

## 8. Dependencies

None — this is independent of the layout system work. Can be implemented before or after layouts.
