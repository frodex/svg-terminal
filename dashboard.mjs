// dashboard.mjs — 3D Terminal Dashboard (Vision Pro style)
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

// === Constants ===
const LIGHT_DIR = new THREE.Vector3(-0.7, 0.7, -0.3).normalize();
const FLOOR_Y = -200;
const MORPH_DURATION = 1.5;
const BILLBOARD_SLERP = 0.05;
const SIDEBAR_WIDTH = 140;

// Camera positions
const HOME_POS = new THREE.Vector3(-15, 20, 500);
const HOME_TARGET = new THREE.Vector3(-15, 0, 0);
const FOCUS_DIST = 350; // distance from focused terminal

// === State ===
let scene, camera, renderer;
let terminalGroup, shadowGroup;
const terminals = new Map(); // sessionName → terminal state
let sessionOrder = []; // ordered list of session names
let focusedSession = null;
const clock = new THREE.Clock();

// Mouse state
let isMouseActive = false;
let lastMouseMove = 0;
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let orbitAngle = 0; // horizontal orbit angle
let orbitPitch = 0.1; // vertical pitch

// Camera tween
let cameraTween = null; // { from, to, lookFrom, lookTo, start, duration }
let currentLookTarget = HOME_TARGET.clone();

// === Layout: calculate positions for all terminals ===
function calculateLayout() {
  const names = sessionOrder;
  const count = names.length;
  if (count === 0) return;

  const now = clock.getElapsedTime();
  const arcRadius = 180 + count * 12;

  if (focusedSession) {
    // Focused layout: selected terminal at front-center,
    // others in an arc behind it
    const focusedIdx = names.indexOf(focusedSession);
    const others = names.filter(n => n !== focusedSession);

    // Focused terminal: directly in front of camera, at origin
    const ft = terminals.get(focusedSession);
    if (ft) {
      ft.morphFrom = { ...ft.currentPos };
      ft.targetPos = { x: 0, y: 0, z: 0 };
      ft.morphStart = now;
    }

    // Others: arc behind the focused terminal (negative Z = further from camera)
    const arcSpan = Math.min(Math.PI * 0.7, others.length * 0.25);
    for (let i = 0; i < others.length; i++) {
      const t = terminals.get(others[i]);
      if (!t) continue;
      const frac = others.length === 1 ? 0.5 : i / (others.length - 1);
      const angle = (frac - 0.5) * arcSpan;
      t.morphFrom = { ...t.currentPos };
      t.targetPos = {
        x: Math.sin(angle) * arcRadius * 0.6,
        y: 20 + Math.sin(i * 1.3) * 30,
        z: -200 + Math.cos(angle) * 60 // behind origin, visible from camera at z=350
      };
      t.morphStart = now;
    }
  } else {
    // Overview layout: curved wall facing the camera
    // Camera is at z=600, so terminals should be around z=0 to z=200
    // Arc curves away from camera (sides go to lower z values)
    const arcSpan = Math.min(Math.PI * 0.8, count * 0.3);
    const rows = count <= 4 ? 1 : 2;
    const perRow = Math.ceil(count / rows);

    let idx = 0;
    for (let row = 0; row < rows; row++) {
      const rowCount = Math.min(perRow, count - idx);
      const rowY = rows === 1 ? 0 : (row === 0 ? 70 : -80);
      const rowScale = rows === 1 ? 1 : (row === 0 ? 1 : 0.85);

      for (let col = 0; col < rowCount; col++) {
        const name = names[idx];
        const t = terminals.get(name);
        if (!t) { idx++; continue; }

        const frac = rowCount === 1 ? 0.5 : col / (rowCount - 1);
        const angle = (frac - 0.5) * arcSpan * rowScale;

        t.morphFrom = { ...t.currentPos };
        t.targetPos = {
          x: Math.sin(angle) * arcRadius,
          y: rowY,
          z: Math.cos(angle) * arcRadius * 0.3 // slight depth, center closest to camera
        };
        t.morphStart = now;
        idx++;
      }
    }
  }
}

