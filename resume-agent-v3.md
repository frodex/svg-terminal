# svg-terminal — Agent Retirement Document v3

**Session ID:** e3af93f5-13f3-470c-a5ba-94823a102b75
**JSONL Path:** `/root/.claude/projects/-root/e3af93f5-13f3-470c-a5ba-94823a102b75.jsonl`
**Resume command:** `claude --resume e3af93f5-13f3-470c-a5ba-94823a102b75`
**Working directory:** `/root` (project at `/srv/svg-terminal`)
**Branch:** `dev`
**Date range:** 2026-03-28 → 2026-03-29
**Status:** Active — frustum layout working, persistence and scene system designed not yet implemented

---

## What I Know That Isn't Written Down

1. The `pkill -f "node.*server.mjs"` followed by `node server.mjs &` consistently fails because the bash tool resets working directory to `/root`. You must run `node server.mjs &` as a separate command — it picks up the cwd from the shell snapshot which is `/srv/svg-terminal`. Exit code 144 from pkill is expected (SIGTERM caught).

2. The user accesses the dashboard via `http://droidware.ai:3200/` from Windows 11. This is HTTP not HTTPS, which means `navigator.clipboard.writeText()` fails silently. The `fallbackCopy()` using `document.execCommand('copy')` with a hidden textarea is the working clipboard path.

3. The user tests in both Chrome and Edge. They render differently. Any CSS that looks right in puppeteer (headless Chrome) might look wrong in Edge.

4. The `cp-*` tmux sessions are managed by claude-proxy and will NOT accept `tmux resize-window` because they have attached SSH clients constraining the size. Only standalone tmux sessions like `resize-test`, `resize-test2`, and `font-test` can be resized. CRITICAL for testing resize features.

5. The user's PuTTY sessions set the terminal size. When the browser resizes a terminal, the PuTTY user sees it too. This is intentional but surprising.

6. Never kill or create tmux sessions without asking. The user has active work running. Only the svg-terminal server process can be restarted.

7. The user's mental model of "font size" is "how many cols/rows fit the card" — not pixels or CSS transforms. ALL visual size changes are tmux resize. Font size is a derived concept: `fontSize = cardWidth / cols`.

8. The `measure` element in terminal.svg reports `bbox.width / 10 ≈ 8.65` for cell width and `bbox.height ≈ 17` for cell height. These are actual SVG font dimensions. If the font changes, `SVG_CELL_W` and `SVG_CELL_H` constants in dashboard.mjs break.

9. The brainstorm visual companion server times out after 30 minutes. Restart with `bash /root/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.6/skills/brainstorming/scripts/start-server.sh --project-dir /srv/svg-terminal --host 0.0.0.0 --url-host 192.168.22.56`. Session data persists in `.superpowers/brainstorm/`.

10. The CSS3DRenderer places real DOM elements in 3D space. Clicks hit the DOM element directly, not the renderer canvas. `onSceneClick` receives bubbled events. `pointer-events: none` on `<object>` elements is load-bearing — without it the SVG captures clicks.

---

## Constraints (Discovered, Load-Bearing)

### Hard Constraints

| What | Why | Consequence if violated |
|------|-----|----------------------|
| 4x scale trick (variable DOM size, CSS3DObject scale 0.25) | Chrome rasterizes DOM before 3D transform. 4x forces high-res raster. | Text blurs in 3D dashboard. |
| SVG is the rendering target | User rejected HTML overlay/crossfade approaches. SVG chosen for cross-browser universality. | Edge/Chrome render HTML overlays differently. |
| No per-terminal DOM click handlers | Causes double-fire with ctrl+click multi-focus. | Multi-focus breaks. |
| Event routing flags must not be simplified | `mouseDownOnSidebar`, `suppressNextClick`, `lastAddToFocusTime`, `ctrlHeld`, `altHeld` — each prevents a tested bug. | Various click/focus bugs return. |
| `syncOrbitFromCamera()` on orbit start | Without it, orbit params contain stale values. | Camera snaps violently. |
| `focusQuatFrom` captured on focus | Without it, card snaps flat instead of slerping. | Z-rotation snap. |
| Atomic tmux capture (`;` separator) | Separate calls create race — cursor doesn't match content. | Cursor offset from input. |
| `tmux resize-window` not `resize-pane` | `resize-pane` only works within window constraints. | Resize silently fails. |
| No CSS font scaling for resize | User explicitly corrected: ALL size changes come from tmux cols/rows. | Coordinate confusion, death spiral. |
| `baseCardW/baseCardH` must always be current | These are restore anchors for focus/unfocus. | Cards mutate on every focus cycle. |
| No CSS default width/height on `.terminal-3d` | Variable card sizes conflict with CSS defaults. | Cards snap to wrong size. |
| Frustum layout: no camera offset | Camera at origin. Cards in screen pixels projected to world. Sidebar is overlay. | Every offset combination was wrong. |
| `suppressNextClick` only on scene ctrl+click | Sidebar ctrl+click was setting it, eating next click. | First click after multi-select fails. |
| `dragDistance` reset on every mousedown | Previous drag's distance persists otherwise. | Can't click after any drag. |
| Ring Z offset must ease, not snap | Instant ring position change causes pop. | Jarring animation. |

