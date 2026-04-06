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
// 12. CARD SIZING USES MEASURED FONT METRICS (2026-04-01):
//     Card DOM dimensions must match the SVG viewBox aspect ratio exactly, or the SVG
//     letterboxes inside the card (visible gap) and text can blur. The SVG's viewBox is
//     computed from runtime-measured font metrics (getBBox on a measure element). The card
//     must be sized using those same measured values, NOT the hardcoded SVG_CELL_W/SVG_CELL_H
//     constants. The constants remain as fallbacks for initial card creation (before the SVG
//     <object> loads and measures its font). After load, the card is corrected to match.
//
//     Sizing flow:
//     a) addTerminal: card sized with hardcoded constants (approximate), _needsMeasuredCorrection=true
//     b) SVG <object> loads: 100ms delay, then card corrected using getMeasuredCellSize()
//     c) First screen message: updateCardForNewSize runs, _needsMeasuredCorrection allows
//        it through even if cols/rows haven't changed, applies measured correction
//     d) Subsequent resizes: updateCardForNewSize always uses measured values when available
//
//     Flags on terminal object:
//     - _needsMeasuredCorrection: set at creation, cleared after first measured resize
//     - _lockCardSize: set by optimizeTermToCard (⊡), prevents updateCardForNewSize from
//       recalculating — user's card size is the authority when fitting terminal to card
//     - _suppressRelayout: set by +/- buttons, prevents re-layout after terminal resize
//       so the header/buttons don't jump away from the cursor
//     - _resizeAnchorFx/_resizeAnchorFy: fraction (0-1) of the card where the user clicked,
//       used to pin that point during resize so the card grows/shrinks around the click
//     - _origColRowRatio: cols/rows ratio set by drag resize or first +/- press, used to
//       preserve aspect ratio during +/- operations (prevents cumulative rounding drift)
//     - _resizeEdge: { left, right, top, bottom } booleans set on alt+drag mousedown,
//       determines which edge/corner was grabbed for directional resize
//
//     See PRD-amendment-004.02.md for full investigation and root cause analysis.
//
// 13. DIRECTIONAL CARD RESIZE (2026-04-01):
//     Alt+drag resize detects which edge/corner was grabbed (20% edge zone from each side).
//     Only the grabbed edges move; the opposite edges stay anchored by shifting the card's
//     3D position to compensate. The scale factor adapts to the card's apparent screen size
//     (DOM width / bounding rect width) so mouse movement tracks 1:1 regardless of Z-depth.
//
// 14. +/- PRESERVES ASPECT RATIO (2026-04-01):
//     The +/- buttons store the original cols/rows ratio (_origColRowRatio) on first press.
//     Subsequent presses compute rows from this fixed ratio, preventing cumulative integer
//     rounding drift that previously caused cards to letterbox over repeated +/- cycles.
//     The ratio is reset by: alt+drag (user's new shape intent), fit-to-term (⊡), fit-to-card (⊞).
//
// ============================================================================

import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { easeInOutCubic, lerpPos } from './polyhedra.mjs';

// Client version — server computes hash of dashboard.mjs at startup and sends on WS connect.
// Client stores the version from first connect. On reconnect, if server version differs,
// the client is stale and needs a reload.
var _serverVersion = null;

// CSRF double-submit cookie: read cp_csrf cookie and include as header on mutations
function _getCsrfToken() {
  var m = document.cookie.match(/cp_csrf=([^;]+)/);
  return m ? m[1] : '';
}
function csrfFetch(url, opts) {
  opts = opts || {};
  if (opts.method && opts.method !== 'GET' && opts.method !== 'HEAD') {
    opts.headers = opts.headers || {};
    opts.headers['X-CSRF-Token'] = _getCsrfToken();
  }
  return fetch(url, opts);
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

// === Layout Registry ===
// Named slot maps for multi-focus card arrangement.
// Each layout defines rectangular slots as percentages of usable space.
// Cards are assigned to slots by cell count (largest → largest slot).
// The 'auto' layout uses the existing masonry bin-packer.
// See design spec: docs/superpowers/specs/2026-04-01-layout-system-design.04.md

const LAYOUTS = {
  'auto': {
    name: 'Auto',
    slots: null  // null = use masonry bin-packer (calculateFocusedLayout legacy path)
  },
  '2up-h': {
    name: '2-Up Horizontal',
    slots: [
      { x: 0, y: 0, w: 50, h: 100 },
      { x: 50, y: 0, w: 50, h: 100 }
    ]
  },
  '2up-v': {
    name: '2-Up Vertical',
    slots: [
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 0, y: 50, w: 100, h: 50 }
    ]
  },
  '1main-2side': {
    name: '1 Main + 2 Side',
    slots: [
      { x: 0, y: 0, w: 66, h: 100 },
      { x: 66, y: 0, w: 34, h: 50 },
      { x: 66, y: 50, w: 34, h: 50 }
    ]
  },
  '3col': {
    name: '3 Columns',
    slots: [
      { x: 0, y: 0, w: 33, h: 100 },
      { x: 33, y: 0, w: 34, h: 100 },
      { x: 67, y: 0, w: 33, h: 100 }
    ]
  },
  '2x2': {
    name: '2×2 Grid',
    slots: [
      { x: 0, y: 0, w: 50, h: 50 },
      { x: 50, y: 0, w: 50, h: 50 },
      { x: 0, y: 50, w: 50, h: 50 },
      { x: 50, y: 50, w: 50, h: 50 }
    ]
  },
  '2top-1bottom': {
    name: '2 Top + 1 Bottom',
    slots: [
      { x: 0, y: 0, w: 50, h: 50 },
      { x: 50, y: 0, w: 50, h: 50 },
      { x: 0, y: 50, w: 100, h: 50 }
    ]
  },
  '1main-4mini': {
    name: '1 Main + 4 Mini',
    slots: [
      { x: 0, y: 0, w: 66, h: 100 },
      { x: 66, y: 0, w: 17, h: 50 },
      { x: 83, y: 0, w: 17, h: 50 },
      { x: 66, y: 50, w: 17, h: 50 },
      { x: 83, y: 50, w: 17, h: 50 }
    ]
  },
  'n-stacked': {
    name: 'Stacked Rows',
    slots: null  // generated dynamically by generateNStacked(count)
  }
};

// Layout order for cycling with layout button
const LAYOUT_ORDER = ['auto', '2up-h', '2up-v', '1main-2side', '3col', '2x2', '2top-1bottom', '1main-4mini', 'n-stacked'];

// Current active layout for the focus group
let activeLayout = 'auto';

// Generate n-stacked layout dynamically — N equal rows, full width.
// Cards are centered within slot at comfortable aspect (not letterboxed to full width).
function generateNStacked(n) {
  var slots = [];
  var h = 100 / n;
  for (var i = 0; i < n; i++) {
    slots.push({ x: 0, y: h * i, w: 100, h: h });
  }
  return slots;
}

// Cycle to the next layout in LAYOUT_ORDER.
// Only works when terminals are focused. Triggers re-layout immediately.
function cycleLayout() {
  var idx = LAYOUT_ORDER.indexOf(activeLayout);
  activeLayout = LAYOUT_ORDER[(idx + 1) % LAYOUT_ORDER.length];
  calculateFocusedLayout();
  showLayoutIndicator();
  updateTopBarLayoutLabel();
}

// Show a brief overlay indicating the current layout name.
// Fades out after 1.5 seconds.
function showLayoutIndicator() {
  var indicator = document.getElementById('layout-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'layout-indicator';
    document.body.appendChild(indicator);
  }
  var layout = LAYOUTS[activeLayout];
  indicator.textContent = layout ? layout.name : activeLayout;
  indicator.style.opacity = '1';
  clearTimeout(indicator._fadeTimer);
  indicator._fadeTimer = setTimeout(function() {
    indicator.style.opacity = '0';
  }, 1500);
}

/** Apply named layout from top bar (multi-focus only). */
function setActiveLayoutFromMenu(layoutKey) {
  if (focusedSessions.size < 2) return;
  if (!LAYOUTS[layoutKey]) return;
  activeLayout = layoutKey;
  calculateFocusedLayout();
  showLayoutIndicator();
  updateTopBarLayoutLabel();
}

/** Slot list for ghost preview (percent of content area below top bar). */
function getSlotsForGhost(layoutKey) {
  if (layoutKey === 'auto') {
    return [{ x: 0, y: 0, w: 100, h: 100 }];
  }
  if (layoutKey === 'n-stacked') {
    var n = Math.max(1, focusedSessions.size);
    return generateNStacked(n);
  }
  var L = LAYOUTS[layoutKey];
  if (!L || !L.slots) return [{ x: 0, y: 0, w: 100, h: 100 }];
  return L.slots;
}

var _ghostFadeTimer = null;
var _ghostHoverKey = null;

function clearGhostLayoutPreview() {
  var host = document.getElementById('ghost-layout-preview');
  if (!host) return;
  host.innerHTML = '';
  host.classList.remove('visible');
  host.setAttribute('aria-hidden', 'true');
  clearTimeout(_ghostFadeTimer);
  _ghostFadeTimer = null;
  _ghostHoverKey = null;
}

function renderGhostLayoutPreview(layoutKey) {
  var host = document.getElementById('ghost-layout-preview');
  if (!host) return;
  clearTimeout(_ghostFadeTimer);
  host.innerHTML = '';
  var slots = getSlotsForGhost(layoutKey);
  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    var el = document.createElement('div');
    el.className = 'ghost-slot';
    el.style.left = s.x + '%';
    el.style.top = s.y + '%';
    el.style.width = s.w + '%';
    el.style.height = s.h + '%';
    host.appendChild(el);
  }
  host.classList.add('visible');
  host.setAttribute('aria-hidden', 'false');
  _ghostHoverKey = layoutKey;
  _ghostFadeTimer = setTimeout(function() {
    for (var j = 0; j < host.children.length; j++) {
      host.children[j].classList.add('ghost-slot--faded');
    }
  }, 1000);
}

function updateTopBarLayoutLabel() {
  var el = document.getElementById('layout-current-label');
  if (!el) return;
  var layout = LAYOUTS[activeLayout];
  el.textContent = layout ? layout.name : activeLayout;
  var opts = document.querySelectorAll('[data-layout-key]');
  for (var i = 0; i < opts.length; i++) {
    var k = opts[i].getAttribute('data-layout-key');
    opts[i].classList.toggle('active', k === activeLayout);
  }
}

function fitAllFocused() {
  if (focusedSessions.size < 2) return;
  for (var name of focusedSessions) {
    var t = terminals.get(name);
    if (t) optimizeTermToCard(t);
  }
}

function maxAllFocused() {
  if (focusedSessions.size < 2) return;
  for (var name of focusedSessions) {
    var t = terminals.get(name);
    if (t) maximizeCardToSlot(t);
  }
}

function updateTopBarVisibility() {
  var multi = document.getElementById('top-bar-multi');
  if (multi) multi.style.display = focusedSessions.size >= 2 ? 'flex' : 'none';
  updateTopBarLayoutLabel();
}

function refreshTopBarUser() {
  var pill = document.getElementById('top-user-pill');
  if (!pill) return;
  fetch('/auth/me', { credentials: 'same-origin' })
    .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
    .then(function(u) {
      pill.textContent = u.displayName || u.email || u.linuxUser || 'Signed in';
      pill.title = u.email || '';
      var adminLink = document.getElementById('menu-admin');
      if (adminLink && u.canApprove) adminLink.style.display = '';
    })
    .catch(function() {
      pill.textContent = 'Guest';
      pill.title = 'Not signed in — use Menu → Login';
    });
}

function wireTopBar() {
  var hamburger = document.getElementById('top-menu-hamburger');
  var mainMenu = document.getElementById('main-menu-dropdown');
  var layoutBtn = document.getElementById('layout-selector-btn');
  var layoutDd = document.getElementById('layout-dropdown');
  var fitAll = document.getElementById('top-fit-all');
  var maxAll = document.getElementById('top-max-all');
  var helpMenu = document.getElementById('menu-help');
  var logoutMenu = document.getElementById('menu-logout');

  if (hamburger && mainMenu) {
    hamburger.addEventListener('click', function(e) {
      e.stopPropagation();
      var open = mainMenu.classList.toggle('visible');
      if (layoutDd) layoutDd.classList.remove('visible');
      if (open) refreshTopBarUser();
      syncUiOverlayPointerBlock();
    });
  }
  if (helpMenu) {
    helpMenu.addEventListener('click', function(e) {
      e.preventDefault();
      toggleHelp();
      if (mainMenu) mainMenu.classList.remove('visible');
    });
  }
  if (logoutMenu) {
    logoutMenu.addEventListener('click', function(e) {
      e.preventDefault();
      fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(function() {
        refreshTopBarUser();
        if (mainMenu) mainMenu.classList.remove('visible');
      });
    });
  }
  if (layoutBtn && layoutDd) {
    layoutBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      layoutDd.classList.toggle('visible');
      if (mainMenu) mainMenu.classList.remove('visible');
      syncUiOverlayPointerBlock();
    });
  }
  if (fitAll) fitAll.addEventListener('click', function() { fitAllFocused(); fitAll.blur(); });
  if (maxAll) maxAll.addEventListener('click', function() { maxAllFocused(); maxAll.blur(); });

  var layoutOptions = document.querySelectorAll('[data-layout-key]');
  for (var i = 0; i < layoutOptions.length; i++) {
    layoutOptions[i].addEventListener('mouseenter', function(ev) {
      var key = ev.currentTarget.getAttribute('data-layout-key');
      if (focusedSessions.size >= 2) renderGhostLayoutPreview(key);
    });
    layoutOptions[i].addEventListener('mouseleave', function() {
      clearGhostLayoutPreview();
    });
    layoutOptions[i].addEventListener('click', function(ev) {
      ev.stopPropagation();
      var key = ev.currentTarget.getAttribute('data-layout-key');
      setActiveLayoutFromMenu(key);
      clearGhostLayoutPreview();
      if (layoutDd) layoutDd.classList.remove('visible');
    });
  }

  document.addEventListener('click', function(ev) {
    if (ev.target.closest && ev.target.closest('#top-bar')) return;
    if (mainMenu) mainMenu.classList.remove('visible');
    if (layoutDd) layoutDd.classList.remove('visible');
    clearGhostLayoutPreview();
    syncUiOverlayPointerBlock();
  });

  var newSess = document.getElementById('menu-new-session');
  if (newSess) {
    newSess.addEventListener('click', function(e) {
      e.preventDefault();
      if (mainMenu) mainMenu.classList.remove('visible');
      void openSessionFormPanel();
    });
  }

  var menuRestart = document.getElementById('menu-restart');
  if (menuRestart) {
    menuRestart.addEventListener('click', function(e) {
      e.preventDefault();
      if (mainMenu) mainMenu.classList.remove('visible');
      void openRestartSessionPanel();
    });
  }
  var menuFork = document.getElementById('menu-fork');
  if (menuFork) {
    menuFork.addEventListener('click', function(e) {
      e.preventDefault();
      if (mainMenu) mainMenu.classList.remove('visible');
      void openForkSessionPanel();
    });
  }

  updateTopBarVisibility();
  refreshTopBarUser();
}