// === Init ===
function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 10000);
  camera.position.copy(HOME_POS);
  camera.lookAt(HOME_TARGET);
  // view offset removed

  renderer = new CSS3DRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.style.position = 'fixed';
  renderer.domElement.style.top = '0';
  renderer.domElement.style.left = '0';
  renderer.domElement.style.zIndex = '1';
  document.body.appendChild(renderer.domElement);

  terminalGroup = new THREE.Group();
  scene.add(terminalGroup);
  shadowGroup = new THREE.Group();
  scene.add(shadowGroup);

  // Events
  window.addEventListener('resize', onResize);
  renderer.domElement.addEventListener('mousemove', onMouseMove);
  renderer.domElement.addEventListener('mousedown', onMouseDown);
  renderer.domElement.addEventListener('mouseup', onMouseUp);
  renderer.domElement.addEventListener('mouseleave', onMouseLeave);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  renderer.domElement.addEventListener('click', onSceneClick);
  document.addEventListener('keydown', onKeyDown);

  refreshSessions();
  setInterval(refreshSessions, 5000);
  setInterval(refreshTitles, 10000);
  animate();
}

// Compute an X offset so content appears centered between left edge and sidebar
function getCenterOffsetX() {
  return -SIDEBAR_WIDTH / 2 * 0.15; // slight shift left in world units
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// === Mouse ===
function onMouseMove(e) {
  isMouseActive = true;
  lastMouseMove = performance.now();

  if (isDragging) {
    const dx = (e.clientX - dragStart.x) * 0.005;
    const dy = (e.clientY - dragStart.y) * 0.003;
    orbitAngle -= dx;
    orbitPitch = Math.max(-0.5, Math.min(0.5, orbitPitch - dy));
    dragStart.x = e.clientX;
    dragStart.y = e.clientY;
    updateCameraOrbit();
  } else if (!focusedSession && cameraTween === null) {
    // Subtle parallax
    const nx = (e.clientX / window.innerWidth - 0.5) * 2;
    const ny = (e.clientY / window.innerHeight - 0.5) * 2;
    camera.position.x = HOME_POS.x + Math.sin(orbitAngle) * HOME_POS.z - nx * 20;
    camera.position.y = HOME_POS.y + orbitPitch * 200 + ny * 15;
    camera.lookAt(currentLookTarget);
  }
}

function onMouseDown(e) {
  // Right-click, middle-click, or Ctrl/Shift+click to orbit
  if (e.button === 1 || e.button === 2) {
    isDragging = true;
    dragStart.x = e.clientX;
    dragStart.y = e.clientY;
    e.preventDefault();
  } else if ((e.ctrlKey || e.shiftKey) && e.button === 0) {
    isDragging = true;
    dragStart.x = e.clientX;
    dragStart.y = e.clientY;
  }
  // Normal left-click passes through to terminal click handlers
}

// Prevent context menu on right-click (we use it for orbit)
document.addEventListener('contextmenu', function(e) { e.preventDefault(); });

function onMouseUp() {
  isDragging = false;
}

function onMouseLeave() {
  isMouseActive = false;
  isDragging = false;
}

function onKeyDown(e) {
  if (e.key === 'Escape' && focusedSession) {
    unfocusTerminal();
  }
}

function onSceneClick(e) {
  // Don't handle if it was a drag
  if (isDragging) return;
  // Don't handle right/middle clicks
  if (e.button !== 0) return;
  // Don't handle ctrl/shift clicks (those are orbit)
  if (e.ctrlKey || e.shiftKey) return;

  // Find which terminal was clicked by checking bounding rects
  let clicked = null;
  let closestZ = -Infinity;
  for (const [name, t] of terminals) {
    const rect = t.dom.getBoundingClientRect();
    if (rect.width < 10) continue; // not visible
    if (e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom) {
      // If multiple overlap, pick the one closest to camera (highest z in screen space)
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
    focusTerminal(clicked);
  } else if (focusedSession) {
    // Clicked on background — unfocus
    unfocusTerminal();
  }
}

function onWheel(e) {
  e.preventDefault();
  const delta = e.deltaY * 0.5;
  if (!focusedSession) {
    HOME_POS.z = Math.max(150, Math.min(800, HOME_POS.z + delta));
    camera.position.z = Math.max(150, Math.min(800, camera.position.z + delta));
    camera.lookAt(currentLookTarget);
  } else {
    // Zoom toward/away from focused terminal — direct, no tween
    camera.position.z = Math.max(100, Math.min(800, camera.position.z + delta));
    camera.lookAt(currentLookTarget);
  }
}

function updateCameraOrbit() {
  const dist = HOME_POS.z;
  camera.position.x = Math.sin(orbitAngle) * dist;
  camera.position.y = HOME_POS.y + orbitPitch * 200;
  camera.position.z = Math.cos(orbitAngle) * dist;
  camera.lookAt(currentLookTarget);
}

// === Terminal DOM ===
function createTerminalDOM(sessionName) {
  const el = document.createElement('div');
  el.className = 'terminal-3d';
  el.dataset.session = sessionName;

  const specular = document.createElement('div');
  specular.className = 'specular-overlay';
  el.appendChild(specular);

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
  el.appendChild(header);

  const obj = document.createElement('object');
  obj.type = 'image/svg+xml';
  obj.data = '/terminal.svg?session=' + encodeURIComponent(sessionName);
  el.appendChild(obj);

  el.addEventListener('click', function () { focusTerminal(sessionName); });
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

  item.addEventListener('click', function () { focusTerminal(sessionName); });
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
    if (changed) calculateLayout();
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
  css3dObj.scale.setScalar(0.5);
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
    currentPos: { x: 0, y: 0, z: -200 },
    targetPos: { x: 0, y: 0, z: -200 },
    morphStart: clock.getElapsedTime(),
    morphFrom: { x: 0, y: 0, z: -200 }
  });

  // Fetch and display the pane title (async, updates when ready)
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
  if (focusedSession === sessionName) unfocusTerminal();
}

