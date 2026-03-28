# 3D Terminal Dashboard — Design Spec

**Date:** 2026-03-27
**Status:** Draft
**Project:** `/srv/svg-terminal`
**Depends on:** `2026-03-27-svg-terminal-viewer-design.md` (the SVG viewer and server are already built)

---

## 1. Overview

A 3D terminal dashboard that replaces the current CSS grid `index.html`. Terminals float at the vertices of geometric primitives that slowly rotate and morph based on terminal count. Apple Keynote aesthetic — white void, single directional light, specular highlights, soft shadows.

**Tech:** Three.js CSS3DRenderer — positions real DOM elements (our SVG terminal `<object>` tags) in 3D space using CSS transforms. No WebGL rasterization — SVG text stays crisp vector at any zoom.

**Key behaviors:**
- Terminals sit at vertices of a polyhedron that matches the session count
- The shape slowly rotates as an attract mode
- Terminals billboard toward the camera with ±5-10 degree lazy drift
- Adding/removing sessions morphs the shape smoothly (~2s transition)
- Single directional light creates consistent shadows and specular highlights
- Click a terminal to zoom in, Escape to zoom back out

---

## 2. Visual Identity

### Background
- Infinite white void with subtle gradient: `linear-gradient(180deg, #f8f8fa 0%, #e8e6e2 100%)`
- Not flat white — *lit* white. The gradient implies a horizon without drawing one.
- No grid, no floor texture. Just atmosphere.

### Light Source
- Single directional "sun" from upper-left (azimuth ~315°, elevation ~45°)
- Consistent across the scene — all shadows fall to the lower-right
- Light direction vector: approximately `(-0.7, 0.7, -0.3)` normalized

### Terminal Panels
- Background: `#1c1c1e`
- Border radius: 12px
- macOS window chrome: three dots (red/yellow/green) in header bar
- Header bar: 28px tall, `#2a2a2c`, shows session name
- Frosted matte surface with specular hot spot from light source
- Panel size: ~320×220px in 3D space (adjustable based on viewport)

### Shadows
- Each terminal casts a shadow blob on an implied floor plane
- Shadow is a CSS element positioned below the terminal, projected via 3D transform onto a horizontal plane
- Shadow offset matches light direction (upper-left light → lower-right shadow offset)
- Shadow properties scale with terminal Y-position (height above floor):
  - Close to floor: sharp, dark, small (`blur: 15px, opacity: 0.3`)
  - High above floor: soft, light, large (`blur: 40px, opacity: 0.12`)
- Implementation: a `<div>` per terminal with `background: radial-gradient(ellipse, rgba(0,0,0,opacity) 0%, transparent 70%)`, positioned and scaled based on the terminal's 3D position

### Specular Highlights
- CSS `linear-gradient` overlay on the terminal panel surface
- Gradient direction matches light source angle (~135deg)
- From `rgba(255,255,255,0.08)` at the light-facing edge to `transparent` at the opposite edge
- Intensity modulated by the panel's orientation relative to the light:
  - Panel facing light → stronger highlight (up to 0.12 alpha)
  - Panel facing away → no highlight
- Calculated per frame based on panel normal dot product with light direction

---

## 3. 3D Engine — Three.js CSS3DRenderer

### Why CSS3DRenderer
- Positions real DOM elements in 3D space using CSS `transform: matrix3d()`
- No WebGL — no texture rasterization, no canvas
- SVG text in the terminal `<object>` tags stays as real vector DOM elements
- Browser handles compositing, font rendering, and scrolling natively
- Three.js provides: scene graph, camera, frustum, billboarding math, tween interpolation

### Scene Setup
```
Camera: PerspectiveCamera(50, aspect, 0.1, 10000)
  - Position: (0, 200, 800) — slightly elevated, looking at origin
  - LookAt: (0, 0, 0)

Scene:
  - Group: "polyhedron" — contains terminal CSS3DObjects at vertex positions
  - Group: "shadows" — contains shadow divs projected on floor plane
  - Floor plane: y = -200 (invisible, just for shadow projection math)

Renderer: CSS3DRenderer
  - Sized to fill viewport
  - Appended to document body
```

