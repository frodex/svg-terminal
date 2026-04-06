// server.mjs
// HTTP server for SVG Terminal Viewer
// Zero npm dependencies — uses Node built-ins only

import http from 'node:http';
import https from 'node:https';
import { createConnection } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createSessionCookie, validateSessionCookie } from './session-cookie.mjs';
import { UserStore } from './user-store.mjs';
import { getAuthUrlAsync, handleCallback, getSupportedProviders } from './auth.mjs';
import { createSystemAccount, deleteSystemAccount, addToGroup, generateUsername, ensureCpUsersGroup, userExists, deactivateAccount, reactivateAccount, purgeAccount } from './provisioner.mjs';
import { ApiKeyStore } from './api-key-store.mjs';
import { RateLimiter } from './rate-limiter.mjs';

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

const COOKIE_NAME = 'cp_session';
const COOKIE_MAX_AGE = 86400;
const AUTH_PROVIDERS = {
  google: process.env.GOOGLE_CLIENT_ID ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } : null,
  github: process.env.GITHUB_CLIENT_ID ? { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET } : null,
  microsoft: process.env.MICROSOFT_CLIENT_ID ? { clientId: process.env.MICROSOFT_CLIENT_ID, clientSecret: process.env.MICROSOFT_CLIENT_SECRET, tenant: process.env.MICROSOFT_TENANT } : null,
};
const AUTH_MODE = process.env.AUTH_MODE || null; // 'dev' for development mode, null for production
const DEV_PASSWORD = process.env.DEV_PASSWORD || null;
const DEV_LOCALHOST_ONLY = process.env.DEV_LOCALHOST_ONLY !== '0'; // default: restrict dev mode to localhost

const hasOAuthProviders = Object.values(AUTH_PROVIDERS).some(v => v !== null);

// Dev mode requires explicit opt-in + password
if (AUTH_MODE === 'dev') {
  if (!DEV_PASSWORD) {
    process.stderr.write('[FATAL] DEV_PASSWORD is required when AUTH_MODE=dev.\n');
    process.stderr.write('        Set DEV_PASSWORD to a password for dev access.\n');
    process.exit(1);
  }
  if (DEV_LOCALHOST_ONLY) {
    process.stderr.write('[INFO] Dev mode enabled — restricted to localhost only. Set DEV_LOCALHOST_ONLY=0 to allow LAN access.\n');
  } else {
    process.stderr.write('[WARN] Dev mode enabled with LAN access. This is not safe for production.\n');
  }
}

// Production mode: require OAuth providers
const AUTH_ENABLED = hasOAuthProviders || AUTH_MODE === 'dev';
if (!hasOAuthProviders && AUTH_MODE !== 'dev') {
  process.stderr.write('[FATAL] No OAuth providers configured and AUTH_MODE is not "dev".\n');
  process.stderr.write('        Either configure OAuth providers (GOOGLE_CLIENT_ID, etc.) or set AUTH_MODE=dev with DEV_PASSWORD.\n');
  process.exit(1);
}

// AUTH_SECRET is required when OAuth providers are configured.
const AUTH_SECRET = process.env.AUTH_SECRET || (AUTH_MODE === 'dev' ? DEV_PASSWORD : null);
if (hasOAuthProviders && !process.env.AUTH_SECRET) {
  process.stderr.write('[FATAL] AUTH_SECRET environment variable is required when OAuth providers are configured.\n');
  process.stderr.write('        Set AUTH_SECRET to a random 32+ character string.\n');
  process.exit(1);
}

let userStore = null;
if (AUTH_ENABLED) {
  mkdirSync(new URL('data', import.meta.url).pathname, { recursive: true });
  const DB_PATH = process.env.USER_DB_PATH || new URL('data/users.db', import.meta.url).pathname;
  userStore = new UserStore(DB_PATH);
  try { ensureCpUsersGroup(); } catch {}

  // Ensure root-mapped users have superadmin flag
  const rootUser = userStore.findByLinuxUser('root');
  if (rootUser && !rootUser.is_superadmin) {
    userStore.setSuperadmin(rootUser.email, true);
    process.stderr.write('[AUTH] Auto-promoted ' + rootUser.email + ' to superadmin (linux_user=root)\n');
  }
}

const apiKeyStore = AUTH_ENABLED ? new ApiKeyStore({
  secret: AUTH_SECRET,
  idleTimeoutMs: 30 * 60 * 1000,
  absoluteTimeoutMs: 24 * 60 * 60 * 1000,
  maxKeysPerUser: 10,
}) : null;

// ---------------------------------------------------------------------------
// Rate limiters (Task 14)
// ---------------------------------------------------------------------------

const authRateLimiter = new RateLimiter({ maxAttempts: 5, windowMs: 60000, lockoutMs: 900000, lockoutAfter: 10 });
const oauthInitRateLimiter = new RateLimiter({ maxAttempts: 10, windowMs: 60000, lockoutMs: 300000, lockoutAfter: 20 });
const adminMutationRateLimiter = new RateLimiter({ maxAttempts: 10, windowMs: 60000, lockoutMs: 300000, lockoutAfter: 15 });
const privilegedActionRateLimiter = new RateLimiter({ maxAttempts: 3, windowMs: 60000, lockoutMs: 600000, lockoutAfter: 5 });
const wsUpgradeRateLimiter = new RateLimiter({ maxAttempts: 20, windowMs: 60000, lockoutMs: 300000, lockoutAfter: 30 });
const apiKeyRateLimiter = new RateLimiter({ maxAttempts: 30, windowMs: 60000 });

function getClientIp(req) {
  return req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
}

const STRICT_SESSION_AUTHZ = process.env.STRICT_SESSION_AUTHZ === '1';
if (STRICT_SESSION_AUTHZ) {
  process.stderr.write('[AUTH] STRICT_SESSION_AUTHZ enabled — per-session authorization enforced\n');
}

const pendingCheckTokens = new Map(); // checkToken → { email, expires }

function isSuperadmin(user) {
  if (!user) return false;
  return !!(user.is_superadmin);
}

/**
 * Check if user is authorized to access a session.
 * @param {object} user - authenticated user (from getAuthUser or API key identity)
 * @param {string} sessionName - tmux/cp session name
 * @returns {boolean}
 */
function authorizeSession(user, sessionName) {
  if (!STRICT_SESSION_AUTHZ) return true;
  if (!user) return false;
  if (isSuperadmin(user)) return true;

  const cached = sessionPermCache.get(sessionName);
  if (!cached) return false; // unknown session = deny (may race before first discovery — superadmin bypass handles bootstrap)
  if (cached.public) return true;
  if (cached.owner === user.linux_user) return true;
  if (cached.allowedUsers && cached.allowedUsers.includes(user.linux_user)) return true;
  return false;
}

// Session permission cache — populated during session discovery
const sessionPermCache = new Map(); // sessionName → { owner, public, allowedUsers, allowedGroups, viewOnly }

// ---------------------------------------------------------------------------
// Static file helpers
// ---------------------------------------------------------------------------

function staticPath(filename) {
  return new URL(filename, import.meta.url).pathname;
}

// Client version hash — computed at startup from all files that affect the browser.
// If server.mjs changes, the API contract may have changed (message formats, WS handlers).
// If dashboard.mjs or index.html change, the browser needs new code.
const CLIENT_VERSION = (() => {
  try {
    const hash = createHash('md5');
    hash.update(readFileSync(staticPath('dashboard.mjs')));
    hash.update(readFileSync(staticPath('index.html')));
    hash.update(readFileSync(import.meta.filename));  // server.mjs itself
    try { hash.update(readFileSync(staticPath('mobile.mjs'))); } catch {}
    try { hash.update(readFileSync(staticPath('mobile.html'))); } catch {}
    return hash.digest('hex').slice(0, 8);
  } catch { return 'unknown'; }
})();
process.stderr.write('[SERVER] Client version: ' + CLIENT_VERSION + '\n');

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SAFE_PARAM = /^[a-zA-Z0-9_:%-]+$/;

function validateParam(value) {
  return typeof value === 'string' && SAFE_PARAM.test(value);
}

// ---------------------------------------------------------------------------
// Claude-proxy Unix socket (JSON-RPC) — replaces HTTP + WS to :3101 for local integration
// ---------------------------------------------------------------------------

const CP_SOCKET = process.env.CLAUDE_PROXY_SOCKET || '/run/claude-proxy/api.sock';
const CP_DEFAULT_USER = process.env.CLAUDE_PROXY_USER || 'root';

let cpSock = null;
let cpBuf = '';
let cpNextId = 0;
const cpPending = new Map();
const cpTerminalHandlers = new Map(); // sessionId → Set<handler>
const cpSubscribeCounts = new Map(); // sessionId → { count, user }

function cpOnDataChunk(chunk) {
  cpBuf += chunk.toString();
  const lines = cpBuf.split('\n');
  cpBuf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && cpPending.has(msg.id)) {
      const p = cpPending.get(msg.id);
      cpPending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || msg.error.code || 'claude-proxy error');
        if (msg.error.code) err.code = msg.error.code;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
    } else if (msg.event && msg.sessionId) {
      const set = cpTerminalHandlers.get(msg.sessionId);
      if (set) {
        for (const h of set) {
          try { h(msg); } catch { /* ignore */ }
        }
      }
    }
  }
}

