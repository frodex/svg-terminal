# Viewer Compliance & URL Hotlinks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make svg-terminal a fully compliant tmux viewer — handle all escape sequences from `capture-pane -e`, enrich the API with tmux metadata, and enable clickable URL hotlinks.

**Architecture:** Parser state machine handles CSI (SGR), OSC (hyperlinks), and strips unknown escapes in a single pass. Plain-text URL detection runs as a post-pass. Server adds tmux metadata fields. Dashboard detects URL clicks via `screenToCell` + span lookup. SVG renders underlines from `span.url` without regex.

**Tech Stack:** Node.js (server), vanilla JS (client), SVG, WebSocket

---

### Task 1: New SGR Codes in Parser

**Files:**
- Modify: `sgr-parser.mjs` (functions `defaultStyle`, `stylesEqual`, `applyParams`)
- Test: `test-sgr-parser.mjs`

- [ ] **Step 1: Write failing tests for new SGR codes**

Add to `test-sgr-parser.mjs`:

```js
// Update the span() helper to include new default fields
function span(overrides) {
  return {
    text: '',
    cls: null,
    fg: null,
    bg: null,
    bgCls: null,
    bold: false,
    italic: false,
    underline: false,
    dim: false,
    strikethrough: false,
    reverse: false,
    hidden: false,
    overline: false,
    underlineColor: null,
    url: null,
    ...overrides,
  };
}

test('SGR 7 reverse video', () => {
  const result = parseLine('\x1b[7mREVERSE\x1b[27m normal');
  assert.deepEqual(result, [
    span({ text: 'REVERSE', reverse: true }),
    span({ text: ' normal' }),
  ]);
});

test('SGR 8 hidden text', () => {
  const result = parseLine('\x1b[8mHIDDEN\x1b[28m visible');
  assert.deepEqual(result, [
    span({ text: 'HIDDEN', hidden: true }),
    span({ text: ' visible' }),
  ]);
});

test('SGR 53 overline', () => {
  const result = parseLine('\x1b[53mOVER\x1b[55m normal');
  assert.deepEqual(result, [
    span({ text: 'OVER', overline: true }),
    span({ text: ' normal' }),
  ]);
});

test('SGR 58;5;N underline color 256', () => {
  const result = parseLine('\x1b[4;58;5;196mCOLORED\x1b[59;24m normal');
  assert.deepEqual(result, [
    span({ text: 'COLORED', underline: true, underlineColor: '#ff0000' }),
    span({ text: ' normal' }),
  ]);
});

test('SGR 58;2;R;G;B underline color truecolor', () => {
  const result = parseLine('\x1b[4;58;2;255;128;0mTC\x1b[59;24m normal');
  assert.deepEqual(result, [
    span({ text: 'TC', underline: true, underlineColor: '#ff8000' }),
    span({ text: ' normal' }),
  ]);
});

test('tmux colon sub-parameter for overline (5:3)', () => {
  // tmux re-encodes SGR 53 as ESC[5:3m
  const result = parseLine('\x1b[5:3mOVER\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'OVER', overline: true }),
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test-sgr-parser.mjs 2>&1 | tail -20`
Expected: 6 new tests FAIL (properties not in span output)

- [ ] **Step 3: Add new fields to defaultStyle and stylesEqual**

In `sgr-parser.mjs`, update `defaultStyle()`:

```js
function defaultStyle() {
  return {
    cls: null,
    fg: null,
    bg: null,
    bgCls: null,
    bold: false,
    italic: false,
    underline: false,
    dim: false,
    strikethrough: false,
    reverse: false,
    hidden: false,
    overline: false,
    underlineColor: null,
    url: null,
  };
}
```

Update `stylesEqual()` to compare the new fields:

```js
function stylesEqual(a, b) {
  return (
    a.cls === b.cls &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bgCls === b.bgCls &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.dim === b.dim &&
    a.strikethrough === b.strikethrough &&
    a.reverse === b.reverse &&
    a.hidden === b.hidden &&
    a.overline === b.overline &&
    a.underlineColor === b.underlineColor &&
    a.url === b.url
  );
}
```

- [ ] **Step 4: Add new SGR codes to applyParams**

