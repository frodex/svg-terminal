# Session Authorization & WebSocket Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Secure all session data paths with scoped API keys, consolidate HTTP endpoints onto the authorized WebSocket backchannel, harden dev mode, and add reconnection UX.

**Architecture:** Issue a scoped API key at login that identifies the user on all WebSocket connections. The key is stored server-side for instant revocation. All dashboard-to-server communication moves to the authenticated `/ws/dashboard` WebSocket — no more parallel HTTP endpoints for session data. Claude-proxy remains the session permission authority; svg-terminal faithfully passes user identity on every RPC call. Reconnection is transparent with a frosted-glass countdown overlay.

**Tech Stack:** Node.js (server.mjs), vanilla JS (dashboard.mjs), SQLite (user-store.mjs), HMAC-SHA256 (session-cookie.mjs)

**Research:** `docs/research/2026-04-05-v0.1-session-authorization-journal.md`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `server.mjs` | HTTP/WS server, auth, routing | Modify: add API key store, WS message handlers, remove redundant HTTP endpoints |
| `dashboard.mjs` | Browser dashboard | Modify: move HTTP calls to WS messages, add reconnection overlay, API key management |
| `dashboard.css` | Dashboard styles | Modify: add reconnection overlay styles |
| `index.html` | Dashboard HTML | Modify: add reconnection overlay DOM |
| `api-key-store.mjs` | Server-side API key management | Create: issue, validate, revoke, timeout |
| `session-cookie.mjs` | Cookie signing | No change (used by API key generation) |
| `user-store.mjs` | User database | No change |
| `admin-client.mjs` | Admin panel JS | Modify: add force-relogin button |
| `admin.html` | Admin panel HTML | Modify: add force-relogin UI |
| `terminal.svg` | SVG terminal card | Modify: remove legacy per-card WS connection |
| `login.html` | Login page | Modify: add dev-mode password form |
| `rate-limiter.mjs` | Per-IP/per-user rate limiting | Create: configurable rate limiter for auth + admin endpoints |

---

### Task 1: API Key Store

**Files:**
- Create: `api-key-store.mjs`
- Test: `test-api-key-store.mjs`

- [ ] **Step 1: Write failing tests for API key lifecycle**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiKeyStore } from './api-key-store.mjs';