### Loading Three.js
- Load from CDN: `https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js`
- CSS3DRenderer from: `https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/renderers/CSS3DRenderer.js`
- Using ES module imports via `<script type="module">`
- No build step, no bundler

---

## 4. Shape Behavior — Morphing Polyhedra

### Terminal Count → Shape Mapping

| Count | Shape | Vertex positions |
|-------|-------|-----------------|
| 1 | Single point | Center (0, 0, 0) |
| 2 | Line segment | (-R, 0, 0) and (R, 0, 0) |
| 3 | Triangle | Equilateral in XZ plane |
| 4 | Tetrahedron | 4 vertices of regular tetrahedron |
| 5 | Triangular bipyramid | 3 equatorial + 2 polar |
| 6 | Octahedron | 6 vertices of regular octahedron |
| 8 | Cube | 8 vertices of cube |
| 7, 9+ | Fibonacci sphere | N points evenly distributed on a sphere using the Fibonacci spiral method |

**Radius R:** Scales with count — `R = 200 + count * 20` (so the shape grows slightly as terminals are added, preventing overcrowding).

### Vertex Position Calculation

For known polyhedra (1-6, 8): hardcoded normalized vertex positions, scaled by R.

For Fibonacci sphere (any N):
```js
function fibonacciSphere(n, radius) {
  const points = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2; // -1 to 1
    const radiusAtY = Math.sqrt(1 - y * y);
    const theta = goldenAngle * i;
    points.push({
      x: Math.cos(theta) * radiusAtY * radius,
      y: y * radius,
      z: Math.sin(theta) * radiusAtY * radius
    });
  }
  return points;
}
```

### Morphing Transitions