// Assign cards to slots: largest terminal (by cell count) → largest slot (by area).
// Returns array of { name, slotIndex, slot } objects.
// Cards with no available slot get slotIndex = -1 and slot = null (overflow).
function assignCardsToSlots(cards, slots) {
  var sorted = cards.slice().sort(function(a, b) { return b.cells - a.cells; });
  var slotOrder = slots.map(function(s, i) { return { index: i, area: s.w * s.h }; })
    .sort(function(a, b) { return b.area - a.area; });

  var assignments = [];
  for (var i = 0; i < sorted.length; i++) {
    if (i < slotOrder.length) {
      assignments.push({ name: sorted[i].name, slotIndex: slotOrder[i].index, slot: slots[slotOrder[i].index] });
    } else {
      assignments.push({ name: sorted[i].name, slotIndex: -1, slot: null });
    }
  }
  return assignments;
}

// === Key Translation (browser KeyboardEvent → tmux send-keys) ===
const SPECIAL_KEY_MAP = {
  'Enter': 'Enter',
  'Tab': 'Tab',
  'Escape': 'Escape',
  'Backspace': 'Backspace',
  'Delete': 'Delete',
  'ArrowUp': 'Up',
  'ArrowDown': 'Down',
  'ArrowLeft': 'Left',
  'ArrowRight': 'Right',
  'Home': 'Home',
  'End': 'End',
  'PageUp': 'PageUp',
  'PageDown': 'PageDown',
  'Insert': 'Insert',
  'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
  'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
  'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
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
        // How much the SVG is currently scaled to fill the card.
        // The viewBox is (cols * cellW) × (rows * cellH), stretched to cardW × cardH.
        // scaleW/scaleH tell us the stretch factor in each dimension.
        // fitScale = min of both = the scale at which content fits without clipping.
        // We compute new cols/rows at this scale so text stays the same apparent size
        // but fills the card completely.
        const scaleW = cardW / (cols * cellW);
        const scaleH = cardH / (rows * cellH);
        const fitScale = Math.min(scaleW, scaleH);
        const newCols = Math.max(20, Math.round(cardW / (cellW * fitScale)));
        const newRows = Math.max(5, Math.round(cardH / (cellH * fitScale)));
        // Lock the card size so updateCardForNewSize doesn't recalculate it.
        // The user's card size is the authority — terminal adapts to it.
        t._lockCardSize = true;
        t.sendInput({ type: 'resize', cols: newCols, rows: newRows });
        // Reset the original ratio so +/- preserves this new shape
        t._origColRowRatio = newCols / newRows;
        // Force repaint after the resize response arrives — CSS3D compositor
        // holds a stale texture until explicitly invalidated.
        setTimeout(function() {
          var obj2 = t.dom ? t.dom.querySelector('object') : null;
          if (obj2) scheduleTerminalSurfaceRepaint(obj2, t);
        }, 500);
        return;
      }
    }
  } catch (e) {}
  // Fallback: keep current size
  t.sendInput({ type: 'resize', cols: t.screenCols || 80, rows: t.screenRows || 24 });
}

// Optimize card → terminal: resize the card to fit the current terminal.
// Terminal stays, card adjusts. Use after +/- to wrap the card snugly.
// Same logic as addTerminal init — unified path.
function optimizeCardToTerm(t) {
  const cols = t.screenCols || 80;
  const rows = t.screenRows || 24;
  // Reset original ratio so +/- preserves this shape going forward
  t._origColRowRatio = cols / rows;
  var measured = getMeasuredCellSize(t);
  const { cardW, cardH } = measured
    ? calcCardSize(cols, rows, measured.cellW, measured.cellH)
    : calcCardSize(cols, rows);
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

// Maximize card→slot: resize card DOM to fill its assigned layout slot.
// Card takes on the slot's aspect ratio. Terminal content letterboxes inside
// (the SVG's preserveAspectRatio=meet handles this automatically).
// Per-browser only — doesn't affect co-browsers or tmux.
function maximizeCardToSlot(t) {
  if (!t._layoutSlot) return;

  var slot = t._layoutSlot;
  var slotAspect = slot.w / slot.h;

  // Compute card DOM dimensions that match the slot's aspect ratio.
  // Use TARGET_WORLD_AREA for consistent visual weight.
  var worldW = Math.sqrt(TARGET_WORLD_AREA * slotAspect);
  var worldH = TARGET_WORLD_AREA / worldW;
  var cardW = Math.round(worldW * DOM_SCALE);
  var cardH = Math.round(worldH * DOM_SCALE) + HEADER_H;
  cardW = Math.max(MIN_CARD_W, Math.min(MAX_CARD_W, cardW));
  cardH = Math.max(MIN_CARD_H, Math.min(MAX_CARD_H, cardH));

  // Apply new card size
  t.baseCardW = cardW;
  t.baseCardH = cardH;
  t.dom.style.width = cardW + 'px';
  t.dom.style.height = cardH + 'px';
  var inner = t.dom.querySelector('.terminal-inner');
  if (inner) {
    inner.style.width = cardW + 'px';
    inner.style.height = cardH + 'px';
  }

  // Reset +/- ratio to new card shape
  var cols = t.screenCols || 80;
  var rows = t.screenRows || 24;
  t._origColRowRatio = cols / rows;

  // Re-run layout to reposition at correct Z-depth for new world size
  calculateFocusedLayout();
}

// === Constants ===
const LIGHT_DIR = new THREE.Vector3(-0.7, 0.7, -0.3).normalize();
const FLOOR_Y = -300;
const MORPH_DURATION = 1.5;
const BILLBOARD_SLERP = 0.08;
const SIDEBAR_WIDTH = 140;
/** Fixed top menu bar height — must match `.top-bar` CSS and ghost preview inset */
const TOP_BAR_H = 44;
const FOCUS_DIST = 350;

// DOM scale trick: card DOM is oversized by DOM_SCALE, CSS3DObject renders at WORLD_SCALE.
// This forces Chrome to rasterize text at high resolution before 3D transform scales it down.
// DO NOT set DOM_SCALE to 1 — text will blur. See note 1 in header.
var DOM_SCALE = 4;
var WORLD_SCALE = 1 / DOM_SCALE;

// Renderer resolution multiplier — separate from DOM_SCALE.
// RENDER_SCALE=2 means renderer canvas is 2x viewport, scaled down via CSS transform.
// Can be reduced to 1 by performance system for lower-end hardware.
var RENDER_SCALE = 2;
var RENDER_SCALE_DEFAULT = 2;

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

// Performance mode (see docs/superpowers/plans/2026-04-03-performance-detection.02.md)
var perfMode = 'auto';
var perfTier = 0;
var _savedRingSpeed = null;
var _perfFrameTimes = [];
var _perfCheckStart = 0;
var _perfCheckPhase = 0;
var _cachedGPU = null;
// Ignore longer gaps between RAF ticks — not render cost (tab in background, OS sleep, debugger).
var _perfMaxFrameGapMs = 200;

function resetAutoPerfSampling() {
  _perfCheckPhase = 0;
  _perfFrameTimes.length = 0;
  delete _perfFrameTimes._lastTime;
}

let dashboardWs = null; // shared WebSocket to /ws/dashboard
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
const STATUS_BAR_H = 50; /* bottom input bar reserve — cards avoid this strip when focused */
const LAYOUT_GAP_PX = 8;

function calculateFocusedLayout() {
  const now = clock.getElapsedTime();
  const count = focusedSessions.size;
  if (count === 0) return;

  // Dispatch to named layout if one is active (not 'auto')
  var layout = LAYOUTS[activeLayout];
  if (layout && layout.slots) {
    calculateSlotLayout(layout.slots);
    return;
  }
  // Special case: n-stacked generates slots dynamically based on card count
  if (activeLayout === 'n-stacked') {
    calculateSlotLayout(generateNStacked(count));
    return;
  }
  // 'auto' layout — fall through to masonry bin-packer below

  // Full viewport — sidebar, top bar, and status bar are overlays; layout avoids them.
  const screenW = window.innerWidth;
  const screenH = window.innerHeight;

  const availW = screenW - SIDEBAR_WIDTH;
  const availH = screenH - STATUS_BAR_H - TOP_BAR_H;

  // Build cards with cell counts — skip user-positioned terminals
  const names = [...focusedSessions];
  const cards = [];
  for (const name of names) {
    const t = terminals.get(name);
    if (t && t._userPositioned) continue; // user dragged/resized — don't override
    const cols = t ? t.screenCols || 80 : 80;
    const rows = t ? t.screenRows || 24 : 24;
    const cells = cols * rows;
    const m = t ? getMeasuredCellSize(t) : null;
    const aspect = (cols * (m ? m.cellW : SVG_CELL_W)) / (rows * (m ? m.cellH : SVG_CELL_H));
    const worldW = (t ? t.baseCardW || 1280 : 1280) * WORLD_SCALE;
    const worldH = (t ? t.baseCardH || 992 : 992) * WORLD_SCALE;
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
    // Score = actual card area as fraction of available area.
    // This directly measures how much of the viewport is used by cards vs wasted.
    // Previous approach (bounding box coverage * balance) failed because:
    // - 3 cards in a row: bounding box is wide but thin → low total card area
    // - 2+1 layout: unbalanced columns penalized too hard despite better area usage
    // Actual card area avoids both problems.
    var totalCardArea = 0;
    for (const p of placements) totalCardArea += p.sw * p.sh;
    const score = totalCardArea * scale * scale / (availW * availH);

    if (score > bestScore) {
      bestScore = score;
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

    // Screen center of this card (full viewport coordinates; content below top bar)
    p._cx = originX + colX[p.col];
    p._cy = TOP_BAR_H + originY + p.y * scale + (p.sh * scale) / 2;
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

// Position cards into named layout slots using frustum projection.
// Same projection math as calculateFocusedLayout but with predefined slot positions
// instead of masonry bin-packing.
//
// Slot positions are percentages of usable space (availW × availH).
// Each card is placed at the Z-depth where its world size fills its slot's screen rectangle.
// Card aspect ratio is preserved — card is centered in slot if aspects don't match.
function calculateSlotLayout(slots) {
  var now = clock.getElapsedTime();
  var count = focusedSessions.size;
  if (count === 0) return;

  var screenW = window.innerWidth;
  var screenH = window.innerHeight;
  var availW = screenW - SIDEBAR_WIDTH;
  var availH = screenH - STATUS_BAR_H - TOP_BAR_H;

  // Build card info — same structure as masonry path
  var names = [...focusedSessions];
  var cards = [];
  for (var ci = 0; ci < names.length; ci++) {
    var name = names[ci];
    var t = terminals.get(name);
    if (t && t._userPositioned) continue;
    var cols = t ? t.screenCols || 80 : 80;
    var rows = t ? t.screenRows || 24 : 24;
    var cells = cols * rows;
    var m = t ? getMeasuredCellSize(t) : null;
    var aspect = (cols * (m ? m.cellW : SVG_CELL_W)) / (rows * (m ? m.cellH : SVG_CELL_H));
    var worldW = (t ? t.baseCardW || 1280 : 1280) * WORLD_SCALE;
    var worldH = (t ? t.baseCardH || 992 : 992) * WORLD_SCALE;
    cards.push({ name: name, cols: cols, rows: rows, cells: cells, aspect: aspect, worldW: worldW, worldH: worldH });
  }

  if (cards.length === 0) return;

  // Assign cards to slots
  var assignments = assignCardsToSlots(cards, slots);

  // Underflow: fewer cards than slots — rescale used slots to fill available space.
  // Compute bounding box of assigned slots, then normalize all to fill 0-100% range.
  var usedAssignments = [];
  for (var ui = 0; ui < assignments.length; ui++) {
    if (assignments[ui].slot) usedAssignments.push(assignments[ui]);
  }
  if (usedAssignments.length > 0 && usedAssignments.length < slots.length) {
    var minX = 100, minY = 100, maxX = 0, maxY = 0;
    for (var ui = 0; ui < usedAssignments.length; ui++) {
      var s = usedAssignments[ui].slot;
      if (s.x < minX) minX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.x + s.w > maxX) maxX = s.x + s.w;
      if (s.y + s.h > maxY) maxY = s.y + s.h;
    }
    var bw = maxX - minX;
    var bh = maxY - minY;
    if (bw > 0 && bh > 0) {
      for (var ui = 0; ui < usedAssignments.length; ui++) {
        var s = usedAssignments[ui].slot;
        usedAssignments[ui].slot = {
          x: ((s.x - minX) / bw) * 100,
          y: ((s.y - minY) / bh) * 100,
          w: (s.w / bw) * 100,
          h: (s.h / bh) * 100
        };
      }
    }
  }
  // Use usedAssignments for the rest of the function instead of assignments
  assignments = usedAssignments.length > 0 ? usedAssignments : assignments;

  // Frustum projection setup
  var vFov = camera.fov * DEG2RAD;
  var halfTan = Math.tan(vFov / 2);

  var placements = [];

  for (var ai = 0; ai < assignments.length; ai++) {
    var a = assignments[ai];
    var t = terminals.get(a.name);
    if (!t) continue;
    var card = null;
    for (var ci = 0; ci < cards.length; ci++) {
      if (cards[ci].name === a.name) { card = cards[ci]; break; }
    }
    if (!card) continue;

    if (!a.slot) {
      // Overflow card — no slot assigned.
      // TODO Phase 2: shrink layout and place overflow cards in freed space.
      continue;
    }

    // Convert slot percentages to pixel positions within usable space (below top bar)
    var slotPxX = (a.slot.x / 100) * availW;
    var slotPxY = TOP_BAR_H + (a.slot.y / 100) * availH;
    var slotPxW = (a.slot.w / 100) * availW;
    var slotPxH = (a.slot.h / 100) * availH;

    // Card must fit within slot while preserving its aspect ratio (letterbox).
    var slotAspect = slotPxW / slotPxH;
    var fitW, fitH;
    if (card.aspect > slotAspect) {
      // Card is wider than slot — constrained by width
      fitW = slotPxW;
      fitH = slotPxW / card.aspect;
    } else {
      // Card is taller than slot — constrained by height
      fitH = slotPxH;
      fitW = slotPxH * card.aspect;
    }

    // Center the card within its slot
    var cx = slotPxX + slotPxW / 2;
    var cy = slotPxY + slotPxH / 2;

    // Screen fraction this card occupies (for frustum depth calc)
    var fracH = fitH / screenH;
    var depth = card.worldH / (fracH * 2 * halfTan);

    placements.push({ name: a.name, cx: cx, cy: cy, fitW: fitW, fitH: fitH, depth: depth, worldW: card.worldW, worldH: card.worldH });
  }

  if (placements.length === 0) return;

  // Camera Z: far enough back that all focused cards are in front of the ring
  var maxDepth = Math.max.apply(null, placements.map(function(p) { return p.depth; }));
  var minCardZ = 150;
  var camZ = Math.max(FOCUS_DIST, maxDepth + minCardZ);

  // Position each card in 3D
  for (var pi = 0; pi < placements.length; pi++) {
    var p = placements[pi];
    var t = terminals.get(p.name);
    if (!t) continue;

    var cardZ = camZ - p.depth;
    var visHAtDepth = 2 * p.depth * halfTan;
    var px2w = visHAtDepth / screenH;
    var wx = (p.cx - screenW / 2) * px2w;
    var wy = -(p.cy - screenH / 2) * px2w;

    t.morphFrom = { x: t.currentPos.x, y: t.currentPos.y, z: t.currentPos.z };
    t._layoutZ = cardZ;
    t.targetPos = { x: wx, y: wy, z: cardZ };
    t.morphStart = now;
    // Save slot dimensions for mutation operations (maximize card→slot).
    t._layoutSlot = { x: slotPxX, y: slotPxY, w: slotPxW, h: slotPxH };
    t._layoutFit = { w: fitW, h: fitH };
  }

  // Camera tween
  var avgZ = 0;
  for (var pi = 0; pi < placements.length; pi++) {
    avgZ += (camZ - placements[pi].depth);
  }
  avgZ /= placements.length;

  cameraTween = {
    from: camera.position.clone(),
    to: new THREE.Vector3(0, 0, camZ),
    lookFrom: currentLookTarget.clone(),
    lookTo: new THREE.Vector3(0, 0, avgZ),
    start: now,
    duration: 1.0
  };
}

// === Performance detection & tiers (see docs/superpowers/plans/2026-04-03-performance-detection.02.md) ===
function detectGPU() {
  var result = { renderer: 'unknown', isSoftware: false, cores: navigator.hardwareConcurrency || 0, memory: navigator.deviceMemory || 0, maxTexture: 0 };
  try {
    var canvas = document.createElement('canvas');
    var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) { result.isSoftware = true; return result; }
    var dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) result.renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || 'unknown';
    result.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
    var sw = result.renderer.toLowerCase();
    result.isSoftware = sw.includes('swiftshader') || sw.includes('llvmpipe')
      || sw.includes('microsoft basic render') || sw.includes('apple software renderer');
    canvas.remove();
  } catch (e) { result.isSoftware = true; }
  return result;
}

function updatePerfIndicator() {
  var el = document.getElementById('perf-indicator');
  if (!el) return;
  el.className = 'perf-indicator tier-' + perfTier;
  var tierName = perfTier === 0 ? 'full' : perfTier === 1 ? 'reduced' : 'minimal';
  el.textContent = tierName + ' (' + perfMode + ')';
  el.title = 'Performance: ' + tierName + ' (click to cycle, current: ' + perfMode + ')';
}

function resizeRenderer() {
  renderer.setSize(window.innerWidth * RENDER_SCALE, window.innerHeight * RENDER_SCALE);
  renderer.domElement.style.transform = 'scale(' + (1 / RENDER_SCALE) + ')';
}

function applyPerfTier(tier) {
  var prev = perfTier;
  perfTier = tier;

  if (tier >= 1) {
    if (_savedRingSpeed === null) {
      _savedRingSpeed = { outer: RING.outer.spinSpeed, inner: RING.inner.spinSpeed };
    }
    RING.outer.spinSpeed = 0;
    RING.inner.spinSpeed = 0;
    if (shadowGroup) shadowGroup.visible = false;
    document.querySelectorAll('.specular-overlay').forEach(function(e) { e.style.display = 'none'; });
    if (RENDER_SCALE > 1) {
      RENDER_SCALE = 1;
      resizeRenderer();
    }
  } else {
    if (_savedRingSpeed) {
      RING.outer.spinSpeed = _savedRingSpeed.outer;
      RING.inner.spinSpeed = _savedRingSpeed.inner;
      _savedRingSpeed = null;
    }
    if (shadowGroup) shadowGroup.visible = true;
    document.querySelectorAll('.specular-overlay').forEach(function(e) { e.style.display = ''; });
    if (RENDER_SCALE !== RENDER_SCALE_DEFAULT) {
      RENDER_SCALE = RENDER_SCALE_DEFAULT;
      resizeRenderer();
    }
  }

  if (tier >= 2) {
    syncPerfTier2Visibility();
  } else if (prev >= 2 && tier < 2) {
    for (var [name, t] of terminals) {
      t.css3dObject.visible = true;
      if (t.shadowObject) t.shadowObject.visible = true;
    }
  }

  updatePerfIndicator();
  console.log('[perf] tier ' + prev + ' → ' + tier + ' (' + perfMode + ')');
}

// Tier 2 (minimal): on desktop overview, show all cards (empty ring looks broken).
// On touch landscape, hide all unfocused cards even in overview — compositor can't handle them.
function tier2CardShouldShow(sessionName) {
  if (perfTier < 2) return true;
  if (focusedSessions.has(sessionName)) return true;
  if (focusedSessions.size > 0) return false;
  // Overview (no focus): hide cards on touch landscape, show on desktop
  var coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  return !coarse || window.innerWidth <= window.innerHeight;
}

function syncPerfTier2Visibility() {
  if (perfTier < 2) return;
  for (var [name, t] of terminals) {
    var show = tier2CardShouldShow(name);
    t.css3dObject.visible = show;
    if (t.shadowObject) t.shadowObject.visible = show;
  }
}

// === Init ===
function init() {
  var gpu = detectGPU();
  console.log('[perf] GPU:', gpu.renderer, gpu.isSoftware ? '(SOFTWARE)' : '(hardware)',
    'cores:', gpu.cores, 'mem:', gpu.memory != null ? gpu.memory + 'GB' : 'n/a');

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 10000);
  camera.position.copy(HOME_POS);
  camera.lookAt(HOME_TARGET);

  renderer = new CSS3DRenderer();
  renderer.domElement.style.position = 'fixed';
  renderer.domElement.style.top = '0';
  renderer.domElement.style.left = '0';
  renderer.domElement.style.zIndex = '1';
  renderer.domElement.style.transformOrigin = '0 0';
  resizeRenderer();
  document.body.appendChild(renderer.domElement);

  terminalGroup = new THREE.Group();
  scene.add(terminalGroup);
  shadowGroup = new THREE.Group();
  scene.add(shadowGroup);

  _cachedGPU = gpu;
  if (perfMode === 'auto') {
    if (gpu.isSoftware) {
      applyPerfTier(1);
      console.log('[perf] auto tier 1: software renderer');
    } else {
      var coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
      if (coarse && window.innerWidth > window.innerHeight) {
        applyPerfTier(2);
        console.log('[perf] auto tier 2: touch device + landscape');
      }
    }
  }

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

  // Events
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState !== 'visible' || perfMode !== 'auto') return;
    resetAutoPerfSampling();
    console.log('[perf] tab visible again — reset FPS sampling (background intervals ignored)');
  });
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  renderer.domElement.addEventListener('mouseleave', onMouseLeave);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  renderer.domElement.addEventListener('click', onSceneClick);
  document.addEventListener('keydown', onKeyDown);
  document.getElementById('help-btn').addEventListener('click', toggleHelp);
  document.getElementById('help-close').addEventListener('click', toggleHelp);

  var perfEl = document.getElementById('perf-indicator');
  if (perfEl) {
    perfEl.addEventListener('click', function(e) {
      e.stopPropagation();
      var modes = ['auto', 'full', 'reduced', 'minimal'];
      var idx = modes.indexOf(perfMode);
      perfMode = modes[(idx + 1) % modes.length];
      if (perfMode === 'full') applyPerfTier(0);
      else if (perfMode === 'reduced') applyPerfTier(1);
      else if (perfMode === 'minimal') applyPerfTier(2);
      else {
        resetAutoPerfSampling();
        if (_cachedGPU && _cachedGPU.isSoftware) applyPerfTier(1);
        else applyPerfTier(0);
      }
      updatePerfIndicator();
      console.log('[perf] mode set to ' + perfMode);
    });
  }
  updatePerfIndicator();

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

  // Auth check + fetch WS token on page load
  fetch('/auth/me', { credentials: 'same-origin' })
    .then(function(r) {
      if (!r.ok) {
        location.href = '/login';
        throw new Error('not authenticated');
      }
      return r.json();
    })
    .then(function(u) {
      var pill = document.getElementById('top-user-pill');
      if (pill) {
        pill.textContent = u.displayName || u.email || u.linuxUser || 'Signed in';
        pill.title = u.email || '';
      }
      var adminLink = document.getElementById('menu-admin');
      if (adminLink && u.canApprove) adminLink.style.display = '';
      // Fetch API key for WebSocket auth (Cloudflare strips cookies from WS upgrades)
      return fetch('/auth/api-key', { credentials: 'same-origin' });
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _apiKey = data.key;
      connectDashboardWs();
    })
    .catch(function(e) {
      if (e.message !== 'not authenticated') {
        // API key fetch failed but we're authenticated — try without key
        connectDashboardWs();
      }
    });

  wireTopBar();
  wireSessionFormPanel();
  wireRestartForkPanels();
  syncUiOverlayPointerBlock();
  animate();
}

