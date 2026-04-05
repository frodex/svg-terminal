# Claude Forker — Specification

**SPEC version:** v0.0.9  
**Tool (`claude-fork`) version:** 0.2.0  

**Status:** Draft — needs Greg's review and comments  
**Date:** 2026-04-01 (SPEC); implementation stepped 2026-04-05  
**Context:** Sub-project of svg-terminal / claude-proxy

---

## What This Is

A CLI tool that forks an existing Claude Code session into a new or existing project directory, optionally under a different user. Called by claude-proxy's session creation UI, which collects parameters and validates inputs before invoking.

It resolves project storage paths using the same directory-name rules as Claude Code (`encode_cwd` / legacy compat; see `docs/migration.md`), scans for source sessions including optional git-worktree fallback, re-stamps **`sessionId`** on forked transcript lines, rewrites **`cwd`** on **chain** records, verifies **`parentUuid`** integrity on the output file, and copies companion artifacts.

---

## Architecture

```
┌─────────────────────────────────┐
│  claude-proxy session UI        │
│                                 │
│  Session name: [___________]    │
│  Run as user:  [root      ▾]   │
│  Working dir:  [/srv/proj ▾]   │
│  Session ID:   [6a76ff6f LOCK]  │
│                                 │
│  [s=submit]                     │
└──────────┬──────────────────────┘
           │
           │ validates inputs
           │
           ▼
┌─────────────────────────────────┐
│  claude-fork (CLI)              │
│                                 │
│  1. Find source JSONL (scan      │
│     ~/.claude/projects; optional │
│     git worktree fallback)      │
│  2. Resolve target project dir  │
│     (sanitizePath-style encode +│
│     legacy + long-path prefix)   │
│  3. New UUID for forked file     │
│  4. Copy JSONL: re-stamp         │
│     sessionId; rewrite cwd on    │
│     chain records only           │
│  5. Copy companion dir           │
│  6. Optional chown for --user    │
│  7. verify_chain (parentUuid)    │
│  8. Emit JSON or human summary   │
│     + resume shell line          │
└──────────┬──────────────────────┘
           │
           │ exit 0 (+ JSON on stdout in --json mode)
           │
           ▼
┌─────────────────────────────────┐
│  claude-proxy tmux launcher     │
│                                 │
│  su - {user} -c "              │
│    cd {target-cwd} &&           │
│    claude --resume {fork-uuid}" │
│                                 │
│  (in named tmux session)        │
└─────────────────────────────────┘
```

---

## CLI Interface

```
claude-fork [command] [options]

Commands:
  help [command]        Show usage, options, and examples (default if no args)
  schema [command]      Output JSON schema for a command's response (or all commands)
  list                  List available sessions
  fork <id> <target>    Fork a session to a target directory

Global options:
  --json                Machine-readable JSON on stdout for list/fork. No prompts, no color.
                        For `fork --json`, warnings are inside the JSON object. Implies no
                        confirmation prompt for fork.
                        The `schema` subcommand always prints JSON (it does not use `--json`).

Contract: For `list --json` and `fork --json`, stdout is a single JSON object.

List options:
  --user <username>     List sessions for a specific user (default: current user)
  --all-users           List sessions across all users with ~/.claude/
  --project <path>      Filter to sessions from a specific project directory

Fork options:
  --user <username>     Target user (default: current user)
  --dry-run             Show what would happen, don't fork
  --no-companion        Skip copying subagent/tool-result companion files
  --no-create           Fail if target directory doesn't exist (default: auto-create)
  --no-session-cleanup  Skip last-record validation (copy raw, for forensic use)

Exit codes:
  0  Success
  1  Source session not found
  2  Target user invalid or missing ~/.claude/
  3  Target directory missing (--no-create), ambiguous project directory, or related resolution failure
  5  Chain integrity check failed after write
```

---

## Help

`claude-fork` or `claude-fork help` prints:

