// dashboard.mjs — 3D Terminal Dashboard
//
// ============================================================================
// IMPORTANT NOTES FOR FUTURE AGENTS — READ BEFORE MODIFYING
// ============================================================================
//
// 1. TEXT CRISPNESS: The entire purpose of this project is hyper-crisp terminal
//    text on 3D objects in Chrome. The Nx scale trick (4x CSS size, 0.25 3D scale)
//    is a deliberate workaround for Chrome's text rasterization under CSS3DRenderer.
//    DO NOT remove the oversized DOM elements or the 0.25 scale — text will blur.
//    See journal v0.2 and v0.3 for full explanation.
//
// 2. SVG IS THE TARGET FORMAT: Do NOT propose HTML overlays, crossfades, or
//    projection-math text layers as crispness solutions. The user explicitly
//    rejected this approach — SVG was chosen for cross-browser universality.
//    Edge and Chrome render differently; layering HTML on 3D creates fragile
//    browser-specific behavior.
//
// 3. EVENT ROUTING (ctrl+click): There are THREE click event paths that competed
//    and caused bugs where ctrl+click would add 2 terminals or replace focus:
//      a) onMouseUp (document) — handleCtrlClick for 3D scene
//      b) onSceneClick (renderer.domElement) — regular click handler
//      c) Thumbnail click handler (sidebar items) — direct sidebar clicks
//    The solution uses mouseDownOnSidebar flag, suppressNextClick flag, and
//    lastAddToFocusTime timestamp to prevent double-firing. DO NOT simplify
//    this to a single handler — it was tried and failed because mouseup fires
//    before click, bounding rects overlap in 3D, and sidebar/scene are
//    different DOM trees. See journal v0.4 for the full debugging story.
//
// 4. DO NOT add per-terminal click handlers (el.addEventListener('click', ...))
//    on the terminal DOM elements. This was the original cause of the double-fire
//    bug — the per-element handler called focusTerminal() directly, bypassing
//    all ctrl/multi-focus logic. All click routing goes through onSceneClick
//    and onMouseUp.
//
// 5. ORBIT SNAP BUG: syncOrbitFromCamera() MUST be called when orbit drag starts.
//    Without it, orbitAngle/orbitPitch/orbitDist contain stale values from a
//    previous camera position (e.g., HOME_POS), and starting an orbit from a
//    focused view snaps the camera to the wrong position. This was a hard bug.
//
// 6. FOCUS QUATERNION: focusQuatFrom captures the card's current rotation when
//    focus starts. Without it, the focused card snaps flat instantly instead of
//    slerping from its 3D angle to face-camera over the fly-in animation.
//    The snap was visually jarring — card would rotate to 0 on Z axis THEN fly in.
//
// 7. RANDOM INITIAL ROTATION: Cards spawn with random 3D angles (rotation.set
//    in addTerminal). This creates the 3D fly-in effect where cards rotate toward
//    camera as they arrive. Without it, cards start face-on and the fly-in looks flat.
//
// 8. BILLBOARD ARRIVAL: billboardArrival tracks when a card finishes morphing to
//    its ring position. During fly-in, billboard slerp ramps from near-zero to full.
//    After arrival, normal billboard behavior takes over. This separation prevents
//    cards from snapping face-on before they've finished moving.
//
// ============================================================================

import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { easeInOutCubic, lerpPos } from './polyhedra.mjs';

// === Ring Layout Preset (from design studio 2026-03-27 session) ===
const DEG2RAD = Math.PI / 180;
const RING = {
  outer: {
    radius: 500,
    mode: 0,
    faceCamera: true,
    spinSpeed: 0.008,
    spinDir: 1,
    ringTilt: { x: 73, y: -5, z: 0 },
    cardTilt: { x: -5, y: -5, z: -5 },
  },
  inner: {
    radius: 300,
    mode: 0,           // Upright
    faceCamera: false,
    spinSpeed: 0.012,
    spinDir: -1,       // Reverse
    ringTilt: { x: 21, y: 0, z: 19 },
    cardTilt: { x: 0, y: 0, z: 0 },
  }
};
// === Key Translation (browser KeyboardEvent → tmux send-keys) ===
const SPECIAL_KEY_MAP = {
  'Enter': 'Enter',
  'Tab': 'Tab',
  'Escape': 'Escape',
  'Backspace': 'BSpace',
  'Delete': 'DC',
  'ArrowUp': 'Up',
  'ArrowDown': 'Down',
  'ArrowLeft': 'Left',
  'ArrowRight': 'Right',
  'Home': 'Home',
  'End': 'End',
  'PageUp': 'PgUp',
  'PageDown': 'PgDn',
  'Insert': 'IC',
  'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
  'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
  'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
  ' ': 'Space',
};

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

// Calculate optimal cols/rows to fill the terminal's card at the current text size.
// Uses cell dimensions from the SVG to determine how many cols/rows fit the card.
function optimizeTerminalFit(t, sessionName) {
  const obj = t.dom.querySelector('object');
  if (!obj) return;
  const currentCols = t.screenCols || 80;
  const currentRows = t.screenRows || 24;
  // Card DOM is 4x. Object area = card minus header (56px).
  const cardW = parseInt(t.dom.style.width) || 1280;
  const cardH = (parseInt(t.dom.style.height) || 992) - 56;

  // Cell pixel size: the SVG is aspect-fit into the card.
  // Current content fills some portion of the card. Cell pixel size depends on which
  // axis constrains the fit.
  try {
    const svgDoc = obj.contentDocument;
    const measure = svgDoc && svgDoc.getElementById('measure');
    if (measure) {
      const bbox = measure.getBBox();
      if (bbox.width > 0) {
        const cellW = bbox.width / 10; // SVG units per cell
        const cellH = bbox.height;
        const contentW = currentCols * cellW; // total SVG width in SVG units
        const contentH = currentRows * cellH; // total SVG height in SVG units
        // SVG aspect-fits: find the scale factor from SVG units to card DOM pixels
        const scaleW = cardW / contentW;
        const scaleH = cardH / contentH;
        const fitScale = Math.min(scaleW, scaleH); // aspect-fit uses the smaller scale
        // Cell size in card DOM pixels at this fit
        const cellPxW = cellW * fitScale;
        const cellPxH = cellH * fitScale;
        // How many cells fill the card?
        const cols = Math.max(20, Math.round(cardW / cellPxW));
        const rows = Math.max(5, Math.round(cardH / cellPxH));
        t.sendInput({ type: 'resize', cols: cols, rows: rows });
        return;
      }
    }
  } catch (e) {}
  // Fallback if SVG not accessible: assume current layout fills the card
  t.sendInput({ type: 'resize', cols: currentCols, rows: currentRows });
}

// === Constants ===
const LIGHT_DIR = new THREE.Vector3(-0.7, 0.7, -0.3).normalize();
const FLOOR_Y = -300;
const MORPH_DURATION = 1.5;
const BILLBOARD_SLERP = 0.08;
const SIDEBAR_WIDTH = 140;
const FOCUS_DIST = 350;
const RENDER_SCALE = 2;

// Camera position — closer to match original visual density
const HOME_POS = new THREE.Vector3(-15, 20, 900);
const HOME_TARGET = new THREE.Vector3(-15, 0, 0);

// === State ===
let scene, camera, renderer;
let terminalGroup, shadowGroup;
const terminals = new Map();
let sessionOrder = [];
let focusedSessions = new Set();
let activeInputSession = null;
const clock = new THREE.Clock();

// Ring state
let outerAngle = 0, innerAngle = 0;
let ringAssignments = { outer: [], inner: [] };

// Mouse state
// IMPORTANT: The interaction between these flags is load-bearing. See note 3 above.
// dragMode 'ctrlPending' means ctrl+mousedown happened but we don't know if it's a
// click (multi-focus) or drag (rotate-origin) yet. Resolved by dragDistance threshold.
let isDragging = false;
let dragMode = null; // 'orbit' | 'dollyXY' | 'rotateOrigin' | 'ctrlPending' | 'moveCard'
let _moveCardSession = null; // session name being dragged by title bar
let dragStart = { x: 0, y: 0 };
let dragDistance = 0;        // total px moved during drag — used to distinguish click vs drag
let ctrlHeld = false;        // tracked via keydown/keyup because e.ctrlKey is unreliable in click events on Windows
let altHeld = false;         // tracked for text selection — prevents unfocus on Alt+click release
let suppressNextClick = false; // set in onMouseUp to prevent onSceneClick from double-handling
let lastAddToFocusTime = 0;   // timestamp — blocks focusTerminal() for 200ms after addToFocus() to prevent replacement
let mouseDownOnSidebar = false; // prevents handleCtrlClick from firing when clicking sidebar thumbnails
let orbitAngle = 0;
let orbitPitch = 0;
let orbitDist = HOME_POS.z;

// Camera tween
let cameraTween = null;
let currentLookTarget = HOME_TARGET.clone();

// Reusable Three.js objects
const _worldPos = new THREE.Vector3();
const _lookAtMat = new THREE.Matrix4();
const _targetQuat = new THREE.Quaternion();
const _driftQuat = new THREE.Quaternion();
const _driftEuler = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);
const _ringTiltEuler = new THREE.Euler();
const _cardTiltEuler = new THREE.Euler();
const _panelNormal = new THREE.Vector3();
// Hot-path drag vectors — reused every mouse move to avoid allocation
const _dragRight = new THREE.Vector3();
const _dragUp = new THREE.Vector3();
const _rotY = new THREE.Matrix4();
const _rotX = new THREE.Matrix4();

