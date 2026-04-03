// server.mjs
// HTTP server for SVG Terminal Viewer
// Zero npm dependencies — uses Node built-ins only

import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { parseLine } from './sgr-parser.mjs';
import { WebSocketServer } from 'ws';
import { createSessionCookie, validateSessionCookie } from './session-cookie.mjs';
import { UserStore } from './user-store.mjs';
import { getAuthUrlAsync, handleCallback, getSupportedProviders } from './auth.mjs';
import { createSystemAccount, addToGroup, generateUsername, ensureCpUsersGroup } from './provisioner.mjs';

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
// Auth config
// ---------------------------------------------------------------------------

const AUTH_SECRET = process.env.AUTH_SECRET || 'dev-mode-secret-change-in-production!!';
const COOKIE_NAME = 'cp_session';
const COOKIE_MAX_AGE = 86400;
const AUTH_PROVIDERS = {
  google: process.env.GOOGLE_CLIENT_ID ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } : null,
  github: process.env.GITHUB_CLIENT_ID ? { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET } : null,
  microsoft: process.env.MICROSOFT_CLIENT_ID ? { clientId: process.env.MICROSOFT_CLIENT_ID, clientSecret: process.env.MICROSOFT_CLIENT_SECRET, tenant: process.env.MICROSOFT_TENANT } : null,
};
const AUTH_ENABLED = Object.values(AUTH_PROVIDERS).some(v => v !== null);

