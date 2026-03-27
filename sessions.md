# sessions.md — Live Project Context
# Backed up as sessions.md.{SESSION}-{STEP} before each optimize

---

## Project Identity

**Repo:** svg-terminal (`/srv/svg-terminal`)
**Branch:** dev
**What this is:** A standalone SVG-based terminal viewer that renders live tmux session output as vector graphics. Designed as a reusable component — first consumer is claude-proxy (SSH tmux multiplexer), eventual integration into PHAT TOAD's hierarchical agent dashboard.

---

## Active Direction

Building a zero-dependency Node.js server + self-contained SVG file that:
- Polls `tmux capture-pane -p -e` for screen snapshots
- Parses SGR escape codes into structured spans
- Renders as SVG `<text>` + `<tspan>` with CSS color classes
- Auto-updates via embedded `<script>` fetching a JSON API
- Supports visibility-aware polling (IntersectionObserver + character cell size thresholds)

Architecture: Approach 3 — bare `http` module, zero npm deps. The JSON API is the integration surface.

---

## Operational Conventions

[2026-03-27] Use journaling and sessions skills for all design/research phases.

---

## Key Technical Decisions

[2026-03-27] Zero npm dependencies — Node built-in `http` module only
[2026-03-27] SVG rendering follows termtosvg patterns: `dominant-baseline: text-before-edge`, `textLength` for monospace enforcement, CSS classes for standard 16 ANSI colors
[2026-03-27] Three-tier polling: >=4x6px char cells → 150ms, <4x6px → 2000ms, offscreen → stopped
[2026-03-27] Faithful ANSI color rendering (16 + 256 + truecolor), not a fixed theme
[2026-03-27] Target is standalone .svg file (goal B) that can be embedded anywhere

---

## Pending Items

[2026-03-27] Write design spec and get approval
[2026-03-27] Create implementation plan via writing-plans skill

---

## Session History (most recent first)

### Session 2026-03-27 — Initial Design
- Explored feasibility of SVG-based terminal viewer
- Researched existing tools: termtosvg, svg-term-cli, ansi-to-svg
- Explored claude-proxy and PHAT-TOAD-with-Trails for integration context
- Brainstormed architecture: 3 approaches → selected Approach 3 (zero deps, bare http)
- Designed SVG structure, SGR parser, JSON API, client update loop
- Key insight: read-only viewer avoids all the hard problems (input, cursor, clipboard)
