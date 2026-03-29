# svg-terminal — Agent Retirement Document v2

**Session ID:** 0317c840-f331-4eac-add0-a6f53550c517
**JSONL Path:** `/root/.claude/projects/-root/0317c840-f331-4eac-add0-a6f53550c517.jsonl`
**Resume command:** `claude --resume 0317c840-f331-4eac-add0-a6f53550c517`
**Working directory:** `/root` (project at `/srv/svg-terminal`)
**Branch:** `dev`
**Date range:** 2026-03-28
**Status:** Retired — context fatigue on resize feature, helper agent continuing via council protocol

---

## What I Know That Isn't Written Down

1. The `pkill -f "node.*server.mjs"` followed by `node server.mjs &` consistently fails because the bash tool resets working directory to `/root`. You must run `node server.mjs &` as a separate command — it picks up the cwd from the shell snapshot which is `/srv/svg-terminal`.

2. The user accesses the dashboard via `http://droidware.ai:3200/` from Windows 11. This is HTTP not HTTPS, which means `navigator.clipboard.writeText()` fails silently. The `fallbackCopy()` using `document.execCommand('copy')` with a hidden textarea is the working clipboard path.

3. The user tests in both Chrome and Edge. They render differently. Any CSS that looks right in puppeteer (headless Chrome) might look wrong in Edge.

4. The `cp-*` tmux sessions are managed by claude-proxy and will NOT accept `tmux resize-window` because they have attached SSH clients constraining the size. Only standalone tmux sessions like `resize-test` and `resize-test2` can be resized. This is critical for testing resize features.

5. The user's PuTTY sessions set the terminal size. When the browser resizes a terminal, the PuTTY user sees it too. This is intentional but surprising.

---

## Constraints (Discovered, Load-Bearing)

### Hard Constraints

| What | Why | Consequence if violated |
|------|-----|----------------------|
| 4x scale trick (1280×992 DOM, CSS3DObject scale 0.25) | Chrome rasterizes DOM before 3D transform. 4x forces high-res raster. | Text blurs in 3D dashboard. Journal v0.2 documents discovery. |
| SVG is the rendering target | User rejected HTML overlay/crossfade approaches. SVG chosen for cross-browser universality. | Edge/Chrome render HTML overlays differently. Adds fragile browser-specific behavior. |
| No per-terminal DOM click handlers | Causes double-fire with ctrl+click multi-focus. Root cause of "adds 2 terminals" bug. | Multi-focus breaks. Took hours to diagnose. |
| Event routing flags must not be simplified | `mouseDownOnSidebar`, `suppressNextClick`, `lastAddToFocusTime`, `ctrlHeld`, `altHeld` — each prevents a specific tested bug. | Various click/focus bugs return. |
| `syncOrbitFromCamera()` on orbit start | Without it, `orbitAngle`/`orbitPitch`/`orbitDist` contain stale values from previous camera position. | Camera snaps violently when starting orbit from focused view. |
| `focusQuatFrom` captured on focus | Without it, focused card snaps flat instantly instead of slerping from its 3D angle. | Z-rotation snap — card rotates to 0 then flies in, instead of rotating during fly-in. |
| Atomic tmux capture (`;` separator) | Separate `display-message` and `capture-pane` calls create a race — cursor position doesn't match screen content. | Cursor appears offset from where input goes. User reported this as "very bad hard to use." |
| `tmux resize-window` not `resize-pane` | `resize-pane` only works within window size constraints. With no attached client, pane can't grow. | Resize silently fails. Discovered during testing. |
| No CSS font scaling for resize | User explicitly corrected: ALL visual size changes come from tmux cols/rows change. No CSS transform zoom. | Coordinate system confusion, death spiral of repeated optimize making terminal smaller. |

### Performance Contracts

| What | Value | Why |
|------|-------|-----|
| Server poll interval | 30ms | Fast enough for interactive use. onRender events will replace in v2 integration. |
| Post-keystroke re-capture delay | 5ms | tmux needs time to process before re-capture shows the result. |
| Scroll step acceleration | 1/3/6/12 lines based on deltaY magnitude | Feels responsive. Fixed step was "clunky." |
| MORPH_DURATION | 1.5s | Fly-in animation length. Billboard slerp ramps during this window. |
| BILLBOARD_SLERP | 0.08 | Lazy drift toward face-camera. Higher = snappier, lower = more 3D angle visible. |

---

## Anti-Patterns (Tried and Failed)

| What was tried | What happened | What to do instead |
|---------------|--------------|-------------------|
| CSS `transform: scale()` on `<object>` for font zoom | Adjusting width/height to prevent overflow caused SVG to rescale DOWN. Net effect: text got smaller, not bigger. Removing width/height adjustment caused different coordinate issues. | Don't CSS-scale the terminal. Change tmux cols/rows to change visual text size. |
| Smooth scroll with CSS `translateY` animation | Any non-zero pixel offset caused visible bounce because the CSS transform and server content update overlap in timing. Tried multiple approaches over 8+ iterations. | Don't animate. Server responds in ~30ms which is fast enough. Line-granular jumps with acceleration. |
| `tmux copy-mode` for scrollback | Entering copy-mode scrolls the PuTTY view but `capture-pane` still returns the base buffer, not the copy-mode view. | Use `capture-pane -S offset -E offset` directly. Manage scroll offset server-side. |
| HTML overlay crossfade for text crispness | Different rendering between Chrome and Edge. Layering HTML on 3D SVG creates fragile browser-specific behavior. | SVG is the target. Solve crispness within SVG pipeline (Nx scaling). |
| SSE + POST instead of WebSocket | Works but two channels instead of one. User found `ws` package already in node_modules via puppeteer. | Use `ws` WebSocket — single bidirectional connection, already installed. |
| Buttons inside CSS3DObject DOM | `getBoundingClientRect()` returns NaN for elements under `matrix3d` transforms. Buttons render visually but can't be clicked. | Use fixed HTML overlay positioned over the terminal. Update position in animate loop. |

