// server.mjs
// HTTP server for SVG Terminal Viewer
// Zero npm dependencies — uses Node built-ins only

import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { parseLine } from './sgr-parser.mjs';
import { WebSocketServer } from 'ws';

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

async function capturePane(session, pane) {
  const target = session + ':' + pane;
  // Atomic capture: display-message and capture-pane in a single tmux invocation
  // using '\;' separator. This eliminates the race condition where cursor position
  // and screen content get out of sync — previously two separate tmux calls meant
  // the cursor could move between them, causing the visual cursor to appear offset
  // from where input actually goes. The first line of output is metadata, the rest
  // is the captured screen.
  const combined = await tmuxAsync(
    'display-message', '-p', '-t', target,
    '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{pane_pid} #{history_size} #{pane_dead} #{pane_current_command} #{pane_current_path} #{pane_title}',
    ';', 'capture-pane', '-p', '-e', '-t', target
  );

  const allLines = combined.split('\n');
  const metaLine = allLines[0];
  const metaParts = metaLine.trim().split(' ');
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

  // Screen content starts at line 1 (after metadata line)
  const rawLines = allLines.slice(1);
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = rawLines.map((line) => ({ spans: parseLine(line) }));

  return { width, height, cursor: { x: cursorX, y: cursorY }, title,
           path, command, pid, historySize, dead, lines };
}

// Capture pane at a scroll offset (lines above the bottom).
// Uses tmux capture-pane -S/-E to grab a window of history.
async function capturePaneAt(session, pane, offset) {
  const target = session + ':' + pane;
  const metaRaw = await tmuxAsync('display-message', '-p', '-t', target,
    '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{pane_pid} #{history_size} #{pane_dead} #{pane_current_command} #{pane_current_path} #{pane_title}');

  const metaParts = metaRaw.trim().split(' ');
  const width = parseInt(metaParts[0], 10);
  const height = parseInt(metaParts[1], 10);
  const pid = parseInt(metaParts[4], 10);
  const historySize = parseInt(metaParts[5], 10);
  const dead = metaParts[6] === '1';
  const command = metaParts[7] || '';
  const path = metaParts[8] || '';
  const title = metaParts.slice(9).join(' ');

  // Capture a window of 'height' lines shifted up by 'offset' lines.
  // tmux line 0 = first visible line, negative = scrollback history.
  // offset=3 means show from line -3 to line (height-4), shifting the view up 3 lines.
  const startLine = -offset;
  const endLine = -offset + height - 1;

  const raw = await tmuxAsync('capture-pane', '-p', '-e', '-t', target,
    '-S', String(startLine), '-E', String(endLine));

  const rawLines = raw.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = rawLines.map((line) => ({ spans: parseLine(line) }));

  // Cursor not meaningful when viewing history
  return { width, height, cursor: { x: -1, y: -1 }, title,
           path, command, pid, historySize, dead, lines };
}