// === Ring Assignment ===
// Distributes terminals across outer and inner rings
function assignRings() {
  const names = sessionOrder;
  const count = names.length;
  if (count <= 3) {
    ringAssignments.outer = [...names];
    ringAssignments.inner = [];
  } else {
    const innerCount = Math.min(3, Math.floor(count / 4));
    ringAssignments.inner = names.slice(0, innerCount);
    ringAssignments.outer = names.slice(innerCount);
  }
}

function getRingInfo(name) {
  if (ringAssignments.inner.includes(name)) {
    return { config: RING.inner, names: ringAssignments.inner, angle: innerAngle };
  }
  return { config: RING.outer, names: ringAssignments.outer, angle: outerAngle };
}

// Compute world-space position for a terminal on a ring
function computeRingPos(index, total, config, angle) {
  const theta = -Math.PI / 2 + (2 * Math.PI * index) / total;
  const spunTheta = theta + angle;

  // Position on flat circle (XY plane, Y negated for Three.js Y-up convention)
  const x = Math.cos(spunTheta) * config.radius;
  const y = -Math.sin(spunTheta) * config.radius;

  // Apply ring tilt rotation to get world-space position
  const v = new THREE.Vector3(x, y, 0);
  _ringTiltEuler.set(
    config.ringTilt.x * DEG2RAD,
    config.ringTilt.y * DEG2RAD,
    config.ringTilt.z * DEG2RAD
  );
  v.applyEuler(_ringTiltEuler);

  return { x: v.x, y: v.y, z: v.z };
}

// === Multi-Focus Layout ===
// Frustum projection: layout in screen pixels, project into 3D.
// Camera looks straight at origin. No offsets. Everything is a card in one frustum.
// Each terminal gets a screen rectangle proportional to its cell count.
// The card sits at whatever Z depth makes its world size fill that screen rectangle.
const STATUS_BAR_H = 50;
const LAYOUT_GAP_PX = 8;

function calculateFocusedLayout() {
  const now = clock.getElapsedTime();
  const count = focusedSessions.size;
  if (count === 0) return;

  // Full viewport — sidebar and status bar are just overlays, not subtracted.
  // But we avoid placing cards under them.
  const screenW = window.innerWidth;
  const screenH = window.innerHeight;

  // Available region: left of sidebar, above status bar
  const availW = screenW - SIDEBAR_WIDTH;
  const availH = screenH - STATUS_BAR_H;

  // Build cards with cell counts
  const names = [...focusedSessions];
  const cards = names.map(name => {
    const t = terminals.get(name);
    const cols = t ? t.screenCols || 80 : 80;
    const rows = t ? t.screenRows || 24 : 24;
    const cells = cols * rows;
    const aspect = (cols * SVG_CELL_W) / (rows * SVG_CELL_H);
    const worldW = (t ? t.baseCardW || 1280 : 1280) * 0.25;
    const worldH = (t ? t.baseCardH || 992 : 992) * 0.25;
    return { name, cols, rows, cells, aspect, worldW, worldH };
  });

  const totalCells = cards.reduce((sum, c) => sum + c.cells, 0);
  cards.sort((a, b) => b.cells - a.cells);

  // Allocate screen rectangles proportional to cell count.
  // Start with proportional areas, then scale everything to fit.
  for (const card of cards) {
    const share = card.cells / totalCells;
    const area = share * availW * availH;
    card.screenW = Math.sqrt(area * card.aspect);
    card.screenH = area / card.screenW;
  }

  // Masonry pack into columns — try each column count, pick best
  let bestLayout = null;
  let bestScore = -Infinity;

  for (let numCols = 1; numCols <= Math.min(count, 4); numCols++) {
    const colH = new Array(numCols).fill(0);
    const colW = new Array(numCols).fill(0);
    const placements = [];

    for (const card of cards) {
      let minCol = 0;
      for (let c = 1; c < numCols; c++) if (colH[c] < colH[minCol]) minCol = c;
      placements.push({ name: card.name, col: minCol, y: colH[minCol], sw: card.screenW, sh: card.screenH, worldW: card.worldW, worldH: card.worldH });
      colH[minCol] += card.screenH + LAYOUT_GAP_PX;
      colW[minCol] = Math.max(colW[minCol], card.screenW);
    }

    const rawW = colW.reduce((a, b) => a + b, 0) + (numCols - 1) * LAYOUT_GAP_PX;
    const rawH = Math.max(...colH) - LAYOUT_GAP_PX;

    // Scale factor to fit into available area
    const scaleX = availW / rawW;
    const scaleY = availH / rawH;
    const scale = Math.min(scaleX, scaleY) * 0.95; // 5% margin

    const fitW = rawW * scale;
    const fitH = rawH * scale;
    const coverage = (fitW * fitH) / (availW * availH);

    if (coverage > bestScore) {
      bestScore = coverage;
      bestLayout = { placements, colW, rawW, rawH, scale, numCols };
    }
  }

  if (!bestLayout) return;
  const { placements, colW, rawW, rawH, scale, numCols } = bestLayout;

  // Compute screen positions — centered in the available area
  // Available area starts at (0, 0) and extends to (availW, availH)
  const fitW = rawW * scale;
  const fitH = rawH * scale;
  const originX = (availW - fitW) / 2;
  const originY = (availH - fitH) / 2;

  // Column X positions (scaled)
  const colX = [];
  let rx = 0;
  for (let c = 0; c < numCols; c++) {
    colX.push(rx + (colW[c] * scale) / 2);
    rx += colW[c] * scale + LAYOUT_GAP_PX * scale;
  }

  // Project each placement into 3D
  const vFov = camera.fov * DEG2RAD;
  const halfTan = Math.tan(vFov / 2);

  for (const p of placements) {
    const t = terminals.get(p.name);
    if (!t) continue;

    // Screen center of this card (in full viewport coordinates)
    p._cx = originX + colX[p.col];
    p._cy = originY + p.y * scale + (p.sh * scale) / 2;
    p._fracH = (p.sh * scale) / screenH;
    p._depth = p.worldH / (p._fracH * 2 * halfTan);
  }

  // Camera must be far enough back that all focused cards sit in front of the ring.
  // Ring orbits at Z≈0 with radius ~500. Cards should be at Z > 100.
  const maxDepth = Math.max(...placements.map(p => p._depth));
  const minCardZ = 150; // focused cards must be well in front of ring
  const camZ = Math.max(FOCUS_DIST, maxDepth + minCardZ);

  // Second pass: position each card using the final camera Z
  for (const p of placements) {
    const t = terminals.get(p.name);
    if (!t) continue;

    const cardZ = camZ - p._depth;
    const visHAtDepth = 2 * p._depth * halfTan;
    const px2w = visHAtDepth / screenH;
    const wx = (p._cx - screenW / 2) * px2w;
    const wy = -(p._cy - screenH / 2) * px2w;

    t.morphFrom = { ...t.currentPos };
    t.targetPos = { x: wx, y: wy, z: cardZ };
    t.morphStart = now;
    t.focusQuatFrom = t.css3dObject.quaternion.clone();
  }

  // Camera looks at the midpoint of focused cards
  const avgZ = placements.reduce((s, p) => s + (camZ - p._depth), 0) / placements.length;
  cameraTween = {
    from: camera.position.clone(),
    to: new THREE.Vector3(0, 0, camZ),
    lookFrom: currentLookTarget.clone(),
    lookTo: new THREE.Vector3(0, 0, avgZ),
    start: now,
    duration: 1.0
  };
}

// === Init ===
function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 10000);
  camera.position.copy(HOME_POS);
  camera.lookAt(HOME_TARGET);

  // Renderer at 2x size, scaled down — forces Chrome to rasterize at 2x resolution
  renderer = new CSS3DRenderer();
  renderer.setSize(window.innerWidth * RENDER_SCALE, window.innerHeight * RENDER_SCALE);
  renderer.domElement.style.position = 'fixed';
  renderer.domElement.style.top = '0';
  renderer.domElement.style.left = '0';
  renderer.domElement.style.zIndex = '1';
  renderer.domElement.style.transformOrigin = '0 0';
  renderer.domElement.style.transform = 'scale(' + (1 / RENDER_SCALE) + ')';
  document.body.appendChild(renderer.domElement);

  terminalGroup = new THREE.Group();
  scene.add(terminalGroup);
  shadowGroup = new THREE.Group();
  scene.add(shadowGroup);

  // Events
  window.addEventListener('resize', onResize);
  renderer.domElement.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  renderer.domElement.addEventListener('mouseleave', onMouseLeave);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  renderer.domElement.addEventListener('click', onSceneClick);
  document.addEventListener('keydown', onKeyDown);
  document.getElementById('help-btn').addEventListener('click', toggleHelp);
  document.getElementById('help-close').addEventListener('click', toggleHelp);

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

  refreshSessions();
  setInterval(refreshSessions, 5000);
  setInterval(refreshTitles, 10000);
  animate();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth * RENDER_SCALE, window.innerHeight * RENDER_SCALE);
}

