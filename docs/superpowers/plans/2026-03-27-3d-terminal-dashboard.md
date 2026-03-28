# 3D Terminal Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current CSS grid dashboard with a 3D scene where terminal panels float at vertices of morphing polyhedra, with cinematic lighting, billboarding, and smooth transitions.

**Architecture:** Three.js CSS3DRenderer positions real DOM elements in 3D space. `polyhedra.mjs` handles pure vertex math. `dashboard.mjs` owns the scene, camera, animation loop, and session discovery. `dashboard.css` handles all visual styling. The existing `terminal.svg` and `server.mjs` are unchanged.

**Tech Stack:** Three.js (CDN, ES modules), CSS3DRenderer, CSS transforms for shadows/specular, existing Node.js server + SVG terminal viewer.

**Spec:** `docs/superpowers/specs/2026-03-27-3d-terminal-dashboard-design.md`

---

## File Structure

```
/srv/svg-terminal/
├── index.html              # Complete rewrite — loads Three.js, dashboard.mjs, dashboard.css
├── dashboard.css            # All visual styling: terminal panels, shadows, specular, sidebar, background
├── dashboard.mjs            # Scene setup, animation loop, session discovery, interaction, billboarding
├── polyhedra.mjs            # Pure math: vertex positions per shape, morphing interpolation, Fibonacci sphere
├── test-polyhedra.mjs       # Unit tests for vertex calculations (node --test)
├── server.mjs               # Unchanged (already serves static files from project dir)
├── terminal.svg             # Unchanged
```

- `polyhedra.mjs` — pure functions, no Three.js dependency, testable with `node --test`
- `dashboard.mjs` — the main module, depends on Three.js + polyhedra.mjs
- `dashboard.css` — all CSS, no JS logic
- `index.html` — minimal HTML shell that loads everything

---

## Task 1: Polyhedra Vertex Calculator

**Files:**
- Create: `/srv/svg-terminal/polyhedra.mjs`
- Create: `/srv/svg-terminal/test-polyhedra.mjs`

- [ ] **Step 1: Write the test file**

```js
// test-polyhedra.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getVertices, fibonacciSphere } from './polyhedra.mjs';

describe('getVertices', () => {
  it('returns 1 vertex at origin for count=1', () => {
    const v = getVertices(1);
    assert.equal(v.length, 1);
    assert.equal(v[0].x, 0);
    assert.equal(v[0].y, 0);
    assert.equal(v[0].z, 0);
  });

  it('returns 2 vertices on X-axis for count=2', () => {
    const v = getVertices(2);
    assert.equal(v.length, 2);
    assert.ok(v[0].x < 0);
    assert.ok(v[1].x > 0);
    assert.equal(v[0].y, 0);
    assert.equal(v[1].y, 0);
  });

  it('returns 3 vertices in XZ plane for count=3 (triangle)', () => {
    const v = getVertices(3);
    assert.equal(v.length, 3);
    // All should have y ≈ 0 (equilateral in XZ plane)
    for (const p of v) {
      assert.ok(Math.abs(p.y) < 0.01, `y should be ~0, got ${p.y}`);
    }
  });

  it('returns 4 vertices for count=4 (tetrahedron)', () => {
    const v = getVertices(4);
    assert.equal(v.length, 4);
    // Tetrahedron has vertices at different Y levels
    const ys = v.map(p => p.y);
    assert.ok(Math.max(...ys) > 0);
    assert.ok(Math.min(...ys) < 0);
  });

  it('returns 5 vertices for count=5 (triangular bipyramid)', () => {
    const v = getVertices(5);
    assert.equal(v.length, 5);
  });

  it('returns 6 vertices for count=6 (octahedron)', () => {
    const v = getVertices(6);
    assert.equal(v.length, 6);
    // Octahedron has 2 poles and 4 equatorial
    const poles = v.filter(p => Math.abs(p.x) < 0.01 && Math.abs(p.z) < 0.01);
    assert.equal(poles.length, 2, 'Should have 2 polar vertices');
  });

  it('returns 8 vertices for count=8 (cube)', () => {
    const v = getVertices(8);
    assert.equal(v.length, 8);
  });

  it('uses Fibonacci sphere for count=7', () => {
    const v = getVertices(7);
    assert.equal(v.length, 7);
  });

  it('uses Fibonacci sphere for count=10', () => {
    const v = getVertices(10);
    assert.equal(v.length, 10);
  });

  it('scales radius with count', () => {
    const v3 = getVertices(3);
    const v8 = getVertices(8);
    const dist3 = Math.sqrt(v3[0].x ** 2 + v3[0].y ** 2 + v3[0].z ** 2);
    const dist8 = Math.sqrt(v8[0].x ** 2 + v8[0].y ** 2 + v8[0].z ** 2);
    assert.ok(dist8 > dist3, 'Radius should increase with count');
  });
});

describe('fibonacciSphere', () => {
  it('distributes N points on a sphere', () => {
    const pts = fibonacciSphere(20, 100);
    assert.equal(pts.length, 20);
    // All points should be approximately on the sphere surface
    for (const p of pts) {
      const dist = Math.sqrt(p.x ** 2 + p.y ** 2 + p.z ** 2);
      assert.ok(Math.abs(dist - 100) < 1, `Distance ${dist} should be ~100`);
    }
  });

  it('returns 1 point at north pole for n=1', () => {
    const pts = fibonacciSphere(1, 100);
    assert.equal(pts.length, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/svg-terminal && node --test test-polyhedra.mjs`

