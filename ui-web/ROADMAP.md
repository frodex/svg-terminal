# Web UI — Unified Spec & Roadmap

**Date:** 2026-04-03  
**Status:** Draft — master checklist for all web-facing work across both repos  
**Unified project dashboard:** `/srv/claude-proxy/docs/integration/UNIFIED-PROJECT.md`

---

## 1. What this document is

A single place that combines every known **web UI** deliverable — from OAuth wiring through live terminal interaction — into a phased roadmap with references to the specs, plans, and prototypes that already exist. Nothing here replaces those docs; it indexes and sequences them.

**Audience:** Any session (human or agent) starting web UI work opens this file first.

---

## 2. System overview

```
Browser
  │
  ├─ claude-proxy web UI (port 3101)          ← THIS ROADMAP
  │    ├─ Login (OAuth → cookie)
  │    ├─ Lobby (session list, create, restart, fork, export)
  │    ├─ Session form (profile-aware fields)
  │    ├─ Admin panel (user management)
  │    └─ Terminal viewer (WebSocket stream)
  │
  └─ svg-terminal dashboard (port 3200)
       ├─ 3D card scene (Three.js CSS3DRenderer)
       ├─ Bridges to claude-proxy WS per cp-* session
       └─ Local tmux sessions (shared capture)
```

**Dependency:** claude-proxy is the **platform** (runs standalone). svg-terminal is a **client** (needs claude-proxy for `cp-*` integration).

---

## 3. Existing artifacts

### Prototypes & references (this directory)

| File | What |
|------|------|
| `prototype.html` | 10-screen clickable HTML prototype — login, pending, lobby, session form, pickers, admin, help. Mock data, no backend. |
| `ANSI-UI.md` | Complete reference of every ANSI screen/widget/color/key in claude-proxy TUI (~1200 lines) |
| `oauth-web-ui-references.md` | Index of all auth/registration/handoff docs across both repos with dates |

### Specs & plans (by topic)

| Topic | Doc | Status |
|-------|-----|--------|
| **Web UI prototype design** | `/srv/svg-terminal/docs/superpowers/specs/2026-04-02-web-ui-prototype-design.md` | Approved, built |
| **OAuth + API auth wiring** | `/srv/claude-proxy/docs/superpowers/specs/2026-04-03-oauth-web-api-wiring-spec.md` | Draft spec, no plan yet |
| **Launch profiles (lobby + API)** | `/srv/claude-proxy/docs/research/add-terminal.v05.md` | Research approved |
| **Launch profiles plan** | `/srv/claude-proxy/docs/superpowers/plans/2026-04-03-launch-profiles.md` | Plan written, not yet executed |
| **Auth shared contract** | `/srv/claude-proxy/docs/superpowers/plans/2026-03-29-auth-plan-a-shared-contract.md` | Implemented |
| **UGO socket security** | `/srv/claude-proxy/docs/superpowers/plans/2026-03-29-auth-plan-b-ugo-security.md` | Implemented |
| **OAuth providers** | `/srv/claude-proxy/docs/superpowers/plans/2026-03-29-auth-plan-c-oauth.md` | Code built, not wired |
| **Login & user management** | `/srv/svg-terminal/docs/superpowers/specs/2026-03-30-login-and-user-management-design.md` | Spec written |
| **Login plan (svg-terminal)** | `/srv/svg-terminal/docs/superpowers/plans/2026-03-30-login-and-user-management.md` | Plan written |
| **User registration** | `/srv/claude-proxy/docs/superpowers/specs/2026-03-27-user-registration-design.md` | Spec + notes |
| **WS bridge (svg-terminal ↔ CP)** | `/srv/svg-terminal/docs/superpowers/specs/2026-03-30-claude-proxy-websocket-integration-design.md` | Draft — needs auth update |
| **User identity / typing** | `/srv/svg-terminal/docs/PRD-amendment-005.md` | Planned |
| **Partial screen fix** | `/srv/svg-terminal/docs/integration/2026-04-02-claude-proxy-partial-screen-fix.v01.md` | Implemented |
| **Directory selector** | `/srv/claude-proxy/docs/superpowers/specs/2026-04-01-directory-selector-design.md` | Spec written |
| **Widget system** | `/srv/claude-proxy/docs/superpowers/specs/2026-03-31-widget-system-design.md` | Approved, implemented |
| **Handoff TODOs** | `/srv/claude-proxy/docs/superpowers/plans/2026-03-31-handoff-todos-v3.md` | Reference |
| **claude-proxy PRD (as-built)** | `/srv/claude-proxy/docs/integration/PRD-claude-proxy-as-built-v2.1.md` | Current |
| **svg-terminal PRD** | `/srv/svg-terminal/PRD-v0.5.1.md` + amendments 001–005 | Current |

---

## 4. Phased roadmap

### Phase W1 — OAuth wiring + minimal web shell (claude-proxy)

