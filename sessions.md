# sessions.md — Live Project Context
# Backed up as sessions.md.{SESSION}-{STEP} before each optimize

---

## Project Identity

**Repo:** svg-terminal (`/srv/svg-terminal`) — github.com/frodex/svg-terminal
**Branch:** camera-only-test (active), dev (integration target)
**What this is:** A standalone SVG-based terminal viewer with a 3D dashboard. Renders live tmux sessions as vector graphics. First consumer: claude-proxy. Future: PHAT TOAD hierarchical agent dashboard.

---

## Active Direction

3D dashboard is functional — Three.js CSS3DRenderer positions terminal panels in 3D space. Currently iterating on the layout/arrangement of terminals in the overview. The focus/unfocus, input bar, sidebar thumbnails, and session discovery all work.

**Current design decision:** Choosing between geometric layout patterns for the overview:
- Nested rotating rings (terminals on counter-rotating circles)
- Golden spiral (Fibonacci spiral, largest at center)
- Hexagonal honeycomb (hex grid with center primary)
- Fractal tree (maps to PHAT TOAD hierarchy)

Key requirement: terminals should be oriented in 3D (not flat/locked), with lazy billboard drift toward viewer. Structure slowly rotates. No collisions. Most terminal faces visible.

---

## Operational Conventions

[2026-03-30] PHAT TOAD system rules (v0.0.1) adopted for all sessions. Source: /srv/PHAT-TOAD-with-Trails/steward/system.md. Core: understanding before action, proposals not declarations, constraint declarations before cross-node work, comprehension tests before integration, no premature GO.
[2026-03-30] PHAT TOAD agent-handoff protocol (v0.0.1) adopted. Source: /srv/PHAT-TOAD-with-Trails/steward/agent-handoff.md. Core: exchange before propose, comprehension verification via written summaries + diff, break test exchange, scope agreement, architecture only after comprehension gates pass.
[2026-03-27] Use journaling, sessions, and bibliography skills for all design/research phases.
[2026-03-27] Branch strategy: dev (active work) → test (staging/QA) → main (production releases). Repo: github.com/frodex/svg-terminal
[2026-03-27] Public dev preview: needs port remapping from 51045 to whatever the brainstorm companion starts on (port not configurable)
[2026-03-29] New tmux sessions use `trap '' TSTP` to ignore Ctrl+Z (SIGTSTP). Prevents accidental server suspension. Existing sessions unprotected.
[2026-03-29] QC procedure: use checkerboard test pattern (alternating █ and ─, offset each row) at various card sizes, terminal sizes, and aspect ratios to verify overlay alignment. Drift is visible as pattern/overlay phase mismatch.

---

## Key Technical Decisions