When terminal count changes:
1. Calculate new vertex positions for the new count
2. Match existing terminals to nearest new positions (Hungarian algorithm or greedy nearest-neighbor)
3. New terminal (if added): spawns at the centroid, then morphs to its assigned vertex
4. Removed terminal: morphs to centroid, then fades out
5. All transitions: smooth interpolation over ~2 seconds using `easeInOutCubic`
6. During morph, shape rotation continues (don't pause)

Implementation: store `currentPosition` and `targetPosition` per terminal. Each animation frame interpolates `currentPosition` toward `targetPosition` using a lerp with easing.

---

## 5. Rotation and Attract Mode

### Constant Rotation
- The polyhedron group rotates around the Y-axis at ~12°/sec (30 seconds per revolution)
- Rotation is constant and smooth — `group.rotation.y += deltaTime * 0.2`
- Also a very subtle X-axis wobble: `group.rotation.x = Math.sin(time * 0.1) * 0.05` (~3° oscillation over ~60s)

### Mouse Interaction
- **Mouse move over scene:** Rotation pauses. Camera tilts slightly toward cursor position (parallax effect, max ±5° in X and Y). Creates a "the scene follows your gaze" feel.
- **Mouse idle 3 seconds:** Rotation resumes with a smooth ease-in over 1 second (not instant restart).
- **Mouse leave window:** Same as idle — rotation resumes.

---

## 6. Billboarding

### Goal
Terminals always *want* to face the camera but drift slightly off-axis as the shape rotates, then lazily correct back. Not instant. Not mechanical. Gravitational pull.

### Implementation
Each terminal CSS3DObject has a target quaternion (facing the camera) and a current quaternion. Each frame:

```js
// Calculate camera-facing quaternion for this terminal
const lookAtMatrix = new Matrix4().lookAt(terminal.position, camera.position, UP);
const targetQuat = new Quaternion().setFromRotationMatrix(lookAtMatrix);

// Add slight offset based on angular velocity (shape rotation speed)
// This creates the ±5-10 degree drift
const drift = new Euler(
  Math.sin(time * 0.3 + index) * 0.08,  // ±5° X
  Math.cos(time * 0.2 + index) * 0.12,  // ±7° Y
  0
);
targetQuat.multiply(new Quaternion().setFromEuler(drift));

// Damped spring toward target — 0.03 is the "laziness" factor
terminal.quaternion.slerp(targetQuat, 0.03);
```

The `0.03` slerp factor means it takes ~1-2 seconds for a terminal to fully face the camera after the shape rotates past it. The drift ensures terminals are never perfectly aligned — always slightly off, always slightly correcting.

---

## 7. Interaction

### Click to Focus
1. User clicks a terminal panel
2. Camera smoothly animates to position directly in front of that terminal (~400px away)
3. Other terminals fade to 30% opacity over 0.5s
4. Shape rotation pauses
5. The focused terminal snaps to perfect camera-facing (no drift)
6. Input bar slides up from bottom (if Phase 4 is active)

Camera animation: use a tween from current camera position to target position over ~1 second with `easeInOutCubic`.

### Thumbnail Sidebar
- A vertical strip of terminal thumbnails pinned to the right edge of the viewport
- Each thumbnail is a small (~120×80px) live preview of the terminal (miniature `<object>` of the SVG, or a static snapshot)
- Scrollable if more terminals than fit vertically
- Click a thumbnail → camera transitions to that terminal (same as clicking the 3D panel)
- The currently focused terminal's thumbnail has a highlight border (`#5c5cff`)
- Thumbnails use the slow-poll visibility tier (2000ms) since they're small — text isn't readable anyway
- In attract mode (no terminal focused): all thumbnails are unhighlighted
- The sidebar is semi-transparent (`background: rgba(0,0,0,0.03)`) so it doesn't break the white void aesthetic
- Collapses to just session name labels on narrow viewports

### Escape to Unfocus
1. Press Escape or click the background
2. Camera smoothly returns to original position
3. All terminals fade back to 100% opacity
4. Shape rotation resumes (ease-in over 1s)
5. Input bar slides away

### Hover
- Hovering over a terminal: subtle scale-up to 1.05x, border glow `box-shadow: 0 0 20px rgba(92, 92, 255, 0.3)`
- CSS transition on the terminal panel, ~0.2s

---

## 8. Session Discovery

Same mechanism as current dashboard:
- Fetch `/api/sessions` every 5 seconds
- Diff against current terminal list
- **New session:** Create terminal DOM element + CSS3DObject. Set initial position at shape centroid. Shape morphs to new polyhedron with the new vertex.
- **Removed session:** Terminal morphs to centroid, fades out over 1s, then removed from scene. Shape morphs to smaller polyhedron.
- **Existing sessions:** No action (each terminal's SVG manages its own polling).

---

## 9. Terminal DOM Structure

Each terminal in the 3D scene is a DOM element:

```html
<div class="terminal-3d" data-session="cp-greg_session_001">
  <!-- Specular highlight overlay -->
  <div class="specular-overlay"></div>
  <!-- Window chrome -->
  <header>
    <span class="dots">
      <span class="dot red"></span>
      <span class="dot yellow"></span>
      <span class="dot green"></span>
    </span>
    <span class="session-name">cp-greg_session_001</span>
  </header>
  <!-- SVG terminal viewer -->
  <object type="image/svg+xml" data="/terminal.svg?session=cp-greg_session_001"></object>
</div>
```

The CSS3DRenderer positions this entire div in 3D space. The `<object>` inside loads the self-contained SVG viewer which manages its own polling.

### Specular Overlay
Updated per frame based on panel orientation relative to light:
```css
.specular-overlay {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  pointer-events: none;
  border-radius: 12px;
  /* Angle and opacity set per-frame via JS */
  background: linear-gradient(135deg, rgba(255,255,255,0.08) 0%, transparent 60%);
}
```

---

## 10. Shadow Projection

Each terminal has a corresponding shadow element on the floor plane:

```html
<div class="terminal-shadow"></div>
```

Per frame, for each terminal:
1. Project terminal position onto floor plane (y = -200)
2. Offset shadow position by light direction vector
3. Scale shadow size based on terminal height above floor
4. Set shadow blur and opacity based on height

```js
const heightAboveFloor = terminal.position.y - FLOOR_Y;
const shadowScale = 1 + heightAboveFloor * 0.003;
const shadowBlur = 15 + heightAboveFloor * 0.1;
const shadowOpacity = Math.max(0.05, 0.3 - heightAboveFloor * 0.001);

// Shadow position = terminal XZ projected + light offset
shadowDiv.style.transform = `translate(${sx}px, ${sz}px) scale(${shadowScale})`;
shadowDiv.style.filter = `blur(${shadowBlur}px)`;
shadowDiv.style.opacity = shadowOpacity;
```

---

## 11. Animation Loop

Single `requestAnimationFrame` loop manages all animation:

```
each frame:
  1. Update time, deltaTime
  2. If not focused and not mouse-hovering:
     - Rotate polyhedron group (Y-axis + subtle X wobble)
  3. For each terminal:
     a. Interpolate position toward target (if morphing)
     b. Calculate billboard quaternion with drift
     c. Slerp current quaternion toward target
     d. Update specular overlay angle based on orientation vs light
     e. Update shadow position, scale, blur
  4. Render (CSS3DRenderer.render(scene, camera))
```

Target: 60fps. The CSS3DRenderer is lightweight since it only sets `transform` CSS properties — no pixel pushing.

---

## 12. File Structure

```
/srv/svg-terminal/
├── index.html              # Complete rewrite — 3D dashboard
├── dashboard.css            # Dashboard styles (panels, shadows, specular)
├── dashboard.mjs            # Main module: scene setup, animation loop, session discovery
├── polyhedra.mjs            # Vertex calculations, morphing, Fibonacci sphere
├── server.mjs               # Unchanged
├── terminal.svg             # Unchanged
├── sgr-parser.mjs           # Unchanged
├── color-table.mjs          # Unchanged
```

**Why separate files?**
- `dashboard.mjs` owns the scene, camera, animation loop, and session management
- `polyhedra.mjs` is pure math — vertex positions for each shape, morph interpolation, Fibonacci distribution. Independently testable.
- `dashboard.css` keeps all the visual styling out of the JavaScript

---

## 13. Test Plan

1. **Scene renders:** Open `http://localhost:3200/` — see rotating polyhedron with terminal panels
2. **Session count mapping:** With 3 sessions → triangle. 4 → tetrahedron. 6 → octahedron. Verify shape matches count.
3. **Morphing:** Create a new tmux session → shape smoothly morphs to accommodate new vertex (~2s). Kill a session → shape contracts.
4. **Billboarding:** As shape rotates, terminals drift slightly off camera-facing then lazily correct back. Never more than ~10° off.
5. **Shadows:** Each terminal has a shadow blob below it. Shadows are offset in the light direction. Higher terminals have softer, larger shadows.
6. **Specular:** Terminal panels have a subtle bright edge on the upper-left (light-facing) side. Intensity changes as panels rotate.
7. **Click focus:** Click a terminal → camera zooms smoothly to that terminal. Others fade. Escape returns to overview.
8. **Mouse parallax:** Move mouse over scene → camera tilts slightly toward cursor. Stop moving → rotation resumes after 3s.
9. **Background:** White void with subtle gradient. Clean, not flat.
10. **Performance:** 6 terminals at 60fps. No visible jank during morphing or rotation.
11. **Terminal content:** SVG terminals inside the 3D panels still poll and update live content correctly.

---

## 14. Out of Scope

- WebGL rendering (using CSS3DRenderer only)
- Mobile touch gestures
- VR/AR modes
- Terminal resize within 3D view
- Drag to rearrange terminals
- Multiple camera presets / viewpoints
- Audio / sound effects