**Goal:** Real login works; `GET /api/auth/me` returns the authenticated user; protected API routes enforce cookies.

**Spec:** `2026-04-03-oauth-web-api-wiring-spec.md`  
**Plan:** Needs writing (or inline in spec — 11 file changes listed in §11).

| Task | Files | Notes |
|------|-------|-------|
| Promote `api` config block in `types.ts` / `config.ts` | `src/types.ts`, `src/config.ts` | `api.port`, `api.host`, `api.public_base_url`, `api.auth.required` |
| Build OAuth objects in `index.ts` | `src/index.ts` | `OAuthManager`, `GitHubAdapter`, `SQLiteUserStore`, pass to `startApiServer` |
| Central `requireWebUser` + protect routes | `src/api-server.ts` | Route classes: public / session-cookie / protected |
| ACL parity on session list | `src/api-server.ts` | `listSessions()` → `listSessionsForUser(u)` |
| ACL on create / mutate / stream | `src/api-server.ts` | `fakeClient.username = u`; owner = cookie user; WS auth |
| Minimal login page | `web/login.html` or `web/index.html` | Provider buttons → `/api/auth/login?provider=…` |
| Feature flag (`api.auth.required`) | `src/api-server.ts`, config | Legacy open when unset; refuse startup if providers + no secret |
| YAML config example | `claude-proxy.yaml` | Uncomment / document providers + session + api blocks |
| Tests | `tests/api-auth-wiring.test.ts` | Cookie validation, 401 without cookie, ACL filtering |

**Depends on:** Nothing (standalone claude-proxy work).  
**Unblocks:** Phase W2 (live web UI), Phase W4 (svg-terminal auth).

---

### Phase W2 — Live web UI (claude-proxy, port 3101)

**Goal:** Browser users can log in, see sessions, create/restart/fork, and view live terminal — all through the same `:3101` API the prototype mocks.

**Spec:** `2026-04-02-web-ui-prototype-design.md` (screens), plus API contract from `add-terminal.v05.md` §3.4  
**Plan:** Needs writing.

| Task | Files | Notes |
|------|-------|-------|
| Convert `prototype.html` → real pages | `web/` | Replace mock `showScreen()` with real `fetch('/api/...')` calls |
| Login screen | `web/login.html` | Redirect to `/api/auth/login?provider=…`; callback lands on `/` |
| Lobby → `GET /api/sessions` | `web/app.html` or SPA | Session list with badges, action buttons |
| Session form → `POST /api/sessions` | `web/` | Profile-aware (sends `launchProfile`); maps to form fields |
| Restart picker → `GET /api/sessions/dead` + `POST .../restart` | `web/` | |
| Fork picker → `POST .../fork` | `web/` | Only for sessions with `sessionIdBackfill` capability |
| Export → existing export endpoint (or add) | `web/` | |
| Terminal viewer → `WS /api/session/:id/stream` | `web/` | Same-origin cookie; render spans (reuse terminal.svg or build minimal) |
| Admin panel → user CRUD endpoints (when built) | `web/` | |
| Password prompt (modal) | `web/` | `POST` with password → join |

**Depends on:** Phase W1 (auth must work).  
**Unblocks:** End users on web.

---

### Phase W3 — Launch profiles (claude-proxy, SSH + API)

**Goal:** Lobby offers "New terminal" / "New Claude session" / "New Cursor session"; API accepts `launchProfile`; one internal pipeline.

**Research:** `add-terminal.v05.md`  
**Plan:** `2026-04-03-launch-profiles.md` (8 tasks, written)

| Task | Summary |
|------|---------|
| 1 | Profile registry (`src/launch-profiles.ts`) — types, 3 profiles, capabilities |
| 2 | `StoredSession.launchProfile` |
| 3 | Lobby menu items |
| 4 | `index.ts` wiring — `finalizeSessionFromResults` uses profile |
| 5 | YAML form gating (`dangermode`, `claudeSessionId`) |
| 6 | `scheduleClaudeIdBackfill` gated by capability |
| 7 | API accepts `launchProfile` |
| 8 | E2E manual verification |

**Depends on:** Nothing (can run in parallel with W1).  
**Unblocks:** Web UI session-type picker (Phase W2 form sends `launchProfile`).

---

### Phase W4 — svg-terminal auth + identity (svg-terminal)

**Goal:** svg-terminal `fetch` and WS bridge to claude-proxy carry auth credentials; typing indicators show real browser user identity.

**Specs:** PRD-amendment-005, WS integration spec (needs stepped update for auth)  
**Plan:** Needs writing.