describe('ApiKeyStore', () => {
  it('issues a key and validates it', () => {
    const store = new ApiKeyStore({ secret: 'test-secret' });
    const key = store.issue('greg@example.com', 'root');
    const result = store.validate(key);
    assert.equal(result.email, 'greg@example.com');
    assert.equal(result.linuxUser, 'root');
  });

  it('rejects an invalid key', () => {
    const store = new ApiKeyStore({ secret: 'test-secret' });
    const result = store.validate('garbage-key');
    assert.equal(result, null);
  });

  it('rejects a revoked key', () => {
    const store = new ApiKeyStore({ secret: 'test-secret' });
    const key = store.issue('greg@example.com', 'root');
    store.revoke(key);
    const result = store.validate(key);
    assert.equal(result, null);
  });

  it('revokes all keys for a user', () => {
    const store = new ApiKeyStore({ secret: 'test-secret' });
    const k1 = store.issue('greg@example.com', 'root');
    const k2 = store.issue('greg@example.com', 'root');
    const k3 = store.issue('aaron@example.com', 'cp-aaronb');
    store.revokeAllForUser('greg@example.com');
    assert.equal(store.validate(k1), null);
    assert.equal(store.validate(k2), null);
    assert.notEqual(store.validate(k3), null);
  });

  it('expires keys after idle timeout', () => {
    const store = new ApiKeyStore({ secret: 'test-secret', idleTimeoutMs: 100 });
    const key = store.issue('greg@example.com', 'root');
    // Simulate time passing
    store._keys.get(key).lastActivity = Date.now() - 200;
    const result = store.validate(key);
    assert.equal(result, null);
  });

  it('expires keys after absolute timeout', () => {
    const store = new ApiKeyStore({ secret: 'test-secret', absoluteTimeoutMs: 100 });
    const key = store.issue('greg@example.com', 'root');
    store._keys.get(key).issuedAt = Date.now() - 200;
    const result = store.validate(key);
    assert.equal(result, null);
  });

  it('touch updates lastActivity', () => {
    const store = new ApiKeyStore({ secret: 'test-secret', idleTimeoutMs: 500 });
    const key = store.issue('greg@example.com', 'root');
    const before = store._keys.get(key).lastActivity;
    store.touch(key);
    assert.ok(store._keys.get(key).lastActivity >= before);
  });

  it('lists active keys for a user', () => {
    const store = new ApiKeyStore({ secret: 'test-secret' });
    store.issue('greg@example.com', 'root');
    store.issue('greg@example.com', 'root');
    store.issue('aaron@example.com', 'cp-aaronb');
    const keys = store.listForUser('greg@example.com');
    assert.equal(keys.length, 2);
  });

  it('cleanup removes expired keys', () => {
    const store = new ApiKeyStore({ secret: 'test-secret', absoluteTimeoutMs: 100 });
    const key = store.issue('greg@example.com', 'root');
    store._keys.get(key).issuedAt = Date.now() - 200;
    store.cleanup();
    assert.equal(store._keys.size, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test-api-key-store.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ApiKeyStore**

```javascript
// api-key-store.mjs
import { randomBytes, createHmac } from 'node:crypto';

export class ApiKeyStore {
  constructor({ secret, idleTimeoutMs = 30 * 60 * 1000, absoluteTimeoutMs = 24 * 60 * 60 * 1000 }) {
    this._secret = secret;
    this._idleTimeoutMs = idleTimeoutMs;
    this._absoluteTimeoutMs = absoluteTimeoutMs;
    this._keys = new Map(); // key → { email, linuxUser, issuedAt, lastActivity, browserUid }
    // Periodic cleanup every 60s
    this._cleanupTimer = setInterval(() => this.cleanup(), 60000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  issue(email, linuxUser, browserUid) {
    const raw = randomBytes(32).toString('base64url');
    const hmac = createHmac('sha256', this._secret).update(raw).digest('base64url');
    const key = raw + '.' + hmac;
    this._keys.set(key, {
      email,
      linuxUser,
      browserUid: browserUid || null,
      issuedAt: Date.now(),
      lastActivity: Date.now(),
    });
    return key;
  }

  validate(key) {
    const entry = this._keys.get(key);
    if (!entry) return null;
    // Check HMAC
    const [raw, hmac] = key.split('.');
    if (!raw || !hmac) return null;
    const expected = createHmac('sha256', this._secret).update(raw).digest('base64url');
    if (hmac !== expected) { this._keys.delete(key); return null; }
    // Check idle timeout
    if (Date.now() - entry.lastActivity > this._idleTimeoutMs) {
      this._keys.delete(key);
      return null;
    }
    // Check absolute timeout
    if (Date.now() - entry.issuedAt > this._absoluteTimeoutMs) {
      this._keys.delete(key);
      return null;
    }
    return { email: entry.email, linuxUser: entry.linuxUser, browserUid: entry.browserUid };
  }

  touch(key) {
    const entry = this._keys.get(key);
    if (entry) entry.lastActivity = Date.now();
  }

  revoke(key) {
    this._keys.delete(key);
  }

  revokeAllForUser(email) {
    for (const [key, entry] of this._keys) {
      if (entry.email === email) this._keys.delete(key);
    }
  }

  listForUser(email) {
    const result = [];
    for (const [key, entry] of this._keys) {
      if (entry.email === email) {
        result.push({ key: key.slice(0, 8) + '...', browserUid: entry.browserUid,
          issuedAt: entry.issuedAt, lastActivity: entry.lastActivity });
      }
    }
    return result;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._keys) {
      if (now - entry.lastActivity > this._idleTimeoutMs || now - entry.issuedAt > this._absoluteTimeoutMs) {
        this._keys.delete(key);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test-api-key-store.mjs`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add api-key-store.mjs test-api-key-store.mjs
git commit -m "feat: add ApiKeyStore for server-side API key management"
```

---

### Task 2: Wire API Key Issuance into Auth Flow

**Files:**
- Modify: `server.mjs` — import ApiKeyStore, add `/auth/api-key` endpoint, replace `/auth/ws-token`

- [ ] **Step 1: Import and initialize ApiKeyStore in server.mjs**

At the imports section (near line 16), add:

```javascript
import { ApiKeyStore } from './api-key-store.mjs';
```

After `AUTH_SECRET` is set (after line ~75), add:

```javascript
const apiKeyStore = new ApiKeyStore({
  secret: AUTH_SECRET,
  idleTimeoutMs: 30 * 60 * 1000,   // 30 min idle timeout
  absoluteTimeoutMs: 24 * 60 * 60 * 1000, // 24h absolute timeout
});
```

- [ ] **Step 2: Replace `/auth/ws-token` with `/auth/api-key`**

Replace the `/auth/ws-token` endpoint with:

```javascript
if (pathname === '/auth/api-key') {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
  const browserUid = url.searchParams.get('uid') || null;
  const key = apiKeyStore.issue(user.email, user.linux_user || CP_DEFAULT_USER, browserUid);
  return sendJson(res, 200, {
    key,
    idleTimeoutMs: 30 * 60 * 1000,
    absoluteTimeoutMs: 24 * 60 * 60 * 1000,
  });
}
```

- [ ] **Step 3: Update WebSocket auth to validate API keys instead of session cookies**

Replace the WebSocket auth block (currently checking cookies + query tokens) with:

```javascript
// WebSocket auth: validate API key from query string
if (AUTH_ENABLED) {
  const apiKey = url.searchParams.get('key');
  const identity = apiKey ? apiKeyStore.validate(apiKey) : null;
  if (!identity) {
    process.stderr.write(`[WS] ${remoteIp} Unauthorized for ${url.pathname} | key: ${!!apiKey}\n`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  // Attach identity to request for downstream handlers
  req._apiKeyIdentity = identity;
  req._apiKey = apiKey;
}
```

- [ ] **Step 4: Update `handleDashboardWs` to use API key identity**

In `handleDashboardWs()` (around line 1172), replace the `getAuthUser(req)` call:

```javascript
async function handleDashboardWs(ws, req) {
  // Use API key identity attached by upgrade handler, fall back to cookie
  const user = req._apiKeyIdentity
    ? { email: req._apiKeyIdentity.email, linux_user: req._apiKeyIdentity.linuxUser, status: 'approved' }
    : getAuthUser(req);
  if (!user || (AUTH_ENABLED && user.status !== 'approved')) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
    ws.close();
    return;
  }
```

Also add periodic `touch()` on the API key — in the `ws.on('message')` handler, at the top:

```javascript
ws.on('message', async (data) => {
  if (req._apiKey) apiKeyStore.touch(req._apiKey);
  // ... rest of handler
```

- [ ] **Step 5: Verify server starts and existing tests pass**

Run: `systemctl restart svg-terminal && sleep 1 && systemctl is-active svg-terminal`
Expected: `active`

Run: `node --test test-api-key-store.mjs`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add server.mjs
git commit -m "feat: wire ApiKeyStore into auth flow, replace ws-token with api-key"
```

---

### Task 3: Dashboard Client — API Key + WS Consolidation

**Files:**
- Modify: `dashboard.mjs` — fetch API key, pass on WS, move HTTP calls to WS messages

- [ ] **Step 1: Replace WS token fetch with API key fetch**

In the `init()` function, replace the `/auth/ws-token` fetch chain with:

```javascript
  fetch('/auth/me', { credentials: 'same-origin' })
    .then(function(r) {
      if (!r.ok) { location.href = '/login'; throw new Error('not authenticated'); }
      return r.json();
    })
    .then(function(u) {
      var pill = document.getElementById('top-user-pill');
      if (pill) { pill.textContent = u.displayName || u.email || u.linuxUser || 'Signed in'; pill.title = u.email || ''; }
      var adminLink = document.getElementById('menu-admin');
      if (adminLink && u.canApprove) adminLink.style.display = '';
      return fetch('/auth/api-key?uid=' + encodeURIComponent(activeUid), { credentials: 'same-origin' });
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _apiKey = data.key;
      _apiKeyTimeouts = { idle: data.idleTimeoutMs, absolute: data.absoluteTimeoutMs };
      connectDashboardWs();
    })
    .catch(function(e) {
      if (e.message !== 'not authenticated') connectDashboardWs();
    });
```

- [ ] **Step 2: Update WS connect to use API key**

Replace `_wsAuthToken` references with `_apiKey`:

```javascript
var _apiKey = null;
var _apiKeyTimeouts = { idle: 0, absolute: 0 };
var _dashWsAuthFailures = 0;

function connectDashboardWs() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var keyParam = _apiKey ? '?key=' + encodeURIComponent(_apiKey) : '';
  var url = proto + '//' + location.host + '/ws/dashboard' + keyParam;
  var ws = new WebSocket(url);
  // ... rest unchanged
```

- [ ] **Step 3: Move session create/restart/fork to WS messages**

Replace the `csrfFetch('/api/sessions/create', ...)` call with:

```javascript
sendDashboardMessage({
  type: 'create-session',
  payload: payload
});
```

Do the same for restart and fork:

```javascript
sendDashboardMessage({ type: 'restart-session', payload: { deadId, settings } });
sendDashboardMessage({ type: 'fork-session', payload: { sourceId, settings } });
```

- [ ] **Step 4: Move layout save to WS message**

Replace the `csrfFetch('/api/layout', ...)` call with:

```javascript
sendDashboardMessage({ type: 'save-layout', layout: layoutData });
```

- [ ] **Step 5: Remove HTTP input path**

Replace the `csrfFetch('/api/input', ...)` call (legacy HTTP input) with a WS message. The dashboard WS `input` type already exists — verify it's used exclusively:

```javascript
// All input goes through the dashboard WS — no HTTP fallback
sendDashboardMessage({
  type: 'input',
  session: sessionName,
  keys: keys,
  specialKey: specialKey || undefined,
  ctrl: ctrl || undefined,
  alt: alt || undefined,
});
```

- [ ] **Step 6: Remove redundant session polling**

Remove or reduce the `setInterval(refreshSessions, 5000)` — sessions are already discovered via WS. Keep a longer fallback (30s) for resilience:

```javascript
setInterval(refreshSessions, 30000); // fallback only, WS handles real-time discovery
```

- [ ] **Step 7: Update WS reconnect to refresh API key**

In the `ws.onclose` handler, fetch a fresh API key before reconnecting:

```javascript
ws.onclose = function(ev) {
  dashboardWs = null;
  if (ev.code === 1006) _dashWsAuthFailures++;
  if (_dashWsAuthFailures >= 3) {
    showReconnectOverlay(0); // immediate redirect
    return;
  }
  showReconnectOverlay(_reconnectTimeoutSec);
  setTimeout(function() {
    fetch('/auth/api-key?uid=' + encodeURIComponent(activeUid), { credentials: 'same-origin' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data) { _apiKey = data.key; _dashWsAuthFailures = 0; }
        hideReconnectOverlay();
        connectDashboardWs();
      })
      .catch(function() {
        _dashWsAuthFailures++;
        if (_dashWsAuthFailures >= 3) showReconnectOverlay(0);
        else connectDashboardWs();
      });
  }, 2000);
};
```

- [ ] **Step 8: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: consolidate dashboard HTTP calls onto authenticated WS backchannel"
```

---

### Task 4: Server WS Message Handlers for Consolidated Operations

**Files:**
- Modify: `server.mjs` — add WS message types for create/restart/fork/layout/input

- [ ] **Step 1: Add WS message handlers in `handleDashboardWs`**

In the `ws.on('message')` handler, after the existing `subscribe` and `focus` handlers, add:

```javascript
// Session lifecycle over WS
if (msg.type === 'create-session') {
  try {
    const linuxUser = user.linux_user || CP_DEFAULT_USER;
    const result = await cpRequest('createSession', { user: linuxUser, body: msg.payload }, 120000);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'create-session-result', ok: true, session: result }));
  } catch (err) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'create-session-result', ok: false, error: err.message }));
  }
  return;
}

if (msg.type === 'restart-session') {
  try {
    const linuxUser = user.linux_user || CP_DEFAULT_USER;
    const result = await cpRequest('restartSession', { user: linuxUser, sessionId: msg.payload.deadId, settings: msg.payload.settings }, 120000);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'restart-session-result', ok: true, session: result }));
  } catch (err) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'restart-session-result', ok: false, error: err.message }));
  }
  return;
}