```
claude-fork — Fork Claude Code sessions across projects and users

USAGE
  claude-fork list [options]            List available sessions
  claude-fork fork <id> <target> [opt]  Fork a session to a target directory
  claude-fork schema [command]          Output JSON schema for responses
  claude-fork help [command]            Show this help

LIST
  claude-fork list                      All sessions for current user
  claude-fork list --user greg          Sessions for a specific user
  claude-fork list --all-users          Sessions across all users (requires root)
  claude-fork list --project /srv/foo   Filter to one project directory
  claude-fork list --json               Machine-readable JSON output

FORK
  claude-fork fork 6a76 /srv/target     Fork session to new project (short ID ok)
  claude-fork fork 6a76 /srv/target --user greg
                                        Fork and assign to different user
  claude-fork fork 6a76 /srv/new --dry-run
                                        Show what would happen, don't do it
  claude-fork fork 6a76 /srv/target --json
                                        Machine-readable output for scripts/UI

  Options:
    --user <name>          Target user (default: current)
    --dry-run              Preview without forking
    --no-companion         Skip subagent/tool-result files
    --no-create            Don't auto-create target directory
    --no-session-cleanup   Skip last-record validation

EXAMPLES
  # See what's available
  claude-fork list

  # Fork your steward to a new project
  claude-fork fork 6a76ff6f /srv/new-project

  # Deploy a trusted agent to svg-terminal as greg
  claude-fork fork 6a76ff6f /srv/svg-terminal --user greg

  # Checkpoint before risky work (same dir)
  claude-fork fork 6a76ff6f /root

  # Script: fork and immediately launch
  NEW=$(claude-fork fork 6a76 /srv/proj --json | jq -r '.fork.sessionId')
  cd /srv/proj && claude --resume $NEW

HOW IT WORKS
  1. Finds the source JSONL by scanning all ~/.claude/projects/ directories
     (also checks sibling git worktrees if session not found)
  2. Resolves the target project directory
     (checks current encoding, legacy encoding, and prefix fallback)
  3. Copies the JSONL with a new UUID to the target
  4. Re-stamps sessionId and cwd on conversation records
     (metadata entries get sessionId only — cwd is provenance)
  5. Copies subagent and tool-result companion files
  6. Verifies parentUuid chain integrity
  7. The forked session resumes with full conversation history

  The source session is never modified.

EXIT CODES
  0  Success
  1  Source session not found
  2  Target user invalid
  3  Target directory / ambiguous project directory
  5  Chain integrity check failed

VERSION
  claude-fork 0.2.0
  Docs: /srv/svg-terminal/claude-forker/SPEC.md
```

`claude-fork help fork` prints the fork section only. `claude-fork help list` prints the list section only.

---

## Schema Discovery

Authoritative JSON for response shapes is emitted by **`claude-fork schema`** (stdout). It includes `tool`, `version` (`0.2.0`), and `commands.list` / `commands.fork` with nested JSON Schema–style objects. There is **no** `--examples` flag; embed fixtures in the UI or load the checked golden file:

- **`tests/fixtures/schema-expected.json`** — byte-for-byte match with `claude-fork schema` (see `tests/test-fork.sh`).

```bash
claude-fork schema              # full document
claude-fork schema list         # list response schema only
claude-fork schema fork         # fork oneOf: success | error | dry-run
```

**List (high level):** Top-level `user` is `null` when using `list --all-users`; otherwise the filter user or current user. Each session’s `project` is the original CWD from JSONL (first record with `cwd`), not a decode of `encodedCwd`.

**Fork success (high level):** `source`, `fork`, **`chain`**, `resume`, `warnings`. The `fork` object includes `chainRecords`, `nonChainRecords`, `cwdFieldsRewritten`, `sessionIdFieldsRewritten`, etc. The `chain` object reports `verify_chain` statistics (`entries`, `nonChainEntries`, `roots`, `leaves`, `branches`, `broken`, `warnings`, `badLines`).

**Fork dry-run:** `wouldDo.cwdRewrite` is either `null` or `{ "from": [string, ...], "to": string, "recordsAffected": number }` (one entry per distinct source CWD when prior forks mixed paths). `checks.encodingMethod` is one of `current`, `legacy-compat`, `prefix-fallback`, `new-directory`.