In `applyParams()`, add these cases inside the `while (i < params.length)` loop, after the existing `strikethrough` case (code === 9):

```js
    } else if (code === 7) {
      next.reverse = true;
    } else if (code === 8) {
      next.hidden = true;
    } else if (code === 27) {
      next.reverse = false;
    } else if (code === 28) {
      next.hidden = false;
    } else if (code === 53) {
      next.overline = true;
    } else if (code === 55) {
      next.overline = false;
    } else if (code === 58) {
      const sub = params[i + 1];
      if (sub === 5) {
        const n = params[i + 2];
        if (n !== undefined && n >= 0 && n <= 255) {
          next.underlineColor = table[n];
          i += 2;
        }
      } else if (sub === 2) {
        const r = params[i + 2];
        const g = params[i + 3];
        const b = params[i + 4];
        if (r !== undefined && g !== undefined && b !== undefined) {
          next.underlineColor = '#' + toHex2(r) + toHex2(g) + toHex2(b);
          i += 4;
        }
      }
    } else if (code === 59) {
      next.underlineColor = null;
```

- [ ] **Step 5: Handle colon sub-parameter syntax in parseLine**

In `parseLine()`, when parsing CSI params, support both `;` and `:` as separators. Replace the param parsing line:

```js
        const rawParams = paramStr === '' ? ['0'] : paramStr.split(';');
```

With:

```js
        const rawParams = paramStr === '' ? ['0'] : paramStr.split(/[;:]/);
```

And add a special case: if params are `[5, 3]` with colon separator (tmux overline encoding), treat as SGR 53. Add to `applyParams` at the top of the loop:

```js
    // tmux encodes SGR 53 (overline) as 5:3 — two params via colon separator
    // When split on [;:], this becomes [5, 3] which looks like blink + nothing.
    // Detect and handle: if code is 5 and next param is 3, treat as overline.
    if (code === 5 && i + 1 < params.length && params[i + 1] === 3) {
      next.overline = true;
      i++; // skip the '3'
```

Place this before the existing code === 0 check, or as a new early check.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test-sgr-parser.mjs 2>&1 | tail -20`
Expected: All tests PASS (existing 22 + 6 new = 28)

- [ ] **Step 7: Commit**

```bash
git add sgr-parser.mjs test-sgr-parser.mjs
git commit -m "feat: add SGR 7/8/53/58/59 support — reverse, hidden, overline, underline color"
```

---

### Task 2: OSC 8 Hyperlink Parsing

**Files:**
- Modify: `sgr-parser.mjs` (function `parseLine`)
- Test: `test-sgr-parser.mjs`

- [ ] **Step 1: Write failing tests for OSC 8**

Add to `test-sgr-parser.mjs`:

```js
test('OSC 8 hyperlink sets span.url', () => {
  const result = parseLine('\x1b]8;;http://example.com\x1b\\Click Here\x1b]8;;\x1b\\');
  assert.deepEqual(result, [
    span({ text: 'Click Here', url: 'http://example.com' }),
  ]);
});

test('OSC 8 with styled text preserves both', () => {
  const result = parseLine('\x1b[1m\x1b]8;;http://test.com\x1b\\BOLD LINK\x1b]8;;\x1b\\\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'BOLD LINK', bold: true, url: 'http://test.com' }),
  ]);
});

test('OSC 8 with params field (ignored)', () => {
  // OSC 8 format: ESC ] 8 ; params ; URL ST — params field exists but we ignore it
  const result = parseLine('\x1b]8;id=123;http://example.com\x1b\\Link\x1b]8;;\x1b\\');
  assert.deepEqual(result, [
    span({ text: 'Link', url: 'http://example.com' }),
  ]);
});

test('unknown OSC stripped cleanly', () => {
  const result = parseLine('before\x1b]99;some data\x07after');
  assert.deepEqual(result, [
    span({ text: 'beforeafter' }),
  ]);
});