// === Focus / Unfocus ===
function focusTerminal(sessionName) {
  const t = terminals.get(sessionName);
  if (!t) return;

  focusedSession = sessionName;

  for (const [name, term] of terminals) {
    if (name !== sessionName) {
      term.dom.classList.add('faded');
    } else {
      term.dom.classList.remove('faded');
      term.dom.classList.add('focused');
    }
    term.thumbnail.classList.toggle('active', name === sessionName);
  }

  calculateLayout();
  // view offset removed // shift center to account for input bar appearing

  // Tween camera to face the focused terminal at origin
  cameraTween = {
    from: camera.position.clone(),
    to: new THREE.Vector3(-20, 20, FOCUS_DIST),
    lookFrom: currentLookTarget.clone(),
    lookTo: new THREE.Vector3(-20, 0, 0),
    start: clock.getElapsedTime(),
    duration: 1.0
  };

  document.getElementById('input-bar').classList.add('visible');
  document.getElementById('input-target').textContent = sessionName;
}

function unfocusTerminal() {
  focusedSession = null;

  for (const [name, term] of terminals) {
    term.dom.classList.remove('faded', 'focused');
    term.thumbnail.classList.remove('active');
  }

  calculateLayout();

  cameraTween = {
    from: camera.position.clone(),
    to: new THREE.Vector3(
      Math.sin(orbitAngle) * HOME_POS.z,
      HOME_POS.y + orbitPitch * 200,
      Math.cos(orbitAngle) * HOME_POS.z
    ),
    lookFrom: currentLookTarget.clone(),
    lookTo: HOME_TARGET.clone(),
    start: clock.getElapsedTime(),
    duration: 1.0
  };

  document.getElementById('input-bar').classList.remove('visible');
  // view offset removed // shift center back (no input bar)
}

