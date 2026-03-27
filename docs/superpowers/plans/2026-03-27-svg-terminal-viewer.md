# SVG Terminal Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dependency Node.js server + self-contained SVG that renders multiple live tmux sessions as vector graphics in a browser.

**Architecture:** Bare Node `http` module serves a JSON API (tmux capture-pane output parsed from SGR to structured spans). Self-contained SVG files poll the API and render via `<text>`/`<tspan>` elements. A dashboard HTML page auto-discovers sessions and arranges SVG viewers in a grid.

**Tech Stack:** Node.js 22 (built-in `http`, `child_process`, `fs`), SVG with embedded JavaScript, plain HTML/CSS.

**Spec:** `docs/superpowers/specs/2026-03-27-svg-terminal-viewer-design.md`

---

## File Structure

```
/srv/svg-terminal/
├── server.mjs              # HTTP server (routing, static files, API handlers)
├── sgr-parser.mjs          # SGR escape code parser (pure function, no side effects)
├── color-table.mjs         # 256-color index → hex lookup table
├── terminal.svg            # Self-contained SVG viewer with embedded <script>
├── index.html              # Multi-session dashboard
├── test-sgr-parser.mjs     # SGR parser tests (run with node --test)
├── test-server.mjs         # Server API tests (run with node --test)
```

**Why separate `sgr-parser.mjs` and `color-table.mjs`?** The parser is the most complex logic and needs thorough unit testing in isolation. The color table is 256 entries — separating it keeps the parser focused on logic.

---

## Phase 1: Single Terminal POC

### Task 1: 256-Color Lookup Table

**Files:**
- Create: `/srv/svg-terminal/color-table.mjs`

- [ ] **Step 1: Create the color table module**

```js
// color-table.mjs
// 256-color index → hex string
// Indices 0-15: null (use CSS classes c0-c15 instead)
// Indices 16-231: 6×6×6 color cube
// Indices 232-255: grayscale ramp

const table = new Array(256);

// 0-15: standard colors → null (handled by CSS classes)
for (let i = 0; i < 16; i++) table[i] = null;

// 16-231: 6×6×6 color cube
const cubeLevels = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
for (let i = 16; i < 232; i++) {
  const idx = i - 16;
  const r = cubeLevels[Math.floor(idx / 36)];
  const g = cubeLevels[Math.floor((idx % 36) / 6)];
  const b = cubeLevels[idx % 6];
  table[i] = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

// 232-255: grayscale ramp (8 to 238 in steps of 10)
for (let i = 232; i < 256; i++) {
  const g = 8 + (i - 232) * 10;
  table[i] = '#' + g.toString(16).padStart(2, '0').repeat(3);
}

// Standard foreground class names for indices 0-7 and 8-15
const fgClass = [
  'c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7',
  'cb0', 'cb1', 'cb2', 'cb3', 'cb4', 'cb5', 'cb6', 'cb7'
];

// Standard background class names for indices 0-7 and 8-15
const bgClass = [
  'bc0', 'bc1', 'bc2', 'bc3', 'bc4', 'bc5', 'bc6', 'bc7',
  'bcb0', 'bcb1', 'bcb2', 'bcb3', 'bcb4', 'bcb5', 'bcb6', 'bcb7'
];

export { table, fgClass, bgClass };
```

- [ ] **Step 2: Verify a few known values**

Run: `node -e "import('./color-table.mjs').then(m => { console.log(m.table[16], m.table[196], m.table[232], m.table[255], m.fgClass[1], m.bgClass[0]); })"`

Expected: `#000000 #ff0000 #080808 #eeeeee c1 bc0`

- [ ] **Step 3: Commit**

```bash
git add color-table.mjs
git commit -m "feat: add 256-color lookup table"
```

---

### Task 2: SGR Parser

**Files:**
- Create: `/srv/svg-terminal/sgr-parser.mjs`
- Create: `/srv/svg-terminal/test-sgr-parser.mjs`

- [ ] **Step 1: Write the test file with failing tests**

