# Terminal Resize + Keybinding Config — Design Spec

## Goal

Add terminal resize (font zoom + PTY resize) with title bar controls, and make all input bindings configurable through a central keybinding config.

## Features

### 1. Title Bar Controls

When a terminal is focused, the header bar gains interactive controls:

```
● ● ●  session-name                    [ - ] [ + ] [ ⊡ ]
```

- **[-]** Decrease font size (zoom out — text smaller, same cols/rows)
- **[+]** Increase font size (zoom in — text larger, same cols/rows)
- **[⊡]** Optimize — resize PTY to fill current card at current font size

Font size is a CSS scale on the terminal's inner content. Increasing it makes text bigger but shows fewer lines. Decreasing shows more but smaller. The actual terminal dimensions (cols/rows) don't change.

Optimize calculates: given the current card pixel size and font scale, how many cols/rows fit? Then sends `tmux resize-pane -x cols -y rows`. The terminal reflows to fill the card exactly.

### 2. Alt+Drag Card Resize

Alt+drag on a focused terminal's edge resizes the card. On mouseup, the PTY is resized to match:

1. User Alt+drags card edge → card DOM element resizes
2. Calculate new cols/rows: `cols = cardPixelWidth / (CELL_W * fontScale)`, `rows = cardPixelHeight / (CELL_H * fontScale)`
3. Send `tmux resize-pane -x cols -y rows`
4. Terminal reflows, SVG viewBox updates, content fills new size

The 4x scale trick is maintained: the DOM element stays at 4x, CSS3DObject scale stays at 0.25. The resize changes the DOM element dimensions and the terminal dimensions together.

### 3. Keybinding Config

Central config object that all input handlers reference:

```js
const KEYBINDINGS = {
  // Mouse drag actions
  orbit:        { mouse: 0, modifier: null, context: 'unfocused', desc: 'Orbit camera' },
  selectText:   { mouse: 0, modifier: null, context: 'focused', desc: 'Select text' },
  resize:       { mouse: 0, modifier: 'alt', context: 'focused', desc: 'Resize terminal' },
  dollyXY:      { mouse: 0, modifier: 'shift', context: 'any', desc: 'Pan X/Y' },
  rotateOrigin: { mouse: 0, modifier: 'ctrl', context: 'any', desc: 'Rotate origin' },
  orbitFocused:  { mouse: 2, modifier: null, context: 'focused', desc: 'Orbit (focused)' },

  // Scroll actions
  scrollContent: { wheel: true, modifier: null, context: 'focused', desc: 'Scroll terminal' },
  zoomFOV:       { wheel: true, modifier: null, context: 'unfocused', desc: 'Zoom (FOV)' },
  zoomFOVCtrl:   { wheel: true, modifier: 'ctrl', context: 'any', desc: 'Zoom (FOV)' },
  dollyZ:        { wheel: true, modifier: 'shift', context: 'any', desc: 'Dolly Z' },

  // Keyboard shortcuts (focused terminal)
  fontUp:   { key: '=', modifier: 'ctrl', context: 'focused', desc: 'Increase font' },
  fontDown: { key: '-', modifier: 'ctrl', context: 'focused', desc: 'Decrease font' },
  optimize: { key: '0', modifier: 'ctrl', context: 'focused', desc: 'Optimize fit' },
  unfocus:  { key: 'Escape', modifier: null, context: 'focused', desc: 'Unfocus' },
  help:     { key: '?', modifier: null, context: 'unfocused', desc: 'Toggle help' },
};
```

All mouse/wheel/keyboard handlers check this config instead of hardcoded modifier checks. The help panel auto-generates from this config.

### 4. Font Scale System

Each terminal has a `fontScale` property (default 1.0):

- **Font up:** `fontScale *= 1.1` → CSS transform scale on the terminal inner content
- **Font down:** `fontScale /= 1.1` → same
- **Optimize:** calculate cols/rows at current fontScale, resize PTY

The SVG viewBox stays based on terminal dimensions. The `fontScale` is applied as a CSS transform on the `<object>` element, which scales the SVG rendering.

Constraint: fontScale changes are visual only — they don't affect the PTY or the 4x scale trick. The 4x trick operates at the CSS3DObject level, fontScale operates inside the terminal panel.

## Architecture

```
KEYBINDINGS config
  ├── onMouseDown: reads config to determine drag mode
  ├── onWheel: reads config to determine scroll action
  ├── keydown handler: reads config for keyboard shortcuts
  └── help panel: auto-generates control list from config

fontScale (per terminal)
  ├── +/- buttons adjust
  ├── CSS transform on <object> element
  └── optimize button reads to calculate cols/rows

resize flow
  ├── Alt+drag changes card DOM size
  ├── On mouseup: calculate cols/rows from card size + fontScale
  ├── Send tmux resize-pane -x cols -y rows
  └── SVG viewBox updates when server pushes new screen dimensions
```

## What Changes

| File | Changes |
|------|---------|
| dashboard.mjs | KEYBINDINGS config, refactor all input handlers to read config, font scale, resize drag, title bar controls, help panel auto-generation |
| dashboard.css | Title bar control button styles, font scale CSS |
| server.mjs | New WebSocket message type: `{ type: "resize", cols, rows }` → `tmux resize-pane` |
| index.html | No changes (title bar is created in JS per terminal) |

## Constraints

- 4x scale trick MUST be preserved — fontScale is a separate layer
- Keybinding config is the ONLY place input mappings are defined — no hardcoded modifier checks elsewhere
- Resize sends character grid (cols × rows), never pixel dimensions
- Font scale persists per terminal (survives unfocus/refocus in same session)
- Default keybindings match current behavior exactly — no UX change unless user remaps

## Out of Scope

- Keybinding UI editor (future — part of user preferences, task #19)
- Saving keybindings to server (future — needs user auth)
- Touch/pinch gestures (future)
- Resize handles (corner/edge grab indicators) — Alt+drag is the gesture, no visual handles yet
