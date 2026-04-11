# sessions.md — Live Project Context
# Backed up as sessions.md.{SESSION}-{STEP} before each optimize

---

## Project Identity

**Repo:** svg-terminal (`/srv/svg-terminal`) — github.com/frodex/svg-terminal
**Branch:** main (single line of truth — all feature branches merged and deleted 2026-04-04)
**What this is:** A standalone SVG-based terminal viewer with a 3D dashboard. Renders live tmux sessions as vector graphics. First consumer: claude-proxy. Future: PHAT TOAD hierarchical agent dashboard.

---

## Active Direction

3D dashboard is functional — Three.js CSS3DRenderer positions terminal panels in 3D space. Layout system implemented with composable slot maps and mutation operations. Performance tier system handles mobile/weak-GPU degradation. Focus/unfocus, input bar, sidebar thumbnails, session discovery, and claude-proxy integration all work.

**Current work:** UI bug fixes (focus positioning, Max All pipeline). Card subscription manager spec + plan written, ready for implementation. Auth system complete (Phase 1+2). OAuth login (Google/Microsoft/GitHub), admin panel with full user lifecycle, session authorization with feature flag, API key store for WS auth, WS consolidation (session ops over authenticated WS), reconnection overlay, admin PIN with sudo window, rate limiting, dev mode hardening. Claude-proxy viewOnly enforcement added. Cookie fallback removed — API key is sole WS credential.

---

## Operational Conventions