function ensureCpSocket() {
  if (cpSock && !cpSock.destroyed) return cpSock;
  cpSock = createConnection(CP_SOCKET);
  cpBuf = '';
  cpSock.on('data', cpOnDataChunk);
  const onDead = () => {
    cpSock = null;
    for (const [, p] of cpPending) {
      clearTimeout(p.timer);
      p.reject(new Error('claude-proxy socket closed'));
    }
    cpPending.clear();
  };
  cpSock.on('close', onDead);
  cpSock.on('error', onDead);
  cpSock.once('connect', () => {
    void cpResubscribeAll().catch((err) => {
      console.warn('[claude-proxy] resubscribe-all failed:', err?.message || err);
    });
  });
  return cpSock;
}

function cpRequest(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const conn = ensureCpSocket();
    const id = ++cpNextId;
    const timer = setTimeout(() => {
      cpPending.delete(id);
      reject(new Error(`cpRequest ${method} timed out`));
    }, timeoutMs);
    cpPending.set(id, { resolve, reject, timer });
    try {
      conn.write(JSON.stringify({ id, method, params }) + '\n');
    } catch (e) {
      cpPending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

function cpRegisterTerminal(sessionId, handler) {
  if (!cpTerminalHandlers.has(sessionId)) cpTerminalHandlers.set(sessionId, new Set());
  cpTerminalHandlers.get(sessionId).add(handler);
}

function cpUnregisterTerminal(sessionId, handler) {
  const set = cpTerminalHandlers.get(sessionId);
  if (!set) return;
  set.delete(handler);
  if (set.size === 0) cpTerminalHandlers.delete(sessionId);
}

async function cpEnsureSubscribed(sessionId, user) {
  let rec = cpSubscribeCounts.get(sessionId);
  if (!rec) {
    rec = { count: 0, user };
    cpSubscribeCounts.set(sessionId, rec);
  }
  rec.count++;
  if (rec.count === 1) {
    await cpRequest('subscribe', { sessionId, user: rec.user }, 15000);
  }
}

async function cpMaybeUnsub(sessionId) {
  const rec = cpSubscribeCounts.get(sessionId);
  if (!rec) return;
  rec.count--;
  if (rec.count <= 0) {
    cpSubscribeCounts.delete(sessionId);
    await cpRequest('unsubscribe', { sessionId, user: rec.user }).catch(() => {});
  }
}

// After claude-proxy restarts, the Unix socket reconnects but the proxy process
// drops all subscribe state. svg-terminal still has cpSubscribeCounts + handlers;
// without re-sending subscribe, terminal events never arrive and cards look frozen.
async function cpResubscribeAll() {
  if (cpSubscribeCounts.size === 0) return;
  for (const [sessionId, rec] of cpSubscribeCounts) {
    if (!rec || rec.count <= 0) continue;
    try {
      await cpRequest('subscribe', { sessionId, user: rec.user }, 15000);
    } catch (err) {
      console.warn(`[claude-proxy] resubscribe ${sessionId} failed:`, err?.message || err);
    }
  }
  await cpPushFullScreensAfterCpResubscribe();
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const CORS_ORIGIN = process.env.PUBLIC_URL || null;

function setCors(res, req) {
  if (CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Vary', 'Origin');
  } else {
    // No PUBLIC_URL set — allow all origins for local development only
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
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
    let content = readFileSync(staticPath('index.html'), 'utf8');
    // Inject version hash as cache buster on dashboard.mjs — forces reload when server code changes
    content = content.replace(
      'src="/dashboard.mjs"',
      'src="/dashboard.mjs?v=' + CLIENT_VERSION + '"'
    );
    setCors(res);
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', CSP_HEADER);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    res.writeHead(200);
    res.end(content);
  } catch (err) {
    sendError(res, 500, 'Failed to read index.html');
  }
}

function handleMobile(req, res) {
  try {
    let content = readFileSync(staticPath('mobile.html'), 'utf8');
    content = content.replace(
      'src="/mobile.mjs"',
      'src="/mobile.mjs?v=' + CLIENT_VERSION + '"'
    );
    setCors(res);
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', CSP_HEADER);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    res.writeHead(200);
    res.end(content);
  } catch (err) {
    sendError(res, 500, 'Failed to read mobile.html');
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

const ALLOWED_SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'BSpace', 'DC', 'IC',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PgUp', 'PgDn',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

// Additional key names accepted from clients (claude-proxy handles translation)
const EXTRA_ALLOWED_KEYS = new Set(['Backspace', 'Delete', 'PageUp', 'PageDown', 'Insert']);

function isAllowedKey(key) {
  return ALLOWED_SPECIAL_KEYS.has(key) || EXTRA_ALLOWED_KEYS.has(key) || /^C-[a-z]$/.test(key);
}


/** Build createSession body for claude-proxy — mirrors CreateSessionRequest / session-form field mapping. */
function buildCreateSessionPayload(body, autoName) {
  const allowedProfiles = new Set(['shell', 'claude', 'cursor']);
  const launchProfile =
    typeof body.launchProfile === 'string' && allowedProfiles.has(body.launchProfile.trim())
      ? body.launchProfile.trim()
      : 'claude';

  let name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().replace(/[^a-zA-Z0-9_.-]/g, '_').substring(0, 64)
      : '';
  if (!name) name = autoName;

  const payload = { name, launchProfile };

  if (body.runAsUser && String(body.runAsUser).trim()) payload.runAsUser = String(body.runAsUser).trim();
  if (body.workingDir && String(body.workingDir).trim()) payload.workingDir = String(body.workingDir).trim();
  if (body.remoteHost && String(body.remoteHost).trim()) payload.remoteHost = String(body.remoteHost).trim();
  if (typeof body.hidden === 'boolean') payload.hidden = body.hidden;
  if (typeof body.viewOnly === 'boolean') payload.viewOnly = body.viewOnly;
  if (typeof body.public === 'boolean') payload.public = body.public;
  if (Array.isArray(body.allowedUsers) && body.allowedUsers.length)
    payload.allowedUsers = body.allowedUsers.map(String);
  if (Array.isArray(body.allowedGroups) && body.allowedGroups.length)
    payload.allowedGroups = body.allowedGroups.map(String);
  if (body.password && String(body.password).length) payload.password = String(body.password);
  if (typeof body.dangerousSkipPermissions === 'boolean')
    payload.dangerousSkipPermissions = body.dangerousSkipPermissions;
  if (body.claudeSessionId && String(body.claudeSessionId).trim())
    payload.claudeSessionId = String(body.claudeSessionId).trim();
  if (typeof body.isResume === 'boolean') payload.isResume = body.isResume;

  return payload;
}

/** Settings payload for restartSession / forkSession (subset of create fields). */
function buildRestartForkSettings(body) {
  const s = {};
  if (body.name && String(body.name).trim()) {
    s.name = String(body.name)
      .trim()
      .replace(/[^a-zA-Z0-9_.-]/g, '_')
      .substring(0, 64);
  }
  if (typeof body.hidden === 'boolean') s.hidden = body.hidden;
  if (typeof body.viewOnly === 'boolean') s.viewOnly = body.viewOnly;
  if (typeof body.public === 'boolean') s.public = body.public;
  if (Array.isArray(body.allowedUsers) && body.allowedUsers.length)
    s.allowedUsers = body.allowedUsers.map(String);
  if (Array.isArray(body.allowedGroups) && body.allowedGroups.length)
    s.allowedGroups = body.allowedGroups.map(String);
  if (body.password && String(body.password).length) s.password = String(body.password);
  if (typeof body.dangerousSkipPermissions === 'boolean')
    s.dangerousSkipPermissions = body.dangerousSkipPermissions;
  return s;
}

function mapCpErrorToStatus(err) {
  const c = err && err.code;
  if (c === 'NOT_FOUND') return 404;
  if (c === 'FORBIDDEN') return 403;
  if (c === 'BAD_REQUEST') return 400;
  return 502;
}




// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SessionWatcher — shared capture per session, broadcast to subscribers
// ---------------------------------------------------------------------------

const sessionWatchers = new Map(); // key = "session:pane", value = watcher
const dashboardClients = new Set(); // all /ws/dashboard connections
const sudoWindows = new Map(); // email → expiry timestamp
// Reverse index: ws → Set of watcher keys (for fast unsubscribe on close)
const wsToWatcherKeys = new WeakMap();

/** Notify all dashboard clients that a new claude-proxy session exists (restart/fork/create). */
function notifyDashboardCpSessionCreated(result, ownerUser) {
  if (!result || typeof result !== 'object') return;
  const name = result.id || result.name;
  if (!name) return;
  const row = {
    name,
    cpId: result.id || name,
    displayName: result.name || result.id,
    windows: 1,
    cols: result.cols || 80,
    rows: result.rows || 24,
    title: result.title || name,
    source: 'claude-proxy',
    launchProfile: result.launchProfile
  };
  // Update permission cache on session lifecycle
  if (STRICT_SESSION_AUTHZ) {
    sessionPermCache.set(name, {
      owner: ownerUser || CP_DEFAULT_USER,
      public: true,
      allowedUsers: [],
      allowedGroups: [],
      viewOnly: false,
    });
  }

  const msg = JSON.stringify({ type: 'session-add', session: name, pane: '0', ...row });
  for (const ws of dashboardClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
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
      if (watcher._cpTerminalHandler) {
        cpUnregisterTerminal(watcher.session, watcher._cpTerminalHandler);
        watcher._cpTerminalHandler = null;
        void cpMaybeUnsub(watcher.session);
      }
      sessionWatchers.delete(key);
    }
  }
  wsToWatcherKeys.delete(ws);
}

// ---------------------------------------------------------------------------
// Bridge claude-proxy sessions into the watcher system (event-driven)
// ---------------------------------------------------------------------------

function bridgeClaudeProxySession(session, cpUser) {
  const u = cpUser || CP_DEFAULT_USER;
  const key = session + ':0';
  if (sessionWatchers.has(key)) {
    const existing = sessionWatchers.get(key);
    if (!existing._cpTerminalHandler) {
      process.stderr.write(`[svg-terminal] upgrading watcher for ${session} to cp bridge\n`);
      const handler = (cpMsg) => {
        if (cpMsg.sessionId !== session) return;

        // Session settings changed — update permission cache
        if (cpMsg.event === 'session-settings-changed' && cpMsg.data && cpMsg.data.access) {
          const a = cpMsg.data.access;
          sessionPermCache.set(session, {
            owner: a.owner || CP_DEFAULT_USER,
            public: a.public !== false,
            allowedUsers: a.allowedUsers || [],
            allowedGroups: a.allowedGroups || [],
            viewOnly: !!a.viewOnly,
          });
          const settingsMsg = JSON.stringify({ type: 'session-settings', session, access: a });
          for (const ws of existing.subscribers) {
            if (ws.readyState === 1) ws.send(settingsMsg);
          }
          return;
        }

        // Session ended — broadcast session-remove and clean up
        if (cpMsg.event === 'session-end') {
          const removeMsg = JSON.stringify({ type: 'session-remove', session });
          for (const ws of existing.subscribers) {
            if (ws.readyState === 1) ws.send(removeMsg);
          }
          cpUnregisterTerminal(session, handler);
          sessionWatchers.delete(key);
          sessionPermCache.delete(session);
          return;
        }

        if (cpMsg.event !== 'terminal') return;
        const inner = cpMsg.data;
        if (inner == null) return;
        const base = typeof inner === 'object' && !Array.isArray(inner) ? inner : {};
        const msg = { ...base, session, pane: '0' };
        if (msg.type === 'screen') existing._lastScreen = msg;
        const json = JSON.stringify(msg);
        for (const ws of existing.subscribers) {
          if (ws.readyState !== 1) continue;
          if (msg.type === 'delta' && ws.bufferedAmount > 65536) continue;
          ws.send(json);
        }
      };
      existing._cpTerminalHandler = handler;
      if (existing.timer) { clearInterval(existing.timer); existing.timer = null; }
      cpRegisterTerminal(session, handler);
      void cpEnsureSubscribed(session, u).catch(() => {
        cpUnregisterTerminal(session, handler);
        existing._cpTerminalHandler = null;
      });
    }
    return existing;
  }

  const watcher = {
    session,
    pane: '0',
    lastState: null,
    subscribers: new Set(),
    timer: null, // no polling for cp sessions — event-driven
    _cpTerminalHandler: null,
  };
  sessionWatchers.set(key, watcher);

  const handler = (cpMsg) => {
    if (cpMsg.sessionId !== session) return;

    // Session settings changed — update permission cache
    if (cpMsg.event === 'session-settings-changed' && cpMsg.data && cpMsg.data.access) {
      const a = cpMsg.data.access;
      sessionPermCache.set(session, {
        owner: a.owner || CP_DEFAULT_USER,
        public: a.public !== false,
        allowedUsers: a.allowedUsers || [],
        allowedGroups: a.allowedGroups || [],
        viewOnly: !!a.viewOnly,
      });
      // Notify dashboard clients so they can update card state (e.g. viewOnly indicator)
      const settingsMsg = JSON.stringify({ type: 'session-settings', session, access: a });
      for (const ws of watcher.subscribers) {
        if (ws.readyState === 1) ws.send(settingsMsg);
      }
      return;
    }

    // Session ended — broadcast session-remove and clean up
    if (cpMsg.event === 'session-end') {
      const removeMsg = JSON.stringify({ type: 'session-remove', session });
      for (const ws of watcher.subscribers) {
        if (ws.readyState === 1) ws.send(removeMsg);
      }
      cpUnregisterTerminal(session, handler);
      sessionWatchers.delete(key);
      sessionPermCache.delete(session);
      return;
    }

    if (cpMsg.event !== 'terminal') return;
    const inner = cpMsg.data;
    if (inner == null) return;
    const base = typeof inner === 'object' && !Array.isArray(inner) ? inner : {};
    const msg = { ...base, session, pane: '0' };
    if (msg.type === 'screen') watcher._lastScreen = msg;
    const json = JSON.stringify(msg);
    for (const ws of watcher.subscribers) {
      if (ws.readyState !== 1) continue;
      // Backpressure: if WS send buffer is backed up, skip delta messages.
      // The next screen or delta will carry current state. Prevents growing
      // lag on slow connections (e.g. second browser through Cloudflare tunnel).
      if (msg.type === 'delta' && ws.bufferedAmount > 65536) continue;
      ws.send(json);
    }
  };
  watcher._cpTerminalHandler = handler;
  watcher._lastScreen = null;
  cpRegisterTerminal(session, handler);

  void cpEnsureSubscribed(session, u).catch(() => {
    cpUnregisterTerminal(session, handler);
    watcher._cpTerminalHandler = null;
    sessionWatchers.delete(key);
  });

  return watcher;
}

// After reconnect, claude-proxy often emits incremental deltas before any full screen.
// Dashboard clients treat the first frame as authoritative only for `type: 'screen'`, so
// push a full snapshot after resubscribe (same shape as initial discovery).
async function cpPushFullScreensAfterCpResubscribe() {
  for (const [sessionId, rec] of cpSubscribeCounts) {
    if (!rec || rec.count <= 0) continue;
    const watcher = sessionWatchers.get(sessionId + ':0');
    if (!watcher || watcher.subscribers.size === 0) continue;
    try {
      const state = await cpRequest(
        'getSessionScreen',
        { sessionId, user: rec.user },
        12000,
      );
      const msg = JSON.stringify({
        type: 'screen',
        session: sessionId,
        pane: '0',
        width: state.width,
        height: state.height,
        cursor: state.cursor,
        title: state.title,
        lines: state.lines,
        scrollOffset: 0,
      });
      for (const ws of watcher.subscribers) {
        if (ws.readyState === 1) ws.send(msg);
      }
    } catch (err) {
      console.warn(
        `[claude-proxy] post-resubscribe full screen ${sessionId}:`,
        err?.message || err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Dashboard WebSocket — single multiplexed connection per browser
// ---------------------------------------------------------------------------

async function sendSessionDiscovery(ws, knownSessions, user) {
  const cpUser = user.linux_user || CP_DEFAULT_USER;
  const sessions = [];

  try {
    const cpSessions = await cpRequest('listSessions', { user: cpUser }, 2000);
    for (const s of cpSessions || []) {
      const name = s.id || s.name;
      sessions.push({
        name, windows: 1, cols: s.cols || 80, rows: s.rows || 24,
        title: s.title || name, source: 'claude-proxy'
      });
    }

    // Populate permission cache for STRICT_SESSION_AUTHZ
    if (STRICT_SESSION_AUTHZ) {
      for (const s of cpSessions || []) {
        sessionPermCache.set(s.id || s.name, {
          owner: s.owner || cpUser,
          public: s.public !== false,
          allowedUsers: s.allowedUsers || [],
          allowedGroups: s.allowedGroups || [],
          viewOnly: !!s.viewOnly,
        });
      }
    }
  } catch (err) {
    // claude-proxy not running
  }

  // Send session-add messages (cards appear in browser)
  process.stderr.write('[WS] Discovery: ' + sessions.length + ' sessions for ' + cpUser + '\n');
  for (const s of sessions) {
    if (knownSessions.has(s.name)) continue;
    knownSessions.add(s.name);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'session-add', session: s.name, pane: '0', ...s }));
    }
  }

  // Bridge all sessions and fetch initial screens
  for (const s of sessions) {
    const watcher = bridgeClaudeProxySession(s.name, cpUser);
    if (watcher) {
      watcher.subscribers.add(ws);
      if (!wsToWatcherKeys.has(ws)) wsToWatcherKeys.set(ws, new Set());
      wsToWatcherKeys.get(ws).add(s.name + ':0');
    }
  }

  if (sessions.length > 0) {
    const screenPromises = sessions.map(async (s) => {
      try {
        const state = await cpRequest('getSessionScreen', {
          sessionId: s.name,
          user: cpUser,
        }, 3000);
        if (ws.readyState === 1) {
          const msg = { type: 'screen', session: s.name, pane: '0',
            width: state.width || s.cols, height: state.height || s.rows,
            cursor: state.cursor, title: state.title, lines: state.lines,
            scrollOffset: 0 };
          ws.send(JSON.stringify(msg));
          const watcher = sessionWatchers.get(s.name + ':0');
          if (watcher) watcher._lastScreen = msg;
        }
      } catch (err) {
        // Session may have disappeared
      }
    });
    await Promise.all(screenPromises);
  }
}

async function handleDashboardWs(ws, req) {
  // Auth check — prefer API key identity over session cookie
  const user = req._apiKeyIdentity
    ? userStore.findByEmail(req._apiKeyIdentity.email) || {
        email: req._apiKeyIdentity.email,
        linux_user: req._apiKeyIdentity.linuxUser,
        status: 'approved',
      }
    : getAuthUser(req);
  if (!user || (AUTH_ENABLED && user.status !== 'approved')) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
    ws.close();
    return;
  }

  dashboardClients.add(ws);
  ws._userEmail = user.email;  // For force-relogin (Task 13) to find WS by user
  const knownSessions = new Set();
  const cpUserDash = user.linux_user || CP_DEFAULT_USER;

  process.stderr.write('[WS] Dashboard connected for ' + user.email + ' (linux_user=' + cpUserDash + ')\n');

  // Send server version — client compares and shows update banner if mismatched
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'version', version: CLIENT_VERSION }));
  }

  // Discover and subscribe to sessions
  await sendSessionDiscovery(ws, knownSessions, user);

  ws.on('message', async (data) => {
    if (req._apiKey && apiKeyStore) apiKeyStore.touch(req._apiKey);
    try {
      const msg = JSON.parse(data);

      // Subscribe to a new session discovered after initial connection
      if (msg.type === 'subscribe') {
        const session = msg.session;
        if (session && validateParam(session)) {
          if (STRICT_SESSION_AUTHZ && !authorizeSession(user, session)) {
            if (ws.readyState === 1) ws.send(JSON.stringify({
              type: 'error', session: session, message: 'Not authorized for this session'
            }));
            return;
          }
          bridgeClaudeProxySession(session, cpUserDash);
          const watcher = sessionWatchers.get(session + ':0');
          if (watcher) {
            watcher.subscribers.add(ws);
            if (!wsToWatcherKeys.has(ws)) wsToWatcherKeys.set(ws, new Set());
            wsToWatcherKeys.get(ws).add(session + ':0');
            if (watcher._lastScreen && ws.readyState === 1) {
              ws.send(JSON.stringify(watcher._lastScreen));
            }
          }
        }
        return;
      }

      // Unsubscribe from a single session (mobile session switching, selective cleanup)
      if (msg.type === 'unsubscribe') {
        const session = msg.session;
        if (session && validateParam(session)) {
          const key = session + ':0';
          const watcher = sessionWatchers.get(key);
          if (watcher) {
            watcher.subscribers.delete(ws);
            if (watcher.subscribers.size === 0) {
              if (watcher.timer) clearInterval(watcher.timer);
              if (watcher._cpTerminalHandler) {
                cpUnregisterTerminal(watcher.session, watcher._cpTerminalHandler);
              }
              cpMaybeUnsub(watcher.session).catch(() => {});
              sessionWatchers.delete(key);
            }
          }
          const keys = wsToWatcherKeys.get(ws);
          if (keys) keys.delete(key);
        }
        return;
      }

      // Session lifecycle over WS
      if (msg.type === 'create-session') {
        try {
          const linuxUser = user.linux_user || CP_DEFAULT_USER;
          const autoName = 'svg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
          const payload = buildCreateSessionPayload(msg.payload || {}, autoName);
          const result = await cpRequest('createSession', { user: linuxUser, body: payload }, 120000);
          notifyDashboardCpSessionCreated(result, linuxUser);
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'create-session-result', ok: true, session: result }));
        } catch (err) {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'create-session-result', ok: false, error: err.message || String(err) }));
        }
        return;
      }

      if (msg.type === 'restart-session') {
        try {
          const linuxUser = user.linux_user || CP_DEFAULT_USER;
          const p = msg.payload || {};
          const deadId = p.deadSessionId || p.deadId;
          if (!deadId || typeof deadId !== 'string') throw new Error('deadSessionId is required');
          const settings = buildRestartForkSettings(p);
          const result = await cpRequest('restartSession', { user: linuxUser, sessionId: deadId, settings }, 120000);
          notifyDashboardCpSessionCreated(result, linuxUser);
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'restart-session-result', ok: true, session: result }));
        } catch (err) {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'restart-session-result', ok: false, error: err.message || String(err) }));
        }
        return;
      }

      if (msg.type === 'fork-session') {
        try {
          const linuxUser = user.linux_user || CP_DEFAULT_USER;
          const p = msg.payload || {};
          const sourceId = p.sourceSessionId || p.sourceId;
          if (!sourceId || typeof sourceId !== 'string') throw new Error('sourceSessionId is required');
          const settings = buildRestartForkSettings(p);
          const result = await cpRequest('forkSession', { user: linuxUser, sessionId: sourceId, settings }, 120000);
          notifyDashboardCpSessionCreated(result, linuxUser);
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'fork-session-result', ok: true, session: result }));
        } catch (err) {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'fork-session-result', ok: false, error: err.message || String(err) }));
        }
        return;
      }

      // Layout save over WS
      if (msg.type === 'save-layout') {
        try {
          const safeKey = user.email.replace(/[^a-zA-Z0-9@._-]/g, '_');
          const profileDir = staticPath('profiles');
          if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true, mode: 0o700 });
          writeFileSync(profileDir + '/' + safeKey + '.json', JSON.stringify(msg.layout), { mode: 0o600 });
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'save-layout-result', ok: true }));
        } catch (err) {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'save-layout-result', ok: false, error: err.message || String(err) }));
        }
        return;
      }

      // Picklist data over WS (replaces GET /api/cp/users, /groups, /remotes, /dead-sessions)
      if (msg.type === 'get-picklists') {
        try {
          const linuxUser = user.linux_user || CP_DEFAULT_USER;
          const [users, groups, remotes, deadSessions] = await Promise.all([
            cpRequest('listUsers', {}, 8000).catch(() => []),
            cpRequest('listGroups', {}, 8000).catch(() => []),
            cpRequest('listRemotes', {}, 8000).catch(() => []),
            cpRequest('listDeadSessions', { user: linuxUser }, 8000).catch(() => []),
          ]);
          if (ws.readyState === 1) ws.send(JSON.stringify({
            type: 'picklists',
            users: Array.isArray(users) ? users : [],
            groups: Array.isArray(groups) ? groups : [],
            remotes: Array.isArray(remotes) ? remotes : [],
            deadSessions: Array.isArray(deadSessions) ? deadSessions : [],
          }));
        } catch (err) {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'picklists', users: [], groups: [], remotes: [], deadSessions: [] }));
        }
        return;
      }

      // Screen data over WS (replaces GET /api/pane for screen heal)
      if (msg.type === 'get-screen') {
        try {
          const session = msg.session;
          const pane = msg.pane || '0';
          if (!session || !validateParam(session)) throw new Error('Invalid session');
          if (!validateParam(pane)) throw new Error('Invalid pane');
          if (STRICT_SESSION_AUTHZ && !authorizeSession(user, session)) {
            throw new Error('Not authorized');
          }
          const cpUser = user.linux_user || CP_DEFAULT_USER;
          const state = await cpRequest('getSessionScreen', { sessionId: session, user: cpUser }, 3000);
          state.type = 'screen';
          state.session = session;
          state.pane = pane;
          state.scrollOffset = 0;
          if (ws.readyState === 1) ws.send(JSON.stringify(state));
        } catch (err) {
          if (ws.readyState === 1) ws.send(JSON.stringify({
            type: 'error', session: msg.session || null, message: 'Screen fetch failed'
          }));
        }
        return;
      }

      // Session list over WS (replaces GET /api/sessions for fork/restart dialogs)
      if (msg.type === 'get-sessions') {
        try {
          const cpUser = user.linux_user || CP_DEFAULT_USER;
          const cpSessions = await cpRequest('listSessions', { user: cpUser }, 2000);
          const sessions = (cpSessions || []).map(s => ({
            name: s.id || s.name,
            cpId: s.id,
            displayName: s.name,
            windows: 1,
            cols: s.cols || 80,
            rows: s.rows || 24,
            title: s.title,
            source: 'claude-proxy',
            launchProfile: s.launchProfile,
          }));
          const filtered = STRICT_SESSION_AUTHZ
            ? sessions.filter(s => authorizeSession(user, s.name))
            : sessions;
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'sessions', sessions: filtered }));
        } catch (err) {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'sessions', sessions: [] }));
        }
        return;
      }

      // Focus message — currently a no-op (all sessions are cp-bridged, no local timers).
      // TODO: Forward focus state to claude-proxy so TerminalMirror can adjust poll rate.
      if (msg.type === 'focus') return;

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

      // Session authorization for input/resize/scroll
      if (STRICT_SESSION_AUTHZ && !authorizeSession(user, session)) {
        if (ws.readyState === 1) ws.send(JSON.stringify({
          type: 'error', session: session, message: 'Not authorized'
        }));
        return;
      }
      if (STRICT_SESSION_AUTHZ && msg.type === 'input') {
        const perms = sessionPermCache.get(session);
        if (perms && perms.viewOnly) {
          if (ws.readyState === 1) ws.send(JSON.stringify({
            type: 'error', session: session, message: 'Session is view-only'
          }));
          return;
        }
      }

      // All sessions go through claude-proxy — input/scroll/resize via JSON-RPC.
      const watcher = sessionWatchers.get(session + ':' + pane);
      const cpSocketBridge = watcher && watcher._cpTerminalHandler;

      if (!cpSocketBridge) {
        // Session not bridged — shouldn't happen, all sessions are cp-managed
        process.stderr.write('[ws/dashboard] no bridge for session ' + session + '\n');
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', session, message: 'Session not found' }));
        return;
      }

      {
        const fwd = { ...msg };
        delete fwd.session;
        delete fwd.pane;
        try {
          if (fwd.type === 'input') {
            // Fire-and-forget: don't await — response isn't used, screen updates
            // arrive via the separate TerminalMirror event stream. Awaiting serializes
            // keystrokes and causes chunky input on held keys.
            cpRequest('input', {
              sessionId: session,
              user: cpUserDash,
              body: {
                keys: fwd.keys,
                specialKey: fwd.specialKey,
                ctrl: fwd.ctrl,
                alt: fwd.alt,
                repeat: fwd.repeat,
              },
            }).catch(err => process.stderr.write('[cp input] ' + (err.message || err) + '\n'));
          } else if (fwd.type === 'resize') {
            await cpRequest('resize', {
              sessionId: session,
              user: cpUserDash,
              cols: fwd.cols,
              rows: fwd.rows,
            });
          } else if (fwd.type === 'scroll') {
            // Fire-and-forget: don't await — scroll response arrives as screen
            // message via TerminalMirror. Awaiting serializes rapid scroll events.
            cpRequest('scroll', {
              sessionId: session,
              user: cpUserDash,
              offset: fwd.offset,
            }).catch(err => process.stderr.write('[cp scroll] ' + (err.message || err) + '\n'));
          }
        } catch (err) {
          process.stderr.write('[ws/dashboard] cp-bridge error: ' + (err.message || err) + '\n');
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'error', message: 'Session communication error' }));
          }
        }
        return;
      }
    } catch (err) {
      console.error('[ws/dashboard] message error:', err);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', message: 'Message processing error' }));
      }
    }
  });

  ws.on('close', () => {
    if (req._apiKey && apiKeyStore) apiKeyStore.releaseWs(req._apiKey);
    unsubscribeFromAll(ws);
    dashboardClients.delete(ws);
  });
  ws.on('error', () => {
    if (req._apiKey && apiKeyStore) apiKeyStore.releaseWs(req._apiKey);
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
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  };
  if (CORS_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = CORS_ORIGIN;
    headers['Vary'] = 'Origin';
  } else {
    headers['Access-Control-Allow-Origin'] = '*';
  }
  res.writeHead(200, headers);
  res.write('retry: 3000\n\n');

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

// ---------------------------------------------------------------------------
// Proxy handler — fetches external URL, strips X-Frame-Options/CSP headers
// ---------------------------------------------------------------------------

const PROXY_BLOCKED_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
]);

