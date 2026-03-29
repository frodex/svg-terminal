# Terminal Persistence and Spatial Scenes — Design Spec

**Date:** 2026-03-28 (updated 2026-03-29)
**Status:** Draft — Phase 1 partially implemented, Phases 2-9 designed
**Project:** svg-terminal

---

## Problem

Terminal customizations (size, font, position) are lost on reload. All cards start at uniform sizes regardless of terminal content. There is no concept of spatial arrangement persistence — users can't save and recall terminal layouts, pin terminals to positions, or group related terminals together.

## Vision

A Prezi-style spatial composition system where terminals are nodes in a recursive scene graph. Users customize terminal size, font, and position. Named scenes save camera + layout state. Everything flies in from origin on load — a "big bang" where each node grows to its destination size as it travels to its saved position.

Inspired by Sozi (open-source Prezi alternative) — objects placed on an infinite spatial canvas, "slides" are saved camera positions that zoom/pan between them. Evaluated and rejected Sozi itself in favor of custom Three.js CSS3DRenderer implementation for tighter integration.

---

## Core Concept: Everything Is a Node

A single recursive data model for all spatial objects. The same structure applies to terminals, groups, cameras, and the viewport. Parent determines coordinate space. Payload determines behavior.

```
node: {
  id:        string,
  parent:    nodeId | "world",
  position:  {x, y, z},         // offset in parent's coordinate space
  rotation:  {x, y, z, w},      // quaternion
  scale:     {x, y, z},
  children:  [nodeId, ...],

  // Exactly one payload type (or null for pure group)
  terminal:  { sessionName, fontSize, cardW, cardH, cols, rows } | null,
  camera:    { fov, aspect, active } | null
}
```

### Node Parenting

| Parent | Behavior | Use case |
|--------|----------|----------|
| `camera` | Fixed in viewport, follows camera movement | HUD monitors — small terminal in upper-right corner, always visible regardless of camera position/zoom |
| `group` | Moves with group as rigid body, maintains offset within group | Related terminals together — editor + tests + logs as a "dev stack" |
| `world` | Fixed in world space, camera orbits around it | Pinned standalone terminals at known positions |
| `ring` (default) | Managed by ring animation layout, auto-positioned | Unpinned terminals, current default behavior |

Reparenting changes behavior. Drag a terminal from the ring to a group — it leaves the ring and locks to the group. Unpin — it returns to the ring. The ring is the "unassigned pool."

### Recursion

Groups can contain groups. A "project" group contains "frontend" and "backend" subgroups, each containing terminals. Moving the project group moves everything. The depth is unlimited.

A scene snapshot traverses the tree and serializes every node's state. Restoring a scene reconstructs the tree.

---

## Font Size as Primary User Preference

Font size is the user's core preference. Everything else derives from it. Two users with the same card can have different font sizes — one prefers 80×24 (big text, fewer cols) and another prefers 200×60 (small text, more content).

Font size is not a CSS property — it's the emergent property of `cardWidth / cols`. When the user alt+scrolls to change cols/rows, the visual font size changes because fewer/more characters fill the same card.

### Card Size Derivation

```
cardW = cols × cellPixelWidth(fontSize)
cardH = rows × cellPixelHeight(fontSize) + headerHeight
```

Where `cellPixelWidth` and `cellPixelHeight` are determined by the SVG font at 4x scale. Currently: `SVG_CELL_W = 8.65`, `SVG_CELL_H = 17`, measured from the `measure` element in terminal.svg.

### Sizing Fallback Chain

When a terminal appears, size it by checking in order:

1. **Saved preference** (localStorage) — user previously customized → restore fontSize, cardW, cardH
2. **Derive from tmux** — no saved preference → read cols×rows from tmux, apply global default fontSize, calculate card to match terminal aspect ratio with uniform visual weight
3. **Default** — can't read tmux yet → use global fontSize with default 80×24, optimize on first WebSocket data

---

## Frustum Projection Layout

**The key architectural insight:** Everything is a card in one frustum. No camera offsets. The sidebar is an overlay, not a subtracted region.