async function handlePane(req, res, params) {
  const session = params.get('session');
  const pane = params.get('pane') || '0';
  if (!session) return sendError(res, 400, 'Missing session parameter');
  if (!validateParam(session)) return sendError(res, 400, 'Invalid session name');
  if (!validateParam(pane)) return sendError(res, 400, 'Invalid pane identifier');
  try {
    const state = await capturePane(session, pane);
    sendJson(res, 200, state);
  } catch (err) {
    sendError(res, 500, 'tmux error: ' + err.message);
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
      'list-sessions', '-F', '#{session_name} #{session_windows} #{window_width} #{window_height}'
    )).trim();

    const sessions = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(' ');
        const height = parseInt(parts.pop(), 10);
        const width = parseInt(parts.pop(), 10);
        const windows = parseInt(parts.pop(), 10);
        const name = parts.join(' ');
        return { name, windows, cols: width, rows: height };
      });

    sendJson(res, 200, sessions);
  } catch (err) {
    sendError(res, 500, `tmux error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

// Shared scroll offset per pane — all WebSocket connections to the same pane share this.
// Without this, the dashboard's input WebSocket and the SVG's output WebSocket have
// independent scroll offsets, so scrolling via input doesn't affect what the SVG renders.
const paneScrollOffsets = new Map(); // key = "session:pane", value = number

function getScrollOffset(session, pane) {
  return paneScrollOffsets.get(session + ':' + pane) || 0;
}

function setScrollOffset(session, pane, offset) {
  const key = session + ':' + pane;
  if (offset <= 0) paneScrollOffsets.delete(key);
  else paneScrollOffsets.set(key, offset);
}

function diffState(prev, curr) {
  if (!prev) return { type: 'screen', width: curr.width, height: curr.height,
    cursor: curr.cursor, title: curr.title, lines: curr.lines };
  if (prev.width !== curr.width || prev.height !== curr.height) {
    return { type: 'screen', width: curr.width, height: curr.height,
      cursor: curr.cursor, title: curr.title, lines: curr.lines };
  }
  const changed = {};
  let anyChanged = false;
  for (let i = 0; i < curr.lines.length; i++) {
    const a = JSON.stringify(prev.lines[i]);
    const b = JSON.stringify(curr.lines[i]);
    if (a !== b) {
      changed[i] = curr.lines[i].spans;
      anyChanged = true;
    }
  }
  if (!anyChanged && prev.cursor.x === curr.cursor.x && prev.cursor.y === curr.cursor.y
      && prev.title === curr.title) {
    return null;
  }
  return { type: 'delta', cursor: curr.cursor, title: curr.title, changed };
}

async function handleTerminalWs(ws, session, pane) {
  let lastState = null;
  let pollTimer = null;

  // Capture pane at shared scroll offset and push to client
  async function captureAndPush() {
    try {
      const offset = getScrollOffset(session, pane);
      let state;
      if (offset > 0) {
        state = await capturePaneAt(session, pane, offset);
      } else {
        state = await capturePane(session, pane);
      }
      const diff = diffState(lastState, state);
      if (diff && ws.readyState === 1) {
        diff.scrollOffset = offset;
        ws.send(JSON.stringify(diff));
        lastState = state;
      }
    } catch (err) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    }
  }

  await captureAndPush();
  pollTimer = setInterval(captureAndPush, 30);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'resize') {
        const cols = Math.max(20, Math.min(500, parseInt(msg.cols) || 80));
        const rows = Math.max(5, Math.min(200, parseInt(msg.rows) || 24));
        try {
          // Use resize-window, not resize-pane. resize-pane only works within
          // the window's current size constraints. resize-window changes the
          // window dimensions which then allows the pane to fill them.
          await tmuxAsync('resize-window', '-t', session, '-x', String(cols), '-y', String(rows));
        } catch (err) {
          // resize may fail if session doesn't exist — ignore
        }
        // Force re-capture to get new dimensions
        lastState = null;
        setTimeout(captureAndPush, 10);
        return;
      }
      if (msg.type === 'input') {
        const target = session + ':' + pane;
        if (msg.scrollTo != null) {
          // Absolute scroll offset — set directly
          setScrollOffset(session, pane, Math.max(0, msg.scrollTo));
          lastState = null;
          await captureAndPush();
          return;
        } else if (msg.specialKey && isAllowedKey(msg.specialKey)) {
          // Any keystroke snaps back to live view
          setScrollOffset(session, pane, 0);
          await tmuxAsync('send-keys', '-t', target, msg.specialKey);
        } else if (msg.keys != null) {
          setScrollOffset(session, pane, 0);
          await tmuxAsync('send-keys', '-t', target, '-l', String(msg.keys));
        }
        setTimeout(captureAndPush, 5);
      }
    } catch (err) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', message: 'Input error: ' + err.message }));
      }
    }
  });

  ws.on('close', () => { clearInterval(pollTimer); setScrollOffset(session, pane, 0); });
  ws.on('error', () => { clearInterval(pollTimer); });
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
    if (pathname === '/api/layout') {
      setCors(res);
      const uid = url.searchParams.get('uid');
      if (!uid || !/^[a-zA-Z0-9_-]+$/.test(uid)) { sendError(res, 400, 'Invalid uid'); return; }
      const profileDir = staticPath('profiles');
      if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });
      const profilePath = profileDir + '/' + uid + '.json';

      if (req.method === 'GET') {
        try {
          const data = readFileSync(profilePath, 'utf8');
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(data);
        } catch {
          sendJson(res, 200, {});
        }
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            JSON.parse(body); // validate JSON
            writeFileSync(profilePath, body);
            sendJson(res, 200, { ok: true });
          } catch (err) {
            sendError(res, 400, 'Invalid JSON: ' + err.message);
          }
        });
        return;
      }
      sendError(res, 405, 'GET or POST only');
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

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ws/terminal') {
    const session = url.searchParams.get('session');
    const pane = url.searchParams.get('pane') || '0';
    if (!session || !validateParam(session) || !validateParam(pane)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleTerminalWs(ws, session, pane);
    });
  } else {
    socket.destroy();
  }
});

server.listen(port, () => {
  process.stderr.write(`svg-terminal server listening on port ${port}\n`);
});