// === Mouse ===
function onMouseMove(e) {
  if (isDragging && dragMode) {
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    dragDistance += Math.abs(dx) + Math.abs(dy);
    dragStart.x = e.clientX;
    dragStart.y = e.clientY;

    // Resolve ctrl pending to rotateOrigin once there's real movement
    if (dragMode === 'ctrlPending' && dragDistance > 5) {
      dragMode = 'rotateOrigin';
    }

    if (dragMode === 'moveCard') {
      // Drag card by title bar — move in screen-projected world space
      const t = _moveCardSession && terminals.get(_moveCardSession);
      if (t) {
        const vFov = camera.fov * DEG2RAD;
        // Get card's current Z depth relative to camera
        const worldPos = new THREE.Vector3();
        t.css3dObject.getWorldPosition(worldPos);
        const depthFromCamera = camera.position.z - worldPos.z;
        const visHAtDepth = 2 * depthFromCamera * Math.tan(vFov / 2);
        const px2w = visHAtDepth / window.innerHeight;
        // Move card position in world space
        t.currentPos.x += dx * px2w;
        t.currentPos.y -= dy * px2w;
        t.targetPos.x = t.currentPos.x;
        t.targetPos.y = t.currentPos.y;
        t.css3dObject.position.x = t.currentPos.x;
        t.css3dObject.position.y = t.currentPos.y;
      }
      return;
    }

    if (dragMode === 'orbit') {
      // Orbit camera around its look target at current distance
      orbitAngle -= dx * 0.005;
      orbitPitch = Math.max(-1.2, Math.min(1.2, orbitPitch - dy * 0.005));
      updateCameraOrbit();

    } else if (dragMode === 'dollyXY') {
      // Shift+drag: translate camera + target in screen-aligned X/Y
      // Uses module-level _dragRight, _dragUp to avoid allocation in hot path
      camera.getWorldDirection(_worldPos);
      _dragRight.crossVectors(_worldPos, _up).normalize();
      _dragUp.crossVectors(_dragRight, _worldPos).normalize();
      const scale = orbitDist * 0.002;
      const offset = _dragRight.multiplyScalar(-dx * scale).add(_dragUp.multiplyScalar(dy * scale));
      camera.position.add(offset);
      currentLookTarget.add(offset);
      HOME_TARGET.add(offset);
      camera.lookAt(currentLookTarget);

    } else if (dragMode === 'rotateOrigin') {
      // Ctrl+drag: rotate camera around center of mass of focused terminals (or world origin)
      const origin = new THREE.Vector3(0, 0, 0);
      if (focusedSessions.size > 0) {
        let count = 0;
        for (const fname of focusedSessions) {
          const ft = terminals.get(fname);
          if (ft) { origin.add(ft.css3dObject.position); count++; }
        }
        if (count > 0) origin.divideScalar(count);
      }
      const offset = camera.position.clone().sub(origin);
      _rotY.makeRotationY(-dx * 0.005);
      _rotX.makeRotationX(-dy * 0.005);
      offset.applyMatrix4(_rotY).applyMatrix4(_rotX);
      camera.position.copy(origin).add(offset);
      currentLookTarget.copy(origin);
      camera.lookAt(currentLookTarget);

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
      // Update .terminal-inner to match card dimensions
      const inner = t.dom.querySelector('.terminal-inner');
      if (inner) {
        inner.style.width = newW + 'px';
        inner.style.height = newH + 'px';
      }
      // Save as user's preferred size — survives focus/unfocus
      t.baseCardW = newW;
      t.baseCardH = newH;
    }
  }
}

