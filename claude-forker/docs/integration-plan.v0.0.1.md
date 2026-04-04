# claude-fork Integration Plan for claude-proxy

**Status:** Plan — not yet approved for implementation
**Date:** 2026-04-02
**Author:** claude-proxy agent (session `1bb81f91`)
**Reviewed:** The integration spec at `docs/claude-proxy-integration.md` by Steward 02

---

## Context: Two Fork Mechanisms

claude-proxy currently has a **built-in fork** that uses Claude Code's native `--fork-session` flag. The `claude-fork` CLI tool does something fundamentally different. They must coexist.

| | Built-in fork | claude-fork |
|---|---|---|
| **Mechanism** | `claude --resume <id> --fork-session` | Copy JSONL + CWD rewrite, then `claude --resume <new-uuid>` |
| **Cross-directory** | No — same project only | Yes — rewrites CWD fields in every record |
| **Cross-user** | No | Yes — chowns files to target user |
| **Session data** | Claude handles internally | Tool copies JSONL + companion files |
| **When to use** | Fork within same project/user | Fork across projects or users |

**Decision needed:** Should `claude-fork` replace the built-in fork entirely, or should the UI offer both? The built-in fork is lighter (no file copying), but claude-fork handles the superset case. My recommendation: use claude-fork for all forks where workdir or user changes, keep built-in fork for same-dir/same-user forks.

---

## What the Integration Spec Gets Right

1. The form fields (name, runas, workdir, claudeSessionId) map correctly to claude-fork's CLI args
2. The metadata storage proposal (forkedFrom, forkId, forkDate) aligns with our existing `pastClaudeSessionIds` pattern
3. The dry-run → summary → execute flow is sound
4. Error handling with exit codes maps to our form validation

## What the Integration Spec Gets Wrong or Doesn't Know

### 1. Fork is not triggered from the "create" screen

The spec assumes putting a session ID in the create form triggers fork mode. That's not how it works:

- **Current fork entry points:**
  - `Ctrl+B f` from inside a session → `startForkFlow()` in session-manager.ts
  - `f` from the lobby → `finalizeForkFromLobby()` in index.ts
- **Create screen** has `claudeSessionId` hidden (`visible: false`)

The fork flow is a separate mode (`'fork'` in `SessionFormMode`), not a variant of create.

### 2. workdir is currently LOCKED on fork

The YAML config has `fork: { visible: true, locked: false, prefill: true }` for workdir — wait, actually I was wrong. Let me correct: workdir IS unlocked on fork in the current YAML. But `sessions.md` says "workdir locked on edit/restart/fork." The YAML is authoritative and shows `locked: false` for fork workdir. So the spec's assumption that you can change workdir on fork is actually correct per the YAML config.

**However:** The current `executeFork()` passes `session.workingDir` (the source's workdir) to `createSession()` regardless of what the form says. The form result for workdir is collected but not used for the fork launch. This is a bug or intentional constraint — needs verification.

### 3. The launch mechanism is more complex than shown

The spec shows `execSync` calling claude-fork directly. In reality:
- Sessions launch via `PtyMultiplexer` constructor → writes a temp bash script → `tmux new-session` runs the script
- The script calls `scripts/launch-claude.sh` which finds/installs claude and does `exec claude "$@"`
- For remote sessions, scripts are SCP'd to the remote host first

claude-fork must run **before** the tmux session is created, not inside it.

### 4. The "session picker" widget doesn't exist

The spec proposes showing `claude-fork list` results as a picker when the user clicks the session ID field. We don't have a "click" — this is a TUI. The `claudeSessionId` field is currently a plain `TextInput`. A session picker would need a new widget or repurposing the existing `ListPicker`.

### 5. runas field is locked on fork — cross-user fork needs unlocking

The spec's cross-user scenario requires `runas` to be editable on fork. Currently locked. This is an intentional constraint (can't change UID of running process). But for claude-fork, we're creating a NEW session, so the constraint doesn't apply in the same way.

### 6. Metadata uses JSON files, not YAML

The spec shows YAML for metadata. claude-proxy uses JSON files in `data/sessions/<tmuxId>.json` via `session-store.ts`. The fields proposed (`forkedFrom`, `forkId`, `forkDate`) should be added to the `StoredSession` interface.

