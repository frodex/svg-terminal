# Layout System Phase 1 — Named Layouts with Position-Only Placement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the masonry bin-packer with named layouts (2up-h, 3col, 2x2, etc.) that position focused cards into predefined slot maps using frustum projection. No card or terminal mutations in this phase — position-only via Z-depth.

**Architecture:** A layout registry defines named slot maps (percentage-based rectangles within usable space). When the user selects a layout, cards are assigned to slots (largest terminal → largest slot) and positioned via the same frustum projection math that `calculateFocusedLayout` already uses. The existing masonry algorithm becomes the `auto` layout. A keyboard shortcut (L key when focused) cycles through layouts.

**Tech Stack:** Pure JS in dashboard.mjs. No new dependencies. Puppeteer for E2E tests.

**Spec:** `docs/superpowers/specs/2026-04-01-layout-system-design.04.md`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `dashboard.mjs` | All layout logic (registry, assignment, frustum projection, UI) | Modify |
| `dashboard.css` | Layout indicator styling | Modify |
| `test-layouts.mjs` | Puppeteer E2E test for layout switching | Create |

All layout code lives in `dashboard.mjs` — no new files for the layout logic itself. This follows the existing pattern where all dashboard features are in one file. The layout registry is a const data structure, not a separate module.

---

### Task 1: Layout Registry — Slot Map Data Structure

**Files:**
- Modify: `dashboard.mjs` (add after the `RING` constant block, ~line 93)

- [ ] **Step 1: Define the LAYOUTS registry**

Add this after the `RING` constant block (around line 93, before `// === Key Translation`):

```javascript
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
  }
};

// Layout order for cycling with L key
const LAYOUT_ORDER = ['auto', '2up-h', '2up-v', '1main-2side', '3col', '2x2', '2top-1bottom', '1main-4mini'];

// Current active layout for the focus group
let activeLayout = 'auto';
```

- [ ] **Step 2: Verify no syntax errors**

Run: `node -e "import('/srv/svg-terminal/dashboard.mjs')" 2>&1 | head -5`
Expected: No syntax errors (may show runtime errors about DOM — that's fine, we're checking parse only)

Actually, dashboard.mjs is a browser module. Instead:

Run: `node --check /srv/svg-terminal/dashboard.mjs 2>&1 || echo 'syntax check not available for ESM with imports'`

If that doesn't work, just verify manually that the server still serves the page:

Run: `curl -s http://localhost:3200/ | head -5`
Expected: `<!DOCTYPE html>`

- [ ] **Step 3: Commit**

```bash
git add dashboard.mjs
git commit -m "feat(layout): add LAYOUTS registry with 8 named slot maps"
```

---

### Task 2: Slot-Based Layout Function

**Files:**
- Modify: `dashboard.mjs` — add `calculateSlotLayout()` function near `calculateFocusedLayout()`

This is the core function. It takes a slot map and a list of focused terminals, assigns cards to slots, and computes 3D positions using the same frustum projection as the existing masonry code.

- [ ] **Step 1: Add the n-stacked slot generator**

Add this right after the `LAYOUTS` const block:

```javascript
// Generate n-stacked layout dynamically — N equal rows, full width.
// Cards are centered within slot at comfortable aspect (not letterboxed to full width).
function generateNStacked(n) {
  const slots = [];
  const h = 100 / n;
  for (let i = 0; i < n; i++) {
    slots.push({ x: 0, y: h * i, w: 100, h: h });
  }
  return slots;
}
```

- [ ] **Step 2: Add the card-to-slot assignment function**

```javascript
// Assign cards to slots: largest terminal (by cell count) → largest slot (by area).
// Returns array of { name, slot } pairs. Excess cards (more than slots) get slot = null.
function assignCardsToSlots(cards, slots) {
  // Sort cards by cell count descending
  const sorted = [...cards].sort((a, b) => b.cells - a.cells);
  // Sort slot indices by area descending
  const slotOrder = slots.map((s, i) => ({ index: i, area: s.w * s.h }))
    .sort((a, b) => b.area - a.area);
  
  const assignments = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i < slotOrder.length) {
      assignments.push({ name: sorted[i].name, slotIndex: slotOrder[i].index, slot: slots[slotOrder[i].index] });
    } else {
      assignments.push({ name: sorted[i].name, slotIndex: -1, slot: null }); // overflow
    }
  }
  return assignments;
}
```