### How Multi-Focus Layout Works

1. **Define usable screen area** — full viewport minus sidebar (right, 140px) and status bar (bottom, 50px)
2. **Allocate screen rectangles** proportional to cell count. Terminals with more content (cols × rows) get more screen space. This gives layout priority to terminals with the smallest text relative to their content.
3. **Masonry bin-pack** — try column counts 1-4, pick the arrangement with best coverage-to-aspect match. Sort by cell count, place each card in the shortest column.
4. **Scale to fit** — uniform scale factor so the packed layout fills the usable area with 5% margin.
5. **Project to 3D** — for each card, compute the Z depth where its world size (from `baseCardW/baseCardH × 0.25`) fills its allocated screen rectangle through camera perspective. `depth = worldH / (screenFraction × 2 × tan(fov/2))`.
6. **Convert screen→world** — screen pixel offset from viewport center → world offset at card's depth.
7. **Camera pullback** — camera moves back to `max(FOCUS_DIST, maxDepth + 150)` so all focused cards sit in front of the ring (Z > 150).

### Why Frustum Projection

- Cards at different Z depths get optimal Chrome 4x rasterization
- More-content terminals are closer to camera = more pixels = crisper text
- No camera offset math (every attempt at offsetting for sidebar was wrong)
- No overlap — each card is in its own frustum slice
- Layout guaranteed to fit viewport because it's designed in screen pixel space
- The depth variation creates natural visual hierarchy

---

## Scenes (Prezi-Style)

A scene is a named snapshot of:
- Camera node state (position, orientation, fov)
- All terminal node states (position, size, fontSize, parent, pinned status)
- Group states (position, rotation, children, membership)
- Focus state (which terminals are focused, which has active input)

### Scene Operations

