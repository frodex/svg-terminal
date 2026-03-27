# sessions.md — Live Project Context
# Backed up as sessions.md.{SESSION}-{STEP} before each optimize

---

## Project Identity

**Repo:** svg-terminal (`/srv/svg-terminal`) — github.com/frodex/svg-terminal
**Branch:** dev
**What this is:** A standalone SVG-based terminal viewer that renders live tmux session output as vector graphics. Designed as a reusable component — first consumer is claude-proxy (SSH tmux multiplexer), eventual integration into PHAT TOAD's hierarchical agent dashboard.

---

## Active Direction

All 4 phases implemented and working:
- Phase 1: SGR parser + HTTP server + SVG viewer with live polling
- Phase 2: Visibility-aware polling (IntersectionObserver + cell size tiers)
- Phase 3: Multi-session dashboard with auto-discovery and selection
- Phase 4: Input box sending keystrokes to selected terminal

Current focus: fixing font rendering — Chrome blocks @font-face in standalone SVGs. Solution: serve terminals via HTML wrapper (`terminal.html`) with inline SVG, which allows embedded woff2 fonts. Dashboard updated to use `<iframe>` instead of `<object>`.

---

## Operational Conventions

[2026-03-27] Use journaling, sessions, and bibliography skills for all design/research phases.
[2026-03-27] Branch strategy: dev (active work) → test (staging/QA) → main (production releases). Repo: github.com/frodex/svg-terminal

---

## Key Technical Decisions

[2026-03-27] Zero npm dependencies — Node built-in `http` module only
[2026-03-27] SVG rendering: `dominant-baseline: text-before-edge`, explicit x-positioned `<tspan>` elements per span, runtime font measurement via getBBox()
[2026-03-27] Three-tier polling: >=4x6px char cells → 150ms, <4x6px → 2000ms, offscreen → stopped
[2026-03-27] Faithful ANSI color rendering (16 + 256 + truecolor), CSS classes for standard 16 colors
[2026-03-27] Embedded FiraCode Nerd Font Mono subset (31KB woff2, base64 data URI) for Unicode glyph coverage — covers ASCII, box-drawing, powerline, prompt symbols
[2026-03-27] `textLength` attribute abandoned — caused character stretching. Replaced with per-tspan x positioning using measured cell width
[2026-03-27] Standalone `.svg` cannot load fonts (Chrome security). Solution: HTML wrapper (`terminal.html`) with inline SVG inherits the @font-face from the HTML document context
[2026-03-27] Dashboard uses `<iframe src="/terminal?session=X">` not `<object>` — iframes support font loading in their HTML content

---

## Pending Items

[2026-03-27] Verify font rendering fix in Chrome with new terminal.html approach
[2026-03-27] Clean up font-test artifacts (font-test.html, font-test tmux session)
[2026-03-27] Push final changes to dev

---

## Session History (most recent first)

### Session 2026-03-27 — Full Implementation
- Implemented all 4 phases (11 tasks) via subagent-driven development
- Phase 1: color-table.mjs, sgr-parser.mjs (22 tests), server.mjs (14 tests), terminal.svg
- Phase 2: IntersectionObserver + measureTier() for visibility-aware polling
- Phase 3: index.html dashboard with CSS grid, session auto-discovery, card selection
- Phase 4: POST /api/input endpoint, input bar in dashboard with special key handling
- Fixed default pane from '%0' to '0' (tmux uses pane index not ID)
- Fixed character spacing: removed textLength, added runtime font measurement via getBBox()
- Discovered Chrome blocks @font-face in standalone SVGs — created HTML wrapper approach
- Embedded FiraCode Nerd Font Mono subset (31KB) for ❯, box-drawing, powerline glyphs
- Created font-test.html diagnostic page confirming font works in HTML but not standalone SVG
- Pivoted dashboard from `<object>` + `.svg` to `<iframe>` + `.html` for font support
- All 36 tests passing (22 SGR parser + 14 server)
