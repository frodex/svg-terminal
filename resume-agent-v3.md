# svg-terminal — Agent Retirement Document v3

**Session ID:** e3af93f5-13f3-470c-a5ba-94823a102b75
**JSONL Path:** `/root/.claude/projects/-root/e3af93f5-13f3-470c-a5ba-94823a102b75.jsonl`
**Resume command:** `claude --resume e3af93f5-13f3-470c-a5ba-94823a102b75`
**Working directory:** `/root` (project at `/srv/svg-terminal`)
**Branch:** `camera-only-test` (ahead of `dev`, needs merge after validation)
**Date range:** 2026-03-28 → 2026-03-29
**Status:** Retired — camera-only architecture working, selection overlay fix needed

---

## What I Know That Isn't Written Down

1. `pkill -f "node.*server.mjs"` exits 144 (expected). Use `bash /srv/svg-terminal/restart-server.sh` for clean kill+restart in one approved command.

2. User accesses via `http://droidware.ai:3200/` from Windows 11, Chrome, 100% scaling. HTTP not HTTPS — clipboard uses `execCommand('copy')` fallback.

3. `cp-*` tmux sessions won't accept `tmux resize-window` — managed by claude-proxy with attached SSH clients.

4. Never kill tmux sessions without asking. Only restart the Node.js server.

5. "Font size" = how many cols/rows fit the card. ALL visual size changes are tmux resize. No CSS transforms.

6. `SVG_CELL_W = 8.65`, `SVG_CELL_H = 17` — measured from SVG `measure` element. If font changes, these break.

7. CSS3D hit testing is 2D — `e.target.closest` and `getBoundingClientRect()` are unreliable for overlapping cards at different Z depths. Use coordinate-based checking against card/header rects instead.

8. CSS class changes (border, box-shadow) on `.terminal-3d` trigger Chrome to re-rasterize the entire card under `matrix3d` transforms, causing visible text sharpness mutation. Use header-only styling for active indicators.

9. `window._saveLayout()` in browser console saves layout to server. `window._getShareUrl()` gives a URL to share layouts. Profiles stored at `/srv/svg-terminal/profiles/<uid>.json`.

10. The brainstorm visual companion server times out after 30 minutes. Restart with `bash /root/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.6/skills/brainstorming/scripts/start-server.sh --project-dir /srv/svg-terminal --host 0.0.0.0 --url-host 192.168.22.56`.

---

## Constraints (Discovered, Load-Bearing)

### Hard Constraints

| What | Why | Consequence if violated |
|------|-----|----------------------|
| 4x scale trick (variable DOM, CSS3DObject scale 0.25) | Chrome rasterizes DOM before 3D transform | Text blurs |
| SVG is the rendering target | Cross-browser universality | Edge/Chrome render HTML overlays differently |
| No per-terminal DOM click handlers | Double-fire with ctrl+click | Multi-focus breaks |
| Event routing flags (mouseDownOnSidebar, suppressNextClick, lastAddToFocusTime, ctrlHeld, altHeld) | Each prevents a tested bug | Various click/focus bugs |
| Camera-only focus: no DOM resize on focus | Eliminates entire category of sizing bugs | Two-state architecture returns |
| No CSS border/box-shadow on .terminal-3d for indicators | Triggers Chrome re-rasterization under matrix3d | Text sharpness mutation on focus switch |
| Coordinate-based header hit testing | CSS3D 2D hit testing ignores Z depth | Wrong card intercepts clicks |
| `_savedZ` must be cleared on deselect | Accumulates READING_Z_OFFSET per cycle | Card creeps toward camera |
| Frustum layout: no camera offset | Camera at origin, sidebar is overlay | Every offset combination was wrong |
| `dragDistance` reset on every mousedown | Previous drag distance persists | Can't click after any drag |

### Performance Contracts

| What | Value | Why |
|------|-------|-----|
| Server poll interval | 30ms | Interactive use |
| MORPH_DURATION | 1.5s | Fly-in animation |
| BILLBOARD_SLERP | 0.08 | Face-camera drift |
| Ring Z ease rate | 0.05/frame | Smooth ring push/pull |
| refreshSessions poll | 5000ms | Reactive card sizing |
| READING_Z_OFFSET | 25 | Subtle active card forward slide |

---

## Anti-Patterns (Tried and Failed)

| What was tried | What happened | What to do instead |
|---------------|--------------|-------------------|
| CSS `transform: scale()` for font zoom | Counteracted by width/height adjustment | Change tmux cols/rows |
| Camera offset for sidebar | Every sign combination wrong | No offset, sidebar is overlay |
| DOM resize on focus (1:1 pixel mapping) | Two-state architecture, every feature breaks something | Camera-only focus |
| `e.target.closest` in CSS3D | 2D hit testing picks wrong card at different Z depths | Coordinate-based rect checking |
| Border/box-shadow for active indicator | Chrome re-rasterizes entire card under matrix3d | Header background change only |
| `_layoutZ` for Z slide restore | Stale after user moves card | `_savedZ` captures current Z |
| `focusedSessions.clear()` on deselect | Cards fly back to ring | Keep focusedSessions, just remove input |
| Floating overlay controls bar | Positioning unreliable in CSS3D, intercepts header clicks | Controls inline in card header |

