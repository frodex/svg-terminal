# Login & User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OAuth login, request-access flow, and admin user management to the svg-terminal dashboard.

**Architecture:** server.mjs is the unified web server. OAuth, user store, provisioning, and session cookies are ported from claude-proxy's TypeScript into plain JS modules. Auth middleware protects all routes except /login and /auth/*. Admin UI is server-side HTML.

**Tech Stack:** Node.js, better-sqlite3, openid-client, HMAC-SHA256 cookies, plain HTML/CSS/JS

**Spec:** `docs/superpowers/specs/2026-03-30-login-and-user-management-design.md`

---

## File Map

| File | Type | Responsibility |
|------|------|---------------|
| `session-cookie.mjs` | New | HMAC-SHA256 cookie creation + validation |
| `user-store.mjs` | New | SQLite user database — schema, CRUD, queries |
| `provisioner.mjs` | New | Linux account creation, group management |
| `auth.mjs` | New | OAuth: Google/Microsoft OIDC + GitHub adapter |
| `login.html` | New | OAuth provider selection page |
| `pending.html` | New | "Request submitted" waiting room |
| `admin.html` | New | User management page (pending, users, pre-approve) |
| `admin.mjs` | New | Client-side JS for admin page |
| `server.mjs` | Modify | Auth middleware, auth/admin routes, serve new pages |
| `test-auth.mjs` | New | Tests for cookie, user store, provisioner |

---

### Task 1: Session Cookie Module

Port from `/srv/claude-proxy/src/auth/session-cookie.ts` to plain JS.

**Files:**
- Create: `session-cookie.mjs`
- Create: `test-auth.mjs`

- [ ] **Step 1: Write failing tests**

Create `test-auth.mjs`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCookie, validateSessionCookie } from './session-cookie.mjs';

