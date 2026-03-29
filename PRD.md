# svg-terminal — Product Requirements Document

**Version:** 0.4.0
**Last updated:** 2026-03-29 by agent 3 (session e3af93f5)
**Branch:** `camera-only-test`

---

## 1. Purpose

A 3D terminal dashboard that renders tmux sessions as floating cards in a Three.js CSS3DRenderer scene. Terminals are interactive — keystrokes, scrollback, copy/paste, resize. Cards can be focused, multi-selected, dragged, and arranged spatially. The system is evolving toward a workspace orchestrator with named scenes, persistent layouts, and heterogeneous card types (terminals, browsers, status panels).

---

## 2. Architecture

### 2.1 Rendering Pipeline

```
tmux session → server.mjs (30ms poll, line diff) → WebSocket → terminal.svg (SVG rendering)
     ↓
<object> element inside card DOM → CSS3DRenderer (matrix3d) → Chrome GPU compositor → screen
```

**The 4x scale trick:** Card DOM is oversized (e.g., 1290×1056 pixels). CSS3DObject scale = 0.25. This forces Chrome to rasterize text at high resolution before the 3D transform scales it down. DO NOT remove — text blurs without it.

### 2.2 Camera-Only Focus

**Current approach.** Cards are ALWAYS at their base DOM size. Focus = camera moves closer. Unfocus = camera moves back. No DOM changes on focus/unfocus. No inner scale transform. No state to restore.

**Why:** The previous approach (DOM resize on focus, inner scale transform, CSS3DObject scale recalculation) created a two-state architecture where every feature that touched card sizing had to handle both ring state and focus state. Alt+drag, +/-, optimize, unfocus — all fought each other. Camera-only eliminated the entire category of bugs.

**Abandoned approach: DOM resize on focus.** Resized the card DOM to fill the viewport for "1:1 pixel mapping." Set `inner.style.transform = scale(innerScale)`. Recalculated `css3dObject.scale`. Required restore on unfocus. Every resize operation needed focus-state branching. Abandoned 2026-03-29.

### 2.3 Frustum-Projected Layout

Multi-focus layout computes in screen pixels, projects into 3D. Each card at its own Z depth where its world size fills its allocated screen rectangle through perspective.

1. Allocate screen area proportional to cell count (cols × rows)
2. Masonry bin-pack into columns
3. Scale to fit usable viewport area
4. Project each card's screen position to world position at its frustum depth
5. Camera pulls back far enough that all focused cards are in front of the ring

**Why cell-count proportional:** Terminals with more content get more screen space. A 120×40 terminal gets ~2.5x the area of a 40×12 terminal.

### 2.4 Card Factory

`createCardDOM(config)` — generic factory for any card type. Config: `{ id, title, type, controls[], contentEl }`. Both terminal and browser cards use the same factory. Header, dots, controls, drag — all inherited.

- `createTerminalDOM(sessionName)` — `<object>` with SVG
- `createBrowserDOM(cardId, url)` — `<iframe>` with URL

### 2.5 Node Model (Target Architecture)

Everything is a node with the same structure:

```
node: {
  id, parent, position, rotation, scale, children,
  terminal: { sessionName, fontSize, cardW, cardH } | null,
  camera: { fov, aspect, active } | null
}
```

Parent determines coordinate space: camera (HUD), group (rigid body), world (pinned), ring (auto-layout). NOT YET IMPLEMENTED — current code uses flat maps, not a tree.

---

## 3. Server API

### 3.1 GET /api/sessions

Returns tmux session list with dimensions.

```json
[{ "name": "resize-test", "windows": 1, "cols": 80, "rows": 24 }]
```

Source: `tmux list-sessions -F '#{session_name} #{session_windows} #{window_width} #{window_height}'`

### 3.2 GET /api/pane?session=X&pane=Y

Returns captured pane content with cursor, title, lines, spans.

### 3.3 POST /api/input

Send keystrokes to tmux. Body: `{ session, pane, keys?, specialKey? }`

### 3.4 WebSocket /ws/terminal?session=X&pane=Y