if (msg.type === 'fork-session') {
  try {
    const linuxUser = user.linux_user || CP_DEFAULT_USER;
    const result = await cpRequest('forkSession', { user: linuxUser, sessionId: msg.payload.sourceId, settings: msg.payload.settings }, 120000);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'fork-session-result', ok: true, session: result }));
  } catch (err) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'fork-session-result', ok: false, error: err.message }));
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
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'save-layout-result', ok: false, error: err.message }));
  }
  return;
}
```

- [ ] **Step 2: Fix hardcoded CP_DEFAULT_USER in all remaining paths**

In `handleDashboardWs`, the `cpUserDash` variable already uses `user.linux_user || CP_DEFAULT_USER`. Verify all input/resize/scroll/subscribe paths use `cpUserDash` not a hardcoded value. Check lines 1218, 1246-1270.

In `/api/pane` (line ~431), replace `CP_DEFAULT_USER` with the authenticated user's linux_user:

```javascript
const auth = getAuthUser(req);
const cpUser = auth ? (auth.linux_user || CP_DEFAULT_USER) : CP_DEFAULT_USER;
const state = await cpRequest('getSessionScreen', {
  sessionId: session,
  user: cpUser,
}, 3000);
```

In the legacy `/ws/terminal` handler (line ~2416), replace:

```javascript
attachCpToTerminalWs(clientWs, session, req._apiKeyIdentity ? req._apiKeyIdentity.linuxUser : CP_DEFAULT_USER);
```

- [ ] **Step 3: Commit**

```bash
git add server.mjs
git commit -m "feat: add WS message handlers for session lifecycle and layout, fix identity passthrough"
```

---

### Task 5: Reconnection Overlay

**Files:**
- Modify: `index.html` — add overlay DOM
- Modify: `dashboard.css` — add overlay styles
- Modify: `dashboard.mjs` — add show/hide/countdown logic

- [ ] **Step 1: Add overlay HTML to index.html**

After the help panel `</div>`, before the input bar, add:

```html
<!-- Reconnection overlay — frosted glass with countdown -->
<div class="reconnect-overlay" id="reconnect-overlay" aria-hidden="true">
  <div class="reconnect-card">
    <div class="reconnect-icon">&#x26A0;</div>
    <p class="reconnect-status" id="reconnect-status">Retrying (attempt 1)... 30</p>
    <div class="reconnect-countdown" id="reconnect-countdown">30</div>
    <p class="reconnect-sub" id="reconnect-sub">Re-establishing connection to server</p>
    <a href="/login" class="reconnect-login-link" id="reconnect-login-link" style="display:none">Sign in again</a>
  </div>
