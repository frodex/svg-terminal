# Login & User Management — Design Spec

**Date:** 2026-03-30
**Status:** Draft (v4 — merged codebase)
**Branch:** camera-only-test
**Goal:** Add login UI, request-access flow, and admin user management to svg-terminal

---

## 1. Architecture

```
Browser (user)
    │
    ▼
server.mjs (port 3200) ── unified web server
    │   Serves: dashboard, login, pending, admin pages
    │   Owns: OAuth, session cookies, user store, provisioning
    │   Owns: session streaming (WebSocket), terminal rendering
    │   Talks to: tmux (local sessions) + claude-proxy (cp-* sessions via internal API)
    │
    ▼
Linux OS (security boundary)
    tmux sockets (UGO permissions), system accounts, cp-* groups
```

**svg-terminal is the unified product.** OAuth, user store, provisioner, and session cookie code are ported from claude-proxy into this repo. server.mjs owns everything web-facing.

**claude-proxy remains as the SSH transport + internal session API** on port 3101. server.mjs proxies to it for `cp-*` session discovery and WebSocket streaming (already working). No auth changes needed in claude-proxy.

**The shared layer is Linux.** Both systems use the same Unix accounts and `cp-*` groups. Users provisioned by server.mjs can SSH into claude-proxy.

---

## 2. Code to Port from claude-proxy

These modules were built in claude-proxy's repo for svg-terminal to consume. They're being merged in:

| claude-proxy source | svg-terminal destination | Purpose |
|--------------------|-----------------------|---------|
| `src/auth/user-store.ts` | `user-store.mjs` | SQLite user database (better-sqlite3) |
| `src/auth/oauth.ts` | `auth.mjs` | Google/Microsoft OIDC (openid-client) |
| `src/auth/github-adapter.ts` | `auth.mjs` | GitHub OAuth |
| `src/auth/session-cookie.ts` | `session-cookie.mjs` | HMAC-SHA256 signed cookies |
| `src/auth/provisioner.ts` | `provisioner.mjs` | useradd, groupadd, installClaude |
| `src/auth/resolve-user.ts` | `resolve-user.mjs` | OAuth identity → Linux user mapping |

Port from TypeScript to plain JS (ESM). Follow svg-terminal's zero-framework style.

### New Dependencies

| Package | Purpose |
|---------|---------|
| `openid-client` | Google/Microsoft OIDC discovery + token exchange |
| `better-sqlite3` | SQLite database |

---

## 3. User Data Model

### User States

```
(new OAuth login)
      │
      ▼
   pending ──deny──▶ denied
      │
   approve
      │
      ▼
   approved ──▶ (Linux account provisioned, added to cp-users)
```

### Database Schema (SQLite, owned by server.mjs)

**users table:**

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `email` | TEXT PRIMARY KEY | — | OAuth email |
| `display_name` | TEXT | — | From OAuth profile |
| `linux_user` | TEXT | NULL | Generated on approval |
| `provider` | TEXT | — | google, github, microsoft |
| `provider_id` | TEXT | — | OAuth subject ID |
| `status` | TEXT | `'pending'` | pending, approved, denied |
| `approved_by` | TEXT | NULL | email of approver (audit) |
| `can_approve_users` | INTEGER | 0 | Can approve user requests |
| `can_approve_admins` | INTEGER | 0 | Can approve + grant approval rights |
| `can_approve_sudo` | INTEGER | 0 | Can approve + grant admin/sudo |
| `created_at` | TEXT | — | ISO timestamp |
| `last_login` | TEXT | NULL | ISO timestamp |

**provider_links table** (for multi-provider linking):

| Column | Type | Purpose |
|--------|------|---------|
| `provider` | TEXT | google, github, microsoft |
| `provider_id` | TEXT | OAuth subject ID |
| `email` | TEXT FK | → users.email |
| `linked_at` | TEXT | ISO timestamp |

**Pending users:** DB row, no Linux account (`linux_user` is NULL).

**Approved users:** Linux account provisioned, added to `cp-users`.

**Pre-approved users:** DB row with `status: approved`, email set, no provider link. First OAuth login triggers instant provisioning.

### Approval Permissions

Each level implies the ones below:
- `can_approve_sudo` → can set all flags, approve anyone
- `can_approve_admins` → can set `can_approve_users` on others
- `can_approve_users` → can approve pending requests

Root can flag any user. Only flagged users (plus root) can approve.

---

## 4. Login Flow

### Pages (served by server.mjs)

**`/login`** — OAuth provider selection
- Three buttons: Google, GitHub, Microsoft
- Dark theme matching dashboard