// === Shared Dashboard WebSocket ===
var _apiKey = null;
var _dashWsAuthFailures = 0;

var _reconnectAttempt = 0;
var _reconnectTimer = null;
var _reconnectTimeoutSec = 30;

function showReconnectOverlay(secondsLeft) {
  _reconnectAttempt++;
  var overlay = document.getElementById('reconnect-overlay');
  var statusEl = document.getElementById('reconnect-status');
  var countdownEl = document.getElementById('reconnect-countdown');
  var subEl = document.getElementById('reconnect-sub');
  var loginLink = document.getElementById('reconnect-login-link');
  if (!overlay) return;

  overlay.setAttribute('aria-hidden', 'false');
  if (loginLink) loginLink.style.display = 'none';
  if (subEl) subEl.textContent = 'Re-establishing connection to server';

  var remaining = secondsLeft;
  if (statusEl) statusEl.textContent = 'Retrying (attempt ' + _reconnectAttempt + ')... ' + remaining;
  if (countdownEl) countdownEl.textContent = remaining;

  if (_reconnectTimer) clearInterval(_reconnectTimer);

  if (remaining <= 0) {
    if (countdownEl) countdownEl.textContent = '!';
    if (statusEl) statusEl.textContent = 'Connection to server lost';
    if (subEl) subEl.textContent = 'Re-authentication required';
    if (loginLink) loginLink.style.display = 'inline-block';
    return;
  }

  _reconnectTimer = setInterval(function() {
    remaining--;
    if (countdownEl) countdownEl.textContent = remaining;
    if (statusEl) statusEl.textContent = 'Retrying (attempt ' + _reconnectAttempt + ')... ' + remaining;
    if (remaining <= 0) {
      clearInterval(_reconnectTimer);
      _reconnectTimer = null;
      if (countdownEl) countdownEl.textContent = '!';
      if (statusEl) statusEl.textContent = 'Connection to server lost';
      if (subEl) subEl.textContent = 'Re-authentication required';
      if (loginLink) loginLink.style.display = 'inline-block';
    }
  }, 1000);
}

function hideReconnectOverlay() {
  _reconnectAttempt = 0;
  if (_reconnectTimer) { clearInterval(_reconnectTimer); _reconnectTimer = null; }
  var overlay = document.getElementById('reconnect-overlay');
  if (overlay) overlay.setAttribute('aria-hidden', 'true');
}

function connectDashboardWs() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var keyParam = _apiKey ? '?key=' + encodeURIComponent(_apiKey) : '';
  var url = proto + '//' + location.host + '/ws/dashboard' + keyParam;
  var ws = new WebSocket(url);
  ws.onopen = function() {
    console.log('[Dashboard WS] connected');
    _dashWsAuthFailures = 0;
    hideReconnectOverlay();
    dashboardWs = ws;
    // Send current focus state so server adjusts capture rates
    if (focusedSessions.size > 0) {
      sendFocusState();
    }
  };
  ws.onmessage = function(ev) {
    try {
      var msg = JSON.parse(ev.data);
      routeDashboardMessage(msg);
    } catch (e) {
      console.warn('[Dashboard WS] bad message', e);
    }
  };
  ws.onclose = function(ev) {
    dashboardWs = null;
    // 1006 = abnormal close (connection rejected), likely auth failure
    if (ev.code === 1006) _dashWsAuthFailures++;

    if (_dashWsAuthFailures >= 3) {
      showReconnectOverlay(0); // immediate — show login link
      return;
    }

    showReconnectOverlay(_reconnectTimeoutSec);

    // Reconnect after delay — refresh API key first
    setTimeout(function() {
      fetch('/auth/api-key', { credentials: 'same-origin' })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
          if (data) { _apiKey = data.key; _dashWsAuthFailures = 0; }
          connectDashboardWs();
        })
        .catch(function() {
          _dashWsAuthFailures++;
          if (_dashWsAuthFailures >= 3) {
            showReconnectOverlay(0);
          } else {
            connectDashboardWs();
          }
        });
    }, 2000);
  };
  ws.onerror = function() {
    // onclose will fire after this and handle reconnect
  };
}

// Chrome/CSS3D: embedded <object> SVG often fails to composite updated DOM until scroll
// or another invalidation. Nudge layers after terminal content changes.
// Do not touch t.dom.style.transform — CSS3DRenderer owns it every frame.
// Per-terminal: first full `screen` must reach renderMessage before any `delta`, or the
// embedded SVG applies partial line updates without initLayout — scrambled/garbage display.
function routeEmbedMessageToSvg(t, obj, msg, opt) {
  var skipRepaint = opt && opt.skipRepaint;
  if (msg.type === 'delta' && !t._screenAppliedToEmbed) {
    if (!t._screenHealRequested) {
      t._screenHealRequested = true;
      requestScreenHeal(msg.session, '0');
    }
    return;
  }
  obj.contentWindow.renderMessage(msg);
  if (msg.type === 'screen') {
    t._screenAppliedToEmbed = true;
  }
  if (!skipRepaint) {
    scheduleTerminalSurfaceRepaint(obj, t);
  }
}

// Invalidate CSS3D texture so compositor picks up SVG content changes.
// Double rAF needed — Chrome requires two frames for CSS3D <object> texture update.
// No renderer.render() — animate() loop handles rendering every frame.
function scheduleTerminalSurfaceRepaint(obj, t) {
  if (!obj) return;
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      obj.style.transform = 'translateZ(0)';
      void obj.offsetHeight;
      obj.style.transform = '';
      if (t && t.dom) {
        var inner = t.dom.querySelector('.terminal-inner');
        if (inner) {
          var o = inner.style.outline;
          inner.style.outline = '1px solid transparent';
          void inner.offsetHeight;
          inner.style.outline = o;
        }
      }
    });
  });
}

