# svg-terminal

A live SVG terminal viewer with a 3D dashboard for visualizing multiple tmux sessions. Renders terminal output as vector graphics — crisp at any zoom level.

## What's Here

### Core Terminal Viewer (Working)

The SVG terminal viewer captures live tmux session output and renders it as vector SVG in a browser.

**Server** (`server.mjs`) — zero-dependency Node.js HTTP server:
- `GET /` — serves the dashboard
- `GET /terminal.svg?session=NAME` — serves the SVG terminal viewer for a session
- `GET /api/pane?session=NAME&pane=0` — returns parsed terminal content as JSON (SGR → structured spans)
- `GET /api/sessions` — lists available tmux sessions
- `POST /api/input` — sends keystrokes to a tmux session

**SGR Parser** (`sgr-parser.mjs`) — converts ANSI escape sequences to structured span objects with colors, bold, italic, etc. Full support for standard 16 colors, 256-color, and truecolor.

**Color Table** (`color-table.mjs`) — 256-color index to hex lookup.

**SVG Viewer** (`terminal.svg`) — self-contained SVG with embedded JavaScript:
- Polls `/api/pane` every 150ms
- Renders text as `<text>` + `<tspan>` SVG elements
- Runtime font measurement via `getBBox()` for correct character spacing
- Embedded FiraCode Nerd Font subset (31KB woff2) for Unicode glyph coverage
- Visibility-aware polling: offscreen SVGs stop polling, tiny ones poll at 2s

**Tests:** 22 SGR parser tests + 14 server tests (`node --test test-sgr-parser.mjs test-server.mjs`)

### 3D Dashboard (In Development)

The dashboard (`dashboard.mjs` + `dashboard.css`) uses Three.js CSS3DRenderer to display terminal panels in 3D space. Currently functional but being redesigned based on the layout prototypes below.

### Layout Design Studio (Active)

A collection of interactive prototypes for exploring 3D terminal layouts, built during the brainstorming phase. These are the active design tools:

**`ring-mega-saved.html`** — The primary design studio. Full control panel with:

Per ring (outer + inner independently):
- Card count (1-12 outer, 1-8 inner)
- Radius (adjustable ring size)
- Mode: Upright, Locked to Ring, Gravity Pull, Free Spin
- Face Camera toggle (counter-rotates cards against ring tilt)
- Spin direction (reverse / stop / forward)
- Ring Tilt X/Y/Z — each with From/To range + Speed for oscillation + lock button
- Card Tilt X/Y/Z — same From/To/Speed/Lock pattern
- Camera: Zoom, Push (translateZ into scene), Pan X/Y

Uses real CSS 3D transforms (`transform-style: preserve-3d`).

**Other saved prototypes:**
- `ring-final-saved.html` — 5-mode ring cycle (upright, locked, gravity, tilt, free spin)
- `ring-controls-saved.html` — earlier control panel version
- `multi-card-test-saved.html` — the test that confirmed locked-to-ring math
- `single-card-test-saved.html` — single card rotation test with angle buttons

## Running

```bash
# Start the terminal viewer server
cd /srv/svg-terminal
node server.mjs
# Open http://localhost:3200/

# The design studio prototypes are served by the superpowers brainstorm companion
# (not the main server). They're standalone HTML files that can also be opened directly.
```

**Requirements:** Node.js 22+, tmux with active sessions.

## Architecture

```
Browser                          Server (node server.mjs)
  │                                │
  ├── /terminal.svg?session=X      │
  │   (self-contained SVG,         │
  │    polls /api/pane)             │
  │                                │
  ├── /api/pane ──────────────────→ tmux capture-pane -p -e
  │   ← JSON { width, height,     │   → sgr-parser.mjs
  │      cursor, title, lines }    │
  │                                │
  ├── /api/sessions ──────────────→ tmux list-sessions
  │   ← JSON [{ name, windows }]  │
  │                                │
  └── /api/input ─────────────────→ tmux send-keys
      → { session, pane, keys }    │
```

## Key Technical Decisions

- **Zero npm dependencies** for the server — Node built-in `http`, `child_process`, `fs`
- **SVG vector rendering** — text is `<text>` + `<tspan>`, not canvas. Crisp at any zoom.
- **Runtime font measurement** — `getBBox()` on a hidden `<text>` element to get actual character width, not hardcoded metrics
- **Embedded font** — FiraCode Nerd Font Mono subset (31KB woff2, base64 data URI) for Unicode terminal symbols
- **Real CSS 3D** for the design studio — `transform-style: preserve-3d` on ring containers, cards positioned in 2D, container rotation handles 3D projection
- **`transform-origin: 50% 50%`** for all card rotations — position computed mathematically, rotations relative to card center. Composable with tilt, face-camera, and mode rotation.

## File Structure

```
/srv/svg-terminal/
├── server.mjs                 # HTTP server + API
├── sgr-parser.mjs             # ANSI SGR parser
├── color-table.mjs            # 256-color lookup
├── terminal.svg               # Self-contained SVG terminal viewer
├── terminal.html              # HTML wrapper (for font loading)
├── index.html                 # Dashboard shell
├── dashboard.mjs              # 3D dashboard (Three.js CSS3DRenderer)
├── dashboard.css              # Dashboard styles
├── polyhedra.mjs              # Polyhedra vertex math
├── test-sgr-parser.mjs        # SGR parser tests
├── test-server.mjs            # Server API tests
├── test-polyhedra.mjs         # Polyhedra math tests
├── ring-mega-saved.html       # Design studio (primary)
├── ring-final-saved.html      # 5-mode ring demo
├── ring-controls-saved.html   # Earlier control panel
├── multi-card-test-saved.html # Locked-to-ring test
├── single-card-test-saved.html # Single card test
├── sessions.md                # Live project context
└── docs/
    ├── bibliography.md
    ├── research/              # Design journals
    └── superpowers/
        ├── specs/             # Design specs
        └── plans/             # Implementation plans
```

## Branch Strategy

- `dev` — active development
- `test` — staging/QA
- `main` — production releases

## Status

- **Terminal viewer:** Complete and working (Phases 1-4)
- **3D dashboard:** Functional but being redesigned
- **Design studio:** Active — iterating on ring layouts, tilt, and camera controls
- **Next:** Lighting effects, finalize layout, integrate into production dashboard