function onMouseDown(e) {
  // Track whether mousedown started on sidebar — if so, the thumbnail's own click
  // handler manages ctrl+click. Without this flag, handleCtrlClick in onMouseUp
  // ALSO fires and finds a different terminal behind the sidebar via bounding rect
  // hit detection, causing two terminals to be added per ctrl+click.
  const sidebar = document.getElementById('sidebar');
  mouseDownOnSidebar = sidebar && sidebar.contains(e.target);
  const isFocused = focusedSessions.size > 0;

  if (e.button === 0) {
    // Check if mousedown is on a terminal header (title bar drag to move card)
    const headerEl = e.target.closest && e.target.closest('.terminal-3d header');
    if (headerEl && isFocused) {
      const card = headerEl.closest('.terminal-3d');
      const sessionName = card && card.dataset.session;
      if (sessionName && focusedSessions.has(sessionName)) {
        isDragging = true;
        dragMode = 'moveCard';
        dragDistance = 0;
        dragStart.x = e.clientX;
        dragStart.y = e.clientY;
        _moveCardSession = sessionName;
        e.preventDefault();
        return;
      }
    }

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
      // Save card dimensions and cols/rows at drag start for proportional resize
      if (activeInputSession) {
        const rt = terminals.get(activeInputSession);
        if (rt) {
          rt._resizeStartW = parseInt(rt.dom.style.width) || 1280;
          rt._resizeStartH = (parseInt(rt.dom.style.height) || 992) - 56;
          rt._resizeStartCols = rt.screenCols || 80;
          rt._resizeStartRows = rt.screenRows || 24;
        }
      }
      e.preventDefault();
    } else if (action === 'rotateOrigin') {
      // Don't commit to rotateOrigin yet — could be ctrl+click for multi-focus.
      // If dragDistance stays < 5px, onMouseUp treats it as ctrl+click.
      // If dragDistance exceeds 5px, onMouseMove promotes to 'rotateOrigin'.
      isDragging = true;
      dragMode = 'ctrlPending';
      dragDistance = 0;
      dragStart.x = e.clientX;
      dragStart.y = e.clientY;
      // IMPORTANT: No preventDefault here — it suppresses the click event entirely,
      // which broke ctrl+click handling when we relied on onSceneClick.
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

// Hidden contenteditable for right-click paste support.
// Browsers only show Cut/Copy/Paste in context menu on editable elements.
// When a terminal is focused, we position this invisible div under the cursor
// so the browser's native paste option works.
const _pasteTarget = document.createElement('div');
_pasteTarget.contentEditable = 'true';
_pasteTarget.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;z-index:200;pointer-events:none;';
document.body.appendChild(_pasteTarget);

document.addEventListener('contextmenu', function(e) {
  if (focusedSessions.size > 0) {
    // Position the invisible contenteditable under the cursor for paste menu
    _pasteTarget.style.left = e.clientX + 'px';
    _pasteTarget.style.top = e.clientY + 'px';
    _pasteTarget.style.pointerEvents = 'auto';
    _pasteTarget.focus();
    // Re-hide after menu closes
    setTimeout(function() { _pasteTarget.style.pointerEvents = 'none'; }, 100);
    return; // let context menu show
  }
  e.preventDefault();
});

function onMouseUp(e) {
  if (e.button === 0 && dragDistance <= 5) {
    if (dragMode === 'ctrlPending' || ctrlHeld) {
      // Ctrl+click on 3D scene — skip if click was on sidebar (thumbnail handles it)
      if (!mouseDownOnSidebar) {
        handleCtrlClick(e);
        suppressNextClick = true; // only suppress if we handled a 3D scene ctrl+click
      }
      isDragging = false;
      dragMode = null;
      return;
    }
  }
  // Title bar click (not drag) — switch input to that terminal
  if (dragMode === 'moveCard' && dragDistance <= 5 && _moveCardSession) {
    setActiveInput(_moveCardSession);
  }
  // After resize drag, calculate cols/rows proportionally.
  // Same text size: cell pixel size stays constant, so cols/rows scale with card size.
  if (dragMode === 'resize' && activeInputSession) {
    const t = terminals.get(activeInputSession);
    if (t) {
      const startW = t._resizeStartW || 1280;
      const startH = t._resizeStartH || 936;
      const startCols = t._resizeStartCols || 80;
      const startRows = t._resizeStartRows || 24;
      const cardW = parseInt(t.dom.style.width) || 1280;
      const cardH = (parseInt(t.dom.style.height) || 992) - 56;
      const newCols = Math.max(20, Math.round(startCols * cardW / startW));
      const newRows = Math.max(5, Math.round(startRows * cardH / startH));
      t.sendInput({ type: 'resize', cols: newCols, rows: newRows });
    }
  }
  isDragging = false;
  dragMode = null;
}

// Find the closest non-focused terminal under the click point and add it to focus.
// Skips already-focused terminals to prevent the overlapping bounding rect problem:
// in 3D, focused terminals (centered, large) overlap unfocused ones in screen space.
// Without the skip, ctrl+clicking near a focused terminal would re-add it (no-op) or
// pick up a second terminal behind it.
function handleCtrlClick(e) {
  let clicked = null;
  let closestZ = -Infinity;
  for (const [name, t] of terminals) {
    if (focusedSessions.has(name)) continue;
    const rect = t.dom.getBoundingClientRect();
    if (rect.width < 10) continue;
    if (e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom) {
      const worldPos = new THREE.Vector3();
      t.css3dObject.getWorldPosition(worldPos);
      worldPos.project(camera);
      if (worldPos.z > closestZ) {
        closestZ = worldPos.z;
        clicked = name;
      }
    }
  }
  if (clicked) {
    addToFocus(clicked);
  }
}

function wasDrag() {
  return dragDistance > 5 && dragMode !== 'ctrlPending';
}

function onMouseLeave() {
  isDragging = false;
  dragMode = null;
}

function toggleHelp() {
  const panel = document.getElementById('help-panel');
  panel.classList.toggle('visible');
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Control') ctrlHeld = true;
  if (e.key === 'Alt') altHeld = true;
});
document.addEventListener('keyup', function(e) {
  if (e.key === 'Control') ctrlHeld = false;
  if (e.key === 'Alt') altHeld = false;
});
window.addEventListener('blur', function() { ctrlHeld = false; altHeld = false; });

function onKeyDown(e) {
  if (e.key === 'Escape') {
    const panel = document.getElementById('help-panel');
    if (panel.classList.contains('visible')) {
      panel.classList.remove('visible');
    } else if (focusedSessions.size > 0) {
      unfocusTerminal();
    }
  }
  if (e.key === '?' && focusedSessions.size === 0) {
    toggleHelp();
  }
}

function onSceneClick(e) {
  // IMPORTANT: Ctrl+click is handled ENTIRELY in onMouseUp → handleCtrlClick.
  // DO NOT add ctrl+click handling here — it causes double-fire because both
  // onMouseUp and onSceneClick find different terminals via overlapping bounding
  // rects in the 3D scene. This was the root cause of the "ctrl+click adds 2
  // terminals" bug. See note 3 in header.
  if (suppressNextClick || ctrlHeld || e.ctrlKey || altHeld || e.altKey) {
    suppressNextClick = false;
    return;
  }
  if (wasDrag()) return;
  if (e.button !== 0) return;
  if (e.shiftKey) return; // shift+click reserved for drag

  let clicked = null;
  let closestZ = -Infinity;

  // When terminals are focused, only check focused terminals for click (setActiveInput).
  // Don't check unfocused terminals behind them — their overlapping bounding rects
  // cause the focused terminal to be replaced by a background one.
  const checkSet = focusedSessions.size > 0 ? focusedSessions : null;

  for (const [name, t] of terminals) {
    if (checkSet && !checkSet.has(name)) continue; // skip unfocused when in focus mode
    const rect = t.dom.getBoundingClientRect();
    if (rect.width < 10) continue;
    if (e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom) {
      const worldPos = new THREE.Vector3();
      t.css3dObject.getWorldPosition(worldPos);
      worldPos.project(camera);
      if (worldPos.z > closestZ) {
        closestZ = worldPos.z;
        clicked = name;
      }
    }
  }

  if (clicked) {
    if (focusedSessions.has(clicked)) {
      // Click on an already-focused terminal: switch input to it
      setActiveInput(clicked);
    } else {
      // Regular click: focus single terminal (replaces all)
      focusTerminal(clicked);
    }
  }
  // NOTE: Clicking empty space does NOT unfocus. Use Esc to unfocus.
  // Previously this called unfocusTerminal() on empty-space clicks, which caused
  // accidental unfocus when clicking near a focused terminal, after Alt+drag
  // selection, or when trying to click into a terminal for keyboard focus.
  // Esc is the explicit, intentional unfocus action.
}

function onWheel(e) {
  e.preventDefault();
  const delta = e.deltaY;
  const isFocused = focusedSessions.size > 0;
  const action = getScrollAction(e, isFocused);

  if (action === 'scrollContent' && activeInputSession) {
    const t = terminals.get(activeInputSession);
    if (t) {
      // Scroll: server-side scrollback with client-side smooth animation.
      // Acceleration-aware scroll — fast flick = bigger jumps
      const absDelta = Math.abs(delta);
      const step = absDelta > 300 ? 12 : absDelta > 150 ? 6 : absDelta > 50 ? 3 : 1;
      t.scrollBy(delta < 0 ? step : -step);
    }
    return;
  }

  if (action === 'fontZoom' && activeInputSession) {
    const t = terminals.get(activeInputSession);
    if (t) {
      // Scroll up = fewer cols/rows (text appears bigger)
      // Scroll down = more cols/rows (text appears smaller)
      const step = delta > 0 ? 2 : -2;
      const newCols = Math.max(20, Math.min(300, (t.screenCols || 80) + step));
      const newRows = Math.max(5, Math.min(100, (t.screenRows || 24) + Math.round(step / 2)));
      t.sendInput({ type: 'resize', cols: newCols, rows: newRows });
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

// Derive orbitAngle/orbitPitch/orbitDist from camera's actual position relative to look target.
// CRITICAL: Must be called when orbit drag starts. Without this, starting an orbit from a
// focused camera position (z=350) uses stale orbitDist from overview (z=900) and the camera
// snaps violently. See note 5 in header. This was a hard-to-diagnose bug.
function syncOrbitFromCamera() {
  const offset = camera.position.clone().sub(currentLookTarget);
  orbitDist = offset.length();
  orbitAngle = Math.atan2(offset.x, offset.z);
  orbitPitch = Math.asin(Math.max(-1, Math.min(1, offset.y / orbitDist)));
}

function updateCameraOrbit() {
  camera.position.x = currentLookTarget.x + Math.sin(orbitAngle) * orbitDist;
  camera.position.y = currentLookTarget.y + Math.sin(orbitPitch) * orbitDist;
  camera.position.z = currentLookTarget.z + Math.cos(orbitAngle) * Math.cos(orbitPitch) * orbitDist;
  camera.lookAt(currentLookTarget);
}

// === Terminal DOM ===
function createTerminalDOM(sessionName) {
  const el = document.createElement('div');
  el.className = 'terminal-3d';
  el.dataset.session = sessionName;

  // Inner wrapper — content is always at 4x layout, wrapper scales to fit outer
  const inner = document.createElement('div');
  inner.className = 'terminal-inner';

  const specular = document.createElement('div');
  specular.className = 'specular-overlay';
  inner.appendChild(specular);

  const header = document.createElement('header');
  const dots = document.createElement('span');
  dots.className = 'dots';
  for (const color of ['red', 'yellow', 'green']) {
    const dot = document.createElement('span');
    dot.className = 'dot ' + color;
    dots.appendChild(dot);
  }
  header.appendChild(dots);
  const name = document.createElement('span');
  name.className = 'session-name';
  name.textContent = sessionName;
  header.appendChild(name);

  // Controls are NOT inside the CSS3DObject DOM — getBoundingClientRect() returns
  // NaN for elements inside CSS3DRenderer's matrix3d transforms, making buttons
  // unclickable. Instead, controls are created as a fixed HTML overlay positioned
  // over the focused terminal. See showTermControls/hideTermControls.
  inner.appendChild(header);

  const obj = document.createElement('object');
  obj.type = 'image/svg+xml';
  obj.data = '/terminal.svg?session=' + encodeURIComponent(sessionName);
  inner.appendChild(obj);

  el.appendChild(inner);
  // Click handling is done in onSceneClick/onMouseUp — no per-element handler
  return el;
}

function createShadowDOM() {
  const el = document.createElement('div');
  el.className = 'terminal-shadow';
  return el;
}

function createThumbnail(sessionName) {
  const item = document.createElement('div');
  item.className = 'thumbnail-item';
  item.dataset.session = sessionName;

  const label = document.createElement('div');
  label.className = 'thumb-label';
  label.textContent = sessionName;
  item.appendChild(label);

  // Minimize button — only visible when this terminal is in a focused group
  const minBtn = document.createElement('div');
  minBtn.className = 'thumb-minimize';
  minBtn.textContent = '⌊';
  minBtn.title = 'Remove from focus group';
  minBtn.style.display = 'none';
  minBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    removeFromFocus(sessionName);
  });
  item.appendChild(minBtn);

  const obj = document.createElement('object');
  obj.type = 'image/svg+xml';
  obj.data = '/terminal.svg?session=' + encodeURIComponent(sessionName);
  item.appendChild(obj);

  // Sidebar thumbnail click handler.
  // stopPropagation prevents this from also triggering onSceneClick on the renderer.
  // lastAddToFocusTime prevents the subsequent focusTerminal call (from other event
  // paths) from replacing the multi-focus selection. See note 3 in header.
  item.addEventListener('click', function (e) {
    e.stopPropagation();
    if (e.ctrlKey || ctrlHeld) {
      lastAddToFocusTime = performance.now();
      addToFocus(sessionName);
    } else {
      focusTerminal(sessionName);
    }
  });
  document.getElementById('sidebar').appendChild(item);
  return item;
}

// === Session Discovery ===
async function refreshSessions() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) return;
    const sessions = await res.json();
    const currentNames = new Set(sessions.map(function (s) { return s.name; }));
    const existingNames = new Set(terminals.keys());

    let changed = false;
    for (const session of sessions) {
      if (!existingNames.has(session.name)) {
        addTerminal(session.name, session.cols, session.rows);
        changed = true;
      } else {
        // Update card size if tmux dimensions changed (e.g. resized from another client)
        const t = terminals.get(session.name);
        if (t) updateCardForNewSize(t, session.cols, session.rows);
      }
    }
    for (const name of existingNames) {
      if (!currentNames.has(name)) {
        removeTerminal(name);
        changed = true;
      }
    }
    if (changed) {
      assignRings();
      if (focusedSessions.size > 0) calculateFocusedLayout();
    }
  } catch (e) {}
}

async function refreshTitles() {
  for (const name of terminals.keys()) {
    const title = await fetchTitle(name);
    if (title) updateTerminalTitle(name, title);
  }
}

// === Add/Remove ===
async function fetchTitle(sessionName) {
  try {
    const res = await fetch('/api/pane?session=' + encodeURIComponent(sessionName) + '&pane=0');
    if (!res.ok) return null;
    const data = await res.json();
    return data.title || null;
  } catch (e) { return null; }
}

function updateTerminalTitle(sessionName, title) {
  const t = terminals.get(sessionName);
  if (!t || !title) return;
  const nameEl = t.dom.querySelector('.session-name');
  if (nameEl) nameEl.textContent = title;
  const thumbLabel = t.thumbnail.querySelector('.thumb-label');
  if (thumbLabel) thumbLabel.textContent = title;
}

// SVG cell dimensions — measured from actual font rendering in terminal.svg.
// terminal.svg measures via a 10-char span: bbox.width/10 ≈ 8.65, bbox.height ≈ 17.
// These MUST match what the SVG actually renders or card aspect will be wrong.
const SVG_CELL_W = 8.65;
const SVG_CELL_H = 17;
const HEADER_H = 72;        // 4x header: 56px height + 16px padding (content-box)
const MIN_CARD_W = 640;
const MAX_CARD_W = 3200;
const MIN_CARD_H = 496;
const MAX_CARD_H = 2400;
// Target world-space area — same visual weight as original 320×248 card
const TARGET_WORLD_AREA = 320 * 248; // ~79,360 sq world units