function showUpdateBanner() {
  var existing = document.getElementById('update-banner');
  if (existing) return;
  var banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.style.cssText = 'position:fixed;top:40px;left:50%;transform:translateX(-50%);z-index:99998;' +
    'background:rgba(66,133,244,0.95);color:#fff;padding:10px 24px;border-radius:8px;' +
    'font-family:-apple-system,sans-serif;font-size:0.9rem;display:flex;align-items:center;gap:12px;' +
    'box-shadow:0 4px 16px rgba(0,0,0,0.3);';
  banner.innerHTML = 'Update available — <button id="update-reload-btn" style="background:#fff;color:#4285f4;' +
    'border:none;padding:6px 16px;border-radius:4px;cursor:pointer;font-size:0.85rem;font-weight:600">Reload</button>';
  document.body.appendChild(banner);
  document.getElementById('update-reload-btn').addEventListener('click', function() {
    location.reload(true);
  });
}

function routeDashboardMessage(msg) {
  if (msg.type === 'version') {
    if (_serverVersion === null) {
      _serverVersion = msg.version; // first connect — remember server version
    } else if (_serverVersion !== msg.version) {
      // Server restarted with new code — force reload to avoid stale code flooding deprecated endpoints
      console.warn('[Dashboard] Server version changed: ' + _serverVersion + ' → ' + msg.version + ' — reloading');
      if (window._saveLayout) window._saveLayout();
      location.reload();
      return;
    }
    return;
  }
  if (msg.type === 'reauth-required') {
    // Save UI state before redirect
    if (window._saveLayout) window._saveLayout();
    showReconnectOverlay(0); // immediate — show login link
    return;
  }
  if (msg.type === 'picklists') {
    _lastPicklistData = msg;
    var cbs = _picklistCallbacks;
    _picklistCallbacks = [];
    for (var i = 0; i < cbs.length; i++) {
      try { cbs[i](msg); } catch (e) {}
    }
    return;
  }
  if (msg.type === 'sessions') {
    // Response to get-sessions — used by fork/restart dialogs
    // Store for callers that are waiting
    if (_sessionsCallback) { _sessionsCallback(msg.sessions || []); _sessionsCallback = null; }
    return;
  }
  if (msg.type === 'session-add') {
    if (!terminals.has(msg.session) && !msg.session.startsWith('browser-')) {
      addTerminal(msg.session, msg.cols, msg.rows);
      assignRings();
      // Subscribe so claude-proxy sessions get screen bridge + deltas (same as refreshSessions).
      sendDashboardMessage({
        type: 'subscribe',
        session: msg.session,
        source: msg.source || 'claude-proxy'
      });
    }
    return;
  }
  if (msg.type === 'session-remove') {
    if (terminals.has(msg.session)) {
      removeTerminal(msg.session);
      assignRings();
    }
    return;
  }
  // Session lifecycle WS results
  if (msg.type === 'create-session-result') {
    if (msg.ok) {
      console.log('[WS] Session created:', msg.session);
    } else {
      window.alert('Failed to create session: ' + (msg.error || 'Unknown error'));
    }
    return;
  }
  if (msg.type === 'restart-session-result') {
    if (msg.ok) {
      console.log('[WS] Session restarted:', msg.session);
    } else {
      window.alert('Failed to restart session: ' + (msg.error || 'Unknown error'));
    }
    return;
  }
  if (msg.type === 'fork-session-result') {
    if (msg.ok) {
      console.log('[WS] Session forked:', msg.session);
    } else {
      window.alert('Failed to fork session: ' + (msg.error || 'Unknown error'));
    }
    return;
  }
  if (msg.type === 'save-layout-result') {
    if (!msg.ok) console.warn('[WS] Layout save failed:', msg.error);
    return;
  }
  if (msg.type === 'error' && !msg.session) {
    console.warn('[Dashboard WS] server error:', msg.message || msg);
    return;
  }
  if (msg.session) {
    var t = terminals.get(msg.session);
    if (!t) return; // no card for this session, ignore
    if (msg.type === 'screen' || msg.type === 'delta') {
      // Update card title from message (claude-proxy sends rich titles)
      if (msg.title) updateTerminalTitle(msg.session, msg.title);
      // Route to main card SVG
      var obj = t.dom ? t.dom.querySelector('object') : null;
      var objReady = obj && obj.contentWindow && typeof obj.contentWindow.renderMessage === 'function';
      if (objReady) {
        routeEmbedMessageToSvg(t, obj, msg);
      } else {
        // SVG not loaded yet — queue the message, flush when object loads
        if (!t._pendingMessages) t._pendingMessages = [];
        if (msg.type === 'screen') {
          t._pendingMessages = [msg]; // screen replaces everything pending
        } else if (msg.type === 'delta') {
          // Drop deltas until a full screen is queued (same rule as live path)
          var hasScreen = t._pendingMessages.some(function(m) { return m.type === 'screen'; });
          if (hasScreen) {
            t._pendingMessages.push(msg);
          }
        }
      }
      // Populate screenLines directly so thumbnails work even when card is hidden
      // (CSS3DObject.visible=false sets display:none, preventing <object> SVG load).
      if (msg.mouseMode !== undefined) t.mouseMode = msg.mouseMode;
      if (msg.bracketedPasteMode !== undefined) t.bracketedPasteMode = msg.bracketedPasteMode;
      if (msg.sendFocusMode !== undefined) t.sendFocusMode = msg.sendFocusMode;
      if (msg.type === 'screen' && msg.lines) {
        t.screenLines = msg.lines.map(function(l) {
          var spans = l.spans || l;
          return { text: (Array.isArray(spans) ? spans : [spans]).map(function(s) { return s.text; }).join(''), spans: Array.isArray(spans) ? spans : [spans] };
        });
        t._thumbDirty = true;
      } else if (msg.type === 'delta' && msg.changed && t.screenLines) {
        for (var idx in msg.changed) {
          var lineData = msg.changed[idx];
          var spans = lineData.spans || lineData;
          t.screenLines[parseInt(idx)] = { text: (Array.isArray(spans) ? spans : [spans]).map(function(s) { return s.text; }).join(''), spans: Array.isArray(spans) ? spans : [spans] };
        }
        t._thumbDirty = true;
      }
    }
  }
}

// Colorized text thumbnails (PRD v0.5.0)
// Uses screenLines spans data directly — no SVG, no canvas, no serialization.
// Just tiny colored <span> elements in a <pre>. Zero GPU cost.
// Sequential round-robin: one thumbnail updated per tick (200ms).
// 16 cards = full cycle in 3.2s. No bursts, no idle callback dependency.

function snapshotThumbnail(sessionName) {
  var t = terminals.get(sessionName);
  if (!t || !t.thumbnail) return;

  var pre = t.thumbnail.querySelector('pre');
  if (!pre) return;

  if (!t.screenLines || !t.screenLines.length) {
    pre.style.display = 'block';
    return;  // show empty pre, will fill when data arrives
  }

  // Scale font to fit terminal rows within 80px thumbnail height
  // lineHeight is 1.2, so fontSize = 80 / (rows * 1.2)
  var rows = t.screenLines.length || 24;
  var fontSize = Math.max(1, Math.min(3, 80 / (rows * 1.2)));
  pre.style.fontSize = fontSize.toFixed(1) + 'px';

  // Build colorized HTML from spans
  var html = '';
  var lines = t.screenLines;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || !line.spans) { html += '\n'; continue; }
    for (var j = 0; j < line.spans.length; j++) {
      var span = line.spans[j];
      var styles = '';
      if (span.fg) styles += 'color:' + span.fg + ';';
      if (span.bg) styles += 'background:' + span.bg + ';';
      if (span.bold) styles += 'font-weight:bold;';
      if (span.dim) styles += 'opacity:0.5;';
      if (styles) {
        html += '<span style="' + styles + '">' + escapeHtml(span.text) + '</span>';
      } else {
        html += escapeHtml(span.text);
      }
    }
    if (i < lines.length - 1) html += '\n';
  }
  pre.innerHTML = html;
  pre.style.display = 'block';

  // Render cursor at _lastCursor position.
  // The cursor is a small highlighted block positioned over the character at (x, y).
  // Uses the same font metrics as the <pre> to calculate pixel position.
  var cursorEl = t.thumbnail.querySelector('.thumb-cursor');
  // Hide cursor when scrolled (cursor is off-screen) or when position is out of bounds.
  // When scrollOffset > 0, the viewport shows scrollback and the cursor is below the visible area.
  var cursorVisible = t._lastCursor && t._lastCursor.x != null && t._lastCursor.y != null
    && t._lastCursor.x >= 0 && t._lastCursor.y >= 0
    && t._lastCursor.x < (t.screenCols || 80) && t._lastCursor.y < rows
    && (t.scrollOffset || 0) === 0;
  if (cursorVisible) {
    if (!cursorEl) {
      cursorEl = document.createElement('div');
      cursorEl.className = 'thumb-cursor';
      cursorEl.style.cssText = 'position:absolute;background:#c5c5c5;pointer-events:none;animation:thumb-blink 1s step-end infinite;';
      t.thumbnail.appendChild(cursorEl);
    }
    // Calculate cursor position from character coordinates.
    // fontSize and lineHeight match the <pre> styling above.
    // Character width ≈ fontSize * 0.6 for monospace at this tiny scale.
    var charW = fontSize * 0.6;
    var lineH = fontSize * 1.2;
    var labelH = t.thumbnail.querySelector('.thumb-label') ? t.thumbnail.querySelector('.thumb-label').offsetHeight : 16;
    cursorEl.style.left = (2 + t._lastCursor.x * charW) + 'px';  // 2px = pre padding
    cursorEl.style.top = (labelH + 2 + t._lastCursor.y * lineH) + 'px';  // label + pre padding
    cursorEl.style.width = Math.max(1, charW) + 'px';
    cursorEl.style.height = Math.max(1, lineH) + 'px';
    cursorEl.style.display = 'block';
  } else if (cursorEl) {
    cursorEl.style.display = 'none';
  }
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Thumbnail sequencer — round-robin, skips clean cards.
// Faster tick since dirty check means most ticks are no-ops.
var _thumbSequencerIndex = 0;
var THUMB_TICK_MS = 50;

setInterval(function() {
  var keys = [...terminals.keys()];
  if (keys.length === 0) return;
  for (var attempt = 0; attempt < keys.length; attempt++) {
    _thumbSequencerIndex = _thumbSequencerIndex % keys.length;
    var name = keys[_thumbSequencerIndex];
    _thumbSequencerIndex++;
    var t = terminals.get(name);
    if (t && t._thumbDirty) {
      t._thumbDirty = false;
      snapshotThumbnail(name);
      return;
    }
  }
}, THUMB_TICK_MS);

// scheduleSnapshot kept as no-op for any remaining callers
function scheduleSnapshot() {}

function sendDashboardMessage(msg) {
  if (dashboardWs && dashboardWs.readyState === WebSocket.OPEN) {
    dashboardWs.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

var _picklistCallbacks = [];
var _lastPicklistData = null;
var _sessionsCallback = null;

function requestPicklists(callback) {
  _picklistCallbacks.push(callback);
  sendDashboardMessage({ type: 'get-picklists' });
}

function requestScreenHeal(session, pane) {
  sendDashboardMessage({ type: 'get-screen', session: session, pane: pane || '0' });
}

function sendFocusState() {
  sendDashboardMessage({ type: 'focus', sessions: [...focusedSessions] });
}

function onResize() {
  // Hide cards BEFORE resize — prevents compositor from choking on CSS3D at new size.
  for (var [, t] of terminals) {
    t.css3dObject.visible = false;
    if (t.shadowObject) t.shadowObject.visible = false;
  }

  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  resizeRenderer();
  renderer.render(scene, camera);

  if (perfMode !== 'auto') {
    // Manual mode: restore visibility per current tier
    if (perfTier >= 2) { syncPerfTier2Visibility(); }
    else { for (var [, t] of terminals) { t.css3dObject.visible = true; if (t.shadowObject) t.shadowObject.visible = true; } }
    return;
  }

  // Auto: cards are hidden, scene is clean. Reset to tier 0 (with cards still hidden,
  // so RENDER_SCALE and effects are restored without compositor load), then show cards
  // and test whether full quality is sustainable at this viewport size.
  applyPerfTier(0);
  for (var [, t] of terminals) {
    t.css3dObject.visible = true;
    if (t.shadowObject) t.shadowObject.visible = true;
  }
  renderer.render(scene, camera);
  var _frameTimes = [];
  var _prevT = performance.now();
  var _testN = 0;
  function testFrame() {
    var now = performance.now();
    _frameTimes.push(now - _prevT);
    _prevT = now;
    _testN++;
    renderer.render(scene, camera);
    if (_testN < 8) { requestAnimationFrame(testFrame); return; }
    _frameTimes.sort(function(a, b) { return a - b; });
    var worst = _frameTimes[Math.floor(_frameTimes.length * 0.9)];
    var coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    var threshold = coarse ? 20 : 35;
    console.log('[perf] resize test: p90 ' + worst.toFixed(1) + 'ms (threshold ' + threshold + '), tier ' + perfTier);
    if (worst > threshold) {
      applyPerfTier(perfTier < 1 ? 1 : 2);
      renderer.render(scene, camera);
      if (perfTier < 2) {
        _frameTimes = [];
        _prevT = performance.now();
        _testN = 0;
        requestAnimationFrame(testFrame);
      }
    }
    updatePerfIndicator();
  }
  requestAnimationFrame(testFrame);

  resetAutoPerfSampling();
}

// === Mouse ===
/** True while a menu/modal should capture pointer input and block the 3D scene. */
function isUiOverlayActive() {
  var sf = document.getElementById('session-form-panel');
  if (sf && sf.classList.contains('visible')) return true;
  var rp = document.getElementById('restart-session-panel');
  if (rp && rp.classList.contains('visible')) return true;
  var fp = document.getElementById('fork-session-panel');
  if (fp && fp.classList.contains('visible')) return true;
  var mm = document.getElementById('main-menu-dropdown');
  if (mm && mm.classList.contains('visible')) return true;
  var ld = document.getElementById('layout-dropdown');
  if (ld && ld.classList.contains('visible')) return true;
  var hp = document.getElementById('help-panel');
  if (hp && hp.classList.contains('visible')) return true;
  return false;
}

/** CSS3D layers can steal hits below fixed nav; disable scene hit-testing while overlays are open. */
function syncUiOverlayPointerBlock() {
  if (!renderer || !renderer.domElement) return;
  renderer.domElement.style.pointerEvents = isUiOverlayActive() ? 'none' : '';
}

function onMouseMove(e) {
  if (isUiOverlayActive()) {
    if (isDragging) {
      isDragging = false;
      dragMode = null;
    }
    return;
  }
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
      // Alt+drag: resize the focused terminal card from the grabbed edge/corner.
      // The opposite edge stays anchored — card resizes like a window.
      if (!activeInputSession) return;
      const t = terminals.get(activeInputSession);
      if (!t || !t._resizeEdge) return;
      // Scale mouse movement to DOM pixels. DOM is DOM_SCALEx, CSS3D renders at WORLD_SCALE,
      // but the card's apparent size depends on its Z-depth relative to camera.
      // Use the ratio of card DOM width to its screen bounding rect width.
      const rect = t.dom.getBoundingClientRect();
      const edge = t._resizeEdge;
      const currentW = parseInt(t.dom.style.width) || 1280;
      const currentH = parseInt(t.dom.style.height) || 992;
      const scaleF = rect.width > 10 ? currentW / rect.width : DOM_SCALE;
      let newW = currentW;
      let newH = currentH;

      // Apply dx/dy only to the grabbed edges
      if (edge.right) newW = Math.max(640, currentW + dx * scaleF);
      if (edge.left)  newW = Math.max(640, currentW - dx * scaleF);
      if (edge.bottom) newH = Math.max(496, currentH + dy * scaleF);
      if (edge.top)    newH = Math.max(496, currentH - dy * scaleF);

      t.dom.style.width = newW + 'px';
      t.dom.style.height = newH + 'px';
      const inner = t.dom.querySelector('.terminal-inner');
      if (inner) {
        inner.style.width = newW + 'px';
        inner.style.height = newH + 'px';
      }

      // Anchor the opposite edge by shifting the 3D position.
      // CSS3DObject origin is center, so changing width shifts both edges equally.
      // To keep the opposite edge fixed, move the card by half the size change.
      // World units = DOM pixels * WORLD_SCALE (CSS3DObject scale)
      const dw = (newW - currentW) * WORLD_SCALE;
      const dh = (newH - currentH) * WORLD_SCALE;
      if (edge.right && !edge.left)  { t.currentPos.x += dw / 2; t.targetPos.x = t.currentPos.x; }
      if (edge.left && !edge.right)  { t.currentPos.x -= dw / 2; t.targetPos.x = t.currentPos.x; }
      if (edge.bottom && !edge.top)  { t.currentPos.y -= dh / 2; t.targetPos.y = t.currentPos.y; }
      if (edge.top && !edge.bottom)  { t.currentPos.y += dh / 2; t.targetPos.y = t.currentPos.y; }
      t.css3dObject.position.set(t.currentPos.x, t.currentPos.y, t.currentPos.z);

      // Save as user's preferred size and set col/row ratio for +/- scaling.
      t.baseCardW = newW;
      t.baseCardH = newH;
      var m = getMeasuredCellSize(t);
      var cw = m ? m.cellW : SVG_CELL_W;
      var ch = m ? m.cellH : SVG_CELL_H;
      t._origColRowRatio = (newW / cw) / ((newH - HEADER_H) / ch);
      t._userPositioned = true; // prevent layout from overriding user's resize
    }
  }
}