- **Save scene** — snapshot current state with a name
- **Recall scene** — animate camera to saved position, restore terminal states
- **Switch scene** — terminal nodes that exist in both scenes stay; nodes unique to the new scene appear; nodes not in the new scene return to ring
- **Delete scene** — remove snapshot (doesn't affect terminals)

### Camera-Locked Terminals

A terminal with `parent: camera` stays fixed in the viewport regardless of scene transitions. The camera moves between scenes; the HUD terminal follows. Use case: a status monitor always visible in the upper-right corner.

In Three.js, this is `camera.add(terminalCSS3DObject)`. The child inherits the camera's transforms.

---

## Layout Modes

Three layout modes for multi-focus, selectable from a header bar:

### Masonry (Default — Implemented)
Cards at their natural aspect ratios, bin-packed into columns. Proportional to cell count. No terminal resizing.

### Treemap
Squarified treemap divides the usable area into rectangles proportional to cell count. Every pixel of viewport used. **Terminals resize to fill their allocation** — this sends `resize` to tmux, changing cols/rows. Maximizes information density at the cost of user font size preference.

### Grid
Uniform rows and columns. Clean alignment. Cards may letterbox if aspects don't match grid cells. Good for terminals of similar size.

### Header Bar
A floating toolbar at the top of the viewport (visible during multi-focus) with:
- Layout mode toggle (masonry / treemap / grid)
- Scene save/recall/rename
- Group controls (create group, add to group)

---

## Big Bang Startup

On every page load, all terminals start at a uniform small size at origin. They simultaneously expand and fly out to their destinations:

- **Ring terminals** → ring positions at ring card size
- **Pinned terminals** → saved world positions at saved card size
- **Group terminals** → group-relative positions within group at saved size
- **HUD terminals** → camera-relative offset at saved size

Position AND size interpolate over `MORPH_DURATION` (1.5s). The morph system already handles position — add `morphFromSize → targetSize` interpolation.

Cards arrive at their destination fully sized. The visual effect: a big bang where everything grows into its place.

---

## Parameterized Decisions

These values are configurable, not hardcoded. The user reserves the right to change them after seeing implementation:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `globalFontSize` | 16 | Default cell pixel width at 4x scale |
| `TARGET_WORLD_AREA` | 320 × 248 | Ring card visual weight (world square units) |
| `SVG_CELL_W` | 8.65 | SVG cell width (from font measurement) |
| `SVG_CELL_H` | 17 | SVG cell height (from font measurement) |
| `HEADER_H` | 72 | Card header height at 4x (56px content + 16px padding) |
| `MIN_CARD_W` | 640 | Minimum card DOM width (4x) |
| `MAX_CARD_W` | 3200 | Maximum card DOM width (4x) |
| `MIN_CARD_H` | 496 | Minimum card DOM height (4x) |
| `MAX_CARD_H` | 2400 | Maximum card DOM height (4x) |
| `altScrollStep` | 2 | Cols change per alt+scroll tick |
| `buttonStep` | 4 | Cols change per +/− click |
| `MORPH_DURATION` | 1.5 | Seconds for fly-in/morph animation |
| `RING_Z_BACK` | -800 | How far to push ring behind during focus |
| `ringZEaseRate` | 0.05 | Ring Z offset ease rate per frame |
| `LAYOUT_GAP_PX` | 8 | Gap between cards in screen pixels |
| `STATUS_BAR_H` | 50 | Status bar height in pixels |

---

## Data Persistence

### localStorage Schema

```json
{
  "svg-terminal": {
    "version": 1,
    "globalFontSize": 16,
    "terminals": {
      "resize-test": {
        "fontSize": 20,
        "cardW": 1600,
        "cardH": 1000,
        "mutated": true
      }
    }
  }
}
```

Phase 1 stores per-terminal preferences. Later phases extend without migration:

```json
{
  "svg-terminal": {
    "version": 2,
    "globalFontSize": 16,
    "terminals": {
      "resize-test": {
        "fontSize": 20,
        "cardW": 1600,
        "cardH": 1000,
        "mutated": true,
        "parent": "dev-stack",
        "position": { "x": 0, "y": 130, "z": 0 },
        "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 },
        "pinned": true
      }
    },
    "groups": {
      "dev-stack": {
        "position": { "x": -200, "y": 0, "z": 0 },
        "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 },
        "children": ["resize-test", "resize-test2"]
      }
    },
    "scenes": {
      "dev-workflow": {
        "camera": {
          "position": { "x": 0, "y": 20, "z": 900 },
          "lookAt": { "x": 0, "y": 0, "z": 0 },
          "fov": 50
        },
        "focused": ["resize-test"],
        "activeInput": "resize-test"
      }
    },
    "activeScene": "dev-workflow"
  }
}
```

### Server API

`/api/sessions` returns cols and rows per session:

```json
[
  { "name": "resize-test", "windows": 1, "cols": 80, "rows": 24 },
  { "name": "cp-greg_session_001", "windows": 1, "cols": 120, "rows": 40 }
]
```

Server reads from tmux: `list-sessions -F '#{session_name} #{session_windows} #{window_width} #{window_height}'`

---

## User Interactions

### Current (Implemented)

| Action | Context | Effect |
|--------|---------|--------|
| Click thumbnail | Ring view | Single focus — card fills viewport |
| Ctrl+click thumbnail | Any | Add terminal to multi-focus group |
| Click focused terminal | Multi-focus | Switch active input to that terminal |
| Escape | Zoomed | Return to multi-focus grid |
| Escape | Multi-focus grid | Unfocus all, return to ring |
| Shift+Tab | Multi-focus | Cycle through terminals, zoom each to fill viewport |
| Alt+scroll | Focused | Resize tmux ±2 cols, ±1 row (font size change) |
| Alt+drag | Focused | Resize card, proportional tmux resize on release |
| +/− buttons | Controls bar | Resize tmux ±4 cols, ±2 rows |
| ⊡ button | Controls bar | Optimize cols/rows to fill card at current font size |
| ⌊ button | Controls bar | Remove terminal from focus group (minimize to ring) |
| ⌊ on thumbnail | Sidebar | Remove that terminal from focus group |
| Title bar drag | Focused | Reposition card in 3D space |
| Drag (unfocused) | Ring view | Orbit camera |
| Shift+drag | Any | Pan camera X/Y |
| Ctrl+drag | Any | Rotate around origin |
| Scroll (unfocused) | Ring view | Zoom (FOV) |
| Shift+scroll | Any | Dolly Z |

### Planned (Not Implemented)

| Action | Context | Effect |
|--------|---------|--------|
| Save scene button | Header bar | Snapshot current layout with name |
| Scene selector | Header bar | Recall saved scene (animated transition) |
| Layout mode toggle | Header bar | Switch masonry/treemap/grid |
| Pin terminal | Context menu | Lock terminal to world position |
| Unpin terminal | Context menu | Return terminal to ring |
| Create group | Context menu | Bundle selected terminals into group |
| Drag to group | Multi-focus | Drag terminal onto group to join |
| Red dot | Card header | Remove from focus group |
| Yellow dot | Card header | Minimize to ring |
| Green dot | Card header | Optimize fit |

---

## Implementation Phases

### Phase 1: Dynamic Card Sizing (DONE)
- Server includes cols×rows in `/api/sessions`
- Cards sized from tmux cols×rows on startup
- Uniform visual weight in ring, different aspect ratios
- Frustum-projected multi-focus layout
- Cell-count proportional sizing in multi-focus
- Reactive card sizing (updateCardForNewSize)

### Phase 2: localStorage Persistence
- Save per-terminal: fontSize, cardW, cardH, mutated flag
- Save global: default fontSize
- Restore on reload (mutated terminals get saved values, others derive from tmux)
- Save on user action (alt+scroll, alt+drag, +/−, ⊡)

### Phase 3: Size Morphing on Startup (Big Bang)
- Cards start at uniform small size at origin
- Grow to target size during fly-in animation
- Position AND size interpolate over MORPH_DURATION
- Saved terminals grow to saved size, new terminals to calculated size

### Phase 4: Pinning
- Pin terminal to world position (survives focus/unfocus)
- Pinned terminals don't return to ring
- Store position/rotation in localStorage
- Context menu or keyboard shortcut to pin/unpin

### Phase 5: Groups
- Create named groups of terminals
- Group is a node with children — recursive
- Move/rotate group moves all children
- Groups survive reload via localStorage
- Drag terminal into/out of group

### Phase 6: Named Scenes
- Save current camera + terminal states as named scene
- Recall scene — animated camera transition
- Scene UI in header bar
- Camera-locked terminals follow between scenes

### Phase 7: Camera-Locked Terminals (HUD)
- Terminal with parent=camera stays fixed in viewport
- Offset in camera-local space (e.g., upper-right corner)
- Survives scene transitions — camera moves, HUD follows

### Phase 8: Layout Mode Switching
- Treemap mode — resize terminals to fill viewport (sends resize to tmux)
- Grid mode — uniform rows/columns
- Header bar toggle between masonry/treemap/grid
- Masonry remains default

### Phase 9: Header Bar UI
- Floating toolbar during multi-focus
- Layout mode selector
- Scene save/recall/rename
- Group creation/management

---

## Constraints

- 4x scale trick must be preserved (variable DOM size, CSS3DObject scale 0.25)
- SVG is the rendering target — no HTML overlays for terminal content
- Event routing flags must not be simplified (each prevents a tested bug)
- All 17 server tests must continue to pass
- tmux sessions are source of truth for cols/rows — read only, never override without user action
- No CSS font scaling — all visual size changes through tmux resize
- Camera points at origin — no offset math
- Sidebar is an overlay, not a subtracted region
- Everything is a node — same data model for terminals, groups, cameras

---

## Relationship to PHAT TOAD

The recursive node model aligns with PHAT TOAD's principle: every node runs the same lifecycle, same shape, different payload. The terminal persistence primitive is the leaf node. Groups, scenes, and camera nodes extend the same model without special-casing.

The localStorage schema grows from version 1 (per-terminal) to version 2+ (groups, scenes) without migration — new fields are additive.

The Prezi-style scene concept (objects in space, scenes as camera positions) was explored in an earlier session that evaluated Sozi (open-source Prezi). That session rejected Sozi in favor of custom implementation but adopted the conceptual model.