[2026-03-27] Zero npm dependencies for server — Node built-in `http` module only (relaxed 2026-03-30: added better-sqlite3, openid-client for auth)
[2026-03-30] Auth architecture: server.mjs owns sessions/cookies, calls claude-proxy API for sessions only. OAuth/user-store/provisioner live in svg-terminal.
[2026-03-30] User approval model: pending→approved→Linux account. Tiered: can_approve_users/admins/sudo. Root delegates. Pre-approve by email.
[2026-03-30] Auth disabled when no OAuth env vars set (dev mode returns root user for all requests)
[2026-03-27] SVG rendering: `dominant-baseline: text-before-edge`, explicit x-positioned `<tspan>` per span, runtime font measurement via getBBox()
[2026-03-27] Three-tier polling: >=4x6px char cells → 150ms, <4x6px → 2000ms, offscreen → stopped
[2026-03-27] Embedded FiraCode Nerd Font Mono subset (31KB woff2, base64 data URI)
[2026-03-27] 3D dashboard: Three.js CSS3DRenderer (not WebGL) — keeps SVG text as real DOM elements
[2026-03-27] 2x CSS size (640x496) with CSS3DObject scale(0.5) — forces Chrome to rasterize at high res, fixes blur
[2026-03-27] CSS3DObject billboarding: use `Matrix4.lookAt(camera, terminal, up)` not `(terminal, camera, up)` — CSS3DObject faces -Z
[2026-03-27] `camera.setViewOffset()` doesn't work well with CSS3DRenderer — removed, using camera/target X offset instead
[2026-03-27] Dashboard reverted from iframe back to `<object>` for terminal embedding — simpler, font issue is cosmetic
[2026-03-27] Pane titles fetched from tmux `#{pane_title}` — shows Claude Code task names from claude-proxy OSC 0 sequences
[2026-03-28] 3D mouse controls: drag=orbit, shift+drag=dollyXY, ctrl+drag=rotateOrigin, scroll=zoom, shift+scroll=dollyZ
[2026-03-28] Multi-focus: ctrl+click adds terminals, grid layout, yellow neon border for input-active
[2026-03-28] Event routing: separate paths for sidebar thumbnails vs 3D scene clicks, mouseDownOnSidebar flag prevents double-fire
[2026-03-28] Scene lighting: gray gradient background, specular 0.4, floor Y=-300, dark shadows
[2026-03-28] Text crispness: SVG is the target — no HTML overlays or crossfades, solve within SVG pipeline
[2026-03-28] Interactive terminals: WebSocket via ws package (already in node_modules via puppeteer)
[2026-03-28] Async tmux: execFileSync → async execFile wrapped in tmuxAsync() Promise helper
[2026-03-28] Server-side diff: server polls at 30ms, pushes only changed lines via WebSocket
[2026-03-28] Direct keystroke capture: document-level keydown replaces input bar text field
[2026-03-28] Key translation: browser KeyboardEvent.key → tmux send-keys names (SPECIAL_KEY_MAP)

---

## Pending Items

[2026-03-28] Text crispness optimization within SVG pipeline (Nx scaling sweet spot)
[2026-03-28] Integrate oscillation parameters from design studio into live dashboard

---

## Session History (most recent first)

### Session 2026-03-30 — Claude-Proxy Integration + Login/User Management
**Part 1: WebSocket Integration**
- Communicated directly with claude-proxy agent via WebSocket (protocol spec + sign-off)
- Wrote integration spec + implemented 8 tasks:
  - Normalized delta/key/scroll formats to claude-proxy standard
  - WebSocket proxy for cp-* sessions working
  - Session 8 renders and accepts input
- 18 server + 23 E2E tests passing

**Part 2: Login & User Management (overnight build)**
- Brainstormed with user: OAuth login, request-access flow, admin UI
- Key decisions:
  - svg-terminal IS the web UI, claude-proxy is API + SSH only
  - Codebases merging — svg-terminal leads
  - OAuth/user-store/provisioner ported from claude-proxy into svg-terminal
  - Tiered approval: can_approve_users/admins/sudo, root delegates
  - Pre-approve by email for classroom enrollment
  - Auth disabled in dev mode (no OAuth env vars)
- Wrote spec: docs/superpowers/specs/2026-03-30-login-and-user-management-design.md
- Wrote plan: docs/superpowers/plans/2026-03-30-login-and-user-management.md
- Implemented all 8 tasks:
  - session-cookie.mjs (HMAC-SHA256)
  - user-store.mjs (SQLite: users + provider_links)
  - provisioner.mjs (useradd, groupadd, generateUsername)
  - auth.mjs (Google/Microsoft OIDC + GitHub OAuth)
  - login.html, pending.html, admin.html, admin-client.mjs
  - server.mjs wired with auth middleware + all routes
- Tests: 18 server + 16 auth + 23 E2E = all passing
- Pages live: /login, /pending, /admin, /auth/me
- Auth disabled in dev (AUTH_ENABLED=false, no env vars set)

**Part 3: Single WebSocket Architecture (in progress)**
- Discovered root cause of scroll/keystroke bugs: dual WebSocket per terminal
  - WS #1 inside SVG `<object>` (rendering), WS #2 opened by dashboard (input)
  - For proxied sessions, two independent bridges — scroll/input don't share state
