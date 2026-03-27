# SVG Terminal Viewer — Design Spec

**Date:** 2026-03-27
**Status:** Draft
**Project:** `/srv/svg-terminal`

---

## 1. Overview

A zero-dependency Node.js server and self-contained SVG file that renders a live tmux session as vector graphics in a browser. Read-only viewer — no input handling.

**Two files, zero npm dependencies:**
- `server.mjs` — Node built-in `http` module, SGR parser, 3 JSON/SVG endpoints
- `terminal.svg` — standalone SVG with embedded `<script>` for live polling and DOM updates

**First test case:** Viewing `cp-*` tmux sessions from claude-proxy.
**Future integration:** Per-node terminal display in PHAT TOAD's hierarchical agent dashboard.

---

## 2. Architecture

```
┌─────────────────────────────┐
│  terminal.svg               │
│  (standalone SVG file)      │
│                             │
│  <rect> background          │
│  <text> × N lines           │
│    <tspan> colored spans    │
│  <script>                   │
│    fetch /api/pane every    │
│    150ms, diff & update     │
│    text elements            │
└──────────┬──────────────────┘
           │ HTTP GET /api/pane?session=X&pane=Y
           ▼
┌─────────────────────────────┐
│  server.mjs                 │
│  (Node built-in http)       │
│                             │
│  GET /api/pane              │
│    → tmux capture-pane -p   │
│      -e -t session:pane     │
│    → parse SGR into spans   │
│    → return JSON            │
│                             │
│  GET /terminal.svg          │
│    → serve the SVG file     │
│                             │
│  GET /api/sessions          │
│    → tmux list-sessions     │
│    → return session list    │
└──────────┬──────────────────┘
           │ child_process.execSync
           ▼
┌─────────────────────────────┐
│  tmux                       │
│  capture-pane -p -e -t ...  │
│  list-sessions              │
│  display-message (dims)     │
└─────────────────────────────┘
```

---

## 3. Server — `server.mjs`

### 3.1 Endpoints

#### `GET /terminal.svg`

Serves the SVG file with `Content-Type: image/svg+xml`.

#### `GET /api/pane?session=NAME&pane=ID`

Captures the current state of a tmux pane and returns parsed output.

**Server-side steps:**
1. Validate `session` and `pane` against `^[a-zA-Z0-9_:%-]+$` — reject with 400 otherwise (prevents command injection)
2. Run `execFileSync('tmux', ['capture-pane', '-p', '-e', '-t', `${session}:${pane}`])`
3. Run `execFileSync('tmux', ['display-message', '-p', '-t', `${session}:${pane}`, '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y}'])`
4. Parse each line through the SGR parser
5. Return JSON

**Response format:**
```json
{
  "width": 80,
  "height": 24,
  "cursor": { "x": 5, "y": 23 },
  "lines": [
    {
      "spans": [
        { "text": "$ ", "cls": null, "fg": null, "bg": null, "bold": false, "italic": false, "underline": false, "dim": false, "strikethrough": false },
        { "text": "npm test", "cls": null, "fg": null, "bg": null, "bold": true, "italic": false, "underline": false, "dim": false, "strikethrough": false }
      ]
    }
  ]
}
```

**Span fields:**
- `text` — the text content
- `cls` — CSS class name for standard 16 ANSI colors (`c0`-`c15`, `cb0`-`cb15` for bright), or `null` for default
- `fg` — hex color string for 256/truecolor, or `null` if using class or default
- `bg` — hex color string for background, or `null`
- `bold`, `italic`, `underline`, `dim`, `strikethrough` — boolean attributes

#### `GET /api/sessions`

Lists available tmux sessions.

**Server-side:** Runs `tmux list-sessions -F "#{session_name} #{session_windows}"`

**Response:**
```json
[
  { "name": "cp-greg_session_001", "windows": 1 },
  { "name": "cp-svg_terminal", "windows": 1 }
]
```

### 3.2 SGR Parser

A state machine that walks `tmux capture-pane -p -e` output and produces structured spans.

**Input:** `"\x1b[1;38;5;82mPASS\x1b[0m all tests"`
**Output:** `[{ text: "PASS", fg: "#5fff00", bold: true }, { text: " all tests" }]`

**Algorithm:**
1. Walk character by character
2. On `\x1b[` → enter escape mode, accumulate semicolon-separated params
3. On `m` (in escape mode) → apply SGR params to current style state, exit escape mode
4. On printable char → append to current text buffer
5. On style change → push current span (if non-empty), start new span with new style

**SGR codes handled:**