</div>
```

- [ ] **Step 2: Add overlay styles to dashboard.css**

```css
/* === Reconnection overlay === */
.reconnect-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 99999;
  background: rgba(10, 10, 30, 0.6);
  backdrop-filter: blur(30px) saturate(1.4);
  -webkit-backdrop-filter: blur(30px) saturate(1.4);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.4s ease;
}
.reconnect-overlay.visible {
  opacity: 1;
  pointer-events: auto;
}
.reconnect-card {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 16px;
  padding: 40px 48px;
  text-align: center;
  font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
  color: #e0e0e0;
  max-width: 360px;
}
.reconnect-icon {
  font-size: 3rem;
  margin-bottom: 12px;
}
.reconnect-card h2 {
  font-size: 1.3rem;
  margin-bottom: 8px;
  color: #fff;
}
.reconnect-card p {
  color: #999;
  font-size: 0.9rem;
  margin-bottom: 16px;
}
.reconnect-countdown {
  font-size: 3rem;
  font-weight: 700;
  color: #ff9800;
  font-variant-numeric: tabular-nums;
  margin: 8px 0;
}
.reconnect-sub {
  color: #666;
  font-size: 0.8rem;
}
.reconnect-status {
  color: #ccc;
  font-size: 0.95rem;
  margin-bottom: 8px;
}
.reconnect-login-link {
  display: inline-block;
  margin-top: 16px;
  padding: 10px 24px;
  color: #fff;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 8px;
  text-decoration: none;
  font-size: 0.9rem;
  transition: background 0.2s;
}
.reconnect-login-link:hover {
  background: rgba(255, 255, 255, 0.2);
}
```

- [ ] **Step 3: Add show/hide/countdown logic to dashboard.mjs**

```javascript
var _reconnectTimer = null;
var _reconnectTimeoutSec = 30; // total seconds before redirect to login

function showReconnectOverlay(secondsLeft) {
  var overlay = document.getElementById('reconnect-overlay');
  var countdownEl = document.getElementById('reconnect-countdown');
  var secondsEl = document.getElementById('reconnect-seconds');
  if (!overlay) return;
  overlay.classList.add('visible');
  overlay.setAttribute('aria-hidden', 'false');

  if (_reconnectTimer) clearInterval(_reconnectTimer);

  var remaining = secondsLeft;
  var attempt = _dashWsAuthFailures || 1;
  var statusEl = document.getElementById('reconnect-status');
  var subEl = document.getElementById('reconnect-sub');
  var loginLink = document.getElementById('reconnect-login-link');

  if (countdownEl) countdownEl.textContent = remaining;
  if (statusEl) statusEl.textContent = 'Retrying (attempt ' + attempt + ')... ' + remaining;
  if (subEl) subEl.textContent = 'Re-establishing connection to server';
  if (loginLink) loginLink.style.display = 'none';

  if (remaining <= 0) {
    // Connection failed — show login link instead of auto-redirect
    if (countdownEl) countdownEl.textContent = '!';
    if (statusEl) statusEl.textContent = 'Connection to server lost';
    if (subEl) subEl.textContent = 'Re-authentication required';
    if (loginLink) loginLink.style.display = 'inline-block';
    return;
  }

  _reconnectTimer = setInterval(function() {
    remaining--;
    if (countdownEl) countdownEl.textContent = remaining;
    if (statusEl) statusEl.textContent = 'Retrying (attempt ' + attempt + ')... ' + remaining;
    if (remaining <= 0) {
      clearInterval(_reconnectTimer);
      if (countdownEl) countdownEl.textContent = '!';
      if (statusEl) statusEl.textContent = 'Connection to server lost';
      if (subEl) subEl.textContent = 'Re-authentication required';
      if (loginLink) loginLink.style.display = 'inline-block';
    }
  }, 1000);
}

function hideReconnectOverlay() {
  var overlay = document.getElementById('reconnect-overlay');
  if (!overlay) return;
  overlay.classList.remove('visible');
  overlay.setAttribute('aria-hidden', 'true');
  if (_reconnectTimer) { clearInterval(_reconnectTimer); _reconnectTimer = null; }
}
```

- [ ] **Step 4: Wire overlay into WS close/open handlers**

In `connectDashboardWs`:

```javascript
ws.onopen = function() {
  _dashWsAuthFailures = 0;
  dashboardWs = ws;
  hideReconnectOverlay();
  // ... existing onopen logic
};

