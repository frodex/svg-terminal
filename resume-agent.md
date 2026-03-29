# svg-terminal — Agent Resume Info

## Session
- **Session ID:** 0317c840-f331-4eac-add0-a6f53550c517
- **JSONL Path:** `/root/.claude/projects/-root/0317c840-f331-4eac-add0-a6f53550c517.jsonl`
- **Resume command:** `claude --resume 0317c840-f331-4eac-add0-a6f53550c517`
- **Working directory:** `/root`
- **Branch:** `dev`
- **Date range:** 2026-03-28

## What Was Built

### Phase 1: 3D Dashboard Polish (inherited from prior session)
- Fly-in 3D rotation — cards spawn at random angles, slerp to face-camera during morph
- focusQuatFrom captures quaternion on focus — prevents z-rotation snap
- billboardArrival tracks morph completion — billboard slerp ramps during fly-in
- Previously focused terminal morphs back when new terminal clicked (not instant disappear)
- Camera FOV resets to 50 on focus — prevents blurry zoom state

### Phase 2: Mouse Controls
- Drag: orbit camera around look target
- Shift+drag: dolly X/Y (pan camera + target)
- Ctrl+drag: rotate around world origin (or center of mass of focused terminals)
- Scroll (unfocused): zoom (FOV)
- Shift+scroll: dolly Z (forward/backward)
- syncOrbitFromCamera() derives orbit params from actual camera position — prevents snap on drag start
- Click-vs-drag 5px dead zone so terminal focus still works