| Code | Meaning |
|------|---------|
| 0 | Reset all attributes |
| 1 | Bold |
| 2 | Dim |
| 3 | Italic |
| 4 | Underline |
| 9 | Strikethrough |
| 22 | Cancel bold/dim |
| 23 | Cancel italic |
| 24 | Cancel underline |
| 29 | Cancel strikethrough |
| 30-37 | Standard foreground (class `c0`-`c7`) |
| 38;5;N | 256-color foreground (hex lookup) |
| 38;2;R;G;B | Truecolor foreground (direct hex) |
| 39 | Default foreground |
| 40-47 | Standard background (class `c0`-`c7` mapped to bg) |
| 48;5;N | 256-color background (hex lookup) |
| 48;2;R;G;B | Truecolor background (direct hex) |
| 49 | Default background |
| 90-97 | Bright foreground (class `cb0`-`cb7`) |
| 100-107 | Bright background |

**256-color lookup:** A hardcoded 256-entry array mapping color index to hex string. Indices 0-15 map to CSS classes instead (themeable). Indices 16-231 are the 6x6x6 color cube. Indices 232-255 are the grayscale ramp.

### 3.3 CORS & Headers

All responses include:
- `Access-Control-Allow-Origin: *`
- `Cache-Control: no-cache` (for API endpoints)

This allows the SVG to be hosted on a different origin from the API server.

### 3.4 Server Configuration

Port is configurable via CLI arg or environment variable:
```bash
node server.mjs --port 3200
# or
PORT=3200 node server.mjs
```

Default port: `3200`

---

## 4. SVG Client — `terminal.svg`