### Performance Contracts

| What | Value | Why |
|------|-------|-----|
| Server poll interval | 30ms | Fast enough for interactive use. |
| Post-keystroke re-capture delay | 5ms | tmux needs time to process. |
| Scroll step acceleration | 1/3/6/12 lines based on deltaY | Feels responsive. |
| MORPH_DURATION | 1.5s | Fly-in animation length. |
| BILLBOARD_SLERP | 0.08 | Lazy face-camera drift. |
| Ring Z ease rate | 0.05 per frame | Smooth ring push/pull on focus/unfocus. |
| refreshSessions poll | 5000ms | Reactive card sizing for unfocused terminals. |

---

## Anti-Patterns (Tried and Failed)

| What was tried | What happened | What to do instead |
|---------------|--------------|-------------------|
| CSS `transform: scale()` on `<object>` for font zoom | Width/height adjustment counteracted scale. Multiple iterations all failed. | Change tmux cols/rows. No CSS transforms. |
| Camera offset to account for sidebar | Every sign combination wrong. Feedback loop with card positioning. | No offset. Camera at origin. Sidebar is overlay. Everything in one frustum. |
| Cards at fixed Z depth with camera pullback | Ring passes through focused cards. Camera pullback makes cards too small. | Frustum projection: each card at own Z. Ring pushed behind via `ringZOffset`. |
| Hardcoded 1280×992 for all terminals | Letterboxing. Focus/unfocus mutates size. Aspect mismatch. | `calcCardSize(cols, rows)` from tmux. `TARGET_WORLD_AREA` for uniform visual weight. |
| `HEADER_H = 56` | Actual header 72px (56 content + 16 padding, content-box). Aspect mismatch. | `HEADER_H = 72`. |
| `SVG_CELL_W = 8.4` | Actual is 8.65. Card/SVG aspect mismatch. | Measured value 8.65 or read from SVG. |
| Smooth scroll with CSS `translateY` animation | Transform and content update overlap in timing, causes bounce. | Don't animate. 30ms server response is fast enough. |
| `tmux copy-mode` for scrollback | Entering copy-mode scrolls PuTTY but `capture-pane` still returns base buffer. | Use `capture-pane -S/-E` directly. Server-side offset. |
| HTML overlay crossfade for crispness | Different rendering Chrome vs Edge. Fragile browser-specific behavior. | SVG is the target. Nx scaling. |
| Buttons inside CSS3DObject DOM | `getBoundingClientRect()` returns NaN under `matrix3d`. Can't click. | Fixed HTML overlay, position in animate loop. |

---

## Break Tests (Fragile Components)

| Mutation | What breaks | How to detect |
|----------|------------|--------------|
| Remove `syncOrbitFromCamera()` in orbit mousedown | Camera snaps to stale position | Visual: click terminal then right-drag — camera jumps |
| Remove `focusQuatFrom = quaternion.clone()` | Card snaps flat before fly-in | Visual: card rotates to 0° then flies in |
| Change `css3dObj.scale.setScalar(0.25)` to `1.0` | Text blurs in 3D | Visual: fuzzy text |
| Add `el.addEventListener('click', ...)` to terminal DOM | Ctrl+click adds 2 terminals | Click count: should add exactly 1 |
| Remove `mouseDownOnSidebar` flag | Ctrl+click thumbnail also fires handleCtrlClick | Terminal count: adds 2 instead of 1 |
| Remove `suppressNextClick` flag | `onSceneClick` fires after `onMouseUp` ctrl+click | Focus count drops to 1 |
| Remove `lastAddToFocusTime` guard | `focusTerminal()` fires after `addToFocus()` | Focus count drops to 1 |
| Remove `dragDistance = 0` from `onMouseDown` | Clicks after drags are ignored | Can't click on anything after dragging |
| Clear `dom.style.width/height` to empty string | Card disappears (no CSS fallback) | Visual: card gone |
| Use `tmux resize-pane` instead of `resize-window` | Resize silently fails | Terminal dimensions unchanged |
| Remove ring Z offset easing | Ring pops on focus/unfocus | Visual: jarring snap |
| Remove `baseCardW/baseCardH` update in `updateCardForNewSize` | Unfocus restores to pre-resize size | Card shrinks after alt+scroll resize |

---

## Interfaces

