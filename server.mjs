// server.mjs
// HTTP server for SVG Terminal Viewer
// Zero npm dependencies — uses Node built-ins only

import http from 'node:http';
import https from 'node:https';
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
  'Enter', 'Tab', 'Escape', 'BSpace', 'DC', 'IC',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PgUp', 'PgDn',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

// Translate claude-proxy key names to tmux send-keys names for local sessions
const CP_TO_TMUX_KEYS = {
  'Backspace': 'BSpace',
  'Delete': 'DC',
  'PageUp': 'PgUp',
  'PageDown': 'PgDn',
  'Insert': 'IC',
};

function translateKeyForTmux(key) {
  return CP_TO_TMUX_KEYS[key] || key;
}

function isAllowedKey(key) {
  return ALLOWED_SPECIAL_KEYS.has(key) || Object.keys(CP_TO_TMUX_KEYS).includes(key) || /^C-[a-z]$/.test(key);
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
        await tmuxAsync('send-keys', '-t', target, translateKeyForTmux(specialKey));
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

// Claude-proxy API URL for session discovery. Sessions on custom tmux sockets
// (created by claude-proxy) are invisible to plain `tmux list-sessions`.
// We merge both sources: local tmux + claude-proxy API.
const CLAUDE_PROXY_API = 'http://127.0.0.1:3101';

async function handleSessions(req, res) {
  const seen = new Set();
  const sessions = [];

  // Source 1: local tmux (default server)
  try {
    const raw = (await tmuxAsync(
      'list-sessions', '-F', '#{session_name} #{session_windows} #{window_width} #{window_height}'
    )).trim();

    for (const line of raw.split('\n').filter(Boolean)) {
      const parts = line.split(' ');
      const height = parseInt(parts.pop(), 10);
      const width = parseInt(parts.pop(), 10);
      const windows = parseInt(parts.pop(), 10);
      const name = parts.join(' ');
      sessions.push({ name, windows, cols: width, rows: height, source: 'tmux' });
      seen.add(name);
    }
  } catch (err) {
    // tmux not running or no sessions — continue with claude-proxy source
  }

  // Source 2: claude-proxy API (sessions on custom sockets)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const cpRes = await fetch(CLAUDE_PROXY_API + '/api/sessions', { signal: controller.signal });
    clearTimeout(timeout);
    if (cpRes.ok) {
      const cpSessions = await cpRes.json();
      for (const s of cpSessions) {
        const name = s.id || s.name;
        if (!seen.has(name)) {
          sessions.push({
            name,
            windows: 1,
            cols: s.cols || 80,
            rows: s.rows || 24,
            title: s.title || name,
            source: 'claude-proxy'
          });
          seen.add(name);
        }
      }
    }
  } catch (err) {
    // claude-proxy not running or unreachable — that's fine
  }

  sendJson(res, 200, sessions);
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
      changed[i] = { spans: curr.lines[i].spans };
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
      if (msg.type === 'scroll') {
        setScrollOffset(session, pane, Math.max(0, parseInt(msg.offset) || 0));
        lastState = null;
        await captureAndPush();
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
          // Support repeat count for cursor movement (click-to-position).
          // Fires all send-keys in parallel (Promise.all) for speed — individual
          // awaits were too slow and caused dropped keystrokes.
          const repeat = Math.min(Math.max(1, parseInt(msg.repeat) || 1), 200);
          if (repeat > 1) {
            const promises = [];
            for (let i = 0; i < repeat; i++) {
              promises.push(tmuxAsync('send-keys', '-t', target, translateKeyForTmux(msg.specialKey)));
            }
            await Promise.all(promises);
          } else {
            await tmuxAsync('send-keys', '-t', target, translateKeyForTmux(msg.specialKey));
          }
        } else if (msg.keys != null) {
          setScrollOffset(session, pane, 0);
          if (msg.ctrl && msg.keys.length === 1) {
            // Ctrl combo: { keys: "c", ctrl: true } → tmux "C-c"
            await tmuxAsync('send-keys', '-t', target, 'C-' + msg.keys);
          } else {
            await tmuxAsync('send-keys', '-t', target, '-l', String(msg.keys));
          }
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
// Proxy handler — fetches external URL, strips X-Frame-Options/CSP headers
// ---------------------------------------------------------------------------

const PROXY_BLOCKED_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
]);

