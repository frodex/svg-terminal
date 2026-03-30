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
// 6-8. FLY-IN ROTATION EFFECTS (REMOVED):
//    Previously: cards spawned at random 3D angles, focusQuatFrom captured rotation
//    on focus for slerp animation, billboardArrival tracked morph completion for
//    ramped billboard slerp. All removed because they caused unpredictable bouncing
//    and overshooting when focusing terminals — terminals would fly too far back or
//    off-screen. The effect was visually appealing but too hard to control. Can be
//    re-added later with careful tuning of slerp parameters and morph timing.
//    For now: cards face camera from spawn, focus = instant face-camera.
//
// 9. CAMERA-ONLY FOCUS: Cards are ALWAYS at their base DOM size. "Focus" means
//    the camera moves close enough to fill the viewport. No DOM changes on focus.
//    The abandoned DOM-resize approach (resize card DOM to 1:1 pixels, set inner
//    scale transform, recalculate CSS3DObject scale) created a two-state system
//    where alt+drag, +/-, optimize, and unfocus all fought each other. See PRD §2.2.
//
// 10. CSS3D HIT TESTING IS PURELY 2D: e.target.closest() and getBoundingClientRect()
//     have no concept of Z depth in a CSS3DRenderer scene. A large card at Z=-50
//     can intercept clicks meant for a small card at Z=+50. All header hit testing
//     uses explicit coordinate checking against getBoundingClientRect rects. See PRD §6.3.
//
// 11. ACTIVE INDICATOR — HEADER BACKGROUND NOT BORDER: The gold active-card indicator
//     is applied to the header element's background, NOT as a border or box-shadow on
//     .terminal-3d. Borders/shadows on the root element under matrix3d cause Chrome to
//     re-rasterize the entire card, producing visible text sharpness mutation. See PRD §7.3.
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
// Optimize terminal → card: resize tmux to fill the current card.
// Card stays, terminal adjusts. Use after alt+drag to fill a custom card size.
function optimizeTermToCard(t) {
  const obj = t.dom.querySelector('object');
  if (!obj) return;
  const cardW = parseInt(t.dom.style.width) || 1280;
  const cardH = (parseInt(t.dom.style.height) || 992) - HEADER_H;
  const cols = t.screenCols || 80;
  const rows = t.screenRows || 24;
  try {
    const svgDoc = obj.contentDocument;
    const measure = svgDoc && svgDoc.getElementById('measure');
    if (measure) {
      const bbox = measure.getBBox();
      if (bbox.width > 0) {
        const cellW = bbox.width / 10;
        const cellH = bbox.height;
        const scaleW = cardW / (cols * cellW);
        const scaleH = cardH / (rows * cellH);
        const fitScale = Math.min(scaleW, scaleH);
        const newCols = Math.max(20, Math.round(cardW / (cellW * fitScale)));
        const newRows = Math.max(5, Math.round(cardH / (cellH * fitScale)));
        t.sendInput({ type: 'resize', cols: newCols, rows: newRows });
        return;
      }
    }
  } catch (e) {}
  t.sendInput({ type: 'resize', cols: cols, rows: rows });
}

// Optimize card → terminal: resize the card to fit the current terminal.
// Terminal stays, card adjusts. Use after +/- to wrap the card snugly.
// Same logic as addTerminal init — unified path.
function optimizeCardToTerm(t) {
  const cols = t.screenCols || 80;
  const rows = t.screenRows || 24;
  const { cardW, cardH } = calcCardSize(cols, rows);
  t.baseCardW = cardW;
  t.baseCardH = cardH;
  t.dom.style.width = cardW + 'px';
  t.dom.style.height = cardH + 'px';
  const inner = t.dom.querySelector('.terminal-inner');
  if (inner) {
    inner.style.width = cardW + 'px';
    inner.style.height = cardH + 'px';
    inner.style.transform = '';
  }
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
let ringZOffset = 0;        // current ring Z offset (eases toward target)
const RING_Z_BACK = -800;   // how far back to push ring during focus
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

  // Build cards with cell counts — skip user-positioned terminals
  const names = [...focusedSessions];
  const cards = [];
  for (const name of names) {
    const t = terminals.get(name);
    if (t && t._userPositioned) continue; // user dragged/resized — don't override
    const cols = t ? t.screenCols || 80 : 80;
    const rows = t ? t.screenRows || 24 : 24;
    const cells = cols * rows;
    const aspect = (cols * SVG_CELL_W) / (rows * SVG_CELL_H);
    const worldW = (t ? t.baseCardW || 1280 : 1280) * 0.25;
    const worldH = (t ? t.baseCardH || 992 : 992) * 0.25;
    cards.push({ name, cols, rows, cells, aspect, worldW, worldH });
  }

  if (cards.length === 0) return; // all cards user-positioned, nothing to layout
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
    t._layoutZ = cardZ; // save layout Z for active-card slide
    t.targetPos = { x: wx, y: wy, z: cardZ };
    t.morphStart = now;

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
  document.addEventListener('mousemove', onMouseMove);
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
      // CAMERA-RELATIVE DRAG: move along camera's right/up vectors, not world X/Y.
      // If we moved along world X/Y, dragging "right" while looking diagonally would
      // slide the card sideways in world space — it would appear to drift off-screen.
      // Camera right (matrixWorld column 0) and up (column 1) always match screen axes
      // regardless of camera rotation, so the card follows the mouse naturally.
      const t = _moveCardSession && terminals.get(_moveCardSession);
      if (t) {
        const worldPos = new THREE.Vector3();
        t.css3dObject.getWorldPosition(worldPos);
        const depthFromCamera = worldPos.clone().sub(camera.position).length();
        const vFov = camera.fov * DEG2RAD;
        const visHAtDepth = 2 * depthFromCamera * Math.tan(vFov / 2);
        const px2w = visHAtDepth / window.innerHeight;
        // Camera's right and up vectors in world space
        const right = new THREE.Vector3();
        const up = new THREE.Vector3();
        camera.getWorldDirection(new THREE.Vector3()); // ensure matrix is current
        right.setFromMatrixColumn(camera.matrixWorld, 0); // right = column 0
        up.setFromMatrixColumn(camera.matrixWorld, 1);    // up = column 1
        t.targetPos.x += right.x * dx * px2w + up.x * (-dy) * px2w;
        t.targetPos.y += right.y * dx * px2w + up.y * (-dy) * px2w;
        t.targetPos.z += right.z * dx * px2w + up.z * (-dy) * px2w;
        t.morphFrom = { ...t.targetPos };
        t.morphStart = 0;
        t._userPositioned = true;
      }
      return;
    }

    if (dragMode === 'dollyCard') {
      // Ctrl+drag header: dolly camera toward/away from the card.
      // Drag up = zoom in (camera closer), drag down = zoom out.
      // Card stays put, camera moves along the vector from camera to card.
      const t = _moveCardSession && terminals.get(_moveCardSession);
      if (t) {
        const cardWorldPos = new THREE.Vector3(t.targetPos.x, t.targetPos.y, t.targetPos.z || 0);
        const dir = cardWorldPos.clone().sub(camera.position).normalize();
        const speed = dy * 0.5; // drag down = positive dy = zoom out (move camera back)
        camera.position.addScaledVector(dir, speed);
        currentLookTarget.copy(cardWorldPos);
        camera.lookAt(currentLookTarget);
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
      // Inner matches card — no scale transform in camera-only architecture
      const inner = t.dom.querySelector('.terminal-inner');
      if (inner) {
        inner.style.width = newW + 'px';
        inner.style.height = newH + 'px';
      }
      // Save as user's preferred size
      t.baseCardW = newW;
      t.baseCardH = newH;
      t._userPositioned = true; // prevent layout from overriding user's resize
    }
  }
}