```js
// test-sgr-parser.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from './sgr-parser.mjs';

describe('SGR Parser', () => {
  it('parses plain text with no escapes', () => {
    const spans = parseLine('hello world');
    assert.deepStrictEqual(spans, [
      { text: 'hello world', cls: null, fg: null, bg: null, bold: false, italic: false, underline: false, dim: false, strikethrough: false }
    ]);
  });

  it('parses bold text', () => {
    const spans = parseLine('\x1b[1mhello\x1b[0m world');
    assert.equal(spans[0].text, 'hello');
    assert.equal(spans[0].bold, true);
    assert.equal(spans[1].text, ' world');
    assert.equal(spans[1].bold, false);
  });

  it('parses standard foreground colors', () => {
    const spans = parseLine('\x1b[31mred\x1b[32mgreen\x1b[0m');
    assert.equal(spans[0].cls, 'c1');
    assert.equal(spans[0].text, 'red');
    assert.equal(spans[1].cls, 'c2');
    assert.equal(spans[1].text, 'green');
  });

  it('parses bright foreground colors', () => {
    const spans = parseLine('\x1b[91mbright red\x1b[0m');
    assert.equal(spans[0].cls, 'cb1');
  });

  it('parses standard background colors', () => {
    const spans = parseLine('\x1b[41mred bg\x1b[0m');
    assert.equal(spans[0].cls, 'bc1');
    assert.equal(spans[0].text, 'red bg');
  });

  it('parses bright background colors', () => {
    const spans = parseLine('\x1b[101mbright red bg\x1b[0m');
    assert.equal(spans[0].cls, 'bcb1');
  });

  it('parses 256-color foreground', () => {
    const spans = parseLine('\x1b[38;5;82mgreen\x1b[0m');
    assert.equal(spans[0].fg, '#5fff00');
    assert.equal(spans[0].cls, null);
  });

  it('parses 256-color foreground for standard colors (uses class)', () => {
    const spans = parseLine('\x1b[38;5;1mred\x1b[0m');
    assert.equal(spans[0].cls, 'c1');
    assert.equal(spans[0].fg, null);
  });

  it('parses truecolor foreground', () => {
    const spans = parseLine('\x1b[38;2;255;128;0morange\x1b[0m');
    assert.equal(spans[0].fg, '#ff8000');
  });

  it('parses 256-color background', () => {
    const spans = parseLine('\x1b[48;5;196mred bg\x1b[0m');
    assert.equal(spans[0].bg, '#ff0000');
  });

  it('parses truecolor background', () => {
    const spans = parseLine('\x1b[48;2;0;0;255mblue bg\x1b[0m');
    assert.equal(spans[0].bg, '#0000ff');
  });

  it('parses multiple attributes', () => {
    const spans = parseLine('\x1b[1;3;4mstuff\x1b[0m');
    assert.equal(spans[0].bold, true);
    assert.equal(spans[0].italic, true);
    assert.equal(spans[0].underline, true);
  });

  it('parses dim and strikethrough', () => {
    const spans = parseLine('\x1b[2;9mfaded\x1b[0m');
    assert.equal(spans[0].dim, true);
    assert.equal(spans[0].strikethrough, true);
  });

  it('handles cancel codes', () => {
    const spans = parseLine('\x1b[1;3mbold italic\x1b[22mnot bold\x1b[23mnormal\x1b[0m');
    assert.equal(spans[0].bold, true);
    assert.equal(spans[0].italic, true);
    assert.equal(spans[1].bold, false);
    assert.equal(spans[1].italic, true);
    assert.equal(spans[2].bold, false);
    assert.equal(spans[2].italic, false);
  });

  it('handles default fg/bg reset codes', () => {
    const spans = parseLine('\x1b[31mred\x1b[39mdefault\x1b[0m');
    assert.equal(spans[0].cls, 'c1');
    assert.equal(spans[1].cls, null);
    assert.equal(spans[1].fg, null);
  });

  it('handles combined fg and bg', () => {
    const spans = parseLine('\x1b[31;42mred on green\x1b[0m');
    assert.equal(spans[0].cls, 'c1');
    assert.equal(spans[0].bg, null);
    // bg class is separate — check for bc2
    // Actually, when both fg and bg have classes, cls should be fg class
    // and bg gets its own class. Let's check the parser handles this.
    // The span should carry fg class + bg class info.
  });

  it('returns empty array for empty string', () => {
    const spans = parseLine('');
    assert.deepStrictEqual(spans, []);
  });

  it('handles reset with no prior style', () => {
    const spans = parseLine('\x1b[0mhello');
    assert.equal(spans[0].text, 'hello');
    assert.equal(spans[0].bold, false);
  });

  it('skips non-SGR escape sequences', () => {
    // Cursor movement etc. should be ignored
    const spans = parseLine('\x1b[Hhello');
    assert.equal(spans[0].text, 'hello');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/svg-terminal && node --test test-sgr-parser.mjs`

Expected: All tests fail (module not found)

- [ ] **Step 3: Write the SGR parser**

```js
// sgr-parser.mjs
import { table, fgClass, bgClass } from './color-table.mjs';

function defaultStyle() {
  return { cls: null, fg: null, bg: null, bgCls: null, bold: false, italic: false, underline: false, dim: false, strikethrough: false };
}

function styleEqual(a, b) {
  return a.cls === b.cls && a.fg === b.fg && a.bg === b.bg && a.bgCls === b.bgCls &&
    a.bold === b.bold && a.italic === b.italic && a.underline === b.underline &&
    a.dim === b.dim && a.strikethrough === b.strikethrough;
}

function toHex(r, g, b) {
  return '#' + [r, g, b].map(c => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');
}

export function parseLine(line) {
  if (!line) return [];

  const spans = [];
  let style = defaultStyle();
  let text = '';
  let i = 0;

  function pushSpan() {
    if (text.length > 0) {
      spans.push({
        text,
        cls: style.cls,
        fg: style.fg,
        bg: style.bgCls ? null : style.bg,
        bgCls: style.bgCls,
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        dim: style.dim,
        strikethrough: style.strikethrough
      });
      text = '';
    }
  }

  while (i < line.length) {
    // Check for ESC [
    if (line[i] === '\x1b' && line[i + 1] === '[') {
      i += 2;
      // Accumulate params until we hit a letter
      let paramStr = '';
      while (i < line.length && line[i] >= '0' && line[i] <= '9' || line[i] === ';') {
        paramStr += line[i];
        i++;
      }
      const finalChar = line[i];
      i++;

      // Only handle SGR (m)
      if (finalChar !== 'm') continue;

      const oldStyle = { ...style };
      const params = paramStr === '' ? [0] : paramStr.split(';').map(Number);

      let p = 0;
      while (p < params.length) {
        const code = params[p];
        if (code === 0) {
          style = defaultStyle();
        } else if (code === 1) {
          style.bold = true;
        } else if (code === 2) {
          style.dim = true;
        } else if (code === 3) {
          style.italic = true;
        } else if (code === 4) {
          style.underline = true;
        } else if (code === 9) {
          style.strikethrough = true;
        } else if (code === 22) {
          style.bold = false;
          style.dim = false;
        } else if (code === 23) {
          style.italic = false;
        } else if (code === 24) {
          style.underline = false;
        } else if (code === 29) {
          style.strikethrough = false;
        } else if (code >= 30 && code <= 37) {
          style.cls = fgClass[code - 30];
          style.fg = null;
        } else if (code === 38) {
          // Extended foreground
          if (params[p + 1] === 5 && p + 2 < params.length) {
            // 256-color
            const idx = params[p + 2];
            if (idx < 16) {
              style.cls = fgClass[idx];
              style.fg = null;
            } else {
              style.cls = null;
              style.fg = table[idx] || null;
            }
            p += 2;
          } else if (params[p + 1] === 2 && p + 4 < params.length) {
            // Truecolor
            style.cls = null;
            style.fg = toHex(params[p + 2], params[p + 3], params[p + 4]);
            p += 4;
          }
        } else if (code === 39) {
          style.cls = null;
          style.fg = null;
        } else if (code >= 40 && code <= 47) {
          style.bgCls = bgClass[code - 40];
          style.bg = null;
        } else if (code === 48) {
          // Extended background
          if (params[p + 1] === 5 && p + 2 < params.length) {
            const idx = params[p + 2];
            if (idx < 16) {
              style.bgCls = bgClass[idx];
              style.bg = null;
            } else {
              style.bgCls = null;
              style.bg = table[idx] || null;
            }
            p += 2;
          } else if (params[p + 1] === 2 && p + 4 < params.length) {
            style.bgCls = null;
            style.bg = toHex(params[p + 2], params[p + 3], params[p + 4]);
            p += 4;
          }
        } else if (code === 49) {
          style.bgCls = null;
          style.bg = null;
        } else if (code >= 90 && code <= 97) {
          style.cls = fgClass[code - 90 + 8];
          style.fg = null;
        } else if (code >= 100 && code <= 107) {
          style.bgCls = bgClass[code - 100 + 8];
          style.bg = null;
        }
        p++;
      }

      if (!styleEqual(oldStyle, style)) {
        pushSpan();
      }
    } else {
      text += line[i];
      i++;
    }
  }

  pushSpan();
  return spans;
}
```