- [ ] **Step 3: Add the slot-based layout function**

Add this right after `calculateFocusedLayout()`:

```javascript
// Position cards into named layout slots using frustum projection.
// Same projection math as calculateFocusedLayout but with predefined slot positions
// instead of masonry bin-packing.
//
// Slot positions are percentages of usable space (availW × availH).
// Each card is placed at the Z-depth where its world size fills its slot's screen rectangle.
// Card aspect ratio is preserved — card is centered in slot if aspects don't match.
function calculateSlotLayout(slots) {
  const now = clock.getElapsedTime();
  const count = focusedSessions.size;
  if (count === 0) return;

  const screenW = window.innerWidth;
  const screenH = window.innerHeight;
  const availW = screenW - SIDEBAR_WIDTH;
  const availH = screenH - STATUS_BAR_H;

  // Build card info — same as masonry path
  const names = [...focusedSessions];
  const cards = [];
  for (const name of names) {
    const t = terminals.get(name);
    if (t && t._userPositioned) continue;
    const cols = t ? t.screenCols || 80 : 80;
    const rows = t ? t.screenRows || 24 : 24;
    const cells = cols * rows;
    const m = t ? getMeasuredCellSize(t) : null;
    const aspect = (cols * (m ? m.cellW : SVG_CELL_W)) / (rows * (m ? m.cellH : SVG_CELL_H));
    const worldW = (t ? t.baseCardW || 1280 : 1280) * 0.25;
    const worldH = (t ? t.baseCardH || 992 : 992) * 0.25;
    cards.push({ name, cols, rows, cells, aspect, worldW, worldH });
  }

  if (cards.length === 0) return;

  // Assign cards to slots
  const assignments = assignCardsToSlots(cards, slots);

  // Frustum projection setup
  const vFov = camera.fov * DEG2RAD;
  const halfTan = Math.tan(vFov / 2);

  const placements = [];

  for (const a of assignments) {
    const t = terminals.get(a.name);
    if (!t) continue;
    const card = cards.find(c => c.name === a.name);
    if (!card) continue;

    if (!a.slot) {
      // Overflow card — no slot assigned. Position below the layout area.
      // TODO Phase 2: shrink layout and place overflow cards in freed space.
      continue;
    }

    // Convert slot percentages to pixel positions within usable space
    const slotPxX = (a.slot.x / 100) * availW;
    const slotPxY = (a.slot.y / 100) * availH;
    const slotPxW = (a.slot.w / 100) * availW;
    const slotPxH = (a.slot.h / 100) * availH;

    // Card must fit within slot while preserving its aspect ratio (letterbox).
    // Automation default aspect bounds: 16:9 to 9:16.
    const slotAspect = slotPxW / slotPxH;
    let fitW, fitH;
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
    const cx = slotPxX + slotPxW / 2;
    const cy = slotPxY + slotPxH / 2;

    // Screen fraction this card occupies (for frustum depth calc)
    const fracH = fitH / screenH;
    const depth = card.worldH / (fracH * 2 * halfTan);

    placements.push({ name: a.name, cx, cy, fitW, fitH, depth, worldW: card.worldW, worldH: card.worldH });
  }

  if (placements.length === 0) return;

  // Camera Z: far enough back that all focused cards are in front of the ring
  const maxDepth = Math.max(...placements.map(p => p.depth));
  const minCardZ = 150;
  const camZ = Math.max(FOCUS_DIST, maxDepth + minCardZ);

  // Position each card in 3D
  for (const p of placements) {
    const t = terminals.get(p.name);
    if (!t) continue;

    const cardZ = camZ - p.depth;
    const visHAtDepth = 2 * p.depth * halfTan;
    const px2w = visHAtDepth / screenH;
    const wx = (p.cx - screenW / 2) * px2w;
    const wy = -(p.cy - screenH / 2) * px2w;

    t.morphFrom = { ...t.currentPos };
    t._layoutZ = cardZ;
    t.targetPos = { x: wx, y: wy, z: cardZ };
    t.morphStart = now;
  }

  // Camera tween
  const avgZ = placements.reduce((s, p) => s + (camZ - p.depth), 0) / placements.length;
  cameraTween = {
    from: camera.position.clone(),
    to: new THREE.Vector3(0, 0, camZ),
    lookFrom: currentLookTarget.clone(),
    lookTo: new THREE.Vector3(0, 0, avgZ),
    start: now,
    duration: 1.0
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add dashboard.mjs
git commit -m "feat(layout): add calculateSlotLayout and card-to-slot assignment"
```