function onMouseDown(e) {
  // Reset drag distance on every mousedown — prevents stale values from
  // previous interactions causing wasDrag() to return true on fresh clicks.
  dragDistance = 0;
  if (e.target.closest && e.target.closest('#top-bar')) return;
  if (isUiOverlayActive()) {
    syncUiOverlayPointerBlock();
    return;
  }
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
          // Detect which edge/corner was grabbed based on cursor position within card.
          // Edge zone = 20% of card dimension from each edge.
          const rect = rt.dom.getBoundingClientRect();
          const fx = (e.clientX - rect.left) / rect.width;  // 0=left, 1=right
          const fy = (e.clientY - rect.top) / rect.height;  // 0=top, 1=bottom
          const edgeZone = 0.2;
          rt._resizeEdge = {
            left:   fx < edgeZone,
            right:  fx > (1 - edgeZone),
            top:    fy < edgeZone,
            bottom: fy > (1 - edgeZone)
          };
          // If grab is in the interior (no edge), default to bottom-right
          if (!rt._resizeEdge.left && !rt._resizeEdge.right && !rt._resizeEdge.top && !rt._resizeEdge.bottom) {
            rt._resizeEdge.right = true;
            rt._resizeEdge.bottom = true;
          }
          // Save the card's current 3D position for anchoring
          rt._resizeStartPos = rt.currentPos ? { ...rt.currentPos } : { x: 0, y: 0, z: 0 };
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
  var t = e.target;
  // Native cut/copy/paste and spelling UI for real form fields (session form, login, etc.)
  if (t && t.closest) {
    if (t.closest('input, textarea, select, label')) {
      return;
    }
  }
  if (t && t.isContentEditable && t !== _pasteTarget && !_pasteTarget.contains(t)) {
    return;
  }
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
  syncUiOverlayPointerBlock();
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Control') ctrlHeld = true;
  if (e.key === 'Alt') altHeld = true;
});
document.addEventListener('keyup', function(e) {
  if (e.key === 'Control') ctrlHeld = false;
  if (e.key === 'Alt') altHeld = false;

  // Shift release = keyboard selection complete (same lifecycle as mouseup)
  if (e.key === 'Shift' && selMode === 'keyboard' && selStart && selEnd) {
    var kbT = activeInputSession ? terminals.get(activeInputSession) : null;
    if (!kbT) { clearSel(); selMode = null; return; }

    // Auto-copy to clipboard
    var kbText = getSelectedTextFromSvg(kbT);
    if (kbText) copyToClipboard(kbText);

    // Flash bright then fade out over 2 seconds
    var kbLayer = getSelOverlay(kbT);
    if (kbLayer && kbLayer.children.length > 0) {
      for (var ki = 0; ki < kbLayer.children.length; ki++) {
        kbLayer.children[ki].setAttribute('fill', 'rgba(200, 200, 255, 0.6)');
      }
      selMode = 'keyboard-fading';
      var kbFadeStart = performance.now();
      function fadeKbSel() {
        var kbElapsed = performance.now() - kbFadeStart;
        var kbProgress = Math.min(1, kbElapsed / 2000);
        var kbOpacity = 0.6 * (1 - kbProgress);
        for (var kj = 0; kj < kbLayer.children.length; kj++) {
          kbLayer.children[kj].setAttribute('opacity', String(kbOpacity));
        }
        if (kbProgress < 1) {
          requestAnimationFrame(fadeKbSel);
        } else {
          if (selMode === 'keyboard-fading') {
            clearSel();
            selMode = null;
          }
        }
      }
      requestAnimationFrame(fadeKbSel);
    } else {
      clearSel();
      selMode = null;
    }
  }
});
window.addEventListener('blur', function() {
  ctrlHeld = false; altHeld = false;
  if (selMode === 'keyboard') { clearSel(); selMode = null; }
});

let _zoomedSession = null; // which terminal is currently zoomed in multi-focus

function onKeyDown(e) {
  if (e.key === 'Escape') {
    const sessionPanel = document.getElementById('session-form-panel');
    if (sessionPanel && sessionPanel.classList.contains('visible')) {
      closeSessionFormPanel();
      e.preventDefault();
      return;
    }
    const restartPanel = document.getElementById('restart-session-panel');
    if (restartPanel && restartPanel.classList.contains('visible')) {
      closeRestartSessionPanel();
      e.preventDefault();
      return;
    }
    const forkPanel = document.getElementById('fork-session-panel');
    if (forkPanel && forkPanel.classList.contains('visible')) {
      closeForkSessionPanel();
      e.preventDefault();
      return;
    }
    const panel = document.getElementById('help-panel');
    if (panel.classList.contains('visible')) {
      panel.classList.remove('visible');
      syncUiOverlayPointerBlock();
    } else if (activeInputSession) {
      // Terminal has input focus — send Escape to the terminal.
      const t = terminals.get(activeInputSession);
      if (t) t.sendInput({ specialKey: 'Escape' });
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
    if (!_zoomedSession && activeInputSession && focusedSessions.has(activeInputSession)) {
      // First Shift+Tab: zoom to the currently active card, not the next one
      _zoomedSession = activeInputSession;
    } else {
      // Subsequent Shift+Tab: cycle to next card
      const currentIdx = _zoomedSession ? names.indexOf(_zoomedSession) : -1;
      const nextIdx = (currentIdx + 1) % names.length;
      _zoomedSession = names[nextIdx];
    }
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
  const worldH = (t.baseCardH || 992) * WORLD_SCALE;
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

  // First check server-tagged URLs
  let offset = 0;
  for (let i = 0; i < lineObj.spans.length; i++) {
    const s = lineObj.spans[i];
    if (col >= offset && col < offset + s.text.length) {
      if (s.url) return s.url;
      break;
    }
    offset += s.text.length;
  }

  // Fallback: client-side URL detection in the full line text.
  // Needed for claude-proxy sessions where screen-renderer.ts doesn't tag URLs.
  const fullLine = lineObj.spans.map(s => s.text).join('');
  const urlRegex = /https?:\/\/[^\s<>"'\])]+/g;
  let match;
  while ((match = urlRegex.exec(fullLine)) !== null) {
    let url = match[0];
    // Strip trailing punctuation
    while (/[.,;:!?)}\]]$/.test(url)) url = url.slice(0, -1);
    const start = match.index;
    const end = start + url.length;
    if (col >= start && col < end) {
      return url;
    }
  }
  return null;
}