---

## Break Tests (Fragile Components)

| Mutation | What breaks | How to detect |
|----------|------------|--------------|
| Remove `syncOrbitFromCamera()` in orbit mousedown | Camera snaps | Visual: camera jumps on orbit start |
| Remove `focusQuatFrom` on focus | Card snaps flat | Visual: rotation snap |
| Change css3dObj scale from 0.25 | Text blurs | Visual: fuzzy text |
| Add per-terminal click handlers | Ctrl+click adds 2 | Click count wrong |
| Clear `focusedSessions` on deselect | Cards fly to ring | Visual: cards scatter |
| Don't delete `_savedZ` on deselect | Z creeps per cycle | Card grows each select |
| Use `e.target.closest` for header | Wrong card intercepts | Drag fails on small cards |
| Add border to `.terminal-3d.input-active` | Re-rasterization | Text sharpness mutation |

---

## Interfaces

### WebSocket: `/ws/terminal?session=X&pane=Y`
Server→Client: `screen`, `delta`, `error`
Client→Server: `input`, `resize`

### HTTP API
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions` | List sessions with cols/rows |
| GET | `/api/pane?session=X&pane=Y` | Capture pane |
| POST | `/api/input` | Send keystrokes |
| GET/POST | `/api/layout?uid=X` | Load/save browser layout profile |

---

## Test Invariants

- `node --test test-server.mjs` — 17 server tests
- `node test-dashboard-e2e.mjs` — 20 E2E puppeteer tests
- Run E2E with haiku subagent before asking user to test

---

## Architecture: Camera-Only Focus

Cards are ALWAYS at `baseCardW × baseCardH`, scale ALWAYS 0.25. Focus = camera moves closer. No DOM changes on focus/unfocus. No inner scale transform. No restore needed.

### Card creation: `createCardDOM(config)`
Generic factory — same structure for terminal and browser cards. Config: `{ id, title, type, controls[], contentEl }`.

### Multi-focus: frustum projection
Layout in screen pixels, project to 3D. Each card at own Z depth. Cell-count proportional sizing. Camera pulls back to see all cards.

### Active card Z-slide
Active card gets `READING_Z_OFFSET` (25 units) forward. `_savedZ` tracks pre-slide Z. Cleared on deselect.

### Deselect vs Unfocus
- Click empty space = deselect (cards stay, input removed)
- Escape = full unfocus (cards return to ring)

---

## What Was About To Be Done Next

### 1. Selection overlay fix (TOP PRIORITY)
Selection highlight is misaligned under CSS3D transforms. Need `screenToCardCoords()` that inverts the matrix3d to properly map screen pixels to card-local coordinates. Same fix will improve header hit testing.

### 2. URL detection + browser cards
Implemented but untested by user. terminal.svg detects URLs, alt+click creates iframe card via `createBrowserDOM()`.

### 3. Merge camera-only-test → dev
Branch is ahead of dev with all the new architecture. Merge after selection fix.

### 4. Cursor offset
Cursor leads text too far right after resize. Likely stale `CELL_W` measurement.

### 5. localStorage persistence
Phase 2 of design spec. Save/restore per-terminal preferences.

### 6. ThinkOrSwim workspace system
Named workspaces, color tag bindings, quick-switch toolbar.

### 7. Mobile support
Touch controls, virtual keys, full-screen terminal on phone.

---

## What Surprised Me

1. **CSS3D hit testing is 2D.** This was the root cause of multiple bugs — header drag not working on small cards, text selection starting on wrong cards. The browser ignores Z depth for event targeting.

2. **CSS class changes trigger re-rasterization.** Adding a border to the active card caused visible text sharpness mutation. The fix was using only header background changes.

3. **Camera-only eliminates an entire category of bugs.** Every sizing bug traced to focus changing the DOM. Removing that one decision simplified hundreds of lines.

4. **The user thinks in terms of windows, not coordinates.** +/- is font size, not card resize. Drag is reposition, not resize. Deselect keeps the layout. These are desktop metaphors applied to 3D.

---

## Files Changed This Session

| File | Summary |
|------|---------|
| `dashboard.mjs` | Camera-only focus, frustum layout, masonry, card factory, browser cards, profiles, controls, Z-slide |
| `dashboard.css` | Flexbox object fill, header controls, gold header indicator, debug background |
| `server.mjs` | /api/sessions cols/rows, /api/layout profiles endpoint |
| `terminal.svg` | URL detection, link layer, alt+click browser card |
| `test-dashboard-e2e.mjs` | 20 E2E tests |
| `restart-server.sh` | Kill+restart in one command |
| `resume-agent-v3.md` | This file |
| `docs/superpowers/specs/` | Design spec for persistence + scenes |
| `council/` | Architecture docs, next features |

---

## Council Protocol

Council at `council/issue_01/`. The advisor agent (session 0317c840) is retired. PHAT TOAD steward protocol from `/srv/PHAT-TOAD-with-Trails/steward/` was read and applied.
