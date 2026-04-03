# Unified project — single entry point

**Purpose:** One place to orient work across **svg-terminal** and **claude-proxy** without hunting each repo separately.

**Repos (expected layout on this machine):**

| Directory | Role |
|-----------|------|
| `/srv/svg-terminal` | Browser dashboard, `server.mjs`, WebSocket bridge to claude-proxy |
| `/srv/claude-proxy` | SSH multiplexer, tmux sessions, HTTP/WS API :3101 |

**Open both at once:** use the multi-root workspace file at repo root: **`/srv/svg-terminal/unified.code-workspace`** (File → Open Workspace from File in Cursor/VS Code).

---

## What to do today (rolling checklist)

Edit this section as you finish items; Git history preserves older snapshots.

| Priority | Task | Spec / doc |
|----------|------|------------|
| 1 | Wire OAuth + cookie auth into claude-proxy `startApiServer` | `/srv/claude-proxy/docs/superpowers/specs/2026-04-03-oauth-web-api-wiring-spec.md` |
| 2 | Minimal web login + `GET /api/me` + session list | Same spec §8 + `/srv/claude-proxy/web/` |
| 3 | When CP auth is on: svg-terminal `fetch` / WS bridge must send credentials | This file § “Auth boundary”; `2026-04-02-claude-proxy-partial-screen-fix.v01.md` §0 |
| 4 | (Later) Launch profiles / one API path | `/srv/claude-proxy/docs/research/add-terminal.v04.md` |

**claude-proxy live context:** `/srv/claude-proxy/sessions.md`  
**Integration history (stepped):** `docs/integration/2026-04-02-claude-proxy-partial-screen-fix.v01.md`

---

## Documentation map (all roads lead here)

| Topic | Canonical doc |
|-------|----------------|
| **This dashboard** | `docs/integration/UNIFIED-PROJECT.md` (here) |
| OAuth / HTTP / WS auth (claude-proxy) | `/srv/claude-proxy/docs/superpowers/specs/2026-04-03-oauth-web-api-wiring-spec.md` |
| Launch profiles & API orchestration research | `/srv/claude-proxy/docs/research/add-terminal.v04.md` |
| Claude-proxy session context & conventions | `/srv/claude-proxy/sessions.md` |
| WS bridge design (update when CP auth ships) | `docs/superpowers/specs/2026-03-30-claude-proxy-websocket-integration-design.md` |
| Typing indicators / user id (browser → CP) | `docs/PRD-amendment-005.md` |
| Partial screen + integration index | `docs/integration/2026-04-02-claude-proxy-partial-screen-fix.v01.md` |

---

## Commands (from unified checkout)

```bash
# claude-proxy
cd /srv/claude-proxy && npm run build && npx vitest run

# svg-terminal (adjust to your test command)
cd /srv/svg-terminal && node --test test-auth.mjs
```

---

## Auth boundary (when claude-proxy enables `api.auth.required`)

Server-to-server calls from svg-terminal to `http://127.0.0.1:3101` must include whatever the wiring spec requires (cookie forwarding, reverse proxy trust, or service token). PRD §12 claims like “no auth on localhost” are **invalid** once that flag is true — update the WebSocket integration spec in a **new stepped** file under `docs/integration/`.

---

## Stepped docs convention (this unified tree)

Under `docs/integration/`: **`cp`** frozen baselines to `.v01.md`, `.v02.md`, …; do not rewrite the prior step in place. Same idea as `sessions.md` in claude-proxy.

---

*Last updated: 2026-04-03 — replace “What to do today” as your sprint changes.*