describe('session-cookie', () => {
  const SECRET = 'test-secret-key-min-32-chars-long!!';

  it('creates and validates a cookie', () => {
    const cookie = createSessionCookie({ email: 'user@test.com', displayName: 'Test' }, SECRET, 3600);
    const payload = validateSessionCookie(cookie, SECRET);
    assert.equal(payload.email, 'user@test.com');
    assert.equal(payload.displayName, 'Test');
  });

  it('rejects tampered cookie', () => {
    const cookie = createSessionCookie({ email: 'user@test.com', displayName: 'Test' }, SECRET, 3600);
    const tampered = cookie.slice(0, -1) + 'X';
    assert.equal(validateSessionCookie(tampered, SECRET), null);
  });

  it('rejects expired cookie', () => {
    const cookie = createSessionCookie({ email: 'user@test.com', displayName: 'Test' }, SECRET, -1);
    assert.equal(validateSessionCookie(cookie, SECRET), null);
  });

  it('rejects wrong secret', () => {
    const cookie = createSessionCookie({ email: 'user@test.com', displayName: 'Test' }, SECRET, 3600);
    assert.equal(validateSessionCookie(cookie, 'wrong-secret-key-also-32-chars!!'), null);
  });

  it('rejects garbage input', () => {
    assert.equal(validateSessionCookie('garbage', SECRET), null);
    assert.equal(validateSessionCookie('', SECRET), null);
    assert.equal(validateSessionCookie('a.b.c', SECRET), null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test-auth.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement session-cookie.mjs**

Create `session-cookie.mjs`:

```javascript
import { createHmac, timingSafeEqual } from 'node:crypto';

export function createSessionCookie(payload, secret, maxAgeSeconds) {
  const data = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + maxAgeSeconds,
  };
  const json = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = createHmac('sha256', secret).update(json).digest('base64url');
  return `${json}.${sig}`;
}

export function validateSessionCookie(cookie, secret) {
  if (!cookie || typeof cookie !== 'string') return null;
  const parts = cookie.split('.');
  if (parts.length !== 2) return null;

  const [json, sig] = parts;
  const expectedSig = createHmac('sha256', secret).update(json).digest('base64url');

  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(json, 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test-auth.mjs`
Expected: All 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add session-cookie.mjs test-auth.mjs
git commit -m "feat: session cookie module — HMAC-SHA256 create/validate"
```

---

### Task 2: User Store Module

Port and extend from `/srv/claude-proxy/src/auth/user-store.ts`. Add `status`, `approved_by`, `can_approve_*` columns. Use `better-sqlite3` (not the encrypted variant — simpler).

**Files:**
- Create: `user-store.mjs`
- Modify: `test-auth.mjs`

- [ ] **Step 1: Install better-sqlite3**

```bash
npm install better-sqlite3
```

- [ ] **Step 2: Write failing tests**

Append to `test-auth.mjs`:

```javascript
import { UserStore } from './user-store.mjs';
import { unlinkSync } from 'node:fs';

describe('user-store', () => {
  let store;
  const DB_PATH = '/tmp/test-user-store.db';

  it('creates database and tables', () => {
    try { unlinkSync(DB_PATH); } catch {}
    store = new UserStore(DB_PATH);
    assert.ok(store);
  });

  it('creates a pending user', () => {
    store.createPendingUser({
      email: 'student@school.edu',
      displayName: 'Test Student',
      provider: 'google',
      providerId: 'goog-123',
    });
    const user = store.findByEmail('student@school.edu');
    assert.equal(user.status, 'pending');
    assert.equal(user.linux_user, null);
  });

  it('approves a user', () => {
    store.approveUser('student@school.edu', 'root');
    const user = store.findByEmail('student@school.edu');
    assert.equal(user.status, 'approved');
    assert.equal(user.approved_by, 'root');
  });

  it('denies a user', () => {
    store.createPendingUser({
      email: 'bad@school.edu',
      displayName: 'Bad Actor',
      provider: 'github',
      providerId: 'gh-999',
    });
    store.denyUser('bad@school.edu');
    const user = store.findByEmail('bad@school.edu');
    assert.equal(user.status, 'denied');
  });

  it('lists pending users', () => {
    store.createPendingUser({
      email: 'pending@school.edu',
      displayName: 'Pending',
      provider: 'google',
      providerId: 'goog-456',
    });
    const pending = store.listPending();
    assert.ok(pending.length >= 1);
    assert.ok(pending.every(u => u.status === 'pending'));
  });

  it('pre-approves by email', () => {
    store.preApprove(['future1@school.edu', 'future2@school.edu'], 'root');
    const u1 = store.findByEmail('future1@school.edu');
    assert.equal(u1.status, 'approved');
    assert.equal(u1.approved_by, 'root');
    assert.equal(u1.provider, null);
  });

  it('finds by provider', () => {
    const user = store.findByProvider('google', 'goog-123');
    assert.equal(user.email, 'student@school.edu');
  });

  it('updates approval flags', () => {
    store.updateFlags('student@school.edu', { can_approve_users: 1 });
    const user = store.findByEmail('student@school.edu');
    assert.equal(user.can_approve_users, 1);
    assert.equal(user.can_approve_admins, 0);
  });

  it('sets linux_user on approve', () => {
    store.setLinuxUser('student@school.edu', 'student');
    const user = store.findByEmail('student@school.edu');
    assert.equal(user.linux_user, 'student');
  });

  it('lists all users', () => {
    const users = store.listUsers();
    assert.ok(users.length >= 3);
  });

  it('cleans up', () => {
    store.close();
    unlinkSync(DB_PATH);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test-auth.mjs`
Expected: FAIL — UserStore not found

- [ ] **Step 4: Implement user-store.mjs**

Create `user-store.mjs`:

```javascript
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  linux_user TEXT,
  provider TEXT,
  provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_by TEXT,
  can_approve_users INTEGER NOT NULL DEFAULT 0,
  can_approve_admins INTEGER NOT NULL DEFAULT 0,
  can_approve_sudo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS provider_links (
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  email TEXT NOT NULL REFERENCES users(email),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_links_email ON provider_links(email);
`;

export class UserStore {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  findByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
  }

  findByProvider(provider, providerId) {
    const link = this.db.prepare(
      'SELECT email FROM provider_links WHERE provider = ? AND provider_id = ?'
    ).get(provider, providerId);
    if (!link) return null;
    return this.findByEmail(link.email);
  }

  createPendingUser({ email, displayName, provider, providerId }) {
    this.db.prepare(
      `INSERT OR IGNORE INTO users (email, display_name, provider, provider_id, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    ).run(email, displayName, provider || null, providerId || null, new Date().toISOString());

    if (provider && providerId) {
      this.db.prepare(
        'INSERT OR IGNORE INTO provider_links (provider, provider_id, email, linked_at) VALUES (?, ?, ?, ?)'
      ).run(provider, providerId, email, new Date().toISOString());
    }
  }

  approveUser(email, approvedBy) {
    this.db.prepare(
      "UPDATE users SET status = 'approved', approved_by = ? WHERE email = ?"
    ).run(approvedBy, email);
  }

  denyUser(email) {
    this.db.prepare(
      "UPDATE users SET status = 'denied' WHERE email = ?"
    ).run(email);
  }

  listPending() {
    return this.db.prepare("SELECT * FROM users WHERE status = 'pending' ORDER BY created_at").all();
  }

  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY email').all();
  }

  preApprove(emails, approvedBy) {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO users (email, display_name, status, approved_by, created_at)
       VALUES (?, ?, 'approved', ?, ?)`
    );
    const now = new Date().toISOString();
    for (const email of emails) {
      stmt.run(email, email.split('@')[0], approvedBy, now);
    }
  }

  updateFlags(email, flags) {
    const sets = [];
    const vals = [];
    for (const [key, val] of Object.entries(flags)) {
      if (['can_approve_users', 'can_approve_admins', 'can_approve_sudo'].includes(key)) {
        sets.push(`${key} = ?`);
        vals.push(val);
      }
    }
    if (sets.length === 0) return;
    vals.push(email);
    this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE email = ?`).run(...vals);
  }

  setLinuxUser(email, linuxUser) {
    this.db.prepare('UPDATE users SET linux_user = ? WHERE email = ?').run(linuxUser, email);
  }

  updateLastLogin(email) {
    this.db.prepare('UPDATE users SET last_login = ? WHERE email = ?').run(new Date().toISOString(), email);
  }

  linkProvider(email, provider, providerId) {
    this.db.prepare(
      'INSERT OR REPLACE INTO provider_links (provider, provider_id, email, linked_at) VALUES (?, ?, ?, ?)'
    ).run(provider, providerId, email, new Date().toISOString());
  }

  close() {
    this.db.close();
  }
}
```

- [ ] **Step 5: Run tests**

Run: `node --test test-auth.mjs`
Expected: All tests pass (5 cookie + 11 user store).

- [ ] **Step 6: Commit**

```bash
git add user-store.mjs test-auth.mjs package.json package-lock.json
git commit -m "feat: user store module — SQLite with pending/approved/denied states + approval flags"
```

---

### Task 3: Provisioner Module

Port from `/srv/claude-proxy/src/auth/provisioner.ts`. Simplified — no encryption, no class methods, just functions.

**Files:**
- Create: `provisioner.mjs`

- [ ] **Step 1: Implement provisioner.mjs**

```javascript
import { execFileSync } from 'node:child_process';

const GROUP_PREFIX = 'cp-';

export function createSystemAccount(username, displayName) {
  execFileSync('useradd', ['-m', '-c', displayName, '-s', '/bin/bash', username], { stdio: 'pipe' });
  addToGroup(username, 'users');
}

export function deleteSystemAccount(username) {
  execFileSync('userdel', ['-r', username], { stdio: 'pipe' });
}

export function addToGroup(username, group) {
  execFileSync('usermod', ['-aG', `${GROUP_PREFIX}${group}`, username], { stdio: 'pipe' });
}

export function removeFromGroup(username, group) {
  execFileSync('gpasswd', ['-d', username, `${GROUP_PREFIX}${group}`], { stdio: 'pipe' });
}

export function createGroup(group) {
  execFileSync('groupadd', [`${GROUP_PREFIX}${group}`], { stdio: 'pipe' });
}

export function userExists(username) {
  try {
    execFileSync('getent', ['passwd', username], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

export function groupExists(group) {
  try {
    execFileSync('getent', ['group', `${GROUP_PREFIX}${group}`], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

export function generateUsername(email) {
  let base = email.split('@')[0].replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 20);
  if (!base) base = 'user';
  if (!userExists(base)) return base;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}${i}`;
    if (!userExists(candidate)) return candidate;
  }
  throw new Error(`Cannot generate username for ${email}`);
}

export function ensureCpUsersGroup() {
  if (!groupExists('users')) {
    createGroup('users');
  }
}
```

Note: No tests for provisioner — it runs `useradd`/`userdel` which require root and mutate system state. Tested manually and via E2E.

- [ ] **Step 2: Commit**

```bash
git add provisioner.mjs
git commit -m "feat: provisioner module — system account creation, group management"
```

---

### Task 4: OAuth Module

Port from `/srv/claude-proxy/src/auth/oauth.ts` and `/srv/claude-proxy/src/auth/github-adapter.ts`. Combined into one file.

**Files:**
- Create: `auth.mjs`

- [ ] **Step 1: Install openid-client**

```bash
npm install openid-client
```

- [ ] **Step 2: Implement auth.mjs**

```javascript
import * as oidc from 'openid-client';
import { randomBytes } from 'node:crypto';

// In-memory state store for OAuth CSRF protection
const pendingStates = new Map(); // state → { provider, expires }

function generateState(provider) {
  const state = randomBytes(24).toString('base64url');
  pendingStates.set(state, { provider, expires: Date.now() + 600000 }); // 10 min
  return state;
}

function consumeState(state) {
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state);
  if (Date.now() > entry.expires) return null;
  return entry;
}

// Clean expired states periodically
setInterval(() => {
  for (const [key, val] of pendingStates) {
    if (Date.now() > val.expires) pendingStates.delete(key);
  }
}, 60000);

// --- Google / Microsoft via openid-client ---

const oidcConfigs = new Map(); // provider → Configuration

async function getOidcConfig(provider, config, callbackUrl) {
  if (oidcConfigs.has(provider)) return oidcConfigs.get(provider);

  const urls = {
    google: 'https://accounts.google.com',
    microsoft: `https://login.microsoftonline.com/${config.tenant || 'common'}/v2.0`,
  };

  const discoveryUrl = urls[provider];
  if (!discoveryUrl) throw new Error(`Unknown OIDC provider: ${provider}`);

  const oidcConfig = await oidc.discovery(
    new URL(discoveryUrl),
    config.clientId,
    {
      client_secret: config.clientSecret,
      redirect_uris: [callbackUrl],
      response_types: ['code'],
    },
    oidc.ClientSecretPost(config.clientSecret),
  );
  oidcConfigs.set(provider, oidcConfig);
  return oidcConfig;
}

// --- GitHub (custom, no OIDC) ---

async function githubExchange(code, config) {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Failed to get GitHub access token');

  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
  });
  const user = await userRes.json();

  const emailRes = await fetch('https://api.github.com/user/emails', {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
  });
  const emails = await emailRes.json();
  const primary = emails.find(e => e.primary && e.verified);
  const email = primary?.email || user.email;
  if (!email) throw new Error('No verified email found on GitHub account');

  return { email, displayName: user.name || user.login, providerId: String(user.id) };
}

// --- Public API ---

export function getAuthUrl(provider, providers, callbackUrl) {
  const state = generateState(provider);

  if (provider === 'github') {
    const config = providers.github;
    if (!config) throw new Error('GitHub not configured');
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: callbackUrl,
      scope: 'read:user user:email',
      state,
    });
    return { url: `https://github.com/login/oauth/authorize?${params}`, state };
  }

  // For google/microsoft, we need async discovery — return a promise
  throw new Error(`Use getAuthUrlAsync for OIDC providers: ${provider}`);
}

export async function getAuthUrlAsync(provider, providers, callbackUrl) {
  const state = generateState(provider);

  if (provider === 'github') {
    const result = getAuthUrl(provider, providers, callbackUrl);
    return result;
  }

  const config = providers[provider];
  if (!config) throw new Error(`Provider "${provider}" not configured`);

  const oidcConfig = await getOidcConfig(provider, config, callbackUrl);
  const url = oidc.buildAuthorizationUrl(oidcConfig, {
    scope: 'openid email profile',
    state,
    redirect_uri: callbackUrl,
  });
  return { url: url.href, state };
}

export async function handleCallback(callbackUrl, query, providers) {
  const { state, code } = query;
  if (!state || !code) throw new Error('Missing state or code');

  const stateEntry = consumeState(state);
  if (!stateEntry) throw new Error('Invalid or expired OAuth state');

  const provider = stateEntry.provider;

  if (provider === 'github') {
    const identity = await githubExchange(code, providers.github);
    return { provider, ...identity };
  }

  // OIDC providers (google, microsoft)
  const config = providers[provider];
  if (!config) throw new Error(`Provider "${provider}" not configured`);

  const oidcConfig = await getOidcConfig(provider, config, callbackUrl);
  const currentUrl = new URL(`${callbackUrl}?code=${code}&state=${state}`);
  const tokenResponse = await oidc.authorizationCodeGrant(oidcConfig, currentUrl, {
    expectedState: state,
  });

  const claims = tokenResponse.claims();
  if (!claims) throw new Error('No ID token claims');

  return {
    provider,
    email: claims.email,
    displayName: claims.name || claims.email,
    providerId: claims.sub,
  };
}

export function getSupportedProviders(providers) {
  return Object.keys(providers).filter(k => providers[k]);
}
```

- [ ] **Step 3: Commit**

```bash
git add auth.mjs package.json package-lock.json
git commit -m "feat: OAuth module — Google/Microsoft OIDC + GitHub adapter"
```

---

### Task 5: Login and Pending HTML Pages

**Files:**
- Create: `login.html`
- Create: `pending.html`

- [ ] **Step 1: Create login.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign In — Claude Proxy</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1a1a2e; color: #e0e0e0; font-family: system-ui, sans-serif;
           display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #16213e; border-radius: 12px; padding: 48px; max-width: 400px; width: 100%;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
    h1 { font-size: 1.5rem; margin-bottom: 8px; color: #fff; }
    p { color: #999; margin-bottom: 32px; font-size: 0.9rem; }
    .btn { display: block; width: 100%; padding: 14px; margin-bottom: 12px; border: none;
           border-radius: 8px; font-size: 1rem; cursor: pointer; text-align: center;
           text-decoration: none; color: #fff; transition: opacity 0.2s; }
    .btn:hover { opacity: 0.85; }
    .btn-google { background: #4285f4; }
    .btn-github { background: #333; }
    .btn-microsoft { background: #00a4ef; }
    .error { background: #3d1515; color: #ff6b6b; padding: 12px; border-radius: 8px;
             margin-bottom: 16px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Claude Proxy</h1>
    <p>Sign in to access terminal sessions</p>
    <div id="error" class="error" style="display:none"></div>
    <a class="btn btn-google" href="/auth/google">Sign in with Google</a>
    <a class="btn btn-github" href="/auth/github">Sign in with GitHub</a>
    <a class="btn btn-microsoft" href="/auth/microsoft">Sign in with Microsoft</a>
  </div>
  <script>
    const params = new URLSearchParams(location.search);
    const err = params.get('error');
    if (err) {
      const el = document.getElementById('error');
      el.textContent = err;
      el.style.display = 'block';
    }
  </script>
</body>
</html>
```

- [ ] **Step 2: Create pending.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Pending — Claude Proxy</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1a1a2e; color: #e0e0e0; font-family: system-ui, sans-serif;
           display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #16213e; border-radius: 12px; padding: 48px; max-width: 480px; width: 100%;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4); text-align: center; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; color: #fff; }
    .icon { font-size: 3rem; margin-bottom: 16px; }
    p { color: #999; margin-bottom: 16px; font-size: 0.9rem; line-height: 1.5; }
    .email { color: #4285f4; font-weight: 600; }
    .btn { display: inline-block; padding: 12px 24px; margin-top: 16px; border: 1px solid #444;
           border-radius: 8px; color: #e0e0e0; background: transparent; cursor: pointer;
           font-size: 0.9rem; text-decoration: none; transition: background 0.2s; }
    .btn:hover { background: #1e3a5f; }
    .status { margin-top: 16px; color: #999; font-size: 0.8rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⏳</div>
    <h1>Access Requested</h1>
    <p>Your request to access Claude Proxy has been submitted.</p>
    <p>Signed in as <span class="email" id="email"></span></p>
    <p>An administrator will review your request. You'll be able to access the dashboard once approved.</p>
    <button class="btn" id="check">Check Status</button>
    <div class="status" id="status"></div>
  </div>
  <script>
    const params = new URLSearchParams(location.search);
    document.getElementById('email').textContent = params.get('email') || '';

    document.getElementById('check').addEventListener('click', async () => {
      const statusEl = document.getElementById('status');
      statusEl.textContent = 'Checking...';
      try {
        const res = await fetch('/auth/me');
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'approved') {
            location.href = '/';
          } else {
            statusEl.textContent = 'Still pending. Check back soon.';
          }
        } else {
          statusEl.textContent = 'Still pending. Check back soon.';
        }
      } catch {
        statusEl.textContent = 'Could not check status.';
      }
    });
  </script>
</body>
</html>
```

- [ ] **Step 3: Commit**

```bash
git add login.html pending.html
git commit -m "feat: login and pending HTML pages"
```

---

### Task 6: Admin HTML Page

**Files:**
- Create: `admin.html`

- [ ] **Step 1: Create admin.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Claude Proxy</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1a1a2e; color: #e0e0e0; font-family: system-ui, sans-serif; padding: 24px; }
    h1 { margin-bottom: 24px; color: #fff; }
    h2 { margin: 24px 0 12px; color: #ccc; font-size: 1.1rem; }
    .section { background: #16213e; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #2a2a4a; font-size: 0.85rem; }
    th { color: #999; font-weight: 600; }
    .btn { padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; font-size: 0.8rem; margin-right: 4px; }
    .btn-approve { background: #2d6a4f; color: #fff; }
    .btn-deny { background: #6a2d2d; color: #fff; }
    .btn-approve:hover { background: #3d8b6a; }
    .btn-deny:hover { background: #8b3d3d; }
    textarea { width: 100%; height: 80px; background: #1a1a2e; color: #e0e0e0; border: 1px solid #333;
               border-radius: 4px; padding: 8px; font-family: monospace; font-size: 0.85rem; resize: vertical; }
    .submit { margin-top: 8px; padding: 8px 20px; background: #4285f4; color: #fff; border: none;
              border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
    .submit:hover { background: #5a9bf4; }
    .toggle { cursor: pointer; }
    .empty { color: #666; font-style: italic; padding: 12px; }
    a.back { color: #4285f4; text-decoration: none; font-size: 0.9rem; }
    a.back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <a class="back" href="/">← Back to Dashboard</a>
  <h1>User Management</h1>

  <div class="section">
    <h2>Pending Requests</h2>
    <div id="pending-list"><span class="empty">Loading...</span></div>
  </div>

  <div class="section">
    <h2>Pre-Approve by Email</h2>
    <textarea id="pre-emails" placeholder="Enter email addresses, one per line"></textarea>
    <button class="submit" id="pre-approve-btn">Pre-Approve</button>
  </div>

  <div class="section">
    <h2>All Users</h2>
    <div id="user-list"><span class="empty">Loading...</span></div>
  </div>

  <script src="/admin.mjs" type="module"></script>
</body>
</html>
```

- [ ] **Step 2: Create admin.mjs (client-side)**

Create `admin.mjs`:

```javascript
async function loadPending() {
  const container = document.getElementById('pending-list');
  try {
    const res = await fetch('/api/admin/pending');
    const users = await res.json();
    if (users.length === 0) {
      container.innerHTML = '<span class="empty">No pending requests</span>';
      return;
    }
    let html = '<table><tr><th>Name</th><th>Email</th><th>Provider</th><th>Requested</th><th>Actions</th></tr>';
    for (const u of users) {
      html += `<tr>
        <td>${esc(u.display_name)}</td>
        <td>${esc(u.email)}</td>
        <td>${esc(u.provider || '—')}</td>
        <td>${new Date(u.created_at).toLocaleDateString()}</td>
        <td>
          <button class="btn btn-approve" onclick="approve('${esc(u.email)}')">Approve</button>
          <button class="btn btn-deny" onclick="deny('${esc(u.email)}')">Deny</button>
        </td>
      </tr>`;
    }
    html += '</table>';
    container.innerHTML = html;
  } catch { container.innerHTML = '<span class="empty">Error loading</span>'; }
}

async function loadUsers() {
  const container = document.getElementById('user-list');
  try {
    const res = await fetch('/api/admin/users');
    const users = await res.json();
    if (users.length === 0) {
      container.innerHTML = '<span class="empty">No users</span>';
      return;
    }
    let html = '<table><tr><th>Name</th><th>Email</th><th>Linux</th><th>Status</th><th>Approved By</th><th>Flags</th></tr>';
    for (const u of users) {
      const flags = [];
      if (u.can_approve_users) flags.push('users');
      if (u.can_approve_admins) flags.push('admins');
      if (u.can_approve_sudo) flags.push('sudo');
      html += `<tr>
        <td>${esc(u.display_name)}</td>
        <td>${esc(u.email)}</td>
        <td>${esc(u.linux_user || '—')}</td>
        <td>${esc(u.status)}</td>
        <td>${esc(u.approved_by || '—')}</td>
        <td>${flags.join(', ') || '—'}</td>
      </tr>`;
    }
    html += '</table>';
    container.innerHTML = html;
  } catch { container.innerHTML = '<span class="empty">Error loading</span>'; }
}

window.approve = async function(email) {
  if (!confirm(`Approve ${email}?`)) return;
  await fetch('/api/admin/approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  loadPending(); loadUsers();
};

window.deny = async function(email) {
  if (!confirm(`Deny ${email}?`)) return;
  await fetch('/api/admin/deny', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  loadPending(); loadUsers();
};

document.getElementById('pre-approve-btn').addEventListener('click', async () => {
  const text = document.getElementById('pre-emails').value.trim();
  if (!text) return;
  const emails = text.split(/[\n,]+/).map(e => e.trim()).filter(Boolean);
  await fetch('/api/admin/pre-approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails })
  });
  document.getElementById('pre-emails').value = '';
  loadPending(); loadUsers();
});

function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]); }

loadPending();
loadUsers();
```

- [ ] **Step 3: Commit**

```bash
git add admin.html admin.mjs
git commit -m "feat: admin page — pending requests, user list, pre-approve"
```

---

### Task 7: Wire Auth into server.mjs

The big integration task. Add auth middleware, auth routes, admin routes, and serve new pages.

**Files:**
- Modify: `server.mjs`

- [ ] **Step 1: Add imports and config at top of server.mjs**

After the existing imports, add:

```javascript
import { createSessionCookie, validateSessionCookie } from './session-cookie.mjs';
import { UserStore } from './user-store.mjs';
import { getAuthUrlAsync, handleCallback, getSupportedProviders } from './auth.mjs';
import { createSystemAccount, addToGroup, generateUsername, ensureCpUsersGroup } from './provisioner.mjs';

// Auth config — load from environment or config file
const AUTH_SECRET = process.env.AUTH_SECRET || 'change-me-in-production-min-32-chars!!';
const COOKIE_NAME = 'cp_session';
const COOKIE_MAX_AGE = 86400; // 24 hours
const AUTH_CALLBACK_URL = process.env.AUTH_CALLBACK_URL || `http://localhost:${port}/auth/callback`;

const AUTH_PROVIDERS = {
  google: process.env.GOOGLE_CLIENT_ID ? {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  } : null,
  github: process.env.GITHUB_CLIENT_ID ? {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  } : null,
  microsoft: process.env.MICROSOFT_CLIENT_ID ? {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    tenant: process.env.MICROSOFT_TENANT,
  } : null,
};

// Auth disabled if no providers configured (development mode)
const AUTH_ENABLED = Object.values(AUTH_PROVIDERS).some(v => v !== null);

const DB_PATH = process.env.USER_DB_PATH || new URL('data/users.db', import.meta.url).pathname;
let userStore;
if (AUTH_ENABLED) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(new URL('data', import.meta.url).pathname, { recursive: true });
  userStore = new UserStore(DB_PATH);
  ensureCpUsersGroup();
}
```

- [ ] **Step 2: Add auth middleware function**

```javascript
function parseCookie(req) {
  const header = req.headers.cookie || '';
  const match = header.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

function getAuthUser(req) {
  if (!AUTH_ENABLED) return { email: 'root@localhost', status: 'approved', linux_user: 'root',
    display_name: 'Development', can_approve_users: 1, can_approve_admins: 1, can_approve_sudo: 1 };
  const token = parseCookie(req);
  if (!token) return null;
  const payload = validateSessionCookie(token, AUTH_SECRET);
  if (!payload) return null;
  const user = userStore.findByEmail(payload.email);
  return user;
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
```

- [ ] **Step 3: Add auth route handlers**

```javascript
function handleLogin(req, res) {
  try {
    const content = readFileSync(staticPath('login.html'));
    setCors(res); res.setHeader('Content-Type', 'text/html'); res.writeHead(200); res.end(content);
  } catch { sendError(res, 500, 'Failed to read login.html'); }
}

function handlePendingPage(req, res) {
  try {
    const content = readFileSync(staticPath('pending.html'));
    setCors(res); res.setHeader('Content-Type', 'text/html'); res.writeHead(200); res.end(content);
  } catch { sendError(res, 500, 'Failed to read pending.html'); }
}

async function handleAuthStart(req, res, provider) {
  try {
    const { url } = await getAuthUrlAsync(provider, AUTH_PROVIDERS, AUTH_CALLBACK_URL);
    res.writeHead(302, { Location: url }); res.end();
  } catch (err) {
    res.writeHead(302, { Location: '/login?error=' + encodeURIComponent(err.message) }); res.end();
  }
}

async function handleAuthCallback(req, res, url) {
  try {
    const query = { state: url.searchParams.get('state'), code: url.searchParams.get('code') };
    const identity = await handleCallback(AUTH_CALLBACK_URL, query, AUTH_PROVIDERS);

    let user = userStore.findByEmail(identity.email);

    if (!user) {
      // Check for pre-approved entry
      user = userStore.findByEmail(identity.email);
      if (user && user.status === 'approved' && !user.provider) {
        // Pre-approved — provision and link
        const linuxUser = generateUsername(identity.email);
        createSystemAccount(linuxUser, identity.displayName);
        addToGroup(linuxUser, 'users');
        userStore.setLinuxUser(identity.email, linuxUser);
        userStore.linkProvider(identity.email, identity.provider, identity.providerId);
        user = userStore.findByEmail(identity.email);
      } else {
        // New user — create pending
        userStore.createPendingUser({
          email: identity.email,
          displayName: identity.displayName,
          provider: identity.provider,
          providerId: identity.providerId,
        });
        res.writeHead(302, { Location: '/pending?email=' + encodeURIComponent(identity.email) });
        res.end();
        return;
      }
    }

    // Update provider link if missing
    if (!userStore.findByProvider(identity.provider, identity.providerId)) {
      userStore.linkProvider(identity.email, identity.provider, identity.providerId);
    }

    userStore.updateLastLogin(identity.email);

    if (user.status === 'pending') {
      res.writeHead(302, { Location: '/pending?email=' + encodeURIComponent(identity.email) });
      res.end();
      return;
    }

    if (user.status === 'denied') {
      res.writeHead(302, { Location: '/login?error=Access+denied' });
      res.end();
      return;
    }

    // Approved — set cookie and redirect to dashboard
    const cookie = createSessionCookie({ email: identity.email, displayName: identity.displayName }, AUTH_SECRET, COOKIE_MAX_AGE);
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': `${COOKIE_NAME}=${cookie}; HttpOnly; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`,
    });
    res.end();
  } catch (err) {
    res.writeHead(302, { Location: '/login?error=' + encodeURIComponent(err.message) });
    res.end();
  }
}

function handleAuthMe(req, res) {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
  sendJson(res, 200, { email: user.email, displayName: user.display_name, status: user.status,
    linuxUser: user.linux_user, canApprove: !!(user.can_approve_users || user.can_approve_admins || user.can_approve_sudo) });
}

function handleAuthLogout(req, res) {
  res.writeHead(302, {
    Location: '/login',
    'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`,
  });
  res.end();
}
```

- [ ] **Step 4: Add admin route handlers**

```javascript
function handleAdminPage(req, res) {
  const user = requireAdmin(req, res);
  if (!user) return;
  try {
    const content = readFileSync(staticPath('admin.html'));
    setCors(res); res.setHeader('Content-Type', 'text/html'); res.writeHead(200); res.end(content);
  } catch { sendError(res, 500, 'Failed to read admin.html'); }
}

function handleAdminPending(req, res) {
  const user = requireAdmin(req, res);
  if (!user) return;
  sendJson(res, 200, userStore.listPending());
}

async function handleAdminApprove(req, res) {
  const user = requireAdmin(req, res);
  if (!user) return;
  const body = await readBody(req);
  const { email } = JSON.parse(body);
  const target = userStore.findByEmail(email);
  if (!target) return sendError(res, 404, 'User not found');

  const linuxUser = generateUsername(email);
  createSystemAccount(linuxUser, target.display_name);
  addToGroup(linuxUser, 'users');
  userStore.approveUser(email, user.email || 'root');
  userStore.setLinuxUser(email, linuxUser);
  sendJson(res, 200, { ok: true });
}

async function handleAdminDeny(req, res) {
  const user = requireAdmin(req, res);
  if (!user) return;
  const body = await readBody(req);
  const { email } = JSON.parse(body);
  userStore.denyUser(email);
  sendJson(res, 200, { ok: true });
}

async function handleAdminPreApprove(req, res) {
  const user = requireAdmin(req, res);
  if (!user) return;
  const body = await readBody(req);
  const { emails } = JSON.parse(body);
  userStore.preApprove(emails, user.email || 'root');
  sendJson(res, 200, { ok: true });
}

function handleAdminUsers(req, res) {
  const user = requireAdmin(req, res);
  if (!user) return;
  sendJson(res, 200, userStore.listUsers());
}

async function handleAdminFlags(req, res, email) {
  const user = requireAdmin(req, res);
  if (!user) return;
  if (!user.can_approve_admins && !user.can_approve_sudo && user.linux_user !== 'root') {
    return sendError(res, 403, 'Insufficient permissions');
  }
  const body = await readBody(req);
  const flags = JSON.parse(body);
  userStore.updateFlags(email, flags);
  sendJson(res, 200, { ok: true });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}
```

- [ ] **Step 5: Add routes to the router function**

In the `router` function in server.mjs, add these routes BEFORE the existing routes (so auth is checked first):

```javascript
  // Auth pages (public)
  if (req.method === 'GET' && pathname === '/login') return handleLogin(req, res);
  if (req.method === 'GET' && pathname === '/pending') return handlePendingPage(req, res);
  if (req.method === 'GET' && pathname === '/auth/me') return handleAuthMe(req, res);
  if (req.method === 'POST' && pathname === '/auth/logout') return handleAuthLogout(req, res);
  if (req.method === 'GET' && pathname === '/auth/callback') {
    handleAuthCallback(req, res, url).catch(err => { res.writeHead(302, { Location: '/login?error=' + encodeURIComponent(err.message) }); res.end(); });
    return;
  }
  if (req.method === 'GET' && pathname.startsWith('/auth/')) {
    const provider = pathname.split('/')[2];
    handleAuthStart(req, res, provider).catch(err => { res.writeHead(302, { Location: '/login?error=' + encodeURIComponent(err.message) }); res.end(); });
    return;
  }

  // Admin routes (protected)
  if (req.method === 'GET' && pathname === '/admin') return handleAdminPage(req, res);
  if (req.method === 'GET' && pathname === '/api/admin/pending') return handleAdminPending(req, res);
  if (req.method === 'POST' && pathname === '/api/admin/approve') { handleAdminApprove(req, res).catch(err => sendError(res, 500, err.message)); return; }
  if (req.method === 'POST' && pathname === '/api/admin/deny') { handleAdminDeny(req, res).catch(err => sendError(res, 500, err.message)); return; }
  if (req.method === 'POST' && pathname === '/api/admin/pre-approve') { handleAdminPreApprove(req, res).catch(err => sendError(res, 500, err.message)); return; }
  if (req.method === 'GET' && pathname === '/api/admin/users') return handleAdminUsers(req, res);
  if (req.method === 'PATCH' && pathname.startsWith('/api/admin/user/') && pathname.endsWith('/flags')) {
    const email = decodeURIComponent(pathname.split('/')[4]);
    handleAdminFlags(req, res, email).catch(err => sendError(res, 500, err.message));
    return;
  }

  // Auth middleware — protect all other routes
  if (AUTH_ENABLED) {
    const user = requireAuth(req, res);
    if (!user) return;
  }
```

Also add static file serving for `admin.mjs`:

```javascript
  if (pathname === '/admin.mjs') {
    try {
      const content = readFileSync(staticPath('admin.mjs'));
      setCors(res); res.setHeader('Content-Type', 'application/javascript'); res.writeHead(200); res.end(content);
    } catch { sendError(res, 500, 'Failed to read admin.mjs'); }
    return;
  }
```

- [ ] **Step 6: Restart and verify**

Restart server (no OAuth configured = dev mode, auth disabled):

```bash
bash restart-server.sh
```

Verify:
- `curl http://localhost:3200/login` returns login.html
- `curl http://localhost:3200/` returns dashboard (auth disabled in dev)
- `curl http://localhost:3200/admin` returns admin.html

- [ ] **Step 7: Run existing tests**

```bash
node --test test-server.mjs && node --test test-auth.mjs
```

All tests must pass.

- [ ] **Step 8: Commit**

```bash
git add server.mjs
git commit -m "feat: wire auth middleware, login/admin routes into server.mjs"
```

---

### Task 8: Run Full Validation

- [ ] **Step 1: Run all tests**

```bash
node --test test-server.mjs
node --test test-auth.mjs
node test-dashboard-e2e.mjs
```

All must pass.

- [ ] **Step 2: Manual verification**

- Visit `http://localhost:3200/login` — should show provider buttons
- Visit `http://localhost:3200/pending` — should show waiting room
- Visit `http://localhost:3200/admin` — should show admin panels
- Visit `http://localhost:3200/` — dashboard works (auth off in dev mode)

- [ ] **Step 3: Final commit if any cleanup needed**