Expected: All tests fail (module not found)

- [ ] **Step 3: Write polyhedra.mjs**

```js
// polyhedra.mjs
// Pure math — vertex positions for geometric shapes.
// No Three.js dependency. All positions are {x, y, z} objects.

/**
 * Calculate radius based on terminal count.
 * Grows slightly to prevent overcrowding.
 */
function radius(count) {
  return 200 + count * 20;
}

/**
 * Distribute N points evenly on a sphere using Fibonacci spiral.
 */
export function fibonacciSphere(n, r) {
  if (n === 1) return [{ x: 0, y: r, z: 0 }];
  const points = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const radiusAtY = Math.sqrt(1 - y * y);
    const theta = goldenAngle * i;
    points.push({
      x: Math.cos(theta) * radiusAtY * r,
      y: y * r,
      z: Math.sin(theta) * radiusAtY * r
    });
  }
  return points;
}

// Normalized vertex positions for known polyhedra (unit radius)
const SHAPES = {
  1: () => [{ x: 0, y: 0, z: 0 }],

  2: () => [
    { x: -1, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 }
  ],

  3: () => {
    // Equilateral triangle in XZ plane
    const a = (2 * Math.PI) / 3;
    return [0, 1, 2].map(i => ({
      x: Math.cos(a * i),
      y: 0,
      z: Math.sin(a * i)
    }));
  },

  4: () => {
    // Regular tetrahedron
    const t = Math.sqrt(2) / 3;
    const h = 1 / 3;
    return [
      { x: 0, y: 1, z: 0 },
      { x: Math.sqrt(8 / 9), y: -h, z: 0 },
      { x: -Math.sqrt(2 / 9), y: -h, z: Math.sqrt(2 / 3) },
      { x: -Math.sqrt(2 / 9), y: -h, z: -Math.sqrt(2 / 3) }
    ];
  },

  5: () => {
    // Triangular bipyramid: 3 equatorial + 2 polar
    const a = (2 * Math.PI) / 3;
    const equatorial = [0, 1, 2].map(i => ({
      x: Math.cos(a * i),
      y: 0,
      z: Math.sin(a * i)
    }));
    return [
      { x: 0, y: 1, z: 0 },
      ...equatorial,
      { x: 0, y: -1, z: 0 }
    ];
  },

  6: () => {
    // Regular octahedron
    return [
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 }
    ];
  },

  8: () => {
    // Cube
    const s = 1 / Math.sqrt(3);
    const signs = [-1, 1];
    const verts = [];
    for (const x of signs)
      for (const y of signs)
        for (const z of signs)
          verts.push({ x: x * s, y: y * s, z: z * s });
    return verts;
  }
};

/**
 * Get vertex positions for a given terminal count.
 * Returns array of {x, y, z} in world coordinates (scaled by radius).
 */
export function getVertices(count) {
  const r = radius(count);

  if (count === 1) return SHAPES[1]();

  const shapeFn = SHAPES[count];
  if (shapeFn) {
    return shapeFn().map(v => ({ x: v.x * r, y: v.y * r, z: v.z * r }));
  }

  // Fallback: Fibonacci sphere for any count
  return fibonacciSphere(count, r);
}

/**
 * Easing function: easeInOutCubic
 */
export function easeInOutCubic(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Lerp between two {x,y,z} positions.
 */
export function lerpPos(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t
  };
}

/**
 * Match existing positions to new target positions using greedy nearest-neighbor.
 * Returns an array of indices: result[i] = index into newPositions for existing terminal i.
 * Extra new positions (for added terminals) are returned as unmatched.
 */
export function matchPositions(currentPositions, newPositions) {
  const used = new Set();
  const mapping = [];

  for (let i = 0; i < currentPositions.length; i++) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let j = 0; j < newPositions.length; j++) {
      if (used.has(j)) continue;
      const dx = currentPositions[i].x - newPositions[j].x;
      const dy = currentPositions[i].y - newPositions[j].y;
      const dz = currentPositions[i].z - newPositions[j].z;
      const dist = dx * dx + dy * dy + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = j;
      }
    }
    mapping.push(bestIdx);
    if (bestIdx >= 0) used.add(bestIdx);
  }

  const unmatched = [];
  for (let j = 0; j < newPositions.length; j++) {
    if (!used.has(j)) unmatched.push(j);
  }

  return { mapping, unmatched };
}
```

