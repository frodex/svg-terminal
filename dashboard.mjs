// dashboard.mjs — 3D Terminal Dashboard
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';
import { CSS3DRenderer, CSS3DObject } from 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/renderers/CSS3DRenderer.js';
import { getVertices, lerpPos, easeInOutCubic, matchPositions } from './polyhedra.mjs';

// === Constants ===
const LIGHT_DIR = new THREE.Vector3(-0.7, 0.7, -0.3).normalize();
const FLOOR_Y = -200;
const ROTATION_SPEED = 0.2;
const MORPH_DURATION = 2.0;
const BILLBOARD_SLERP = 0.03;
const IDLE_TIMEOUT = 3000;
const HOME_POS = new THREE.Vector3(0, 200, 800);
const HOME_TARGET = new THREE.Vector3(0, 0, 0);

// === State ===
let scene, camera, renderer;
let polyhedronGroup, shadowGroup;
const terminals = new Map();
let focusedSession = null;
let isMouseActive = false;
let lastMouseMove = 0;
let rotationResumeProgress = 1;
const clock = new THREE.Clock();

// Camera tween state
let cameraTweenStart = null;
let cameraTweenDuration = 1.0;
let cameraTweenFrom = null;
let cameraTweenTo = null;
let cameraLookFrom = null;
let cameraLookTo = null;
let currentLookTarget = HOME_TARGET.clone();

// === Init ===
function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 10000);
  camera.position.copy(HOME_POS);
  camera.lookAt(HOME_TARGET);

  renderer = new CSS3DRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.style.position = 'fixed';
  renderer.domElement.style.top = '0';
  renderer.domElement.style.left = '0';
  renderer.domElement.style.zIndex = '1';
  document.body.appendChild(renderer.domElement);

  polyhedronGroup = new THREE.Group();
  scene.add(polyhedronGroup);
  shadowGroup = new THREE.Group();
  scene.add(shadowGroup);

  window.addEventListener('resize', onResize);
  renderer.domElement.addEventListener('mousemove', onMouseMove);
  renderer.domElement.addEventListener('mouseleave', onMouseLeave);
  document.addEventListener('keydown', onKeyDown);

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
  rotationResumeProgress = 0;

  if (!focusedSession && cameraTweenStart === null) {
    const nx = (e.clientX / window.innerWidth - 0.5) * 2;
    const ny = (e.clientY / window.innerHeight - 0.5) * 2;
    camera.position.x = HOME_POS.x - nx * 30;
    camera.position.y = HOME_POS.y + ny * 20;
    camera.lookAt(currentLookTarget);
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

    for (const session of sessions) {
      if (!existingNames.has(session.name)) {
        addTerminal(session.name);
      }
    }

    for (const name of existingNames) {
      if (!currentNames.has(name)) {
        removeTerminal(name);
      }
    }
  } catch (e) {
    // Server unreachable
  }
}