function onSceneClick(e) {
  if (isUiOverlayActive()) return;
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
  if (isUiOverlayActive()) return;
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
    btn.addEventListener('click', function(ev) { ev.stopPropagation(); ev.preventDefault(); fn(ev); btn.blur(); });
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
      { label: '−', title: 'Smaller text (more cols)', fn: function(ev) {
        const t = terminals.get(sessionName);
        if (t) {
          // Preserve original col/row ratio to prevent aspect drift over repeated presses.
          if (!t._origColRowRatio) t._origColRowRatio = (t.screenCols || 80) / (t.screenRows || 24);
          const newCols = Math.min(300, (t.screenCols || 80) + 4);
          const newRows = Math.max(5, Math.min(100, Math.round(newCols / t._origColRowRatio)));
          // Pin the point under the click — card resizes around this anchor
          if (ev) {
            const rect = t.dom.getBoundingClientRect();
            t._resizeAnchorFx = (ev.clientX - rect.left) / rect.width;
            t._resizeAnchorFy = (ev.clientY - rect.top) / rect.height;
          }
          t._suppressRelayout = true;
          t.sendInput({ type: 'resize', cols: newCols, rows: newRows });
        }
      }},
      { label: '+', title: 'Bigger text (fewer cols)', fn: function(ev) {
        const t = terminals.get(sessionName);
        if (t) {
          if (!t._origColRowRatio) t._origColRowRatio = (t.screenCols || 80) / (t.screenRows || 24);
          const newCols = Math.max(20, (t.screenCols || 80) - 4);
          const newRows = Math.max(5, Math.min(100, Math.round(newCols / t._origColRowRatio)));
          if (ev) {
            const rect = t.dom.getBoundingClientRect();
            t._resizeAnchorFx = (ev.clientX - rect.left) / rect.width;
            t._resizeAnchorFy = (ev.clientY - rect.top) / rect.height;
          }
          t._suppressRelayout = true;
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

  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;padding:2px;font-family:monospace;font-size:2px;line-height:1.2;' +
    'overflow:hidden;height:80px;background:#1c1c1e;color:#ccc;white-space:pre;display:none;';
  item.appendChild(pre);

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
  css3dObj.scale.setScalar(WORLD_SCALE);
  // No random rotation — face camera from spawn (consistent with terminal cards)
  terminalGroup.add(css3dObj);
  dom.style.pointerEvents = 'auto';

  const shadowObj = new CSS3DObject(shadowDiv);
  shadowObj.rotation.x = -Math.PI / 2;
  shadowGroup.add(shadowObj);
  css3dObj.visible = tier2CardShouldShow(cardId);
  shadowObj.visible = tier2CardShouldShow(cardId);

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
window._terminals = terminals;
window._focusTerminal = focusTerminal;
window._activeInputSession = function() { return activeInputSession; };


/** Cached /auth/me for session form (admin-only fields). */
var _authMeCache = null;
var _sessionFormRemotesCount = 0;

async function fetchAuthMeForSessionForm() {
  try {
    var r = await fetch('/auth/me', { credentials: 'same-origin' });
    _authMeCache = r.ok ? await r.json() : null;
  } catch (e) {
    _authMeCache = null;
  }
  return _authMeCache;
}

function sessionFormIsAdmin() {
  var u = _authMeCache;
  if (!u) return false;
  if (u.linuxUser === 'root') return true;
  return !!u.canApprove;
}

function getSessionFormProfile() {
  var el = document.querySelector('input[name="sf-profile"]:checked');
  return el ? el.value : 'claude';
}

function updateSessionFormVisibility() {
  var profile = getSessionFormProfile();
  document.querySelectorAll('.profile-pill').forEach(function(lab) {
    var inp = lab.querySelector('input[type="radio"]');
    lab.classList.toggle('profile-pill--active', !!(inp && inp.checked));
  });

  var admin = sessionFormIsAdmin();
  var runRow = document.getElementById('sf-runas-row');
  if (runRow) {
    runRow.hidden = !admin;
  }

  var remoteRow = document.getElementById('sf-remote-row');
  if (remoteRow) {
    remoteRow.hidden = !(admin && profile === 'claude' && _sessionFormRemotesCount > 0);
  }

  var dangerRow = document.getElementById('sf-danger-row');
  if (dangerRow) {
    dangerRow.hidden = !(admin && profile === 'claude');
  }

  var resumeRow = document.getElementById('sf-resume-row');
  if (resumeRow) {
    resumeRow.style.display = profile === 'claude' ? 'block' : 'none';
  }

  var resumeCb = document.getElementById('sf-resume');
  var claudeId = document.getElementById('sf-claude-id');
  if (resumeCb && claudeId) {
    claudeId.disabled = !resumeCb.checked || profile !== 'claude';
  }

  var pub = document.getElementById('sf-public');
  var hid = document.getElementById('sf-hidden');
  var accessRow = document.getElementById('sf-access-row');
  if (accessRow && pub && hid) {
    accessRow.hidden = hid.checked || pub.checked;
  }
}

async function loadSessionFormPicklists() {
  return new Promise(function(resolve) {
    requestPicklists(function(data) {
      var usersEl = document.getElementById('sf-users');
      var groupsEl = document.getElementById('sf-groups');
      var remoteEl = document.getElementById('sf-remote');
      _sessionFormRemotesCount = 0;

      if (usersEl) {
        usersEl.innerHTML = '';
        (data.users || []).forEach(function(u) {
          var opt = document.createElement('option');
          opt.value = typeof u === 'string' ? u : (u.name || u);
          opt.textContent = opt.value;
          usersEl.appendChild(opt);
        });
      }
      if (groupsEl) {
        groupsEl.innerHTML = '';
        (data.groups || []).forEach(function(g) {
          var opt = document.createElement('option');
          var v = typeof g === 'string' ? g : (g.systemName || g.name);
          opt.value = v;
          opt.textContent = typeof g === 'string' ? g : (g.name || v);
          groupsEl.appendChild(opt);
        });
      }
      if (remoteEl) {
        remoteEl.innerHTML = '';
        var loc = document.createElement('option');
        loc.value = ''; loc.textContent = 'local';
        remoteEl.appendChild(loc);
        if (Array.isArray(data.remotes)) {
          _sessionFormRemotesCount = data.remotes.length;
          data.remotes.forEach(function(r) {
            var opt = document.createElement('option');
            opt.value = typeof r === 'string' ? r : (r.host || r.name || '');
            opt.textContent = typeof r === 'string' ? r : (r.label || r.name || r.host || opt.value);
            if (opt.value) remoteEl.appendChild(opt);
          });
        }
      }
      updateSessionFormVisibility();
      resolve();
    });
  });
}

function closeSessionFormPanel() {
  var panel = document.getElementById('session-form-panel');
  if (!panel) return;
  panel.classList.remove('visible');
  panel.setAttribute('aria-hidden', 'true');
  syncUiOverlayPointerBlock();
}

async function openSessionFormPanel() {
  var panel = document.getElementById('session-form-panel');
  if (!panel) return;
  await fetchAuthMeForSessionForm();
  await loadSessionFormPicklists();

  var nameEl = document.getElementById('sf-name');
  if (nameEl) nameEl.value = '';
  var claude = document.querySelector('input[name="sf-profile"][value="claude"]');
  if (claude) claude.checked = true;
  var wd = document.getElementById('sf-workdir');
  if (wd) wd.value = '';
  var h = document.getElementById('sf-hidden');
  if (h) h.checked = false;
  var vo = document.getElementById('sf-viewonly');
  if (vo) vo.checked = false;
  var p = document.getElementById('sf-public');
  if (p) p.checked = true;
  var pw = document.getElementById('sf-password');
  if (pw) pw.value = '';
  var dm = document.getElementById('sf-dangermode');
  if (dm) dm.checked = false;
  var ru = document.getElementById('sf-resume');
  if (ru) ru.checked = false;
  var cid = document.getElementById('sf-claude-id');
  if (cid) {
    cid.value = '';
    cid.disabled = true;
  }
  var ra = document.getElementById('sf-runas');
  if (ra) ra.value = '';

  ['sf-users', 'sf-groups'].forEach(function(id) {
    var sel = document.getElementById(id);
    if (sel) {
      for (var i = 0; i < sel.options.length; i++) sel.options[i].selected = false;
    }
  });

  updateSessionFormVisibility();
  panel.classList.add('visible');
  panel.setAttribute('aria-hidden', 'false');
  syncUiOverlayPointerBlock();
  if (nameEl) nameEl.focus();
}

function collectMultiSelectValues(id) {
  var sel = document.getElementById(id);
  if (!sel) return [];
  var out = [];
  for (var i = 0; i < sel.options.length; i++) {
    if (sel.options[i].selected) out.push(sel.options[i].value);
  }
  return out;
}

async function submitSessionFormFromPanel() {
  var nameEl = document.getElementById('sf-name');
  var name = nameEl && nameEl.value.trim();
  if (!name) {
    window.alert('Session name is required.');
    return;
  }

  var profile = getSessionFormProfile();
  var payload = {
    name: name,
    launchProfile: profile,
    hidden: document.getElementById('sf-hidden').checked,
    viewOnly: document.getElementById('sf-viewonly').checked,
    public: document.getElementById('sf-public').checked
  };

  var wd = document.getElementById('sf-workdir').value.trim();
  if (wd) payload.workingDir = wd;

  var runas = document.getElementById('sf-runas');
  if (sessionFormIsAdmin() && runas && runas.value.trim()) {
    payload.runAsUser = runas.value.trim();
  }

  var remoteSel = document.getElementById('sf-remote');
  var remoteRowEl = document.getElementById('sf-remote-row');
  if (remoteSel && remoteRowEl && !remoteRowEl.hidden && remoteSel.value) {
    payload.remoteHost = remoteSel.value;
  }

  if (!payload.public && !payload.hidden) {
    var au = collectMultiSelectValues('sf-users');
    var ag = collectMultiSelectValues('sf-groups');
    if (au.length) payload.allowedUsers = au;
    if (ag.length) payload.allowedGroups = ag;
  }

  var pwb = document.getElementById('sf-password').value;
  if (pwb) payload.password = pwb;

  if (profile === 'claude' && sessionFormIsAdmin()) {
    payload.dangerousSkipPermissions = document.getElementById('sf-dangermode').checked;
  }

  if (profile === 'claude') {
    var resCb = document.getElementById('sf-resume');
    if (resCb && resCb.checked) {
      payload.isResume = true;
      var cid = document.getElementById('sf-claude-id').value.trim();
      if (cid) payload.claudeSessionId = cid;
    }
  }

  sendDashboardMessage({ type: 'create-session', payload: payload });
  closeSessionFormPanel();
}

function wireSessionFormPanel() {
  var panel = document.getElementById('session-form-panel');
  if (!panel) return;

  document.getElementById('session-form-close').addEventListener('click', closeSessionFormPanel);
  document.getElementById('session-form-cancel').addEventListener('click', closeSessionFormPanel);
  document.getElementById('session-form-backdrop').addEventListener('click', closeSessionFormPanel);
  document.getElementById('session-form-submit').addEventListener('click', function() {
    void submitSessionFormFromPanel();
  });

  document.querySelectorAll('input[name="sf-profile"]').forEach(function(inp) {
    inp.addEventListener('change', updateSessionFormVisibility);
  });
  ['sf-public', 'sf-hidden'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', updateSessionFormVisibility);
  });
  var resumeCb = document.getElementById('sf-resume');
  if (resumeCb) {
    resumeCb.addEventListener('change', function() {
      var profile = getSessionFormProfile();
      var claudeId = document.getElementById('sf-claude-id');
      if (claudeId) claudeId.disabled = !resumeCb.checked || profile !== 'claude';
    });
  }

  panel.querySelector('.session-form-dialog').addEventListener('click', function(e) {
    e.stopPropagation();
  });
}

function closeRestartSessionPanel() {
  var panel = document.getElementById('restart-session-panel');
  if (!panel) return;
  panel.classList.remove('visible');
  panel.setAttribute('aria-hidden', 'true');
  syncUiOverlayPointerBlock();
}

function closeForkSessionPanel() {
  var panel = document.getElementById('fork-session-panel');
  if (!panel) return;
  panel.classList.remove('visible');
  panel.setAttribute('aria-hidden', 'true');
  syncUiOverlayPointerBlock();
}

function updateRestartPanelVisibility() {
  var pub = document.getElementById('rs-public');
  var hid = document.getElementById('rs-hidden');
  var accessRow = document.getElementById('rs-access-row');
  if (accessRow && pub && hid) accessRow.hidden = hid.checked || pub.checked;

  var deadSel = document.getElementById('rs-dead');
  var dangerRow = document.getElementById('rs-danger-row');
  if (deadSel && dangerRow) {
    var idx = deadSel.selectedIndex;
    var opt = idx >= 0 ? deadSel.options[idx] : null;
    var lp = opt && opt.getAttribute('data-profile');
    dangerRow.hidden = !(sessionFormIsAdmin() && lp === 'claude');
  }
}

function updateForkPanelVisibility() {
  var pub = document.getElementById('fk-public');
  var hid = document.getElementById('fk-hidden');
  var accessRow = document.getElementById('fk-access-row');
  if (accessRow && pub && hid) accessRow.hidden = hid.checked || pub.checked;

  var dangerRow = document.getElementById('fk-danger-row');
  if (dangerRow) dangerRow.hidden = !sessionFormIsAdmin();
}

async function loadRestartForkPicklists() {
  return new Promise(function(resolve) {
    requestPicklists(function(data) {
      _lastPicklistData = data;
      ['rs-users', 'fk-users'].forEach(function(id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = '';
        (data.users || []).forEach(function(u) {
          var opt = document.createElement('option');
          opt.value = typeof u === 'string' ? u : (u.name || u);
          opt.textContent = opt.value;
          el.appendChild(opt);
        });
      });
      ['rs-groups', 'fk-groups'].forEach(function(id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = '';
        (data.groups || []).forEach(function(g) {
          var opt = document.createElement('option');
          var v = typeof g === 'string' ? g : (g.systemName || g.name);
          opt.value = v;
          opt.textContent = typeof g === 'string' ? g : (g.name || v);
          el.appendChild(opt);
        });
      });
      resolve();
    });
  });
}

async function openRestartSessionPanel() {
  var panel = document.getElementById('restart-session-panel');
  if (!panel) return;
  await fetchAuthMeForSessionForm();
  await loadRestartForkPicklists();

  var deadSel = document.getElementById('rs-dead');
  var emptyHint = document.getElementById('rs-empty-hint');
  var rsBtn = document.getElementById('restart-session-submit');
  if (deadSel) {
    deadSel.innerHTML = '';
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '— Select a dead session —';
    deadSel.appendChild(ph);
    var list = (_lastPicklistData && Array.isArray(_lastPicklistData.deadSessions))
      ? _lastPicklistData.deadSessions : [];
    if (list.length === 0) {
      if (emptyHint) emptyHint.hidden = false;
      if (rsBtn) rsBtn.disabled = true;
    } else {
      if (emptyHint) emptyHint.hidden = true;
      if (rsBtn) rsBtn.disabled = false;
      list.forEach(function(d) {
        var id = d.id || d.tmuxId;
        if (!id) return;
        var opt = document.createElement('option');
        opt.value = id;
        var lp = d.launchProfile || '';
        opt.setAttribute('data-profile', lp);
        opt.textContent = (d.name || id) + (lp ? ' (' + lp + ')' : '');
        deadSel.appendChild(opt);
      });
      if (deadSel.options.length > 1) deadSel.selectedIndex = 1;
    }
  }

  var nameEl = document.getElementById('rs-name');
  if (nameEl) nameEl.value = '';
  var h = document.getElementById('rs-hidden');
  if (h) h.checked = false;
  var vo = document.getElementById('rs-viewonly');
  if (vo) vo.checked = false;
  var p = document.getElementById('rs-public');
  if (p) p.checked = true;
  var pw = document.getElementById('rs-password');
  if (pw) pw.value = '';
  var dm = document.getElementById('rs-dangermode');
  if (dm) dm.checked = false;
  ['rs-users', 'rs-groups'].forEach(function(id) {
    var sel = document.getElementById(id);
    if (sel) {
      for (var i = 0; i < sel.options.length; i++) sel.options[i].selected = false;
    }
  });

  updateRestartPanelVisibility();
  panel.classList.add('visible');
  panel.setAttribute('aria-hidden', 'false');
  syncUiOverlayPointerBlock();
  if (deadSel && deadSel.options.length) deadSel.focus();
}

async function openForkSessionPanel() {
  var panel = document.getElementById('fork-session-panel');
  if (!panel) return;
  await fetchAuthMeForSessionForm();
  await loadRestartForkPicklists();

  var srcSel = document.getElementById('fk-source');
  var emptyHint = document.getElementById('fk-empty-hint');
  if (srcSel) {
    srcSel.innerHTML = '';
    var list = await new Promise(function(resolve) {
      _sessionsCallback = resolve;
      sendDashboardMessage({ type: 'get-sessions' });
      setTimeout(function() { if (_sessionsCallback) { _sessionsCallback([]); _sessionsCallback = null; } }, 5000);
    });
    if (!Array.isArray(list)) list = [];
    var cpOnly = list.filter(function(s) {
      return s && s.source === 'claude-proxy';
    });
    if (cpOnly.length === 0) {
      if (emptyHint) emptyHint.hidden = false;
    } else {
      if (emptyHint) emptyHint.hidden = true;
      cpOnly.forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s.name;
        opt.textContent = (s.title || s.displayName || s.name) + ' — ' + s.name;
        srcSel.appendChild(opt);
      });
      if (activeInputSession && cpOnly.some(function(x) { return x.name === activeInputSession; })) {
        srcSel.value = activeInputSession;
      }
    }
  }

  var nameEl = document.getElementById('fk-name');
  if (nameEl) nameEl.value = '';
  var h = document.getElementById('fk-hidden');
  if (h) h.checked = false;
  var vo = document.getElementById('fk-viewonly');
  if (vo) vo.checked = false;
  var p = document.getElementById('fk-public');
  if (p) p.checked = true;
  var pw = document.getElementById('fk-password');
  if (pw) pw.value = '';
  var dm = document.getElementById('fk-dangermode');
  if (dm) dm.checked = false;
  ['fk-users', 'fk-groups'].forEach(function(id) {
    var sel = document.getElementById(id);
    if (sel) {
      for (var i = 0; i < sel.options.length; i++) sel.options[i].selected = false;
    }
  });

  updateForkPanelVisibility();
  panel.classList.add('visible');
  panel.setAttribute('aria-hidden', 'false');
  syncUiOverlayPointerBlock();
  if (srcSel && srcSel.options.length) srcSel.focus();
}

function buildRestartForkPayloadFrom(prefix) {
  var payload = {
    hidden: document.getElementById(prefix + '-hidden').checked,
    viewOnly: document.getElementById(prefix + '-viewonly').checked,
    public: document.getElementById(prefix + '-public').checked
  };

  var nm = document.getElementById(prefix + '-name');
  if (nm && nm.value.trim()) payload.name = nm.value.trim();

  if (!payload.public && !payload.hidden) {
    var usersId = prefix === 'rs' ? 'rs-users' : 'fk-users';
    var groupsId = prefix === 'rs' ? 'rs-groups' : 'fk-groups';
    var au = collectMultiSelectValues(usersId);
    var ag = collectMultiSelectValues(groupsId);
    if (au.length) payload.allowedUsers = au;
    if (ag.length) payload.allowedGroups = ag;
  }

  var pwb = document.getElementById(prefix + '-password');
  if (pwb && pwb.value) payload.password = pwb.value;

  var dangerRow = document.getElementById(prefix === 'rs' ? 'rs-danger-row' : 'fk-danger-row');
  var dm = document.getElementById(prefix === 'rs' ? 'rs-dangermode' : 'fk-dangermode');
  if (sessionFormIsAdmin() && dm && dangerRow && !dangerRow.hidden) {
    payload.dangerousSkipPermissions = dm.checked;
  }

  return payload;
}

async function submitRestartFromPanel() {
  var deadSel = document.getElementById('rs-dead');
  if (!deadSel || !deadSel.value) {
    window.alert('Choose a dead session to restart.');
    return;
  }
  var body = buildRestartForkPayloadFrom('rs');
  body.deadSessionId = deadSel.value;

  sendDashboardMessage({ type: 'restart-session', payload: body });
  closeRestartSessionPanel();
}

async function submitForkFromPanel() {
  var srcSel = document.getElementById('fk-source');
  if (!srcSel || !srcSel.value) {
    window.alert('Choose a source session to fork.');
    return;
  }
  var body = buildRestartForkPayloadFrom('fk');
  body.sourceSessionId = srcSel.value;

  sendDashboardMessage({ type: 'fork-session', payload: body });
  closeForkSessionPanel();
}

function wireRestartForkPanels() {
  var rp = document.getElementById('restart-session-panel');
  if (rp) {
    var rc = document.getElementById('restart-session-close');
    var rcan = document.getElementById('restart-session-cancel');
    var rb = document.getElementById('restart-session-backdrop');
    var rs = document.getElementById('restart-session-submit');
    if (rc) rc.addEventListener('click', closeRestartSessionPanel);
    if (rcan) rcan.addEventListener('click', closeRestartSessionPanel);
    if (rb) rb.addEventListener('click', closeRestartSessionPanel);
    if (rs) {
      rs.addEventListener('click', function() {
        void submitRestartFromPanel();
      });
    }
    var rsDead = document.getElementById('rs-dead');
    if (rsDead) rsDead.addEventListener('change', updateRestartPanelVisibility);
    ['rs-public', 'rs-hidden'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', updateRestartPanelVisibility);
    });
    rp.querySelector('.session-form-dialog').addEventListener('click', function(e) {
      e.stopPropagation();
    });
  }

  var fp = document.getElementById('fork-session-panel');
  if (fp) {
    var fc = document.getElementById('fork-session-close');
    var fcan = document.getElementById('fork-session-cancel');
    var fb = document.getElementById('fork-session-backdrop');
    var fs = document.getElementById('fork-session-submit');
    if (fc) fc.addEventListener('click', closeForkSessionPanel);
    if (fcan) fcan.addEventListener('click', closeForkSessionPanel);
    if (fb) fb.addEventListener('click', closeForkSessionPanel);
    if (fs) {
      fs.addEventListener('click', function() {
        void submitForkFromPanel();
      });
    }
    ['fk-public', 'fk-hidden'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', updateForkPanelVisibility);
    });
    fp.querySelector('.session-form-dialog').addEventListener('click', function(e) {
      e.stopPropagation();
    });
  }
}