ws.onclose = function(ev) {
  dashboardWs = null;
  if (ev.code === 1006) _dashWsAuthFailures++;
  if (_dashWsAuthFailures >= 3) {
    showReconnectOverlay(0);
    return;
  }
  showReconnectOverlay(_reconnectTimeoutSec);
  // ... reconnect with API key refresh
};
```

- [ ] **Step 5: Commit**

```bash
git add index.html dashboard.css dashboard.mjs
git commit -m "feat: add frosted-glass reconnection overlay with countdown"
```

---

### Task 6: Force Re-login from Admin Panel

**Files:**
- Modify: `server.mjs` — add `/api/admin/force-relogin` endpoint
- Modify: `admin-client.mjs` — add force-relogin button
- Modify: `admin.html` — add button style

- [ ] **Step 1: Add server endpoint**

After the existing admin endpoints, add:

```javascript
if (req.method === 'POST' && pathname === '/api/admin/force-relogin') {
  (async () => {
    const u = requireAdmin(req, res); if (!u) return;
    const body = await readBody(req);
    const { email } = JSON.parse(body);
    if (!email) return sendError(res, 400, 'Missing email');
    const target = userStore.findByEmail(email);
    if (!target) return sendError(res, 404, 'User not found');
    // Revoke all API keys for this user
    apiKeyStore.revokeAllForUser(email);
    // Send reauth-required to all connected dashboard WS clients for this user
    for (const client of dashboardClients) {
      if (client._userEmail === email && client.readyState === 1) {
        client.send(JSON.stringify({ type: 'reauth-required', reason: 'admin-revoked' }));
      }
    }
    sendJson(res, 200, { ok: true });
  })().catch(err => sendCaughtError(res, err));
  return;
}
```

Also: in `handleDashboardWs`, store the user email on the ws object:

```javascript
ws._userEmail = user.email;
```

- [ ] **Step 2: Handle `reauth-required` in dashboard.mjs**

In `routeDashboardMessage`:

```javascript
if (msg.type === 'reauth-required') {
  // Save UI state to localStorage
  window._saveLayout();
  showReconnectOverlay(0); // immediate redirect
  return;
}
```

- [ ] **Step 3: Add force-relogin button to admin client**

In the users table row (admin-client.mjs), add after the Deactivate button:

```javascript
'<button class="btn btn-force-relogin" onclick="forceRelogin(\'' + em + '\')">Force re-login</button>' +
```

Add the handler:

```javascript
window.forceRelogin = async function(email) {
  if (!confirm('Force ' + email + ' to re-authenticate?\n\nAll their active sessions will be disconnected immediately.')) return;
  var res = await csrfFetch('/api/admin/force-relogin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email })
  });
  if (!res.ok) {
    var err = await res.json().catch(function() { return {}; });
    alert('Error: ' + (err.error || 'Failed'));
    return;
  }
  alert(email + ' has been forced to re-authenticate.');
};
```

- [ ] **Step 4: Add button style to admin.html**

```css
.btn-force-relogin { background: #6a4a2d; color: #fff; }
.btn-force-relogin:hover { background: #8b6a3d; }
```

- [ ] **Step 5: Commit**

```bash
git add server.mjs admin-client.mjs admin.html
git commit -m "feat: admin force re-login — revokes API keys and disconnects user"
```

---

### Task 7: Remove Legacy Per-Card WebSocket (`/ws/terminal`)

**Files:**
- Modify: `terminal.svg` — remove `connectWebSocket()`, keep `renderMessage()` and `sendToWs()` (called by parent dashboard)
- Modify: `server.mjs` — remove or gate the `/ws/terminal` upgrade handler
- Modify: `dashboard.mjs` — remove token passing to SVG `<object>` URL

- [ ] **Step 1: Remove `connectWebSocket()` from terminal.svg**

In terminal.svg, remove the `connectWebSocket()` function and the call at the bottom (`connectWebSocket()`). Keep:
- `window.renderMessage` — dashboard calls this to push screen data
- `window.sendToWs` — dashboard calls this to route input through the parent's WS

The SVG no longer opens its own WebSocket connection. All data flows through the parent dashboard.

- [ ] **Step 2: Remove token param from SVG object URL in dashboard.mjs**

In `createTerminalDOM`, remove the token param:

```javascript
obj.data = '/terminal.svg?session=' + encodeURIComponent(sessionName);
```

- [ ] **Step 3: Mark `/ws/terminal` as deprecated in server.mjs**

Add a comment and reject new connections:

```javascript
if (url.pathname === '/ws/terminal') {
  // DEPRECATED: per-card WebSocket removed. All data flows through /ws/dashboard.
  process.stderr.write(`[WS] ${remoteIp} REJECTED deprecated /ws/terminal\n`);
  socket.write('HTTP/1.1 410 Gone\r\n\r\n');
  socket.destroy();
  return;
}
```

- [ ] **Step 4: Commit**

```bash
git add terminal.svg dashboard.mjs server.mjs
git commit -m "feat: remove legacy per-card /ws/terminal, all data through /ws/dashboard"
```

---

### Task 8: Fix `/auth/status` Information Leak

**Files:**
- Modify: `server.mjs` — require some form of identity proof on `/auth/status`
- Modify: `pending.html` — update the check-status flow

- [ ] **Step 1: Restrict `/auth/status` to require the pending user's OAuth state**

The pending page is reached after an OAuth sign-in attempt. We can pass a one-time check token:

In the auth callback, when redirecting to `/pending`, generate a check token:

```javascript
const checkToken = randomBytes(16).toString('base64url');
pendingCheckTokens.set(checkToken, { email: identity.email, expires: Date.now() + 3600000 }); // 1 hour
res.writeHead(302, { Location: '/pending?email=' + encodeURIComponent(identity.email) + '&check=' + checkToken });
```

Add `pendingCheckTokens` map near the other state maps:

```javascript
const pendingCheckTokens = new Map();
```

Update `/auth/status` to require the check token:

```javascript
if (pathname === '/auth/status') {
  const email = url.searchParams.get('email');
  const checkToken = url.searchParams.get('check');
  if (!email || !checkToken) return sendError(res, 400, 'Missing parameters');
  const entry = pendingCheckTokens.get(checkToken);
  if (!entry || entry.email !== email || Date.now() > entry.expires) {
    return sendError(res, 403, 'Invalid or expired check token');
  }
  // ... rest of status check logic
```

- [ ] **Step 2: Update pending.html to pass the check token**

```javascript
var params = new URLSearchParams(location.search);
var email = params.get('email');
var checkToken = params.get('check');
// ...
var res = await fetch('/auth/status?email=' + encodeURIComponent(email) + '&check=' + encodeURIComponent(checkToken));
```

- [ ] **Step 3: Commit**

```bash
git add server.mjs pending.html
git commit -m "fix: require check token on /auth/status to prevent email enumeration"
```

---

### Task 9: Dev Mode Login Page

**Files:**
- Modify: `login.html` — add password form for dev mode

- [ ] **Step 1: Add dev mode password form to login.html**

Add a conditional section that shows when no OAuth providers are configured. The server already handles `POST /login` with password validation. The login page needs to detect dev mode:

```javascript
// After the existing provider buttons, add:
fetch('/auth/me').then(function(r) {
  if (r.status === 401) {
    // Check if any OAuth buttons are visible
    var btns = document.querySelectorAll('.oauth-btn:not([style*="display: none"])');
    if (btns.length === 0) {
      // No OAuth providers — show dev password form
      var devForm = document.createElement('div');
      devForm.innerHTML = '<div class="dev-login"><h3>Development Mode</h3>' +
        '<input type="password" id="dev-password" placeholder="Dev password" />' +
        '<button onclick="devLogin()">Sign in</button></div>';
      document.querySelector('.card').appendChild(devForm);
    }
  }
});

function devLogin() {
  var pw = document.getElementById('dev-password').value;
  fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  }).then(function(r) {
    if (r.ok) location.href = '/';
    else document.getElementById('error').textContent = 'Invalid password';
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add login.html
git commit -m "feat: add dev mode password login form"
```

---

### Task 10: Admin PIN for Privileged Actions

**Files:**
- Modify: `user-store.mjs` — add `admin_pin_hash` column
- Modify: `server.mjs` — add PIN set/verify endpoints, sudo window check
- Modify: `admin.html` — add PIN modal, PIN setup section
- Modify: `admin-client.mjs` — PIN prompt logic, sudo window tracking
- Create: `test-admin-pin.mjs`

- [ ] **Step 1: Write failing tests for PIN lifecycle**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

describe('Admin PIN', () => {
  it('hashes PIN with HMAC-SHA256', () => {
    const secret = 'test-secret';
    const pin = '1234';
    const hash = createHmac('sha256', secret).update(pin).digest('hex');
    assert.equal(hash.length, 64);
    // Same input = same hash
    const hash2 = createHmac('sha256', secret).update(pin).digest('hex');
    assert.equal(hash, hash2);
    // Different input = different hash
    const hash3 = createHmac('sha256', secret).update('5678').digest('hex');
    assert.notEqual(hash, hash3);
  });
});
```

- [ ] **Step 2: Add `admin_pin_hash` column to user-store.mjs**

In the SCHEMA string, add to the users table:

```sql
admin_pin_hash TEXT
```

Add methods to UserStore:

```javascript
setAdminPin(email, pinHash) {
  this.db.prepare('UPDATE users SET admin_pin_hash = ? WHERE email = ?').run(pinHash, email);
}

getAdminPinHash(email) {
  const row = this.db.prepare('SELECT admin_pin_hash FROM users WHERE email = ?').get(email);
  return row ? row.admin_pin_hash : null;
}
```

- [ ] **Step 3: Add PIN set/verify endpoints to server.mjs**

```javascript
// Set admin PIN
if (req.method === 'POST' && pathname === '/api/admin/set-pin') {
  (async () => {
    const u = requireAdmin(req, res); if (!u) return;
    const body = await readBody(req);
    const { pin } = JSON.parse(body);
    if (!pin || pin.length < 4 || pin.length > 20) return sendError(res, 400, 'PIN must be 4-20 characters');
    const hash = createHmac('sha256', AUTH_SECRET).update(pin).digest('hex');
    userStore.setAdminPin(u.email, hash);
    sendJson(res, 200, { ok: true });
  })().catch(err => sendCaughtError(res, err));
  return;
}

// Verify admin PIN (returns a sudo token valid for 15 min)
if (req.method === 'POST' && pathname === '/api/admin/verify-pin') {
  (async () => {
    const u = requireAdmin(req, res); if (!u) return;
    const body = await readBody(req);
    const { pin } = JSON.parse(body);
    const storedHash = userStore.getAdminPinHash(u.email);
    if (!storedHash) return sendError(res, 400, 'No PIN set — set one first');
    const inputHash = createHmac('sha256', AUTH_SECRET).update(pin).digest('hex');
    if (inputHash !== storedHash) return sendError(res, 401, 'Invalid PIN');
    // Issue sudo token — store on the API key
    const apiKey = parseCookie(req); // or from API key store
    // Set sudo window: 15 minutes
    const sudoToken = randomBytes(16).toString('base64url');
    sudoWindows.set(u.email, { token: sudoToken, expires: Date.now() + 15 * 60 * 1000 });
    sendJson(res, 200, { ok: true, sudoToken });
  })().catch(err => sendCaughtError(res, err));
  return;
}
```

Add `sudoWindows` Map near the other state maps:

```javascript
const sudoWindows = new Map(); // email → { token, expires }
```

Add a helper to check sudo status:

```javascript
function requireSudo(req, res) {
  const u = requireAdmin(req, res);
  if (!u) return null;
  const window = sudoWindows.get(u.email);
  if (!window || Date.now() > window.expires) {
    sendJson(res, 403, { error: 'sudo-required', message: 'Enter your admin PIN to continue' });
    return null;
  }
  return u;
}
```

- [ ] **Step 4: Gate privileged admin actions behind `requireSudo`**

Replace `requireAdmin` with `requireSudo` on these endpoints:
- `PATCH /api/admin/user/:email/flags` (flag changes)
- `POST /api/admin/force-relogin`
- `POST /api/admin/deactivate`
- `POST /api/admin/purge`
- `POST /api/admin/merge`
- Any action where target user has `linux_user === 'root'`

- [ ] **Step 5: Add PIN modal to admin.html**

```html
<!-- Admin PIN modal -->
<div class="pin-modal" id="pin-modal" style="display:none">
  <div class="pin-modal-backdrop"></div>
  <div class="pin-modal-dialog">
    <h3>Admin PIN Required</h3>
    <p class="note">Enter your PIN to continue with this action.</p>
    <input type="password" id="pin-input" placeholder="PIN" maxlength="20" autocomplete="off">
    <div class="pin-modal-actions">
      <button class="btn btn-approve" id="pin-submit">Confirm</button>
      <button class="btn btn-deny" id="pin-cancel">Cancel</button>
    </div>
    <p class="note" id="pin-error" style="color:#f44; display:none"></p>
  </div>
</div>
```

Add styles:

```css
.pin-modal { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 99999;
             display: flex; align-items: center; justify-content: center; }
.pin-modal-backdrop { position: absolute; top: 0; left: 0; right: 0; bottom: 0;
                      background: rgba(0,0,0,0.5); backdrop-filter: blur(8px); }
.pin-modal-dialog { position: relative; background: #16213e; border-radius: 12px; padding: 24px 32px;
                    min-width: 280px; text-align: center; border: 1px solid #333; }
.pin-modal-dialog h3 { color: #fff; margin-bottom: 8px; }
.pin-modal-dialog input { background: #1a1a2e; color: #e0e0e0; border: 1px solid #333; border-radius: 4px;
                          padding: 8px 12px; font-size: 1.1rem; text-align: center; width: 120px;
                          letter-spacing: 4px; margin: 12px 0; }
.pin-modal-dialog input:focus { border-color: #4285f4; outline: none; }
.pin-modal-actions { display: flex; gap: 8px; justify-content: center; margin-top: 12px; }
```

- [ ] **Step 6: Add PIN prompt logic to admin-client.mjs**

```javascript
var _sudoToken = null;
var _sudoExpires = 0;
var _pendingSudoAction = null;

function hasSudo() {
  return _sudoToken && Date.now() < _sudoExpires;
}

function requirePinThen(action) {
  if (hasSudo()) { action(); return; }
  _pendingSudoAction = action;
  var modal = document.getElementById('pin-modal');
  var input = document.getElementById('pin-input');
  var error = document.getElementById('pin-error');
  modal.style.display = 'flex';
  input.value = '';
  error.style.display = 'none';
  input.focus();
}

document.getElementById('pin-submit').addEventListener('click', async function() {
  var pin = document.getElementById('pin-input').value;
  if (!pin) return;
  var res = await csrfFetch('/api/admin/verify-pin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: pin })
  });
  if (!res.ok) {
    var err = await res.json().catch(function() { return {}; });
    var errorEl = document.getElementById('pin-error');
    errorEl.textContent = err.message || 'Invalid PIN';
    errorEl.style.display = 'block';
    return;
  }
  var data = await res.json();
  _sudoToken = data.sudoToken;
  _sudoExpires = Date.now() + 15 * 60 * 1000;
  document.getElementById('pin-modal').style.display = 'none';
  if (_pendingSudoAction) { _pendingSudoAction(); _pendingSudoAction = null; }
});

document.getElementById('pin-cancel').addEventListener('click', function() {
  document.getElementById('pin-modal').style.display = 'none';
  _pendingSudoAction = null;
});
```

Then wrap privileged actions:

```javascript
// Example: deactivateUser becomes
window.deactivateUser = async function(email) {
  requirePinThen(async function() {
    if (!confirm('Deactivate ' + email + '? ...')) return;
    // ... existing deactivate logic
  });
};
```

Apply same wrapper to: `forceRelogin`, `purgeUser`, `toggleFlag`, `mergeUser`.

- [ ] **Step 7: Add PIN setup section to admin panel**

In admin.html, add a section at the top for the current admin to set their PIN:

```html
<div class="section">
  <h2>Your Admin PIN <span class="info-icon" title="Set a PIN to authorize privileged actions like changing flags, deactivating users, or force re-login. Required for sensitive operations.">i</span></h2>
  <p class="section-info">Privileged actions require PIN confirmation. Set or change your PIN here.</p>
  <div class="form-row">
    <label>New PIN</label>
    <input type="password" id="set-pin" placeholder="4-20 characters" maxlength="20" size="12">
    <button class="submit" id="set-pin-btn">Set PIN</button>
  </div>
</div>
```

Wire it up:

```javascript
document.getElementById('set-pin-btn').addEventListener('click', async function() {
  var pin = document.getElementById('set-pin').value;
  if (!pin || pin.length < 4) { alert('PIN must be at least 4 characters'); return; }
  var res = await csrfFetch('/api/admin/set-pin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: pin })
  });
  if (res.ok) {
    alert('PIN set successfully');
    document.getElementById('set-pin').value = '';
  } else {
    var err = await res.json().catch(function() { return {}; });
    alert('Error: ' + (err.error || 'Failed to set PIN'));
  }
});
```

- [ ] **Step 8: Commit**

```bash
git add user-store.mjs server.mjs admin.html admin-client.mjs test-admin-pin.mjs
git commit -m "feat: admin PIN for privileged actions with 15-min sudo window"
```

---

### Task 11: Rate Limiting

**Files:**
- Create: `rate-limiter.mjs`
- Create: `test-rate-limiter.mjs`
- Modify: `server.mjs` — apply rate limits to auth and admin endpoints

- [ ] **Step 1: Write failing tests**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from './rate-limiter.mjs';

describe('RateLimiter', () => {
  it('allows requests under the limit', () => {
    const rl = new RateLimiter({ maxAttempts: 5, windowMs: 60000 });
    for (let i = 0; i < 5; i++) {
      assert.equal(rl.check('1.2.3.4'), true);
    }
  });

  it('blocks requests over the limit', () => {
    const rl = new RateLimiter({ maxAttempts: 3, windowMs: 60000 });
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), false); // 4th attempt blocked
  });

  it('tracks different keys independently', () => {
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 60000 });
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), false);
    assert.equal(rl.check('5.6.7.8'), true); // different key, still allowed
  });

  it('applies lockout after max failures', () => {
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 60000, lockoutMs: 5000, lockoutAfter: 3 });
    rl.recordFailure('1.2.3.4');
    rl.recordFailure('1.2.3.4');
    rl.recordFailure('1.2.3.4');
    assert.equal(rl.check('1.2.3.4'), false); // locked out
  });

  it('resets after window expires', () => {
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 100 });
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), false);
    // Simulate time passing
    rl._entries.get('1.2.3.4').windowStart = Date.now() - 200;
    assert.equal(rl.check('1.2.3.4'), true); // window reset
  });

  it('recordSuccess resets failure count', () => {
    const rl = new RateLimiter({ maxAttempts: 5, windowMs: 60000, lockoutAfter: 3, lockoutMs: 5000 });
    rl.recordFailure('1.2.3.4');
    rl.recordFailure('1.2.3.4');
    rl.recordSuccess('1.2.3.4');
    assert.equal(rl.check('1.2.3.4'), true); // failure count reset
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test-rate-limiter.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement RateLimiter**

```javascript
// rate-limiter.mjs
export class RateLimiter {
  constructor({ maxAttempts = 10, windowMs = 60000, lockoutMs = 300000, lockoutAfter = 0 }) {
    this._maxAttempts = maxAttempts;
    this._windowMs = windowMs;
    this._lockoutMs = lockoutMs;
    this._lockoutAfter = lockoutAfter; // 0 = no lockout, just rate limit
    this._entries = new Map(); // key → { attempts, failures, windowStart, lockedUntil }
    this._cleanupTimer = setInterval(() => this._cleanup(), 60000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  _getEntry(key) {
    let entry = this._entries.get(key);
    if (!entry) {
      entry = { attempts: 0, failures: 0, windowStart: Date.now(), lockedUntil: 0 };
      this._entries.set(key, entry);
    }
    // Reset window if expired
    if (Date.now() - entry.windowStart > this._windowMs) {
      entry.attempts = 0;
      entry.windowStart = Date.now();
    }
    return entry;
  }

  check(key) {
    const entry = this._getEntry(key);
    // Check lockout
    if (entry.lockedUntil && Date.now() < entry.lockedUntil) return false;
    // Check rate limit
    if (entry.attempts >= this._maxAttempts) return false;
    entry.attempts++;
    return true;
  }

  recordFailure(key) {
    const entry = this._getEntry(key);
    entry.failures++;
    if (this._lockoutAfter && entry.failures >= this._lockoutAfter) {
      entry.lockedUntil = Date.now() + this._lockoutMs;
    }
  }

  recordSuccess(key) {
    const entry = this._getEntry(key);
    entry.failures = 0;
    entry.lockedUntil = 0;
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._entries) {
      if (now - entry.windowStart > this._windowMs * 2 && (!entry.lockedUntil || now > entry.lockedUntil)) {
        this._entries.delete(key);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test-rate-limiter.mjs`
Expected: All 7 tests PASS

- [ ] **Step 5: Apply rate limiters to server.mjs**

Import and create rate limiter instances:

```javascript
import { RateLimiter } from './rate-limiter.mjs';

// Rate limiters — keyed by cf-connecting-ip or socket address
const authRateLimiter = new RateLimiter({ maxAttempts: 5, windowMs: 60000, lockoutMs: 900000, lockoutAfter: 10 });
const oauthInitRateLimiter = new RateLimiter({ maxAttempts: 10, windowMs: 60000, lockoutMs: 300000, lockoutAfter: 20 });
const adminMutationRateLimiter = new RateLimiter({ maxAttempts: 10, windowMs: 60000, lockoutMs: 300000, lockoutAfter: 15 });
const privilegedActionRateLimiter = new RateLimiter({ maxAttempts: 3, windowMs: 60000, lockoutMs: 600000, lockoutAfter: 5 });
const wsUpgradeRateLimiter = new RateLimiter({ maxAttempts: 20, windowMs: 60000, lockoutMs: 300000, lockoutAfter: 30 });
```

Helper to get the real client IP:

```javascript
function getClientIp(req) {
  return req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
}
```

Apply to endpoints:

```javascript
// POST /login (dev mode password)
const ip = getClientIp(req);
if (!authRateLimiter.check(ip)) { sendError(res, 429, 'Too many attempts — try again later'); return; }
// On success: authRateLimiter.recordSuccess(ip)
// On failure: authRateLimiter.recordFailure(ip)

// GET /auth/{provider}
if (!oauthInitRateLimiter.check(ip)) { sendError(res, 429, 'Too many attempts'); return; }

// Admin mutation endpoints (flag changes, deactivate, purge, force-relogin, merge)
if (!privilegedActionRateLimiter.check(u.email)) { sendError(res, 429, 'Too many privileged actions'); return; }

// Failed WS upgrades
if (!wsUpgradeRateLimiter.check(remoteIp)) {
  socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
  socket.destroy();
  return;
}
// On successful upgrade: wsUpgradeRateLimiter.recordSuccess(remoteIp)
```

- [ ] **Step 6: Commit**

```bash
git add rate-limiter.mjs test-rate-limiter.mjs server.mjs
git commit -m "feat: rate limiting on auth, admin, and WS upgrade endpoints"
```

---

### Task 12: Documentation Update (renumbered from Task 10)

**Files:**
- Modify: `docs/oauth-provider-setup-v0.2.md` — update security section
- Modify: `docs/admin-panel-v0.1.md` — add force re-login docs
- Modify: `docs/research/2026-04-05-v0.1-session-authorization-journal.md` — update status to Direction Confirmed
- Modify: `/srv/security-scan/updates/2026-04-05-svg-terminal-security-fixes.md` — add new fixes

- [ ] **Step 1: Update security docs with API key model, dev mode hardening, WS consolidation**

Update the Security section of `oauth-provider-setup-v0.2.md` to document:
- API key model replaces cookie-based WS auth
- Idle timeout (30 min) and absolute timeout (24h)
- Force re-login admin action
- Dev mode requires explicit `AUTH_MODE=dev` + `DEV_PASSWORD`
- All dashboard communication over authenticated WS (no parallel HTTP)

- [ ] **Step 2: Add force re-login to admin panel docs**

In `admin-panel-v0.1.md`, add to the All Users section:

```markdown
### Force Re-login Button

1. Confirm dialog: "Force user to re-authenticate? All active sessions disconnected."
2. All API keys for the user are revoked server-side
3. Connected dashboard WebSockets receive `reauth-required` message
4. User's browser shows reconnection overlay → redirects to login
5. User must sign in via OAuth again to get a new API key
```

- [ ] **Step 3: Update security scan fixes log**

Add to `/srv/security-scan/updates/2026-04-05-svg-terminal-security-fixes.md`:

```markdown
## Phase 2 — Session Authorization (2026-04-05)

### API Key Store
- Server-side API key management with idle timeout (30 min) and absolute timeout (24h)
- Keys stored in memory Map, validated on every WS message
- Admin can revoke all keys for a user (force re-login)

### WebSocket Consolidation
- All session operations moved from HTTP endpoints to authenticated WS backchannel
- Removed: /api/input HTTP, /api/layout HTTP POST, /api/sessions/create|restart|fork HTTP
- Legacy /ws/terminal endpoint deprecated and rejected (410 Gone)
- All paths now pass authenticated user identity to claude-proxy (no more hardcoded root)

### Dev Mode Hardening
- Requires explicit AUTH_MODE=dev (missing OAuth vars alone = server refuses to start)
- Requires DEV_PASSWORD env var
- Localhost-only by default (DEV_LOCALHOST_ONLY=0 to opt out)

### Information Leak Fix
- /auth/status now requires a one-time check token (issued at OAuth callback)
- Prevents unauthenticated email enumeration

### Admin PIN
- Privileged admin actions require PIN confirmation (4-20 char, HMAC-SHA256 hashed)
- 15-minute sudo window after PIN entry
- Actions gated: flag changes, deactivate, purge, force re-login, merge
- PIN set/changed in admin panel, stored as hash in user DB

### Rate Limiting
- Auth endpoints: 5/min per IP, 15-min lockout after 10 failures
- OAuth initiation: 10/min per IP
- Admin mutations: 10/min per user
- Privileged actions: 3/min per user, 10-min lockout after 5
- Failed WS upgrades: 20/min per IP, 5-min lockout after 30
```

- [ ] **Step 4: Commit**

```bash
git add docs/ /srv/security-scan/updates/
git commit -m "docs: update security docs for API key model, WS consolidation, dev mode"
```