**Note on the spec:** The spec defines span fields `cls`, `fg`, `bg`. The parser adds `bgCls` for background CSS classes (separate from `fg` classes). The SVG client needs both — `cls` for text `fill` and `bgCls` for background `<rect>` class. This is a refinement over the spec's simpler model where `cls` was overloaded.

- [ ] **Step 4: Run tests**

Run: `cd /srv/svg-terminal && node --test test-sgr-parser.mjs`

Expected: Most tests pass. Fix any failures — the test for "combined fg and bg" may need adjustment since we now have `bgCls` as a separate field.

- [ ] **Step 5: Update tests for bgCls field and fix any failures**

Update the test expectations to account for the `bgCls` field. Each span object in test assertions should include `bgCls: null` (or the appropriate value). Run tests again until all pass.

Run: `cd /srv/svg-terminal && node --test test-sgr-parser.mjs`

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add sgr-parser.mjs test-sgr-parser.mjs
git commit -m "feat: add SGR escape code parser with full color support"
```

---

### Task 3: HTTP Server with `/api/pane` Endpoint

**Files:**
- Create: `/srv/svg-terminal/server.mjs`
- Create: `/srv/svg-terminal/test-server.mjs`

- [ ] **Step 1: Write server tests**

```js
// test-server.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const PORT = 3299; // test port to avoid conflicts
let serverProcess;

before(async () => {
  const { spawn } = await import('node:child_process');
  serverProcess = spawn('node', ['server.mjs', '--port', String(PORT)], {
    cwd: '/srv/svg-terminal',
    stdio: 'pipe'
  });
  // Wait for server to start
  await new Promise(resolve => setTimeout(resolve, 500));
});

after(() => {
  if (serverProcess) serverProcess.kill();
});

async function fetchJSON(path) {
  const res = await fetch(`http://localhost:${PORT}${path}`);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function fetchText(path) {
  const res = await fetch(`http://localhost:${PORT}${path}`);
  return { status: res.status, headers: res.headers, body: await res.text() };
}

describe('Server API', () => {
  it('serves terminal.svg with correct content type', async () => {
    const res = await fetchText('/terminal.svg');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.ok(res.body.includes('<svg'));
  });

  it('rejects invalid session names', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/pane?session=foo;rm%20-rf&pane=%250`);
    assert.equal(res.status, 400);
  });

  it('returns 404 for nonexistent session', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/pane?session=nonexistent_session_xyz&pane=%250`);
    // tmux will error — server should return 500 or 404
    assert.ok([404, 500].includes(res.status));
  });

  it('returns CORS headers', async () => {
    const res = await fetchText('/terminal.svg');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('returns session list', async () => {
    const res = await fetchJSON('/api/sessions');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    // There should be at least one session running (the test environment has cp-* sessions)
    assert.ok(res.body.length > 0);
    assert.ok(res.body[0].name);
    assert.ok(typeof res.body[0].windows === 'number');
  });

  it('captures a real tmux pane', async () => {
    // Use the first available session
    const sessions = await fetchJSON('/api/sessions');
    const session = sessions.body[0].name;
    const res = await fetchJSON(`/api/pane?session=${session}&pane=%250`);
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.width === 'number');
    assert.ok(typeof res.body.height === 'number');
    assert.ok(typeof res.body.cursor.x === 'number');
    assert.ok(typeof res.body.cursor.y === 'number');
    assert.ok(Array.isArray(res.body.lines));
    assert.ok(res.body.lines.length > 0);
    assert.ok(Array.isArray(res.body.lines[0].spans));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/svg-terminal && node --test test-server.mjs`

Expected: Connection refused (server not built yet)

- [ ] **Step 3: Write the server**

```js
// server.mjs
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseLine } from './sgr-parser.mjs';

const PARAM_RE = /^[a-zA-Z0-9_:%-]+$/;
const DEFAULT_PORT = 3200;

function getPort() {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && args[portIdx + 1]) return parseInt(args[portIdx + 1], 10);
  if (process.env.PORT) return parseInt(process.env.PORT, 10);
  return DEFAULT_PORT;
}

function validate(value) {
  return typeof value === 'string' && PARAM_RE.test(value);
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  });
  res.end(body);
}