[2026-04-03] **Verify against running code, not stale processes:** After any change to `server.mjs`, `dashboard.mjs`, `terminal.svg`, or claude-proxy, **restart the relevant systemd units before manual testing** — otherwise the browser exercises old bundles / old Node code. Typical: `systemctl restart svg-terminal` after svg-terminal edits; restart `claude-proxy` too when testing proxy↔dashboard integration or subscribe/reconnect behavior. Automated `node --test` spawns its own server and does not replace this.

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
[2026-04-05] All Linux user accounts must use `cp-` prefix. Deactivated accounts use `cpx-` prefix. System accounts (root, claude-proxy) are outside this namespace and cannot be assigned via admin panel.
[2026-04-05] User deletion is a 2-phase process: Deactivate (soft delete, cp→cpx, login removed) then Purge (permanent). No direct delete.
[2026-04-05] Documentation files use stepped versioning (v0.1, v0.2, etc). Always cp to next version BEFORE editing. Never overwrite.
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
[2026-04-04] Performance tiers: 3-tier system (full/reduced/minimal) with auto detection. `detectGPU()` identifies software renderers; `applyPerfTier()` controls ring spin, shadows, specular, RENDER_SCALE, and card visibility centrally.
[2026-04-04] Compositor-safe resize: `onResize` hides all CSS3DObjects BEFORE `renderer.setSize()` — prevents mobile compositor from choking on CSS3D transforms at the new viewport size. Cards are re-shown after resize and tested.
[2026-04-04] 8-frame rAF resize test: after resize, renders 8 frames and measures p90 frame time. Cascading degradation (tier 0→1→retest→2) with coarse threshold 20ms, fine 35ms. Allows re-promotion on conditions improving (e.g., rotate back to portrait).
[2026-04-04] Tier 2 overview visibility: `tier2CardShouldShow` hides all overview cards on coarse+landscape (compositor can't handle full ring); shows all on desktop or portrait. Trade-off: empty ring on phone landscape vs. frozen/glitched cards.
[2026-04-04] Background FPS sampler: 3-second window in `animate`, skips first 33% of frames, uses avg frame time with coarse-aware thresholds (42ms/50ms for tier 2, 33ms for tier 1). Fires once then stops (`_perfCheckPhase=2`); re-armed on resize.
[2026-04-04] Thumbnail data path: `routeDashboardMessage` populates `t.screenLines` directly from WebSocket screen/delta messages — decoupled from SVG `<object>` load state. Fixes thumbnails being empty when cards are `display:none` (CSS3DObject.visible=false).
[2026-04-04] claude-proxy reconnection: `cpResubscribeAll()` re-subscribes WebSocket sessions after proxy restart. `cpPushFullScreensAfterCpResubscribe()` sends full screen snapshots to avoid diff-only frames. Bridge ordering: register event bridges before fetching screen content.
[2026-04-04] Render scaling: DOM_SCALE=4, WORLD_SCALE=1/DOM_SCALE, RENDER_SCALE_DEFAULT=2. Tier ≥1 drops RENDER_SCALE to 1. `resizeRenderer()` centralizes setSize + transform logic.
[2026-04-05] OAuth callback URL uses `PUBLIC_URL` env var (not hardcoded localhost). Google OIDC requires `iss` parameter passthrough from callback query string.
[2026-04-05] Multi-provider auth: `provider_links` table maps multiple OAuth providers to one user. Auth callback checks `findByProvider` first, then `findByEmail`. Session cookie uses primary user email regardless of which provider was used to sign in.
[2026-04-05] User lifecycle states: pending → approved → deactivated → (reactivated as pending, or purged). Deactivate renames cp-→cpx-, sets nologin shell, removes provider links. Reactivate restores cp-, sets pending, user must re-auth.
[2026-04-05] Security hardening: CSRF double-submit cookie, auth on all admin/SSE/WebSocket endpoints, SSRF protection on /api/proxy, 1MB request body limit, CSP headers, WebSocket origin validation, bounded OAuth state map, reserved username blocking, DB file permissions 0600, no hardcoded AUTH_SECRET fallback, restricted CORS to PUBLIC_URL.
[2026-04-06] Focus positioning fix: `updateCardForNewSize` was overwriting `targetPos` with mid-morph `currentPos` during card resize events. Fixed to apply anchor shift delta independently to both `currentPos` and `targetPos`. Race condition: SVG measurement correction or perf tier resize firing during the 1.5s morph window.
[2026-04-06] Max All pipeline: complete rewrite as multi-step process. Pre-compute equalize targets (16px font) → reset cards to natural size for target dims → layout (frustum-fit) → expand card DOM to match slot aspect → direct frustum repositioning (bypasses layout's terminal-aspect letterbox) → send equalize resize. Removed old `maximizeCardToSlot` and `_fillSlot` mechanism.
[2026-04-06] Max All equalize: derives rows from cols using slot aspect ratio (not independent rounding) to eliminate letterbox gaps. Uses `Math.ceil` for cols. Accounts for HEADER_H in content area calculation.
[2026-04-06] `optimizeTermToCard` sets `_suppressRelayout = true` alongside `_lockCardSize` to prevent resize response from triggering re-layout that undoes card positioning.
[2026-04-06] Layout options (top-bar-multi) always visible regardless of focus count.

---

## Pending Items

[2026-03-28] Text crispness optimization within SVG pipeline (Nx scaling sweet spot)
[2026-03-28] Integrate oscillation parameters from design studio into live dashboard
[2026-04-04] Top menu bar implementation (plan: docs/superpowers/plans/2026-04-04-top-menu-bar.md)
[2026-04-04] Re-arm background FPS sampler on addTerminal (gap: new terminals increase load but don't trigger re-evaluation)
[2026-04-04] **claude-forker:** Implement v0.8 source-verified fix plan — `claude-forker/docs/2026-04-04-v0.8-source-verified-fix-plan.md` (tool `0.2.0`, SPEC `v0.0.9`, `tests/test-fork.sh`, `docs/migration.md`). Next agent owns implementation; journal: `docs/research/2026-04-04-v0.1-claude-forker-v0.8-plan-handoff-journal.md`.
[2026-04-05] ~~**Legacy cleanup:**~~ DONE — HTTP endpoints removed, WS-only data paths, dead code cleaned up. Path B (direct tmux) fully removed — all sessions via claude-proxy.
[2026-04-05] **Message pipeline spec:** Verified flow tmux PTY → TerminalMirror (30ms poll) → Unix socket → cpOnDataChunk → WS → browser. Journal v0.2 confirmed. Spec in progress — event-driven TerminalMirror, focus-aware polling, backpressure handling.
[2026-04-05] **Session settings dashboard handler:** Design in progress. ViewOnly air-gapped router (intent table with validate/encode), card title bar authorization badges ([OWNER], [VIEW ONLY], etc.), access revocation with content clearing + 10s countdown. Missing: dashboard handler for `session-settings` WS messages.
[2026-04-05] **Hierarchical group permissions:** Design needed. cp-root group, per-group owner/admin, composable group access. Separate brainstorm phase.
[2026-04-05] **claude-proxy auth fix:** DONE — admin bypass + cp-users gate in listSessionsForUser and canUserAccessSession (bd42aae).
[2026-04-05] **svg-terminal authorizeSession:** Needs update — missing allowedGroups check, should mirror claude-proxy's canUserAccessSession logic including cp-users gate.
[2026-04-05] **Button factory consolidation:** Pending — mkHdrBtn, static HTML buttons, sidebar divs need unified approach. Action buttons (auto-blur) vs UI buttons (hold focus). Needed before adding search UI.
[2026-04-05] **Future card types:** File viewer and file transfer cards planned — all via WebSocket, no HTTP endpoints.
[2026-04-05] **Fork menu item on cards:** Backend exists (WS fork-session), needs UI — right-click or menu on terminal card to fork.
[2026-04-05] **Idle time tracking:** claude-proxy composeTitle tracks connected SSH clients but WS viewers don't register. Idle time not updated on WS input path.
[2026-04-06] **Card subscription manager:** IMPLEMENTED. CARDS sub-panel in hamburger menu, persistent subscription state (SQLite), thumbnail buttons, orange badge, status bar counts, search/sort, save current state, admin batch terminate. Name mismatch fix: all paths now use `s.id || s.name` consistently (cp- prefix).
[2026-04-06] **Drag-and-drop thumbnail reordering:** Pending. User wants drag-to-reorder in sidebar thumbnails AND in CARDS panel list. "Save Current State" should push order to dashboard. Needs design/plan.
[2026-04-07] **Chat console card:** New card type — multi-user text chat running through tmux. Format: TIMESTAMP/USER: message. Compose bar attaches to it for input. Persistent via tmux session. Needs design/plan.
[2026-04-07] **Compose mode refinements done:** Ctrl+Space opens compose if closed, toggles focus if open. X button closes. Click card blurs compose. Compose open/closed + perf mode persist in localStorage. Gold header when compose is focused.
[2026-04-10] **Remote session input dies after first keystroke via svg-terminal:** Session works fine via direct SSH/tmux attach. Via svg-terminal, the card shows content on restart but dies after first keystroke. Logs show `capture-pane` failing on local socket — remote sessions have no local socket, only an SSH PTY bridge. The scroll/capture path assumes local tmux, breaks for remote. The PTY write path (pty.write → SSH → tmux) should work but something in the error cascade from the failed capture-pane may be killing the bridge. Needs investigation in claude-proxy's remote session data path — separate the local tmux operations (capture-pane, resize) from the SSH PTY path.
[2026-04-10] **Remote session prerequisites check:** Before launching a remote session (any profile), claude-proxy should SSH to the remote host and verify: (1) tmux installed, (2) the profile's command installed (cursor-agent, claude, bash). If missing, install automatically (apt install tmux, npm install cursor-agent, etc). Similar to how launch-claude-remote.sh handles claude installation. Applies to all profiles — claude, cursor, shell. Currently fails with cryptic "tmux: command not found" if tmux isn't on the remote host.
[2026-04-08] **URL click architecture rework needed:** Current approach maps screen clicks to cell coordinates then checks if a URL is at that cell. Fails when URL fills last column (click on row below maps to URL row via letterbox/boundary rounding). User proposes: calculate URL pixel bounds from text content, draw clickable regions mapped onto SVG. Also: multi-line URL underlines may be broken after prior fixes. See wiki bug report: wiki.droidware.ai/projects/default/pages/bug-report-for-svg-terminal-url-decoder-clicks-on-card-send-link-when-they-shouldnt
[2026-04-08] REPLACED BY ABOVE: Clicking the row BELOW a URL triggers the URL on the row above. `screenToCell` uses `Math.floor(svgY / cellH)` — if cellH is slightly too large, clicks near the top of a row map to the row above. Investigate: compare cellH (from r1.y - r0.y) vs actual rendered row height. May need `Math.round` or measurement correction. Seen on narrow side-panel cards where URL fills the full terminal width.
[2026-04-07] **claude-proxy restart race condition:** Root cause found in session-manager.ts — old PTY onExit callback fires after new session created with same tmuxId, deleting the new session from the Map. Guard added (check current.pty === pty before delete). BUT: this guard can cause sessions to appear "dead" while tmux is still alive (session manager loses track). Needs deeper investigation — the dead sessions list should verify tmux is actually dead, not just check the sessions Map.
[2026-04-07] **Unify session lifecycle path:** `sendSessionDiscovery` does session-add + bridge + initial screen fetch. `notifyDashboardCpSessionCreated` (used by create/restart/fork) only does session-add. These should be ONE function: `addSessionToDashboard(ws, session, user)` that handles the full lifecycle regardless of how the session was created. Current workaround: restart/fork handlers call bridgeClaudeProxySession directly + 1s retry. Refactor: merge into single path, eliminate notifyDashboardCpSessionCreated.
[2026-04-07] **Delta rendering glitch under load:** Intermittent character loss at SGR formatting boundaries (e.g., space between normal and blue text). Full screen data is correct (Shift+Ctrl+R fixes it). Only occurs under load or on late-loaded cards. Likely cause: rapid delta updates where second delta computes against stale prevState. Investigate claude-proxy TerminalMirror delta coalescing or add debounce/frame-sync in terminal.svg renderMessage.
[2026-04-06] **Persistent layout save/recall:** Pending. Save current layout (active layout key, slot assignments, card dimensions, terminal cols/rows) to server so it restores on reboot. Architecture should support named presets — save/recall multiple layouts, with and without card assignments. Existing `save-layout` WS message type exists but writes to file, not DB. Needs design/plan. CARDS sub-panel in hamburger menu, persistent subscription state (SQLite), thumbnail buttons (▶/⏸ bottom-center, ⏹ upper-left, ✕ upper-right), orange badge, status bar counts, search/sort, save current state, admin batch terminate. Spec: `docs/superpowers/specs/2026-04-06-v0.2-card-subscription-manager-design.md`. Plan: `docs/superpowers/plans/2026-04-06-v0.1-card-subscription-manager.md`.

---

## Session History (most recent first)

### Session 2026-04-06/07 — UI Bugs, Max All, Card Subscriptions, Compose Mode

**Part 1: Bug Fixes**
- Focus positioning race: `updateCardForNewSize` overwriting `targetPos` mid-morph
- Max All pipeline: 5-step rewrite (pre-compute equalize → reset → layout → expand → frustum reposition → equalize resize)
- Layout constants measured to reality: SIDEBAR=157, TOP_BAR=45, STATUS_BAR=34
- Cursor drift: 100-char measure element (was 10, accumulated 0.024px/char error)

**Part 2: Card Subscription Manager (IMPLEMENTED)**
- CARDS sub-panel in hamburger menu with checkbox subscribe/unsubscribe
- Server-side SQLite persistence (card_subscriptions, card_preferences tables)
- Session discovery filtering — unsubscribed cards never touch browser
- Thumbnail buttons: ▶/⏸ center, ⏹ lower-right, ✕ upper-right (admin)
- Orange badge + status bar counts, both click to open CARDS panel
- Search by title, sort by state/name/owner/age
- Save Current State button, admin batch terminate with PIN
- Fixed: cp- prefix mismatch (s.id || s.name consistently)

**Part 3: Compose Mode (IMPLEMENTED)**
- Ctrl+Space toggles Terminal Mode ↔ Compose Mode
- Frosted glass bar with opaque rounded textarea, slides up from bottom
- Enter: send+CR, Shift+Enter: send no CR, Ctrl+Enter: bare CR
- Ctrl+Arrow/Y/N/C passthrough to terminal
- Shift+Up/Down: entry history (localStorage, max 100)
- Layout-aware: cards reposition above compose bar
- Draft persists across reload via localStorage
- Fixed: Ctrl+Space stray character (second keydown handler was sending ctrl+space to terminal)

**Part 4: UI Polish**
- Brushed steel title bars (dark titanium inactive, gold when active, dark text)
- Card retreat fade animation with _retreating flag protection
- Minimal mode respects manual setting on unfocus
- Sidebar frosted glass, thumbnail cursor blink pause on muted
- Unified [Aa | size | Unify] control
- Single card Max All/Fit All/layout support
- Bottom bar always visible, sidebar bottom padding for scroll clearance

**Artifacts:**
- docs/research/2026-04-06-v0.1-focus-positioning-bug-journal.md
- docs/research/2026-04-06-v0.1-max-all-layout-fix-journal.md (+NOTES, v0.2)
- docs/superpowers/plans/2026-04-06-v0.1-max-all-pipeline-fix.md
- docs/superpowers/specs/2026-04-06-v0.2-card-subscription-manager-design.md
- docs/superpowers/plans/2026-04-06-v0.1-card-subscription-manager.md
- docs/superpowers/specs/2026-04-07-compose-mode-design.md
- test-card-subscriptions.mjs, test-card-subscription-e2e.mjs
- test-maxall-layout.mjs, test-maxall-fit.mjs

### Session 2026-04-06 — UI Bug Fixes + Max All Rewrite + Card Subscription Design

**Part 1: Focus Positioning Bug (FIXED)**
- Root cause: `updateCardForNewSize` lines 4216-4217 overwrote `targetPos` with mid-morph `currentPos` during card resize
- Race condition: SVG measurement correction (`_needsMeasuredCorrection`) or perf tier resize firing during 1.5s morph window
- Fix: apply anchor shift delta to `targetPos` independently, not replace it with `currentPos`
- Confirmed with diagnostic logging: `morphFrom` at ring position, `targetPos` at (0,0,0), resize fires mid-morph

**Part 2: Max All Pipeline Rewrite (FIXED)**
- Previous implementation: single-step `maximizeCardToSlot` sending terminal resize, card sized from `_fillSlot` flag in `updateCardForNewSize`. Broken — wrong expansion ratios, compounding across layout switches.
- New pipeline (5 steps): pre-compute equalize targets → reset cards to natural size for target dims → layout → expand card DOM (aspect match slot) → direct frustum repositioning → send equalize resize
- Key fixes:
  - Card DOM aspect matched to slot aspect (not terminal content aspect)
  - Direct frustum Z-depth positioning (bypasses layout's terminal-aspect letterbox)
  - Pre-compute equalize cols/rows so step 0 reset uses correct terminal dims (eliminates need to press Max All twice)
  - `Math.ceil` for cols, rows derived from slot aspect ratio (eliminates letterbox gaps)
  - HEADER_H subtracted from content area for equalize calculation
  - `_suppressRelayout` on all resize paths to prevent re-layout from undoing positioning
- Removed: `maximizeCardToSlot()`, `_fillSlot` mechanism
- Layout options now always visible in top bar

**Part 3: Card Subscription Manager (DESIGNED)**
- Brainstormed + spec'd persistent card subscription system
- CARDS sub-panel in hamburger menu with search/sort, session list grouped by state
- Two-layer pause: thumbnail ⏸ (temporary) vs CARDS menu pause (sticky, persists)
- Thumbnail buttons: ▶/⏸ (bottom-center, state toggle), ⏹ (upper-left, unsubscribe), ✕ (upper-right, admin terminate)
- Orange badge "YOU HAVE N HIDDEN CARDS" + status bar counts — click opens CARDS panel directly
- "Save Current State" button snapshots dashboard state to profile
- Server-side SQLite tables: `card_subscriptions`, `card_preferences`
- Admin batch terminate with PIN confirmation
- Implementation plan: 7 tasks, subagent-driven execution

**Artifacts:**
- docs/research/2026-04-06-v0.1-focus-positioning-bug-journal.md
- docs/research/2026-04-06-v0.1-max-all-layout-fix-journal.md (+ NOTES, v0.2)
- docs/superpowers/plans/2026-04-06-v0.1-max-all-pipeline-fix.md
- docs/superpowers/specs/2026-04-06-card-subscription-manager-design.md (+ NOTES, v0.2)
- docs/superpowers/plans/2026-04-06-v0.1-card-subscription-manager.md
- test-maxall-layout.mjs, test-maxall-fit.mjs (Puppeteer test scripts)

### Session 2026-04-05 (late) — Path B Removal, Auth Fixes, Pipeline Research

**Part 1: Path B (Direct Tmux) Removal**
- Removed ALL direct tmux code from svg-terminal (361 lines, 2450→2089)
- tmuxAsync, capturePane, capturePaneAt, diffState, getOrCreateWatcher, subscribeToSession, triggerCapture, scroll offsets, resize locks, execFile/parseLine imports — all deleted
- All WS handlers simplified to cp-only: subscribe, create-session, get-screen, get-sessions, input/resize/scroll
- sendSessionDiscovery rewritten — single source from cpRequest('listSessions')
- **Result:** Fast repeat keys in terminal — chunky input was caused by execFile child process spawning

**Part 2: Bug Fixes**
- +/- and all header buttons stealing focus: `btn.blur()` in mkHdrBtn factory
- Top-bar Fit All / Max All same issue: blur after click
- Version hash expanded to include server.mjs and index.html (not just dashboard.mjs)
- Fire-and-forget on cp input: don't await cpRequest('input'), screen updates arrive via TerminalMirror
- Upgrade handler bug: bridgeClaudeProxySession "upgrade watcher" path dropped session-end and session-settings-changed events — cards for ended sessions stayed visible

**Part 3: Auth Fixes (claude-proxy)**
- Root couldn't see sessions owned by other users (cp-frodex's TMUX-cleanup invisible to root)
- Root cause: listSessionsForUser had no admin bypass, root not in cp-users group
- Fix: admin bypass (root + cp-admins see all) + cp-users gate (non-members see nothing except own)
- Applied to both listSessionsForUser and canUserAccessSession

**Part 4: Pipeline Research**
- Verified complete data flow: PTY → TerminalMirror (30ms poll) → Unix socket → cpOnDataChunk → WS → browser
- All claims from v0.1 journal verified against code, corrected, and documented in v0.2
- Identified improvements: event-driven TerminalMirror, focus-aware polling, backpressure handling
- Found gap: dashboard has no handler for session-settings messages (permission changes invisible to browser)

**Part 5: Design Work (in progress)**
- Session settings dashboard handler: viewOnly air-gapped router, card title bar authorization badges, access revocation UX
- Hierarchical group permissions: identified need for cp-root group, per-group owner/admin — deferred to future brainstorm

**Artifacts:**
- docs/research/2026-04-05-v0.1-path-b-removal-journal.md
- docs/research/2026-04-05-v0.1-ws-only-first-principles-review-journal.md
- docs/research/2026-04-05-v0.2-message-pipeline-architecture-journal.md
- docs/superpowers/plans/2026-04-05-v0.1-path-b-removal.md
- docs/superpowers/plans/2026-04-05-v0.1-admin-bypass-listSessions.md
- docs/superpowers/plans/2026-04-05-v0.2-admin-bypass-listSessions.md

### Session 2026-04-05 — OAuth, Security Hardening, Session Authorization, Admin Panel

**Part 1: OAuth Provider Setup**
- Google, Microsoft, GitHub OAuth configured and live at https://3200.droidware.ai
- Fixed callback URL (was hardcoded localhost), Google OIDC iss parameter, pending page check status
- Created setup guide (docs/oauth-provider-setup-v0.1 through v0.3)

**Part 2: Admin Panel**
- Full user lifecycle: approve/deny/deactivate/reactivate/purge
- Editable cp- usernames on approval with [check existing] and [auto-generate]
- Multi-provider OAuth linking, merge accounts, flag toggles
- Admin PIN with 15-min sudo window for privileged actions
- Force re-login (revokes API keys, sends reauth-required WS message)
- Info tooltips and section descriptions on all admin sections

**Part 3: Security Hardening (from audit CSV)**
- 17 findings addressed: CSRF, CSP, SSRF protection, 1MB body limit, auth on admin/SSE/WS, reserved usernames, DB permissions, bounded OAuth state map, dev mode hardening (AUTH_MODE=dev + DEV_PASSWORD required)

**Part 4: Session Authorization (Phase 1)**
- STRICT_SESSION_AUTHZ feature flag with is_superadmin role
- authorizeSession() with permission cache from claude-proxy listSessions
- handleInput/POST /api/input removed (tmux bypass)
- /ws/terminal removed (410 Gone)
- /auth/status info leak fixed (single-use check tokens)
- /api/proxy admin-only, admin-client.mjs behind auth gate
- CP_DEFAULT_USER identity passthrough fixes on all paths

**Part 5: Session Authorization (Phase 2)**
- API Key Store: 30min idle, 24h absolute, max 10/user, one WS per key
- Cookie fallback removed from WS upgrade — API key is sole WS credential
- WS consolidation: session create/restart/fork/layout moved to WS messages
- Reconnection overlay: frosted glass, countdown, login link
- Rate limiting: 6 tiers by endpoint type
- Dev mode login page
- Client version check with update banner

**Part 6: Claude-proxy Fixes**
- viewOnly enforcement on socket RPC (sendInput rejects non-owner/admin)
- viewOnlyAllowScroll/viewOnlyAllowResize metadata fields
- Access metadata exposed in listSessions response
- listSessionsForUser bug: checked 'cp-users' but getGroups strips prefix — fixed to 'users'

**Part 7: Implementation Plan Standards**
- Wrote /srv/PHAT-TOAD-with-Trails/implementation-planner/implementation-plan-standards.md
- 7 rules: agent interchangeability, current state verification, no unverified claims, test completeness, phasing/rollback, schema contracts, single review round
- Applied retroactively — plan went through 5 review rounds; standards would have reduced to 1

**Part 8: Misc**
- Cache-busted dashboard.mjs?v=hash in index.html
- API key required on HTTP session data endpoints
- Animated SVG favicon with pulsing cursor (data URI, no HTTP)
- User provisioning: 5 users (frodex310 superadmin, cp-aaronb, cp-aaronh, cp-joshm, cp-gregt, cp-frodex)

**Key bug found:** claude-proxy listSessionsForUser checked groups.includes('cp-users') but getGroups() strips the cp- prefix, returning 'users'. Non-owner users on public sessions were invisible. One character fix.

**Artifacts:**
- docs/oauth-provider-setup-v0.1 through v0.3.md
- docs/admin-panel-v0.1, v0.2.md
- docs/research/2026-04-05-v0.1-oauth-admin-security-journal.md
- docs/research/2026-04-05-v0.1-session-authorization-journal.md (+ NOTES, ORIGINAL)
- docs/superpowers/plans/2026-04-05-v0.1 through v0.5-session-auth-and-ws-consolidation.md (+ NOTES, REVIEWED variants)
- docs/superpowers/specs/implementation-plan-standards.md
- /srv/security-scan/updates/2026-04-05-svg-terminal-security-fixes.md, phase2-security-fixes.md
- api-key-store.mjs, rate-limiter.mjs, test-api-key-store.mjs, test-rate-limiter.mjs, test-feature-flag.mjs, test-session-authz.mjs
- favicon.svg, favicon-nocursor.svg

### Session 2026-04-05 (earlier) — OAuth Implementation + Admin Panel + Security Hardening

**Part 1: OAuth Provider Setup**
- Set up Google OAuth (consent screen, credentials, scopes)
- Set up Microsoft OAuth (Azure AD app registration)
- GitHub OAuth app registered
- Fixed callback URL: was hardcoded `http://localhost:3200`, now uses `PUBLIC_URL` env var
- Fixed Google OIDC `iss` parameter: server was dropping it from callback query, causing `OAUTH_INVALID_RESPONSE`
- Fixed pending page "Check Status": added `/auth/status` endpoint that works without session cookie
- Created `docs/oauth-provider-setup-v0.1.md` (provider setup) and `docs/oauth-provider-setup-v0.2.md` (full lifecycle)
- Environment vars added to systemd service file

**Part 2: Admin Panel Build**
- Wired admin link into hamburger menu (visible to admins only)
- Added editable username field to pending approval with `cp-` prefix enforcement
- Added `[check existing]` lookup and `[auto-generate]` reset buttons
- Multi-provider support: users can link Google + Microsoft + GitHub to one account
- Merge flow: when approving a pending user with an existing user's username, offers to merge accounts
- Built 5 admin features: edit flags (toggle buttons), deactivate, edit linux username, merge users, add user manually
- Deactivated Users section with Reactivate and Purge

**Part 3: User Lifecycle (3-phase)**
- Deactivate: removes provider links, renames `cp-*` → `cpx-*`, moves home dir, sets nologin shell
- Reactivate: restores `cpx-*` → `cp-*`, sets pending status, user must re-authenticate
- Purge: double-confirm, deletes `cpx-*` account + home dir + DB records permanently
- Migrated existing users to `cp-` prefix: aaronb→cp-aaronb, aaronh→cp-aaronh, joshm→cp-joshm
- Assigned root Linux account to frodex310@gmail.com (admin)

**Part 4: Security Hardening (audit-driven)**
- Applied fixes for security audit findings (`/srv/security-scan/security-audit-findings-2026-04-03.csv`)
- HIGH: Removed hardcoded AUTH_SECRET fallback, restricted CORS to PUBLIC_URL, SSRF protection on /api/proxy (blocks private IPs), 1MB request body limit, auth on admin/reload/clients/throttle endpoints, WebSocket auth on upgrade, SSE auth, reserved username blocking
- MEDIUM: CSRF double-submit cookie pattern, GitHub verified-email-only, sanitized error messages, DB file permissions 0600, bounded OAuth state map (1000 max), CSP headers on all HTML, WebSocket origin validation
- Created `docs/admin-panel-v0.1.md` (complete admin panel reference)

**Users provisioned:**
- frodex310@gmail.com → root (admin)
- aaronmbraskin@gmail.com → cp-aaronb
- aaron.hopkins@gmail.com → cp-aaronh (admin)
- joshua.montgomery@guardwellfarm.com → cp-joshm (admin)
- microsoft.net@frodex.com → cp-gregt (test account)

**Artifacts:**
- docs/oauth-provider-setup-v0.1.md, docs/oauth-provider-setup-v0.2.md
- docs/admin-panel-v0.1.md

### Session 2026-04-04 — claude-forker v0.8 plan finalized; implementation delegated

- Iterated source-verified fix plan v0.3 → v0.8 against Claude Code snapshot at `/srv/src` (`sessionStoragePortable.ts` `sanitizePath` / `findProjectDir`, `hash.ts` `djb2Hash`, `getWorktreePathsPortable.ts`).
- Resolved earlier review issues: `_djb2_hash` must match `simpleHash` (initial 0, `(h<<5)-h+c`, signed 32-bit, abs, base-36); prefix match uses `sanitized[:200] + '-'`; `find_project_dir` is **target** resolution only — `find_session` full-scans all project dirs plus worktree fallback (Fix 7).
- **Canonical implementation spec:** `claude-forker/docs/2026-04-04-v0.8-source-verified-fix-plan.md` (approved). v0.8 clarifies Fix 8.2 HOW IT WORKS (source discovery vs target encoding/prefix fallback).
- User requested another agent implement the code; this session updated `sessions.md` + research journal only.

**Artifacts:**
- `claude-forker/docs/2026-04-04-v0.8-source-verified-fix-plan.md`
- `docs/research/2026-04-04-v0.1-claude-forker-v0.8-plan-handoff-journal.md`

### Session c2a34800 / 2026-04-04 — Performance Tier Iteration + Repo Cleanup + Top Menu Bar Plan

**Part 1: ZFS Recovery + Performance Tier Re-implementation**
- Inspected ZFS snapshots to find "lost" uncommitted perf detection code from previous agent
- Determined previous agent's work was overwritten by a `git checkout -- dashboard.mjs` during server bridge ordering
- Re-implemented perf tier system from first principles, iterating on mobile behavior with user testing
- Key architectural difference from original agent: compositor-safe resize (hide cards before setSize), 8-frame rAF test with cascading degradation, re-up capability on improved conditions
- Fixed: thumbnail data populated from WebSocket (not SVG load), input bar visibility on re-select, resizeRenderer() helper, RENDER_SCALE_DEFAULT pattern

**Part 2: claude-proxy Reconnection**
- Verified cpResubscribeAll + cpPushFullScreensAfterCpResubscribe + bridge ordering survive proxy restart
- Shutdown test (5s down, restart): all cards recovered, thumbnails loaded, no diff-only frames

**Part 3: Repo Cleanup**
- Merged all feature branches into main for both svg-terminal and claude-proxy
- Deleted stale local and remote branches
- Committed untracked files (sessions.md, PRD, research docs)
- Deleted backup files that duplicated tracked versions
- Established single line of truth on main

**Part 4: Top Menu Bar**
- Designed top menu bar feature: hamburger, layout selector + ghost preview, group mutations, user identity
- Wrote plan doc: docs/superpowers/plans/2026-04-04-top-menu-bar.md
- Created interactive mockup: ui-web/top-menu-bar-mockup.html (served at /mockup)

**Part 5: Documentation Reconciliation**
- Reviewed original agent's assessment of divergences between their proposal and current implementation
- Updated sessions.md with perf tier key technical decisions
- Created journal v0.2 correcting stale v0.1 statements
- Fixed test-performance-mode.mjs Test 3 to match actual tier2CardShouldShow behavior

**Artifacts:**
- docs/superpowers/plans/2026-04-04-top-menu-bar.md
- ui-web/top-menu-bar-mockup.html
- docs/research/2026-04-03-v0.2-mobile-css3d-perf-tiers-journal.md

### Session 206fe1ef / 2026-04-01–2026-04-03 — Layout System Design + Card Sizing Fix + UI Improvements

**Part 1: Layout System Design**
- Designed composable layout system: slot maps + independent mutation operations
- 8 standard layouts cataloged, POV-FONT-SIZE metric designed
- 3 mutation levers confirmed: Z-depth (free), card resize (per-browser), terminal resize (global)
- "Font-size mutation" explored and rejected — not a real lever
- Mutation cost hierarchy, co-browser politeness, VT100 minimum, 16:9–9:16 aspect constraints
- Design docs: specs/2026-04-01-layout-system-design (v1→v4 + user NOTES-01A)

**Part 2: Card Sizing Root Cause + Fix**
- Discovered: card DOM sized with hardcoded 8.65/17, SVG viewBox with runtime-measured ~8.61/~17.0
- SVG letterboxes inside card due to aspect mismatch (preserveAspectRatio default)
- Fixed: calcCardSize accepts measured values, getMeasuredCellSize reads from SVG, all paths prefer measured
- Checkerboard alignment tests validated fix across 6 terminal sizes × 6 mutations
- PRD amendment 004 (v1→v3) documents full investigation
- Committed: aa78fd6

**Part 3: UI Improvements**
- Directional alt+drag resize (edge/corner detection, anchored opposite side, dynamic scale factor)
- +/− preserves aspect ratio (_origColRowRatio), suppresses re-layout, pins click point
- Fit-to-card (⊡) fix: restored fitScale approach, added _lockCardSize
- Masonry scoring: actual card area instead of bounding box coverage (fixes 3-in-a-row for 4 cards)
- Thumbnail cursors: positioned at _lastCursor.x/y with blink, hidden when scrolled
- Escape sends to terminal when active input; deselect returns to group grid
- Shift+Tab zooms to active card first

**Part 4: Planning**
- Performance detection plan (9 tasks): GPU detection, frame timing, 3 tiers, status indicator
- PRD amendment 005: user identity flow svg-terminal → claude-proxy for title updates
- Hover-to-activate resize handles designed (not yet implemented)

**Artifacts:**
- docs/superpowers/specs/2026-04-01-layout-system-design*.md (5 versions)
- docs/PRD-amendment-004*.md (3 versions), PRD-amendment-005.md
- docs/superpowers/plans/2026-04-03-performance-detection.md
- docs/superpowers/specs/2026-04-03-performance-detection-plan.md
- docs/research/2026-04-01-v0.1-layout-system-journal.md, 2026-04-02-v0.2-layout-system-journal.md
- test-selection-alignment.mjs, alignment-tests/ screenshots

### Session 2026-03-31 — Crisis Recovery: Single WebSocket + Shared Capture Architecture

**Context:** Server meltdown on 2026-03-30. 170 TCP connections, 55% CPU, connection cycling from stale clients. Server isolated to port 3201. Previous agent left unverified research proposing xterm/headless (wrong — loses scrollback).

**Part 1: First-Principles Analysis**
- Traced complete data lifecycle: tmux capture-pane → sgr-parser → diffState → WebSocket → terminal.svg SVG rendering
- Identified real problem: per-connection polling duplication (N browsers × M sessions = N×M captures), not polling itself
- Audited legacy code: mapped new-session-only path vs pre-WebSocket dead code
- Rejected xterm/headless (loses scrollback, proven by claude-proxy commit 7aa1323)
- Rejected tmux -C control mode (adds persistent process, throws away data, calls capture-pane anyway)
- Rejected adaptive backoff (optimizes wrong dimension — captures not interval)
- Benchmarked: 30 concurrent capture-pane = 13ms, 30 screens parsing = 2.6ms. Shared polling handles 30 sessions in 16ms.
- Research trail: journals v0.1 through v0.5

**Part 2: Architecture Decision**
- Single multiplexed WebSocket per browser (`/ws/dashboard`)
- Shared capture per session (SessionWatcher — one poll per session, broadcast to subscribers)
- Per-user session filtering via getAuthUser (cookie from upgrade headers, UGO model)
- SSE throttle for server load management
- Tunable poll interval (default 100ms, env CAPTURE_INTERVAL)
- PRD v0.5.0 written (stepped from v0.4.0)
- Wire format spec: tagged JSON messages, no combining/demuxing

**Part 3: Implementation (8 tasks, subagent-driven)**
- SessionWatcher + DashboardSocket in server.mjs (shared capture, /ws/dashboard endpoint)
- Dashboard single WebSocket (connectDashboardWs, routeDashboardMessage, sendDashboardMessage)
- terminal.svg renderMessage() inbound API
- Claude-proxy session bridging (event-driven relay with session tagging)
- SSE throttle endpoint + dashboard listener
- Deprecation comments on all legacy code paths
- Integration test (23 tests passing)
- Fix: cp-* input routing through upstream bridge (not local tmux)

**Verified live:** User typed through shared WS → claude-proxy bridge → into active session. "I do think this is WAY better."

**CPU note:** 53.5% during transition (both old per-card WS and new shared WS running). Expected to drop significantly when old paths removed.

**Artifacts:**
- PRD-v0.5.0.md (stepped from PRD.md v0.4.0)
- docs/PRD-amendment-001.md, 002.md, 003.md (reasoning trail)
- docs/research/2026-03-31-v0.1 through v0.5-event-driven-terminal-updates-journal.md
- docs/superpowers/plans/2026-03-31-single-websocket-shared-capture.md
- 10 commits on camera-only-test branch

**Still pending:**
- Remove deprecated code when old sessions terminated
- Periodic session re-discovery on shared WS (currently one-shot on connect)
- Extract shared discoverSessions() to deduplicate handleSessions + sendSessionDiscovery
- Move SGR parsing from server to browser (future optimization)

### Session 2026-03-30 — Cross-Browser Resize Sync + Card Association Design + Crash Debugging
**Part 1: Design & Planning**
- Card association system designed (magnetic attachment, group title bars, recursive focus)
  - Spec: docs/superpowers/specs/2026-03-30-card-association-system-design.md
- Cross-browser resize sync: 6-step design chain (design.01 → design.06)
  - SSH resize token flow researched (RFC 4254 §6.7, fire-and-forget at every layer)
  - Focused-card guard history traced through 3 git commits
  - Design: fix single-browser first, multi-browser is free via 30ms poll
  - Spec: docs/superpowers/specs/2026-03-30-cross-browser-resize-sync-design.06.md
  - Plan: docs/superpowers/plans/2026-03-30-cross-browser-resize-sync.md

**Part 2: Implementation**
- Removed Z-slide bump in multi-focus (Task #4, commit 7c0ebfd)
- Removed focused-card guard (commit de32874) — card DOM always updates
- Added re-layout trigger for focused cards on dimension change (commit 5fb33be)
- Server-side resize lock 500ms (TDD, commit 0a2d030, 19/19 tests)
- PRD updated with no-outbound-resize constraint (commit 941e40e)
- All 57 tests passing (19 server + 16 auth + 22 E2E)

**Part 3: Connection Cycling Crash**
- Dashboard cards started cycling "Connection lost" after implementation
- Extended debugging session: message flood analysis, Chrome re-compositing theory, guard revert
- Root cause: version mismatch — 2-3 stale browser clients (running 4-day-old code) against new server
- Moved server to port 3201, isolated from stale clients — immediately stable
- Journal: docs/research/2026-03-30-v0.1-connection-cycling-crash-journal.md

**Part 4: Additional Design Work**
- Card association system: magnetic edge attachment with commitment threshold (magnet icon)
- Follow-along mode: parent/child browser action sync
- Z-plane eclipsing: documented 3 approaches, deferred
- Text aliasing: fractional pixel sizes under CSS3D, needs investigation

**Tasks Created:**
- #6: Card association system (magnetic attachment + groups)
- #7: Cross-browser resize sync (implemented, needs manual verification)
- #8: Follow-along mode
- #9: Text aliasing from fractional sizes
- #10: Z-plane eclipsing
- #18: Server-pushed browser reload for deploys
- #19: Fix /api/pane for claude-proxy sessions

**Still needed:**
- Reconcile guard state (committed: removed, local disk: restored)
- Manual multi-browser verification (Task #15)
- Server-pushed reload feature before sharing URL again
- Fix /api/pane HTTP endpoint for proxy sessions
- Move server back to port 3200 after stale clients cleared
- Branch: camera-only-test, server on port 3201

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

**Part 4: Selection Rework**
- Mouse selection: bounds check (no sidebar trigger), minimum drag distance (1.5 cells), auto-copy on mouseup + flash + 2s fade
- Keyboard selection: Shift+Arrow extends, Shift release = auto-copy + flash + fade (same lifecycle as mouse)
- Added selMode flag (mouse/keyboard/mouse-fading/keyboard-fading) to prevent race conditions
- Journals: v0.1-v0.7 selection bugs, plan v3 + keyboard selection fix plan
- User approved and verified working

**Part 5: Z-slide removal + overlay fix**
- Removed READING_Z_OFFSET Z-slide in multi-focus (gold header sufficient)
- Fixed persistent "Connection lost" overlay: guarded poll showError with useWebSocket check, added hideError to delta handler
- Root cause: poll fires after WS connects, showError overwrites hideError, delta handler never clears it

**Still needed:**
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