function onMouseDown(e) {
  // Reset drag distance on every mousedown — prevents stale values from
  // previous interactions causing wasDrag() to return true on fresh clicks.
  dragDistance = 0;
  // Disable iframe pointer events during drag to prevent iframe from capturing mouseup
  document.querySelectorAll('.terminal-3d iframe').forEach(function(f) { f.style.pointerEvents = 'none'; });

  // Track whether mousedown started on sidebar — if so, the thumbnail's own click
  // handler manages ctrl+click. Without this flag, handleCtrlClick in onMouseUp
  // ALSO fires and finds a different terminal behind the sidebar via bounding rect
  // hit detection, causing two terminals to be added per ctrl+click.
  const sidebar = document.getElementById('sidebar');
  mouseDownOnSidebar = sidebar && sidebar.contains(e.target);
  const isFocused = focusedSessions.size > 0;

  if (e.button === 0) {
    // Check if mousedown is on any focused card's header (title bar drag).
    // CANNOT use e.target.closest('.terminal-3d header') — CSS3D hit testing is purely
    // 2D. A card behind another in Z depth can intercept the event. Instead we check
    // click coordinates against each focused header's getBoundingClientRect. See PRD §6.3.
    // Check click coordinates against all focused card headers.
    let headerHitSession = null;
    let isButton = e.target.closest && e.target.closest('button');
    if (isFocused && !isButton) {
      for (const fname of focusedSessions) {
        const ft = terminals.get(fname);
        if (!ft) continue;
        const hdr = ft.dom.querySelector('header');
        if (!hdr) continue;
        const hr = hdr.getBoundingClientRect();
        if (e.clientX >= hr.left && e.clientX <= hr.right && e.clientY >= hr.top && e.clientY <= hr.bottom) {
          headerHitSession = fname;
          break;
        }
      }
    }
    if (headerHitSession) {
      const sessionName = headerHitSession;
      if (sessionName && focusedSessions.has(sessionName)) {
        isDragging = true;
        dragMode = (e.ctrlKey || ctrlHeld) ? 'dollyCard' : 'moveCard';
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
          rt._resizeStartH = (parseInt(rt.dom.style.height) || 992) - HEADER_H;
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
    if ((dragMode === 'ctrlPending' || ctrlHeld) && dragMode !== 'dollyCard') {
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
  if ((dragMode === 'moveCard' || dragMode === 'dollyCard') && dragDistance <= 5 && _moveCardSession) {
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
      const cardH = (parseInt(t.dom.style.height) || 992) - HEADER_H;
      const newCols = Math.max(20, Math.round(startCols * cardW / startW));
      const newRows = Math.max(5, Math.round(startRows * cardH / startH));
      t.sendInput({ type: 'resize', cols: newCols, rows: newRows });
    }
  }
  _lastDragWasReal = isDragging && dragDistance > 5;
  isDragging = false;
  dragMode = null;
  // Re-enable iframe pointer events after any drag
  document.querySelectorAll('.terminal-3d iframe').forEach(function(f) { f.style.pointerEvents = 'auto'; });
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

// _lastDragWasReal replaces raw dragDistance for wasDrag(). The old approach checked
// dragDistance > 5 directly in onSceneClick, but dragDistance is reset on mousedown —
// so by the time onSceneClick fires, a stale reset could make a real drag look like a
// click. Setting this flag in onMouseUp captures the drag state before any reset. See PRD §6.2.
let _lastDragWasReal = false; // set in onMouseUp, cleared in onSceneClick

function wasDrag() {
  return _lastDragWasReal;
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

let _zoomedSession = null; // which terminal is currently zoomed in multi-focus

function onKeyDown(e) {
  if (e.key === 'Escape') {
    const panel = document.getElementById('help-panel');
    if (panel.classList.contains('visible')) {
      panel.classList.remove('visible');
    } else if (_zoomedSession) {
      // Return from zoomed view to multi-focus layout
      _zoomedSession = null;
      calculateFocusedLayout();
    } else if (focusedSessions.size > 0) {
      unfocusTerminal();
    }
  }
  if (e.key === '?' && focusedSessions.size === 0) {
    toggleHelp();
  }
  // Shift+Tab: cycle through focused terminals, zooming each to fill viewport
  if (e.key === 'Tab' && e.shiftKey && focusedSessions.size > 1) {
    e.preventDefault();
    const names = [...focusedSessions];
    const currentIdx = _zoomedSession ? names.indexOf(_zoomedSession) : -1;
    const nextIdx = (currentIdx + 1) % names.length;
    _zoomedSession = names[nextIdx];
    zoomToFocusedTerminal(_zoomedSession);
  }
}

// Zoom camera to a single terminal within the multi-focus set.
// The focus set stays intact — this just moves the camera to see one terminal large.
function zoomToFocusedTerminal(sessionName) {
  const t = terminals.get(sessionName);
  if (!t) return;

  setActiveInput(sessionName);

  const now = clock.getElapsedTime();
  const vFov = camera.fov * DEG2RAD;
  const halfTan = Math.tan(vFov / 2);

  // Calculate camera distance to fill ~85% of viewport height with this card
  const worldH = (t.baseCardH || 992) * 0.25;
  const depth = worldH / (0.85 * 2 * halfTan);

  // Camera flies to look directly at this terminal's position
  const cardPos = t.targetPos || t.currentPos;
  cameraTween = {
    from: camera.position.clone(),
    to: new THREE.Vector3(cardPos.x, cardPos.y, cardPos.z + depth),
    lookFrom: currentLookTarget.clone(),
    lookTo: new THREE.Vector3(cardPos.x, cardPos.y, cardPos.z),
    start: now,
    duration: 0.6
  };
}

// Find URL at a specific row/col by walking the span list
function getUrlAtCell(t, row, col) {
  if (!t.screenLines || !t.screenLines[row]) return null;
  const lineObj = t.screenLines[row];
  if (!lineObj.spans) return null;
  let offset = 0;
  for (let i = 0; i < lineObj.spans.length; i++) {
    const s = lineObj.spans[i];
    if (col >= offset && col < offset + s.text.length) {
      return s.url || null;
    }
    offset += s.text.length;
  }
  return null;
}

function onSceneClick(e) {
  // IMPORTANT: Ctrl+click is handled ENTIRELY in onMouseUp → handleCtrlClick.
  // DO NOT add ctrl+click handling here — it causes double-fire because both
  // onMouseUp and onSceneClick find different terminals via overlapping bounding
  // rects in the 3D scene. This was the root cause of the "ctrl+click adds 2
  // terminals" bug. See note 3 in header.
  if (suppressNextClick || ctrlHeld || e.ctrlKey) {
    suppressNextClick = false;
    _lastDragWasReal = false;
    return;
  }
  if (wasDrag()) { _lastDragWasReal = false; return; }
  _lastDragWasReal = false;
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
      // Check for URL click on focused terminal
      const t = terminals.get(clicked);
      if (t) {
        const cell = screenToCell(e, t);
        if (cell) {
          const url = getUrlAtCell(t, cell.row, cell.col);
          if (url) {
            if (e.altKey || altHeld) {
              window.open(url, '_blank');
            } else {
              addBrowserCard(url);
            }
            return;
          }
        }
      }
      setActiveInput(clicked);
    } else {
      focusTerminal(clicked);
    }
  }
  // Click on empty space: deselect (remove input focus) but keep camera and cards in place.
  // Escape returns to attract mode (ring animation).
  if (!clicked && focusedSessions.size > 0) {
    deselectTerminals();
  }
}

// Dolly camera toward the point under the mouse cursor.
// Converts mouse screen position to a world-space ray and moves camera along it.
// NDC→RAY CONVERSION: Screen pixel (clientX, clientY) → NDC (-1..1, -1..1) → world point
// via Vector3.unproject(camera). Subtracting camera.position gives the ray direction.
// Moving the camera along this ray zooms toward/away from whatever is under the cursor,
// rather than zooming toward the scene origin (which would feel wrong off-center).
function dollyTowardCursor(e, speed) {
  // Normalized device coordinates (-1 to 1)
  const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
  const ndcY = -(e.clientY / window.innerHeight) * 2 + 1;
  // Ray from camera through mouse position
  const ray = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
  camera.position.addScaledVector(ray, -speed);
  // Update look target to follow the dolly
  currentLookTarget.addScaledVector(ray, -speed);
  camera.lookAt(currentLookTarget);
  orbitDist = camera.position.distanceTo(currentLookTarget);
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
    // Shift+scroll: focus-zoom toward mouse cursor
    dollyTowardCursor(e, delta * 0.8);
    return;
  }

  // Default (unfocused scroll): dolly toward mouse cursor
  dollyTowardCursor(e, delta * 0.5);
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
// CARD FACTORY PATTERN (See PRD §2.4): createCardDOM is a generic factory for any card
// type. Header, dots, controls, and drag behavior are inherited by all card types.
// createTerminalDOM() and createBrowserDOM() both call createCardDOM() with their own
// contentEl — this makes the pattern recursive and reusable without duplicating structure.
// config: { id, title, type: 'terminal'|'browser', controls: [...], contentEl }
function createCardDOM(config) {
  const el = document.createElement('div');
  el.className = 'terminal-3d';
  el.dataset.session = config.id;
  el.dataset.cardType = config.type || 'terminal';

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
  const nameEl = document.createElement('span');
  nameEl.className = 'session-name';
  nameEl.textContent = config.title || config.id;
  header.appendChild(nameEl);

  // Controls inside the header — shown when focused
  const controls = document.createElement('span');
  controls.className = 'header-controls';
  controls.style.display = 'none';
  const mkHdrBtn = function(label, title, fn) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', function(ev) { ev.stopPropagation(); ev.preventDefault(); fn(); });
    return btn;
  };
  // Add custom controls from config
  if (config.controls) {
    for (const ctrl of config.controls) {
      controls.appendChild(mkHdrBtn(ctrl.label, ctrl.title, ctrl.fn));
    }
  }
  // Minimize is always available
  controls.appendChild(mkHdrBtn('⌊', 'Minimize', function() {
    removeFromFocus(config.id);
  }));
  header.appendChild(controls);
  inner.appendChild(header);

  // Content area — provided by the caller
  if (config.contentEl) {
    inner.appendChild(config.contentEl);
  }

  el.appendChild(inner);
  return el;
}

// Terminal card
function createTerminalDOM(sessionName) {
  const obj = document.createElement('object');
  obj.type = 'image/svg+xml';
  obj.data = '/terminal.svg?session=' + encodeURIComponent(sessionName);

  return createCardDOM({
    id: sessionName,
    title: sessionName,
    type: 'terminal',
    controls: [
      { label: '−', title: 'Smaller text (more cols)', fn: function() {
        const t = terminals.get(sessionName);
        if (t) {
          const newCols = Math.min(300, (t.screenCols || 80) + 4);
          const newRows = Math.min(100, (t.screenRows || 24) + 2);
          t.sendInput({ type: 'resize', cols: newCols, rows: newRows });
        }
      }},
      { label: '+', title: 'Bigger text (fewer cols)', fn: function() {
        const t = terminals.get(sessionName);
        if (t) {
          const newCols = Math.max(20, (t.screenCols || 80) - 4);
          const newRows = Math.max(5, (t.screenRows || 24) - 2);
          t.sendInput({ type: 'resize', cols: newCols, rows: newRows });
        }
      }},
      { label: '⊡', title: 'Fit terminal to card', fn: function() {
        const t = terminals.get(sessionName);
        if (t) optimizeTermToCard(t);
      }},
      { label: '⊞', title: 'Fit card to terminal', fn: function() {
        const t = terminals.get(sessionName);
        if (t) optimizeCardToTerm(t);
      }}
    ],
    contentEl: obj
  });
}

// Browser card — iframe with URL, proxied to strip X-Frame-Options
function createBrowserDOM(cardId, url) {
  const iframe = document.createElement('iframe');
  // Proxy through our server to strip X-Frame-Options/CSP headers
  iframe.src = '/api/proxy?url=' + encodeURIComponent(url);
  iframe.style.cssText = 'width:100%;border:none;flex:1;min-height:0;border-bottom-left-radius:48px;border-bottom-right-radius:48px;';

  return createCardDOM({
    id: cardId,
    title: url.length > 60 ? url.substring(0, 57) + '...' : url,
    type: 'browser',
    controls: [
      { label: '↻', title: 'Reload', fn: function() { iframe.src = iframe.src; }},
      { label: '↗', title: 'Open in new tab', fn: function() { window.open(url, '_blank'); }},
      { label: '✕', title: 'Close', fn: function() { removeBrowserCard(cardId); }}
    ],
    contentEl: iframe
  });
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

// === Browser Cards ===
function addBrowserCard(url) {
  const cardId = 'browser-' + Date.now().toString(36);
  const cardW = 1280;
  const cardH = 992;

  const dom = createBrowserDOM(cardId, url);
  dom.style.width = cardW + 'px';
  dom.style.height = cardH + 'px';
  const inner = dom.querySelector('.terminal-inner');
  if (inner) {
    inner.style.width = cardW + 'px';
    inner.style.height = cardH + 'px';
  }

  const shadowDiv = createShadowDOM();
  const css3dObj = new CSS3DObject(dom);
  css3dObj.scale.setScalar(0.25);
  // No random rotation — face camera from spawn (consistent with terminal cards)
  terminalGroup.add(css3dObj);
  dom.style.pointerEvents = 'auto';

  const shadowObj = new CSS3DObject(shadowDiv);
  shadowObj.rotation.x = -Math.PI / 2;
  shadowGroup.add(shadowObj);

  // Create thumbnail for browser card
  const thumb = document.createElement('div');
  thumb.className = 'thumbnail-item';
  thumb.dataset.session = cardId;
  const thumbLabel = document.createElement('div');
  thumbLabel.className = 'thumb-label';
  thumbLabel.textContent = url.length > 30 ? url.substring(0, 27) + '...' : url;
  thumb.appendChild(thumbLabel);
  const thumbMinBtn = document.createElement('div');
  thumbMinBtn.className = 'thumb-minimize';
  thumbMinBtn.textContent = '⌊';
  thumbMinBtn.title = 'Remove from focus group';
  thumbMinBtn.style.display = 'none';
  thumbMinBtn.addEventListener('click', function(ev) {
    ev.stopPropagation();
    removeFromFocus(cardId);
  });
  thumb.appendChild(thumbMinBtn);
  thumb.addEventListener('click', function(ev) {
    if (ev.ctrlKey || ctrlHeld) {
      addToFocus(cardId);
    } else {
      focusTerminal(cardId);
    }
  });
  document.getElementById('sidebar').appendChild(thumb);

  terminals.set(cardId, {
    css3dObject: css3dObj,
    shadowObject: shadowObj,
    shadowDiv: shadowDiv,
    dom: dom,
    thumbnail: thumb,
    baseCardW: cardW,
    baseCardH: cardH,
    currentPos: { x: 0, y: 0, z: -500 },
    targetPos: { x: 0, y: 0, z: -500 },
    morphStart: clock.getElapsedTime(),
    morphFrom: { x: 0, y: 0, z: -500 },
    billboardArrival: null,
    inputWs: null,
    scrollOffset: 0,
    screenLines: [],
    screenCols: 80,
    screenRows: 24,
    sendInput: function() {}, // browser cards don't send terminal input
    scrollBy: function() {},
    _lastCursor: null,
    url: url
  });

  sessionOrder.push(cardId);
  assignRings();

  // Add browser card to the current focus group (don't replace existing focus)
  addToFocus(cardId);

  return cardId;
}

function removeBrowserCard(cardId) {
  const t = terminals.get(cardId);
  if (!t) return;
  terminalGroup.remove(t.css3dObject);
  shadowGroup.remove(t.shadowObject);
  if (t.thumbnail) t.thumbnail.remove();
  terminals.delete(cardId);
  const idx = sessionOrder.indexOf(cardId);
  if (idx >= 0) sessionOrder.splice(idx, 1);
  focusedSessions.delete(cardId);
  if (activeInputSession === cardId) activeInputSession = null;
  if (focusedSessions.size === 0) unfocusTerminal();
  assignRings();
}

// Expose globally so terminal.svg alt+click can call it
window._addBrowserCard = addBrowserCard;

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
      if (!currentNames.has(name) && !name.startsWith('browser-')) {
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
// Target world-space area — same visual weight as original 320×248 card.
// Cards are sized from tmux cols/rows (via SVG_CELL_W/H), NOT hardcoded to 1280×992.
// Hardcoding caused letterboxing and aspect mismatch when terminals had non-standard
// dimensions. See PRD §5.1 and §9 (anti-pattern: "Hardcoded 1280×992 for all cards").
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
  // Always update base values so unfocus restores to correct size
  const { cardW, cardH } = calcCardSize(newCols, newRows);
  t.baseCardW = cardW;
  t.baseCardH = cardH;
  // When focused: don't reshape the card. +/- changes font size inside the same card.
  // The card is the user's chosen window — only explicit actions (alt+drag, ⊞) change it.
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
  // NOTE: Previously cards spawned with random 3D angles for a fly-in rotation effect.
  // Removed because it caused unpredictable bouncing/overshooting when focusing terminals.
  // The effect was visually nice but too hard to control — terminals would fly too far back
  // or off-screen. Can be re-added later with more careful tuning of the slerp parameters.
  // For now, cards face the camera from the start.
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
// Old floating controls bar removed — controls are now inline in each card's header.
let _controlsBar = null; // kept as null, never created
let _controlsSession = null;

// Controls are now inline in each card's header — no floating overlay needed.
function showTermControls(sessionName) { _controlsSession = sessionName; }
function hideTermControls() { _controlsSession = null; }
function updateControlsPosition() { /* no-op — controls are inside the card */ }

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
          return { text: l.spans.map(function(s) { return s.text; }).join(''), spans: l.spans };
        });
        updateCardForNewSize(t, msg.width || 80, msg.height || 24);
        if (msg.cursor) t._lastCursor = msg.cursor;
      } else if (msg.type === 'delta' && msg.changed) {
        for (const [idx, lineData] of Object.entries(msg.changed)) {
          const spans = lineData.spans || lineData;
          t.screenLines[parseInt(idx)] = { text: spans.map(function(s) { return s.text; }).join(''), spans: spans };
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

  // CAMERA-ONLY FOCUS (See PRD §2.2): card stays at base size, camera moves close
  // enough to fill the viewport. No DOM resize, no inner scale transform, no state
  // to restore. The abandoned DOM-resize approach required every feature (alt+drag,
  // +/-, optimize, unfocus) to branch on focus state — they all fought each other.
  const worldW = (t.baseCardW || 1280) * 0.25;
  const worldH = (t.baseCardH || 992) * 0.25;

  const vFov = camera.fov * DEG2RAD;
  const halfTan = Math.tan(vFov / 2);

  // Calculate camera distance where card fills ~90% of viewport height
  const targetScreenFrac = 0.90;
  const camDist = worldH / (targetScreenFrac * 2 * halfTan);

  // Offset for sidebar (card at origin, camera shifted so card centers in usable area)
  const visHAtDist = 2 * camDist * halfTan;
  const px2w = visHAtDist / window.innerHeight;

  cameraTween = {
    from: camera.position.clone(),
    to: new THREE.Vector3(0, 0, camDist),
    lookFrom: currentLookTarget.clone(),
    lookTo: new THREE.Vector3(0, 0, 0),
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

  // Camera-only: no DOM to restore. Cards are always at base size.

  focusedSessions.add(sessionName);
  activeInputSession = sessionName;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  t.inputWs = new WebSocket(proto + '//' + location.host + '/ws/terminal?session=' + encodeURIComponent(sessionName) + '&pane=0');
  t.inputWs.onmessage = function(e) {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'screen' && msg.lines) {
        t.screenLines = msg.lines.map(function(l) {
          return { text: l.spans.map(function(s) { return s.text; }).join(''), spans: l.spans };
        });
        updateCardForNewSize(t, msg.width || 80, msg.height || 24);
        if (msg.cursor) t._lastCursor = msg.cursor;
      } else if (msg.type === 'delta' && msg.changed) {
        for (const [idx, lineData] of Object.entries(msg.changed)) {
          const spans = lineData.spans || lineData;
          t.screenLines[parseInt(idx)] = { text: spans.map(function(s) { return s.text; }).join(''), spans: spans };
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
// Standard "reading distance" Z — active card slides forward to this depth
// relative to camera, so text is always the same readable size.
// Z-CREEP BUG: Without deleting _savedZ on deselect, each select/deselect cycle adds
// READING_Z_OFFSET to the card's Z. _savedZ must capture the pre-slide Z and be
// deleted on deselect so the next select starts from the restored position. See PRD §7.4.
const READING_Z_OFFSET = 25; // subtle forward slide — just enough to layer in front

function setActiveInput(sessionName) {
  if (!focusedSessions.has(sessionName)) return;
  const prevActive = activeInputSession;
  activeInputSession = sessionName;
  updateFocusStyles();
  document.getElementById('input-target').textContent = sessionName;
  showTermControls(sessionName);

  // Slide previous active card back to where it was before the Z slide
  if (prevActive && prevActive !== sessionName) {
    const prevT = terminals.get(prevActive);
    if (prevT && prevT._savedZ !== undefined) {
      prevT.targetPos.z = prevT._savedZ;
      prevT.morphFrom = { ...prevT.currentPos };
      prevT.morphStart = clock.getElapsedTime();
      // Keep current position, just slide Z
      delete prevT._savedZ;
    }
  }

  // Slide new active card forward — only in MULTI-FOCUS mode to distinguish
  // the active input terminal from others. In single focus, the terminal is
  // already centered — no Z slide needed.
  const t = terminals.get(sessionName);
  if (t && focusedSessions.size > 1) {
    if (t._savedZ === undefined) {
      t._savedZ = t.targetPos.z;
      t.targetPos.z += READING_Z_OFFSET;
      t.morphFrom = { ...t.currentPos };
      t.morphStart = clock.getElapsedTime();
    }
  }
}

// Update CSS classes for all terminals based on focus state.
// ACTIVE INDICATOR uses header background (#4a4020), NOT a border on .terminal-3d.
// A CSS border or box-shadow on the root element under matrix3d triggers Chrome to
// re-rasterize the card, causing visible text sharpness mutation on focus switch. See PRD §7.3.
function updateFocusStyles() {
  for (const [name, term] of terminals) {
    term.dom.classList.remove('faded', 'focused', 'input-active');
    if (term.thumbnail) term.thumbnail.classList.remove('active');

    // Show/hide minimize button on thumbnail
    const minBtn = term.thumbnail ? term.thumbnail.querySelector('.thumb-minimize') : null;
    if (minBtn) minBtn.style.display = (focusedSessions.has(name) && focusedSessions.size > 1) ? 'block' : 'none';

    // Show/hide header controls
    const hdrControls = term.dom.querySelector('.header-controls');
    if (hdrControls) hdrControls.style.display = focusedSessions.has(name) ? 'inline-flex' : 'none';

    if (focusedSessions.size > 0) {
      if (focusedSessions.has(name)) {
        term.dom.classList.add('focused');
        if (term.thumbnail) term.thumbnail.classList.add('active');
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
  term._userPositioned = false;
  // Card was never changed during focus — nothing to restore.
  // Just morph position back to ring.
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
  }
  // Always update controls — even if a non-active terminal was removed,
  // the controls bar must follow the active session, not the removed one
  showTermControls(activeInputSession);

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

// DESELECT vs UNFOCUS — two distinct operations (See PRD §4.1):
// deselectTerminals(): removes keyboard input and active highlight, but cards stay
//   at their current positions and focusedSessions stays intact. Camera does not move.
//   Triggered by clicking empty space. Escape from deselected state calls unfocusTerminal.
// unfocusTerminal(): returns all cards to the ring, clears focusedSessions, flies
//   camera back to HOME_POS. The old bug was calling focusedSessions.clear() inside
//   deselectTerminals — cards immediately flew to the ring on every empty-space click.
function deselectTerminals() {
  // Slide active card back to its pre-slide Z, then clear saved state
  if (activeInputSession) {
    const t = terminals.get(activeInputSession);
    if (t && t._savedZ !== undefined) {
      t.targetPos.z = t._savedZ;
      t.morphFrom = { ...t.currentPos };
      t.morphStart = clock.getElapsedTime();
      delete t._savedZ;
    }
  }
  // Clear all _savedZ to prevent accumulation
  for (const [name, term] of terminals) {
    delete term._savedZ;
  }
  activeInputSession = null;
  _zoomedSession = null;
  // Remove input/highlight indicators but keep focusedSessions intact.
  // Cards stay where they are — the animation loop keeps them at their targetPos
  // because they're still in focusedSessions.
  for (const [name, term] of terminals) {
    term.dom.classList.remove('input-active');
    term.dom.classList.remove('faded'); // show ring cards normally
    const hdrCtrl = term.dom.querySelector('.header-controls');
    if (hdrCtrl) hdrCtrl.style.display = 'none';
  }
  // Close WebSocket connections (no longer receiving input)
  for (const fname of focusedSessions) {
    const ft = terminals.get(fname);
    if (ft && ft.inputWs) {
      ft.inputWs.close();
      ft.inputWs = null;
    }
  }
  hideTermControls();
  document.getElementById('input-bar').classList.remove('visible');
}

// Full unfocus: return cards to ring, camera to home position.
function unfocusTerminal() {
  restoreAllFocused();
  activeInputSession = null;
  _zoomedSession = null;
  const now = clock.getElapsedTime();

  for (const [name, term] of terminals) {
    term.dom.classList.remove('faded', 'focused', 'input-active');
    term.thumbnail.classList.remove('active');
    const minBtn = term.thumbnail.querySelector('.thumb-minimize');
    if (minBtn) minBtn.style.display = 'none';
    const hdrCtrl = term.dom.querySelector('.header-controls');
    if (hdrCtrl) hdrCtrl.style.display = 'none';
  }
  hideTermControls();

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

  // Ease ring Z offset — smoothly push back during focus, smoothly return on unfocus
  const ringZTarget = focusedSessions.size > 0 ? RING_Z_BACK : 0;
  ringZOffset += (ringZTarget - ringZOffset) * 0.05;

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

      // Ease ring behind focused cards (ringZOffset transitions smoothly)
      ringPos.z += ringZOffset;

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
    // NOTE: Previously had complex fly-in rotation (focusQuatFrom slerp, billboardArrival
    // tracking, ramped slerp during morph). Removed because it caused unpredictable
    // bouncing when focusing terminals. Simplified to: focused = face camera,
    // unfocused = gentle billboard with drift. Can be re-added with careful tuning.
    if (focusedSessions.has(name)) {
      // Focused: face camera directly
      t.css3dObject.quaternion.copy(camera.quaternion);
    } else {
      // Unfocused: billboard toward camera with gentle drift
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

      t.css3dObject.quaternion.slerp(_targetQuat, BILLBOARD_SLERP);
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

  // Shift+Tab: cycle focused terminals (handled by onKeyDown)
  if (e.key === 'Tab' && e.shiftKey && focusedSessions.size > 1) return;

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

function getSelOverlay(t) {
  // Selection overlay lives INSIDE the SVG document as a <g> layer.
  // This ensures zero subpixel drift — the overlay rects use the exact same
  // coordinate space as the text elements. Previous approaches (position:fixed
  // on document.body, position:absolute on .terminal-inner) both drifted
  // because CSS pixel rounding differs from SVG's internal rendering pipeline.
  if (!t || !t.dom) return null;
  const obj = t.dom.querySelector('object');
  if (!obj || !obj.contentDocument) return null;
  const svgDoc = obj.contentDocument;
  let layer = svgDoc.getElementById('sel-layer');
  if (!layer) {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    layer = svgDoc.createElementNS(SVG_NS, 'g');
    layer.setAttribute('id', 'sel-layer');
    const svgRoot = svgDoc.getElementById('root');
    if (svgRoot) svgRoot.appendChild(layer);
  }
  return layer;
}

function getTermRenderInfo(t) {
  // Calculate the rendered SVG area dimensions for a terminal.
  // Returns both screen-space coords (for mouse mapping) and card-local coords
  // (for positioning elements inside .terminal-inner).
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

  // Card-local coordinates: object's position within .terminal-inner
  // The SVG uses integer y positions (row * floor(CELL_H)). To avoid cumulative
  // subpixel drift, store the scale factor so callers can compute positions as
  // floor(row * svgCellH) * scale — matching the SVG's actual rounding.
  const header = t.dom.querySelector('header');
  const headerH = header ? header.offsetHeight : 0;
  const svgScale = obj.offsetWidth / svgW;

  // Read the SVG's actual cell height from row spacing (integer, e.g. 17)
  let svgCellH = svgH / rows;
  let svgCellW = svgW / cols;
  try {
    const svgDoc = obj.contentDocument;
    if (svgDoc) {
      const r0 = svgDoc.getElementById('r0');
      const r1 = svgDoc.getElementById('r1');
      if (r0 && r1) {
        svgCellH = parseFloat(r1.getAttribute('y')) - parseFloat(r0.getAttribute('y'));
      }
    }
  } catch (err) {}

  return {
    // Screen-space (for mouse event mapping)
    left: rect.left + offsetX,
    top: rect.top + offsetY,
    cellW: renderW / cols,
    cellH: renderH / rows,
    cols, rows,
    // Card-local (for position:absolute inside .terminal-inner)
    localLeft: 0,
    localTop: headerH,
    localCellW: svgCellW * svgScale,
    localCellH: svgCellH * svgScale,
    svgCellH,
    svgCellW,
    svgScale
  };
}

function screenToCell(e, t) {
  // Map screen coordinates to terminal row/col.
  // The SVG is inside an <object> with pointer-events:none, so we can't use
  // SVG's native coordinate transforms directly. Instead use the object's
  // bounding rect (screen-space) to get relative position, then the SVG's
  // getScreenCTM to map to viewBox coordinates. This accounts for CSS3D
  // transforms since getBoundingClientRect reflects the final rendered position.
  const obj = t.dom ? t.dom.querySelector('object') : null;
  if (obj && obj.contentDocument) {
    try {
      const svgDoc = obj.contentDocument;
      const svgRoot = svgDoc.getElementById('root');
      const r0 = svgDoc.getElementById('r0');
      const r1 = svgDoc.getElementById('r1');
      if (svgRoot && r0 && r1) {
        const objRect = obj.getBoundingClientRect();
        if (objRect.width > 10) {
          // Proportional mapping: screen position → 0-1 fraction → SVG viewBox
          const fracX = (e.clientX - objRect.left) / objRect.width;
          const fracY = (e.clientY - objRect.top) / objRect.height;
          const vb = svgRoot.getAttribute('viewBox').split(/\s+/);
          const vbW = parseFloat(vb[2]);
          const vbH = parseFloat(vb[3]);
          const svgX = fracX * vbW;
          const svgY = fracY * vbH;
          const cellH = parseFloat(r1.getAttribute('y')) - parseFloat(r0.getAttribute('y'));
          const cols = t.screenCols || Math.round(vbW / 8.6);
          const cellW = vbW / cols;
          const rows = Math.round(vbH / cellH);
          const row = Math.floor(svgY / cellH);
          const col = Math.floor(svgX / cellW);
          return {
            row: Math.max(0, Math.min(row, rows - 1)),
            col: Math.max(0, Math.min(col, cols - 1)),
            _render: { cols, rows }
          };
        }
      }
    } catch (err) {}
  }

  // Fallback: bounding rect approach
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
  const layer = getSelOverlay(t);
  if (!layer) return;
  while (layer.firstChild) layer.removeChild(layer.firstChild);
  if (!selStart || !selEnd || !t) return;

  const obj = t.dom.querySelector('object');
  if (!obj || !obj.contentDocument) return;
  const svgDoc = obj.contentDocument;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Read cell dimensions directly from SVG text elements — same coordinates
  const r0 = svgDoc.getElementById('r0');
  const r1 = svgDoc.getElementById('r1');
  if (!r0 || !r1) return;
  const cellH = parseFloat(r1.getAttribute('y')) - parseFloat(r0.getAttribute('y'));

  const svgRoot = svgDoc.getElementById('root');
  const vb = svgRoot.getAttribute('viewBox').split(/\s+/);
  const vbW = parseFloat(vb[2]);
  const cols = t.screenCols || Math.round(vbW / 8.6);
  const cellW = vbW / cols;

  // Normalize direction
  let s = selStart, en = selEnd;
  if (s.row > en.row || (s.row === en.row && s.col > en.col)) {
    s = selEnd; en = selStart;
  }

  for (let row = s.row; row <= en.row; row++) {
    const c1 = (row === s.row) ? s.col : 0;
    const c2 = (row === en.row) ? en.col : cols - 1;
    const rect = svgDoc.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', (c1 * cellW).toFixed(2));
    rect.setAttribute('y', row * cellH);
    rect.setAttribute('width', ((c2 - c1 + 1) * cellW).toFixed(2));
    rect.setAttribute('height', cellH);
    rect.setAttribute('fill', 'rgba(92,92,255,0.3)');
    layer.appendChild(rect);
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
    const lineObj = t.screenLines[row];
    const line = (typeof lineObj === 'string') ? lineObj : (lineObj ? lineObj.text : '');
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

// Move the terminal cursor to a clicked position using Left/Right arrow keys.
// In shell prompts (bash/readline), the cursor is a linear position in the input
// buffer. Left/Right wraps across visual line boundaries. So to move from one
// visual row to another, we just count the total Left or Right presses needed:
//   total offset = (cursorRow - targetRow) * cols + (cursorCol - targetCol)
// Positive = go Left, negative = go Right.
// Sends keys with small delays to avoid dropped keystrokes.
function moveCursorTo(t, cursorPos, targetPos) {
  // Get terminal cols for line-width calculation
  const cols = t.screenCols || 80;

  // Linear offset: how many characters between cursor and target
  // treating the screen as wrapped text
  const cursorLinear = cursorPos.y * cols + cursorPos.x;
  const targetLinear = targetPos.row * cols + targetPos.col;
  const delta = cursorLinear - targetLinear;

  if (delta === 0) return;

  const key = delta > 0 ? 'Left' : 'Right';
  const steps = Math.min(Math.abs(delta), 200); // cap to avoid flooding

  // Send as a batch of special keys in one WebSocket message.
  // Individual messages with 5ms delays were dropping keystrokes.
  t.sendInput({ type: 'input', specialKey: key, repeat: steps });
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
  // Don't start text selection on any focused card's header — that's for title bar drag.
  // Same CSS3D constraint as onMouseDown: e.target.closest is 2D and ignores Z depth.
  // A header on a background card can match even if it's visually behind another card.
  // Coordinate check against getBoundingClientRect is the correct approach. See PRD §6.3.
  // Instead check if click coordinates are within any focused card's header rect.
  for (const fname of focusedSessions) {
    const ft = terminals.get(fname);
    if (!ft) continue;
    const hdr = ft.dom.querySelector('header');
    if (!hdr) continue;
    const hr = hdr.getBoundingClientRect();
    if (e.clientX >= hr.left && e.clientX <= hr.right && e.clientY >= hr.top && e.clientY <= hr.bottom) return;
  }
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
    // Just a click, not a drag — try to move cursor to clicked position.
    // Fetch current cursor from server (more reliable than _lastCursor which
    // depends on inputWs having received a screen/delta event).
    if (selStart && activeInputSession) {
      const t = terminals.get(activeInputSession);
      if (t) {
        const clickedCell = selStart;
        fetch('/api/pane?session=' + encodeURIComponent(activeInputSession) + '&pane=0')
          .then(r => r.json())
          .then(data => {
            if (data && data.cursor) {
              moveCursorTo(t, data.cursor, clickedCell);
            }
          })
          .catch(() => {});
      }
    }
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

// Debug: export current layout state to console for sharing
// === Browser Profile ===
// Each browser gets a UID stored in localStorage. Layout auto-saves to server.
// Share layout via URL: ?profile=<uid>
(function() {
  let _uid = localStorage.getItem('svg-terminal-uid');
  if (!_uid) {
    _uid = 'browser-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    localStorage.setItem('svg-terminal-uid', _uid);
  }
  // Check URL for shared profile
  const urlUid = new URLSearchParams(location.search).get('profile');
  const activeUid = urlUid || _uid;

  window._getLayoutState = function() {
    const state = {
      uid: activeUid,
      timestamp: Date.now(),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      userAgent: navigator.userAgent.slice(0, 80),
      camera: {
        x: parseFloat(camera.position.x.toFixed(2)),
        y: parseFloat(camera.position.y.toFixed(2)),
        z: parseFloat(camera.position.z.toFixed(2)),
        fov: camera.fov
      },
      focused: [...focusedSessions],
      activeInput: activeInputSession,
      cards: {}
    };
    for (const [name, t] of terminals) {
      const r = t.dom.getBoundingClientRect();
      const h = t.dom.querySelector('header')?.getBoundingClientRect();
      state.cards[name] = {
        domW: parseInt(t.dom.style.width) || 0,
        domH: parseInt(t.dom.style.height) || 0,
        baseW: t.baseCardW, baseH: t.baseCardH,
        cols: t.screenCols, rows: t.screenRows,
        screen: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        header: h ? { x: Math.round(h.x), y: Math.round(h.y), w: Math.round(h.width), h: Math.round(h.height) } : null,
        focused: focusedSessions.has(name),
        worldPos: {
          x: parseFloat(t.currentPos.x.toFixed(2)),
          y: parseFloat(t.currentPos.y.toFixed(2)),
          z: parseFloat((t.targetPos.z || 0).toFixed(2))
        }
      };
    }
    return state;
  };

  window._saveLayout = function() {
    const state = window._getLayoutState();
    fetch('/api/layout?uid=' + encodeURIComponent(activeUid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    }).then(r => r.json()).then(d => console.log('Layout saved:', activeUid));
    return state;
  };

  window._getShareUrl = function() {
    const url = location.origin + location.pathname + '?profile=' + encodeURIComponent(activeUid);
    console.log('Share URL:', url);
    return url;
  };

  // Auto-save on focus changes
  const origUpdateFocusStyles = updateFocusStyles;
  // Save layout periodically when focused (every 10s)
  setInterval(function() {
    if (focusedSessions.size > 0) window._saveLayout();
  }, 10000);

  console.log('Browser UID:', _uid, urlUid ? '(viewing profile: ' + urlUid + ')' : '');
})();