let userStore = null;
if (AUTH_ENABLED) {
  mkdirSync(new URL('data', import.meta.url).pathname, { recursive: true });
  const DB_PATH = process.env.USER_DB_PATH || new URL('data/users.db', import.meta.url).pathname;
  userStore = new UserStore(DB_PATH);
  try { ensureCpUsersGroup(); } catch {}
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

// DEPRECATED (PRD v0.5.0 §3.2): HTTP polling endpoint, replaced by WebSocket screen/delta via /ws/dashboard
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

// DEPRECATED (PRD v0.5.0 §3.3): HTTP input endpoint, replaced by WebSocket input via /ws/dashboard
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

// ---------------------------------------------------------------------------
// SessionWatcher — shared capture per session, broadcast to subscribers
// ---------------------------------------------------------------------------

// Focused terminals get fast capture; unfocused ones slow down to save CPU.
// Dashboard sends focus state over WS; new watchers start unfocused.
const CAPTURE_INTERVAL_FOCUSED = Number(process.env.CAPTURE_INTERVAL_FOCUSED) || 20;
const CAPTURE_INTERVAL_UNFOCUSED = Number(process.env.CAPTURE_INTERVAL_UNFOCUSED) || 500;
const sessionWatchers = new Map(); // key = "session:pane", value = watcher
const dashboardClients = new Set(); // all /ws/dashboard connections
// Reverse index: ws → Set of watcher keys (for fast unsubscribe on close)
const wsToWatcherKeys = new WeakMap();

function getOrCreateWatcher(session, pane) {
  const key = session + ':' + pane;
  if (sessionWatchers.has(key)) return sessionWatchers.get(key);

  const watcher = {
    session,
    pane,
    lastState: null,
    subscribers: new Set(),
    timer: null,
  };

  async function captureAndBroadcast() {
    if (watcher.subscribers.size === 0 || watcher._capturing) return;
    watcher._capturing = true;
    try {
      const offset = getScrollOffset(session, pane);
      let state;
      if (offset > 0) {
        state = await capturePaneAt(session, pane, offset);
      } else {
        state = await capturePane(session, pane);
      }
      const diff = diffState(watcher.lastState, state);
      if (diff) {
        diff.session = session;
        diff.pane = pane;
        diff.scrollOffset = offset;
        const json = JSON.stringify(diff);
        for (const ws of watcher.subscribers) {
          if (ws.readyState === 1) ws.send(json);
        }
        watcher.lastState = state;
      }
    } catch (err) {
      // Session may have disappeared — don't crash
    } finally {
      watcher._capturing = false;
    }
  }

  watcher._captureAndBroadcast = captureAndBroadcast;
  watcher.timer = setInterval(captureAndBroadcast, CAPTURE_INTERVAL_UNFOCUSED);
  sessionWatchers.set(key, watcher);
  return watcher;
}

function subscribeToSession(ws, session, pane) {
  const watcher = getOrCreateWatcher(session, pane);
  watcher.subscribers.add(ws);
  // Track reverse mapping
  if (!wsToWatcherKeys.has(ws)) wsToWatcherKeys.set(ws, new Set());
  wsToWatcherKeys.get(ws).add(session + ':' + pane);
}

function unsubscribeFromAll(ws) {
  const keys = wsToWatcherKeys.get(ws);
  if (!keys) return;
  for (const key of keys) {
    const watcher = sessionWatchers.get(key);
    if (!watcher) continue;
    watcher.subscribers.delete(ws);
    if (watcher.subscribers.size === 0) {
      if (watcher.timer) clearInterval(watcher.timer);
      if (watcher._cpUpstream) {
        try { watcher._cpUpstream.close(); } catch (e) {}
        watcher._cpUpstream = null;
      }
      sessionWatchers.delete(key);
    }
  }
  wsToWatcherKeys.delete(ws);
}

function triggerCapture(session, pane) {
  const key = session + ':' + pane;
  const watcher = sessionWatchers.get(key);
  if (watcher) {
    // Don't null lastState — delta is fine, full screen not needed.
    // Nulling caused every keystroke to send a full screen dump instead of
    // just the changed lines, which made the cursor visually lag during fast typing.
    watcher._captureAndBroadcast();
  }
}

// ---------------------------------------------------------------------------
// Bridge claude-proxy sessions into the watcher system (event-driven)
// ---------------------------------------------------------------------------

function bridgeClaudeProxySession(session) {
  const key = session + ':0';
  if (sessionWatchers.has(key)) return sessionWatchers.get(key);

  const watcher = {
    session,
    pane: '0',
    lastState: null,
    subscribers: new Set(),
    timer: null,        // no polling for cp sessions — event-driven
    _cpUpstream: null,  // upstream WebSocket reference for cleanup
  };
  sessionWatchers.set(key, watcher);

  try {
    const cpUrl = 'ws://127.0.0.1:3101/api/session/' + encodeURIComponent(session) + '/stream';
    const upstream = new WebSocket(cpUrl);
    watcher._cpUpstream = upstream;

    upstream.onmessage = (evt) => {
      try {
        const raw = typeof evt.data === 'string' ? evt.data : evt.data.toString();
        const msg = JSON.parse(raw);
        // Tag with session and pane so dashboard clients can route
        msg.session = session;
        msg.pane = '0';
        const json = JSON.stringify(msg);
        for (const ws of watcher.subscribers) {
          if (ws.readyState === 1) ws.send(json);
        }
      } catch (err) {
        // malformed message — skip
      }
    };

    upstream.onclose = () => {
      watcher._cpUpstream = null;
      sessionWatchers.delete(key);
    };

    upstream.onerror = () => {
      try { upstream.close(); } catch (e) {}
      watcher._cpUpstream = null;
      sessionWatchers.delete(key);
    };
  } catch (err) {
    // claude-proxy unreachable — clean up and skip
    sessionWatchers.delete(key);
    return null;
  }

  return watcher;
}

// ---------------------------------------------------------------------------
// Dashboard WebSocket — single multiplexed connection per browser
// ---------------------------------------------------------------------------

async function sendSessionDiscovery(ws, knownSessions, user) {
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
    // tmux not running or no sessions
  }

  // Source 2: claude-proxy API
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
            name, windows: 1, cols: s.cols || 80, rows: s.rows || 24,
            title: s.title || name, source: 'claude-proxy'
          });
          seen.add(name);
        }
      }
    }
  } catch (err) {
    // claude-proxy not running — fine
  }

  // Phase 1: Send session-add messages for all sessions (cards appear in browser)
  for (const s of sessions) {
    if (knownSessions.has(s.name)) continue;
    knownSessions.add(s.name);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'session-add', session: s.name, pane: '0', ...s }));
    }
  }

  // Phase 2: Fetch initial screens
  // Local tmux: sequential (capturePane is fast, ~5ms each)
  for (const s of sessions) {
    if (s.source !== 'tmux') continue;
    subscribeToSession(ws, s.name, '0');
    try {
      const state = await capturePane(s.name, '0');
      if (ws.readyState === 1) {
        const msg = { type: 'screen', session: s.name, pane: '0',
          width: state.width, height: state.height,
          cursor: state.cursor, title: state.title, lines: state.lines,
          scrollOffset: 0 };
        ws.send(JSON.stringify(msg));
      }
    } catch (err) {
      // Session may have disappeared
    }
  }

  // Claude-proxy: parallel fetch all at once (~50-200ms total)
  const cpSessions = sessions.filter(s => s.source === 'claude-proxy');
  if (cpSessions.length > 0) {
    const screenPromises = cpSessions.map(async (s) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        const screenRes = await fetch(
          CLAUDE_PROXY_API + '/api/session/' + encodeURIComponent(s.name) + '/screen',
          { signal: controller.signal }
        );
        clearTimeout(timeout);
        if (screenRes.ok) {
          const state = await screenRes.json();
          if (ws.readyState === 1) {
            const msg = { type: 'screen', session: s.name, pane: '0',
              width: state.width, height: state.height,
              cursor: state.cursor, title: state.title, lines: state.lines,
              scrollOffset: 0 };
            ws.send(JSON.stringify(msg));
          }
        }
      } catch (err) {
        // CP unreachable for this session — bridge will deliver eventually
      }
    });
    await Promise.allSettled(screenPromises);
  }

  // Phase 3: Set up bridges for ongoing delta updates (after initial screens sent)
  for (const s of cpSessions) {
    const watcher = bridgeClaudeProxySession(s.name);
    if (watcher) {
      watcher.subscribers.add(ws);
      if (!wsToWatcherKeys.has(ws)) wsToWatcherKeys.set(ws, new Set());
      wsToWatcherKeys.get(ws).add(s.name + ':0');
    }
  }
}