/** Check if a hostname resolves to a private/internal IP range (SSRF protection). */
function isPrivateHost(hostname) {
  // Block obvious private hostnames
  if (hostname === 'localhost' || hostname === 'localhost.localdomain') return true;
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  // Check IP address patterns
  const ip = hostname;
  // IPv6 loopback
  if (ip === '::1' || ip === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
  // IPv6 unique local (fc00::/7)
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  // IPv4
  const parts = ip.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 127) return true;                     // 127.0.0.0/8
    if (a === 10) return true;                      // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;        // 192.168.0.0/16
    if (a === 169 && b === 254) return true;        // 169.254.0.0/16 (link-local, AWS metadata)
    if (a === 0) return true;                       // 0.0.0.0/8
  }
  return false;
}

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

  // SSRF protection: block private/internal IP ranges
  if (isPrivateHost(parsed.hostname)) {
    return sendError(res, 403, 'Proxying to private/internal addresses is not allowed');
  }

  const client = parsed.protocol === 'https:' ? https : http;
  const opts = { timeout: 10000 };
  const proxyReq = client.get(targetUrl, opts, (proxyRes) => {
    // Follow redirects (up to 5)
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      const redirectUrl = new URL(proxyRes.headers.location, targetUrl).href;
      // SSRF check on redirect target too
      try {
        const redirectParsed = new URL(redirectUrl);
        if (isPrivateHost(redirectParsed.hostname)) {
          return sendError(res, 403, 'Redirect to private/internal address blocked');
        }
      } catch {
        return sendError(res, 400, 'Invalid redirect URL');
      }
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

function parseCsrfCookie(req) {
  const header = req.headers.cookie || '';
  const match = header.match(/cp_csrf=([^;]+)/);
  return match ? match[1] : null;
}

/** Validate CSRF double-submit cookie: cookie value must match X-CSRF-Token header. */
function validateCsrf(req, res) {
  if (!AUTH_ENABLED) return true; // No CSRF needed when auth is off
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  const cookieToken = parseCsrfCookie(req);
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    sendError(res, 403, 'CSRF token mismatch');
    return false;
  }
  return true;
}

/** Set CSRF cookie if not already present. Non-HttpOnly so JS can read it. */
function ensureCsrfCookie(req, res) {
  if (!AUTH_ENABLED) return;
  const existing = parseCsrfCookie(req);
  if (!existing) {
    const token = randomBytes(24).toString('base64url');
    res.setHeader('Set-Cookie', [
      res.getHeader('Set-Cookie') || [],
      'cp_csrf=' + token + '; Path=/; SameSite=Lax; Max-Age=' + COOKIE_MAX_AGE,
    ].flat().filter(Boolean));
  }
}

function getAuthUser(req) {
  if (AUTH_MODE === 'dev' && !hasOAuthProviders) {
    // Dev mode: check cookie exists (set after dev password login)
    const token = parseCookie(req);
    if (!token) return null;
    const payload = validateSessionCookie(token, AUTH_SECRET);
    if (!payload) return null;
    return { email: 'dev@localhost', status: 'approved', linux_user: 'root',
      display_name: 'Development', can_approve_users: 1, can_approve_admins: 1, can_approve_sudo: 1 };
  }
  const token = parseCookie(req);
  if (!token) return null;
  const payload = validateSessionCookie(token, AUTH_SECRET);
  if (!payload) return null;
  return userStore.findByEmail(payload.email);
}

function requireAuth(req, res) {
  const user = getAuthUser(req);
  if (!user) { res.writeHead(302, { Location: '/login' }); res.end(); return null; }
  if (user.status === 'pending') { const checkToken = randomBytes(16).toString('base64url'); pendingCheckTokens.set(checkToken, { email: user.email, expires: Date.now() + 3600000 }); res.writeHead(302, { Location: '/pending?email=' + encodeURIComponent(user.email) + '&check=' + checkToken }); res.end(); return null; }
  if (user.status === 'denied') { res.writeHead(302, { Location: '/login?error=Access+denied' }); res.end(); return null; }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.linux_user === 'root' || user.can_approve_users || user.can_approve_admins || user.can_approve_sudo || user.is_superadmin) return user;
  sendError(res, 403, 'Admin access required'); return null;
}

