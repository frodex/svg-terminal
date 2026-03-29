# Terminal Persistence and Spatial Scenes — Design Spec

**Date:** 2026-03-28
**Status:** Draft
**Project:** svg-terminal

---

## Problem

Every terminal card starts at a fixed 1280×992 regardless of the terminal's actual dimensions. User customizations (font size, card size, position) are lost on reload. There is no concept of spatial arrangement persistence — users can't save and recall terminal layouts.

## Vision

A Prezi-style spatial composition system where terminals are nodes in a recursive scene graph. Users customize terminal size, font, and position. Named scenes save camera + layout state. Everything flies in from origin on load — a "big bang" where each node grows to its destination size as it travels to its saved position.

## Core Concept: Everything Is a Node

A single recursive data model for all spatial objects:

```
node: {
  id:        string,
  parent:    nodeId | "world",
  position:  {x, y, z},         // offset in parent's coordinate space
  rotation:  {x, y, z, w},      // quaternion
  scale:     {x, y, z},
  children:  [nodeId, ...],

  // Exactly one payload type (or null for pure group)
  terminal:  { sessionName, fontSize, cardW, cardH } | null,
  camera:    { fov, aspect, active } | null
}
```

### Node parenting determines behavior

| Parent | Behavior | Use case |
|--------|----------|----------|
| `camera` | Fixed in viewport, follows camera | HUD monitors, always-visible status |
| `group` | Moves with group, offset within group | Related terminals together (dev stack) |
| `world` | Fixed in world space | Pinned standalone terminals |
| `ring` (default) | Managed by ring animation layout | Unpinned terminals, current behavior |

Reparenting changes behavior. Drag a terminal from the ring to a group — it leaves the ring and locks to the group. Unpin — it returns to the ring.

### Scenes are named snapshots

A scene captures:
- Camera node state (position, orientation, fov)
- All terminal node states (position, size, fontSize, parent)
- Group states (position, rotation, children)
- Focus state (which terminals are focused, which has input)

Switching scenes = animated camera move to saved position. Terminal nodes stay put (unless reparented). Camera-locked terminals follow the camera.

### Big bang startup

On every page load, all terminals start at origin at a uniform small size. They simultaneously fly out and grow to their destinations:
- Ring terminals → ring positions at ring card size
- Pinned terminals → saved world positions at saved card size
- Group terminals → group-relative positions at saved size
- HUD terminals → camera-relative offset at saved size

Position AND size interpolate over `MORPH_DURATION`. The morph system already handles position — add size interpolation: `morphFromSize → targetSize`.

## Font Size as Primary User Preference

Font size is the user's core preference. Card dimensions derive from it:

```
cardW = cols × cellPixelWidth(fontSize)
cardH = rows × cellPixelHeight(fontSize) + headerHeight
```

Where `cellPixelWidth` and `cellPixelHeight` are functions of the chosen font size at 4x scale.

### Sizing fallback chain

When a terminal appears, size it by checking in order:

1. **Saved preference** (localStorage) — user previously customized this session → restore fontSize, cardW, cardH
2. **Derive from tmux** — no saved preference → read cols×rows from tmux, apply global default fontSize, calculate card dimensions to match terminal aspect ratio
3. **Default** — can't read tmux yet → use global fontSize with default cols×rows (80×24), optimize on first WebSocket data

### User actions that change sizing

| Action | Effect |
|--------|--------|
| Alt+scroll (focused) | Changes cols/rows in tmux by ±2/±1 steps. Text appears bigger/smaller. Card size unchanged. |
| Alt+drag (focused) | Changes card dimensions visually. On release, resizes tmux proportionally to fill new card at same font size. |
| +/− buttons | Changes cols/rows by ±4/±2 steps. Same as alt+scroll but discrete. |
| ⊡ Optimize | Calculates cols/rows that fill the current card at current font size. Sends resize to tmux. |

All actions that change sizing mark the terminal as `mutated: true` and persist to localStorage.

## Parameterized Decisions

These values are configurable, not hardcoded. The user reserves the right to change them after seeing implementation:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `globalFontSize` | 16 | Default cell pixel width at 4x scale |
| `minCardW` | 640 | Minimum card DOM width (4x) |
| `maxCardW` | 3200 | Maximum card DOM width (4x) |
| `minCardH` | 496 | Minimum card DOM height (4x) |
| `maxCardH` | 2400 | Maximum card DOM height (4x) |
| `altScrollStep` | 2 | Cols change per alt+scroll tick |
| `buttonStep` | 4 | Cols change per +/− click |
| `morphDuration` | 1.5 | Seconds for fly-in animation |

## Data Persistence

### localStorage schema

```json
{
  "svg-terminal": {
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

Phase 1 stores per-terminal preferences only. Later phases add:
- `position`, `rotation`, `parent` (pinning)
- `groups` (group definitions)
- `scenes` (named snapshots)

### Server API change

`/api/sessions` response adds cols and rows per session:

```json
[
  { "name": "resize-test", "windows": 1, "cols": 80, "rows": 24 },
  { "name": "editor", "windows": 1, "cols": 120, "rows": 40 }
]
```

Server reads these from tmux: `list-sessions -F '#{session_name} #{session_windows} #{window_width} #{window_height}'`

## Phase 1 Scope (What We Build Now)

1. **Server: include cols×rows in `/api/sessions`**
2. **Startup sizing: derive card dimensions from tmux cols×rows × fontSize**
   - No more hardcoded 1280×992 for all cards
   - Each card shaped to match its terminal's actual aspect ratio
   - Thumbnail size stays fixed (sidebar UI, not content)
3. **localStorage persistence**
   - Save per-terminal: fontSize, cardW, cardH, mutated flag
   - Save global: fontSize
   - Restore on reload (mutated terminals get saved values, others derive from tmux)
4. **Size morphing on startup**
   - Cards start at uniform small size at origin
   - Grow to target size during fly-in animation
   - Position AND size interpolate over MORPH_DURATION
5. **Existing resize features preserved**
   - Alt+scroll, alt+drag, +/−, ⊡ all work as currently implemented
   - Each action saves to localStorage

## Out of Scope (Later Phases)

- Pinning (position/rotation persistence, reparenting)
- Groups (rigid body collections of terminals)
- Named scenes (save/recall camera + layout)
- Scene transitions (animated camera moves)
- Scene UI (save/recall/rename controls)
- Multiple cameras

## Constraints

- 4x scale trick must be preserved (card DOM is 4x, CSS3DObject scale 0.25)
- SVG is the rendering target — no HTML overlays
- Event routing flags (mouseDownOnSidebar, suppressNextClick, etc.) must not be disrupted
- All 17 server tests must continue to pass
- tmux sessions are the source of truth for cols×rows — we read, never override without user action

## Relationship to PHAT TOAD Node Model

The recursive node model described here aligns with PHAT TOAD's principle: every node runs the same lifecycle, same shape, different payload. The terminal persistence primitive is the leaf node. Groups, scenes, and camera nodes extend the same model. The localStorage schema is designed to grow into the full node tree without migration.
