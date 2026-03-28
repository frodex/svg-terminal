// dashboard.mjs — 3D Terminal Dashboard with Ring Layout
import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { easeInOutCubic, lerpPos } from './polyhedra.mjs';

// Oscillate between from and to using sine wave. Speed 0 = static at from.
// Exact function from ring-mega-saved.html design studio.
function osc(from, to, speed, time) {
  if (speed === 0) return from;
  var t = (Math.sin(time * speed * 0.05) + 1) / 2;
  return from + (to - from) * t;
}

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
// === Constants ===
const LIGHT_DIR = new THREE.Vector3(-0.7, 0.7, -0.3).normalize();
const FLOOR_Y = -300;
const MORPH_DURATION = 1.5;
const BILLBOARD_SLERP = 0.08;
const SIDEBAR_WIDTH = 140;
const FOCUS_DIST = 350;

// Camera position — closer to match original visual density
const HOME_POS = new THREE.Vector3(-15, 20, 900);
const HOME_TARGET = new THREE.Vector3(-15, 0, 0);

// === State ===
let scene, camera, renderer;
let terminalGroup, shadowGroup;
const terminals = new Map();
let sessionOrder = [];
let focusedSession = null;
let focusedSessions = new Set();
let activeInputSession = null;
const clock = new THREE.Clock();

// Ring state
let outerAngle = 0, innerAngle = 0;
let ringAssignments = { outer: [], inner: [] };

// Mouse state
let isMouseActive = false;
let lastMouseMove = 0;
let isDragging = false;
let dragMode = null; // 'orbit' | 'dollyXY' | 'rotateOrigin'
let dragStart = { x: 0, y: 0 };
let dragDistance = 0;
let ctrlHeld = false;
let suppressNextClick = false;
let lastAddToFocusTime = 0;
let mouseDownOnSidebar = false;
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
// Arrange focused terminals in a grid pattern that maximizes screen space:
// 1=center, 2=side-by-side, 3=triangle, 4=2x2, 5+=grid
function calculateFocusedLayout() {
  const now = clock.getElapsedTime();
  const count = focusedSessions.size;
  if (count === 0) return;

  // Grid dimensions
  const cols = Math.ceil(Math.sqrt(count * (window.innerWidth / window.innerHeight)));
  const rows = Math.ceil(count / cols);

  // Card world size and spacing
  const cardW = 320;
  const cardH = 248;
  const gap = 30;
  const totalW = cols * cardW + (cols - 1) * gap;
  const totalH = rows * cardH + (rows - 1) * gap;

  let idx = 0;
  const names = [...focusedSessions];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (idx >= count) break;
      const name = names[idx];
      const t = terminals.get(name);
      if (!t) { idx++; continue; }

      t.morphFrom = { ...t.currentPos };
      t.targetPos = {
        x: (col - (cols - 1) / 2) * (cardW + gap),
        y: ((rows - 1) / 2 - row) * (cardH + gap),
        z: 0
      };
      t.morphStart = now;
      t.focusQuatFrom = t.css3dObject.quaternion.clone();
      idx++;
    }
  }

  // Camera distance: pull back enough to see the whole grid
  const vFov = camera.fov * DEG2RAD;
  const distForH = (totalH / 2) / Math.tan(vFov / 2) * 1.15;
  const distForW = (totalW / 2) / (Math.tan(vFov / 2) * camera.aspect) * 1.15;
  const dist = Math.max(FOCUS_DIST, Math.max(distForH, distForW));

  const vFovH = 2 * dist * Math.tan(vFov / 2);
  const pxToWorld = vFovH / window.innerHeight;
  const offX = (SIDEBAR_WIDTH / 2) * pxToWorld;

  cameraTween = {
    from: camera.position.clone(),
    to: new THREE.Vector3(offX, 0, dist),
    lookFrom: currentLookTarget.clone(),
    lookTo: new THREE.Vector3(offX, 0, 0),
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

  refreshSessions();
  setInterval(refreshSessions, 5000);
  setInterval(refreshTitles, 10000);
  animate();
}

const RENDER_SCALE = 2;
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth * RENDER_SCALE, window.innerHeight * RENDER_SCALE);
}

// === Mouse ===
function onMouseMove(e) {
  isMouseActive = true;
  lastMouseMove = performance.now();

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

    if (dragMode === 'orbit') {
      // Orbit camera around its look target at current distance
      orbitAngle -= dx * 0.005;
      orbitPitch = Math.max(-1.2, Math.min(1.2, orbitPitch - dy * 0.005));
      updateCameraOrbit();

    } else if (dragMode === 'dollyXY') {
      // Shift+drag: translate camera + target in screen-aligned X/Y
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      camera.getWorldDirection(_worldPos);
      right.crossVectors(_worldPos, _up).normalize();
      up.crossVectors(right, _worldPos).normalize();
      const scale = orbitDist * 0.002;
      const offset = right.multiplyScalar(-dx * scale).add(up.multiplyScalar(dy * scale));
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
      const rotY = new THREE.Matrix4().makeRotationY(-dx * 0.005);
      const rotX = new THREE.Matrix4().makeRotationX(-dy * 0.005);
      offset.applyMatrix4(rotY).applyMatrix4(rotX);
      camera.position.copy(origin).add(offset);
      currentLookTarget.copy(origin);
      camera.lookAt(currentLookTarget);
    }
  }
}

