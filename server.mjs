// server.mjs
// HTTP server for SVG Terminal Viewer
// Zero npm dependencies — uses Node built-ins only

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { parseLine } from './sgr-parser.mjs';

// ---------------------------------------------------------------------------
// Async tmux helper
// ---------------------------------------------------------------------------

function tmuxAsync(...args) {
  return new Promise((resolve, reject) => {
    execFileCb('tmux', args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

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

async function handlePane(req, res, params) {
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
    const rawOutput = await tmuxAsync(
      'capture-pane', '-p', '-e', '-t', target
    );

    // Get dimensions, cursor position, and pane title
    const infoRaw = (await tmuxAsync(
      'display-message', '-p', '-t', target,
      '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{pane_title}'
    )).trim();

    const [widthStr, heightStr, cxStr, cyStr, ...titleParts] = infoRaw.split(' ');
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

    const paneTitle = titleParts.join(' ') || '';

    sendJson(res, 200, {
      width,
      height,
      cursor: { x: cursorX, y: cursorY },
      title: paneTitle,
      lines,
    });
  } catch (err) {
    // tmux errors (no such session, etc.)
    sendError(res, 500, `tmux error: ${err.message}`);
  }
}

const ALLOWED_SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'BSpace', 'DC', 'IC', 'Space',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PgUp', 'PgDn',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

function isAllowedKey(key) {
  return ALLOWED_SPECIAL_KEYS.has(key) || /^C-[a-z]$/.test(key);
}

async function handleInput(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendError(res, 400, 'Invalid JSON body');
    }

    const { session, pane = '0', keys, specialKey } = parsed;

    if (!validateParam(session)) {
      return sendError(res, 400, 'Invalid session parameter');
    }
    if (!validateParam(pane)) {
      return sendError(res, 400, 'Invalid pane parameter');
    }

    const target = `${session}:${pane}`;

    if (specialKey !== undefined) {
      if (!isAllowedKey(specialKey)) {
        return sendError(res, 400, `Invalid specialKey: ${specialKey}`);
      }
      try {
        await tmuxAsync('send-keys', '-t', target, specialKey);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendError(res, 500, `tmux error: ${err.message}`);
      }
    }

    if (typeof keys === 'string' && keys.length > 0) {
      try {
        await tmuxAsync('send-keys', '-t', target, '-l', keys);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendError(res, 500, `tmux error: ${err.message}`);
      }
    }

    return sendError(res, 400, 'Must provide keys or specialKey');
  });
}

async function handleSessions(req, res) {
  try {
    const raw = (await tmuxAsync(
      'list-sessions', '-F', '#{session_name} #{session_windows}'
    )).trim();

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
    if (pathname === '/terminal') {
      try {
        const content = readFileSync(staticPath('terminal.html'));
        setCors(res);
        res.setHeader('Content-Type', 'text/html');
        res.writeHead(200);
        res.end(content);
      } catch (err) {
        sendError(res, 500, 'Failed to read terminal.html');
      }
      return;
    }
    if (pathname === '/api/pane') {
      handlePane(req, res, url.searchParams).catch(err => sendError(res, 500, err.message));
      return;
    }
    if (pathname === '/api/sessions') {
      handleSessions(req, res).catch(err => sendError(res, 500, err.message));
      return;
    }
    if (pathname === '/font-test.html') {
      try {
        const content = readFileSync(staticPath('font-test.html'));
        setCors(res);
        res.setHeader('Content-Type', 'text/html');
        res.writeHead(200);
        res.end(content);
      } catch (err) {
        sendError(res, 500, 'Failed to read font-test.html');
      }
      return;
    }
    if (pathname === '/dashboard.css') {
      try {
        const content = readFileSync(staticPath('dashboard.css'));
        setCors(res);
        res.setHeader('Content-Type', 'text/css');
        res.writeHead(200);
        res.end(content);
      } catch (err) {
        sendError(res, 500, 'Failed to read dashboard.css');
      }
      return;
    }
    if (pathname === '/dashboard.mjs') {
      try {
        const content = readFileSync(staticPath('dashboard.mjs'));
        setCors(res);
        res.setHeader('Content-Type', 'application/javascript');
        res.writeHead(200);
        res.end(content);
      } catch (err) {
        sendError(res, 500, 'Failed to read dashboard.mjs');
      }
      return;
    }
    if (pathname === '/polyhedra.mjs') {
      try {
        const content = readFileSync(staticPath('polyhedra.mjs'));
        setCors(res);
        res.setHeader('Content-Type', 'application/javascript');
        res.writeHead(200);
        res.end(content);
      } catch (err) {
        sendError(res, 500, 'Failed to read polyhedra.mjs');
      }
      return;
    }
  }

  if (req.method === 'POST' && pathname === '/api/input') {
    handleInput(req, res).catch(err => sendError(res, 500, err.message));
    return;
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