Bidirectional. Server pushes `screen` (full) and `delta` (changes). Client sends `input`, `resize`.

```
Server → Client: { type: "screen", width, height, cursor, lines, scrollOffset }
Server → Client: { type: "delta", cursor, changed: { "3": [...spans] } }
Client → Server: { type: "input", keys: "hello" }
Client → Server: { type: "resize", cols: 100, rows: 30 }
```

### 3.5 GET/POST /api/layout?uid=X

Browser layout profiles. GET returns saved state, POST saves state. Stored at `profiles/<uid>.json`.

---

## 4. Client Interactions

### 4.1 Focus System

| Action | Effect |
|--------|--------|
| Click thumbnail | Single focus — camera zooms to card |
| Ctrl+click thumbnail | Add to multi-focus group |
| Click focused card body | Switch active input to that card |
| Click empty space | Deselect — remove input, cards stay in place |
| Escape (from zoomed) | Return to multi-focus grid |
| Escape (from grid) | Full unfocus — cards return to ring |
| Shift+Tab | Cycle zoom through focused cards |

### 4.2 Card Manipulation

| Action | Effect |
|--------|--------|
| Drag title bar | Move card in 3D (camera-relative vectors) |
| Ctrl+drag title bar | Dolly camera toward/away from card |
| Alt+drag card body | Resize card DOM |
| Alt+scroll | Change terminal cols/rows (font size) |
| +/− header buttons | Change cols/rows by ±4/±2 |
| ⊡ header button | Fit terminal to card (resize tmux) |
| ⊞ header button | Fit card to terminal (reshape card) |
| ⌊ header button | Minimize — remove from focus group |

### 4.3 Camera

| Action | Effect |
|--------|--------|
| Scroll wheel (unfocused) | Dolly toward mouse pointer |
| Shift+scroll | Faster dolly toward mouse pointer |
| Drag (unfocused) | Orbit camera |
| Shift+drag | Pan camera X/Y |
| Ctrl+drag | Rotate around origin |
| Right-click drag | Orbit |
| Middle-click drag | Pan |

### 4.4 Terminal

| Action | Effect |
|--------|--------|
| Type | Keystrokes sent to tmux |
| Scroll (focused) | Terminal scrollback |
| Ctrl+C (with selection) | Copy to clipboard |
| Ctrl+C (no selection) | Send C-c to terminal |
| Ctrl+V | Paste from clipboard |
| Shift+arrow | Text selection |

### 4.5 URL Detection

terminal.svg detects `http://` and `https://` URLs in terminal output. Blue underline overlay. Click opens in new tab. Alt+click creates a browser card in the 3D scene.

---

## 5. Card Sizing

### 5.1 Startup

`calcCardSize(cols, rows)` derives card DOM dimensions from terminal aspect ratio. All ring cards have uniform visual weight (`TARGET_WORLD_AREA = 320 × 248`), different shapes.

Constants: `SVG_CELL_W = 8.65`, `SVG_CELL_H = 17`, `HEADER_H = 72`.

### 5.2 During Focus

Card size does NOT change. +/− changes cols/rows inside the same card (font size change). Alt+drag changes card DOM directly. `updateCardForNewSize` skips DOM updates when focused — only updates `baseCardW/baseCardH` so unfocus restores correctly.

### 5.3 Optimize (Two Directions)

- **⊡ Fit terminal to card:** Resize tmux so content fills current card. Card stays.
- **⊞ Fit card to terminal:** Reshape card to wrap current content. Same as startup `calcCardSize`.

### 5.4 Reactive Sizing

`refreshSessions` polls every 5s. For unfocused cards, `updateCardForNewSize` reshapes the card when tmux dimensions change (from any source). For focused cards, `baseCardW/baseCardH` update silently.

---

## 6. Event Routing

### 6.1 Three Click Paths

1. `onMouseUp` (document) — ctrl+click for multi-focus via `handleCtrlClick`
2. `onSceneClick` (renderer.domElement) — regular click, focus switch, deselect
3. Thumbnail click (sidebar) — direct `focusTerminal` or `addToFocus`