function onMouseDown(e) {
  const sidebar = document.getElementById('sidebar');
  mouseDownOnSidebar = sidebar && sidebar.contains(e.target);
  if (e.button === 0) {
    if (e.ctrlKey) {
      // Don't commit to rotateOrigin yet — could be ctrl+click for multi-focus
      isDragging = true;
      dragMode = 'ctrlPending';
      dragDistance = 0;
      dragStart.x = e.clientX;
      dragStart.y = e.clientY;
      // No preventDefault — let click event fire for ctrl+click
    } else if (e.shiftKey) {
      isDragging = true;
      dragMode = 'dollyXY';
      dragStart.x = e.clientX;
      dragStart.y = e.clientY;
      e.preventDefault();
    } else {
      // Plain left drag: orbit
      isDragging = true;
      dragMode = 'orbit';
      dragDistance = 0;
      syncOrbitFromCamera();
      dragStart.x = e.clientX;
      dragStart.y = e.clientY;
      e.preventDefault();
    }
  } else if (e.button === 1) {
    // Middle button: pan
    isDragging = true;
    dragMode = 'dollyXY';
    dragStart.x = e.clientX;
    dragStart.y = e.clientY;
    e.preventDefault();
  } else if (e.button === 2) {
    // Right button: orbit
    isDragging = true;
    dragMode = 'orbit';
    dragStart.x = e.clientX;
    dragStart.y = e.clientY;
    syncOrbitFromCamera();
    e.preventDefault();
  }
}

document.addEventListener('contextmenu', function(e) { e.preventDefault(); });

function onMouseUp(e) {
  if (e.button === 0 && dragDistance <= 5) {
    if (dragMode === 'ctrlPending' || ctrlHeld) {
      // Ctrl+click on 3D scene — skip if click was on sidebar (thumbnail handles it)
      if (!mouseDownOnSidebar) {
        handleCtrlClick(e);
      }
      suppressNextClick = true;
      isDragging = false;
      dragMode = null;
      return;
    }
  }
  isDragging = false;
  dragMode = null;
}