### 4.1 SVG Structure

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 {width * CELL_WIDTH} {height * CELL_HEIGHT}"
     font-family="'DejaVu Sans Mono', 'Fira Code', Consolas, monospace"
     font-size="14">
  <defs>
    <style>
      .fg { fill: #c5c5c5; }
      .bg { fill: #1c1c1c; }
      .c0 { fill: #1c1c1c; }
      .c1 { fill: #ff005b; }
      .c2 { fill: #00cd00; }
      .c3 { fill: #cdcd00; }
      .c4 { fill: #0000ee; }
      .c5 { fill: #cd00cd; }
      .c6 { fill: #00cdcd; }
      .c7 { fill: #e5e5e5; }
      .cb0 { fill: #4d4d4d; }
      .cb1 { fill: #ff0000; }
      .cb2 { fill: #00ff00; }
      .cb3 { fill: #ffff00; }
      .cb4 { fill: #5c5cff; }
      .cb5 { fill: #ff00ff; }
      .cb6 { fill: #00ffff; }
      .cb7 { fill: #ffffff; }
      .bold { font-weight: bold; }
      .italic { font-style: italic; }
      .dim { opacity: 0.5; }
      text {
        dominant-baseline: text-before-edge;
        white-space: pre;
      }
    </style>
  </defs>

  <!-- full background -->
  <rect class="bg" width="100%" height="100%" />

  <!-- background color rects (rebuilt on change) -->
  <g id="bg-layer"></g>

  <!-- text lines (always present, content updated) -->
  <g id="text-layer" class="fg">
    <text id="r0" y="0" textLength="{width * CELL_WIDTH}" xml:space="preserve"></text>
    <text id="r1" y="17" textLength="{width * CELL_WIDTH}" xml:space="preserve"></text>
    <!-- ... one <text> per row -->
  </g>

  <!-- cursor overlay -->
  <rect id="cursor" width="8" height="17" fill="#c5c5c5" opacity="0.7">
    <animate attributeName="opacity" values="0.7;0;0.7" dur="1s" repeatCount="indefinite" />
  </rect>

  <script>
    <!-- embedded client logic -->
  </script>
</svg>
```

**Constants:**
- `CELL_WIDTH = 8` (pixels per character column)
- `CELL_HEIGHT = 17` (pixels per row)
- `FONT_SIZE = 14` (px)

### 4.2 Initialization

1. Read configuration from URL parameters: `?session=X&pane=Y&server=http://host:port`
   - Defaults: `session` = first available, `pane` = `%0`, `server` = same origin
2. First fetch to `/api/pane` determines `width` and `height`
3. Set `viewBox` to `0 0 {width * 8} {height * 17}`
4. Create `<text>` elements `r0` through `r{height-1}`, each with `y = row * 17` and `textLength = width * 8`
5. Measure character cell size for initial poll tier
6. Start poll loop

### 4.3 Poll & Update Loop

```
every {pollInterval}ms:
  1. fetch /api/pane?session={session}&pane={pane}
  2. if fetch fails → show error overlay, retry at 2000ms
  3. for each line index:
     a. JSON.stringify(newLine.spans) vs JSON.stringify(prevState[index])
     b. if identical → skip
     c. if changed → call updateLine(index, newLine.spans)
  4. rebuild background rects if any line changed
  5. update cursor x/y attributes
  6. store current state as prevState
```

### 4.4 Line Update

```js
function updateLine(index, spans) {
  const text = document.getElementById(`r${index}`);
  text.textContent = '';
  for (const span of spans) {
    const tspan = document.createElementNS(SVG_NS, 'tspan');
    tspan.textContent = span.text;
    if (span.cls) tspan.setAttribute('class', span.cls);
    if (span.fg) tspan.setAttribute('fill', span.fg);
    if (span.bold) tspan.classList.add('bold');
    if (span.italic) tspan.classList.add('italic');
    if (span.dim) tspan.classList.add('dim');
    if (span.underline) tspan.setAttribute('text-decoration', 'underline');
    if (span.strikethrough) tspan.setAttribute('text-decoration', 'line-through');
    text.appendChild(tspan);
  }
}
```

### 4.5 Background Rect Rebuild

When any line changes, rebuild `bg-layer`:
1. Clear all children of `#bg-layer`
2. For each line, for each span with a non-null `bg`:
   - Calculate x position from cumulative character offset × CELL_WIDTH
   - Create `<rect x="{x}" y="{row * CELL_HEIGHT}" width="{span.text.length * CELL_WIDTH}" height="{CELL_HEIGHT}" fill="{bg}" />`
3. Append all rects to `#bg-layer`

### 4.6 Visibility-Aware Polling

Three tiers based on rendered character cell size:

| Condition | Poll interval | Rationale |
|-----------|---------------|-----------|
| Character cell >= 4px wide × 6px tall | 150ms | Text legible, full speed |
| Character cell < 4×6 but SVG on screen | 2000ms | Visible but unreadable, show activity only |
| SVG fully offscreen | Stopped | No point updating |

**Implementation:**

```js
const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) {
      stopPolling();
    } else {
      const tier = measureTier();
      startPolling(tier);
    }
  }
}, { threshold: 0 });

observer.observe(document.rootElement);

function measureTier() {
  const el = document.getElementById('r0');
  const rect = el.getBoundingClientRect();
  const charWidth = rect.width / columns;
  const charHeight = rect.height;
  if (charWidth >= 4 && charHeight >= 6) return 150;
  return 2000;
}
```

Tier is also rechecked on window `resize` events (debounced 200ms).

### 4.7 Error Handling

If a fetch to `/api/pane` fails:
- Show a semi-transparent overlay `<rect>` with `<text>` message: "Connection lost — retrying"
- Switch to 2000ms retry interval
- On successful fetch, remove overlay and restore normal polling

---

## 5. Security

- **Input validation:** `session` and `pane` parameters validated against `^[a-zA-Z0-9_:%-]+$` before shell execution. Any other characters return HTTP 400.
- **No shell interpolation:** Parameters are passed as arguments to `execSync`, never interpolated into a shell string. Use `execFileSync` with argument array.
- **Read-only:** No write path to tmux. The viewer cannot send input to sessions.
- **CORS open:** `Access-Control-Allow-Origin: *` — acceptable because the API is read-only and exposes only terminal display content. Can be restricted later via config.

---

## 6. File Structure

```
/srv/svg-terminal/
├── server.mjs              # HTTP server + SGR parser
├── terminal.svg            # Self-contained SVG viewer
├── sessions.md             # Live project context
├── docs/
│   ├── bibliography.md
│   ├── research/
│   │   └── 2026-03-27-v0.1-svg-terminal-viewer-journal.md
│   └── superpowers/
│       └── specs/
│           └── 2026-03-27-svg-terminal-viewer-design.md  # this file
```

---

## 7. Test Plan

1. **Server starts:** `node server.mjs` binds to port 3200 without error
2. **Session list:** `GET /api/sessions` returns the `cp-*` sessions visible via `tmux list-sessions`
3. **Pane capture:** `GET /api/pane?session=cp-greg_session_001&pane=%0` returns valid JSON with correct dimensions and parsed spans
4. **SGR parsing:** Unit test the parser against known ANSI sequences — standard colors, 256-color, truecolor, bold, reset, mixed attributes
5. **SVG renders:** Open `http://localhost:3200/terminal.svg?session=cp-greg_session_001` in Chrome — see terminal content as crisp vector text
6. **Live updates:** Type in the tmux session, see changes reflected in the SVG within ~200ms
7. **Color accuracy:** Compare SVG rendering against actual terminal — colors should match
8. **Zoom:** Zoom to 500% in Chrome — text stays crisp, no pixelation
9. **Input rejection:** `GET /api/pane?session=foo;rm -rf /` returns 400
10. **Visibility tiers:** Embed multiple SVGs in an HTML page, scroll — offscreen ones stop polling (verify via network inspector)

---

## 8. Integration Points

### claude-proxy

The SVG viewer is standalone — no changes to claude-proxy are needed. Just point the viewer at a `cp-*` session name. Future: claude-proxy could serve the SVG and API directly by importing the server logic.

### PHAT TOAD

The dashboard embeds multiple `terminal.svg` instances via `<object>` or `<iframe>` tags, each pointed at a different node's tmux session. The visibility-aware polling ensures only visible terminals consume resources. The JSON API contract is the integration surface.

---

## 9. Out of Scope (for POC)

- Input handling (sending keystrokes to tmux)
- WebSocket streaming (upgrade from polling)
- Session picker UI within the SVG
- Authentication/authorization
- Multiple panes in a single SVG
- Recording/playback
- Custom themes (CSS class approach enables this later)