// === Add/Remove ===
function addTerminal(sessionName) {
  const dom = createTerminalDOM(sessionName);
  const shadowDiv = createShadowDOM();
  const thumbnail = createThumbnail(sessionName);

  const css3dObj = new CSS3DObject(dom);
  polyhedronGroup.add(css3dObj);

  const shadowObj = new CSS3DObject(shadowDiv);
  shadowObj.rotation.x = -Math.PI / 2;
  shadowGroup.add(shadowObj);

  terminals.set(sessionName, {
    css3dObject: css3dObj,
    shadowObject: shadowObj,
    shadowDiv: shadowDiv,
    dom: dom,
    thumbnail: thumbnail,
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
  const names = Array.from(terminals.keys());
  const count = names.length;
  if (count === 0) return;

  const newVerts = getVertices(count);
  const currentPositions = names.map(function (n) { return terminals.get(n).currentPos; });
  const result = matchPositions(currentPositions, newVerts);
  const now = clock.getElapsedTime();

  for (let i = 0; i < names.length; i++) {
    const t = terminals.get(names[i]);
    const targetIdx = result.mapping[i];
    if (targetIdx !== null && targetIdx >= 0) {
      t.morphFrom = { x: t.currentPos.x, y: t.currentPos.y, z: t.currentPos.z };
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

  for (const [name, term] of terminals) {
    if (name !== sessionName) {
      term.dom.classList.add('faded');
    } else {
      term.dom.classList.remove('faded');
      term.dom.classList.add('focused');
    }
    term.thumbnail.classList.toggle('active', name === sessionName);
  }

  // Camera tween to in front of terminal
  const worldPos = new THREE.Vector3();
  t.css3dObject.getWorldPosition(worldPos);
  const dir = worldPos.clone().normalize();
  if (dir.length() < 0.01) dir.set(0, 0, 1);

  cameraTweenFrom = camera.position.clone();
  cameraLookFrom = currentLookTarget.clone();
  cameraTweenTo = worldPos.clone().add(dir.multiplyScalar(400));
  cameraLookTo = worldPos.clone();
  cameraTweenStart = clock.getElapsedTime();

  // Show input bar
  const inputBar = document.getElementById('input-bar');
  const inputTarget = document.getElementById('input-target');
  inputBar.classList.add('visible');
  inputTarget.textContent = sessionName;
}

function unfocusTerminal() {
  focusedSession = null;

  for (const [name, term] of terminals) {
    term.dom.classList.remove('faded', 'focused');
    term.thumbnail.classList.remove('active');
  }

  cameraTweenFrom = camera.position.clone();
  cameraLookFrom = currentLookTarget.clone();
  cameraTweenTo = HOME_POS.clone();
  cameraLookTo = HOME_TARGET.clone();
  cameraTweenStart = clock.getElapsedTime();

  document.getElementById('input-bar').classList.remove('visible');
  rotationResumeProgress = 0;
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

  // Mouse idle check
  if (isMouseActive && performance.now() - lastMouseMove > IDLE_TIMEOUT) {
    isMouseActive = false;
  }

  // Rotation (attract mode)
  if (!focusedSession && !isMouseActive) {
    if (rotationResumeProgress < 1) {
      rotationResumeProgress = Math.min(1, rotationResumeProgress + delta * 0.5);
    }
    const speed = ROTATION_SPEED * easeInOutCubic(Math.min(1, rotationResumeProgress));
    polyhedronGroup.rotation.y += delta * speed;
    polyhedronGroup.rotation.x = Math.sin(time * 0.1) * 0.05;
  }

  // Camera tween
  if (cameraTweenStart !== null) {
    const elapsed = time - cameraTweenStart;
    const t = Math.min(1, elapsed / cameraTweenDuration);
    const eased = easeInOutCubic(t);

    camera.position.lerpVectors(cameraTweenFrom, cameraTweenTo, eased);
    currentLookTarget.lerpVectors(cameraLookFrom, cameraLookTo, eased);
    camera.lookAt(currentLookTarget);

    if (t >= 1) {
      cameraTweenStart = null;
      // Reset home position for parallax if unfocused
      if (!focusedSession) {
        camera.position.copy(HOME_POS);
        currentLookTarget.copy(HOME_TARGET);
        camera.lookAt(HOME_TARGET);
      }
    }
  }

  // Per-terminal updates
  let idx = 0;
  for (const [name, t] of terminals) {
    // Morph interpolation
    const morphElapsed = time - t.morphStart;
    const morphT = Math.min(1, morphElapsed / MORPH_DURATION);
    const easedMorph = easeInOutCubic(morphT);
    t.currentPos = lerpPos(t.morphFrom, t.targetPos, easedMorph);
    t.css3dObject.position.set(t.currentPos.x, t.currentPos.y, t.currentPos.z);

    // Billboarding
    if (focusedSession === name) {
      t.css3dObject.lookAt(camera.position);
    } else {
      t.css3dObject.getWorldPosition(_worldPos);
      _lookAtMat.lookAt(_worldPos, camera.position, _up);
      _targetQuat.setFromRotationMatrix(_lookAtMat);

      // Add lazy drift
      _driftEuler.set(
        Math.sin(time * 0.3 + idx * 1.5) * 0.08,
        Math.cos(time * 0.2 + idx * 1.7) * 0.12,
        0
      );
      _driftQuat.setFromEuler(_driftEuler);
      _targetQuat.multiply(_driftQuat);

      t.css3dObject.quaternion.slerp(_targetQuat, BILLBOARD_SLERP);
    }

    // Shadow
    const heightAboveFloor = t.currentPos.y - FLOOR_Y;
    const absHeight = Math.abs(heightAboveFloor);
    const shadowScale = 1 + absHeight * 0.003;
    const shadowBlur = 15 + absHeight * 0.1;
    const shadowOpacity = Math.max(0.05, 0.3 - absHeight * 0.001);

    const lightOffsetX = LIGHT_DIR.x * absHeight * 0.3;
    const lightOffsetZ = LIGHT_DIR.z * absHeight * 0.3;
    t.shadowObject.position.set(
      t.currentPos.x + lightOffsetX,
      FLOOR_Y,
      t.currentPos.z + lightOffsetZ
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
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      await sendSpecialKey(focusedSession, 'BSpace');
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
  } catch (e) { /* silently fail */ }
}

async function sendSpecialKey(session, key) {
  try {
    await fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: session, pane: '0', specialKey: key })
    });
  } catch (e) { /* silently fail */ }
}

// === Start ===
init();