function handleCtrlClick(e) {
  let clicked = null;
  let closestZ = -Infinity;
  for (const [name, t] of terminals) {
    if (focusedSessions.has(name)) continue; // skip already-focused
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
  isMouseActive = false;
  isDragging = false;
  dragMode = null;
}

function toggleHelp() {
  const panel = document.getElementById('help-panel');
  panel.classList.toggle('visible');
}

document.addEventListener('keydown', function(e) { if (e.key === 'Control') ctrlHeld = true; });
document.addEventListener('keyup', function(e) { if (e.key === 'Control') ctrlHeld = false; });
window.addEventListener('blur', function() { ctrlHeld = false; });

function onKeyDown(e) {
  if (e.key === 'Escape') {
    const panel = document.getElementById('help-panel');
    if (panel.classList.contains('visible')) {
      panel.classList.remove('visible');
    } else if (focusedSessions.size > 0) {
      unfocusTerminal();
    }
  }
  if (e.key === '?') {
    toggleHelp();
  }
}

function onSceneClick(e) {
  // Ctrl+click is handled entirely in onMouseUp — skip here
  if (suppressNextClick || ctrlHeld || e.ctrlKey) {
    suppressNextClick = false;
    return;
  }
  if (wasDrag()) return;
  if (e.button !== 0) return;
  if (e.shiftKey) return; // shift+click reserved for drag

  let clicked = null;
  let closestZ = -Infinity;
  for (const [name, t] of terminals) {
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
  } else if (focusedSessions.size > 0) {
    unfocusTerminal();
  }
}

function onWheel(e) {
  e.preventDefault();
  const delta = e.deltaY;

  if (e.shiftKey) {
    // Shift+scroll: dolly Z (move camera forward/backward along view direction)
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    camera.position.addScaledVector(dir, -delta * 0.5);
    orbitDist = camera.position.distanceTo(currentLookTarget);
    camera.lookAt(currentLookTarget);
  } else {
    // Scroll: zoom (change FOV)
    camera.fov = Math.max(10, Math.min(120, camera.fov + delta * 0.05));
    camera.updateProjectionMatrix();
  }
}

// Derive orbitAngle/orbitPitch/orbitDist from camera's actual position relative to look target
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

  const obj = document.createElement('object');
  obj.type = 'image/svg+xml';
  obj.data = '/terminal.svg?session=' + encodeURIComponent(sessionName);
  item.appendChild(obj);

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
        addTerminal(session.name);
        changed = true;
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

function addTerminal(sessionName) {
  const dom = createTerminalDOM(sessionName);
  const shadowDiv = createShadowDOM();
  const thumbnail = createThumbnail(sessionName);

  const css3dObj = new CSS3DObject(dom);
  css3dObj.scale.setScalar(0.25);
  // Start tilted so the fly-in shows 3D angle, easing to face-camera on arrival
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
    currentPos: { x: 0, y: 0, z: -500 },
    targetPos: { x: 0, y: 0, z: -500 },
    morphStart: clock.getElapsedTime(),
    morphFrom: { x: 0, y: 0, z: -500 },
    billboardArrival: null  // set when terminal first reaches its ring position
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

// Focus a single terminal (replaces all focused)
function focusTerminal(sessionName) {
  if (performance.now() - lastAddToFocusTime < 200) {
    return;
  }
  const t = terminals.get(sessionName);
  if (!t) return;

  // Restore any previously focused terminals
  restoreAllFocused();

  focusedSessions.add(sessionName);
  focusedSession = sessionName;
  activeInputSession = sessionName;

  updateFocusStyles();

  const now = clock.getElapsedTime();
  t.morphFrom = { ...t.currentPos };
  t.targetPos = { x: 0, y: 0, z: 0 };
  t.morphStart = now;
  t.focusQuatFrom = t.css3dObject.quaternion.clone();

  // 1:1 pixel mapping for single terminal focus
  const vFov = camera.fov * DEG2RAD;
  const visH = 2 * FOCUS_DIST * Math.tan(vFov / 2);
  const pxToWorld = visH / window.innerHeight;
  const offX = (SIDEBAR_WIDTH / 2) * pxToWorld;
  const offY = -(50 / 2) * pxToWorld;

  const worldH = 248;
  const worldW = 320;
  const screenH = Math.round((worldH / visH) * window.innerHeight);
  const screenW = Math.round(screenH * (worldW / worldH));
  const innerScale = screenW / 1280;

  t.dom.style.width = screenW + 'px';
  t.dom.style.height = screenH + 'px';
  t.dom.style.borderRadius = Math.round(48 * innerScale) + 'px';
  const inner = t.dom.querySelector('.terminal-inner');
  if (inner) inner.style.transform = 'scale(' + innerScale + ')';
  t.css3dObject.scale.setScalar(worldH / screenH);

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
      ft.dom.style.width = '';
      ft.dom.style.height = '';
      ft.dom.style.borderRadius = '';
      const inner = ft.dom.querySelector('.terminal-inner');
      if (inner) inner.style.transform = '';
      ft.css3dObject.scale.setScalar(0.25);
    }
  }

  focusedSessions.add(sessionName);
  if (!focusedSession) focusedSession = sessionName;
  activeInputSession = sessionName;

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
}

// Update CSS classes for all terminals based on focus state
function updateFocusStyles() {
  for (const [name, term] of terminals) {
    term.dom.classList.remove('faded', 'focused', 'input-active');
    term.thumbnail.classList.remove('active');

    if (focusedSessions.size > 0) {
      if (focusedSessions.has(name)) {
        term.dom.classList.add('focused');
        term.thumbnail.classList.add('active');
        if (name === activeInputSession && focusedSessions.size > 1) {
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
  const now = clock.getElapsedTime();
  term.dom.classList.remove('faded', 'focused', 'input-active');
  term.dom.style.width = '';
  term.dom.style.height = '';
  term.dom.style.borderRadius = '';
  const inner = term.dom.querySelector('.terminal-inner');
  if (inner) inner.style.transform = '';
  term.css3dObject.scale.setScalar(0.25);
  term.morphFrom = { ...term.currentPos };
  term.morphStart = now;
  term.billboardArrival = null;
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
  focusedSession = null;
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
}

// === Animation Loop ===
function animate() {
  requestAnimationFrame(animate);

  const time = clock.getElapsedTime();
  const delta = clock.getDelta();

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
}

// === Input Bar ===
const inputBox = document.getElementById('input-box');
if (inputBox) {
  inputBox.addEventListener('keydown', async function (e) {
    if (!activeInputSession) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      const text = inputBox.value;
      if (text) {
        await sendKeys(activeInputSession, text);
        inputBox.value = '';
      }
      await sendSpecialKey(activeInputSession, 'Enter');
    } else if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      await sendSpecialKey(activeInputSession, 'C-c');
    } else if (e.ctrlKey && e.key === 'd') {
      e.preventDefault();
      await sendSpecialKey(activeInputSession, 'C-d');
    } else if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      await sendSpecialKey(activeInputSession, 'C-l');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      await sendSpecialKey(activeInputSession, 'Up');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      await sendSpecialKey(activeInputSession, 'Down');
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
      body: JSON.stringify({ session: session, pane: '0', keys: keys })
    });
  } catch (e) {}
}

async function sendSpecialKey(session, key) {
  try {
    await fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: session, pane: '0', specialKey: key })
    });
  } catch (e) {}
}

// === Start ===
init();