### Phase 3: Scene Lighting
- Background: medium gray gradient (#a5a5ae → #c2c2c8)
- Specular: intensity 0.4 on card faces via panel normal dot light direction
- Shadows: floor at Y=-300, radial-gradient ellipse, opacity/blur/scale from height
- Iterative tuning with user over ~8 adjustment rounds

### Phase 4: Multi-Focus Terminals
- Ctrl+click adds terminals to focused set (grid layout: 2=side-by-side, 4=2x2, etc.)
- Yellow neon border shows which terminal receives input (input-active, only when 2+)
- Click between focused terminals to switch input target
- Single focus: 1:1 pixel mapping with DOM resize for crispness
- Multi-focus: calculateFocusedLayout() arranges in grid, camera pulls back to fit
- Esc unfocuses all, regular click replaces multi-focus with single

### Phase 5: Event Routing (the hard part)
- Three competing click paths: onMouseUp (document), onSceneClick (renderer), thumbnail click (sidebar)
- mouseDownOnSidebar flag prevents double-fire on ctrl+click thumbnails
- suppressNextClick flag prevents onSceneClick from re-handling after onMouseUp
- lastAddToFocusTime 200ms timestamp blocks focusTerminal after addToFocus
- ctrlHeld tracked via keydown/keyup (e.ctrlKey unreliable in click events on Windows)
- altHeld tracked for text selection
- DO NOT add per-terminal DOM click handlers — root cause of double-fire bug
- Clicking focused terminal no longer unfocuses (removed empty-space unfocus)
- Only focused terminals checked for click hits when in focus mode

### Phase 6: Help Panel
- Frosted glass panel (backdrop-filter blur) in upper-left corner
- ? button toggles, ? key toggles (only when no terminal focused)
- When terminal focused, ? goes to terminal

### Phase 7: Interactive Terminals (WebSocket)
- WebSocket server endpoint /ws/terminal?session=X&pane=Y (ws package, already in node_modules)
- Server-side 30ms poll with line-by-line diff (diffState), pushes deltas
- Async tmux execution (execFileSync → tmuxAsync Promise wrapper)
- Direct keystroke capture — document-level keydown handler
- Key translation map (SPECIAL_KEY_MAP): browser KeyboardEvent.key → tmux send-keys names
- Per-terminal inputWs WebSocket opened on focus, closed on unfocus
- Paste support via document paste event + fallback execCommand('copy')
- SVG client WebSocket with polling fallback (terminal.svg)
- Expanded special key whitelist: F1-F12, PgUp/PgDn, IC, Space, C-a through C-z
- Input bar replaced with status indicator (green dot + session name)

### Phase 8: Scrollback
- Server-side scroll offset per pane (paneScrollOffsets Map, shared across connections)
- capturePaneAt() uses tmux capture-pane -S/-E for scrollback ranges
- Dashboard sends absolute scrollTo offset via WebSocket
- Acceleration-aware step: deltaY magnitude → step 1/3/6/12 lines
- PgUp/PgDn: 24-line jumps via scrollBy()
- Alt+scroll: Up/Down arrows (command history at prompt)
- Unified scrollBy/scrollReset methods on terminal object
- Any keystroke resets scroll to live view

### Phase 9: Text Selection + Copy/Paste
- Focused terminal: plain drag = select text (blue highlight overlay)
- Unfocused: plain drag = orbit (unchanged)
- Alt+drag orbits when focused (swapped)
- Shift+arrow keyboard selection from cursor position
- Ctrl+C with selection copies to clipboard (via fallback execCommand for HTTP)
- Ctrl+C without selection sends C-c to terminal
- Ctrl+V pastes from clipboard into terminal
- Right-click context menu with paste (contenteditable trick)
- Selection reads actual terminal dimensions from SVG viewBox + font measurement
- SVG aspect ratio correction for highlight positioning
- getSelectedTextFromSvg reads directly from <object> contentDocument

### Phase 10: Cursor Sync Fix
- Atomic tmux capture: display-message and capture-pane in single invocation using ';'
- Eliminates race condition where cursor and content get out of sync

### Phase 11: Code Cleanup
- Removed dead code: focusedSession (singular), isMouseActive, lastMouseMove, osc()
- Removed execFileSync import, dead msg.scroll relative handler
- Moved hot-path allocations out of drag handler (_dragRight, _dragUp, _rotY, _rotX)
- Moved RENDER_SCALE before first use
- Collapsed duplicate FOV zoom branches
- Fixed paneScrollOffsets cleanup on WebSocket disconnect
- Fixed empty catch block in WebSocket message handler
- Removed unused sendInput from terminal.svg

### Integration with claude-proxy
- 9 FOLLOW-UP/RESPONSE documents exchanged via filesystem protocol
- Reviewed and corrected PRD-svg-terminal-as-built.md (v1.0 → v1.1, added 8 major items)
- Architecture agreed: claude-proxy v2.0 = SSH + Web API + 3D dashboard
- Protocol corrections: hex-only spans, separate scroll type, session list format
- Accepted integration leadership (svg-terminal side leads)
- Steward questionnaire completed (honest self-assessment of deference and premature GO)
- Identified 5 landmines: 4x scale resize, font metrics, event routing, input WS pattern, shared scroll

### Design Docs
- docs/superpowers/specs/2026-03-28-interactive-terminals-design.md — WebSocket architecture
- docs/superpowers/plans/2026-03-28-interactive-terminals.md — 5-task implementation plan
- docs/superpowers/plans/2026-03-28-crispness-test-and-3d-ring-fix.md — original 3D layout plan
- docs/research/2026-03-28-v0.4-svg-terminal-viewer-journal.md — 3D controls session
- docs/research/2026-03-28-v0.5-svg-terminal-viewer-journal.md — WebSocket streaming session
- PRD-svg-terminal-as-built.md v1.1 (in claude-proxy integration docs)
- PRD-unified-v2.md review + corrections (FOLLOW-UP-08)
- svg-terminal-FOLLOW-UP-09.md — protocol confirmation, unblocked api-server.ts build

## Key Technical Decisions
- 4x scale trick (1280×992 DOM, CSS3DObject scale 0.25) for text crispness — DO NOT REMOVE
- SVG is the rendering target — no HTML overlays, crossfades, or projection-math hacks
- ws package for WebSocket (already in node_modules via puppeteer — zero new deps)
- Server-side diff (diffState) — server polls tmux, pushes only changed lines
- Atomic tmux capture (display-message ; capture-pane) — prevents cursor sync issues
- Event routing: three click paths with flag discipline (mouseDownOnSidebar, suppressNextClick, lastAddToFocusTime, ctrlHeld)
- No per-terminal DOM click handlers — causes double-fire with ctrl+click
- syncOrbitFromCamera() on every orbit start — prevents camera snap
- focusQuatFrom on every focus — prevents rotation snap
- Smooth scroll attempted, abandoned — 30ms server response fast enough, any CSS transform bounced
- Shared scroll offset per pane across WebSocket connections
- Clicking empty space does NOT unfocus — use Esc (prevents accidental unfocus)

## Key Anti-Patterns (from dashboard.mjs header, notes 1-8)
1. DO NOT remove the 4x scale trick — text will blur
2. DO NOT propose HTML overlays for crispness — SVG is the target
3. DO NOT simplify event routing flags — each prevents a tested bug
4. DO NOT add per-terminal click handlers — breaks ctrl+click
5. Always call syncOrbitFromCamera() when orbit starts
6. focusQuatFrom must capture quaternion on focus
7. Cards must spawn with random rotation for fly-in effect
8. billboardArrival must track morph completion

## Files Changed
- dashboard.mjs — 3D scene, controls, focus, selection, keystroke capture (~1600 lines)
- dashboard.css — styles, 4x scale, specular, shadows, help panel, selection
- server.mjs — HTTP + WebSocket server, async tmux, diff, scroll, atomic capture
- terminal.svg — WebSocket client, polling fallback, selection layer
- index.html — help panel, input status bar
- test-server.mjs — 16 tests (HTTP + WebSocket)
- package.json — v0.3.0
- 5 journal/research docs, 3 specs/plans, bibliography

## Pending Tasks
- #16: Use composed titles from claude-proxy API
- #17: Terminal resize from browser (PTY resize + drag handles + Ctrl+Plus/Minus)
- #18: Ctrl+B hotkeys (needs claude-proxy integration)
- #19: User auth + per-user preferences
- #20: Terminal key encoding presets (top 20 encodings)
- #21: Multi-language / internationalization
- #22: Session owner/group permissions in browser UI

## What's Next
- **Terminal resize — BROKEN, needs fresh agent.** See docs/handoff-resize-fix.md for full details. KEYBINDINGS config added, font zoom/optimize/alt-drag implemented but coordinate system bugs make it non-functional. The applyFontScale and optimizeTerminalFit functions need rewriting.
- claude-proxy v2 integration Phase B (adapt client to new API endpoints)
- claude-proxy v2 integration Phase C (merge, QC, code style unification)
- Clean up dashboard.mjs — consolidate keydown listeners