function handleProxy(req, res, params) {
  const targetUrl = params.get('url');
  if (!targetUrl) return sendError(res, 400, 'Missing url parameter');

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return sendError(res, 400, 'Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return sendError(res, 400, 'Only http/https URLs supported');
  }

  const client = parsed.protocol === 'https:' ? https : http;
  const opts = { timeout: 10000 };
  if (parsed.protocol === 'https:') opts.rejectUnauthorized = false;
  const proxyReq = client.get(targetUrl, opts, (proxyRes) => {
    // Follow redirects (up to 5)
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      const redirectUrl = new URL(proxyRes.headers.location, targetUrl).href;
      const redirectParams = new URLSearchParams();
      redirectParams.set('url', redirectUrl);
      return handleProxy(req, res, redirectParams);
    }

    // Copy headers, stripping frame-blocking ones
    const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (!PROXY_BLOCKED_HEADERS.has(key.toLowerCase())) {
        // Strip content-length for HTML since we inject a <base> tag
        if (key.toLowerCase() === 'content-length' && contentType.includes('text/html')) continue;
        res.setHeader(key, value);
      }
    }
    setCors(res);
    res.writeHead(proxyRes.statusCode);

    // For HTML responses, inject <base href> so relative URLs resolve to the
    // original site, not our proxy server. Without this, form submissions and
    // relative links hit localhost:3200 instead of the target domain.
    if (contentType.includes('text/html')) {
      const baseTag = '<base href="' + targetUrl.replace(/"/g, '&quot;') + '">';
      let injected = false;
      proxyRes.on('data', (chunk) => {
        if (!injected) {
          const str = chunk.toString();
          const headIdx = str.indexOf('<head');
          if (headIdx >= 0) {
            const closeIdx = str.indexOf('>', headIdx);
            if (closeIdx >= 0) {
              res.write(str.slice(0, closeIdx + 1) + baseTag + str.slice(closeIdx + 1));
              injected = true;
              return;
            }
          }
        }
        res.write(chunk);
      });
      proxyRes.on('end', () => res.end());
    } else {
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) sendError(res, 502, 'Proxy error: ' + err.message);
    else res.end();
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) sendError(res, 504, 'Proxy timeout');
    else res.end();
  });
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
    if (pathname === '/api/proxy') {
      handleProxy(req, res, url.searchParams);
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

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ws/terminal') {
    const session = url.searchParams.get('session');
    const pane = url.searchParams.get('pane') || '0';
    if (!session || !validateParam(session) || !validateParam(pane)) {
      socket.destroy();
      return;
    }

    // Check if session is in local tmux. If not, proxy to claude-proxy API.
    let isLocal = false;
    try { await tmuxAsync('has-session', '-t', session); isLocal = true; } catch (e) {}

    if (isLocal) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleTerminalWs(ws, session, pane);
      });
    } else {
      // Proxy WebSocket to claude-proxy API for sessions on custom sockets.
      const cpUrl = 'ws://127.0.0.1:3101/api/session/' + encodeURIComponent(session) + '/stream';
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        const proxyWs = new WebSocket(cpUrl);
        proxyWs.onopen = () => {
          clientWs.on('message', (data) => {
            if (proxyWs.readyState === WebSocket.OPEN) {
              proxyWs.send(typeof data === 'string' ? data : data.toString());
            }
          });
          proxyWs.onmessage = (evt) => {
            if (clientWs.readyState === 1) {
              clientWs.send(typeof evt.data === 'string' ? evt.data : evt.data.toString());
            }
          };
        };
        proxyWs.onclose = () => { try { clientWs.close(); } catch(e) {} };
        proxyWs.onerror = () => { try { clientWs.close(); } catch(e) {} };
        clientWs.on('close', () => { try { proxyWs.close(); } catch(e) {} });
        clientWs.on('error', () => { try { proxyWs.close(); } catch(e) {} });
      });
    }
  } else {
    socket.destroy();
  }
});

server.listen(port, () => {
  process.stderr.write(`svg-terminal server listening on port ${port}\n`);
});