// Calculate card DOM dimensions from terminal cols×rows.
// All cards have roughly the same visual weight (world-space area),
// but each card's shape matches its terminal's aspect ratio.
function calcCardSize(cols, rows) {
  const termAspect = (cols * SVG_CELL_W) / (rows * SVG_CELL_H);
  // Solve for world dimensions with target area and correct aspect:
  // worldW * worldH = TARGET_WORLD_AREA
  // worldW / worldH = termAspect
  // worldW = sqrt(TARGET_WORLD_AREA * termAspect)
  const worldW = Math.sqrt(TARGET_WORLD_AREA * termAspect);
  const worldH = TARGET_WORLD_AREA / worldW;
  // Convert world → DOM at 4x (world * 4 = DOM pixels)
  let cardW = Math.round(worldW * 4);
  let cardH = Math.round(worldH * 4) + HEADER_H;
  // Clamp to bounds
  cardW = Math.max(MIN_CARD_W, Math.min(MAX_CARD_W, cardW));
  cardH = Math.max(MIN_CARD_H, Math.min(MAX_CARD_H, cardH));
  return { cardW, cardH };
}

// Reactively update a terminal's card size when cols/rows change.
// Called from WebSocket onmessage when screenCols/screenRows differ.
// Update card base size when tmux dimensions change.
// Always updates baseCardW/baseCardH (so unfocus restores correctly).
// Only updates DOM if not focused (focus manages its own DOM sizing).
function updateCardForNewSize(t, newCols, newRows) {
  if (newCols === t.screenCols && newRows === t.screenRows) return;
  t.screenCols = newCols;
  t.screenRows = newRows;
  const { cardW, cardH } = calcCardSize(newCols, newRows);
  t.baseCardW = cardW;
  t.baseCardH = cardH;
  // Don't resize card DOM while focused — focus has its own layout.
  // baseCardW/baseCardH are updated above so unfocus restores correctly.
  if (t.dom.classList.contains('focused')) return;
  t.dom.style.width = cardW + 'px';
  t.dom.style.height = cardH + 'px';
  const inner = t.dom.querySelector('.terminal-inner');
  if (inner) {
    inner.style.width = cardW + 'px';
    inner.style.height = cardH + 'px';
  }
}

function addTerminal(sessionName, cols, rows) {
  cols = cols || 80;
  rows = rows || 24;
  const { cardW, cardH } = calcCardSize(cols, rows);

  const dom = createTerminalDOM(sessionName);
  dom.style.width = cardW + 'px';
  dom.style.height = cardH + 'px';
  const inner = dom.querySelector('.terminal-inner');
  if (inner) {
    inner.style.width = cardW + 'px';
    inner.style.height = cardH + 'px';
  }

  const shadowDiv = createShadowDOM();
  const thumbnail = createThumbnail(sessionName);

  const css3dObj = new CSS3DObject(dom);
  // IMPORTANT: DOM element is sized to match terminal at 4x scale.
  // CSS3DObject scale 0.25 forces Chrome to rasterize at 4x resolution.
  // DO NOT change to 1.0 with smaller DOM — text will be blurry. See note 1.
  css3dObj.scale.setScalar(0.25);
  // Start tilted so the fly-in shows 3D angle. Without this, CSS3DObjects default to
  // facing -Z (toward camera), so the fly-in looks flat. See note 7 in header.
  css3dObj.rotation.set(
    (40 + Math.random() * 30) * DEG2RAD,
    (-30 + Math.random() * 60) * DEG2RAD,
    (-20 + Math.random() * 40) * DEG2RAD
  );
  terminalGroup.add(css3dObj);

  dom.style.pointerEvents = 'auto';

  const shadowObj = new CSS3DObject(shadowDiv);
  shadowObj.rotation.x = -Math.PI / 2;
  shadowGroup.add(shadowObj);

  sessionOrder.push(sessionName);
  terminals.set(sessionName, {
    css3dObject: css3dObj,
    shadowObject: shadowObj,
    shadowDiv: shadowDiv,
    dom: dom,
    thumbnail: thumbnail,
    baseCardW: cardW,   // original calculated card size — restore on unfocus
    baseCardH: cardH,
    currentPos: { x: 0, y: 0, z: -500 },
    targetPos: { x: 0, y: 0, z: -500 },
    morphStart: clock.getElapsedTime(),
    morphFrom: { x: 0, y: 0, z: -500 },
    billboardArrival: null,  // set when terminal first reaches its ring position
    inputWs: null,
    scrollOffset: 0,
    screenLines: [],  // text content from server for copy/paste
    screenCols: cols,
    screenRows: rows,
    sendInput: function(msg) {
      if (this.inputWs && this.inputWs.readyState === WebSocket.OPEN) {
        this.inputWs.send(JSON.stringify(msg));
      } else {
        fetch('/api/input', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: sessionName, pane: '0', ...msg })
        }).catch(function() {});
      }
    },
    // Unified scroll — one offset, one method. Used by mouse wheel, PgUp/PgDn, etc.
    scrollBy: function(lines) {
      this.scrollOffset = Math.max(0, this.scrollOffset + lines);
      this.sendInput({ type: 'input', scrollTo: this.scrollOffset });
    },
    scrollReset: function() {
      this.scrollOffset = 0;
    }
  });

  fetchTitle(sessionName).then(function(title) {
    if (title) updateTerminalTitle(sessionName, title);
  });
}

function removeTerminal(sessionName) {
  const t = terminals.get(sessionName);
  if (!t) return;
  terminalGroup.remove(t.css3dObject);
  shadowGroup.remove(t.shadowObject);
  t.thumbnail.remove();
  terminals.delete(sessionName);
  sessionOrder = sessionOrder.filter(n => n !== sessionName);
  if (focusedSessions.has(sessionName)) {
    focusedSessions.delete(sessionName);
    if (activeInputSession === sessionName) activeInputSession = [...focusedSessions][0] || null;
    if (focusedSessions.size === 0) unfocusTerminal();
    else { updateFocusStyles(); calculateFocusedLayout(); }
  }
}

// === Focus / Unfocus ===

// Focus a single terminal (replaces all focused).
// === Terminal Controls Overlay ===
// Floating HTML bar outside the 3D scene — positioned over the focused terminal's header.
// Can't put buttons inside CSS3DObject DOM because getBoundingClientRect() returns NaN
// for elements under matrix3d transforms, making them unclickable.
let _controlsBar = null;
let _controlsSession = null;

function createControlsBar() {
  const bar = document.createElement('div');
  bar.id = 'term-controls-bar';
  bar.style.cssText = 'position:fixed;z-index:60;display:none;gap:6px;align-items:center;pointer-events:auto;';

  const mkBtn = (text, title, fn) => {
    const btn = document.createElement('button');
    btn.className = 'term-ctrl-btn-overlay';
    btn.textContent = text;
    btn.title = title;
    btn.style.cssText = 'width:28px;height:28px;border:none;border-radius:6px;background:rgba(255,255,255,0.12);color:#ccc;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;';
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.25)'; btn.style.color = '#fff'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(255,255,255,0.12)'; btn.style.color = '#ccc'; });
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); fn(); });
    return btn;
  };

  bar.appendChild(mkBtn('−', 'Smaller text (more cols)', () => {
    const t = terminals.get(_controlsSession);
    if (t) {
      const newCols = Math.min(300, (t.screenCols || 80) + 4);
      const newRows = Math.min(100, (t.screenRows || 24) + 2);
      t.sendInput({ type: 'resize', cols: newCols, rows: newRows });
    }
  }));
  bar.appendChild(mkBtn('+', 'Bigger text (fewer cols)', () => {
    const t = terminals.get(_controlsSession);
    if (t) {
      const newCols = Math.max(20, (t.screenCols || 80) - 4);
      const newRows = Math.max(5, (t.screenRows || 24) - 2);
      t.sendInput({ type: 'resize', cols: newCols, rows: newRows });
    }
  }));
  bar.appendChild(mkBtn('⊡', 'Optimize fit', () => {
    const t = terminals.get(_controlsSession);
    if (t) optimizeTerminalFit(t, _controlsSession);
  }));
  bar.appendChild(mkBtn('⌊', 'Minimize (return to ring)', () => {
    if (_controlsSession) removeFromFocus(_controlsSession);
  }));

  document.body.appendChild(bar);
  return bar;
}

function showTermControls(sessionName) {
  if (!_controlsBar) _controlsBar = createControlsBar();
  _controlsSession = sessionName;
  _controlsBar.style.display = 'flex';
  updateControlsPosition();
}

function hideTermControls() {
  if (_controlsBar) _controlsBar.style.display = 'none';
  _controlsSession = null;
}

function updateControlsPosition() {
  if (!_controlsBar || !_controlsSession) return;
  const t = terminals.get(_controlsSession);
  if (!t) return;
  const rect = t.dom.getBoundingClientRect();
  if (rect.width < 10) return;
  // Position at top-right of the terminal card
  _controlsBar.style.left = (rect.right - 110) + 'px';
  _controlsBar.style.top = (rect.top + 4) + 'px';
}