test('OSC terminated by BEL', () => {
  const result = parseLine('\x1b]8;;http://bel.com\x07Link\x1b]8;;\x07');
  assert.deepEqual(result, [
    span({ text: 'Link', url: 'http://bel.com' }),
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test-sgr-parser.mjs 2>&1 | tail -20`
Expected: 5 new tests FAIL (OSC sequences leak into text)

- [ ] **Step 3: Add OSC handling to parseLine**

In `parseLine()`, inside the main `while (i < line.length)` loop, add an OSC branch after the existing CSI branch. The current code checks for `ESC [`. Add a check for `ESC ]` before the `else` that accumulates text:

Replace the structure:

```js
    if (line[i] === '\x1b' && i + 1 < line.length && line[i + 1] === '[') {
      // ... existing CSI handling ...
    } else {
      text += line[i];
      i++;
    }
```

With:

```js
    if (line[i] === '\x1b' && i + 1 < line.length && line[i + 1] === '[') {
      // ... existing CSI handling (unchanged) ...
    } else if (line[i] === '\x1b' && i + 1 < line.length && line[i + 1] === ']') {
      // OSC sequence: ESC ] ... terminated by BEL (\x07) or ST (ESC \)
      let j = i + 2;
      while (j < line.length) {
        if (line[j] === '\x07') { j++; break; }
        if (line[j] === '\x1b' && j + 1 < line.length && line[j + 1] === '\\') { j += 2; break; }
        j++;
      }
      // Extract OSC content (between ESC ] and terminator)
      const oscContent = line.slice(i + 2, line[j - 1] === '\\' ? j - 2 : j - 1);
      // OSC 8: hyperlink — format: 8;params;URL
      if (oscContent.startsWith('8;')) {
        const firstSemi = oscContent.indexOf(';');
        const secondSemi = oscContent.indexOf(';', firstSemi + 1);
        const url = secondSemi >= 0 ? oscContent.slice(secondSemi + 1) : '';
        // Flush text before style change
        if (text.length > 0) {
          spans.push({ text, ...style });
          text = '';
        }
        const newStyle = { ...style, url: url || null };
        style = newStyle;
      }
      // All other OSC types: silently strip
      i = j;
    } else if (line[i] === '\x1b') {
      // Other escape sequences (ESC D, ESC M, etc.): skip ESC + next char
      i += 2;
    } else {
      text += line[i];
      i++;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test-sgr-parser.mjs 2>&1 | tail -20`
Expected: All tests PASS (28 + 5 = 33)

- [ ] **Step 5: Commit**

```bash
git add sgr-parser.mjs test-sgr-parser.mjs
git commit -m "feat: OSC 8 hyperlink parsing — span.url set from terminal escape sequences"
```

---

### Task 3: Plain-Text URL Fallback

**Files:**
- Modify: `sgr-parser.mjs` (new function `tagPlainUrls`, call from `parseLine`)
- Test: `test-sgr-parser.mjs`

- [ ] **Step 1: Write failing tests for plain-text URLs**

Add to `test-sgr-parser.mjs`:

```js
test('plain-text http URL tagged', () => {
  const result = parseLine('Visit http://example.com/path for info');
  assert.deepEqual(result, [
    span({ text: 'Visit ' }),
    span({ text: 'http://example.com/path', url: 'http://example.com/path' }),
    span({ text: ' for info' }),
  ]);
});

test('plain-text https URL tagged', () => {
  const result = parseLine('See https://github.com/user/repo');
  assert.deepEqual(result, [
    span({ text: 'See ' }),
    span({ text: 'https://github.com/user/repo', url: 'https://github.com/user/repo' }),
  ]);
});

test('multiple plain-text URLs on one line', () => {
  const result = parseLine('http://a.com and http://b.com');
  assert.deepEqual(result, [
    span({ text: 'http://a.com', url: 'http://a.com' }),
    span({ text: ' and ' }),
    span({ text: 'http://b.com', url: 'http://b.com' }),
  ]);
});

test('URL with SGR styling preserved', () => {
  const result = parseLine('\x1b[32mhttp://green.com\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'http://green.com', cls: 'c2', url: 'http://green.com' }),
  ]);
});

test('OSC 8 URL not double-tagged by plain-text pass', () => {
  // OSC 8 already sets url — plain-text pass should skip spans that have url
  const result = parseLine('\x1b]8;;http://osc.com\x1b\\Click\x1b]8;;\x1b\\');
  assert.deepEqual(result, [
    span({ text: 'Click', url: 'http://osc.com' }),
  ]);
});

test('URL terminated by whitespace, quotes, angle brackets', () => {
  const result = parseLine('"http://quoted.com" <http://angle.com>');
  assert.deepEqual(result, [
    span({ text: '"' }),
    span({ text: 'http://quoted.com', url: 'http://quoted.com' }),
    span({ text: '" <' }),
    span({ text: 'http://angle.com', url: 'http://angle.com' }),
    span({ text: '>' }),
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test-sgr-parser.mjs 2>&1 | tail -20`
Expected: 6 new tests FAIL

- [ ] **Step 3: Implement tagPlainUrls post-pass**

Add to `sgr-parser.mjs` before the `export function parseLine`:

```js
function tagPlainUrls(spans) {
  const result = [];
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    // Skip spans that already have a URL (from OSC 8)
    if (s.url) { result.push(s); continue; }
    const text = s.text;
    let lastEnd = 0;
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const httpIdx = text.indexOf('http://', searchFrom);
      const httpsIdx = text.indexOf('https://', searchFrom);
      let idx = -1;
      if (httpIdx >= 0 && httpsIdx >= 0) idx = Math.min(httpIdx, httpsIdx);
      else if (httpIdx >= 0) idx = httpIdx;
      else if (httpsIdx >= 0) idx = httpsIdx;
      if (idx < 0) break;
      // Walk forward to find URL end (whitespace or URL-terminating chars)
      let end = idx;
      while (end < text.length && !/[\s<>"'\])]/.test(text[end])) end++;
      // Strip trailing punctuation that's likely not part of the URL
      while (end > idx && /[.,;:!?)}\]]/.test(text[end - 1])) end--;
      const url = text.slice(idx, end);
      if (url.length > 7) { // longer than just "http://"
        // Text before the URL
        if (idx > lastEnd) {
          result.push({ ...s, text: text.slice(lastEnd, idx) });
        }
        // The URL span
        result.push({ ...s, text: url, url: url });
        lastEnd = end;
      }
      searchFrom = end;
    }
    // Remaining text after last URL
    if (lastEnd === 0) {
      result.push(s); // no URLs found, keep original
    } else if (lastEnd < text.length) {
      result.push({ ...s, text: text.slice(lastEnd) });
    }
  }
  return result;
}
```

- [ ] **Step 4: Call tagPlainUrls from parseLine**

At the end of `parseLine()`, replace:

```js
  return spans;
```

With:

```js
  return tagPlainUrls(spans);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test-sgr-parser.mjs 2>&1 | tail -20`
Expected: All tests PASS (33 + 6 = 39)

- [ ] **Step 6: Commit**

```bash
git add sgr-parser.mjs test-sgr-parser.mjs
git commit -m "feat: plain-text URL detection — http/https tagged on span.url in parser post-pass"
```

---

### Task 4: Server Metadata Expansion

**Files:**
- Modify: `server.mjs` (function `capturePane`)
- Test: `test-server.mjs`

- [ ] **Step 1: Write failing test**

Add to `test-server.mjs`:

```js
test('GET /api/pane returns metadata fields', async () => {
  // Create a test session
  execSync('tmux new-session -d -s meta-test -x 80 -y 24');
  await new Promise(r => setTimeout(r, 500));
  try {
    const res = await fetch(`http://localhost:${PORT}/api/pane?session=meta-test&pane=0`);
    const data = await res.json();
    assert.ok('path' in data, 'response has path field');
    assert.ok('command' in data, 'response has command field');
    assert.ok('pid' in data, 'response has pid field');
    assert.ok('historySize' in data, 'response has historySize field');
    assert.ok('dead' in data, 'response has dead field');
    assert.equal(typeof data.pid, 'number');
    assert.equal(typeof data.dead, 'boolean');
  } finally {
    execSync('tmux kill-session -t meta-test 2>/dev/null || true');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test-server.mjs 2>&1 | grep 'meta'`
Expected: FAIL — response doesn't have `path` field

- [ ] **Step 3: Expand capturePane format string**

In `server.mjs`, update the `capturePane` function. Change the `display-message` format string from:

```js
    '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{pane_title}',
```

To:

```js
    '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{pane_pid} #{history_size} #{pane_dead} #{pane_current_command} #{pane_current_path} #{pane_title}',
```

Update the parsing after `const metaParts`:

```js
  const width = parseInt(metaParts[0], 10);
  const height = parseInt(metaParts[1], 10);
  const cursorX = parseInt(metaParts[2], 10);
  const cursorY = parseInt(metaParts[3], 10);
  const pid = parseInt(metaParts[4], 10);
  const historySize = parseInt(metaParts[5], 10);
  const dead = metaParts[6] === '1';
  const command = metaParts[7] || '';
  const path = metaParts[8] || '';
  const title = metaParts.slice(9).join(' ');
```

Update the return:

```js
  return { width, height, cursor: { x: cursorX, y: cursorY }, title,
           path, command, pid, historySize, dead, lines };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test-server.mjs 2>&1 | tail -10`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server.mjs test-server.mjs
git commit -m "feat: server returns tmux metadata — path, command, pid, historySize, dead"
```

---

### Task 5: Simplified SVG Link Layer

**Files:**
- Modify: `terminal.svg` (function `rebuildLinkLayer`)

- [ ] **Step 1: Replace regex-based rebuildLinkLayer with span.url reader**

In `terminal.svg`, replace the `rebuildLinkLayer` function. Find:

```js
      // Detect URLs in terminal lines and create clickable link overlays
      function rebuildLinkLayer(lines) {
```

Replace the entire function with:

```js
      // Render blue underlines for spans that have url property (set by parser).
      // No regex — URLs are already tagged by the server-side parser.
      // Click handling is done by the dashboard layer, not here.
      function rebuildLinkLayer(lines) {
        while (linkLayer.firstChild) linkLayer.removeChild(linkLayer.firstChild);
        for (var row = 0; row < lines.length; row++) {
          var spans = lines[row].spans;
          var colOffset = 0;
          for (var s = 0; s < spans.length; s++) {
            var span = spans[s];
            if (span.url) {
              var underline = document.createElementNS(SVG_NS, 'line');
              underline.setAttribute('x1', (colOffset * CELL_W).toFixed(2));
              underline.setAttribute('y1', ((row + 1) * CELL_H - 1).toFixed(2));
              underline.setAttribute('x2', ((colOffset + span.text.length) * CELL_W).toFixed(2));
              underline.setAttribute('y2', ((row + 1) * CELL_H - 1).toFixed(2));
              underline.setAttribute('stroke', '#5c8fff');
              underline.setAttribute('stroke-width', '1');
              underline.setAttribute('opacity', '0.6');
              linkLayer.appendChild(underline);
            }
            colOffset += span.text.length;
          }
        }
      }
```

- [ ] **Step 2: Remove URL_RE regex constant**

Delete the line near the top of the script:

```js
      var URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
```

- [ ] **Step 3: Verify server serves updated SVG**

Run: `bash restart-server.sh`
Run: `curl -s http://localhost:3200/terminal.svg | grep -c 'URL_RE'`
Expected: 0 (regex removed)

- [ ] **Step 4: Commit**

```bash
git add terminal.svg
git commit -m "refactor: SVG link layer reads span.url instead of running regex"
```

---

### Task 6: Dashboard URL Click Handler

**Files:**
- Modify: `dashboard.mjs` (store full span data, add URL click in `onSceneClick`)

- [ ] **Step 1: Store full span data in screenLines**

In `dashboard.mjs`, find the WebSocket `onmessage` handler (around line 1621). Change `screenLines` to store full span objects instead of joined text strings.

Replace:

```js
      if (msg.type === 'screen' && msg.lines) {
        t.screenLines = msg.lines.map(function(l) {
          return l.spans.map(function(s) { return s.text; }).join('');
        });
```

With:

```js
      if (msg.type === 'screen' && msg.lines) {
        t.screenLines = msg.lines.map(function(l) {
          return { text: l.spans.map(function(s) { return s.text; }).join(''), spans: l.spans };
        });
```

Replace the delta handler:

```js
          t.screenLines[parseInt(idx)] = spans.map(function(s) { return s.text; }).join('');
```

With:

```js
          t.screenLines[parseInt(idx)] = { text: spans.map(function(s) { return s.text; }).join(''), spans: spans };
```

Do the same for the second WebSocket handler (around line 1709) — search for the duplicate pattern and apply the same changes.

- [ ] **Step 2: Update getSelectedText to use new screenLines shape**

Find `getSelectedText` (around line 2462). It currently reads `t.screenLines[row]` as a string. Update:

```js
    const line = t.screenLines[row] || '';
```

To:

```js
    const lineObj = t.screenLines[row];
    const line = (typeof lineObj === 'string') ? lineObj : (lineObj ? lineObj.text : '');
```

- [ ] **Step 3: Add getUrlAtCell helper function**

Add before `onSceneClick`:

```js
// Find URL at a specific row/col by walking the span list
function getUrlAtCell(t, row, col) {
  if (!t.screenLines || !t.screenLines[row]) return null;
  const lineObj = t.screenLines[row];
  if (!lineObj.spans) return null;
  let offset = 0;
  for (let i = 0; i < lineObj.spans.length; i++) {
    const s = lineObj.spans[i];
    if (col >= offset && col < offset + s.text.length) {
      return s.url || null;
    }
    offset += s.text.length;
  }
  return null;
}
```

- [ ] **Step 4: Add URL click detection in onSceneClick**

In `onSceneClick`, after the line `if (clicked) {`, add a URL check before the existing focus logic:

```js
  if (clicked) {
    // Check for URL click before handling focus
    if (focusedSessions.has(clicked)) {
      const t = terminals.get(clicked);
      if (t) {
        const cell = screenToCell(e, t);
        if (cell) {
          const url = getUrlAtCell(t, cell.row, cell.col);
          if (url) {
            if (e.altKey || altHeld) {
              addBrowserCard(url);
            } else {
              window.open(url, '_blank');
            }
            return;
          }
        }
      }
      // No URL — switch input to this terminal
      setActiveInput(clicked);
    } else {
```

Note: the existing `if (focusedSessions.has(clicked))` block that calls `setActiveInput` needs to be inside an `else` after the URL check. Restructure:

```js
  if (clicked) {
    if (focusedSessions.has(clicked)) {
      // Check for URL click on focused terminal
      const t = terminals.get(clicked);
      if (t) {
        const cell = screenToCell(e, t);
        if (cell) {
          const url = getUrlAtCell(t, cell.row, cell.col);
          if (url) {
            if (e.altKey || altHeld) {
              addBrowserCard(url);
            } else {
              window.open(url, '_blank');
            }
            return;
          }
        }
      }
      setActiveInput(clicked);
    } else {
      focusTerminal(clicked);
    }
  }
```

- [ ] **Step 5: Re-enable alt+click in onSceneClick for URLs**

The existing guard at the top of `onSceneClick` returns early on `altHeld || e.altKey`. URL alt+click needs to get past this. Update:

```js
  if (suppressNextClick || ctrlHeld || e.ctrlKey || altHeld || e.altKey) {
```

To:

```js
  if (suppressNextClick || ctrlHeld || e.ctrlKey) {
```

Remove `altHeld || e.altKey` from this guard. Alt+click will now fall through to the URL check. If no URL is found, the function continues to the existing behavior.

- [ ] **Step 6: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: clickable URL hotlinks — click opens tab, alt+click opens browser card"
```

---

### Task 7: E2E Test — URL Hotlinks

**Files:**
- Modify: `test-dashboard-e2e.mjs`

- [ ] **Step 1: Add URL detection E2E test**

Add to `test-dashboard-e2e.mjs`:

```js
test('URL hotlink — span.url in API response', async () => {
  execSync('tmux new-session -d -s url-e2e -x 80 -y 24');
  execSync("tmux send-keys -t url-e2e \"printf '\\\\e]8;;http://example.com\\\\e\\\\\\\\Click Here\\\\e]8;;\\\\e\\\\\\\\\\\\n'\" Enter");
  await new Promise(r => setTimeout(r, 1000));
  try {
    const res = await fetch(`http://localhost:${PORT}/api/pane?session=url-e2e&pane=0`);
    const data = await res.json();
    let foundUrl = false;
    for (const line of data.lines) {
      for (const span of line.spans) {
        if (span.url === 'http://example.com') {
          foundUrl = true;
          assert.equal(span.text, 'Click Here');
        }
      }
    }
    assert.ok(foundUrl, 'OSC 8 URL found in API response');
  } finally {
    execSync('tmux kill-session -t url-e2e 2>/dev/null || true');
  }
});

test('plain-text URL tagged in API response', async () => {
  execSync('tmux new-session -d -s url-plain -x 80 -y 24');
  execSync("tmux send-keys -t url-plain 'echo http://plain.example.com/test' Enter");
  await new Promise(r => setTimeout(r, 1000));
  try {
    const res = await fetch(`http://localhost:${PORT}/api/pane?session=url-plain&pane=0`);
    const data = await res.json();
    let foundUrl = false;
    for (const line of data.lines) {
      for (const span of line.spans) {
        if (span.url === 'http://plain.example.com/test') {
          foundUrl = true;
        }
      }
    }
    assert.ok(foundUrl, 'plain-text URL found in API response');
  } finally {
    execSync('tmux kill-session -t url-plain 2>/dev/null || true');
  }
});
```

- [ ] **Step 2: Run E2E tests**

Run: `node test-dashboard-e2e.mjs 2>&1 | tail -20`
Expected: New URL tests PASS

- [ ] **Step 3: Commit**

```bash
git add test-dashboard-e2e.mjs
git commit -m "test: E2E tests for URL hotlinks — OSC 8 and plain-text"
```

---

### Task 8: Checkerboard Alignment E2E Test

**Files:**
- Modify: `test-dashboard-e2e.mjs`

- [ ] **Step 1: Add checkerboard alignment test**

Add to `test-dashboard-e2e.mjs`:

```js
test('selection overlay aligns with checkerboard pattern', async () => {
  // Create a session with checkerboard pattern
  execSync('tmux new-session -d -s checker-test -x 80 -y 24');
  execSync("tmux send-keys -t checker-test \"python3 -c \\\"" +
    "for r in range(23):\\n" +
    "    line=''\\n" +
    "    for c in range(80):\\n" +
    "        if (r+c)%2==0: line+=chr(0x2588)\\n" +
    "        else: line+=chr(0x2500)\\n" +
    "    print(line)\\\"\" Enter");
  await new Promise(r => setTimeout(r, 1500));

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 4000));

  // Focus checker-test
  await page.evaluate(() => {
    for (const t of document.querySelectorAll('.thumbnail-item'))
      if (t.dataset.session === 'checker-test') { t.click(); return; }
  });
  await new Promise(r => setTimeout(r, 2000));

  // Drag select rows 5-15
  const objR = await page.evaluate(() => {
    const card = document.querySelector('.terminal-3d[data-session="checker-test"]');
    return card.querySelector('object').getBoundingClientRect().toJSON();
  });
  const cellH = objR.height / 24;
  await page.mouse.move(objR.left + 20, objR.top + 5.5 * cellH);
  await page.mouse.down();
  await page.mouse.move(objR.left + objR.width * 0.8, objR.top + 15.5 * cellH, { steps: 10 });
  await new Promise(r => setTimeout(r, 300));

  // Verify sel-layer exists inside SVG with correct number of rects
  const selInfo = await page.evaluate(() => {
    const card = document.querySelector('.terminal-3d[data-session="checker-test"]');
    const obj = card.querySelector('object');
    const selLayer = obj.contentDocument.getElementById('sel-layer');
    if (!selLayer) return { error: 'no sel-layer' };
    const rects = selLayer.querySelectorAll('rect');
    return { rectCount: rects.length };
  });
  assert.ok(selInfo.rectCount >= 10, 'selection created ' + selInfo.rectCount + ' rects (expected ~11)');

  await page.mouse.up();
  await browser.close();
  execSync('tmux kill-session -t checker-test 2>/dev/null || true');
});
```

- [ ] **Step 2: Run E2E tests**

Run: `node test-dashboard-e2e.mjs 2>&1 | tail -20`
Expected: Checkerboard test PASS

- [ ] **Step 3: Commit**

```bash
git add test-dashboard-e2e.mjs
git commit -m "test: checkerboard alignment E2E test for selection overlay"
```