// === Animation Loop ===
const _worldPos = new THREE.Vector3();
const _lookAtMat = new THREE.Matrix4();
const _targetQuat = new THREE.Quaternion();
const _driftQuat = new THREE.Quaternion();
const _driftEuler = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);
const _panelNormal = new THREE.Vector3();

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

  // Per-terminal updates
  let idx = 0;
  for (const [name, t] of terminals) {
    // Morph position
    const morphElapsed = time - t.morphStart;
    const morphT = Math.min(1, morphElapsed / MORPH_DURATION);
    const eased = easeInOutCubic(morphT);
    t.currentPos = lerpPos(t.morphFrom, t.targetPos, eased);

    // Add gentle float to non-focused terminals
    let floatY = 0;
    let floatX = 0;
    if (name !== focusedSession) {
      floatY = Math.sin(time * 0.4 + idx * 1.3) * 8;
      floatX = Math.cos(time * 0.3 + idx * 1.7) * 5;
    }

    t.css3dObject.position.set(
      t.currentPos.x + floatX,
      t.currentPos.y + floatY,
      t.currentPos.z
    );

    // Billboarding
    if (focusedSession === name) {
      t.css3dObject.lookAt(camera.position);
    } else {
      // CSS3DObject faces -Z, so lookAt from camera toward terminal (not terminal toward camera)
      t.css3dObject.getWorldPosition(_worldPos);
      _lookAtMat.lookAt(camera.position, _worldPos, _up);
      _targetQuat.setFromRotationMatrix(_lookAtMat);

      _driftEuler.set(
        Math.sin(time * 0.3 + idx * 1.5) * 0.06,
        Math.cos(time * 0.2 + idx * 1.7) * 0.08,
        0
      );
      _driftQuat.setFromEuler(_driftEuler);
      _targetQuat.multiply(_driftQuat);
      t.css3dObject.quaternion.slerp(_targetQuat, BILLBOARD_SLERP);
    }

    // Shadow
    const heightAboveFloor = t.currentPos.y + floatY - FLOOR_Y;
    const absHeight = Math.abs(heightAboveFloor);
    const shadowScale = 1 + absHeight * 0.002;
    const shadowBlur = 15 + absHeight * 0.08;
    const shadowOpacity = Math.max(0.05, 0.25 - absHeight * 0.0008);

    t.shadowObject.position.set(
      t.currentPos.x + floatX + LIGHT_DIR.x * absHeight * 0.2,
      FLOOR_Y,
      t.currentPos.z + LIGHT_DIR.z * absHeight * 0.2
    );
    t.shadowDiv.style.filter = 'blur(' + shadowBlur.toFixed(0) + 'px)';
    t.shadowDiv.style.opacity = shadowOpacity.toFixed(3);
    t.shadowObject.scale.setScalar(shadowScale);

    // Specular
    const specular = t.dom.querySelector('.specular-overlay');
    if (specular) {
      _panelNormal.set(0, 0, 1).applyQuaternion(t.css3dObject.quaternion);
      const dot = _panelNormal.dot(LIGHT_DIR);
      const intensity = Math.max(0, dot) * 0.12;
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
    if (!focusedSession) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      const text = inputBox.value;
      if (text) {
        await sendKeys(focusedSession, text);
        inputBox.value = '';
      }
      await sendSpecialKey(focusedSession, 'Enter');
    } else if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      await sendSpecialKey(focusedSession, 'C-c');
    } else if (e.ctrlKey && e.key === 'd') {
      e.preventDefault();
      await sendSpecialKey(focusedSession, 'C-d');
    } else if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      await sendSpecialKey(focusedSession, 'C-l');
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
