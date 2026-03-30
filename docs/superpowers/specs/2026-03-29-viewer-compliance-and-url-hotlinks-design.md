# Viewer Compliance & URL Hotlinks — Design Spec

**Date:** 2026-03-29
**Branch:** camera-only-test
**Status:** Draft

---

## 1. Goal

Make svg-terminal a fully compliant tmux viewer by handling all escape sequences that `capture-pane -e` can produce, enriching the API with available tmux metadata, and enabling clickable URL hotlinks in the 3D dashboard.

---

## 2. Parser Upgrade (`sgr-parser.mjs`)

### 2.1 State Machine Structure

Replace the current single-path loop (CSI-only) with a three-family state machine:

```
NORMAL → accumulate text
ESC seen → check next character:
  '[' → CSI: scan params + final byte
         'm' → SGR (existing + new codes below)
         other → skip silently
  ']' → OSC: scan to terminator (ESC \ or BEL)
         '8' → hyperlink: extract URL, set style.url
         other → strip (don't leak into text)
  other → skip (single-char escapes: ESC D, ESC M, etc.)
```

### 2.2 New SGR Codes

| Code | Property | Reset | Rendering |
|------|----------|-------|-----------|
| 7 | `reverse: true` | 27 | Swap fg/bg at render time |
| 8 | `hidden: true` | 28 | `visibility: hidden` or transparent |
| 53 | `overline: true` | 55 | `text-decoration: overline` (SVG: line above) |
| 58;5;N | `underlineColor: '#hex'` | 59 | Colored underline |
| 58;2;R;G;B | `underlineColor: '#rrggbb'` | 59 | Colored underline |

Note: tmux may re-encode SGR 53 as `5:3` (colon sub-parameter syntax). Parser handles both `;` and `:` separators.

### 2.3 OSC 8 Hyperlinks

Format in `capture-pane -e` output:
```
ESC ] 8 ; ; URL ESC \   ← open link
  visible text
ESC ] 8 ; ; ESC \       ← close link (empty URL)
```

Parser sets `style.url = URL` when open is encountered. Text spans between open and close get `span.url = URL`. Close sets `style.url = null`.

### 2.4 Plain-Text URL Fallback

Post-pass after the main loop: scan each span's text for `http://` or `https://` prefix. Walk forward to first whitespace/control character. Split span at URL boundaries. Tag URL portion with `span.url`.

This runs once per line in the parser. No client-side detection needed.

### 2.5 Span Shape After Changes

```js
{
  text, cls, fg, bg, bgCls,
  bold, italic, underline, dim, strikethrough,
  reverse, hidden, overline, underlineColor,  // new SGR
  url                                          // OSC 8 / plaintext
}
```

---

## 3. Server Metadata (`server.mjs`)

### 3.1 Expanded Format String

`capturePane()` currently fetches: `pane_width`, `pane_height`, `cursor_x`, `cursor_y`, `pane_title`.

Add to the `display-message` format string:
- `pane_current_path` — CWD
- `pane_current_command` — running process name
- `pane_pid` — process ID
- `history_size` — scrollback line count
- `pane_dead` — 1 if pane process has exited

### 3.2 API Response Shape

```json
{
  "width": 80, "height": 24,
  "cursor": { "x": 5, "y": 10 },
  "title": "session name",
  "path": "/srv/svg-terminal",
  "command": "bash",
  "pid": 12345,
  "historySize": 1500,
  "dead": false,
  "lines": [...]
}
```

New fields are informational — no client changes required to consume them. Dashboard can use them in future (e.g., show CWD in card header).

---

## 4. URL Click Handling (`dashboard.mjs`)

### 4.1 Approach: Dashboard-Layer Click + SVG Visual

The `<object>` has `pointer-events: none` (required for dashboard event routing). URL visual indicators (blue underlines) render inside the SVG via `rebuildLinkLayer`. Click handling happens in the dashboard layer.

### 4.2 Click Flow

On click in focused card body area (existing `onSceneClick` path):

1. `screenToCell(e, terminal)` → `{ row, col }`
2. Look up `terminal.screenLines[row].spans` → find the span at `col`
3. If `span.url` exists:
   - Regular click → `window.open(url, '_blank')`
   - Alt+click → `addBrowserCard(url)`
4. If no URL → existing behavior (focus switch, deselect)

### 4.3 screenLines Population

The WebSocket handler already stores line data. Ensure `screenLines` is updated with full span data (including `url` property) on every `screen` and `delta` message.

---

## 5. SVG Link Layer (`terminal.svg`)

### 5.1 Simplified rebuildLinkLayer

Current: runs URL regex on concatenated line text, creates underlines and clickable rects.

New: iterates spans checking `span.url`. Creates blue underline SVG elements only. No click handlers (dashboard handles clicks). No regex.

### 5.2 Underline Style

- `stroke: #5c8fff`
- `stroke-width: 1`
- `opacity: 0.6`
- Positioned at bottom of cell row

---

## 6. Selection Fix (Already Implemented)

### 6.1 Highlight Placement

Selection highlight rects are now created inside the SVG document as `<rect>` elements in a `<g id="sel-layer">`. This eliminates subpixel drift from CSS3D transforms.

### 6.2 Mouse-to-Cell Mapping

`screenToCell()` uses proportional mapping through `getBoundingClientRect()`:
```
fracY = (mouseY - objRect.top) / objRect.height
svgY = fracY * viewBoxHeight
row = floor(svgY / cellH)
```

`cellH` is read from the SVG's actual row spacing (`r1.y - r0.y`), not `measureBBox.height`.

---

## 7. Testing

### 7.1 Parser Tests (`test-sgr-parser.mjs`)

- OSC 8 open/close produces `span.url`
- OSC 8 with styled text preserves both style and URL
- Unknown OSC stripped (no text leakage)
- SGR 7 (reverse), 8 (hidden), 53 (overline) set properties
- SGR 58 (underline color) with 256 and truecolor
- Plain-text URL detection and span splitting
- Mixed OSC 8 + plain-text URLs on same line

### 7.2 E2E Alignment Test

Checkerboard test pattern (alternating `█` and `─`, offset each row) at varied:
- Card sizes (small, large, wide, tall)
- Terminal dimensions (20x8, 120x10, 30x50, 200x60, 80x24)
- Verify overlay-to-text alignment holds across all combinations

### 7.3 URL Click Test

- Create tmux session with OSC 8 hyperlink
- Verify `span.url` appears in API response
- Verify blue underline renders in SVG
- Verify click on URL cell triggers `window.open` or `addBrowserCard`

---

## 8. Files Changed

| File | Changes |
|------|---------|
| `sgr-parser.mjs` | State machine, new SGR codes, OSC 8, plain-text URL |
| `server.mjs` | Expanded tmux format string, new response fields |
| `dashboard.mjs` | URL click handler in `onSceneClick`, `screenLines` with url |
| `terminal.svg` | Simplified `rebuildLinkLayer` (read `span.url`, no regex) |
| `test-sgr-parser.mjs` | New test cases for all parser changes |
| `test-dashboard-e2e.mjs` | Checkerboard alignment test, URL click test |

---

## 9. What This Does NOT Include

- Replacing tmux (terminal emulation stays with tmux)
- Rendering new SGR properties in the dashboard (reverse, overline, etc. — properties are parsed and stored but visual rendering is a separate task)
- Using new tmux metadata in the UI (data is available in API, dashboard changes are future work)
- Fixing the `position:fixed` selection overlay on `document.body` (replaced with SVG-internal approach)