- History: dual WS was a patch from read-only SVG cards + input bar era. Should have been removed when direct keystroke capture was added.
- Attempted and rejected approaches:
  - Inline SVG (Approach 3): font metrics differ between inline and `<object>` contexts. Days of calibration lost.
  - HTML text overlay: same font mismatch — 0.248px/char drift, ~20px by column 80
  - Confirmed: HTML text degrades under CSS3D transforms, SVG stays crisp — `<object>` SVG is correct for rendering
- Verified via puppeteer POC: contentWindow function calls work on SVG `<object>` (set/call functions, callbacks, postMessage)
- Architecture reviewed by two subagents, both confirmed contentWindow bridge is the right approach
- Plan written: docs/superpowers/plans/2026-03-30-single-websocket.md
- Task 1 complete: terminal.svg exports (sendToWs, _wsReady, _screenCallback)
- Tasks 2-4 in progress

**Still needed:**
- Complete single-WS tasks 2-4 (sendInput routing, callback registration, remove inputWs)
- Configure real OAuth credentials (env vars)
- Test full OAuth flow end-to-end with a real provider
- Test provisioning (useradd) with a real approval
- Repo consolidation decision (svg-terminal + claude-proxy)
- Branch: camera-only-test

### Session 2026-03-28 — Interactive Terminals (WebSocket)
- Converted all tmux calls to async (execFileSync → tmuxAsync)
- Added WebSocket server endpoint (/ws/terminal) with ws package
- Server-side 30ms polling with line-level diff, pushes deltas
- SVG client WebSocket with automatic polling fallback
- Direct keystroke capture in dashboard (replaces input bar)
- Key translation map for special keys and Ctrl combos
- Paste support via clipboard API
- Per-terminal input WebSocket opened on focus
- Expanded special key whitelist (F1-F12, PgUp/PgDn, all Ctrl combos)
- Version bumped to 0.3.0

### Session 2026-03-28 — 3D Controls + Multi-Focus + Lighting
- Implemented full 3D mouse controls (orbit, pan, dolly, zoom)
- Added scene lighting (specular highlights, shadows, gray gradient background)
- Built multi-focus system (ctrl+click to add, grid layout, yellow input-active border)
- Fixed event routing: sidebar thumbnails vs 3D scene ctrl+click conflict
- Fly-in animation: cards spawn at random 3D angles, slerp to face-camera
- Help panel with frosted glass overlay (? button upper-left)
- Discussed text crispness — decided SVG is the target, no HTML overlay hacks
- User rejected ring layout rewrite — accepted current arc layout

### Session 2026-03-27 — 3D Dashboard + Layout Iteration
- Implemented 3D dashboard with Three.js CSS3DRenderer
- Debugged billboard facing (was 180° reversed), backface-visibility, blur (2x trick)
- Debugged click detection (CSS3DRenderer intercepts events — solved with bounding rect hit testing)
- Explored layout options via visual companion: arc, staggered grid, amphitheater, constellation, nested rings, golden spiral, honeycomb, fractal tree
- User preference: geometric/fractal patterns with terminals at nodes, oriented in 3D not locked flat
- Added pane title display from tmux (shows Claude Code task names)
- Scroll zoom and right-click orbit added
- Camera offset for sidebar centering (removed setViewOffset, using position offset)

### Session 2026-03-27 — Full SVG Viewer Implementation
- Implemented all 4 phases (11 tasks) via subagent-driven development
- Phase 1: color-table.mjs, sgr-parser.mjs (22 tests), server.mjs (14 tests), terminal.svg
- Phase 2: IntersectionObserver + measureTier() for visibility-aware polling
- Phase 3: index.html dashboard with session auto-discovery
- Phase 4: POST /api/input endpoint, input bar with special key handling
- Fixed default pane '%0' → '0', character spacing via runtime font measurement
- Embedded FiraCode Nerd Font subset for Unicode glyph coverage
- All 36 tests passing (22 SGR parser + 14 server)