async function handleDashboardWs(ws, req) {
  // Auth check
  const user = getAuthUser(req);
  if (!user || (AUTH_ENABLED && user.status !== 'approved')) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
    ws.close();
    return;
  }

  dashboardClients.add(ws);
  const knownSessions = new Set();

  // Discover and subscribe to sessions
  await sendSessionDiscovery(ws, knownSessions, user);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      // Subscribe to a new session discovered after initial connection
      if (msg.type === 'subscribe') {
        const session = msg.session;
        if (session && validateParam(session)) {
          if (msg.source === 'claude-proxy') {
            bridgeClaudeProxySession(session);
            const watcher = sessionWatchers.get(session + ':0');
            if (watcher) watcher.subscribers.add(ws);
          } else {
            subscribeToSession(ws, session, '0');
          }
        }
        return;
      }

      // Focus message — adjust capture rates for all watchers
      if (msg.type === 'focus') {
        const focused = new Set(msg.sessions || []);
        for (const [key, watcher] of sessionWatchers) {
          if (!watcher.timer) continue; // cp bridges have no timer
          const isFocused = focused.has(watcher.session);
          const interval = isFocused ? CAPTURE_INTERVAL_FOCUSED : CAPTURE_INTERVAL_UNFOCUSED;
          clearInterval(watcher.timer);
          watcher.timer = setInterval(watcher._captureAndBroadcast, interval);
        }
        return;
      }

      const session = msg.session;
      if (!session || !validateParam(session)) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: 'Invalid session' }));
        return;
      }
      const pane = msg.pane || '0';
      if (!validateParam(pane)) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: 'Invalid pane' }));
        return;
      }

      // Check if this session has a claude-proxy upstream bridge.
      // cp-* sessions are NOT in local tmux — input/scroll/resize must go through
      // the upstream WebSocket to claude-proxy, not through tmux send-keys.
      const watcher = sessionWatchers.get(session + ':' + pane);
      const cpUpstream = watcher && watcher._cpUpstream;

      if (cpUpstream && cpUpstream.readyState === 1) {
        // Forward to claude-proxy upstream — strip session/pane tags (cp doesn't expect them)
        const fwd = { ...msg };
        delete fwd.session;
        delete fwd.pane;
        cpUpstream.send(JSON.stringify(fwd));
        return;
      }

      // Local tmux session — handle directly
      if (msg.type === 'resize') {
        const lock = resizeLocks.get(session);
        if (lock && lock.ws !== ws && Date.now() < lock.expires) return;
        resizeLocks.set(session, { ws, expires: Date.now() + RESIZE_LOCK_MS });
        const cols = Math.max(20, Math.min(500, parseInt(msg.cols) || 80));
        const rows = Math.max(5, Math.min(200, parseInt(msg.rows) || 24));
        try {
          await tmuxAsync('resize-window', '-t', session, '-x', String(cols), '-y', String(rows));
        } catch (err) { /* session may not exist */ }
        setTimeout(() => triggerCapture(session, pane), 10);
        return;
      }

      if (msg.type === 'scroll') {
        setScrollOffset(session, pane, Math.max(0, parseInt(msg.offset) || 0));
        triggerCapture(session, pane);
        return;
      }

      if (msg.type === 'input') {
        const target = session + ':' + pane;
        if (msg.scrollTo != null) {
          setScrollOffset(session, pane, Math.max(0, msg.scrollTo));
          triggerCapture(session, pane);
          return;
        } else if (msg.specialKey && isAllowedKey(msg.specialKey)) {
          setScrollOffset(session, pane, 0);
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
            await tmuxAsync('send-keys', '-t', target, 'C-' + msg.keys);
          } else {
            await tmuxAsync('send-keys', '-t', target, '-l', String(msg.keys));
          }
        }
        setTimeout(() => triggerCapture(session, pane), 5);
      }
    } catch (err) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', message: 'Input error: ' + err.message }));
      }
    }
  });

  ws.on('close', () => {
    unsubscribeFromAll(ws);
    dashboardClients.delete(ws);
  });
  ws.on('error', () => {
    unsubscribeFromAll(ws);
    dashboardClients.delete(ws);
  });
}