---

### Task 3: Wire Layout Selection into calculateFocusedLayout

**Files:**
- Modify: `dashboard.mjs` — change `calculateFocusedLayout` to dispatch to slot layout when a named layout is active

- [ ] **Step 1: Add layout dispatcher at the top of calculateFocusedLayout**

Find `function calculateFocusedLayout()` (around line 404) and add the dispatcher at the beginning, right after `if (count === 0) return;`:

```javascript
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
  // 'auto' or unknown layout — fall through to masonry bin-packer below
  // ... (rest of existing masonry code)
```

This means every call site that currently calls `calculateFocusedLayout()` automatically uses the active layout. No call site changes needed.

- [ ] **Step 2: Handle n-stacked dynamically**

Also add before the dispatch, handle the case where the user has more cards than the largest fixed layout and n-stacked makes sense:

Actually, n-stacked is invoked explicitly (not auto-selected). We'll add it as a layout option when the user cycles. For now, just add it to the dispatcher:

```javascript
  // Special case: n-stacked generates slots dynamically based on card count
  if (activeLayout === 'n-stacked') {
    calculateSlotLayout(generateNStacked(count));
    return;
  }
```

Add 'n-stacked' to LAYOUT_ORDER:

```javascript
const LAYOUT_ORDER = ['auto', '2up-h', '2up-v', '1main-2side', '3col', '2x2', '2top-1bottom', '1main-4mini', 'n-stacked'];
```

And add the entry to LAYOUTS:

```javascript
  'n-stacked': {
    name: 'Stacked Rows',
    slots: null  // generated dynamically by generateNStacked(count)
  }
```

- [ ] **Step 3: Commit**

```bash
git add dashboard.mjs
git commit -m "feat(layout): wire named layouts into calculateFocusedLayout dispatcher"
```

---

### Task 4: Keyboard Shortcut to Cycle Layouts

**Files:**
- Modify: `dashboard.mjs` — add L key handler in the keydown handler
- Modify: `dashboard.css` — add layout indicator styling

- [ ] **Step 1: Add layout cycling function**

Add near the layout registry:

```javascript
// Cycle to the next layout in LAYOUT_ORDER.
// Only works when terminals are focused. Triggers re-layout immediately.
function cycleLayout() {
  const idx = LAYOUT_ORDER.indexOf(activeLayout);
  activeLayout = LAYOUT_ORDER[(idx + 1) % LAYOUT_ORDER.length];
  calculateFocusedLayout();
  showLayoutIndicator();
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
```

- [ ] **Step 2: Add L key to keydown handler**

Find the keydown handler section (search for `// Escape: clear keyboard selection` around line 2500+). In the same key handling block, add:

```javascript
  // L key: cycle layout (only when focused, no modifier keys)
  if (e.key === 'l' && !e.ctrlKey && !e.altKey && !e.shiftKey && focusedSessions.size > 0) {
    cycleLayout();
    e.preventDefault();
    return;
  }
```

Important: this must be BEFORE the section that sends keystrokes to tmux (the `if (activeInputSession)` block), otherwise 'l' gets sent to the terminal. Place it in the "focused but not typing" section — near where Escape is handled.

Actually, 'l' would conflict with typing in the terminal. We need a key that doesn't conflict. Better options:

- `Tab` (already used for Shift+Tab cycle-zoom, but plain Tab goes to terminal)
- A number key like `1`-`8` to select layout directly
- `Ctrl+L` (but that's "clear terminal" in most shells)

Best approach: use **number keys 1-8** when focused to select layouts directly, and **0** for auto:

```javascript
  // Number keys 0-8: select layout directly (only when focused, no modifiers, no active input)
  if (e.key >= '0' && e.key <= '8' && !e.ctrlKey && !e.altKey && !e.shiftKey
      && focusedSessions.size > 0 && !activeInputSession) {
    var layoutIdx = parseInt(e.key);
    if (layoutIdx < LAYOUT_ORDER.length) {
      activeLayout = LAYOUT_ORDER[layoutIdx];
      calculateFocusedLayout();
      showLayoutIndicator();
    }
    e.preventDefault();
    return;
  }
```

Wait — `!activeInputSession` won't work because when you focus a terminal, it becomes the active input. The number keys would go to the terminal.

Better: use **Shift+number** (Shift+1 through Shift+8). In a terminal, Shift+number produces `!@#$%^&*` — not standard commands. And we can intercept before they reach tmux:

```javascript
  // Shift+1-8: select layout (only when focused).
  // Shift+0 or Shift+`: return to auto layout.
  // These don't conflict with terminal input since Shift+number produces symbols.
  if (e.shiftKey && !e.ctrlKey && !e.altKey && focusedSessions.size > 1) {
    var layoutKey = '`1234567890'.indexOf(e.key);
    if (layoutKey === -1) layoutKey = '~!@#$%^&*()'.indexOf(e.key);
    if (layoutKey >= 0 && layoutKey < LAYOUT_ORDER.length) {
      activeLayout = LAYOUT_ORDER[layoutKey];
      calculateFocusedLayout();
      showLayoutIndicator();
      e.preventDefault();
      return;
    }
  }
```

Hmm, this is getting complicated with keyboard layouts. Let me simplify — use **the grid button (⊞) in the header** that already exists. Actually, let's add a new header button for layout cycling. That's unambiguous:

```javascript
  // In createTerminalDOM controls array, add before the minimize button:
  { label: '⊞', title: 'Cycle layout', fn: function() {
    if (focusedSessions.size > 1) cycleLayout();
  }}
```

Wait, ⊞ is already used for "Fit card to terminal." Let me use a different symbol. The grid icon `⊟` or `▦` or just `L`:

```javascript
  { label: '▦', title: 'Cycle layout', fn: function() {
    if (focusedSessions.size > 0) cycleLayout();
  }}
```

- [ ] **Step 3: Add layout indicator CSS**

Add to `dashboard.css`:

```css
/* Layout indicator — shows current layout name briefly when switching */
#layout-indicator {
  position: fixed;
  bottom: 60px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.8);
  color: #fff;
  padding: 8px 20px;
  border-radius: 8px;
  font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
  font-size: 14px;
  z-index: 200;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s;
}
```

- [ ] **Step 4: Add the ▦ button to card header controls**

In `createTerminalDOM` (around line 1519), add the layout cycle button after the ⊞ button and before the minimize button:

```javascript
      { label: '▦', title: 'Cycle layout (multi-focus)', fn: function() {
        if (focusedSessions.size > 0) cycleLayout();
      }},
