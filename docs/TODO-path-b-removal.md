# TODO: Remove direct tmux code (Path B) from svg-terminal

## Context

svg-terminal has two data paths to terminal sessions:
- **Path A:** svg-terminal → claude-proxy (Unix socket JSON-RPC) → tmux
- **Path B:** svg-terminal → tmux directly (via `execFile('tmux', ...)`)

Path B exists as legacy code and a fallback when claude-proxy is unavailable. All current sessions use Path A. Path B bypasses claude-proxy's permission model (viewOnly, allowedUsers, etc.) and creates sessions outside the managed lifecycle.

An earlier cleanup (2026-04-05) removed HTTP endpoints and consolidated browser-to-server communication onto WebSocket. But it kept all direct tmux code in the WS handlers, treating it as essential. It wasn't — it's the same dual-path problem, just moved from HTTP to WS.

## What needs to happen

1. **Decide:** Is claude-proxy a hard dependency? If yes, remove Path B entirely. If no, Path B needs the same auth/permission enforcement as Path A — which means duplicating claude-proxy's permission model in svg-terminal.

2. **Audit all direct tmux calls in server.mjs** — grep for `tmuxAsync`. Each one is either:
   - Used only for Path B (remove if Path B removed)
   - Used by both paths (needs to route through claude-proxy instead)
   - Used by the session watcher capture loop (needs claude-proxy equivalent)

3. **Key code to evaluate:**
   - `tmux new-session` fallback in WS `create-session` handler (~line 1098)
   - `tmux send-keys` for local session input (~lines 1367-1378)
   - `tmux resize-window` for local session resize (~line 1343)
   - `capturePane()` / `capturePaneAt()` used by SessionWatcher polling
   - `tmux list-sessions` in `sendSessionDiscovery()` and `get-sessions` WS handler
   - `tmux has-session` checks in `get-screen` WS handler

4. **Write a plan following `/srv/PHAT-TOAD-with-Trails/implementation-planner/implementation-plan-standards.md`** (Rules 1-7) before making any changes.

## Reference docs

- `sessions.md` — project context, pending items
- `docs/research/2026-04-05-v0.1-message-pipeline-architecture-journal.md` — pipeline analysis with both paths diagrammed
- `docs/superpowers/plans/2026-04-05-v0.1-legacy-http-cleanup.md` — the cleanup that removed HTTP but kept Path B
- `docs/superpowers/specs/implementation-plan-standards.md` — plan writing rules

## Do not

- Make changes without a reviewed plan
- Assume "no callers" without grepping
- Remove Path B without deciding on the claude-proxy dependency question first