### WebSocket Protocol: `/ws/terminal?session=X&pane=Y`

**Type:** Bidirectional WebSocket
**Server → Client:**
```json
{ "type": "screen", "width": 120, "height": 40, "cursor": {"x": 5, "y": 12}, "title": "...", "lines": [...], "scrollOffset": 0 }
{ "type": "delta", "cursor": {...}, "title": "...", "changed": {"3": [...spans], "12": [...spans]}, "scrollOffset": 0 }
{ "type": "error", "message": "..." }
```

**Client → Server:**
```json
{ "type": "input", "keys": "hello" }
{ "type": "input", "specialKey": "Enter" }
{ "type": "input", "scrollTo": 42 }
{ "type": "resize", "cols": 100, "rows": 30 }
```

### HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions` | List tmux sessions with cols/rows |
| GET | `/api/pane?session=X&pane=Y` | Capture pane |
| POST | `/api/input` | Send keystrokes |

### `/api/sessions` Response Format
```json
[
  { "name": "resize-test", "windows": 1, "cols": 80, "rows": 24 },
  { "name": "cp-greg_session_001", "windows": 1, "cols": 120, "rows": 40 }
]
```

---

## Test Invariants

**Test runner:** `node --test` (Node.js built-in)
**Test count:** 17
**Run:** `cd /srv/svg-terminal && node --test test-server.mjs`

**What's covered:**
- HTTP API routes (sessions, pane capture, input)
- CORS headers
- Parameter validation
- WebSocket connect + receive screen
- WebSocket input → receive delta
- WebSocket resize message processed

**What's NOT covered:**
- Client-side dashboard behavior (no DOM tests)
- Text selection / copy-paste
- 3D scene rendering
- Multi-focus / event routing
- Frustum layout
- These are tested via puppeteer scripts (`test-*.mjs`)

---

## What I Was About To Do Next (and Why)

### Immediate: Title bar drag refinement
The drag detection works but may not feel natural. User reported needing ctrl which shouldn't be required. The header click zone is thin — may need a larger hit area.

### Next: The dots (red/yellow/green)
Currently decorative. User wants them functional or removed. Candidates: red=remove from focus, yellow=minimize to ring, green=optimize fit.

### Then: localStorage persistence (Phase 2 of design spec)
Save per-terminal fontSize, cardW, cardH, mutated flag. Restore on reload. Global default fontSize. This is the foundation for pinning, groups, and scenes.

### Then: Size morphing on startup (big bang)
Cards start at origin, small. Fly out and grow to saved sizes. Position AND size interpolate over MORPH_DURATION.

### Pending tasks (by priority):
1. Title bar drag refinement
2. Functional dots
3. localStorage persistence
4. Size morphing (big bang startup)
5. Layout mode switching (masonry/treemap/grid)
6. Pinning (world position persistence)
7. Groups (rigid body collections)
8. Named scenes (camera snapshots)
9. Camera-locked terminals (HUD)
10. claude-proxy v2 integration Phase B+C

---

## What Surprised Me About Current State

1. **Frustum projection solved multiple problems at once** — crispness, layout, and Z-ordering all improved from one architectural change. Each card at its own optimal depth gets the best Chrome rasterization.

2. **"Everything is a card in one frustum" was the user's insight that unblocked the layout.** I spent multiple iterations fighting camera offset math. Dropping it and treating the sidebar as an overlay (not a subtracted region) made the code simpler AND correct.

3. **Cell-count proportional sizing is the right metric for multi-focus.** Not card area, not terminal aspect, not height. The terminal with the most content (smallest text relative to area) should get the most screen space.

4. **The ring's Z range is huge** (~-500 to +500 due to 73° tilt). Any focused card at Z≈0 gets ring cards passing through it. The ease-behind solution (push ring Z back 800 units during focus) works but kills the ambient 3D effect. Future: modify ring path to arc behind focused cards instead of straight push.

5. **Event routing remains the hardest part.** Every mouse feature I added broke something in the click/drag/ctrl+click system. The `dragDistance` reset on mousedown was the subtlest bug — stale distance from a previous drag making `wasDrag()` lie.

---

## Council Protocol

Active council at `council/issue_01/`. Communication via markdown files:
- `request_01.md` through `request_04.md` — from advisor agent (session 0317c840, retired)
- `request_NN-RESPONSE-NN.md` — my responses
- `card-sizing-design.md` — first-principles card sizing design
- Advisor session is retired but the trail is complete and instructive

The PHAT TOAD steward protocol was read and internalized from `/srv/PHAT-TOAD-with-Trails/steward/`. Key behaviors:
- "No concerns" is a red flag — walk through fragile component survival
- Constraints before architecture
- After 2 failed fixes for same issue, stop and question the architecture
- Use subagents (haiku) for non-reasoning tasks