---

## Break Tests (Fragile Components)

| Mutation | What breaks | How to detect |
|----------|------------|--------------|
| Remove `syncOrbitFromCamera()` call in orbit mousedown | Camera snaps to stale position when starting orbit from focused view | Visual: click terminal, then right-drag — camera jumps |
| Remove `focusQuatFrom = quaternion.clone()` in focusTerminal | Focused card snaps flat before fly-in animation | Visual: click terminal — card rotates to 0° then flies in |
| Change `css3dObj.scale.setScalar(0.25)` to `1.0` | Terminal text blurs in 3D view | Visual: text is fuzzy/soft |
| Add `el.addEventListener('click', ...)` to terminal DOM | Ctrl+click adds 2 terminals per click | Click count: ctrl+click should add exactly 1 |
| Remove `mouseDownOnSidebar` flag | Ctrl+clicking sidebar thumbnail also fires handleCtrlClick on a background 3D terminal | Terminal count: ctrl+click thumbnail adds 2 instead of 1 |
| Remove `suppressNextClick` flag | `onSceneClick` fires after `onMouseUp` ctrl+click handler, replacing multi-focus with single | Focus count drops to 1 after ctrl+click |
| Remove `lastAddToFocusTime` guard | `focusTerminal()` fires 200ms after `addToFocus()`, replacing multi-focus | Focus count drops to 1 shortly after ctrl+click |
| Use `tmux resize-pane` instead of `resize-window` | Resize silently fails on detached sessions | Terminal dimensions don't change (check with `tput cols`) |
| Remove atomic tmux capture (separate display-message + capture-pane) | Cursor position drifts from screen content under load | Cursor appears offset during fast typing |

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

**Error handling:** `ws.readyState === 1` check before send. Client auto-reconnects after 2s. Server cleans up poll timer on close.

### HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions` | List tmux sessions |
| GET | `/api/pane?session=X&pane=Y` | Capture pane (backward compat) |
| POST | `/api/input` | Send keystrokes (backward compat) |

### Span Format
```json
{ "text": "hello", "fg": "#00cd00", "bg": "#1c1c1e", "bold": true, "italic": false, "underline": false, "dim": false, "strikethrough": false, "cls": "c2", "bgCls": "bc0" }
```

---

## Test Invariants

**Test runner:** `node --test` (Node.js built-in)
**Test count:** 17 (16 original + 1 WebSocket resize)
**Run:** `cd /srv/svg-terminal && node --test test-server.mjs`

**What's covered:**
- HTTP API routes (sessions, pane capture, input)
- CORS headers
- Parameter validation (bad session/pane names)
- WebSocket connect + receive screen event
- WebSocket input → receive delta
- WebSocket resize message processed

**What's NOT covered:**
- Client-side dashboard behavior (no DOM tests)
- Text selection / copy-paste
- 3D scene rendering
- Multi-focus / event routing
- Font zoom / resize interaction
- These are tested manually via puppeteer scripts

---

## What I Was About To Do Next (and Why)

### Immediate: Terminal resize (council issue_01, request_04)
The helper agent has request_04 which corrects the approach: no CSS font scaling, all tmux resize. The helper should implement this. Key insight from user: "+/- changes font size by changing tmux cols/rows, not by CSS transform."

### Next: claude-proxy v2 integration
Phase B (adapt client to new API endpoints) is ready to start once the resize feature stabilizes. The architecture is agreed in the integration docs at `/srv/claude-proxy/docs/integration/`. The other Claude has already built `screen-renderer.ts`, PtyMultiplexer hooks, and `api-server.ts` on port 3101.

### Pending tasks (by priority):
1. Terminal resize — helper agent working on it
2. claude-proxy v2 integration Phase B+C
3. User auth + preferences (#19)
4. Session permissions in browser (#22)
5. Composed titles from claude-proxy (#16)
6. Ctrl+B hotkeys (#18) — fixed automatically by integration
7. Terminal key encoding presets (#20)
8. Multi-language support (#21)

---

## What Surprised Me About Current State

1. **CSS transforms inside CSS3DRenderer are a dead end for interactive controls.** `getBoundingClientRect()` returns NaN, click events don't reach buttons, coordinate spaces multiply. Any UI controls must be fixed HTML overlays outside the 3D scene.

2. **The user's mental model of "font size" is "how many cols/rows fit" — not "CSS transform."** This seems obvious in retrospect but I spent hours building CSS scaling before the user corrected me.

3. **`tmux resize-pane` vs `resize-window` — not obvious, not documented well.** `resize-pane` only works within window constraints. `resize-window` changes the window, allowing the pane to fill. Discovered empirically.

4. **The smooth scroll rabbit hole.** Spent significant effort on CSS `translateY` animation that could never work because the transform and content update overlap in timing. The 30ms server response is fast enough — the answer was to not animate.

5. **Event routing is the hardest part of the entire project.** Not the 3D rendering, not the WebSocket streaming, not the SVG. Getting ctrl+click, alt+drag, text selection, and focus/unfocus to coexist without interfering required 5 flags, 3 event paths, and careful ordering. Any new feature that touches mouse events must understand all of this.

---

## Council Protocol

Active council at `council/issue_01/`. Communication via markdown files:
- `request_NN.md` — my requests to the helper agent
- `request_NN-RESPONSE-NN.md` — their responses
- Request 04 is pending (course correction to tmux-only resize)
- Helper agent has their own tmux session: `cp-SVG-TERM_HELP_ISSUE_01_AGENT`