- [ ] **Step 4: Run tests**

Run: `cd /srv/svg-terminal && node --test test-polyhedra.mjs`

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add polyhedra.mjs test-polyhedra.mjs
git commit -m "feat: add polyhedra vertex calculator with morphing helpers"
```

---

## Task 2: Dashboard CSS

**Files:**
- Create: `/srv/svg-terminal/dashboard.css`

- [ ] **Step 1: Write the full CSS file**

```css
/* dashboard.css — 3D Terminal Dashboard styles */

/* === Background === */
html, body {
  margin: 0;
  padding: 0;
  overflow: hidden;
  width: 100%;
  height: 100%;
  background: linear-gradient(180deg, #f8f8fa 0%, #e8e6e2 100%);
  font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
}

/* === Terminal Panel === */
.terminal-3d {
  width: 320px;
  height: 248px;
  background: #1c1c1e;
  border-radius: 12px;
  overflow: hidden;
  position: relative;
  cursor: pointer;
  transition: box-shadow 0.2s, transform 0.2s;
}

.terminal-3d:hover {
  box-shadow: 0 0 20px rgba(92, 92, 255, 0.3);
  transform: scale(1.05);
}

.terminal-3d.focused {
  box-shadow: 0 0 30px rgba(92, 92, 255, 0.4);
}

.terminal-3d.faded {
  opacity: 0.3;
  pointer-events: none;
  transition: opacity 0.5s;
}

/* === Window Chrome === */
.terminal-3d header {
  height: 28px;
  background: #2a2a2c;
  display: flex;
  align-items: center;
  padding: 0 10px;
  gap: 8px;
  user-select: none;
}

.terminal-3d .dots {
  display: flex;
  gap: 5px;
}

.terminal-3d .dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.terminal-3d .dot.red { background: #ff5f57; }
.terminal-3d .dot.yellow { background: #febc2e; }
.terminal-3d .dot.green { background: #28c840; }

.terminal-3d .session-name {
  color: #808080;
  font-size: 11px;
  font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* === SVG Object inside panel === */
.terminal-3d object {
  width: 100%;
  height: 220px;
  display: block;
  pointer-events: none;
  border-bottom-left-radius: 12px;
  border-bottom-right-radius: 12px;
}

/* === Specular Highlight Overlay === */
.specular-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(255,255,255,0.08) 0%, transparent 60%);
}

/* === Shadow Blob === */
.terminal-shadow {
  width: 280px;
  height: 40px;
  background: radial-gradient(ellipse, rgba(0,0,0,0.25) 0%, transparent 70%);
  position: absolute;
  pointer-events: none;
}

/* === Thumbnail Sidebar === */
.thumbnail-sidebar {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 140px;
  background: rgba(0, 0, 0, 0.03);
  border-left: 1px solid rgba(0, 0, 0, 0.06);
  overflow-y: auto;
  overflow-x: hidden;
  z-index: 100;
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.thumbnail-sidebar::-webkit-scrollbar {
  width: 4px;
}

.thumbnail-sidebar::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.1);
  border-radius: 2px;
}

.thumbnail-item {
  cursor: pointer;
  border-radius: 6px;
  overflow: hidden;
  border: 2px solid transparent;
  transition: border-color 0.2s;
  background: #1c1c1e;
  flex-shrink: 0;
}

.thumbnail-item:hover {
  border-color: rgba(92, 92, 255, 0.3);
}

.thumbnail-item.active {
  border-color: #5c5cff;
}

.thumbnail-item .thumb-label {
  font-size: 9px;
  color: #808080;
  padding: 3px 6px;
  background: #2a2a2c;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
}

.thumbnail-item object {
  width: 100%;
  height: 70px;
  display: block;
  pointer-events: none;
}

/* === Input Bar (from Phase 4) === */
.input-bar {
  position: fixed;
  bottom: -50px;
  left: 0;
  right: 140px;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(10px);
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  z-index: 100;
  transition: bottom 0.3s ease;
}

.input-bar.visible {
  bottom: 0;
}

.input-bar .target {
  color: #5c5cff;
  font-size: 12px;
  white-space: nowrap;
  font-family: 'FiraCode Nerd Font Mono', monospace;
}

.input-bar input {
  flex: 1;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  color: #e0e0e0;
  font-family: 'FiraCode Nerd Font Mono', monospace;
  font-size: 14px;
  padding: 6px 10px;
  outline: none;
}

.input-bar input:focus {
  border-color: #5c5cff;
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard.css
git commit -m "feat: add dashboard CSS for 3D terminal panels, shadows, sidebar, input bar"
```

---

## Task 3: index.html Shell

**Files:**
- Rewrite: `/srv/svg-terminal/index.html`

- [ ] **Step 1: Write the new index.html**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>svg-terminal</title>
  <link rel="stylesheet" href="/dashboard.css">
</head>
<body>
  <!-- Thumbnail sidebar -->
  <div class="thumbnail-sidebar" id="sidebar"></div>

  <!-- Input bar (hidden until terminal focused) -->
  <div class="input-bar" id="input-bar">
    <span class="target" id="input-target"></span>
    <input type="text" id="input-box" placeholder="Type here...">
  </div>

  <script type="module" src="/dashboard.mjs"></script>
</body>
</html>
```

- [ ] **Step 2: Add routes for dashboard.css and dashboard.mjs in server.mjs**

Read `server.mjs` and add static file routes for the new files. Add inside the `GET` block, after the existing routes:

```js
if (pathname === '/dashboard.css') {
  try {
    const content = readFileSync(staticPath('dashboard.css'));
    setCors(res);
    res.setHeader('Content-Type', 'text/css');
    res.writeHead(200);
    res.end(content);
  } catch (err) {
    sendError(res, 500, 'Failed to read dashboard.css');
  }
  return;
}
if (pathname === '/dashboard.mjs') {
  try {
    const content = readFileSync(staticPath('dashboard.mjs'));
    setCors(res);
    res.setHeader('Content-Type', 'application/javascript');
    res.writeHead(200);
    res.end(content);
  } catch (err) {
    sendError(res, 500, 'Failed to read dashboard.mjs');
  }
  return;
}
if (pathname === '/polyhedra.mjs') {
  try {
    const content = readFileSync(staticPath('polyhedra.mjs'));
    setCors(res);
    res.setHeader('Content-Type', 'application/javascript');
    res.writeHead(200);
    res.end(content);
  } catch (err) {
    sendError(res, 500, 'Failed to read polyhedra.mjs');
  }
  return;
}
```

- [ ] **Step 3: Create a minimal dashboard.mjs placeholder so the page loads**

```js
// dashboard.mjs — placeholder, will be built in Tasks 4-9
console.log('dashboard.mjs loaded');
```

- [ ] **Step 4: Start the server, verify the new index.html loads**

Run: `curl -s http://localhost:3200/ | head -5`

Expected: HTML with `<link rel="stylesheet" href="/dashboard.css">`

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3200/dashboard.css`

Expected: `200`

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3200/dashboard.mjs`

Expected: `200`

- [ ] **Step 5: Commit**

```bash
git add index.html server.mjs dashboard.mjs
git commit -m "feat: new index.html shell with CSS/JS module loading"
```

---

## Task 4: Scene Setup and Basic Rendering

**Files:**
- Rewrite: `/srv/svg-terminal/dashboard.mjs`

- [ ] **Step 1: Write dashboard.mjs with scene setup, session discovery, and terminal creation**

This is the core module. It:
1. Imports Three.js from CDN and polyhedra.mjs
2. Sets up Scene, Camera, CSS3DRenderer
3. Fetches `/api/sessions` to discover terminals
4. Creates a CSS3DObject per terminal with the DOM structure from the spec
5. Positions terminals at polyhedra vertices
6. Starts the animation loop with rotation

```js
// dashboard.mjs
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';
import { CSS3DRenderer, CSS3DObject } from 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/renderers/CSS3DRenderer.js';
import { getVertices, lerpPos, easeInOutCubic, matchPositions } from './polyhedra.mjs';

// === Constants ===
const LIGHT_DIR = new THREE.Vector3(-0.7, 0.7, -0.3).normalize();
const FLOOR_Y = -200;
const ROTATION_SPEED = 0.2; // radians per second (~12°/s)
const MORPH_DURATION = 2.0; // seconds
const BILLBOARD_SLERP = 0.03;
const IDLE_TIMEOUT = 3000; // ms before rotation resumes after mouse stops

// === State ===
let scene, camera, renderer;
let polyhedronGroup, shadowGroup;
const terminals = new Map(); // sessionName → { css3dObject, shadowDiv, dom, currentPos, targetPos, morphStart, morphFrom }
let focusedSession = null;
let isMouseActive = false;
let lastMouseMove = 0;
let rotationPaused = false;
let rotationResumeProgress = 0;
const clock = new THREE.Clock();

// Camera home position
const HOME_POS = new THREE.Vector3(0, 200, 800);
const HOME_TARGET = new THREE.Vector3(0, 0, 0);
let cameraTarget = HOME_POS.clone();
let cameraLookTarget = HOME_TARGET.clone();
let cameraTweenStart = null;
let cameraTweenFrom = null;
let cameraTweenLookFrom = null;

// === Init ===
function init() {
  // Scene
  scene = new THREE.Scene();

  // Camera
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 10000);
  camera.position.copy(HOME_POS);
  camera.lookAt(HOME_TARGET);

  // Renderer
  renderer = new CSS3DRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.style.position = 'fixed';
  renderer.domElement.style.top = '0';
  renderer.domElement.style.left = '0';
  renderer.domElement.style.zIndex = '1';
  document.body.appendChild(renderer.domElement);

  // Groups
  polyhedronGroup = new THREE.Group();
  scene.add(polyhedronGroup);
  shadowGroup = new THREE.Group();
  scene.add(shadowGroup);

  // Event listeners
  window.addEventListener('resize', onResize);
  renderer.domElement.addEventListener('mousemove', onMouseMove);
  renderer.domElement.addEventListener('mouseleave', onMouseLeave);
  document.addEventListener('keydown', onKeyDown);

  // Start
  refreshSessions();
  setInterval(refreshSessions, 5000);
  animate();
}

// === Resize ===
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// === Mouse ===
function onMouseMove(e) {
  isMouseActive = true;
  lastMouseMove = performance.now();
  if (!focusedSession) {
    // Parallax: tilt camera slightly toward cursor
    const nx = (e.clientX / window.innerWidth - 0.5) * 2;
    const ny = (e.clientY / window.innerHeight - 0.5) * 2;
    camera.rotation.y = -nx * 0.08; // ±5°
    camera.rotation.x = ny * 0.08;
  }
}

function onMouseLeave() {
  isMouseActive = false;
}

function onKeyDown(e) {
  if (e.key === 'Escape' && focusedSession) {
    unfocusTerminal();
  }
}

// === Terminal DOM Creation ===
function createTerminalDOM(sessionName) {
  const el = document.createElement('div');
  el.className = 'terminal-3d';
  el.dataset.session = sessionName;

  // Specular overlay
  const specular = document.createElement('div');
  specular.className = 'specular-overlay';
  el.appendChild(specular);

  // Header with dots
  const header = document.createElement('header');
  const dots = document.createElement('span');
  dots.className = 'dots';
  for (const color of ['red', 'yellow', 'green']) {
    const dot = document.createElement('span');
    dot.className = `dot ${color}`;
    dots.appendChild(dot);
  }
  header.appendChild(dots);
  const name = document.createElement('span');
  name.className = 'session-name';
  name.textContent = sessionName;
  header.appendChild(name);
  el.appendChild(header);

  // SVG terminal object
  const obj = document.createElement('object');
  obj.type = 'image/svg+xml';
  obj.data = `/terminal.svg?session=${encodeURIComponent(sessionName)}`;
  el.appendChild(obj);

  // Click handler
  el.addEventListener('click', () => focusTerminal(sessionName));

  return el;
}

// === Shadow DOM Creation ===
function createShadowDOM() {
  const el = document.createElement('div');
  el.className = 'terminal-shadow';
  return el;
}

// === Thumbnail Creation ===
function createThumbnail(sessionName) {
  const item = document.createElement('div');
  item.className = 'thumbnail-item';
  item.dataset.session = sessionName;

  const label = document.createElement('div');
  label.className = 'thumb-label';
  label.textContent = sessionName;
  item.appendChild(label);

  const obj = document.createElement('object');
  obj.type = 'image/svg+xml';
  obj.data = `/terminal.svg?session=${encodeURIComponent(sessionName)}`;
  item.appendChild(obj);

  item.addEventListener('click', () => focusTerminal(sessionName));

  document.getElementById('sidebar').appendChild(item);
  return item;
}

// === Session Discovery ===
async function refreshSessions() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) return;
    const sessions = await res.json();
    const currentNames = new Set(sessions.map(s => s.name));
    const existingNames = new Set(terminals.keys());

    // Add new sessions
    for (const session of sessions) {
      if (!existingNames.has(session.name)) {
        addTerminal(session.name);
      }
    }

    // Remove dead sessions
    for (const name of existingNames) {
      if (!currentNames.has(name)) {
        removeTerminal(name);
      }
    }
  } catch (e) {
    // Server unreachable — leave as-is
  }
}

// === Add/Remove Terminals ===
function addTerminal(sessionName) {
  const dom = createTerminalDOM(sessionName);
  const shadowDiv = createShadowDOM();
  const thumbnail = createThumbnail(sessionName);

  const css3dObj = new CSS3DObject(dom);
  polyhedronGroup.add(css3dObj);

  const shadowObj = new CSS3DObject(shadowDiv);
  shadowObj.rotation.x = -Math.PI / 2; // Lay flat on floor
  shadowGroup.add(shadowObj);

  terminals.set(sessionName, {
    css3dObject: css3dObj,
    shadowObject: shadowObj,
    shadowDiv,
    dom,
    thumbnail,
    currentPos: { x: 0, y: 0, z: 0 },
    targetPos: { x: 0, y: 0, z: 0 },
    morphStart: clock.getElapsedTime(),
    morphFrom: { x: 0, y: 0, z: 0 }
  });

  recalculatePositions();
}

function removeTerminal(sessionName) {
  const t = terminals.get(sessionName);
  if (!t) return;
  polyhedronGroup.remove(t.css3dObject);
  shadowGroup.remove(t.shadowObject);
  t.thumbnail.remove();
  terminals.delete(sessionName);
  if (focusedSession === sessionName) unfocusTerminal();
  recalculatePositions();
}

function recalculatePositions() {
  const names = [...terminals.keys()];
  const count = names.length;
  if (count === 0) return;

  const newVerts = getVertices(count);
  const currentPositions = names.map(n => terminals.get(n).currentPos);
  const { mapping, unmatched } = matchPositions(currentPositions, newVerts);

  const now = clock.getElapsedTime();

  for (let i = 0; i < names.length; i++) {
    const t = terminals.get(names[i]);
    const targetIdx = mapping[i];
    if (targetIdx >= 0) {
      t.morphFrom = { ...t.currentPos };
      t.targetPos = newVerts[targetIdx];
      t.morphStart = now;
    }
  }
}

// === Focus / Unfocus ===
function focusTerminal(sessionName) {
  const t = terminals.get(sessionName);
  if (!t) return;

  focusedSession = sessionName;

  // Fade others
  for (const [name, term] of terminals) {
    if (name !== sessionName) {
      term.dom.classList.add('faded');
    } else {
      term.dom.classList.remove('faded');
      term.dom.classList.add('focused');
    }
    // Update thumbnails
    term.thumbnail.classList.toggle('active', name === sessionName);
  }

  // Animate camera to in front of this terminal
  const worldPos = new THREE.Vector3();
  t.css3dObject.getWorldPosition(worldPos);
  const dir = worldPos.clone().normalize();
  cameraTweenFrom = camera.position.clone();
  cameraTweenLookFrom = HOME_TARGET.clone();
  cameraTarget = worldPos.clone().add(dir.multiplyScalar(400));
  cameraLookTarget = worldPos.clone();
  cameraTweenStart = clock.getElapsedTime();

  // Show input bar
  const inputBar = document.getElementById('input-bar');
  const inputTarget = document.getElementById('input-target');
  inputBar.classList.add('visible');
  inputTarget.textContent = sessionName;

  rotationPaused = true;
}

function unfocusTerminal() {
  focusedSession = null;

  for (const [name, term] of terminals) {
    term.dom.classList.remove('faded', 'focused');
    term.thumbnail.classList.remove('active');
  }

  // Animate camera back
  cameraTweenFrom = camera.position.clone();
  cameraTweenLookFrom = cameraLookTarget.clone();
  cameraTarget = HOME_POS.clone();
  cameraLookTarget = HOME_TARGET.clone();
  cameraTweenStart = clock.getElapsedTime();

  // Hide input bar
  document.getElementById('input-bar').classList.remove('visible');

  rotationPaused = false;
  rotationResumeProgress = 0;
}

// === Animation Loop ===
function animate() {
  requestAnimationFrame(animate);

  const time = clock.getElapsedTime();
  const delta = clock.getDelta();

  // Check mouse idle
  if (isMouseActive && performance.now() - lastMouseMove > IDLE_TIMEOUT) {
    isMouseActive = false;
  }

  // Rotation
  if (!focusedSession && !isMouseActive) {
    if (rotationResumeProgress < 1) {
      rotationResumeProgress = Math.min(1, rotationResumeProgress + delta);
    }
    const rotSpeed = ROTATION_SPEED * easeInOutCubic(rotationResumeProgress);
    polyhedronGroup.rotation.y += delta * rotSpeed;
    polyhedronGroup.rotation.x = Math.sin(time * 0.1) * 0.05;
  }

  // Camera tween
  if (cameraTweenStart !== null) {
    const elapsed = time - cameraTweenStart;
    const t = Math.min(1, elapsed / 1.0);
    const eased = easeInOutCubic(t);

    camera.position.lerpVectors(cameraTweenFrom, cameraTarget, eased);
    const lookAt = new THREE.Vector3().lerpVectors(cameraTweenLookFrom, cameraLookTarget, eased);
    camera.lookAt(lookAt);

    if (t >= 1) cameraTweenStart = null;
  }

  // Per-terminal updates
  for (const [name, t] of terminals) {
    // Morph position
    const morphElapsed = time - t.morphStart;
    const morphT = Math.min(1, morphElapsed / MORPH_DURATION);
    const easedT = easeInOutCubic(morphT);
    t.currentPos = lerpPos(t.morphFrom, t.targetPos, easedT);

    t.css3dObject.position.set(t.currentPos.x, t.currentPos.y, t.currentPos.z);

    // Billboarding with lazy drift
    if (focusedSession === name) {
      // Focused: face camera exactly
      t.css3dObject.lookAt(camera.position);
    } else {
      const lookAtMat = new THREE.Matrix4().lookAt(
        t.css3dObject.getWorldPosition(new THREE.Vector3()),
        camera.position,
        new THREE.Vector3(0, 1, 0)
      );
      const targetQuat = new THREE.Quaternion().setFromRotationMatrix(lookAtMat);

      // Add drift
      const idx = [...terminals.keys()].indexOf(name);
      const drift = new THREE.Euler(
        Math.sin(time * 0.3 + idx * 1.5) * 0.08,
        Math.cos(time * 0.2 + idx * 1.7) * 0.12,
        0
      );
      targetQuat.multiply(new THREE.Quaternion().setFromEuler(drift));

      t.css3dObject.quaternion.slerp(targetQuat, BILLBOARD_SLERP);
    }

    // Shadow update
    const heightAboveFloor = t.currentPos.y - FLOOR_Y;
    const shadowScale = 1 + heightAboveFloor * 0.003;
    const shadowBlur = 15 + heightAboveFloor * 0.1;
    const shadowOpacity = Math.max(0.05, 0.3 - heightAboveFloor * 0.001);

    // Shadow position: project terminal XZ + light offset
    const lightOffset = LIGHT_DIR.clone().multiplyScalar(heightAboveFloor * 0.3);
    t.shadowObject.position.set(
      t.currentPos.x + lightOffset.x,
      FLOOR_Y,
      t.currentPos.z + lightOffset.z
    );
    t.shadowDiv.style.filter = `blur(${shadowBlur.toFixed(0)}px)`;
    t.shadowDiv.style.opacity = shadowOpacity.toFixed(3);
    t.shadowObject.scale.setScalar(shadowScale);

    // Specular overlay update
    const specular = t.dom.querySelector('.specular-overlay');
    if (specular) {
      // Calculate how much this panel faces the light
      const panelNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(t.css3dObject.quaternion);
      const dot = panelNormal.dot(LIGHT_DIR);
      const intensity = Math.max(0, dot) * 0.12;
      specular.style.background = `linear-gradient(135deg, rgba(255,255,255,${intensity.toFixed(3)}) 0%, transparent 60%)`;
    }
  }

  renderer.render(scene, camera);
}

// === Input Bar ===
const inputBox = document.getElementById('input-box');
if (inputBox) {
  inputBox.addEventListener('keydown', async (e) => {
    if (!focusedSession) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      const text = inputBox.value;
      if (text) {
        await sendKeys(focusedSession, text);
        inputBox.value = '';
      }
      await sendSpecialKey(focusedSession, 'Enter');
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      await sendSpecialKey(focusedSession, 'BSpace');
    } else if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      await sendSpecialKey(focusedSession, 'C-c');
    } else if (e.ctrlKey && e.key === 'd') {
      e.preventDefault();
      await sendSpecialKey(focusedSession, 'C-d');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      await sendSpecialKey(focusedSession, 'Up');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      await sendSpecialKey(focusedSession, 'Down');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      unfocusTerminal();
    }
  });
}

async function sendKeys(session, keys) {
  try {
    await fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, pane: '0', keys })
    });
  } catch (e) { /* silently fail */ }
}

async function sendSpecialKey(session, key) {
  try {
    await fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, pane: '0', specialKey: key })
    });
  } catch (e) { /* silently fail */ }
}

// === Start ===
init();
```

- [ ] **Step 2: Restart server, open in browser**

Kill and restart the server, then open `http://<server-ip>:3200/` in Chrome.

Expected: See terminal panels floating at polyhedra vertices, slowly rotating. The whole scene should be functional — session discovery, rotation, billboarding, shadows, specular, click-to-focus, thumbnails.

- [ ] **Step 3: Fix any issues found during visual testing**

This is a complex module — expect to iterate. Common issues:
- CSS3DRenderer import path might need adjustment
- Camera position might need tuning
- Terminal panel size vs 3D scale might need adjustment
- Shadow projection math might need tweaking

Fix and test iteratively.

- [ ] **Step 4: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: add 3D terminal dashboard with Three.js CSS3DRenderer"
```

---

## Task 5: Visual Tuning and Polish

**Files:**
- Modify: `/srv/svg-terminal/dashboard.mjs`
- Modify: `/srv/svg-terminal/dashboard.css`

- [ ] **Step 1: Test with the font-test tmux session**

Open `http://<server-ip>:3200/` in Chrome. Verify:
1. All tmux sessions appear as terminal panels
2. Shape matches session count (e.g., 6 sessions → octahedron)
3. Terminals billboard toward camera with slight drift
4. Shadows appear below each terminal
5. Specular highlights visible on light-facing panels
6. Clicking a terminal zooms the camera to it
7. Escape returns to overview
8. Thumbnail sidebar on the right shows all sessions
9. Rotation pauses on mouse movement, resumes after 3s idle

- [ ] **Step 2: Tune any visual parameters that look off**

Common adjustments:
- `HOME_POS` camera position (if scene is too far/close)
- `BILLBOARD_SLERP` (if billboarding is too snappy or too sluggish)
- Shadow blur/opacity/scale factors
- Terminal panel size in CSS (320×248 might be too large/small in 3D)
- Rotation speed

- [ ] **Step 3: Test morphing by creating/killing tmux sessions**

```bash
tmux new-session -d -s morph-test-1
# Wait 5s, verify shape changes in browser
tmux new-session -d -s morph-test-2
# Wait 5s, verify shape changes again
tmux kill-session -t morph-test-1
tmux kill-session -t morph-test-2
# Verify shape contracts
```

- [ ] **Step 4: Commit tuning changes**

```bash
git add dashboard.mjs dashboard.css
git commit -m "fix: tune visual parameters for 3D dashboard"
```

---

## Task 6: Final Testing and Push

- [ ] **Step 1: Run all unit tests**

```bash
cd /srv/svg-terminal
node --test test-polyhedra.mjs
node --test test-sgr-parser.mjs
node --test test-server.mjs
```

Expected: All tests pass.

- [ ] **Step 2: Full browser test checklist**

Open `http://<server-ip>:3200/` and verify:
- [ ] Scene renders with rotating polyhedron
- [ ] Terminals show live content from tmux
- [ ] Billboarding works (terminals face camera with lazy drift)
- [ ] Shadows below each terminal, offset by light direction
- [ ] Specular highlights on light-facing panels
- [ ] Click terminal → zoom in, others fade
- [ ] Escape → zoom back out
- [ ] Mouse parallax (camera tilts toward cursor)
- [ ] Mouse idle → rotation resumes
- [ ] Thumbnail sidebar clickable
- [ ] Input bar appears on focus, sends keystrokes
- [ ] New tmux session → shape morphs to accommodate
- [ ] Killed tmux session → shape contracts

- [ ] **Step 3: Commit and push**

```bash
git add -A
git commit -m "feat: complete 3D terminal dashboard with morphing polyhedra, lighting, and interaction"
git push origin dev
```