---

## Files to Modify

### Core changes

| File | What changes |
|---|---|
| `src/session-form.yaml` | Add new mode `cross-fork` or modify `fork` mode to unlock workdir + runas. Add new field or flag for fork type selection. |
| `src/session-form.ts` | Add claude-fork CLI invocation logic. New function `executeCrossFork()`. Extend `WidgetContext` with session list callback. |
| `src/session-manager.ts` | Modify `executeFork()` to detect when workdir/user changed and route to claude-fork instead of built-in `--fork-session`. |
| `src/index.ts` | Modify `finalizeForkFromLobby()` similarly — detect cross-dir/cross-user and route to claude-fork. |
| `src/session-store.ts` | Add `forkedFrom`, `forkId`, `forkDate` fields to `StoredSession` interface. |
| `src/pty-multiplexer.ts` | No changes needed — the tmux launch stays the same, only the args change (new UUID from claude-fork instead of `--fork-session`). |

### New files

| File | Purpose |
|---|---|
| `src/claude-fork-client.ts` | Wrapper around the claude-fork CLI. Handles `list --json`, `fork --json`, `fork --dry-run --json`. Parses responses, maps exit codes to errors. Single place to change if the tool's API evolves. |

### Test files

| File | Purpose |
|---|---|
| `tests/claude-fork-client.test.ts` | Unit tests for CLI wrapper (mock execSync, test JSON parsing, error mapping) |
| `tests/session-form-crossfork.test.ts` | Integration tests for cross-fork flow through the form engine |

---

## The Flow

### Fork from inside a session (Ctrl+B f)

```
User presses Ctrl+B f
  → startForkFlow() builds form with mode='fork'
  → Form shows: name (editable), runas (editable*), workdir (editable), claudeSessionId (locked)
  → User changes workdir to /srv/new-project (or leaves same)
  → User presses 's' to submit

IF workdir changed OR runas changed:
  → claude-fork path (NEW)
  → Call: claude-fork fork <sessionId> <newWorkdir> --user <runas> --dry-run --json
  → Parse dry-run response
  → Show fork summary screen with warnings
  → User confirms (Enter) or cancels (Escape)
  → Call: claude-fork fork <sessionId> <newWorkdir> --user <runas> --json
  → Parse response, get fork.sessionId
  → createSession() with args: ['--resume', forkSessionId] (NO --fork-session)
  → Store metadata: forkedFrom, forkId, forkDate
  → Enter new session

ELSE (same workdir, same user):
  → Built-in fork path (EXISTING)
  → createSession() with args: ['--resume', claudeId, '--fork-session']
  → Existing behavior unchanged
```

### Fork from lobby ('f')

Same logic, but triggered from lobby menu. The form is built the same way.

### Create with session ID (NEW — optional future feature)

The integration spec proposes making `claudeSessionId` visible on create to enable "fork as create." This is a separate feature and should NOT be in the initial integration. It blurs the create/fork boundary and would confuse users who just want a new session.

---

## claude-fork-client.ts Design

```typescript
// Thin wrapper around the CLI tool
const CLAUDE_FORK_BIN = '/srv/svg-terminal/claude-forker/tools/claude-fork';

interface ForkListResult {
  command: 'list';
  user: string;
  sessions: ForkSessionInfo[];
  warnings: string[];
}

interface ForkSessionInfo {
  sessionId: string;
  project: string;
  sizeHuman: string;
  records: number;
  status: 'active' | 'idle' | 'compacted';
  pid: number | null;
}

interface ForkDryRunResult {
  command: 'fork';
  status: 'dry-run';
  checks: Record<string, any>;
  warnings: string[];
}

interface ForkSuccessResult {
  command: 'fork';
  status: 'success';
  fork: { sessionId: string; project: string; user: string; recordsWritten: number };
  resume: string;
  warnings: string[];
}

interface ForkErrorResult {
  command: 'fork';
  status: 'error';
  exitCode: number;
  error: string;
  detail?: string;
  suggestions?: string[];
}

// Functions:
export function listSessions(user?: string): ForkListResult;
export function dryRunFork(sessionId: string, targetDir: string, user?: string): ForkDryRunResult | ForkErrorResult;
export function executeFork(sessionId: string, targetDir: string, user?: string): ForkSuccessResult | ForkErrorResult;
```