The UI integration pattern:

```javascript
const schema = JSON.parse(execSync('claude-fork schema', { encoding: 'utf8' }));
const listResult = JSON.parse(execSync('claude-fork list --json', { encoding: 'utf8' }));
// validate(listResult, schema.commands.list.response);
```

---

## Output Schemas (--json mode)

### `claude-fork list --json`

Top-level `user` is `null` when `--all-users` is used (sessions carry their own `user` field). Otherwise it is the filter user or the current user.

```json
{
  "command": "list",
  "user": "root",
  "sessions": [
    {
      "sessionId": "6a76ff6f-ca1e-4be9-b596-b2c0ae588d91",
      "user": "root",
      "project": "/root",
      "encodedCwd": "-root",
      "jsonlPath": "/root/.claude/projects/-root/6a76ff6f-ca1e-4be9-b596-b2c0ae588d91.jsonl",
      "sizeBytes": 4200000,
      "sizeHuman": "4.2MB",
      "records": 1200,
      "status": "active",
      "pid": 3352832,
      "compacted": false,
      "hasCompanion": true,
      "companionFiles": 12,
      "lastModified": "2026-04-01T12:45:00+00:00",
      "createdAt": "2026-03-28T15:57:38+00:00",
      "age": "4d"
    }
  ],
  "warnings": []
}
```

### `claude-fork fork <id> <target> --json`

Success:

```json
{
  "command": "fork",
  "status": "success",
  "source": {
    "sessionId": "6a76ff6f-ca1e-4be9-b596-b2c0ae588d91",
    "project": "/root",
    "sizeBytes": 4200000,
    "records": 1200,
    "compacted": false
  },
  "fork": {
    "sessionId": "a7da9a5d-8424-453b-84a5-05e2e36a0fa7",
    "project": "/srv/svg-terminal",
    "user": "root",
    "jsonlPath": "/root/.claude/projects/-srv-svg-terminal/a7da9a5d-8424-453b-84a5-05e2e36a0fa7.jsonl",
    "sizeBytes": 4200000,
    "recordsWritten": 1200,
    "chainRecords": 1150,
    "nonChainRecords": 50,
    "cwdFieldsRewritten": 1130,
    "sessionIdFieldsRewritten": 1200,
    "companionFilesCopied": 12,
    "lastRecordCleaned": false
  },
  "chain": {
    "entries": 1150,
    "nonChainEntries": 50,
    "roots": 1,
    "leaves": 1,
    "branches": 0,
    "broken": 0,
    "warnings": [],
    "badLines": 0
  },
  "resume": "cd /srv/svg-terminal && claude --resume a7da9a5d-8424-453b-84a5-05e2e36a0fa7",
  "warnings": [
    "Source session is ACTIVE (PID 3352832)"
  ]
}
```

Failure (stdout JSON; typical):

```json
{
  "command": "fork",
  "status": "error",
  "exitCode": 1,
  "error": "Source session not found",
  "detail": "No JSONL matching 'deadbeef'",
  "suggestions": [
    "6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 (/root, 4096KB, Apr 01)"
  ]
}
```

Exit **3** is used for missing target directory with `--no-create`, **ambiguous project directory** (`find_project_dir` prefix collision), and related resolution failures.

### `claude-fork fork <id> <target> --dry-run --json`

`wouldDo.target` is a concrete path (a new UUID is chosen for the dry run). `cwdRewrite.from` is always an array of source CWD strings (possibly one element).

```json
{
  "command": "fork",
  "status": "dry-run",
  "wouldDo": {
    "source": "/root/.claude/projects/-root/6a76ff6f-ca1e-4be9-b596-b2c0ae588d91.jsonl",
    "target": "/root/.claude/projects/-srv-svg-terminal/a7da9a5d-8424-453b-84a5-05e2e36a0fa7.jsonl",
    "cwdRewrite": {
      "from": ["/root"],
      "to": "/srv/svg-terminal",
      "recordsAffected": 1180
    },
    "userChange": null,
    "createDir": false,
    "companionFiles": 12
  },
  "checks": {
    "sourceExists": true,
    "sourceActive": true,
    "sourceActivePid": 3352832,
    "sourceCompacted": false,
    "sourceRecords": 1200,
    "sourceChainRecords": 1150,
    "sourceNonChainRecords": 50,
    "sourceSizeHuman": "4096KB",
    "targetDirExists": true,
    "targetHasClaudeMd": true,
    "targetUserHasClaude": true,
    "targetCleanupProtected": true,
    "encodingMethod": "current"
  },
  "warnings": [
    "Source session is ACTIVE (PID 3352832)"
  ]
}
```