```

- [ ] **Step 5: Commit**

```bash
git add dashboard.mjs dashboard.css
git commit -m "feat(layout): add layout cycling via header button + layout indicator"
```

---

### Task 5: Reset Layout on Unfocus

**Files:**
- Modify: `dashboard.mjs` — reset activeLayout when unfocusing

- [ ] **Step 1: Reset layout in unfocusTerminal**

Find `function unfocusTerminal()` (around line 2419) and add at the top:

```javascript
function unfocusTerminal() {
  activeLayout = 'auto';  // reset to default when leaving focus mode
  restoreAllFocused();
  // ... rest of existing code
```

- [ ] **Step 2: Also reset when focus changes**

When the user ctrl+clicks to change the focus group, the layout should reset to auto (the new group may have a different number of cards):

Find `function addToFocus(sessionName)` and add:

```javascript
function addToFocus(sessionName) {
  activeLayout = 'auto';  // reset layout when focus group changes
  // ... rest of existing code
```

And in `function removeFromFocus(sessionName)`:

```javascript
function removeFromFocus(sessionName) {
  activeLayout = 'auto';  // reset layout when focus group changes
  // ... rest of existing code
```

- [ ] **Step 3: Commit**

```bash
git add dashboard.mjs
git commit -m "feat(layout): reset to auto layout on unfocus and focus group change"
```

---

### Task 6: Underflow Handling — Fewer Cards Than Slots

**Files:**
- Modify: `dashboard.mjs` — update `calculateSlotLayout` to handle underflow

- [ ] **Step 1: Add underflow logic to calculateSlotLayout**

When there are fewer cards than slots, the empty slots should be collapsed and remaining slots should expand. The simplest approach: only use the first N slots (sorted by area, largest first) and scale them to fill the available space.

In `calculateSlotLayout`, after the assignments are computed, filter to assigned slots only and rescale:

```javascript
  // Underflow: fewer cards than slots — use only assigned slots, rescale to fill
  const usedAssignments = assignments.filter(a => a.slot !== null);
  if (usedAssignments.length < slots.length && usedAssignments.length > 0) {
    // Compute bounding box of used slots
    let minX = 100, minY = 100, maxX = 0, maxY = 0;
    for (const a of usedAssignments) {
      minX = Math.min(minX, a.slot.x);
      minY = Math.min(minY, a.slot.y);
      maxX = Math.max(maxX, a.slot.x + a.slot.w);
      maxY = Math.max(maxY, a.slot.y + a.slot.h);
    }
    // Scale used slots to fill the full available space
    const bw = maxX - minX;
    const bh = maxY - minY;
    if (bw > 0 && bh > 0) {
      for (const a of usedAssignments) {
        a.slot = {
          x: ((a.slot.x - minX) / bw) * 100,
          y: ((a.slot.y - minY) / bh) * 100,
          w: (a.slot.w / bw) * 100,
          h: (a.slot.h / bh) * 100
        };
      }
    }
  }
```

Insert this right after `const assignments = assignCardsToSlots(cards, slots);` and use `usedAssignments` instead of `assignments` for the rest of the function.

- [ ] **Step 2: Commit**

```bash
git add dashboard.mjs
git commit -m "feat(layout): underflow handling — expand slots when fewer cards than slots"
```

---

### Task 7: Help Panel Update

**Files:**
- Modify: `dashboard.mjs` — add layout controls to help panel

- [ ] **Step 1: Add layout info to KEYBINDINGS or help content**

Find where the help panel content is populated (search for `help-controls` or `KEYBINDINGS`). Add the layout button to the controls documentation:

```javascript
  // Add to the keybindings/help content:
  { key: '▦', context: 'focused', desc: 'Cycle layout (on card header)' }
```

- [ ] **Step 2: Commit**

```bash
git add dashboard.mjs
git commit -m "docs: add layout controls to help panel"
```

---

### Task 8: E2E Test — Layout Switching

**Files:**
- Create: `test-layouts.mjs`

- [ ] **Step 1: Write the puppeteer test**

```javascript
// test-layouts.mjs — E2E test for layout switching
// Verifies: named layouts position cards correctly, cycling works, unfocus resets to auto
import puppeteer from 'puppeteer';
import { execFileSync } from 'child_process';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function tmux(args) { return execFileSync('tmux', args, { encoding: 'utf8' }).trim(); }

async function run() {
  // Create 4 test terminals
  const terms = ['layout-a', 'layout-b', 'layout-c', 'layout-d'];
  for (const name of terms) {
    try { tmux(['kill-session', '-t', name]); } catch {}
    tmux(['new-session', '-d', '-s', name, '-x', '80', '-y', '24']);
  }
  await sleep(2000);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('http://localhost:3200/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(8000);

  // Multi-focus all 4 terminals via ctrl+click on thumbnails
  for (const name of terms) {
    await page.evaluate((n) => {
      const items = document.querySelectorAll('.thumbnail-item');
      for (const item of items) {
        if (item.dataset.session === n) { item.click(); return; }
      }
    }, name);
    await sleep(500);
    // After first, use ctrl+click
    if (name !== terms[0]) {
      // Already focused first, ctrl+click rest
    }
  }
  // Actually: focus first, then ctrl+click rest
  await page.evaluate((n) => {
    const items = document.querySelectorAll('.thumbnail-item');
    for (const item of items) {
      if (item.dataset.session === n) { item.click(); return; }
    }
  }, terms[0]);
  await sleep(2000);

  for (let i = 1; i < terms.length; i++) {
    await page.keyboard.down('Control');
    await page.evaluate((n) => {
      const items = document.querySelectorAll('.thumbnail-item');
      for (const item of items) {
        if (item.dataset.session === n) { item.click(); return; }
      }
    }, terms[i]);
    await page.keyboard.up('Control');
    await sleep(500);
  }
  await sleep(2000);

  // Screenshot: auto layout (masonry)
  await page.screenshot({ path: '/srv/svg-terminal/alignment-tests/layout-auto.png' });
  console.log('Auto layout saved');

  // Click the ▦ button on any focused card to cycle layout
  async function cycleLayout() {
    await page.evaluate(() => {
      const focused = document.querySelector('.focused');
      if (!focused) return;
      const btns = focused.querySelectorAll('.header-controls button');
      for (const btn of btns) {
        if (btn.textContent.trim() === '▦') { btn.click(); return; }
      }
    });
    await sleep(1500);
  }

  // Cycle through layouts and screenshot each
  const layoutNames = ['2up-h', '2up-v', '1main-2side', '3col', '2x2', '2top-1bottom', '1main-4mini', 'n-stacked'];
  for (const name of layoutNames) {
    await cycleLayout();
    await page.screenshot({ path: '/srv/svg-terminal/alignment-tests/layout-' + name + '.png' });
    console.log(name + ' layout saved');
  }

  // Verify: press Escape, check auto layout resets
  await page.keyboard.press('Escape');
  await sleep(1000);
  await page.keyboard.press('Escape');
  await sleep(1500);

  // Check that activeLayout was reset
  const layoutAfterUnfocus = await page.evaluate(() => {
    return typeof activeLayout !== 'undefined' ? activeLayout : 'not accessible';
  });
  console.log('Layout after unfocus: ' + layoutAfterUnfocus);

  await page.screenshot({ path: '/srv/svg-terminal/alignment-tests/layout-after-unfocus.png' });

  await browser.close();

  // Cleanup
  for (const name of terms) {
    try { tmux(['kill-session', '-t', name]); } catch {}
  }

  console.log('\\nDone. Review screenshots in /srv/svg-terminal/alignment-tests/layout-*.png');
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
```

- [ ] **Step 2: Run the test**

Run: `cd /srv/svg-terminal && node test-layouts.mjs`
Expected: 9 screenshots saved (auto + 8 named layouts), each showing 4 terminals arranged differently.

- [ ] **Step 3: Visual review**

Open each screenshot and verify:
- `layout-auto.png`: masonry-style arrangement (existing behavior)
- `layout-2up-h.png`: 2 cards side by side (2 of 4 visible — underflow handling)
- `layout-2x2.png`: 4 cards in quadrant grid
- `layout-1main-2side.png`: 1 large + 2 stacked (3 of 4 — one card in overflow)
- Each layout shows cards positioned at the correct slot locations within usable space (left of sidebar, above status bar)

- [ ] **Step 4: Commit**

```bash
git add test-layouts.mjs
git commit -m "test: E2E test for layout switching across all named layouts"
```

---

### Task 9: Final Commit and Push

- [ ] **Step 1: Verify everything works together**

Hard refresh the browser. Multi-focus 2+ terminals. Click the ▦ button repeatedly — layouts should cycle. Cards should animate to new positions. Layout name indicator should appear briefly.

- [ ] **Step 2: Push**

```bash
git push
```

---

## Post-Phase 1 — What Comes Next

These are documented for context but NOT part of this plan:

- **Phase 2: Mutation operations** — maximize card→slot (resize card DOM to fill slot), maximize terminal→card via layout button, letterbox/fill mode per card
- **Phase 3: POV-FONT-SIZE** — calculate apparent font size, unify text size across cards
- **Phase 4: Profile persistence** — save/load active layout and slot assignments to profile JSON
- **Phase 5: Overflow handling** — shrink layout proportionally when more cards than slots, place excess cards in freed space
- **Phase 6: Co-browser politeness** — Z-compensation for terminal resizes from other browsers, resize source attribution on WebSocket messages