// === Server-Sent Events (SSE) command channel ===
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

const resizeLocks = new Map();
const RESIZE_LOCK_MS = 500;

// DEPRECATED (PRD v0.5.0 §3.4): Per-connection polling, replaced by SessionWatcher + /ws/dashboard
// Kept for old pre-WebSocket tmux sessions during transition. Remove when old sessions terminated.
async function handleTerminalWs(ws, session, pane) {
  // If a shared watcher exists, skip the capture loop but keep the message
  // handler so input still works as fallback if shared WS isn't delivering.
  const hasSharedWatcher = sessionWatchers.has(session + ':' + pane);

  let lastState = null;
  let pollTimer = null;

  // Capture pane at shared scroll offset and push to client
  async function captureAndPush() {
    // Self-terminate if a shared watcher took over (race: per-card WS connects before shared WS)
    if (sessionWatchers.has(session + ':' + pane)) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      return;
    }
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

  if (!hasSharedWatcher) {
    // Only run per-card capture loop if no shared watcher exists.
    // Shared watcher handles capture + broadcast for this session.
    await captureAndPush();
    pollTimer = setInterval(captureAndPush, 30);
  }

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'resize') {
        const lock = resizeLocks.get(session);
        if (lock && lock.ws !== ws && Date.now() < lock.expires) {
          return; // another browser holds the lock
        }
        resizeLocks.set(session, { ws, expires: Date.now() + RESIZE_LOCK_MS });
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
// Auth helpers
// ---------------------------------------------------------------------------

function parseCookie(req) {
  const header = req.headers.cookie || '';
  const match = header.match(new RegExp(COOKIE_NAME + '=([^;]+)'));
  return match ? match[1] : null;
}

function getAuthUser(req) {
  if (!AUTH_ENABLED) return { email: 'root@localhost', status: 'approved', linux_user: 'root',
    display_name: 'Development', can_approve_users: 1, can_approve_admins: 1, can_approve_sudo: 1 };
  const token = parseCookie(req);
  if (!token) return null;
  const payload = validateSessionCookie(token, AUTH_SECRET);
  if (!payload) return null;
  return userStore.findByEmail(payload.email);
}

function requireAuth(req, res) {
  const user = getAuthUser(req);
  if (!user) { res.writeHead(302, { Location: '/login' }); res.end(); return null; }
  if (user.status === 'pending') { res.writeHead(302, { Location: '/pending?email=' + encodeURIComponent(user.email) }); res.end(); return null; }
  if (user.status === 'denied') { res.writeHead(302, { Location: '/login?error=Access+denied' }); res.end(); return null; }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.linux_user === 'root' || user.can_approve_users || user.can_approve_admins || user.can_approve_sudo) return user;
  res.writeHead(403); res.end('Forbidden'); return null;
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function serveHtml(req, res, filename) {
  try {
    const content = readFileSync(staticPath(filename));
    setCors(res); res.setHeader('Content-Type', 'text/html'); res.writeHead(200); res.end(content);
  } catch { sendError(res, 500, 'Failed to read ' + filename); }
}

function serveJs(req, res, filename) {
  try {
    const content = readFileSync(staticPath(filename));
    setCors(res); res.setHeader('Content-Type', 'application/javascript'); res.writeHead(200); res.end(content);
  } catch { sendError(res, 500, 'Failed to read ' + filename); }
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

function router(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const pathname = url.pathname;
  const remoteIp = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (pathname !== '/api/events') {
    process.stderr.write(`[HTTP] ${remoteIp} ${req.method} ${pathname}\n`);
  }

  // Auth pages (public — no auth required)
  if (pathname === '/login') return serveHtml(req, res, 'login.html');
  if (pathname === '/pending') return serveHtml(req, res, 'pending.html');
  if (pathname === '/admin-client.mjs') return serveJs(req, res, 'admin-client.mjs');

  if (pathname === '/auth/me') {
    const user = getAuthUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
    return sendJson(res, 200, { email: user.email, displayName: user.display_name, status: user.status,
      linuxUser: user.linux_user, canApprove: !!(user.can_approve_users || user.can_approve_admins || user.can_approve_sudo) });
  }

  if (req.method === 'POST' && pathname === '/auth/logout') {
    res.writeHead(302, { Location: '/login', 'Set-Cookie': COOKIE_NAME + '=; HttpOnly; Path=/; Max-Age=0' });
    res.end(); return;
  }

  if (pathname === '/auth/callback') {
    (async () => {
      try {
        const callbackUrl = 'http://localhost:' + port + '/auth/callback';
        const query = { state: url.searchParams.get('state'), code: url.searchParams.get('code') };
        const identity = await handleCallback(callbackUrl, query, AUTH_PROVIDERS);
        let user = userStore.findByEmail(identity.email);
        if (!user) {
          // Check for pre-approved
          const preApproved = userStore.findByEmail(identity.email);
          if (preApproved && preApproved.status === 'approved' && !preApproved.provider) {
            const linuxUser = generateUsername(identity.email);
            createSystemAccount(linuxUser, identity.displayName);
            addToGroup(linuxUser, 'users');
            userStore.setLinuxUser(identity.email, linuxUser);
            userStore.linkProvider(identity.email, identity.provider, identity.providerId);
            user = userStore.findByEmail(identity.email);
          } else {
            userStore.createPendingUser({ email: identity.email, displayName: identity.displayName,
              provider: identity.provider, providerId: identity.providerId });
            res.writeHead(302, { Location: '/pending?email=' + encodeURIComponent(identity.email) }); res.end(); return;
          }
        }
        if (!userStore.findByProvider(identity.provider, identity.providerId)) {
          userStore.linkProvider(identity.email, identity.provider, identity.providerId);
        }
        userStore.updateLastLogin(identity.email);
        if (user.status === 'pending') { res.writeHead(302, { Location: '/pending?email=' + encodeURIComponent(identity.email) }); res.end(); return; }
        if (user.status === 'denied') { res.writeHead(302, { Location: '/login?error=Access+denied' }); res.end(); return; }
        const cookie = createSessionCookie({ email: identity.email, displayName: identity.displayName }, AUTH_SECRET, COOKIE_MAX_AGE);
        res.writeHead(302, { Location: '/', 'Set-Cookie': COOKIE_NAME + '=' + cookie + '; HttpOnly; Path=/; Max-Age=' + COOKIE_MAX_AGE + '; SameSite=Lax' });
        res.end();
      } catch (err) {
        res.writeHead(302, { Location: '/login?error=' + encodeURIComponent(err.message) }); res.end();
      }
    })();
    return;
  }

  if (pathname.startsWith('/auth/')) {
    const provider = pathname.split('/')[2];
    (async () => {
      try {
        const callbackUrl = 'http://localhost:' + port + '/auth/callback';
        const result = await getAuthUrlAsync(provider, AUTH_PROVIDERS, callbackUrl);
        res.writeHead(302, { Location: result.url }); res.end();
      } catch (err) {
        res.writeHead(302, { Location: '/login?error=' + encodeURIComponent(err.message) }); res.end();
      }
    })();
    return;
  }

  // SSE command channel
  if (pathname === '/api/events') return handleSSE(req, res);
  if (req.method === 'POST' && pathname === '/api/admin/reload') {
    broadcast('reload', {});
    return sendJson(res, 200, { ok: true, clients: sseClients.size });
  }
  if (pathname === '/api/admin/clients') {
    return sendJson(res, 200, { count: sseClients.size });
  }
  if (pathname === '/api/admin/throttle') {
    setCors(res);
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { interval } = JSON.parse(body);
          if (typeof interval === 'number' && interval >= 30 && interval <= 5000) {
            broadcast('throttle', { interval });
            sendJson(res, 200, { ok: true, interval });
          } else {
            sendError(res, 400, 'interval must be 30-5000');
          }
        } catch (err) {
          sendError(res, 400, 'Invalid JSON');
        }
      });
      return;
    }
    sendError(res, 405, 'POST only');
    return;
  }

  // Admin routes (protected)
  if (pathname === '/admin') { const u = requireAdmin(req, res); if (!u) return; return serveHtml(req, res, 'admin.html'); }
  if (pathname === '/api/admin/pending') { const u = requireAdmin(req, res); if (!u) return; return sendJson(res, 200, userStore.listPending()); }
  if (pathname === '/api/admin/users') { const u = requireAdmin(req, res); if (!u) return; return sendJson(res, 200, userStore.listUsers()); }

  if (req.method === 'POST' && pathname === '/api/admin/approve') {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      const body = await readBody(req);
      const { email } = JSON.parse(body);
      const target = userStore.findByEmail(email);
      if (!target) return sendError(res, 404, 'User not found');
      const linuxUser = generateUsername(email);
      createSystemAccount(linuxUser, target.display_name);
      addToGroup(linuxUser, 'users');
      userStore.approveUser(email, u.email || 'root');
      userStore.setLinuxUser(email, linuxUser);
      sendJson(res, 200, { ok: true });
    })().catch(err => sendError(res, 500, err.message));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/deny') {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      const body = await readBody(req);
      const { email } = JSON.parse(body);
      userStore.denyUser(email);
      sendJson(res, 200, { ok: true });
    })().catch(err => sendError(res, 500, err.message));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/pre-approve') {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      const body = await readBody(req);
      const { emails } = JSON.parse(body);
      userStore.preApprove(emails, u.email || 'root');
      sendJson(res, 200, { ok: true });
    })().catch(err => sendError(res, 500, err.message));
    return;
  }

  if (req.method === 'PATCH' && pathname.startsWith('/api/admin/user/') && pathname.endsWith('/flags')) {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      if (!u.can_approve_admins && !u.can_approve_sudo && u.linux_user !== 'root') return sendError(res, 403, 'Insufficient permissions');
      const email = decodeURIComponent(pathname.split('/')[4]);
      const body = await readBody(req);
      const flags = JSON.parse(body);
      userStore.updateFlags(email, flags);
      sendJson(res, 200, { ok: true });
    })().catch(err => sendError(res, 500, err.message));
    return;
  }

  // Auth middleware — protect all remaining routes
  if (AUTH_ENABLED) {
    const user = requireAuth(req, res);
    if (!user) return;
  }

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
  const remoteIp = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  process.stderr.write(`[WS] ${remoteIp} UPGRADE ${url.pathname}\n`);
  if (url.pathname === '/ws/dashboard') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleDashboardWs(ws, req).catch(err => {
        process.stderr.write('Dashboard WS error: ' + err.message + '\n');
        try { ws.close(); } catch {}
      });
    });
    return;
  }
  if (url.pathname === '/ws/terminal') {
    // DEPRECATED (PRD v0.5.0 §3.4): Per-card WebSocket, replaced by /ws/dashboard
    // Kept for old sessions during transition.
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