**Contract:** In `--json` mode for `list` and `fork --json` / `fork --dry-run --json`:

- **stdout** is a single JSON object (errors included in the object when the tool emits structured errors).
- **Warnings** for fork are included in the JSON `warnings` array (not only on stderr).
- **Exit code:** `0` success; `1` source not found / ambiguous ID; `2` target user invalid; `3` target path / ambiguous project dir; `5` chain broken after write. There is **no** exit code `4`.
- **`fork` without `--json`** still prompts for confirmation unless combined with `--json` or `--dry-run` (dry-run never writes).
- **No ANSI color codes** on stdout.

---

**Discovery — list available sessions:**

```bash
# List all sessions for current user
claude-fork list

# Output:
#   SESSION ID                             PROJECT           SIZE    RECORDS  STATUS      AGE
#   6a76ff6f-ca1e-4be9-b596-b2c0ae588d91   /root             4.2MB   1200     active      4d
#   e3af93f5-13f3-470c-a5ba-94823a102b75   /root             20MB    3400     active      4d
#   0317c840-f331-4eac-add0-a6f53550c517   /root             17MB    2800     idle        4d
#   72fd1d06-5e87-46fe-ad8a-8cb596b2c0e7   /srv/svg-terminal 1.2MB   340      idle        2d
#   c3c486aa-28dc-4010-9351-69f68a654e3b   /srv/marktext     0.8MB   210      idle        2d
#   ...
#
#   STATUS: active = running PID found in ~/.claude/sessions/
#           idle   = JSONL exists, no running PID
#           compacted = compact_boundary found in JSONL

# List sessions for a different user
claude-fork list --user greg

# List sessions from a specific project
claude-fork list --project /srv/svg-terminal

# List across all users (requires root)
claude-fork list --all-users

# JSON output for UI consumption (object with command, user, sessions, warnings)
claude-fork list --json
```

**Forking — source is auto-resolved from session ID:**

```bash
# Fork to different project (source CWD auto-detected from JSONL location)
claude-fork fork 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 /srv/svg-terminal

# Fork to different user
claude-fork fork 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 /srv/svg-terminal --user greg

# Dry run
claude-fork fork 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 /srv/new-project --dry-run

# Script: new session id (parse JSON)
NEW_ID=$(claude-fork fork 6a76ff6f /srv/proj --json | jq -r '.fork.sessionId')

# Short ID works — tool finds the match
claude-fork fork 6a76 /srv/svg-terminal
#   Found: 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 (/root, 4.2MB)
#   Fork to /srv/svg-terminal? [y/n]
```

---

## What Happens Step by Step

### Step 1 — Resolve source

```
Input:  source-session-id (full or prefix); search is under current user's
        ~/.claude/projects/ (see multi-user note in repo docs).
Action: Scan each project subdirectory for *.jsonl; match stem to full id or prefix.
        If git worktree fallback applies (session not in primary scan), shell out
        git worktree list --porcelain from cwd and re-check encoded paths.
Source CWD: From JSONL via read_cwds_from_jsonl (aggregate); primary fork source
        uses the most frequent cwd value.
Match:  Exact stem → return file + cwd map
        Single prefix match → same
        Multiple prefix matches → exit 1 (ambiguous), list tuples
        No match → exit 1 with suggestion strings (cwd from read_first_cwd_from_jsonl)
Check:  Active PID via ~/.claude/sessions → warn
Check:  compact_boundary in JSONL → warn
```

### Step 2 — Resolve target