| Task | Files | Notes |
|------|-------|-------|
| Store `_user` on WS connection | `server.mjs` | `getAuthUser(req)` already exists |
| Forward `user` field in input messages | `server.mjs` | Include in JSON forwarded to CP |
| CP records keystroke from stream input | `api-server.ts` | `statusBar.recordKeystroke(username)` |
| CP `composeTitle` includes typing state | `api-server.ts` | Match session-manager behavior |
| Auth on `fetch` to CP screen endpoint | `server.mjs` | Cookie forwarding, service token, or trust — depends on W1 flag |
| Auth on WS bridge to CP stream | `server.mjs` | Same credential strategy |
| Update WS integration spec (stepped) | `docs/integration/` | Remove "no auth on localhost" assumption |

**Depends on:** Phase W1 (CP auth must exist to test against).

---

### Phase W5 — User management + registration (claude-proxy)

**Goal:** Admin can approve/deny users, pre-approve by email, manage groups. New OAuth users see "pending" screen until approved.

**Specs:** `2026-03-27-user-registration-design.md`, `2026-03-30-login-and-user-management-design.md`  
**Plan:** `2026-03-30-login-and-user-management.md` (svg-terminal side); claude-proxy admin API endpoints not yet planned.

| Task | Notes |
|------|-------|
| `GET /api/admin/users` | List all registered users (OAuth identity + Linux mapping) |
| `PATCH /api/admin/users/:id` | Update approval flags |
| `POST /api/admin/users/:id/provision` | Provision Linux account |
| `POST /api/admin/invites` | Generate invite / pre-approve email |
| Admin web page | From prototype's admin screen |
| Pending-approval web page | From prototype's pending screen |

**Depends on:** Phase W1 (auth), Phase W2 (web shell).

---

### Phase W6 — Remote launch for non-Claude profiles (claude-proxy)

**Goal:** Shell and Cursor sessions can start on remote hosts, not just Claude.

**Research:** `add-terminal.v05.md` §4.2, §5  
**Plan:** Needs writing.

| Task | Notes |
|------|-------|
| Generic remote launcher script | Replace `launch-claude-remote.sh` with profile-aware script or parameterized wrapper |
| Profile registry `remoteSupport` flag | Already in capabilities (`false` for shell/cursor now) |
| PtyMultiplexer remote branch generalization | Factor out Claude-specific SCP + wrapper logic |

**Depends on:** Phase W3 (profiles must exist).

---

### Phase W7 — Cursor session-ID discovery (sub-project)

**Goal:** Resume and fork for Cursor sessions, matching Claude's `scheduleClaudeIdBackfill`.

**Research:** `add-terminal.v05.md` §5  
**Plan:** Needs research — how does Cursor store session state?

| Task | Notes |
|------|-------|
| Research Cursor session metadata on disk | Where does `cursor-agent` write session info? |
| Implement `discoverCursorSessionId` | Parallel to `discoverClaudeSessionId` |
| Enable capabilities on `cursor` profile | `sessionIdBackfill: true`, `resume: true`, `fork: TBD` |

**Depends on:** Phase W3 (profile infrastructure).

---

### Phase W8 — svg-terminal Phase D (future)

**Goal:** Remove `server.mjs` as a separate HTTP/WS server; claude-proxy serves static files and all sessions directly. svg-terminal becomes a pure client bundle.

**From:** svg-terminal PRD v0.5.1 §12.3 Phase D  
**Plan:** Not started.

| Task | Notes |
|------|-------|
| Claude-proxy serves `web/` static files (already partially there) | Unify `:3101` and `:3200` |
| Dashboard connects to claude-proxy WS directly | No bridge |
| Local tmux sessions managed by claude-proxy | All sessions through one manager |

**Depends on:** Phases W1–W4 complete and validated.

---

## 5. Dependency graph

```
W3 (Launch Profiles)  ──────────────────────────────────┐
  │                                                      │
  └─→ W6 (Remote non-Claude) ─→ W7 (Cursor session ID)  │
                                                         │
W1 (OAuth Wiring) ───────────────────────────────────────┤
  │                                                      │
  ├─→ W2 (Live Web UI) ─→ W5 (User Management)          │
  │                                                      │
  └─→ W4 (svg-terminal auth + identity)                  │
                                                         │
                                      W8 (Merge / Phase D) ← all above
```

**Parallelism:** W1 and W3 can run simultaneously. W2 needs W1. W4 needs W1. W6 needs W3. W7 needs W3.

---

## 6. What is NOT in scope

- Docker packaging / Vault (separate PRD future item)
- svg-terminal 3D scene, layout system, camera (covered by svg-terminal PRD §13)
- Cloudflare Access as sole auth provider (future — could replace or supplement OAuth)
- Mobile touch support (svg-terminal PRD F7)
- Session recording / playback
- Clustering / multi-server

---

## 7. How to use this document

1. **Starting web work?** Read the phase you're in. Follow the spec/plan links.
2. **Adding a feature?** Check if it fits an existing phase. If not, propose a new phase here.
3. **Stepping this doc:** `cp ROADMAP.md ROADMAP.v01.md` — edit only the new version. Same convention as research docs.

---

*Last updated: 2026-04-03 — initial roadmap from full audit of both repos.*
