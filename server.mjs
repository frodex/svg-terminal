// server.mjs
// HTTP server for SVG Terminal Viewer
// Zero npm dependencies — uses Node built-ins only

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseLine } from './sgr-parser.mjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let port = Number(process.env.PORT) || 3200;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = Number(args[i + 1]);
    break;
  }
}

// ---------------------------------------------------------------------------
// Static file helpers
// ---------------------------------------------------------------------------

function staticPath(filename) {
  return new URL(filename, import.meta.url).pathname;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SAFE_PARAM = /^[a-zA-Z0-9_:%-]+$/;

function validateParam(value) {
  return typeof value === 'string' && SAFE_PARAM.test(value);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
}

function sendJson(res, status, data) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleRoot(req, res) {
  try {
    const content = readFileSync(staticPath('index.html'));
    setCors(res);
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(content);
  } catch (err) {
    sendError(res, 500, 'Failed to read index.html');
  }
}

function handleSvg(req, res) {
  try {
    const content = readFileSync(staticPath('terminal.svg'));
    setCors(res);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.writeHead(200);
    res.end(content);
  } catch (err) {
    sendError(res, 500, 'Failed to read terminal.svg');
  }
}

function handlePane(req, res, params) {
  const session = params.get('session');
  const pane = params.get('pane') ?? '0';

  if (!validateParam(session)) {
    return sendError(res, 400, 'Invalid session parameter');
  }
  if (!validateParam(pane)) {
    return sendError(res, 400, 'Invalid pane parameter');
  }

  const target = `${session}:${pane}`;

  try {
    // Capture pane output
    const rawOutput = execFileSync(
      'tmux',
      ['capture-pane', '-p', '-e', '-t', target],
      { encoding: 'utf8' }
    );

    // Get dimensions and cursor position
    const infoRaw = execFileSync(
      'tmux',
      ['display-message', '-p', '-t', target,
       '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y}'],
      { encoding: 'utf8' }
    ).trim();

    const [widthStr, heightStr, cxStr, cyStr] = infoRaw.split(' ');
    const width = parseInt(widthStr, 10);
    const height = parseInt(heightStr, 10);
    const cursorX = parseInt(cxStr, 10);
    const cursorY = parseInt(cyStr, 10);

    // Split by newline; remove trailing empty element from final \n
    const rawLines = rawOutput.split('\n');
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop();
    }

    const lines = rawLines.map((line) => ({ spans: parseLine(line) }));

    sendJson(res, 200, {
      width,
      height,
      cursor: { x: cursorX, y: cursorY },
      lines,
    });
  } catch (err) {
    // tmux errors (no such session, etc.)
    sendError(res, 500, `tmux error: ${err.message}`);
  }
}

function handleSessions(req, res) {
  try {
    const raw = execFileSync(
      'tmux',
      ['list-sessions', '-F', '#{session_name} #{session_windows}'],
      { encoding: 'utf8' }
    ).trim();

    const sessions = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const spaceIdx = line.lastIndexOf(' ');
        const name = line.slice(0, spaceIdx);
        const windows = parseInt(line.slice(spaceIdx + 1), 10);
        return { name, windows };
      });

    sendJson(res, 200, sessions);
  } catch (err) {
    sendError(res, 500, `tmux error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

function router(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const pathname = url.pathname;

  if (req.method === 'GET') {
    if (pathname === '/') {
      return handleRoot(req, res);
    }
    if (pathname === '/terminal.svg') {
      return handleSvg(req, res);
    }
    if (pathname === '/api/pane') {
      return handlePane(req, res, url.searchParams);
    }
    if (pathname === '/api/sessions') {
      return handleSessions(req, res);
    }
  }

  setCors(res);
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const server = http.createServer(router);
server.listen(port, () => {
  process.stderr.write(`svg-terminal server listening on port ${port}\n`);
});