### 6.2 Flags

| Flag | Purpose |
|------|---------|
| `mouseDownOnSidebar` | Prevents `handleCtrlClick` firing on sidebar ctrl+clicks |
| `suppressNextClick` | Prevents `onSceneClick` after `handleCtrlClick` (only set for 3D scene ctrl+clicks) |
| `lastAddToFocusTime` | 200ms guard prevents `focusTerminal` after `addToFocus` |
| `ctrlHeld` / `altHeld` | Tracked via keydown/keyup (e.ctrlKey unreliable on Windows) |
| `_lastDragWasReal` | Set in `onMouseUp`, cleared in `onSceneClick` — replaces stale `dragDistance` |
| `_userPositioned` | Set by drag/resize — prevents `calculateFocusedLayout` from overriding |
| `_savedZ` | Tracks pre-slide Z for active card — prevents Z creep on deselect/re-select |

### 6.3 CSS3D Hit Testing Is 2D

**CRITICAL.** `e.target.closest()` and `getBoundingClientRect()` do not respect Z depth in CSS3DRenderer. A large card behind a small card can intercept clicks meant for the small card.

**Solution:** Coordinate-based hit testing. Check click position against all focused card header rects manually instead of relying on DOM event targeting.

**Abandoned approach:** `e.target.closest('.terminal-3d header')` — fails when cards overlap in screen space at different Z depths. Discovered 2026-03-29.

### 6.4 Text Selection

Capture-phase mousedown listener. Must skip header clicks (coordinate check, not `e.target.closest`). `screenToCell` maps screen coordinates to terminal character grid.

**Known bug:** Selection overlay is misaligned under CSS3D transforms. Needs `screenToCardCoords()` that inverts the matrix3d. Same fix benefits header hit testing.

---

## 7. Visual Design

### 7.1 Ring Layout

Cards orbit in two rings (outer radius 500, inner radius 300). Ring tilt, card tilt, spin speed configurable via `RING` constant. Billboard slerp faces cards toward camera.

### 7.2 Ring During Focus

Ring Z offset eases to `RING_Z_BACK = -800` during focus. Cards fade to 30% opacity. On unfocus, ring eases back to Z=0. Rate: 0.05 per frame.

### 7.3 Active Card Indicator

Gold header background (`#4a4020`) with subtle box-shadow. NO border or box-shadow on `.terminal-3d` — triggers Chrome to re-rasterize the entire card under matrix3d transforms, causing visible text sharpness mutation.

**Abandoned approach:** Gold neon border on `.terminal-3d.input-active`. Caused re-rasterization. Discovered 2026-03-29.

### 7.4 Active Card Z-Slide

Active card slides forward by `READING_Z_OFFSET = 25` world units. `_savedZ` tracks pre-slide position. Cleared on deselect. Prevents Z creep on select/deselect cycles.

### 7.5 Debug Background

Card background is `#2e2e32` (lightened from `#1c1c1e`) to see card vs terminal edges during development. Revert to `#1c1c1e` for production.

---

## 8. Constraints

| Constraint | Reason | Violation consequence | Verified by |
|-----------|--------|----------------------|-------------|
| 4x scale trick (oversized DOM, 0.25 CSS3DObject scale) | Chrome rasterization quality | Text blurs | agent 1 (discovered), agent 3 (confirmed) |
| SVG rendering target | Cross-browser universality | Edge/Chrome render HTML overlays differently | `[UNVERIFIED]` agent 1 — user directive, not tested cross-browser by agent 3 |
| Camera-only focus (no DOM resize) | Eliminates two-state sizing bugs | Every feature fights focus state | agent 3 (designed and validated) |
| No per-terminal DOM click handlers | Double-fire with ctrl+click | Multi-focus breaks | `[UNVERIFIED]` agent 1 |
| Coordinate-based hit testing in CSS3D | 2D hit testing ignores Z depth | Wrong card intercepts clicks | agent 3 (discovered and fixed) |
| No CSS border/box-shadow on .terminal-3d | Triggers GPU re-rasterization | Text sharpness mutation | agent 3 (user reported, fixed) |
| Atomic tmux capture (`;` separator) | Race condition between cursor and content | Cursor offset | `[UNVERIFIED]` agent 1 |
| `tmux resize-window` not `resize-pane` | resize-pane fails without attached client | Silent resize failure | `[UNVERIFIED]` agent 2 |
| `cp-*` sessions don't accept resize | Managed by claude-proxy with SSH clients | Test only with standalone sessions | agent 3 (confirmed empirically) |