All three call `execSync` with `--json` flag, parse stdout as JSON, and throw on non-JSON output.

---

## session-form.yaml Changes

### Option A: Modify existing fork mode

Unlock `runas` and add a note that it enables cross-user fork:

```yaml
  - id: runas
    ...
    modes:
      fork:    { visible: true, locked: false, prefill: true }  # was locked: true
```

**Risk:** This changes behavior for all forks, even same-dir forks where runas change doesn't make sense.

### Option B: Add a new mode (recommended)

Add `cross-fork` mode to the YAML:

```yaml
  - id: runas
    ...
    modes:
      fork:       { visible: true, locked: true, prefill: true }   # same-dir fork
      cross-fork: { visible: true, locked: false, prefill: true }  # cross-dir fork
```

**Risk:** Adds complexity to the mode system. But it's the clean separation.

### Option C: Dynamic locking based on context

Keep one `fork` mode but let the code override `locked` based on whether claude-fork is available:

```typescript
// In createWidget(), if field.id === 'runas' && mode === 'fork' && claudeForkAvailable:
//   override locked = false
```

**Risk:** Config says locked but behavior isn't — confusing.

**Recommendation:** Option A for now. Unlocking runas on fork is safe because we're creating a NEW session in all cases. The current lock was a conservative choice when fork always meant same-dir. Document the change.

---

## Session Metadata Changes

Add to `StoredSession` interface in `session-store.ts`:

```typescript
interface StoredSession {
  // ... existing fields ...
  forkedFrom?: string;          // source Claude session ID
  forkId?: string;              // new UUID from claude-fork (or Claude's internal fork ID)
  forkDate?: string;            // ISO timestamp of fork
  forkTool?: 'builtin' | 'claude-fork';  // which mechanism was used
  forkSourceProject?: string;   // original project directory (for cross-dir forks)
}
```

---

## What I Haven't Verified

These are claims from the integration spec and SPEC.md that I need to test before implementation:

| Claim | My concern |
|---|---|
| "CWD rewrite enables cross-directory resume" | Spec says verified, but I haven't run the tool myself |
| "New UUID filename works (internal sessionId mismatch)" | Spec says verified — Claude finds by directory scan not internal ID |
| Cross-user fork (root → greg) | Spec marks as UNTESTED — permissions could break |
| claude-fork tool produces valid JSON on all error paths | Need to test edge cases |
| Tool handles concurrent access (active session fork) | Spec marks as UNTESTED |
| Performance on large sessions (>50MB) | Spec marks as UNTESTED |

**Before implementing, I should run the tool manually with a real session to verify the basic flow works.**

---

## Implementation Order

1. **claude-fork-client.ts** — CLI wrapper with tests (mock execSync)
2. **session-store.ts** — Add fork metadata fields
3. **session-form.yaml** — Unlock runas on fork mode
4. **session-manager.ts** — Route to claude-fork when workdir/runas changed in fork flow
5. **index.ts** — Same routing for lobby fork
6. **Manual test** — Fork a real session across directories via SSH
7. **Session picker** (optional, later) — ListPicker for `claude-fork list` results

---

## Open Questions for Greg

1. **Should claude-fork replace built-in fork entirely?** The tool handles the superset case, but built-in fork is lighter for same-dir forks. I recommend keeping both, routing by context.

2. **Should the create screen gain a "fork from" field?** The integration spec proposes this. I think it's a separate feature — fork has its own entry points already.

3. **Is the tool path hardcoded or configurable?** Currently I'd hardcode `/srv/svg-terminal/claude-forker/tools/claude-fork`. Should it be in a config file or environment variable?

4. **Cross-user fork: unlock runas on fork?** Currently locked "because you can't change UID of a running process." But claude-fork creates a NEW process. Unlocking seems correct.

5. **Session picker priority?** The `claude-fork list` picker would be nice but is new widget work. Should it be in v1 or deferred? User can paste a session ID manually for now.

6. **Where should the tool live long-term?** Currently at `/srv/svg-terminal/claude-forker/tools/claude-fork`. Should it be vendored into claude-proxy or stay external?