// The lastAddToFocusTime guard prevents this from firing immediately after addToFocus().
// Without it, the event sequence mouseup→click causes addToFocus (correct) then
// focusTerminal (wrong, replaces everything). The 200ms window covers the gap between
// mouseup and click events. See note 3 in header.
function focusTerminal(sessionName) {
  if (performance.now() - lastAddToFocusTime < 200) {
    return;
  }
  const t = terminals.get(sessionName);
  if (!t) return;

  // Restore any previously focused terminals
  restoreAllFocused();

  focusedSessions.add(sessionName);
  activeInputSession = sessionName;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  t.inputWs = new WebSocket(proto + '//' + location.host + '/ws/terminal?session=' + encodeURIComponent(sessionName) + '&pane=0');
  // Capture screen text from the WebSocket for copy/paste support
  t.inputWs.onmessage = function(e) {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'screen' && msg.lines) {
        t.screenLines = msg.lines.map(function(l) {
          return l.spans.map(function(s) { return s.text; }).join('');
        });
        updateCardForNewSize(t, msg.width || 80, msg.height || 24);
        if (msg.cursor) t._lastCursor = msg.cursor;
      } else if (msg.type === 'delta' && msg.changed) {
        for (const [idx, spans] of Object.entries(msg.changed)) {
          t.screenLines[parseInt(idx)] = spans.map(function(s) { return s.text; }).join('');
        }
        if (msg.cursor) t._lastCursor = msg.cursor;
      }
    } catch (err) {}
  };

  updateFocusStyles();

  const now = clock.getElapsedTime();
  t.morphFrom = { ...t.currentPos };
  t.targetPos = { x: 0, y: 0, z: 0 };
  t.morphStart = now;
  t.focusQuatFrom = t.css3dObject.quaternion.clone();

  // Reset camera FOV to default — prevents blurry focus from zoomed-in/out state
  camera.fov = 50;
  camera.updateProjectionMatrix();

  // Also reset orbit state so unfocus returns to a clean position
  orbitAngle = 0;
  orbitPitch = 0;

  // Scale card to fill viewport while preserving terminal aspect ratio.
  // Use the card's base aspect (from tmux cols×rows) to fill available screen space.
  const baseW = t.baseCardW || 1280;
  const baseH = t.baseCardH || 992;
  const baseAspect = baseW / baseH;

  const vFov = camera.fov * DEG2RAD;
  const visH = 2 * FOCUS_DIST * Math.tan(vFov / 2);
  const visW = visH * camera.aspect;
  const pxToWorld = visH / window.innerHeight;

  // Available world space (accounting for sidebar)
  const sidebarWorld = SIDEBAR_WIDTH * pxToWorld;
  const availW = visW - sidebarWorld;
  const availH = visH;

  // Fit card into available space preserving aspect
  let worldW, worldH;
  if (availW / availH > baseAspect) {
    // Height-limited
    worldH = availH * 0.92;
    worldW = worldH * baseAspect;
  } else {
    // Width-limited
    worldW = availW * 0.92;
    worldH = worldW / baseAspect;
  }

  // Convert world → DOM pixels for the focused card
  const screenH = Math.round((worldH / visH) * window.innerHeight);
  const screenW = Math.round(screenH * baseAspect);
  const innerScale = screenW / baseW;

  t.dom.style.width = screenW + 'px';
  t.dom.style.height = screenH + 'px';
  t.dom.style.borderRadius = Math.round(48 * (screenW / 1280)) + 'px';
  const inner = t.dom.querySelector('.terminal-inner');
  if (inner) {
    inner.style.width = baseW + 'px';
    inner.style.height = baseH + 'px';
    inner.style.transform = 'scale(' + innerScale + ')';
  }
  t.css3dObject.scale.setScalar(worldH / screenH);

  const offX = (SIDEBAR_WIDTH / 2) * pxToWorld;
  const offY = -(50 / 2) * pxToWorld;

  cameraTween = {
    from: camera.position.clone(),
    to: new THREE.Vector3(offX, offY, FOCUS_DIST),
    lookFrom: currentLookTarget.clone(),
    lookTo: new THREE.Vector3(offX, offY, 0),
    start: now,
    duration: 1.0
  };

  document.getElementById('input-bar').classList.add('visible');
  document.getElementById('input-target').textContent = sessionName;
  showTermControls(sessionName);
}

// Add a terminal to the multi-focus set (ctrl+click)
function addToFocus(sessionName) {
  const t = terminals.get(sessionName);
  if (!t) return;

  if (focusedSessions.has(sessionName)) {
    setActiveInput(sessionName);
    return;
  }
  lastAddToFocusTime = performance.now();

  // If switching from single-focus to multi-focus, restore DOM sizing on all existing focused
  for (const fname of focusedSessions) {
    const ft = terminals.get(fname);
    if (ft) {
      const rw = ft.baseCardW || 1280;
      const rh = ft.baseCardH || 992;
      ft.dom.style.width = rw + 'px';
      ft.dom.style.height = rh + 'px';
      ft.dom.style.borderRadius = '';
      const inner = ft.dom.querySelector('.terminal-inner');
      if (inner) { inner.style.transform = ''; inner.style.width = rw + 'px'; inner.style.height = rh + 'px'; }
      ft.css3dObject.scale.setScalar(0.25);
    }
  }

  focusedSessions.add(sessionName);
  activeInputSession = sessionName;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  t.inputWs = new WebSocket(proto + '//' + location.host + '/ws/terminal?session=' + encodeURIComponent(sessionName) + '&pane=0');
  t.inputWs.onmessage = function(e) {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'screen' && msg.lines) {
        t.screenLines = msg.lines.map(function(l) {
          return l.spans.map(function(s) { return s.text; }).join('');
        });
        updateCardForNewSize(t, msg.width || 80, msg.height || 24);
        if (msg.cursor) t._lastCursor = msg.cursor;
      } else if (msg.type === 'delta' && msg.changed) {
        for (const [idx, spans] of Object.entries(msg.changed)) {
          t.screenLines[parseInt(idx)] = spans.map(function(s) { return s.text; }).join('');
        }
        if (msg.cursor) t._lastCursor = msg.cursor;
      }
    } catch (err) {}
  };

  updateFocusStyles();
  calculateFocusedLayout();

  document.getElementById('input-bar').classList.add('visible');
  document.getElementById('input-target').textContent = activeInputSession;
}

// Set which focused terminal receives input
function setActiveInput(sessionName) {
  if (!focusedSessions.has(sessionName)) return;
  activeInputSession = sessionName;
  updateFocusStyles();
  document.getElementById('input-target').textContent = sessionName;
  showTermControls(sessionName);
}

// Update CSS classes for all terminals based on focus state
function updateFocusStyles() {
  for (const [name, term] of terminals) {
    term.dom.classList.remove('faded', 'focused', 'input-active');
    term.thumbnail.classList.remove('active');

    // Show/hide minimize button on thumbnail
    const minBtn = term.thumbnail.querySelector('.thumb-minimize');
    if (minBtn) minBtn.style.display = (focusedSessions.has(name) && focusedSessions.size > 1) ? 'block' : 'none';

    if (focusedSessions.size > 0) {
      if (focusedSessions.has(name)) {
        term.dom.classList.add('focused');
        term.thumbnail.classList.add('active');
        if (name === activeInputSession) {
          term.dom.classList.add('input-active');
        }
      } else {
        term.dom.classList.add('faded');
      }
    }
  }
}

// Restore a single terminal to overview state
function restoreFocusedTerminal(name) {
  const term = terminals.get(name);
  if (!term) return;
  if (term.inputWs) {
    term.inputWs.close();
    term.inputWs = null;
  }
  const now = clock.getElapsedTime();
  term.dom.classList.remove('faded', 'focused', 'input-active');
  // Restore card to its base calculated size (not CSS default 1280×992)
  const restoreW = term.baseCardW || 1280;
  const restoreH = term.baseCardH || 992;
  term.dom.style.width = restoreW + 'px';
  term.dom.style.height = restoreH + 'px';
  term.dom.style.borderRadius = '';
  const inner = term.dom.querySelector('.terminal-inner');
  if (inner) { inner.style.transform = ''; inner.style.width = restoreW + 'px'; inner.style.height = restoreH + 'px'; }
  term.css3dObject.scale.setScalar(0.25);
  const obj = term.dom.querySelector('object');
  if (obj) {
    obj.style.transform = '';
    obj.style.width = '';
    obj.style.height = '';
  }
  term.morphFrom = { ...term.currentPos };
  term.morphStart = now;
  term.billboardArrival = null;
}

// Remove a single terminal from the focused set (minimize).
// If other terminals remain focused, recalculate layout.
// If none remain, unfocus entirely.
function removeFromFocus(sessionName) {
  if (!focusedSessions.has(sessionName)) return;
  restoreFocusedTerminal(sessionName);
  focusedSessions.delete(sessionName);

  if (focusedSessions.size === 0) {
    unfocusTerminal();
    return;
  }

  // Switch active input if we just removed the active one
  if (activeInputSession === sessionName) {
    activeInputSession = [...focusedSessions][0];
    showTermControls(activeInputSession);
  }

  updateFocusStyles();
  assignRings(); // reassign ring positions including the restored terminal
  calculateFocusedLayout();
}

// Restore all focused terminals
function restoreAllFocused() {
  for (const name of focusedSessions) {
    restoreFocusedTerminal(name);
  }
  focusedSessions.clear();
}

function unfocusTerminal() {
  restoreAllFocused();
  activeInputSession = null;
  const now = clock.getElapsedTime();

  for (const [name, term] of terminals) {
    term.dom.classList.remove('faded', 'focused', 'input-active');
    term.thumbnail.classList.remove('active');
  }

  cameraTween = {
    from: camera.position.clone(),
    to: new THREE.Vector3(
      HOME_TARGET.x + Math.sin(orbitAngle) * HOME_POS.z,
      HOME_POS.y + orbitPitch * 200,
      HOME_TARGET.z + Math.cos(orbitAngle) * HOME_POS.z
    ),
    lookFrom: currentLookTarget.clone(),
    lookTo: HOME_TARGET.clone(),
    start: now,
    duration: 1.0
  };

  document.getElementById('input-bar').classList.remove('visible');
  hideTermControls();
}