```
Input:  target-cwd, --user (target user only)
Action: Resolve target user's home; find_project_dir(target_cwd) for existing
        ~/.claude/projects/<encoded>/ or legacy slash-only or long-path prefix.
        If none, use projects/<encode_cwd(target_cwd)> (may create).
Check:  Target user exists? → exit 2 if not
Check:  Ambiguous prefix match → exit 3
Check:  --no-create and target working dir missing → exit 3
Check:  cleanupPeriodDays, claude binary, CLAUDE.md → warn as implemented
```

### Step 3 — Generate new UUID

```
Action: uuid.uuid4(); ensure {fork_id}.jsonl does not already exist under target dir
```

### Step 4 — Copy and rewrite

```
Action: Stream source JSONL; fork_record() per line:
        Re-stamp sessionId on all records that have it; rewrite cwd on chain
        participants only when it differs from target.
Report: recordsWritten, cwdFieldsRewritten, sessionIdFieldsRewritten, chain vs metadata counts
```

### Step 5 — Copy companion files

```
Action: If source has {session-id}/ companion tree, copy to target_projects_dir/{fork_id}/
Report: companionFilesCopied
```

### Step 6 — Set ownership (if user changed)

```
Action: chown new jsonl and companion tree to target user
```

### Step 7 — Verify integrity

```
Action: verify_chain() single pass (chain participants only)
Check:  broken == 0 required; warnings/badLines informational
Failure: exit 5
```

### Step 8 — Output

```
--json: full JSON document on stdout (list or fork success/error/dry-run)
Interactive fork: human summary + resume line; structured fields mirror JSON
```

---

## Pre-Fork Validation

These checks run BEFORE the fork begins. The UI collects the inputs; the CLI validates them. Failures block the fork.

### Source Validation

| Check | How | Failure |
|-------|-----|---------|
| Source JSONL exists | Scan `~/.claude/projects/*/<id>.jsonl` (and worktree fallback); source user is always the invoking user’s store today | exit 1 — JSON `"error": "Source session not found"` with `suggestions` |
| Source session ID prefix | Partial id may match 0, 1, or many JSONL stems | exit 1 — ambiguous or not found as implemented in `find_session` |
| Source is compacted? | `grep "compact_boundary" {source}.jsonl` | WARN (not block) — "Source was compacted — fork gets summary context only, not full history" |
| Source size | `du -h {source}.jsonl` | WARN if >10MB — "Large session — fork may take a moment" |
| Source is currently running? | Check `~/.claude/sessions/*.json` for matching sessionId with live PID | WARN (not block) — "SOURCE SESSION IS ACTIVE — fork will capture current state" |

### Target Validation

| Check | How | Failure |
|-------|-----|---------|
| Target working directory | `test -d {target-cwd}` | Auto-create with `mkdir -p` (default). `--no-create` → exit **3** if missing |
| Target project dir encoding | `find_project_dir` + `encode_cwd` | Ambiguous long-path prefix → exit **3** |
| Target user exists | `id {user}` | exit 2 — "User {user} not found" |
| Target user has `~/.claude/` | `test -d ~{user}/.claude/` | Create it — `mkdir -p ~{user}/.claude/projects/` |
| Target user has claude installed | `test -x ~{user}/.local/bin/claude` OR `which claude` | WARN — "Claude Code not found for user {user} — session cannot be resumed until installed" |
| Target user has `cleanupPeriodDays` set | `grep cleanupPeriodDays ~{user}/.claude/settings.json` | WARN — "Target user's sessions auto-delete after 30 days — set cleanupPeriodDays: 99999" |
| Target has CLAUDE.md | `test -f {target-cwd}/CLAUDE.md` | INFO — "No project instructions at target — agent will use only conversation history" |
| Target has .claude/settings.json | `test -f {target-cwd}/.claude/settings.json` | INFO — "No project settings at target" |

### Pre-Fork Summary (UI displays before submit)