// Titles arrive via WS screen/delta messages — no HTTP fetch needed
async function fetchTitle() { return null; }


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
// cellW/cellH: optional measured cell dimensions from the SVG renderer.
// When provided, card aspect matches the SVG viewBox exactly (no letterbox gap).
// When omitted, falls back to hardcoded SVG_CELL_W/H (approximate, pre-measurement).
function calcCardSize(cols, rows, cellW, cellH) {
  const termAspect = (cols * (cellW || SVG_CELL_W)) / (rows * (cellH || SVG_CELL_H));
  // Solve for world dimensions with target area and correct aspect:
  // worldW * worldH = TARGET_WORLD_AREA
  // worldW / worldH = termAspect
  // worldW = sqrt(TARGET_WORLD_AREA * termAspect)
  const worldW = Math.sqrt(TARGET_WORLD_AREA * termAspect);
  const worldH = TARGET_WORLD_AREA / worldW;
  // Convert world → DOM at DOM_SCALE (world * DOM_SCALE = DOM pixels)
  let cardW = Math.round(worldW * DOM_SCALE);
  let cardH = Math.round(worldH * DOM_SCALE) + HEADER_H;
  // Clamp to bounds
  cardW = Math.max(MIN_CARD_W, Math.min(MAX_CARD_W, cardW));
  cardH = Math.max(MIN_CARD_H, Math.min(MAX_CARD_H, cardH));
  return { cardW, cardH };
}

// Read measured cell dimensions from a terminal's SVG <object>.
// Returns { cellW, cellH } or null if not available yet.
function getMeasuredCellSize(t) {
  var obj = t.dom ? t.dom.querySelector('object') : null;
  if (!obj || !obj.contentDocument) return null;
  try {
    var measure = obj.contentDocument.getElementById('measure');
    if (measure) {
      var bbox = measure.getBBox();
      if (bbox.width > 0) {
        return { cellW: bbox.width / 10, cellH: bbox.height };
      }
    }
  } catch (e) {}
  return null;
}

// Reactively update a terminal's card size when cols/rows change.
// Called from _screenCallback when screenCols/screenRows differ from last known values.
//
// Three special flags modify behavior (see note 12 in header):
// - _needsMeasuredCorrection: allows through even if dims unchanged (initial measured correction)
// - _lockCardSize: skips card resize entirely (after ⊡ fit-terminal-to-card, user's card is authority)
// - _suppressRelayout: skips re-layout in _screenCallback (after +/-, keeps header under cursor)
//
// Anchor behavior: if _resizeAnchorFx/_resizeAnchorFy are set (by +/- click), the card's
// 3D position is adjusted so the clicked point stays fixed on screen during resize.
// Default anchor is center (0.5, 0.5) — no position change.
function updateCardForNewSize(t, newCols, newRows) {
  var dimsChanged = newCols !== t.screenCols || newRows !== t.screenRows;
  if (!dimsChanged && !t._needsMeasuredCorrection) return;
  t.screenCols = newCols;
  t.screenRows = newRows;
  // If card size is locked (e.g., after fit-terminal-to-card), the user's card size
  // is the authority — don't recalculate. Just update screenCols/screenRows and clear the lock.
  if (t._lockCardSize) {
    t._lockCardSize = false;
    return;
  }
  // Use measured cell dimensions from SVG when available — card aspect matches SVG exactly.
  var measured = getMeasuredCellSize(t);
  if (measured) t._needsMeasuredCorrection = false; // correction applied
  const { cardW, cardH } = measured
    ? calcCardSize(newCols, newRows, measured.cellW, measured.cellH)
    : calcCardSize(newCols, newRows);
  // Compensate 3D position so the anchor point stays fixed when resizing.
  // CSS3DObject origin is center — changing DOM size shifts all edges equally.
  // The anchor point (fx, fy) is the fraction of the card where the user clicked.
  // Default to center (0.5, 0.5) if no anchor set — no position change.
  var oldW = parseInt(t.dom.style.width) || cardW;
  var oldH = parseInt(t.dom.style.height) || cardH;
  var dwWorld = (cardW - oldW) * WORLD_SCALE;  // DOM to world: * CSS3DObject scale
  var dhWorld = (cardH - oldH) * WORLD_SCALE;
  if (t.currentPos && (dwWorld !== 0 || dhWorld !== 0)) {
    // Anchor fraction: 0.5 = center (no shift), 0 = left/top edge, 1 = right/bottom edge
    var fx = t._resizeAnchorFx != null ? t._resizeAnchorFx : 0.5;
    var fy = t._resizeAnchorFy != null ? t._resizeAnchorFy : 0.5;
    // To keep the anchor point fixed on screen: when the card grows, the anchor
    // moves away from center. Shift the 3D center in the opposite direction to compensate.
    // shift = -(fx - 0.5) * sizeChange. At center (0.5), shift=0.
    t.currentPos.x -= dwWorld * (fx - 0.5);
    t.currentPos.y += dhWorld * (fy - 0.5);  // Y inverted in 3D
    t.targetPos.x = t.currentPos.x;
    t.targetPos.y = t.currentPos.y;
    t.css3dObject.position.set(t.currentPos.x, t.currentPos.y, t.currentPos.z);
    // Clear anchor after use — next resize without explicit anchor stays centered
    t._resizeAnchorFx = null;
    t._resizeAnchorFy = null;
  }
  t.baseCardW = cardW;
  t.baseCardH = cardH;
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
  // IMPORTANT: DOM element is sized to match terminal at DOM_SCALE.
  // CSS3DObject scale WORLD_SCALE forces Chrome to rasterize at DOM_SCALEx resolution.
  // DO NOT change to 1.0 with smaller DOM — text will be blurry. See note 1.
  css3dObj.scale.setScalar(WORLD_SCALE);
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
  css3dObj.visible = tier2CardShouldShow(sessionName);
  shadowObj.visible = tier2CardShouldShow(sessionName);

  sessionOrder.push(sessionName);
  terminals.set(sessionName, {
    css3dObject: css3dObj,
    shadowObject: shadowObj,
    shadowDiv: shadowDiv,
    dom: dom,
    thumbnail: thumbnail,
    baseCardW: cardW,   // original calculated card size — restore on unfocus
    baseCardH: cardH,
    _needsMeasuredCorrection: true,  // card sized with hardcoded constants, needs correction after SVG measures font
    currentPos: { x: 0, y: 0, z: -500 },
    targetPos: { x: 0, y: 0, z: -500 },
    morphStart: clock.getElapsedTime(),
    morphFrom: { x: 0, y: 0, z: -500 },
    billboardArrival: null,  // set when terminal first reaches its ring position
    inputWs: null,
    scrollOffset: 0,
    screenLines: [],  // text content from server for copy/paste
    _thumbDirty: true,  // start dirty so sequencer attempts initial snapshot
    screenCols: cols,
    screenRows: rows,
    _screenAppliedToEmbed: false,
    sendInput: function(msg) {
      this._thumbDirty = true;  // input = activity, thumbnail should refresh
      // Try shared dashboard WebSocket first (new path)
      if (sendDashboardMessage({ session: sessionName, pane: '0', ...msg })) return;
    },
    // Unified scroll — one offset, one method. Used by mouse wheel, PgUp/PgDn, etc.
    scrollBy: function(lines) {
      this.scrollOffset = Math.max(0, this.scrollOffset + lines);
      this.sendInput({ type: 'scroll', offset: this.scrollOffset });
    },
    scrollReset: function() {
      this.scrollOffset = 0;
    }
  });

  fetchTitle(sessionName).then(function(title) {
    if (title) updateTerminalTitle(sessionName, title);
  });

  // Register screen data callback on SVG <object> once it loads.
  // This replaces what inputWs.onmessage used to do: populate screenLines
  // and call updateCardForNewSize when terminal dimensions change.
  var termObj = dom.querySelector('object');
  if (termObj) {
    termObj.addEventListener('load', function() {
      try {
        // SVG loaded — correct card size using actual measured cell dimensions.
        // Initial calcCardSize used hardcoded constants (approximate). Now that the
        // SVG has measured its font, resize the card to match the SVG's actual viewBox
        // aspect ratio. This eliminates the letterbox gap between SVG and card.
        // Use setTimeout to ensure the SVG has rendered and measured its font.
        setTimeout(function() {
          var t = terminals.get(sessionName);
          if (t) {
            var measured = getMeasuredCellSize(t);
            if (measured) {
              var corrected = calcCardSize(t.screenCols, t.screenRows, measured.cellW, measured.cellH);
              t.baseCardW = corrected.cardW;
              t.baseCardH = corrected.cardH;
              t.dom.style.width = corrected.cardW + 'px';
              t.dom.style.height = corrected.cardH + 'px';
              var inner = t.dom.querySelector('.terminal-inner');
              if (inner) {
                inner.style.width = corrected.cardW + 'px';
                inner.style.height = corrected.cardH + 'px';
              }
            }
          }
        }, 100);
        termObj.contentWindow._screenCallback = function(msg) {
          var t = terminals.get(sessionName);
          if (!t) return;
          if (msg.type === 'screen' && msg.lines) {
            if (msg.mouseMode !== undefined) t.mouseMode = msg.mouseMode;
            if (msg.bracketedPasteMode !== undefined) t.bracketedPasteMode = msg.bracketedPasteMode;
            if (msg.sendFocusMode !== undefined) t.sendFocusMode = msg.sendFocusMode;
            t.screenLines = msg.lines.map(function(l) {
              return { text: l.spans.map(function(s) { return s.text; }).join(''), spans: l.spans };
            });
            // Track dimension changes for re-layout
            var prevCols = t.screenCols;
            var prevRows = t.screenRows;
            updateCardForNewSize(t, msg.width || 80, msg.height || 24);
            // Re-layout if dimensions actually changed (not first message) and card is focused.
            // Skip re-layout if the resize was triggered by +/- buttons — card stays in place
            // so the header/buttons don't jump away from the cursor.
            if (prevCols && prevRows && (msg.width !== prevCols || msg.height !== prevRows) && focusedSessions.has(sessionName)) {
              if (t._suppressRelayout) {
                t._suppressRelayout = false;
              } else if (focusedSessions.size > 1) {
                calculateFocusedLayout();
              } else {
                focusTerminal(sessionName);
              }
            }
            if (msg.cursor) t._lastCursor = msg.cursor;
            t._thumbDirty = true;
          } else if (msg.type === 'delta' && msg.changed) {
            if (msg.mouseMode !== undefined) t.mouseMode = msg.mouseMode;
            if (msg.bracketedPasteMode !== undefined) t.bracketedPasteMode = msg.bracketedPasteMode;
            if (msg.sendFocusMode !== undefined) t.sendFocusMode = msg.sendFocusMode;
            for (var idx in msg.changed) {
              var lineData = msg.changed[idx];
              var spans = lineData.spans || lineData;
              t.screenLines[parseInt(idx)] = { text: spans.map(function(s) { return s.text; }).join(''), spans: spans };
            }
            if (msg.cursor) t._lastCursor = msg.cursor;
            t._thumbDirty = true;
          }
        };
        // Flush any messages that arrived before SVG loaded (screen before deltas)
        var t = terminals.get(sessionName);
        if (t && t._pendingMessages && t._pendingMessages.length > 0) {
          var pending = t._pendingMessages;
          t._pendingMessages = null;
          for (var p = 0; p < pending.length; p++) {
            routeEmbedMessageToSvg(t, termObj, pending[p], { skipRepaint: true });
          }
          scheduleTerminalSurfaceRepaint(termObj, t);
        } else if (t && !t._screenAppliedToEmbed) {
          // Self-heal: SVG loaded but no screen arrived — fetch current screen
          requestScreenHeal(sessionName, '0');
        }
        // Initial thumbnail snapshot once main SVG has content
        t._thumbDirty = true;
      } catch (e) {}
    });
  }
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
  if (t.sendFocusMode) t.sendInput({ type: 'input', keys: '\x1b[I' });
  // Input routed via contentWindow.sendToWs, screen data via _screenCallback
  // (single-WebSocket architecture — no second connection needed)

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
  const worldW = (t.baseCardW || 1280) * WORLD_SCALE;
  const worldH = (t.baseCardH || 992) * WORLD_SCALE;

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
  sendFocusState();
  updateTopBarVisibility();
}

// Add a terminal to the multi-focus set (ctrl+click)
function addToFocus(sessionName) {
  activeLayout = 'auto';  // reset to default layout when focus group changes
  const t = terminals.get(sessionName);
  if (!t) return;

  if (focusedSessions.has(sessionName)) {
    setActiveInput(sessionName);
    updateTopBarVisibility();
    return;
  }
  lastAddToFocusTime = performance.now();

  // Camera-only: no DOM to restore. Cards are always at base size.

  if (activeInputSession && activeInputSession !== sessionName) {
    var prevT = terminals.get(activeInputSession);
    if (prevT && prevT.sendFocusMode) prevT.sendInput({ type: 'input', keys: '\x1b[O' });
  }
  focusedSessions.add(sessionName);
  activeInputSession = sessionName;
  if (t.sendFocusMode) t.sendInput({ type: 'input', keys: '\x1b[I' });

  // Input routed via contentWindow.sendToWs, screen data via _screenCallback
  // (single-WebSocket architecture — no second connection needed)

  updateFocusStyles();
  calculateFocusedLayout();

  document.getElementById('input-bar').classList.add('visible');
  document.getElementById('input-target').textContent = activeInputSession;
  sendFocusState();
  updateTopBarVisibility();
}