// === Animation Loop ===
function animate() {
  requestAnimationFrame(animate);

  const time = clock.getElapsedTime();
  clock.getDelta(); // advance clock internal state (side effect needed for accurate getElapsedTime)

  // Camera tween
  if (cameraTween) {
    const elapsed = time - cameraTween.start;
    const t = Math.min(1, elapsed / cameraTween.duration);
    const eased = easeInOutCubic(t);

    camera.position.lerpVectors(cameraTween.from, cameraTween.to, eased);
    currentLookTarget.lerpVectors(cameraTween.lookFrom, cameraTween.lookTo, eased);
    camera.lookAt(currentLookTarget);

    if (t >= 1) cameraTween = null;
  }

  // Advance ring rotation
  outerAngle += RING.outer.spinSpeed * RING.outer.spinDir;
  innerAngle += RING.inner.spinSpeed * RING.inner.spinDir;

  // Per-terminal updates
  let idx = 0;
  for (const [name, t] of terminals) {
    let pos;

    if (focusedSessions.has(name)) {
      // Focused terminal: morph to grid position
      const morphElapsed = time - t.morphStart;
      const morphT = Math.min(1, morphElapsed / MORPH_DURATION);
      const eased = easeInOutCubic(morphT);
      t.currentPos = lerpPos(t.morphFrom, t.targetPos, eased);
      pos = t.currentPos;
    } else {
      // Ring layout (both overview and non-focused terminals during focus)
      const { config, names: ringNames, angle } = getRingInfo(name);
      const ringIdx = ringNames.indexOf(name);
      if (ringIdx < 0) { idx++; continue; }
      const ringPos = computeRingPos(ringIdx, ringNames.length, config, angle);

      // Smooth return from focus (morph toward ring position)
      const morphElapsed = time - t.morphStart;
      if (morphElapsed < MORPH_DURATION) {
        const morphT = easeInOutCubic(morphElapsed / MORPH_DURATION);
        t.currentPos = lerpPos(t.morphFrom, ringPos, morphT);
      } else {
        t.currentPos = ringPos;
      }
      pos = t.currentPos;
    }

    // Gentle float
    let floatY = 0, floatX = 0;
    if (!focusedSessions.has(name)) {
      floatY = Math.sin(time * 0.4 + idx * 1.3) * 5;
      floatX = Math.cos(time * 0.3 + idx * 1.7) * 3;
    }

    t.css3dObject.position.set(
      pos.x + floatX,
      pos.y + floatY,
      pos.z
    );

    // === Orientation ===
    if (focusedSessions.has(name)) {
      // Focused terminal: slerp from captured rotation to face-camera over the fly-in
      const morphElapsed = time - t.morphStart;
      const morphT = Math.min(1, morphElapsed / MORPH_DURATION);
      const eased = easeInOutCubic(morphT);
      if (t.focusQuatFrom) {
        _targetQuat.copy(camera.quaternion);
        t.css3dObject.quaternion.copy(t.focusQuatFrom).slerp(_targetQuat, eased);
      } else {
        t.css3dObject.quaternion.copy(camera.quaternion);
      }
    } else {
      // Billboard toward camera, but only ease in after morph completes
      const morphElapsed = time - t.morphStart;
      const morphDone = morphElapsed >= MORPH_DURATION;

      // Target: face camera
      t.css3dObject.getWorldPosition(_worldPos);
      _lookAtMat.lookAt(camera.position, _worldPos, _up);
      _targetQuat.setFromRotationMatrix(_lookAtMat);

      // Apply card tilt from ring config
      const { config } = getRingInfo(name);
      const ct = config.cardTilt;
      if (ct.x !== 0 || ct.y !== 0 || ct.z !== 0) {
        _cardTiltEuler.set(ct.x * DEG2RAD, ct.y * DEG2RAD, ct.z * DEG2RAD);
        _driftQuat.setFromEuler(_cardTiltEuler);
        _targetQuat.multiply(_driftQuat);
      }

      // Gentle lazy drift
      _driftEuler.set(
        Math.sin(time * 0.3 + idx * 1.5) * 0.03,
        Math.cos(time * 0.2 + idx * 1.7) * 0.04,
        0
      );
      _driftQuat.setFromEuler(_driftEuler);
      _targetQuat.multiply(_driftQuat);

      // Track when terminal arrives at its ring position
      if (morphDone && t.billboardArrival === null) {
        t.billboardArrival = time;
      }
      if (!morphDone) {
        t.billboardArrival = null; // reset if morphing again
      }

      if (t.billboardArrival === null) {
        // Flying in: rotate toward camera while moving (smooth concurrent motion)
        const morphProgress = Math.min(1, morphElapsed / MORPH_DURATION);
        const easedProgress = easeInOutCubic(morphProgress);
        // Slerp ramps from 0.01 to BILLBOARD_SLERP over the fly-in
        const flySlerp = 0.01 + easedProgress * (BILLBOARD_SLERP - 0.01);
        t.css3dObject.quaternion.slerp(_targetQuat, flySlerp);
      } else {
        // At rest: normal billboard slerp
        t.css3dObject.quaternion.slerp(_targetQuat, BILLBOARD_SLERP);
      }
    }

    // === Shadow ===
    const heightAboveFloor = pos.y + floatY - FLOOR_Y;
    const absHeight = Math.abs(heightAboveFloor);
    const shadowScale = 1.5 + absHeight * 0.002;
    const shadowBlur = 20 + absHeight * 0.05;
    const shadowOpacity = Math.max(0.4, 1.0 - absHeight * 0.0003);

    t.shadowObject.position.set(
      pos.x + floatX + LIGHT_DIR.x * absHeight * 0.15,
      FLOOR_Y,
      pos.z + LIGHT_DIR.z * absHeight * 0.15
    );
    t.shadowDiv.style.filter = 'blur(' + shadowBlur.toFixed(0) + 'px)';
    t.shadowDiv.style.opacity = shadowOpacity.toFixed(3);
    t.shadowObject.scale.setScalar(shadowScale);

    // === Specular ===
    const specular = t.dom.querySelector('.specular-overlay');
    if (specular) {
      _panelNormal.set(0, 0, 1).applyQuaternion(t.css3dObject.quaternion);
      const dot = _panelNormal.dot(LIGHT_DIR);
      const intensity = Math.max(0, dot) * 0.4;
      specular.style.background = 'linear-gradient(135deg, rgba(255,255,255,' + intensity.toFixed(3) + ') 0%, transparent 60%)';
    }

    idx++;
  }

  // Ensure camera looks at target when not tweening
  if (!cameraTween) {
    camera.lookAt(currentLookTarget);
  }

  renderer.render(scene, camera);

  // Update floating controls position to track the focused terminal
  updateControlsPosition();
}

// === Direct Keystroke Capture ===
// When a terminal is focused, ALL keyboard events go to tmux via WebSocket.
// Browser shortcuts (Ctrl+T, Ctrl+W, etc.) are excluded.
// DO NOT add per-terminal click handlers — see note 4 in header.
document.addEventListener('keydown', function(e) {
  if (!activeInputSession) return;
  if (focusedSessions.size === 0) return;

  // Don't capture when help panel is open
  if (document.getElementById('help-panel').classList.contains('visible')) return;

  // Let browser shortcuts through
  if ((e.ctrlKey || e.metaKey) && ['t', 'w', 'n', 'r', 'v'].includes(e.key.toLowerCase())) return;
  if (e.altKey && e.key === 'F4') return;
  if (e.key === 'F12') return;

  // Don't interfere with bare modifier presses
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;

  // Escape: unfocus terminal (handled by existing onKeyDown)
  if (e.key === 'Escape') return;

  e.preventDefault();

  const t = terminals.get(activeInputSession);
  if (!t) return;

  // Shift+Arrow: keyboard text selection
  if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    // Get actual terminal dimensions from SVG
    let cols = t.screenCols, rows = t.screenRows;
    try {
      const obj = t.dom.querySelector('object');
      if (obj && obj.contentDocument) {
        const svg = obj.contentDocument.getElementById('root');
        const measure = obj.contentDocument.getElementById('measure');
        if (svg && measure) {
          const vb = svg.getAttribute('viewBox');
          if (vb) {
            const parts = vb.split(/\s+/);
            const bbox = measure.getBBox();
            if (bbox.width > 0) {
              cols = Math.round(parseFloat(parts[2]) / (bbox.width / 10));
              rows = Math.round(parseFloat(parts[3]) / bbox.height);
            }
          }
        }
      }
    } catch (err) {}

    // Initialize keyboard selection at cursor position if not started
    if (!selStart) {
      // Use server's cursor position, or default to 0,0
      const cursor = t._lastCursor || { x: 0, y: 0 };
      selStart = { row: cursor.y, col: cursor.x };
      selEnd = { row: cursor.y, col: cursor.x };
    }

    // Extend selection
    let r = selEnd.row, c = selEnd.col;
    if (e.key === 'ArrowRight') { c++; if (c >= cols) { c = 0; r++; } }
    else if (e.key === 'ArrowLeft') { c--; if (c < 0) { c = cols - 1; r--; } }
    else if (e.key === 'ArrowDown') { r++; }
    else if (e.key === 'ArrowUp') { r--; }
    else if (e.key === 'Home') { c = 0; }
    else if (e.key === 'End') { c = cols - 1; }
    r = Math.max(0, Math.min(r, rows - 1));
    c = Math.max(0, Math.min(c, cols - 1));
    selEnd = { row: r, col: c };

    // Draw the highlight — get render info for positioning
    const renderInfo = getTermRenderInfo(t);
    if (renderInfo) {
      selEnd._render = renderInfo;
      selStart._render = renderInfo;
    }
    drawSelHighlight(t);
    return;
  }

  // Page Up/Down: scroll by a full page
  if (e.key === 'PageUp') {
    t.scrollBy(24);
    return;
  }
  if (e.key === 'PageDown') {
    t.scrollBy(-24);
    return;
  }

  // Any keystroke resets scroll to live view
  t.scrollReset();

  // Ctrl+C: if text is selected, copy instead of sending C-c to terminal
  if (e.ctrlKey && e.key.toLowerCase() === 'c' && selStart) {
    const text = getSelectedTextFromSvg(t);
    if (text) {
      copyToClipboard(text);
    }
    clearSel();
    return;
  }

  // Ctrl combos (C-c only reaches here if no selection)
  if (e.ctrlKey && e.key.length === 1) {
    t.sendInput({ type: 'input', specialKey: 'C-' + e.key.toLowerCase() });
    return;
  }

  // Special keys
  if (SPECIAL_KEY_MAP[e.key]) {
    t.sendInput({ type: 'input', specialKey: SPECIAL_KEY_MAP[e.key] });
    return;
  }

  // Regular printable characters
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    t.sendInput({ type: 'input', keys: e.key });
  }
});