```
Fork summary:
  Source: 6a76ff6f (root@/root, 4.2MB, 1200 records, not compacted)
  ⚠ Source session is ACTIVE (PID 3352832)
  Target: /srv/svg-terminal (as user: root)
  New session will load source's full conversation history
  Target has CLAUDE.md: Yes
  Target has .claude/settings.json: Yes
  Target already has 2 forks from this source

  [s=submit, e=edit, esc=cancel]
```

---

## Anti-Patterns the UI Must Prevent

### 1. Overwrite on re-fork
**Problem:** Forking the same source to the same directory twice overwrites the first fork.
**Prevention:** Every fork gets a new UUID. No collision possible. The UI does NOT reuse session IDs.
**Implementation:** `claude-fork` always generates a fresh UUID via `uuid.uuid4()` (122 bits of randomness — collision probability ~1 in 2^61). As a safety check, verify `test -f {target}/{new-uuid}.jsonl` before writing. If exists (essentially impossible), regenerate. There is no option to specify a target UUID.

### 2. Forking an active session — truncated last record
**Problem:** The source JSONL is append-only. If the source session is actively writing during the copy, the last line may be truncated mid-JSON (partial write captured).
**Prevention:** After copy, validate the last line is parseable JSON. If not, truncate to the last valid line. This is safe — the truncated line was an incomplete append, not meaningful data.
**Flags:**
- Default behavior: validate and clean up last record if corrupted
- `--no-session-cleanup`: skip validation, copy raw (for forensic use)
**Additional check:** Compare source file size before and after copy. If source grew during copy, report: "Source grew by {N} bytes during copy — fork captured state at copy start, not current state."
**Session active warning:** Check `~/.claude/sessions/*.json` for matching sessionId with live PID. If active, show:
```
⚠ SOURCE SESSION IS ACTIVE (PID {pid})
  Fork will capture the current state. Last record validated for completeness.
  [y=proceed, n=cancel]
```

### 3. Forking to a user without Claude Code installed
**Problem:** The fork creates the JSONL in the target user's `~/.claude/projects/`, but the user can't resume it because `claude` isn't installed.
**Prevention:** Check for `~{user}/.local/bin/claude` or `which claude` as the target user. If not found:
```
⚠ Claude Code not found for user {user}
  The session will be created but cannot be resumed until Claude Code is installed.
  Install with: su - {user} -c "curl -fsSL https://claude.ai/install.sh | sh"
  [y=proceed anyway, n=cancel]
```

### 4. Forking a compacted session without warning
**Problem:** The fork preserves only the compact summary, not the full conversation history. The agent's "character" is diminished.
**Prevention:** `grep "compact_boundary" {source}.jsonl`. If found:
```
⚠ SOURCE SESSION HAS BEEN COMPACTED
  The fork will include only the summary context, not the original
  full conversation. For full character preservation, use a
  pre-compaction backup if available.
  [y=proceed, n=cancel]
```

### 5. Chain integrity after fork
**Problem:** Corrupt or inconsistent `parentUuid` links would yield a broken transcript.
**Prevention:** `verify_chain` runs on the **new** JSONL; any `broken > 0` fails the fork (exit **5**). CWD rewriting is limited to **chain participants**; metadata `cwd` is left as provenance by design.

### 6. No backup before modifying source
**Problem:** The fork tool should NEVER modify the source. But bugs happen.
**Prevention:** The tool opens the source JSONL read-only. It writes to a NEW file in the target directory. The source path and target path are always different (different directories or different UUIDs). There is no code path that writes to the source.

---

## Scenarios

### Scenario A: Fork to same directory, same user

```
Source: root@/root session 6a76ff6f
Target: root@/root

Result:
  ~/.claude/projects/-root/{new-uuid}.jsonl  (CWD stays /root, no rewrite needed)
  Resume: cd /root && claude --resume {new-uuid}
```

Use case: Checkpoint. Preserve agent before risky work.

### Scenario B: Fork to different project, same user

```
Source: root@/root session 6a76ff6f
Target: root@/srv/svg-terminal

Result:
  ~/.claude/projects/-srv-svg-terminal/{new-uuid}.jsonl  (CWD rewritten)
  Resume: cd /srv/svg-terminal && claude --resume {new-uuid}
  Agent loads: /srv/svg-terminal/CLAUDE.md + /srv/svg-terminal/.claude/settings.json
```