---

## 9. Anti-Patterns (Tried and Abandoned)

Each entry notes whether the change was due to **misunderstood intent** (agents assumed wrong mechanism for the right goal) or **changed intent** (user's goal itself evolved).

| Approach | Problem | Replacement | Intent |
|----------|---------|-------------|--------|
| CSS `transform: scale()` for font zoom | Width/height adjustment counteracted scale | Change tmux cols/rows directly | **Misunderstood intent.** User always wanted font size change. Agents assumed CSS transform; user corrected: "ALL visual size changes come from tmux cols/rows." |
| DOM resize on focus (1:1 pixel mapping) | Two-state architecture, every feature breaks | Camera-only focus | **Misunderstood intent.** Goal was crisp text. Agents assumed bigger DOM = crisper. True, but the two-state complexity was worse than the marginal crispness gain. Understanding of the tradeoff changed. |
| Camera offset for sidebar | Every sign combination wrong | No offset, sidebar is overlay | **Misunderstood intent.** User said "everything is a card in one frustum." Agents were treating the sidebar as a subtracted region. User's spatial model was simpler. |
| Card reshaping on +/- | Card morphs shape on every +/- press | Card stays, font changes inside | **Changed intent.** Originally +/- was "resize terminal" (card follows). User clarified: "the card is my window, +/- is font size inside it." The distinction between window and content crystallized during testing. |
| `focusedSessions.clear()` on deselect | Cards fly to ring | Keep focusedSessions intact | **Changed intent.** Originally deselect meant "return to overview." User clarified: "I want to stay where I am, just release input." Deselect vs unfocus became two separate actions. |
| `e.target.closest` in CSS3D | 2D hit testing picks wrong card | Coordinate-based rect checking | **Misunderstood constraint.** Agents assumed DOM event targeting worked in CSS3D. It doesn't — browser uses 2D bounding rects, ignores Z depth. |
| Border/box-shadow active indicator | Chrome re-rasterizes card | Header background only | **Misunderstood constraint.** CSS changes on a matrix3d-transformed element trigger full re-rasterization. Only discovered by user observing sharpness mutation on focus switch. |
| `_layoutZ` for Z-slide restore | Stale after user moves card | `_savedZ` captures current Z | **Misunderstood intent.** Agents assumed cards return to layout position. User expected cards to stay where they were put. |
| Floating overlay controls bar | Positioning unreliable, intercepts header clicks | Controls inline in card header | **Misunderstood constraint.** Originally thought CSS3D DOM couldn't receive button clicks (getBoundingClientRect returns NaN). Testing proved buttons inside headers work fine. |
| Hardcoded 1280×992 for all cards | Letterboxing, aspect mismatch | `calcCardSize` from tmux cols/rows | **Misunderstood intent.** User expected cards shaped by their terminal content. "You're killing that when you start by forcing all terminals into a forced aspect." |
| Smooth scroll with CSS translateY | Transform and content update overlap, bounce | No animation, 30ms server response sufficient | **Misunderstood constraint.** `[UNVERIFIED]` agent 1 — 8+ iterations tried. The 30ms server response makes animation unnecessary. |

---

## 10. Break Tests

Items tagged `[UNVERIFIED]` were inherited from agent 1/2 resume docs and not independently tested by agent 3. They were true when written but may have drifted.

| Mutation | What breaks | Detection | Verified by |
|----------|------------|-----------|-------------|
| Remove `syncOrbitFromCamera()` on orbit start | Camera snaps to stale position | Visual: camera jumps | `[UNVERIFIED]` agent 1 |
| Remove `focusQuatFrom` on focus | Card snaps flat before fly-in | Visual: rotation snap | `[UNVERIFIED]` agent 1 |
| Change CSS3DObject scale from 0.25 | Text blurs | Visual: fuzzy text | agent 3 (confirmed) |
| Add per-terminal click handlers | Ctrl+click double-fire | Terminal count wrong | `[UNVERIFIED]` agent 1 |
| Remove event routing flags | Various click/focus bugs | Multi-focus breaks | agent 3 (hit multiple times) |
| Clear `focusedSessions` on deselect | Cards scatter to ring | Visual: cards fly away | agent 3 (discovered and fixed) |
| Don't delete `_savedZ` on deselect | Z accumulates per cycle | Card creeps toward camera | agent 3 (discovered and fixed) |
| Use `e.target.closest` for header hits | Wrong card intercepts | Drag fails on overlapping cards | agent 3 (discovered and fixed) |
| Add border to `.terminal-3d.input-active` | Text sharpness mutation | Visual: text changes on focus switch | agent 3 (user reported, fixed) |
| Use `resize-pane` instead of `resize-window` | Silent failure | Terminal size unchanged | `[UNVERIFIED]` agent 2 |

---

## 11. Testing

### 11.1 Server Tests

`node --test test-server.mjs` — 17 tests. HTTP API, WebSocket, CORS, validation.

### 11.2 E2E Dashboard Tests

`node test-dashboard-e2e.mjs` — 20 tests. Puppeteer headless. Covers: focus, multi-focus, input switching, title bar drag, minimize, shift+tab, resize, card sizing, header controls.

**Rule:** Run E2E with haiku subagent before asking user to test.

### 11.3 Test Gaps

- URL detection and browser cards
- Deselect/re-select Z stability
- Selection overlay alignment
- Camera dolly toward cursor

---

## 12. Integration: claude-proxy

### 12.1 Status

Architecture agreed in council protocol (council/issue_01). Integration docs at `/srv/claude-proxy/docs/integration/`. Phase A (screen-renderer, PtyMultiplexer, api-server on port 3101) built by claude-proxy side.

### 12.2 Blocker

Integration docs describe the OLD dashboard architecture. Must be revised to reflect:
- Camera-only focus
- Frustum layout
- Card factory (terminal + browser)
- New WebSocket handling (updateCardForNewSize)
- Coordinate-based event handling

### 12.3 Phases

- Phase B: Adapt svg-terminal client to claude-proxy API endpoints
- Phase C: Merge, QC, code style unification

---

## 13. Roadmap

### Now
- B1: Fix selection overlay alignment (screenToCardCoords)
- F1: Merge camera-only-test → dev
- F2: Test URL detection + browser cards
- D1: Handoff doc cleanup

### Next
- F3: localStorage persistence (save/restore card prefs)
- F4: Big bang startup animation (size morph)
- F5: Functional dots (close/minimize/optimize)
- I1: claude-proxy integration (after doc revision)

### Later
- F6: ThinkOrSwim workspace system (named scenes, color tags)
- F7: Mobile support (touch, virtual keys)
- F8: Terminal pinning (world position persistence)
- F9: Groups (rigid body collections)
- F10: Named scenes (camera snapshots)

---

## 14. File Map

| File | Purpose |
|------|---------|
| `dashboard.mjs` | 3D scene, camera, focus, layout, events, cards (~2300 lines) |
| `dashboard.css` | Card styling, header, controls, indicators, debug background |
| `server.mjs` | HTTP + WebSocket server, tmux integration, layout profiles |
| `terminal.svg` | SVG terminal renderer, WebSocket client, URL detection, selection |
| `index.html` | Page shell, sidebar, help panel, input bar |
| `polyhedra.mjs` | Vertex math, easing functions |
| `test-server.mjs` | 17 server tests |
| `test-dashboard-e2e.mjs` | 20 E2E puppeteer tests |
| `restart-server.sh` | Kill + restart in one command |
| `PRD.md` | This file — source of truth |
| `TASKLIST.md` | Current bugs, features, priorities |