// Paste support
document.addEventListener('paste', function(e) {
  if (!activeInputSession) return;
  if (focusedSessions.size === 0) return;
  e.preventDefault();
  const text = e.clipboardData.getData('text');
  if (text) {
    const t = terminals.get(activeInputSession);
    if (t) t.sendInput({ type: 'input', keys: text });
  }
});

// === Text Selection + Copy ===
// When a focused terminal is Alt+clicked/dragged, select text and copy to clipboard.
// Alt+click enters selection mode so it doesn't conflict with orbit drag.
// Selection happens in the dashboard layer (not inside the SVG <object>)
// because <object> pointer-events must stay 'none' for the dashboard to work.
let selTerminal = null;
let selStart = null;  // { row, col }
let selEnd = null;
let selOverlay = null; // DOM element for selection highlight

function getSelOverlay() {
  if (!selOverlay) {
    selOverlay = document.createElement('div');
    selOverlay.id = 'sel-overlay';
    selOverlay.style.cssText = 'position:fixed;top:0;left:0;z-index:50;pointer-events:none;';
    document.body.appendChild(selOverlay);
  }
  return selOverlay;
}

function getTermRenderInfo(t) {
  // Calculate the rendered SVG area dimensions for a terminal
  const obj = t.dom.querySelector('object');
  if (!obj) return null;
  const rect = obj.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;

  let cols = t.screenCols, rows = t.screenRows;
  let svgW = rect.width, svgH = rect.height;

  try {
    const svgDoc = obj.contentDocument;
    if (svgDoc) {
      const svgRoot = svgDoc.getElementById('root');
      if (svgRoot) {
        const vb = svgRoot.getAttribute('viewBox');
        if (vb) {
          const parts = vb.split(/\s+/);
          svgW = parseFloat(parts[2]);
          svgH = parseFloat(parts[3]);
        }
        const measure = svgDoc.getElementById('measure');
        if (measure) {
          const bbox = measure.getBBox();
          if (bbox.width > 0) {
            cols = Math.round(svgW / (bbox.width / 10));
            rows = Math.round(svgH / bbox.height);
          }
        }
      }
    }
  } catch (err) {}

  const svgAspect = svgW / svgH;
  const objAspect = rect.width / rect.height;
  let renderW, renderH, offsetX, offsetY;
  if (objAspect > svgAspect) {
    renderH = rect.height;
    renderW = rect.height * svgAspect;
    offsetX = (rect.width - renderW) / 2;
    offsetY = 0;
  } else {
    renderW = rect.width;
    renderH = rect.width / svgAspect;
    offsetX = 0;
    offsetY = (rect.height - renderH) / 2;
  }

  return {
    left: rect.left + offsetX,
    top: rect.top + offsetY,
    cellW: renderW / cols,
    cellH: renderH / rows,
    cols, rows
  };
}

function screenToCell(e, t) {
  // Map screen pixel coordinates to terminal character row/col
  const r = getTermRenderInfo(t);
  if (!r) return null;

  const col = Math.floor((e.clientX - r.left) / r.cellW);
  const row = Math.floor((e.clientY - r.top) / r.cellH);
  return {
    row: Math.max(0, Math.min(row, r.rows - 1)),
    col: Math.max(0, Math.min(col, r.cols - 1)),
    _render: r
  };
}

function drawSelHighlight(t) {
  const overlay = getSelOverlay();
  overlay.innerHTML = '';
  if (!selStart || !selEnd || !t) return;

  // Use render info from the most recent screenToCell call
  const r = selEnd._render || selStart._render;
  if (!r) return;

  // Normalize direction
  let s = selStart, en = selEnd;
  if (s.row > en.row || (s.row === en.row && s.col > en.col)) {
    s = selEnd; en = selStart;
  }

  for (let row = s.row; row <= en.row; row++) {
    const c1 = (row === s.row) ? s.col : 0;
    const c2 = (row === en.row) ? en.col : r.cols - 1;
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;background:rgba(92,92,255,0.3);pointer-events:none;';
    div.style.left = (r.left + c1 * r.cellW) + 'px';
    div.style.top = (r.top + row * r.cellH) + 'px';
    div.style.width = ((c2 - c1 + 1) * r.cellW) + 'px';
    div.style.height = r.cellH + 'px';
    overlay.appendChild(div);
  }
}

function getSelectedText(t) {
  if (!selStart || !selEnd || !t || !t.screenLines.length) return '';
  let s = selStart, en = selEnd;
  if (s.row > en.row || (s.row === en.row && s.col > en.col)) {
    s = selEnd; en = selStart;
  }
  const lines = [];
  for (let row = s.row; row <= en.row; row++) {
    const line = t.screenLines[row] || '';
    const c1 = (row === s.row) ? s.col : 0;
    const c2 = (row === en.row) ? en.col + 1 : line.length;
    lines.push(line.substring(c1, c2).replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

// Get text directly from the SVG document if dashboard screenLines aren't populated
function getSelectedTextFromSvg(t) {
  if (!selStart || !selEnd) return getSelectedText(t);
  try {
    const obj = t.dom.querySelector('object');
    if (!obj || !obj.contentDocument) return getSelectedText(t);
    const allLines = [];
    let row = 0;
    while (true) {
      const textEl = obj.contentDocument.getElementById('r' + row);
      if (!textEl) break;
      allLines.push(textEl.textContent || '');
      row++;
    }
    if (allLines.length === 0) return getSelectedText(t);

    let s = selStart, en = selEnd;
    if (s.row > en.row || (s.row === en.row && s.col > en.col)) {
      s = selEnd; en = selStart;
    }
    const result = [];
    for (let r = s.row; r <= en.row; r++) {
      const line = allLines[r] || '';
      const c1 = (r === s.row) ? s.col : 0;
      const c2 = (r === en.row) ? en.col + 1 : line.length;
      result.push(line.substring(c1, c2).replace(/\s+$/, ''));
    }
    return result.join('\n');
  } catch (err) {
    return getSelectedText(t);
  }
}

function clearSel() {
  selTerminal = null;
  selStart = null;
  selEnd = null;
  if (selOverlay) selOverlay.innerHTML = '';
}

// Clipboard write with fallback for non-HTTPS contexts
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(function() {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch (e) {}
  document.body.removeChild(ta);
}

// Plain mousedown on a focused terminal starts text selection.
// When unfocused, plain drag orbits (handled by onMouseDown above).
// Alt+drag orbits when focused (swapped).
document.addEventListener('mousedown', function(e) {
  if (e.button !== 0) return;
  if (!matchBinding(KEYBINDINGS.selectText, e, focusedSessions.size > 0)) return;
  if (!activeInputSession) return;
  const t = terminals.get(activeInputSession);
  if (!t) return;

  const cell = screenToCell(e, t);
  if (!cell) return;

  e.preventDefault();
  e.stopPropagation();
  selTerminal = t;
  selStart = cell;
  selEnd = cell;
  drawSelHighlight(t);
}, true); // capture phase to intercept before orbit drag

document.addEventListener('mousemove', function(e) {
  if (!selTerminal || !selStart) return;
  selEnd = screenToCell(e, selTerminal);
  if (selEnd) drawSelHighlight(selTerminal);
});

document.addEventListener('mouseup', function(e) {
  if (!selTerminal || !selStart) return;
  selEnd = screenToCell(e, selTerminal);

  // Only keep selection if mouse actually moved (not just a click)
  const isRealSelection = selStart && selEnd && (selStart.row !== selEnd.row || selStart.col !== selEnd.col);
  if (!isRealSelection) {
    // Just a click, not a drag — clear everything
    clearSel();
    selTerminal = null;
    return;
  }

  if (selEnd) drawSelHighlight(selTerminal);

  if (isRealSelection) {
    const text = getSelectedTextFromSvg(selTerminal);
    if (text) {
      copyToClipboard(text);
    }
  }

  // Stop the selection drag — critical. Without this, mousemove keeps updating selEnd
  // after mouseup, causing the "keeps dragging after release" bug.
  selTerminal = null;
  // Keep selStart/selEnd/highlight visible for Ctrl+C. clearSel() on next keystroke.
  suppressNextClick = true;
});

// Clear selection on any keystroke EXCEPT selection-related keys.
// Ctrl+C copy is handled in the main keystroke handler above — not here.
document.addEventListener('keydown', function(e) {
  // Don't clear on shift+arrow (keyboard selection extending)
  if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  // Don't clear on Ctrl+C — the main handler copies the selection
  if (e.ctrlKey && e.key.toLowerCase() === 'c') return;
  // Don't clear on bare modifiers
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  if (selStart && !e.altKey) {
    clearSel();
  }
});

// === Start ===
init();