// Set which focused terminal receives input
// Active terminal distinguished by gold header background only — no Z movement.
// Z-slide removed: was sliding active card forward by 25 units in multi-focus,
// caused Z-creep bugs and added complexity. Gold header (#4a4020) is sufficient.
function setActiveInput(sessionName) {
  if (!focusedSessions.has(sessionName)) return;
  activeInputSession = sessionName;
  updateFocusStyles();
  document.getElementById('input-target').textContent = sessionName;
  document.getElementById('input-bar').classList.add('visible');
  showTermControls(sessionName);
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
  if (perfTier >= 2) syncPerfTier2Visibility();
}

// Restore a single terminal to overview state
function restoreFocusedTerminal(name) {
  const term = terminals.get(name);
  if (!term) return;
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
  activeLayout = 'auto';  // reset to default layout when focus group changes
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
  sendFocusState();
  updateTopBarVisibility();
}

// Restore all focused terminals
function restoreAllFocused() {
  if (activeInputSession) {
    var blurT = terminals.get(activeInputSession);
    if (blurT && blurT.sendFocusMode) blurT.sendInput({ type: 'input', keys: '\x1b[O' });
  }
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
  if (activeInputSession) {
    var blurT = terminals.get(activeInputSession);
    if (blurT && blurT.sendFocusMode) blurT.sendInput({ type: 'input', keys: '\x1b[O' });
  }
  activeInputSession = null;
  _zoomedSession = null;
  // Remove input/highlight indicators but keep focusedSessions intact.
  for (const [name, term] of terminals) {
    term.dom.classList.remove('input-active');
    term.dom.classList.remove('faded'); // show ring cards normally
    const hdrCtrl = term.dom.querySelector('.header-controls');
    if (hdrCtrl) hdrCtrl.style.display = 'none';
  }
  hideTermControls();
  document.getElementById('input-bar').classList.remove('visible');
  // Return to group grid layout when deselecting.
  // If multiple cards are focused, re-run the layout so all cards are visible
  // in the optimized grid. This is the path back from "zoomed into one card"
  // to "seeing the whole group." Next Escape from this state unfocuses entirely.
  if (focusedSessions.size > 1) {
    calculateFocusedLayout();
  }
}

// Full unfocus: return cards to ring, camera to home position.
function unfocusTerminal() {
  activeLayout = 'auto';  // reset to default layout when focus group changes
  // Clear layout slot assignments
  for (var entry of terminals) {
    entry[1]._layoutSlot = null;
    entry[1]._layoutFit = null;
  }
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

  if (perfTier >= 2) syncPerfTier2Visibility();

  sendFocusState();
  updateTopBarVisibility();
}

// === Animation Loop ===
function animate() {
  requestAnimationFrame(animate);

  // Skip rendering when tab is hidden — saves 100% GPU/CPU in background
  if (document.hidden) return;

  const time = clock.getElapsedTime();
  clock.getDelta(); // advance clock internal state (side effect needed for accurate getElapsedTime)

  if (perfMode === 'auto' && _perfCheckPhase < 2) {
    if (_perfCheckPhase === 0) {
      _perfCheckStart = performance.now();
      _perfCheckPhase = 1;
    }
    if (_perfCheckPhase === 1) {
      var now = performance.now();
      if (_perfFrameTimes._lastTime !== undefined) {
        var dt = now - _perfFrameTimes._lastTime;
        if (dt <= _perfMaxFrameGapMs && !document.hidden) {
          _perfFrameTimes.push(dt);
        }
      }
      _perfFrameTimes._lastTime = now;
      if (now - _perfCheckStart > 3000) {
        var times = _perfFrameTimes.slice(Math.floor(_perfFrameTimes.length * 0.33));
        var avg = times.length > 0 ? times.reduce(function(a, b) { return a + b; }, 0) / times.length : 16;
        console.log('[perf] avg frame time: ' + avg.toFixed(1) + 'ms (' + (1000 / avg).toFixed(0) + ' fps)');
        var coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
        var tier2Ms = coarse ? 42 : 50;
        if (avg > tier2Ms) {
          applyPerfTier(2);
        } else if (avg > 33) {
          applyPerfTier(1);
        }
        _perfCheckPhase = 2;
      }
    }
  }

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

  // Per-terminal updates — perf tier >= 1 skips float, billboard slerp drift, shadow/specular work (mobile/CSS3D)
  var lowMotion = perfTier >= 1;
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

    let floatY = 0, floatX = 0;
    if (!lowMotion && !focusedSessions.has(name)) {
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

      if (!lowMotion) {
        _driftEuler.set(
          Math.sin(time * 0.3 + idx * 1.5) * 0.03,
          Math.cos(time * 0.2 + idx * 1.7) * 0.04,
          0
        );
        _driftQuat.setFromEuler(_driftEuler);
        _targetQuat.multiply(_driftQuat);
        t.css3dObject.quaternion.slerp(_targetQuat, BILLBOARD_SLERP);
      } else {
        t.css3dObject.quaternion.copy(_targetQuat);
      }
    }

    if (perfTier === 0) {
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

      const specular = t.dom.querySelector('.specular-overlay');
      if (specular) {
        _panelNormal.set(0, 0, 1).applyQuaternion(t.css3dObject.quaternion);
        const dot = _panelNormal.dot(LIGHT_DIR);
        const intensity = Math.max(0, dot) * 0.4;
        specular.style.background = 'linear-gradient(135deg, rgba(255,255,255,' + intensity.toFixed(3) + ') 0%, transparent 60%)';
      }
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
function shouldSendKeysToTerminal() {
  if (isUiOverlayActive()) return false;
  var a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return true;
  var tag = a.tagName && String(a.tagName).toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (tag === 'INPUT') {
    var type = String(a.type || '').toLowerCase();
    if (type === 'hidden' || type === 'button' || type === 'submit' || type === 'reset' || type === 'file' || type === 'range' || type === 'color') return true;
    return false;
  }
  if (tag === 'BUTTON' || tag === 'A') return false;
  if (a.isContentEditable) {
    if (a === _pasteTarget || _pasteTarget.contains(a)) return true;
    return false;
  }
  return true;
}

document.addEventListener('keydown', function(e) {
  if (!shouldSendKeysToTerminal()) return;
  if (!activeInputSession) return;
  if (focusedSessions.size === 0) return;

  // Let browser shortcuts through
  if ((e.ctrlKey || e.metaKey) && ['t', 'w', 'n', 'r', 'v'].includes(e.key.toLowerCase())) return;
  if (e.altKey && e.key === 'F4') return;
  if (e.key === 'F12') return;

  // Don't interfere with bare modifier presses
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;

  // Escape: clear keyboard selection first, then unfocus
  if (e.key === 'Escape') {
    if (selMode === 'keyboard' || selMode === 'keyboard-fading') {
      clearSel();
      selMode = null;
      e.preventDefault();
      return;
    }
    return;
  }

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
    selMode = 'keyboard';

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

  // Ctrl combos — selection is auto-copied on mouseup, no persistent selection to check
  if (e.ctrlKey && !e.altKey && e.key.length === 1) {
    t.sendInput({ type: 'input', keys: e.key.toLowerCase(), ctrl: true });
    return;
  }

  // Alt combos — ESC + key (word navigation in bash, emacs bindings, etc.)
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
    e.preventDefault();
    t.sendInput({ type: 'input', keys: e.key, alt: true });
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
  if (!shouldSendKeysToTerminal()) return;
  if (!activeInputSession) return;
  if (focusedSessions.size === 0) return;
  e.preventDefault();
  const text = e.clipboardData.getData('text');
  if (text) {
    const t = terminals.get(activeInputSession);
    if (t) {
      var payload = text;
      if (t.bracketedPasteMode) payload = '\x1b[200~' + text + '\x1b[201~';
      t.sendInput({ type: 'input', keys: payload });
    }
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
let selMode = null;    // 'mouse' | 'keyboard' | 'mouse-fading' | 'keyboard-fading' | null

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
// Send SGR-encoded mouse event to the PTY.
// SGR format: ESC [ < Cb ; Cx ; Cy M (press) or m (release)
// Coordinates are 1-based. Button: 0=left, 1=middle, 2=right.
function sendMouseEvent(t, button, col, row, pressed, modifiers) {
  var cb = button;
  if (modifiers) {
    if (modifiers.shift) cb |= 4;
    if (modifiers.alt) cb |= 8;
    if (modifiers.ctrl) cb |= 16;
  }
  var seq = '\x1b[<' + cb + ';' + (col + 1) + ';' + (row + 1) + (pressed ? 'M' : 'm');
  t.sendInput({ type: 'input', keys: seq });
}

function clearSel() {
  // Clear SVG sel-layer rects via contentDocument (selOverlay is unreliable)
  if (activeInputSession) {
    var ct = terminals.get(activeInputSession);
    if (ct) {
      var layer = getSelOverlay(ct);
      if (layer) while (layer.firstChild) layer.removeChild(layer.firstChild);
    }
  }
  // Also try the selTerminal if different
  if (selTerminal) {
    var layer2 = getSelOverlay(selTerminal);
    if (layer2) while (layer2.firstChild) layer2.removeChild(layer2.firstChild);
  }
  selTerminal = null;
  selStart = null;
  selEnd = null;
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
  if (e.target.closest && e.target.closest('#top-bar')) return;
  if (isUiOverlayActive()) return;
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

  // Don't start selection if click is outside the focused terminal's card body
  var selObj = t.dom ? t.dom.querySelector('object') : null;
  if (selObj) {
    var selObjRect = selObj.getBoundingClientRect();
    if (e.clientX < selObjRect.left || e.clientX > selObjRect.right ||
        e.clientY < selObjRect.top || e.clientY > selObjRect.bottom) return;
  }

  const cell = screenToCell(e, t);
  if (!cell) return;

  e.preventDefault();
  e.stopPropagation();
  // Clear any existing keyboard selection
  if (selMode === 'keyboard' || selMode === 'keyboard-fading') {
    clearSel();
  }
  // Store pixel start for minimum drag distance check
  t._selDragStartX = e.clientX;
  t._selDragStartY = e.clientY;
  selMode = 'mouse';
  selTerminal = t;
  selStart = cell;
  selEnd = cell;
  drawSelHighlight(t);
}, true); // capture phase to intercept before orbit drag

document.addEventListener('mousemove', function(e) {
  if (!selTerminal || !selStart) return;
  if (isUiOverlayActive()) {
    clearSel();
    return;
  }
  selEnd = screenToCell(e, selTerminal);
  if (selEnd) drawSelHighlight(selTerminal);
});

document.addEventListener('mouseup', function(e) {
  if (!selTerminal || !selStart) return;
  selEnd = screenToCell(e, selTerminal);

  // Minimum drag distance — prevent accidental 1-char selections from clicks.
  // Require > 1.5 cell widths of pixel movement before treating as a real selection.
  var isRealSelection = false;
  var t2 = terminals.get(activeInputSession);
  if (selStart && selEnd && t2) {
    var dx = e.clientX - (t2._selDragStartX || 0);
    var dy = e.clientY - (t2._selDragStartY || 0);
    var pixelDist = Math.sqrt(dx * dx + dy * dy);
    var renderInfo = getTermRenderInfo(t2);
    var minDragPx = renderInfo ? renderInfo.cellW * 1.5 : 15;
    isRealSelection = pixelDist > minDragPx;
  }

  if (!isRealSelection) {
    // Click (not drag). Behavior depends on whether the app enabled mouse tracking.
    if (selStart && activeInputSession) {
      var ct = terminals.get(activeInputSession);
      if (ct && ct.mouseMode && ct.mouseMode !== 'none') {
        sendMouseEvent(ct, 0, selStart.col, selStart.row, true, {
          shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey
        });
        sendMouseEvent(ct, 0, selStart.col, selStart.row, false, {
          shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey
        });
      }
      // mouseMode 'none' or unset: no input sent — click is local-only (selection/focus)
    }
    clearSel();
    selTerminal = null;
    return;
  }

  // Real selection — draw final highlight, copy to clipboard, then fade out
  if (selEnd) drawSelHighlight(selTerminal);

  var text = getSelectedTextFromSvg(selTerminal);
  if (text) {
    copyToClipboard(text);
  }

  // Flash bright then fade out over 2 seconds
  var fadeTerminal = selTerminal;
  var layer = getSelOverlay(fadeTerminal);
  if (layer && layer.children.length > 0) {
    // Flash to bright
    for (var fi = 0; fi < layer.children.length; fi++) {
      layer.children[fi].setAttribute('fill', 'rgba(200, 200, 255, 0.6)');
    }
    // Fade out
    var fadeStart = performance.now();
    selMode = 'mouse-fading';
    function fadeSel() {
      var elapsed = performance.now() - fadeStart;
      var progress = Math.min(1, elapsed / 2000);
      var opacity = 0.6 * (1 - progress);
      for (var fj = 0; fj < layer.children.length; fj++) {
        layer.children[fj].setAttribute('opacity', String(opacity));
      }
      if (progress < 1) {
        requestAnimationFrame(fadeSel);
      } else {
        // Don't clear if keyboard selection started during mouse fade
        if (selMode === 'mouse-fading') {
          clearSel();
          selMode = null;
        }
      }
    }
    requestAnimationFrame(fadeSel);
  } else {
    clearSel();
    selMode = null;
  }

  // Stop the selection drag — critical. Without this, mousemove keeps updating selEnd
  // after mouseup, causing the "keeps dragging after release" bug.
  selTerminal = null;
  suppressNextClick = true;
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
      perfMode: perfMode,
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
    sendDashboardMessage({ type: 'save-layout', layout: state });
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

  // === SSE command channel ===
  var eventSource = new EventSource('/api/events');
  eventSource.addEventListener('reload', function() {
    console.log('[SSE] reload command received');
    location.reload();
  });
  eventSource.addEventListener('dom', function(e) {
    try {
      var data = JSON.parse(e.data);
      var el = document.getElementById(data.id);
      if (el) el.innerHTML = data.html;
    } catch (err) {}
  });
  eventSource.addEventListener('throttle', function(e) {
    var data = JSON.parse(e.data);
    console.log('[SSE] throttle interval:', data.interval, 'ms');
  });
  eventSource.onopen = function() { console.log('[SSE] connected'); };
  eventSource.onerror = function() { console.log('[SSE] disconnected, auto-reconnecting...'); };
})();