function requireSudo(user) {
  if (!user) return false;
  const expiry = sudoWindows.get(user.email);
  return expiry && Date.now() < expiry;
}

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** Send error from a caught exception, respecting statusCode if set (e.g. 413 from readBody). */
function sendCaughtError(res, err, fallbackStatus = 500) {
  if (res.headersSent) return;
  const status = err.statusCode || fallbackStatus;
  sendError(res, status, status === 413 ? 'Request body too large' : 'Internal server error');
}

const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' wss: https://cdn.jsdelivr.net",
  "img-src 'self' data:",
  "object-src 'self'",
  "base-uri 'self'",
].join('; ');

function serveHtml(req, res, filename) {
  try {
    const content = readFileSync(staticPath(filename));
    setCors(res);
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', CSP_HEADER);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.writeHead(200);
    res.end(content);
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

  // Dev mode: restrict to localhost if DEV_LOCALHOST_ONLY is enabled
  if (AUTH_MODE === 'dev' && DEV_LOCALHOST_ONLY) {
    const rawIp = req.socket.remoteAddress;
    if (rawIp !== '127.0.0.1' && rawIp !== '::1' && rawIp !== '::ffff:127.0.0.1') {
      sendError(res, 403, 'Dev mode is restricted to localhost');
      return;
    }
  }

  // CSRF validation for state-changing requests (skip auth endpoints which use OAuth state)
  if (!pathname.startsWith('/auth/') && !validateCsrf(req, res)) return;

  // Set CSRF cookie on page loads
  ensureCsrfCookie(req, res);

  // Favicon (public)
  if (pathname === '/favicon.ico' || pathname === '/favicon.svg' || pathname === '/favicon-nocursor.svg') {
    try {
      const fname = pathname === '/favicon-nocursor.svg' ? 'favicon-nocursor.svg' : 'favicon.svg';
      const content = readFileSync(staticPath(fname));
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.writeHead(200);
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
    return;
  }

  // Auth pages (public — no auth required)
  if (pathname === '/login') {
    // Dev mode password login
    if (AUTH_MODE === 'dev' && !hasOAuthProviders && req.method === 'POST') {
      const ip = getClientIp(req);
      if (!authRateLimiter.check(ip)) { sendError(res, 429, 'Too many attempts — try again later'); return; }
      (async () => {
        try {
          const body = await readBody(req);
          const { password } = JSON.parse(body);
          if (password !== DEV_PASSWORD) { authRateLimiter.recordFailure(ip); sendError(res, 401, 'Invalid password'); return; }
          authRateLimiter.recordSuccess(ip);
          const cookie = createSessionCookie({ email: 'dev@localhost', displayName: 'Development' }, AUTH_SECRET, COOKIE_MAX_AGE);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': COOKIE_NAME + '=' + cookie + '; HttpOnly; Path=/; Max-Age=' + COOKIE_MAX_AGE + '; SameSite=Lax',
          });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) { sendCaughtError(res, err); }
      })();
      return;
    }
    return serveHtml(req, res, 'login.html');
  }
  if (pathname === '/pending') return serveHtml(req, res, 'pending.html');
  // admin-client.mjs moved behind auth gate (Task 8)

  if (pathname === '/auth/api-key') {
    const ip = getClientIp(req);
    if (!apiKeyRateLimiter.check(ip)) { sendError(res, 429, 'Too many API key requests'); return; }
    const user = getAuthUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
    const browserUid = url.searchParams.get('uid') || null;
    const key = apiKeyStore.issue(user.email, user.linux_user || CP_DEFAULT_USER, browserUid);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ key }));
    return;
  }

  // /auth/ws-token REMOVED — replaced by /auth/api-key in Phase 2

  if (pathname === '/auth/me') {
    const user = getAuthUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
    return sendJson(res, 200, { email: user.email, displayName: user.display_name, status: user.status,
      linuxUser: user.linux_user, canApprove: !!(user.can_approve_users || user.can_approve_admins || user.can_approve_sudo) });
  }

  if (pathname === '/auth/status') {
    const email = url.searchParams.get('email');
    const checkToken = url.searchParams.get('check');
    if (!email || !checkToken) return sendError(res, 400, 'Missing parameters');
    const entry = pendingCheckTokens.get(checkToken);
    if (!entry || entry.email !== email || Date.now() > entry.expires) {
      return sendError(res, 403, 'Invalid or expired check token');
    }
    // Consume the token (single-use to prevent replay)
    pendingCheckTokens.delete(checkToken);

    const user = userStore.findByEmail(email);
    if (!user) return sendJson(res, 404, { status: 'unknown' });
    if (user.status === 'approved') {
      // Issue a fresh session cookie and return approved status
      const cookie = createSessionCookie({ email: user.email, displayName: user.display_name }, AUTH_SECRET, COOKIE_MAX_AGE);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': COOKIE_NAME + '=' + cookie + '; HttpOnly; Path=/; Max-Age=' + COOKIE_MAX_AGE + '; SameSite=Lax',
      });
      res.end(JSON.stringify({ status: 'approved' }));
      return;
    }
    // Still pending — issue a fresh check token for the next click
    const newToken = randomBytes(16).toString('base64url');
    pendingCheckTokens.set(newToken, { email, expires: Date.now() + 3600000 });
    return sendJson(res, 200, { status: user.status, check: newToken });
  }

  if (req.method === 'POST' && pathname === '/auth/logout') {
    res.writeHead(302, { Location: '/login', 'Set-Cookie': COOKIE_NAME + '=; HttpOnly; Path=/; Max-Age=0' });
    res.end(); return;
  }

  if (pathname === '/auth/callback') {
    (async () => {
      try {
        const callbackUrl = (process.env.PUBLIC_URL || ('http://localhost:' + port)) + '/auth/callback';
        const query = { state: url.searchParams.get('state'), code: url.searchParams.get('code'), iss: url.searchParams.get('iss') };
        const identity = await handleCallback(callbackUrl, query, AUTH_PROVIDERS);
        // Check provider link first — handles multi-provider login (different email, same user)
        let user = userStore.findByProvider(identity.provider, identity.providerId);
        if (!user) user = userStore.findByEmail(identity.email);
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
            const checkToken = randomBytes(16).toString('base64url'); pendingCheckTokens.set(checkToken, { email: identity.email, expires: Date.now() + 3600000 }); res.writeHead(302, { Location: '/pending?email=' + encodeURIComponent(identity.email) + '&check=' + checkToken }); res.end(); return;
          }
        }
        if (!userStore.findByProvider(identity.provider, identity.providerId)) {
          userStore.linkProvider(user.email, identity.provider, identity.providerId);
        }
        userStore.updateLastLogin(user.email);
        if (user.status === 'pending') { const checkToken = randomBytes(16).toString('base64url'); pendingCheckTokens.set(checkToken, { email: user.email, expires: Date.now() + 3600000 }); res.writeHead(302, { Location: '/pending?email=' + encodeURIComponent(user.email) + '&check=' + checkToken }); res.end(); return; }
        if (user.status === 'denied') { res.writeHead(302, { Location: '/login?error=Access+denied' }); res.end(); return; }
        const cookie = createSessionCookie({ email: user.email, displayName: user.display_name || identity.displayName }, AUTH_SECRET, COOKIE_MAX_AGE);
        res.writeHead(302, { Location: '/', 'Set-Cookie': COOKIE_NAME + '=' + cookie + '; HttpOnly; Path=/; Max-Age=' + COOKIE_MAX_AGE + '; SameSite=Lax' });
        res.end();
      } catch (err) {
        console.error('[AUTH] callback error:', err);
        // Don't leak internal error details to the client
        const safeMsg = /No verified|not configured|Missing state/i.test(err.message) ? err.message : 'Authentication failed';
        res.writeHead(302, { Location: '/login?error=' + encodeURIComponent(safeMsg) }); res.end();
      }
    })();
    return;
  }

  if (pathname.startsWith('/auth/')) {
    const ip = getClientIp(req);
    if (!oauthInitRateLimiter.check(ip)) { sendError(res, 429, 'Too many attempts'); return; }
    const provider = pathname.split('/')[2];
    (async () => {
      try {
        const callbackUrl = (process.env.PUBLIC_URL || ('http://localhost:' + port)) + '/auth/callback';
        const result = await getAuthUrlAsync(provider, AUTH_PROVIDERS, callbackUrl);
        res.writeHead(302, { Location: result.url }); res.end();
      } catch (err) {
        res.writeHead(302, { Location: '/login?error=' + encodeURIComponent(err.message) }); res.end();
      }
    })();
    return;
  }

  // SSE command channel (requires auth)
  if (pathname === '/api/events') {
    if (AUTH_ENABLED) {
      const user = getAuthUser(req);
      if (!user || user.status !== 'approved') {
        res.writeHead(401); res.end('Unauthorized'); return;
      }
    }
    return handleSSE(req, res);
  }
  if (req.method === 'POST' && pathname === '/api/admin/reload') {
    const u = requireAdmin(req, res); if (!u) return;
    broadcast('reload', {});
    return sendJson(res, 200, { ok: true, clients: sseClients.size });
  }
  if (pathname === '/api/admin/clients') {
    const u = requireAdmin(req, res); if (!u) return;
    return sendJson(res, 200, { count: sseClients.size });
  }
  if (pathname === '/api/admin/throttle') {
    const u = requireAdmin(req, res); if (!u) return;
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
  if (pathname === '/api/admin/pending') {
    const u = requireAdmin(req, res); if (!u) return;
    const pending = userStore.listPending().map(p => ({
      ...p,
      suggested_username: generateUsername(p.email),
    }));
    return sendJson(res, 200, pending);
  }
  if (pathname === '/api/admin/users') {
    const u = requireAdmin(req, res); if (!u) return;
    const users = userStore.listUsers().map(usr => ({
      ...usr,
      providers: userStore.getProviderLinks(usr.email),
    }));
    return sendJson(res, 200, users);
  }

  if (pathname === '/api/admin/deactivated') {
    const u = requireAdmin(req, res); if (!u) return;
    return sendJson(res, 200, userStore.listDeactivated());
  }

  if (pathname === '/api/admin/check-username') {
    const u = requireAdmin(req, res); if (!u) return;
    const raw = url.searchParams.get('username');
    if (!raw) return sendError(res, 400, 'Missing username');
    const username = raw.startsWith('cp-') ? raw : 'cp-' + raw;
    const linuxExists = userExists(username);
    const dbUser = userStore.findByLinuxUser(username);
    return sendJson(res, 200, {
      username,
      linuxExists,
      dbUser: dbUser ? { email: dbUser.email, displayName: dbUser.display_name, status: dbUser.status } : null,
    });
  }

  if (req.method === 'POST' && pathname === '/api/admin/approve') {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      const body = await readBody(req);
      const { email, username, assignExisting, mergeInto } = JSON.parse(body);
      const target = userStore.findByEmail(email);
      if (!target) return sendError(res, 404, 'User not found');

      // Merge into existing user
      if (mergeInto) {
        const primary = userStore.findByEmail(mergeInto);
        if (!primary) return sendError(res, 404, 'Merge target "' + mergeInto + '" not found');
        userStore.mergeUser(email, mergeInto);
        sendJson(res, 200, { ok: true, merged: true, primaryEmail: mergeInto });
        return;
      }

      const linuxUser = username ? (username.startsWith('cp-') ? username : 'cp-' + username) : generateUsername(email);
      if (!linuxUser.startsWith('cp-')) return sendError(res, 400, 'Username must start with cp-');
      if (userExists(linuxUser) && !assignExisting) {
        return sendError(res, 409, 'Linux user "' + linuxUser + '" already exists — confirm to assign');
      }
      if (!userExists(linuxUser)) {
        createSystemAccount(linuxUser, target.display_name);
      }
      addToGroup(linuxUser, 'users');
      userStore.approveUser(email, u.email || 'root');
      userStore.setLinuxUser(email, linuxUser);
      sendJson(res, 200, { ok: true });
    })().catch(err => sendCaughtError(res, err));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/deny') {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      const body = await readBody(req);
      const { email } = JSON.parse(body);
      userStore.denyUser(email);
      sendJson(res, 200, { ok: true });
    })().catch(err => sendCaughtError(res, err));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/pre-approve') {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      const body = await readBody(req);
      const { emails } = JSON.parse(body);
      userStore.preApprove(emails, u.email || 'root');
      sendJson(res, 200, { ok: true });
    })().catch(err => sendCaughtError(res, err));
    return;
  }

  if (pathname.startsWith('/api/admin/user/') && pathname.endsWith('/providers')) {
    const u = requireAdmin(req, res); if (!u) return;
    const userEmail = decodeURIComponent(pathname.split('/')[4]);
    if (req.method === 'GET') {
      const links = userStore.getProviderLinks(userEmail);
      return sendJson(res, 200, links);
    }
    if (req.method === 'DELETE') {
      (async () => {
        const body = await readBody(req);
        const { provider, providerId } = JSON.parse(body);
        // Don't allow unlinking the last provider
        const links = userStore.getProviderLinks(userEmail);
        if (links.length <= 1) return sendError(res, 400, 'Cannot remove the only login method');
        userStore.unlinkProvider(provider, providerId);
        sendJson(res, 200, { ok: true });
      })().catch(err => sendCaughtError(res, err));
      return;
    }
    return sendError(res, 405, 'GET or DELETE only');
  }

  if (req.method === 'PATCH' && pathname.startsWith('/api/admin/user/') && pathname.endsWith('/flags')) {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      if (!privilegedActionRateLimiter.check(u.email)) { sendError(res, 429, 'Too many privileged actions'); return; }
      if (!requireSudo(u)) return sendJson(res, 403, { error: 'sudo-required', message: 'Enter your admin PIN to continue' });
      if (!u.can_approve_admins && !u.can_approve_sudo && u.linux_user !== 'root') return sendError(res, 403, 'Insufficient permissions');
      const email = decodeURIComponent(pathname.split('/')[4]);
      const body = await readBody(req);
      const flags = JSON.parse(body);
      userStore.updateFlags(email, flags);
      sendJson(res, 200, { ok: true });
    })().catch(err => sendCaughtError(res, err));
    return;
  }

  // Deactivate user (soft delete: cp- → cpx-, remove logins, status=deactivated)
  if (req.method === 'POST' && pathname === '/api/admin/deactivate') {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      if (!privilegedActionRateLimiter.check(u.email)) { sendError(res, 429, 'Too many privileged actions'); return; }
      if (!requireSudo(u)) return sendJson(res, 403, { error: 'sudo-required', message: 'Enter your admin PIN to continue' });
      const body = await readBody(req);
      const { email } = JSON.parse(body);
      if (email === u.email) return sendError(res, 400, 'Cannot deactivate yourself');
      const target = userStore.findByEmail(email);
      if (!target) return sendError(res, 404, 'User not found');
      if (target.status === 'deactivated') return sendError(res, 400, 'Already deactivated');
      let deactivatedName = target.linux_user;
      if (target.linux_user && target.linux_user.startsWith('cp-')) {
        deactivatedName = deactivateAccount(target.linux_user);
        userStore.setLinuxUser(email, deactivatedName);
      }
      userStore.deactivateUser(email);
      sendJson(res, 200, { ok: true, linuxUser: deactivatedName });
    })().catch(err => sendCaughtError(res, err));
    return;
  }

  // Reactivate user (cpx- → cp-, status=pending, must re-authenticate)
  if (req.method === 'POST' && pathname === '/api/admin/reactivate') {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      const body = await readBody(req);
      const { email } = JSON.parse(body);
      const target = userStore.findByEmail(email);
      if (!target) return sendError(res, 404, 'User not found');
      if (target.status !== 'deactivated') return sendError(res, 400, 'User is not deactivated');
      let restoredName = target.linux_user;
      if (target.linux_user && target.linux_user.startsWith('cpx-')) {
        restoredName = reactivateAccount(target.linux_user);
        userStore.setLinuxUser(email, restoredName);
      }
      userStore.reactivateUser(email);
      sendJson(res, 200, { ok: true, linuxUser: restoredName });
    })().catch(err => sendCaughtError(res, err));
    return;
  }

  // Purge user (permanently delete cpx- account + DB entry)
  if (req.method === 'POST' && pathname === '/api/admin/purge') {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      if (!privilegedActionRateLimiter.check(u.email)) { sendError(res, 429, 'Too many privileged actions'); return; }
      if (!requireSudo(u)) return sendJson(res, 403, { error: 'sudo-required', message: 'Enter your admin PIN to continue' });
      const body = await readBody(req);
      const { email } = JSON.parse(body);
      const target = userStore.findByEmail(email);
      if (!target) return sendError(res, 404, 'User not found');
      if (target.status !== 'deactivated') return sendError(res, 400, 'User must be deactivated before purging');
      if (target.linux_user && target.linux_user.startsWith('cpx-')) {
        try { purgeAccount(target.linux_user); } catch (e) { /* best effort */ }
      }
      userStore.deleteUser(email);
      sendJson(res, 200, { ok: true });
    })().catch(err => sendCaughtError(res, err));
    return;
  }

  // Edit Linux username
  if (req.method === 'PATCH' && pathname.startsWith('/api/admin/user/') && pathname.endsWith('/linux-user')) {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      const email = decodeURIComponent(pathname.split('/')[4]);
      const target = userStore.findByEmail(email);
      if (!target) return sendError(res, 404, 'User not found');
      const body = await readBody(req);
      const { linux_user } = JSON.parse(body);
      if (!linux_user || !linux_user.startsWith('cp-')) return sendError(res, 400, 'Username must start with cp-');
      // Check for conflicts
      const existing = userStore.findByLinuxUser(linux_user);
      if (existing && existing.email !== email) return sendError(res, 409, 'Linux user "' + linux_user + '" already assigned to ' + existing.email);
      userStore.setLinuxUser(email, linux_user);
      sendJson(res, 200, { ok: true });
    })().catch(err => sendCaughtError(res, err));
    return;
  }

  // Merge users
  if (req.method === 'POST' && pathname === '/api/admin/merge') {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      if (!privilegedActionRateLimiter.check(u.email)) { sendError(res, 429, 'Too many privileged actions'); return; }
      if (!requireSudo(u)) return sendJson(res, 403, { error: 'sudo-required', message: 'Enter your admin PIN to continue' });
      const body = await readBody(req);
      const { sourceEmail, targetEmail } = JSON.parse(body);
      if (!sourceEmail || !targetEmail) return sendError(res, 400, 'sourceEmail and targetEmail required');
      if (sourceEmail === targetEmail) return sendError(res, 400, 'Cannot merge user into themselves');
      const source = userStore.findByEmail(sourceEmail);
      const target = userStore.findByEmail(targetEmail);
      if (!source) return sendError(res, 404, 'Source user not found');
      if (!target) return sendError(res, 404, 'Target user not found');
      userStore.mergeUser(sourceEmail, targetEmail);
      sendJson(res, 200, { ok: true });
    })().catch(err => sendCaughtError(res, err));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/set-pin') {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      const body = await readBody(req);
      const { pin } = JSON.parse(body);
      if (!pin || pin.length < 4 || pin.length > 20) return sendError(res, 400, 'PIN must be 4-20 characters');
      await userStore.setAdminPin(u.email, pin);
      sendJson(res, 200, { ok: true });
    })().catch(err => sendCaughtError(res, err));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/verify-pin') {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      const body = await readBody(req);
      const { pin } = JSON.parse(body);
      const valid = await userStore.verifyAdminPin(u.email, pin);
      if (!valid) return sendError(res, 403, 'Invalid PIN');
      sudoWindows.set(u.email, Date.now() + 15 * 60 * 1000);
      sendJson(res, 200, { ok: true });
    })().catch(err => sendCaughtError(res, err));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/force-relogin') {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      if (!privilegedActionRateLimiter.check(u.email)) { sendError(res, 429, 'Too many privileged actions'); return; }
      if (!requireSudo(u)) return sendJson(res, 403, { error: 'sudo-required', message: 'Enter your admin PIN to continue' });
      const body = await readBody(req);
      const { email } = JSON.parse(body);
      if (!email) return sendError(res, 400, 'Missing email');
      if (apiKeyStore) apiKeyStore.revokeAllForUser(email);
      for (const ws of dashboardClients) {
        if (ws._userEmail === email && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'reauth-required', reason: 'admin-revoked' }));
        }
      }
      sendJson(res, 200, { ok: true });
    })().catch(err => sendCaughtError(res, err));
    return;
  }

  // Add user manually
  if (req.method === 'POST' && pathname === '/api/admin/add-user') {
    (async () => {
      const u = requireAdmin(req, res); if (!u) return;
      const body = await readBody(req);
      const { email, display_name, linux_user, status, is_admin } = JSON.parse(body);
      if (!email) return sendError(res, 400, 'Email required');
      if (userStore.findByEmail(email)) return sendError(res, 409, 'User already exists');
      if (linux_user && !linux_user.startsWith('cp-')) return sendError(res, 400, 'Username must start with cp-');
      if (linux_user) {
        const existing = userStore.findByLinuxUser(linux_user);
        if (existing) return sendError(res, 409, 'Linux user "' + linux_user + '" already assigned to ' + existing.email);
      }
      const userStatus = status === 'approved' ? 'approved' : 'pending';
      userStore.db.prepare(
        'INSERT INTO users (email, display_name, linux_user, status, approved_by, can_approve_users, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(email, display_name || email.split('@')[0], linux_user || null, userStatus, u.email || 'root', is_admin ? 1 : 0, new Date().toISOString());
      // Create Linux account if approved and username provided
      if (userStatus === 'approved' && linux_user) {
        if (!userExists(linux_user)) {
          createSystemAccount(linux_user, display_name || email.split('@')[0]);
        }
        addToGroup(linux_user, 'users');
      }
      sendJson(res, 200, { ok: true });
    })().catch(err => sendCaughtError(res, err));
    return;
  }

  // Auth middleware — protect all remaining routes
  // Cookie auth is sufficient for: /, static files, admin panel
  // API data endpoints require an active API key (or cookie for admin panel)
  if (AUTH_ENABLED) {
    const user = requireAuth(req, res);
    if (!user) return;

  }

  if (pathname === '/admin-client.mjs') return serveJs(req, res, 'admin-client.mjs');

  if (req.method === 'GET') {
    if (pathname === '/') {
      if (AUTH_ENABLED) {
        const user = getAuthUser(req);
        if (!user || user.status !== 'approved') {
          res.writeHead(302, { Location: '/login' });
          res.end();
          return;
        }
      }
      // Auto-redirect mobile User-Agents to /mobile
      const ua = (req.headers['user-agent'] || '').toLowerCase();
      const isMobile = /mobile|android|iphone|ipad|ipod|webos|blackberry|opera mini|iemobile/i.test(ua);
      if (isMobile) {
        res.writeHead(302, { Location: '/mobile' });
        res.end();
        return;
      }
      return handleRoot(req, res);
    }
    if (pathname === '/mobile') {
      if (AUTH_ENABLED) {
        const user = getAuthUser(req);
        if (!user || user.status !== 'approved') {
          res.writeHead(302, { Location: '/login' });
          res.end();
          return;
        }
      }
      return handleMobile(req, res);
    }
    if (pathname === '/desktop') {
      if (AUTH_ENABLED) {
        const user = getAuthUser(req);
        if (!user || user.status !== 'approved') {
          res.writeHead(302, { Location: '/login' });
          res.end();
          return;
        }
      }
      return handleRoot(req, res);
    }
    if (pathname === '/terminal.svg') {
      return handleSvg(req, res);
    }
    // STUB — TO BE FINISHED/COMPLETED: layout persistence per authenticated user.
    // Currently stores layout as JSON file keyed by user email.
    // Future: richer profile system with preferences, theme, default sessions.
    if (pathname === '/api/layout') {
      setCors(res);
      const user = getAuthUser(req);
      if (!user) { sendJson(res, 200, {}); return; }
      // Use user email as profile key (sanitized for filesystem)
      const safeKey = user.email.replace(/[^a-zA-Z0-9@._-]/g, '_');
      const profileDir = staticPath('profiles');
      if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      const profilePath = profileDir + '/' + safeKey + '.json';

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
        (async () => {
          try {
            const body = await readBody(req);
            JSON.parse(body); // validate JSON
            writeFileSync(profilePath, body, { mode: 0o600 });
            sendJson(res, 200, { ok: true });
          } catch (err) {
            sendCaughtError(res, err);
          }
        })();
        return;
      }
      sendError(res, 405, 'GET or POST only');
      return;
    }
    if (pathname === '/api/proxy') {
      // When AUTH_ENABLED: admin-only. When AUTH_ENABLED=false (dev mode): proxy stays open (matches existing dev behavior).
      if (AUTH_ENABLED) {
        const proxyUser = requireAdmin(req, res);
        if (!proxyUser) return;
      }
      handleProxy(req, res, url.searchParams);
      return;
    }
    if (pathname === '/mockup') {
      return serveHtml(req, res, 'ui-web/top-menu-bar-mockup.html');
    }
    if (pathname === '/font-test.html') {
      try {
        const content = readFileSync(staticPath('font-test.html'));
        setCors(res);
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Security-Policy', CSP_HEADER);
        res.setHeader('X-Content-Type-Options', 'nosniff');
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
    if (pathname === '/mobile.css') {
      try {
        const content = readFileSync(staticPath('mobile.css'));
        setCors(res);
        res.setHeader('Content-Type', 'text/css');
        res.writeHead(200);
        res.end(content);
      } catch (err) {
        sendError(res, 500, 'Failed to read mobile.css');
      }
      return;
    }
    if (pathname === '/mobile.mjs') {
      try {
        const content = readFileSync(staticPath('mobile.mjs'));
        setCors(res);
        res.setHeader('Content-Type', 'application/javascript');
        res.writeHead(200);
        res.end(content);
      } catch (err) {
        sendError(res, 500, 'Failed to read mobile.mjs');
      }
      return;
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

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const remoteIp = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  process.stderr.write(`[WS] ${remoteIp} UPGRADE ${url.pathname}\n`);

  // Rate limit WS upgrades
  const wsIp = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  if (!wsUpgradeRateLimiter.check(wsIp)) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  // WebSocket auth: API key REQUIRED — no cookie/token fallback
  // Clients must fetch GET /auth/api-key first, then pass ?key= on WS URL
  if (AUTH_ENABLED) {
    const apiKey = url.searchParams.get('key');
    if (!apiKey || !apiKeyStore) {
      wsUpgradeRateLimiter.recordFailure(wsIp);
      process.stderr.write(`[WS] ${remoteIp} No API key for ${url.pathname}\n`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const identity = apiKeyStore.validate(apiKey);
    if (!identity) {
      wsUpgradeRateLimiter.recordFailure(wsIp);
      process.stderr.write(`[WS] ${remoteIp} Invalid API key for ${url.pathname}\n`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!apiKeyStore.claimWs(apiKey)) {
      process.stderr.write(`[WS] ${remoteIp} Duplicate WS connection for ${url.pathname}\n`);
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
      socket.destroy();
      return;
    }
    req._apiKey = apiKey;
    req._apiKeyIdentity = identity;
  }
  wsUpgradeRateLimiter.recordSuccess(wsIp);

  if (url.pathname === '/ws/dashboard') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleDashboardWs(ws, req).catch(err => {
        process.stderr.write('Dashboard WS error: ' + (err && err.message || err) + '\n');
        try { ws.close(); } catch {}
      });
    });
    return;
  }
  if (url.pathname === '/ws/terminal') {
    process.stderr.write(`[WS] ${remoteIp} REJECTED deprecated /ws/terminal\n`);
    socket.write('HTTP/1.1 410 Gone\r\n\r\n');
    socket.destroy();
    return;
  } else {
    socket.destroy();
  }
});

server.listen(port, () => {
  process.stderr.write(`svg-terminal server listening on port ${port}\n`);
});
