# PRD Amendment 007 — Cursor profile: `cursor-agent` binary + launcher (check / install)

**Date:** 2026-04-04  
**Status:** Planned (not implemented)  
**Relates to:** [PRD.md](../PRD.md) §2 (architecture), §3 (server / sessions), claude-proxy launch profiles; [PRD Amendment 006](./PRD-amendment-006.md) (Unix socket integration)  
**Problem statement:** The `cursor` launch profile invoked a non-existent `cursor` binary; sessions exited immediately. The real CLI is **`cursor-agent`**. Behavior should match **Claude**: **`useLauncher`** + shell script that **checks**, **installs or instructs**, then **`exec`**.

---

## 1. Goals

1. Use executable **`cursor-agent`** for profile id **`cursor`** (API field **`launchProfile: "cursor"`** unchanged — svg-terminal, REST, TUI stay compatible).
2. Parity with **Claude** (`scripts/launch-claude.sh`): resolve PATH, common locations, optional install, clear failure messages.
3. Refactor **`PtyMultiplexer`** so launcher selection uses **`launchProfile` + `useLauncher`**, not only `options.command === 'claude'`.

---

## 2. References (implementation)

| Artifact | Role |
|----------|------|
| `/srv/claude-proxy/src/launch-profiles.ts` | Set `command: 'cursor-agent'`, `useLauncher: true` for `id: 'cursor'`. |
| `/srv/claude-proxy/scripts/launch-claude.sh` | Template for check → install → `exec` pattern. |
| `/srv/claude-proxy/src/pty-multiplexer.ts` | Branches on `command === 'claude'` today; extend for cursor launcher. |
| `/srv/claude-proxy/scripts/launch-claude-remote.sh` | Only if **`remoteSupport`** for cursor is enabled later. |

**Install reference (verify before shipping):** [Cursor install](https://cursor.com/install) — often `curl … \| bash`; confirm binary name on disk (`cursor-agent` vs `agent`) on target OS after install.

---

## 3. Stepped implementation plan

### Step 1 — Add `scripts/launch-cursor-agent.sh` (claude-proxy)

- Mirror **structure** of `launch-claude.sh`: optional `TSTP` trap (confirm if suspending agent in tmux is unsafe).
- **Resolve binary:** `command -v cursor-agent`, then fallback paths (TBD: e.g. `~/.local/bin`, `/usr/local/bin` — align with official installer output).
- **If found:** `exec cursor-agent "$@"` (pass through args; profile may add args later via `buildCommandArgs`).
- **If not found:** print whoami + short message; run **install** path:
  - Prefer official non-interactive flow if documented (e.g. `curl -fsSL https://cursor.com/install | bash`), then re-check `command -v`.
  - If installer requires TTY or fails: print **admin commands** + `read` + `exit 1` (same pattern as Claude when `npm` is missing).
- **Post-install:** verify binary; on failure print manual steps and exit non-zero.
- **Auth note (banner / doc):** Cursor may require `cursor-agent login` or `CURSOR_API_KEY`; v1 can document one line in the script output if full detection is out of scope.

### Step 2 — Update `launch-profiles.ts`

- **`cursor` profile:** `command: 'cursor-agent'`, **`useLauncher: true`**.
- Keep **`id: 'cursor'`** and **`key: 'c'`** — no API or dashboard enum change.
- Comment that bare binary must not be invoked from multiplexer when `useLauncher` is true.

### Step 3 — Refactor `pty-multiplexer.ts` (local sessions)

- Introduce **`resolveLocalLauncherPath(launchProfile)`** (or equivalent):
  - `'claude'` → `…/launch-claude.sh`
  - `'cursor'` + profile `useLauncher` → `…/launch-cursor-agent.sh`
  - else `null` (raw `command` + `args`).
- Replace checks **`options.command === 'claude'`** with launcher resolution by **`launchProfile`** (or `null` vs path) for:
  - local + `runAsUser` (`su - user -c 'cdPrefix + launcher + args'`)
  - local + no `runAsUser` (`cdPrefix + launcher`)
- Preserve **`cdPrefix`** (`mkdir -p` + `cd` for `workingDir`) behavior for all profiles.
- **Remote:** `cursor` currently has **`remoteSupport: false`**. **Defer** `launch-cursor-agent-remote.sh` unless product explicitly wants Cursor on remotes; then mirror `launch-claude-remote.sh` + scp/ssh pattern.

### Step 4 — Grep and tests (claude-proxy)

- Search for **`command === 'claude'`** and **`useLauncher`**; update any call site that should treat **cursor** like **claude** for launcher-only behavior (not fork/resume — cursor capabilities stay false).
- Add or update tests: session create with **`launchProfile: 'cursor'`** generates `/tmp/claude-proxy-launch-*.sh` referencing **`launch-cursor-agent.sh`**, not raw `cursor` / `cursor-agent` without launcher.

### Step 5 — Manual verification (host)

- New **Cursor** session from svg-terminal with **`workingDir`** set; empty PATH → expect install flow or clear instructions in pane, not instant exit.
- Root vs non-root: align with Claude’s per-user install behavior when using `su`.

### Step 6 — Documentation touchpoints (optional)

- One line in **PRD.md** roadmap or amendment index (this file already linked).
- If **sessions.md** or operator runbook exists, note **`cursor-agent`** requirement for Cursor profile.

---

## 4. Out of scope (this amendment)

- Changing **svg-terminal** `POST /api/sessions/create` contract (still sends `launchProfile: "cursor"`).
- **`remoteSupport: true`** for cursor without a dedicated remote launcher design.
- Full **auth automation** (`login` / API key) beyond messaging.

---

## 5. Risks

| Risk | Mitigation |
|------|------------|
| Binary name differs on disk (`agent` vs `cursor-agent`) | Verify after official install on target OS; adjust profile `command` + script once. |
| Interactive installer | Fallback message + `read` + exit 1. |
| Subscription / auth required for useful session | Document in launcher; optional v2. |

---

## 6. Completion criteria

- [ ] `launch-cursor-agent.sh` committed and executable.
- [ ] `launch-profiles.ts` updated; `useLauncher` true for cursor.
- [ ] `pty-multiplexer` uses profile-based launcher resolution.
- [ ] Tests updated; manual Cursor session starts agent or shows clear install/auth guidance.
- [x] [PRD.md](../PRD.md) amendment index references this document (§15).