Use case: Deploy trusted agent to different project.

### Scenario C: Fork to different user

```
Source: root@/root session 6a76ff6f
Target: greg@/home/greg/projects/foo

Result:
  /home/greg/.claude/projects/-home-greg-projects-foo/{new-uuid}.jsonl  (directory name from sanitizePath-style encode_cwd; CWD rewritten, chowned)
  Resume: su - greg -c "cd /home/greg/projects/foo && claude --resume {new-uuid}"
```

Use case: Give a team member a copy of a trusted agent.

**NEEDS TESTING:** Does a session created by root work when resumed by greg? The JSONL may contain tool results that reference files only root can read. The agent will have greg's permissions, not root's.

### Scenario D: Fork to new project (doesn't exist yet)

```
Source: root@/root session 6a76ff6f
Target: root@/srv/new-project (doesn't exist)

Actions:
  1. mkdir -p /srv/new-project
  2. mkdir -p ~/.claude/projects/-srv-new-project/   (encode_cwd("/srv/new-project"))
  3. Copy JSONL; fork_record (sessionId + chain cwd)
  4. Optionally create /srv/new-project/CLAUDE.md from template

Result:
  Agent arrives in empty project with full memory
```

Use case: Start new project with experienced agent.

### Scenario E: Re-fork (same source, same target, again)

```
Source: root@/root session 6a76ff6f (fork already exists in target from last week)
Target: root@/srv/svg-terminal

Result:
  New UUID generated — no collision with previous fork
  Previous fork's JSONL untouched
  Both forks coexist in target directory

Resume picker will show BOTH forks (plus any work done on the previous fork)
```

Use case: Weekly fresh deployment. Previous fork ages, new fork is fresh.

---

## Verified Behaviors (2026-04-01)

| Claim | Status | Evidence |
|-------|--------|----------|
| Target cwd + chain `cwd` rewrite enables cross-directory resume | **VERIFIED** (historical) | Prior manual tests; see journals |
| `sessionId` in forked JSONL matches new file stem | **BY DESIGN** | `fork_record` re-stamps every record that has `sessionId` |
| Multiple forks coexist in same directory | **VERIFIED** | Distinct UUID filenames under same encoded project dir |
| Claude Code discovers sessions via `~/.claude/projects/<encode_cwd(cwd)>/` | **ALIGNED** | `encode_cwd` matches Claude `sanitizePath` semantics (v0.2+) |
| Wrong or missing cwd in chain records hurts tool/context behavior | **VERIFIED** (historical) | Motivation for selective cwd rewrite on chain participants only |

## Needs Testing

| Claim | Status | Risk |
|-------|--------|------|
| Cross-user fork (root → greg) | **UNTESTED** | Permissions, file access, claude binary path |
| Companion file CWD references | **UNTESTED** | Subagent meta.json may have CWD baked in |
| Fork of compacted session | **UNTESTED** | Should work but only summary context preserved |
| Fork of session with active concurrent resume | **UNTESTED** | Which branch gets copied? Most recent leaf? |
| Chain integrity after fork (sessionId + selective cwd) | **TESTED OK** | `verify_chain` on output; exit 5 if broken |
| Very large sessions (>50MB) | **UNTESTED** | Performance, memory during rewrite |

---

## Files

```
/srv/svg-terminal/claude-forker/
├── SPEC.md                     ← this file
├── docs/
│   ├── migration.md            ← encoding / legacy directory behavior (v0.2+)
│   ├── how-it-works.md         ← reference copy of how-to-fork-claude.md
│   ├── testing-via-tmux.md     ← reference copy of tmux testing journal
│   └── session-anatomy.md      ← reference copy of fork mechanics journal
├── tools/
│   └── claude-fork             ← CLI (Python 3; `VERSION` in file)
└── tests/
    ├── test-fork.sh            ← schema + encode_cwd regression
    └── fixtures/
        └── schema-expected.json ← golden `claude-fork schema` output
```