**`/auth/callback`** — OAuth return (handled by server.mjs directly)
- Exchanges code for token via openid-client / GitHub adapter
- Checks user store by email:
  - **Approved** → set cookie, redirect to `/`
  - **Pending** → redirect to `/pending`
  - **Pre-approved (first login)** → provision account, set cookie, redirect to `/`
  - **New** → create `pending` entry, redirect to `/pending`
  - **Denied** → redirect to `/login` with error

**`/pending`** — Waiting room
- "Your request has been submitted"
- Name, email displayed
- "Check status" button polls, redirects when approved

**`/`** — Dashboard (protected)
- Auth middleware: no cookie → `/login`, pending → `/pending`

**`/admin`** — User management (protected: `can_approve_*` or root)

### OAuth Flow

```
Browser                    server.mjs (3200)              OAuth Provider
   │                            │                               │
   │── GET /auth/google ───────▶│── 302 to Google ────────────▶│
   │◀── 302 ───────────────────│                               │
   │── (user authenticates) ───────────────────────────────────▶│
   │◀── 302 /auth/callback?code=X ────────────────────────────│
   │                            │                               │
   │── GET /auth/callback ─────▶│── exchange code for token ──▶│
   │                            │◀── { email, name, id } ──────│
   │                            │                               │
   │                            │── check/create user in SQLite │
   │◀── Set-Cookie + 302 ──────│                               │
```

**Session cookie:** HMAC-SHA256 signed. Contains email + expiry. Validated locally.

---

## 5. Admin UI

### Pending Requests Panel

- Name, email, provider, request date
- Approve → provisions Linux account, status → `approved`, adds to `cp-users`
- Deny → status → `denied`

### User List Panel

- Name, email, linux_user, groups, approved_by, last login
- Approval flag toggles (scoped to viewer's permission level)

### Pre-Approve Panel

- Text area for emails (one per line or comma-separated)
- Creates `approved` entries — users skip pending on first login

### Rendering

Server-side HTML. No framework. Dark theme. POST forms. JS for confirm dialogs only.

---

## 6. API Endpoints (all server.mjs)

### Auth

| Method | Path | Purpose |
|--------|------|---------|
| GET | /login | Login page |
| GET | /auth/:provider | Start OAuth (google, github, microsoft) |
| GET | /auth/callback | OAuth return, set cookie |
| GET | /auth/me | Current user JSON |
| POST | /auth/logout | Clear cookie |

### Admin

| Method | Path | Requires |
|--------|------|----------|
| GET | /admin | Admin page HTML | `can_approve_*` |
| GET | /api/admin/pending | List pending | `can_approve_*` |
| POST | /api/admin/approve | Approve user | `can_approve_*` |
| POST | /api/admin/deny | Deny user | `can_approve_*` |
| POST | /api/admin/pre-approve | Pre-approve emails | `can_approve_*` |
| GET | /api/admin/users | List all users | `can_approve_*` |
| PATCH | /api/admin/user/:id/flags | Set approval flags | `can_approve_admins`+ |

---

## 7. Files

### New

| File | Purpose |
|------|---------|
| `user-store.mjs` | SQLite user DB (ported from claude-proxy) |
| `auth.mjs` | OAuth: Google/Microsoft OIDC + GitHub adapter |
| `session-cookie.mjs` | HMAC-SHA256 cookie create/validate |
| `provisioner.mjs` | useradd, groupadd, installClaude |
| `resolve-user.mjs` | OAuth identity → user lookup/creation |
| `login.html` | OAuth provider selection page |
| `pending.html` | "Request submitted" page |
| `admin.html` | User management page |
| `admin.mjs` | Client-side JS for admin page |

### Modified

| File | Change |
|------|--------|
| `server.mjs` | Auth middleware, auth routes, admin routes, serve new pages |
| `package.json` | Add openid-client, better-sqlite3 |

---

## 8. What Does NOT Change

- 3D dashboard, terminal rendering, focus system, layout
- WebSocket protocol (already normalized)
- Session discovery + WebSocket proxy to claude-proxy
- Claude-proxy (no changes — SSH transport + internal API unchanged)
- UGO socket permissions
- E2E tests (auth bypass for testing)

---

## 9. Out of Scope (Later Phases)

- Classes/courses as data entities
- CSV roster import
- Join codes / invite links
- Role labels (teacher, student, TA)
- Session creation from web UI
- Group management UI
- User profile editing
- Password/local auth
- Making port 3101 a Unix socket with UGO permissions