function serveFile(res, filePath, contentType) {
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

function handlePane(req, res, params) {
  const session = params.get('session');
  const pane = params.get('pane') || '%0';

  if (!session || !validate(session) || !validate(pane)) {
    return json(res, 400, { error: 'Invalid session or pane parameter' });
  }

  try {
    const raw = execFileSync('tmux', ['capture-pane', '-p', '-e', '-t', `${session}:${pane}`], { encoding: 'utf8' });
    const metaRaw = execFileSync('tmux', ['display-message', '-p', '-t', `${session}:${pane}`,
      '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y}'], { encoding: 'utf8' }).trim();
    const [width, height, cursorX, cursorY] = metaRaw.split(' ').map(Number);

    const rawLines = raw.split('\n');
    // Remove trailing empty line from split
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

    const lines = rawLines.map(line => ({ spans: parseLine(line) }));

    json(res, 200, { width, height, cursor: { x: cursorX, y: cursorY }, lines });
  } catch (err) {
    json(res, 500, { error: `tmux error: ${err.message}` });
  }
}

function handleSessions(req, res) {
  try {
    const raw = execFileSync('tmux', ['list-sessions', '-F', '#{session_name} #{session_windows}'], { encoding: 'utf8' }).trim();
    const sessions = raw.split('\n').map(line => {
      const parts = line.split(' ');
      return { name: parts[0], windows: parseInt(parts[1], 10) };
    });
    json(res, 200, sessions);
  } catch (err) {
    json(res, 500, { error: `tmux error: ${err.message}` });
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/') {
    serveFile(res, new URL('index.html', import.meta.url).pathname, 'text/html');
  } else if (req.method === 'GET' && path === '/terminal.svg') {
    serveFile(res, new URL('terminal.svg', import.meta.url).pathname, 'image/svg+xml');
  } else if (req.method === 'GET' && path === '/api/pane') {
    handlePane(req, res, url.searchParams);
  } else if (req.method === 'GET' && path === '/api/sessions') {
    handleSessions(req, res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const port = getPort();
server.listen(port, () => {
  console.log(`svg-terminal server listening on http://localhost:${port}`);
});
```

- [ ] **Step 4: Create a minimal terminal.svg placeholder so the server can serve it**

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 408">
  <rect width="100%" height="100%" fill="#1c1c1c"/>
  <text x="10" y="20" fill="#c5c5c5" font-family="monospace" font-size="14">Loading...</text>
</svg>
```

- [ ] **Step 5: Create a minimal index.html placeholder**

```html
<!DOCTYPE html>
<html><head><title>svg-terminal</title></head>
<body style="background:#0a0a0a;color:#ccc;font-family:monospace">
  <p>Dashboard placeholder</p>
</body></html>
```

- [ ] **Step 6: Run tests**

Run: `cd /srv/svg-terminal && node --test test-server.mjs`

Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add server.mjs terminal.svg index.html test-server.mjs
git commit -m "feat: add HTTP server with /api/pane and /api/sessions endpoints"
```

---

### Task 4: SVG Viewer with Poll Loop

**Files:**
- Modify: `/srv/svg-terminal/terminal.svg` (replace placeholder)

- [ ] **Step 1: Write the full terminal.svg**

```xml
<svg xmlns="http://www.w3.org/2000/svg" id="root"
     font-family="'DejaVu Sans Mono', 'Fira Code', Consolas, monospace"
     font-size="14">
  <defs>
    <style>
      .fg { fill: #c5c5c5; }
      .bg { fill: #1c1c1c; }
      .c0 { fill: #1c1c1c; } .c1 { fill: #ff005b; } .c2 { fill: #00cd00; }
      .c3 { fill: #cdcd00; } .c4 { fill: #0000ee; } .c5 { fill: #cd00cd; }
      .c6 { fill: #00cdcd; } .c7 { fill: #e5e5e5; }
      .cb0 { fill: #4d4d4d; } .cb1 { fill: #ff0000; } .cb2 { fill: #00ff00; }
      .cb3 { fill: #ffff00; } .cb4 { fill: #5c5cff; } .cb5 { fill: #ff00ff; }
      .cb6 { fill: #00ffff; } .cb7 { fill: #ffffff; }
      .bc0 { fill: #1c1c1c; } .bc1 { fill: #ff005b; } .bc2 { fill: #00cd00; }
      .bc3 { fill: #cdcd00; } .bc4 { fill: #0000ee; } .bc5 { fill: #cd00cd; }
      .bc6 { fill: #00cdcd; } .bc7 { fill: #e5e5e5; }
      .bcb0 { fill: #4d4d4d; } .bcb1 { fill: #ff0000; } .bcb2 { fill: #00ff00; }
      .bcb3 { fill: #ffff00; } .bcb4 { fill: #5c5cff; } .bcb5 { fill: #ff00ff; }
      .bcb6 { fill: #00ffff; } .bcb7 { fill: #ffffff; }
      .bold { font-weight: bold; }
      .italic { font-style: italic; }
      .dim { opacity: 0.5; }
      text { dominant-baseline: text-before-edge; white-space: pre; }
    </style>
  </defs>

  <rect id="bg" class="bg" width="100%" height="100%" />
  <g id="bg-layer"></g>
  <g id="text-layer" class="fg"></g>
  <rect id="cursor" width="8" height="17" fill="#c5c5c5" opacity="0.7">
    <animate attributeName="opacity" values="0.7;0;0.7" dur="1s" repeatCount="indefinite" />
  </rect>

  <!-- Error overlay (hidden by default) -->
  <g id="error-overlay" visibility="hidden">
    <rect width="100%" height="100%" fill="#1c1c1c" opacity="0.85" />
    <text id="error-msg" x="50%" y="50%" text-anchor="middle" class="fg" font-size="16">
      Connection lost — retrying
    </text>
  </g>

  <script type="text/javascript">
  <![CDATA[
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const CELL_W = 8;
    const CELL_H = 17;

    // Parse URL params from the SVG's URL
    const svgUrl = document.URL || window.location.href;
    const urlParams = new URL(svgUrl).searchParams;
    const SESSION = urlParams.get('session');
    const PANE = urlParams.get('pane') || '%0';
    const SERVER = urlParams.get('server') || '';

    let columns = 0;
    let rows = 0;
    let prevState = [];
    let pollTimer = null;
    let pollInterval = 150;
    let initialized = false;

    const bgLayer = document.getElementById('bg-layer');
    const textLayer = document.getElementById('text-layer');
    const cursor = document.getElementById('cursor');
    const errorOverlay = document.getElementById('error-overlay');
    const root = document.getElementById('root');

    function apiUrl(path) {
      return SERVER + path;
    }

    function createTextElements(w, h) {
      columns = w;
      rows = h;
      root.setAttribute('viewBox', `0 0 ${w * CELL_W} ${h * CELL_H}`);
      textLayer.innerHTML = '';
      for (let r = 0; r < h; r++) {
        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('id', `r${r}`);
        text.setAttribute('y', String(r * CELL_H));
        text.setAttribute('textLength', String(w * CELL_W));
        text.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
        textLayer.appendChild(text);
      }
      prevState = new Array(h).fill(null);
    }

    function updateLine(index, spans) {
      const text = document.getElementById(`r${index}`);
      if (!text) return;
      // Clear existing content
      while (text.firstChild) text.removeChild(text.firstChild);

      for (const span of spans) {
        const tspan = document.createElementNS(SVG_NS, 'tspan');
        tspan.textContent = span.text;
        const classes = [];
        if (span.cls) classes.push(span.cls);
        if (span.bold) classes.push('bold');
        if (span.italic) classes.push('italic');
        if (span.dim) classes.push('dim');
        if (classes.length) tspan.setAttribute('class', classes.join(' '));
        if (span.fg) tspan.setAttribute('fill', span.fg);
        if (span.underline) tspan.setAttribute('text-decoration', 'underline');
        if (span.strikethrough) tspan.setAttribute('text-decoration', 'line-through');
        text.appendChild(tspan);
      }
    }

    function rebuildBgLayer(lines) {
      while (bgLayer.firstChild) bgLayer.removeChild(bgLayer.firstChild);
      for (let r = 0; r < lines.length; r++) {
        let x = 0;
        for (const span of lines[r].spans) {
          const hasBg = span.bg || span.bgCls;
          if (hasBg) {
            const rect = document.createElementNS(SVG_NS, 'rect');
            rect.setAttribute('x', String(x * CELL_W));
            rect.setAttribute('y', String(r * CELL_H));
            rect.setAttribute('width', String(span.text.length * CELL_W));
            rect.setAttribute('height', String(CELL_H));
            if (span.bgCls) rect.setAttribute('class', span.bgCls);
            else rect.setAttribute('fill', span.bg);
            bgLayer.appendChild(rect);
          }
          x += span.text.length;
        }
      }
    }

    function showError(msg) {
      document.getElementById('error-msg').textContent = msg || 'Connection lost — retrying';
      errorOverlay.setAttribute('visibility', 'visible');
    }

    function hideError() {
      errorOverlay.setAttribute('visibility', 'hidden');
    }

    async function poll() {
      try {
        let url = apiUrl(`/api/pane?pane=${encodeURIComponent(PANE)}`);
        if (SESSION) url += `&session=${encodeURIComponent(SESSION)}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (!initialized || data.width !== columns || data.height !== rows) {
          createTextElements(data.width, data.height);
          initialized = true;
        }

        let anyChanged = false;
        for (let i = 0; i < data.lines.length; i++) {
          const newKey = JSON.stringify(data.lines[i].spans);
          if (newKey !== prevState[i]) {
            updateLine(i, data.lines[i].spans);
            prevState[i] = newKey;
            anyChanged = true;
          }
        }

        if (anyChanged) rebuildBgLayer(data.lines);

        // Update cursor
        cursor.setAttribute('x', String(data.cursor.x * CELL_W));
        cursor.setAttribute('y', String(data.cursor.y * CELL_H));

        hideError();
        schedulePoll(pollInterval);
      } catch (err) {
        showError();
        schedulePoll(2000);
      }
    }

    function schedulePoll(ms) {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, ms);
    }

    function stopPolling() {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    }

    function startPolling(ms) {
      pollInterval = ms;
      if (!pollTimer) poll();
    }

    // Start immediately
    poll();
  ]]>
  </script>
</svg>
```

- [ ] **Step 2: Start server and test in curl**

Run: `cd /srv/svg-terminal && node server.mjs &`
Run: `curl -s http://localhost:3200/terminal.svg | head -5`

Expected: SVG content returned

Run: `curl -s 'http://localhost:3200/api/sessions' | python3 -m json.tool`

Expected: JSON array of tmux sessions

Run: Pick a session name from the output and test:
`curl -s 'http://localhost:3200/api/pane?session=SESSION_NAME&pane=%0' | python3 -m json.tool | head -20`

Expected: JSON with width, height, cursor, lines array

Then kill the background server: `kill %1`

- [ ] **Step 3: Commit**

```bash
git add terminal.svg
git commit -m "feat: add SVG viewer with poll loop, line diffing, cursor, error overlay"
```

---

### Task 5: Manual Browser Test

This task validates the full Phase 1 stack end-to-end.

- [ ] **Step 1: Start the server**

Run: `cd /srv/svg-terminal && node server.mjs`

- [ ] **Step 2: Open in browser**

Open `http://<server-ip>:3200/terminal.svg?session=cp-greg_session_001` in Chrome.

Verify:
- Terminal content visible as SVG text
- Text is crisp vector (zoom to 500% — no pixelation)
- Content updates when the tmux session changes
- Colors render correctly
- Cursor blinks at the correct position

- [ ] **Step 3: Test input validation**

Open `http://<server-ip>:3200/api/pane?session=foo;rm%20-rf` in Chrome.

Expected: `{"error":"Invalid session or pane parameter"}`

- [ ] **Step 4: Commit any fixes from manual testing**

```bash
git add -A
git commit -m "fix: adjustments from manual browser testing"
```

---

## Phase 2: Visibility-Aware Polling

### Task 6: Add IntersectionObserver and Tier Measurement

**Files:**
- Modify: `/srv/svg-terminal/terminal.svg` (add to `<script>`)

- [ ] **Step 1: Add visibility tier logic to terminal.svg**

Add the following to the `<script>` section, before the final `poll()` call:

```js
function measureTier() {
  const el = document.getElementById('r0');
  if (!el) return 150;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0) return 150; // not rendered yet
  const charWidth = rect.width / columns;
  const charHeight = rect.height;
  if (charWidth >= 4 && charHeight >= 6) return 150;
  return 2000;
}

// IntersectionObserver for offscreen detection
if (typeof IntersectionObserver !== 'undefined') {
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) {
        stopPolling();
      } else {
        startPolling(measureTier());
      }
    }
  }, { threshold: 0 });
  observer.observe(document.documentElement);
}

// Recheck tier on resize (debounced)
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (pollTimer) {
      const tier = measureTier();
      if (tier !== pollInterval) {
        pollInterval = tier;
      }
    }
  }, 200);
});
```

Also update the initial `poll()` call at the bottom to use `startPolling`:

Replace: `poll();`
With: `startPolling(150);`

- [ ] **Step 2: Test with an HTML wrapper to verify visibility behavior**

Create a temporary test file `/srv/svg-terminal/test-visibility.html`:

```html
<!DOCTYPE html>
<html>
<head><title>Visibility Test</title></head>
<body style="background:#0a0a0a">
  <div style="height:200vh">
    <h1 style="color:white">Scroll down to find the terminal</h1>
  </div>
  <object data="/terminal.svg?session=SESSION_NAME" type="image/svg+xml" width="800" height="400"></object>
  <div style="height:200vh"></div>
</body>
</html>
```

Open in Chrome, check Network inspector:
- When terminal is offscreen: no `/api/pane` requests
- Scroll into view: requests resume
- Zoom out (Ctrl-minus) until text is tiny: requests slow to ~2s interval

- [ ] **Step 3: Commit**

```bash
git add terminal.svg
git commit -m "feat: add visibility-aware polling with IntersectionObserver and cell size tiers"
```

Clean up test file:
```bash
rm test-visibility.html
```

---

## Phase 3: Multi-Session Dashboard

### Task 7: `/api/sessions` Endpoint (already built in Task 3)

The `/api/sessions` endpoint was implemented in Task 3. Verify it works:

- [ ] **Step 1: Verify sessions endpoint**

Run: `curl -s http://localhost:3200/api/sessions | python3 -m json.tool`

Expected: JSON array with all tmux sessions. Already done — move on.

---

### Task 8: Dashboard HTML

**Files:**
- Modify: `/srv/svg-terminal/index.html` (replace placeholder)

- [ ] **Step 1: Write the full index.html**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>svg-terminal</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0a0a;
      font-family: 'DejaVu Sans Mono', 'Fira Code', Consolas, monospace;
      padding: 16px;
    }
    h1 {
      color: #666;
      font-size: 14px;
      font-weight: normal;
      margin-bottom: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
      gap: 12px;
    }
    .terminal-card {
      background: #1c1c1c;
      border-radius: 6px;
      overflow: hidden;
      border: 2px solid transparent;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .terminal-card:hover {
      border-color: #333;
    }
    .terminal-card.selected {
      border-color: #5c5cff;
    }
    .terminal-card header {
      padding: 6px 12px;
      color: #888;
      font-size: 12px;
      border-bottom: 1px solid #333;
      display: flex;
      justify-content: space-between;
      align-items: center;
      user-select: none;
    }
    .terminal-card header .session-name {
      color: #aaa;
    }
    .terminal-card header .status {
      color: #555;
      font-size: 10px;
    }
    .terminal-card object {
      width: 100%;
      display: block;
      pointer-events: none; /* clicks go to card, not SVG */
    }
  </style>
</head>
<body>
  <h1>svg-terminal</h1>
  <div class="grid" id="grid"></div>

  <script>
    const grid = document.getElementById('grid');
    const cards = new Map(); // session name → card element
    let selectedSession = null;

    function createCard(session) {
      const card = document.createElement('div');
      card.className = 'terminal-card';
      card.dataset.session = session.name;

      const hdr = document.createElement('header');
      const nameEl = document.createElement('span');
      nameEl.className = 'session-name';
      nameEl.textContent = session.name;
      const statusEl = document.createElement('span');
      statusEl.className = 'status';
      statusEl.textContent = `${session.windows} window${session.windows !== 1 ? 's' : ''}`;
      hdr.appendChild(nameEl);
      hdr.appendChild(statusEl);
      card.appendChild(hdr);

      const obj = document.createElement('object');
      obj.type = 'image/svg+xml';
      obj.data = `/terminal.svg?session=${encodeURIComponent(session.name)}`;
      card.appendChild(obj);

      card.addEventListener('click', () => selectCard(session.name));

      grid.appendChild(card);
      cards.set(session.name, card);
    }

    function removeCard(name) {
      const card = cards.get(name);
      if (card) {
        card.remove();
        cards.delete(name);
        if (selectedSession === name) selectedSession = null;
      }
    }

    function selectCard(name) {
      // Deselect previous
      if (selectedSession) {
        const prev = cards.get(selectedSession);
        if (prev) prev.classList.remove('selected');
      }
      // Select new (or deselect if clicking same)
      if (selectedSession === name) {
        selectedSession = null;
      } else {
        selectedSession = name;
        const card = cards.get(name);
        if (card) card.classList.add('selected');
      }
    }

    async function refreshSessions() {
      try {
        const res = await fetch('/api/sessions');
        if (!res.ok) return;
        const sessions = await res.json();
        const currentNames = new Set(sessions.map(s => s.name));
        const existingNames = new Set(cards.keys());

        // Add new sessions
        for (const session of sessions) {
          if (!existingNames.has(session.name)) {
            createCard(session);
          }
        }

        // Remove dead sessions
        for (const name of existingNames) {
          if (!currentNames.has(name)) {
            removeCard(name);
          }
        }
      } catch (e) {
        // Server unreachable — leave cards as-is
      }
    }

    // Initial load
    refreshSessions();

    // Poll for session changes every 5 seconds
    setInterval(refreshSessions, 5000);

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const names = [...cards.keys()];
        if (names.length === 0) return;
        const idx = selectedSession ? names.indexOf(selectedSession) : -1;
        const next = e.shiftKey
          ? (idx <= 0 ? names.length - 1 : idx - 1)
          : (idx + 1) % names.length;
        selectCard(names[next]);
      }
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Test dashboard**

Run: `cd /srv/svg-terminal && node server.mjs`

Open `http://<server-ip>:3200/` in Chrome.

Verify:
- Grid shows all tmux sessions
- Each card renders live terminal content
- Click a card — blue border appears (selected)
- Click another — selection moves
- Tab key cycles through cards
- Shift+Tab cycles backwards

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add multi-session dashboard with auto-discovery and selection state"
```

---

### Task 9: Session Discovery Refresh

- [ ] **Step 1: Test auto-discovery**

With the server running, create a new tmux session:
```bash
tmux new-session -d -s test-auto-discover
```

Wait 5 seconds, verify it appears in the dashboard.

Then remove it:
```bash
tmux kill-session -t test-auto-discover
```

Wait 5 seconds, verify it disappears from the dashboard.

- [ ] **Step 2: Fix any issues found and commit**

```bash
git add -A
git commit -m "fix: session discovery adjustments from testing"
```

---

## Phase 4: Input

### Task 10: `POST /api/input` Endpoint

**Files:**
- Modify: `/srv/svg-terminal/server.mjs`
- Modify: `/srv/svg-terminal/test-server.mjs`

- [ ] **Step 1: Add input endpoint tests**

Add to `test-server.mjs`:

```js
describe('Input API', () => {
  it('rejects invalid session in input', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: 'foo;rm -rf', pane: '%0', keys: 'test' })
    });
    assert.equal(res.status, 400);
  });

  it('rejects non-POST methods', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/input`);
    assert.equal(res.status, 404);
  });

  it('sends keys to a real tmux session', async () => {
    // Create a temp session for this test
    const { execSync } = await import('node:child_process');
    execSync('tmux new-session -d -s svg-test-input');
    try {
      const res = await fetch(`http://localhost:${PORT}/api/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: 'svg-test-input', pane: '%0', keys: 'echo hello-from-test' })
      });
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.ok, true);
    } finally {
      execSync('tmux kill-session -t svg-test-input');
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/svg-terminal && node --test test-server.mjs`

Expected: Input tests fail (endpoint not found)

- [ ] **Step 3: Add input handler to server.mjs**

Add this function to `server.mjs`:

```js
function handleInput(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const { session, pane, keys } = JSON.parse(body);
      if (!session || !validate(session) || !validate(pane || '%0')) {
        return json(res, 400, { error: 'Invalid session or pane parameter' });
      }
      if (typeof keys !== 'string' || keys.length === 0) {
        return json(res, 400, { error: 'Invalid keys parameter' });
      }

      const target = `${session}:${pane || '%0'}`;

      // Send literal characters with -l flag
      execFileSync('tmux', ['send-keys', '-t', target, '-l', keys]);

      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: `input error: ${err.message}` });
    }
  });
}
```

Add to the router in the `createServer` callback:

```js
} else if (req.method === 'POST' && path === '/api/input') {
  handleInput(req, res);
}
```

- [ ] **Step 4: Run tests**

Run: `cd /srv/svg-terminal && node --test test-server.mjs`

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server.mjs test-server.mjs
git commit -m "feat: add POST /api/input endpoint for sending keystrokes to tmux"
```

---

### Task 11: Input Box in Dashboard

**Files:**
- Modify: `/srv/svg-terminal/index.html`

- [ ] **Step 1: Add input bar CSS**

Add to the `<style>` section of `index.html`:

```css
.input-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #111;
  border-top: 1px solid #333;
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.input-bar .target {
  color: #5c5cff;
  font-size: 12px;
  white-space: nowrap;
}
.input-bar .target.none {
  color: #555;
}
.input-bar input {
  flex: 1;
  background: #1c1c1c;
  border: 1px solid #333;
  border-radius: 4px;
  color: #c5c5c5;
  font-family: inherit;
  font-size: 14px;
  padding: 6px 10px;
  outline: none;
}
.input-bar input:focus {
  border-color: #5c5cff;
}
.input-bar input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
body {
  padding-bottom: 56px; /* space for fixed input bar */
}
```

- [ ] **Step 2: Add input bar HTML**

Add before the closing `</body>` tag (before `<script>`):

```html
<div class="input-bar">
  <span class="target none" id="input-target">No terminal selected</span>
  <input type="text" id="input-box" placeholder="Type here to send to selected terminal..." disabled>
</div>
```

- [ ] **Step 3: Add input bar JavaScript**

Add to the `<script>` section:

```js
const inputBox = document.getElementById('input-box');
const inputTarget = document.getElementById('input-target');

function updateInputBar() {
  if (selectedSession) {
    inputTarget.textContent = selectedSession;
    inputTarget.className = 'target';
    inputBox.disabled = false;
    inputBox.placeholder = 'Type here to send to selected terminal...';
  } else {
    inputTarget.textContent = 'No terminal selected';
    inputTarget.className = 'target none';
    inputBox.disabled = true;
    inputBox.placeholder = 'Select a terminal first...';
  }
}
```

Update the `selectCard` function to call `updateInputBar()` at the end.

Add keydown handler for the input box:

```js
inputBox.addEventListener('keydown', async (e) => {
  if (!selectedSession) return;

  if (e.key === 'Enter') {
    e.preventDefault();
    const text = inputBox.value;
    if (text) {
      await sendKeys(selectedSession, text);
      inputBox.value = '';
    }
    // Send Enter key
    await sendSpecialKey(selectedSession, 'Enter');
  } else if (e.key === 'Tab') {
    // Only intercept Tab if not using it for card navigation
    // Tab in the input box sends Tab to terminal
    if (document.activeElement === inputBox) {
      e.preventDefault();
      await sendSpecialKey(selectedSession, 'Tab');
    }
  }
});

// Ctrl-C handler
inputBox.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'c' && selectedSession) {
    e.preventDefault();
    sendSpecialKey(selectedSession, 'C-c');
  }
});

async function sendKeys(session, keys) {
  try {
    await fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, pane: '%0', keys })
    });
  } catch (e) {
    // Silently fail — the terminal will show the error
  }
}

async function sendSpecialKey(session, key) {
  // Special keys are sent without -l flag
  // We use a separate endpoint param to distinguish
  try {
    await fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, pane: '%0', specialKey: key })
    });
  } catch (e) {
    // Silently fail
  }
}
```

- [ ] **Step 4: Update server.mjs to handle specialKey**

Update `handleInput` in `server.mjs`:

```js
function handleInput(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const { session, pane, keys, specialKey } = JSON.parse(body);
      if (!session || !validate(session) || !validate(pane || '%0')) {
        return json(res, 400, { error: 'Invalid session or pane parameter' });
      }

      const target = `${session}:${pane || '%0'}`;

      if (specialKey) {
        // Send as tmux key name (Enter, Tab, C-c, etc.)
        const ALLOWED_KEYS = ['Enter', 'Tab', 'Escape', 'C-c', 'C-d', 'C-z', 'C-l',
          'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'BSpace', 'DC'];
        if (!ALLOWED_KEYS.includes(specialKey)) {
          return json(res, 400, { error: 'Invalid special key' });
        }
        execFileSync('tmux', ['send-keys', '-t', target, specialKey]);
      } else if (typeof keys === 'string' && keys.length > 0) {
        // Send literal characters
        execFileSync('tmux', ['send-keys', '-t', target, '-l', keys]);
      } else {
        return json(res, 400, { error: 'Must provide keys or specialKey' });
      }

      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: `input error: ${err.message}` });
    }
  });
}
```

- [ ] **Step 5: Run all tests**

Run: `cd /srv/svg-terminal && node --test test-server.mjs`

Expected: All tests PASS

- [ ] **Step 6: Manual browser test**

Open `http://<server-ip>:3200/` in Chrome.

Verify:
- Input bar at bottom shows "No terminal selected" when nothing selected
- Click a terminal card — input bar shows session name, input box enables
- Type text and press Enter — text appears in the tmux session
- Ctrl-C sends interrupt to the session

- [ ] **Step 7: Commit**

```bash
git add index.html server.mjs
git commit -m "feat: add input box to dashboard for sending keystrokes to selected terminal"
```

---

## Final Task: Push and Tag

- [ ] **Step 1: Run all tests one final time**

```bash
cd /srv/svg-terminal && node --test test-sgr-parser.mjs && node --test test-server.mjs
```

Expected: All tests PASS

- [ ] **Step 2: Push to dev**

```bash
git push origin dev
```

- [ ] **Step 3: Tag the POC**

```bash
git tag v0.1.0
git push origin v0.1.0
```
