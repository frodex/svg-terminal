# Claude Forker — Specification

**Status:** Draft — needs Greg's review and comments
**Date:** 2026-04-01
**Context:** Sub-project of svg-terminal / claude-proxy

---

## What This Is

A CLI tool that forks an existing Claude Code session into a new or existing project directory, optionally under a different user. Called by claude-proxy's session creation UI, which collects parameters and validates inputs before invoking.

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
│  1. Reads source JSONL          │
│  2. Generates new UUID          │
│  3. Rewrites CWD in records     │
│  4. Writes to target dir        │
│  5. Copies companion files      │
│  6. Chowns if user changed      │
│  7. Returns new UUID on stdout  │
└──────────┬──────────────────────┘
           │
           │ exit 0 + UUID on stdout
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
  schema [command]      Output JSON schema for a command's response (or all commands)
  list                  List available sessions (default if no args)
  fork <id> <target>    Fork a session to a target directory

Global options:
  --json                Machine-readable JSON on stdout. No prompts, no color.
                        Warnings/errors go to stderr. Implies no confirmation prompts.
                        Contract: stdout is ALWAYS valid JSON or empty.

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
  3  Target directory creation failed
  4  CWD rewrite failed
  5  Chain integrity check failed after write
```

---

## Schema Discovery

```bash
# All schemas
claude-fork schema
# Output: { "commands": { "list": { ... }, "fork": { ... }, "schema": { ... } } }

# Schema for a specific command
claude-fork schema list
# Output: JSON Schema for the list response

claude-fork schema fork
# Output: JSON Schema for the fork response (success + error variants)
```

The schema command always outputs JSON regardless of `--json` flag. It returns standard JSON Schema (draft 2020-12) so the calling UI can validate responses at runtime.

```json
{
  "tool": "claude-fork",
  "version": "0.1.0",
  "commands": {
    "schema": {
      "description": "Output JSON schema for command responses",
      "args": "[command]",
      "response": "This object"
    },
    "list": {
      "description": "List available sessions",
      "args": "[--user <name>] [--all-users] [--project <path>]",
      "response": {
        "type": "object",
        "properties": {
          "command": { "const": "list" },
          "user": { "type": "string" },
          "sessions": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["sessionId", "project", "status"],
              "properties": {
                "sessionId": { "type": "string", "format": "uuid" },
                "project": { "type": "string", "description": "Decoded CWD path" },
                "encodedCwd": { "type": "string" },
                "jsonlPath": { "type": "string" },
                "sizeBytes": { "type": "integer" },
                "sizeHuman": { "type": "string" },
                "records": { "type": "integer" },
                "status": { "enum": ["active", "idle", "compacted"] },
                "pid": { "type": ["integer", "null"] },
                "compacted": { "type": "boolean" },
                "hasCompanion": { "type": "boolean" },
                "companionFiles": { "type": "integer" },
                "lastModified": { "type": "string", "format": "date-time" },
                "createdAt": { "type": "string", "format": "date-time" }
              }
            }
          },
          "warnings": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "fork": {
      "description": "Fork a session to a target directory",
      "args": "<session-id> <target-cwd> [--user <name>] [--dry-run] [--no-companion] [--no-create] [--no-session-cleanup]",
      "response": {
        "oneOf": [
          {
            "description": "Success",
            "type": "object",
            "required": ["command", "status", "source", "fork", "resume"],
            "properties": {
              "command": { "const": "fork" },
              "status": { "const": "success" },
              "source": {
                "type": "object",
                "properties": {
                  "sessionId": { "type": "string" },
                  "project": { "type": "string" },
                  "sizeBytes": { "type": "integer" },
                  "records": { "type": "integer" },
                  "compacted": { "type": "boolean" }
                }
              },
              "fork": {
                "type": "object",
                "properties": {
                  "sessionId": { "type": "string", "format": "uuid" },
                  "project": { "type": "string" },
                  "user": { "type": "string" },
                  "jsonlPath": { "type": "string" },
                  "sizeBytes": { "type": "integer" },
                  "recordsWritten": { "type": "integer" },
                  "cwdFieldsRewritten": { "type": "integer" },
                  "companionFilesCopied": { "type": "integer" },
                  "lastRecordCleaned": { "type": "boolean" }
                }
              },
              "resume": { "type": "string", "description": "Exact shell command to resume the fork" },
              "warnings": { "type": "array", "items": { "type": "string" } }
            }
          },
          {
            "description": "Error",
            "type": "object",
            "required": ["command", "status", "exitCode", "error"],
            "properties": {
              "command": { "const": "fork" },
              "status": { "const": "error" },
              "exitCode": { "type": "integer", "minimum": 1, "maximum": 5 },
              "error": { "type": "string" },
              "detail": { "type": "string" },
              "suggestions": { "type": "array", "items": { "type": "string" } }
            }
          },
          {
            "description": "Dry run",
            "type": "object",
            "required": ["command", "status", "wouldDo", "checks"],
            "properties": {
              "command": { "const": "fork" },
              "status": { "const": "dry-run" },
              "wouldDo": { "type": "object" },
              "checks": { "type": "object" },
              "warnings": { "type": "array", "items": { "type": "string" } }
            }
          }
        ]
      }
    }
  }
}
```

The UI integration pattern:

```javascript
// On startup — discover what the tool supports
const schema = JSON.parse(execSync('claude-fork schema'));
const listSchema = schema.commands.list.response;
const forkSchema = schema.commands.fork.response;

// Use schemas to validate responses at runtime
const listResult = JSON.parse(execSync('claude-fork list --json'));
validate(listResult, listSchema); // throws if response doesn't match
```

---

## Output Schemas (--json mode)

### `claude-fork list --json`

```json
{
  "command": "list",
  "user": "root",
  "sessions": [
    {
      "sessionId": "6a76ff6f-ca1e-4be9-b596-b2c0ae588d91",
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
      "lastModified": "2026-04-01T12:45:00Z",
      "createdAt": "2026-03-28T15:57:38Z"
    }
  ],
  "warnings": [
    "User greg has default cleanupPeriodDays (30 days)"
  ]
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
    "cwdFieldsRewritten": 1180,
    "companionFilesCopied": 12,
    "lastRecordCleaned": false
  },
  "resume": "cd /srv/svg-terminal && claude --resume a7da9a5d-8424-453b-84a5-05e2e36a0fa7",
  "warnings": [
    "Source session is ACTIVE (PID 3352832)"
  ]
}
```

Failure:
```json
{
  "command": "fork",
  "status": "error",
  "exitCode": 1,
  "error": "Source session not found",
  "detail": "No JSONL matching 6a76ff6f in any project directory",
  "suggestions": [
    "6a73ab12-de09-4a1c-b3f2-... (/root, 1.1MB, Mar 28)",
    "6a76ff6f-ca1e-4be9-b596-... found in /root but CWD encoded as -root"
  ]
}
```

### `claude-fork fork <id> <target> --dry-run --json`

```json
{
  "command": "fork",
  "status": "dry-run",
  "wouldDo": {
    "source": "/root/.claude/projects/-root/6a76ff6f-ca1e-4be9-b596-b2c0ae588d91.jsonl",
    "target": "/root/.claude/projects/-srv-svg-terminal/{new-uuid}.jsonl",
    "cwdRewrite": { "from": "/root", "to": "/srv/svg-terminal" },
    "userChange": null,
    "createDir": false,
    "companionFiles": 12
  },
  "checks": {
    "sourceExists": true,
    "sourceActive": true,
    "sourceCompacted": false,
    "targetDirExists": true,
    "targetHasClaudeMd": true,
    "targetUserHasClaude": true,
    "targetCleanupProtected": true
  },
  "warnings": [
    "Source session is ACTIVE (PID 3352832)"
  ]
}
```

**Contract:** In `--json` mode:
- **stdout** is always valid JSON (or empty on exit code > 0 with no structured error)
- **stderr** gets human-readable diagnostics (progress messages, warnings during execution)
- **Exit code** is the same as non-json mode (0=success, 1-5=specific failures)
- **No interactive prompts** — all confirmation is skipped (the calling UI handles user confirmation before invoking)
- **No ANSI color codes** on stdout

---

**Discovery — list available sessions:**

```bash
# List all sessions for current user
claude-fork list

# Output:
#   SESSION ID                             PROJECT           SIZE    RECORDS  STATUS      AGE
#   6a76ff6f-ca1e-4be9-b596-b2c0ae588d91   /root             4.2MB   1200     ACTIVE      4d
#   e3af93f5-13f3-470c-a5ba-94823a102b75   /root             20MB    3400     ACTIVE      4d
#   0317c840-f331-4eac-add0-a6f53550c517   /root             17MB    2800     idle        4d
#   72fd1d06-5e87-46fe-ad8a-8cb596b2c0e7   /srv/svg-terminal 1.2MB   340      idle        2d
#   c3c486aa-28dc-4010-9351-69f68a654e3b   /srv/marktext     0.8MB   210      idle        2d
#   ...
#
#   STATUS: ACTIVE = running PID found in ~/.claude/sessions/
#           idle   = JSONL exists, no running PID
#           COMPACTED = compact_boundary found in JSONL

# List sessions for a different user
claude-fork list --user greg

# List sessions from a specific project
claude-fork list --project /srv/svg-terminal

# List across all users (requires root)
claude-fork list --all-users

# JSON output for UI consumption
claude-fork list --json
# [
#   {
#     "sessionId": "6a76ff6f-ca1e-4be9-b596-b2c0ae588d91",
#     "project": "/root",
#     "encodedCwd": "-root",
#     "size": "4.2MB",
#     "records": 1200,
#     "status": "ACTIVE",
#     "pid": 3352832,
#     "compacted": false,
#     "age": "4d",
#     "lastModified": "2026-04-01T12:45:00Z",
#     "hasCompanion": true,
#     "companionFiles": 12
#   },
#   ...
# ]
```

**Forking — source is auto-resolved from session ID:**

```bash
# Fork to different project (source CWD auto-detected from JSONL location)
claude-fork fork 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 /srv/svg-terminal

# Fork to different user
claude-fork fork 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 /srv/svg-terminal --user greg

# Dry run
claude-fork fork 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 /srv/new-project --dry-run

# Script mode (just the new UUID)
NEW_ID=$(claude-fork fork 6a76ff6f /srv/proj --quiet)

# Short ID works — tool finds the match
claude-fork fork 6a76 /srv/svg-terminal
#   Found: 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 (/root, 4.2MB)
#   Fork to /srv/svg-terminal? [y/n]
```

---

## What Happens Step by Step

### Step 1 — Resolve source

```
Input:  source-session-id (full or prefix)
Action: Scan all directories under ~{user}/.claude/projects/*/
        for a JSONL matching the session ID (or prefix).
        Derive source-cwd from the encoded directory name (- → /).
Match:  Full UUID     → exact match
        Partial prefix → scan all projects dirs, list matches if ambiguous
        No match       → list similar IDs (levenshtein or prefix), exit 1
Check:  File exists? → exit 1 if not
Check:  Is source session currently running? → warn (not block)
Check:  Has source been compacted? → warn ("fork will have summary context only")
Report: Source path, CWD (derived), size, record count, compaction status
```

### Step 2 — Resolve target

```
Input:  target-cwd, --user (optional)
Action: Determine target user's home directory
Check:  Target user exists? → exit 2 if not
Check:  Target user has ~/.claude/ ? → create if missing
Check:  Target user has cleanupPeriodDays set? → warn if default (30-day delete risk)
Check:  Target directory exists? → create if missing, report
Check:  Target has CLAUDE.md? → report (agent will/won't get project instructions)
```

### Step 3 — Generate new UUID

```
Action: python3 -c "import uuid; print(uuid.uuid4())"
Report: "Fork UUID: {new-uuid}"
```

### Step 4 — Copy and rewrite

```
Action: Read source JSONL line by line
        For each record with cwd == source-cwd: rewrite to target-cwd
        Write to ~{target-user}/.claude/projects/{encoded-target-cwd}/{new-uuid}.jsonl
Report: "{N} records written, {M} CWD fields rewritten"
```

### Step 5 — Copy companion files

```
Action: If source has {session-id}/ directory:
          Copy to {new-uuid}/ in target
          Includes: subagents/*.jsonl, subagents/*.meta.json, tool-results/*.txt
Check:  Any companion files have CWD references? → rewrite if found (NEEDS TESTING)
Report: "{N} companion files copied" or "No companion files"
```

### Step 6 — Set ownership (if user changed)

```
Action: chown -R {target-user}:{target-group} on:
        - {new-uuid}.jsonl
        - {new-uuid}/ (companion directory)
Check:  Permissions correct? → verify with stat
```

### Step 7 — Verify integrity

```
Action: Read the new JSONL, build parentUuid chain
Check:  Every parentUuid points to an existing entry (or null for roots)
Check:  At least one root node exists
Check:  At least one leaf node exists
Report: "Chain integrity: OK ({N} entries, {B} branches, {L} leaves)"
        or "BROKEN: {details}" → exit 5
```

### Step 8 — Output

```
Quiet mode:  print("{new-uuid}") → exit 0
Normal mode: print summary + resume command → exit 0
```

---

## Pre-Fork Validation

These checks run BEFORE the fork begins. The UI collects the inputs; the CLI validates them. Failures block the fork.

### Source Validation

| Check | How | Failure |
|-------|-----|---------|
| Source JSONL exists | Look up `~{source-user}/.claude/projects/{encoded-source-cwd}/{session-id}.jsonl` | exit 1 — "Source session not found at {path}" |
| Source session ID is valid UUID | Regex match. On failure, scan source dir for prefix matches and list candidates | exit 1 — "Session not found. Did you mean:\n  6a76ff6f-ca1e-... (4.2MB, Mar 31)\n  6a73ab12-de09-... (1.1MB, Mar 28)" |
| Source is compacted? | `grep "compact_boundary" {source}.jsonl` | WARN (not block) — "Source was compacted — fork gets summary context only, not full history" |
| Source size | `du -h {source}.jsonl` | WARN if >10MB — "Large session — fork may take a moment" |
| Source is currently running? | Check `~/.claude/sessions/*.json` for matching sessionId with live PID | WARN (not block) — "SOURCE SESSION IS ACTIVE — fork will capture current state" |

### Target Validation

| Check | How | Failure |
|-------|-----|---------|
| Target directory exists | `test -d {target-cwd}` | Auto-create with `mkdir -p` (default). Use `--no-create` to fail instead: "Target directory {path} does not exist. Run with default behavior or create manually." |
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

### 5. Silent context loss from CWD mismatch
**Problem:** If the CWD rewrite misses records (edge case), the agent loads with partial or no history — silently.
**Prevention:** After writing the fork, run chain integrity check (Step 7). Count records with CWD matching target vs not matching. If any mismatch:
```
ERROR: {N} records still have CWD={old-cwd} after rewrite
  Fork may load with missing context. Aborting.
```

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
  /home/greg/.claude/projects/-home-greg-projects-foo/{new-uuid}.jsonl  (CWD rewritten, chowned)
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
  2. mkdir -p ~/.claude/projects/-srv-new-project/
  3. Copy + CWD rewrite
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
| CWD rewrite enables cross-directory resume | **VERIFIED** | 4MB session, 32% context loaded, agent retained full memory |
| New UUID filename works (internal sessionId mismatch) | **VERIFIED** | UUID `a7da9a5d` filename, internal `6a76ff6f`, loaded fine |
| Multiple forks coexist in same directory | **VERIFIED** | Fork A + Fork B, both loaded independently at 34% context |
| Claude Code finds sessions by directory scan, not internal ID | **VERIFIED** | Mismatched IDs worked across all tests |
| Without CWD rewrite, history silently not loaded | **VERIFIED** | Session found (no error) but 0% context, "no previous conversation" |

## Needs Testing

| Claim | Status | Risk |
|-------|--------|------|
| Cross-user fork (root → greg) | **UNTESTED** | Permissions, file access, claude binary path |
| Companion file CWD references | **UNTESTED** | Subagent meta.json may have CWD baked in |
| Fork of compacted session | **UNTESTED** | Should work but only summary context preserved |
| Fork of session with active concurrent resume | **UNTESTED** | Which branch gets copied? Most recent leaf? |
| Chain integrity after CWD-only rewrite | **TESTED OK** | parentUuid chain unaffected by CWD rewrite |
| Very large sessions (>50MB) | **UNTESTED** | Performance, memory during rewrite |

---

## Files

```
/srv/svg-terminal/claude-forker/
├── SPEC.md                     ← this file
├── docs/
│   ├── how-it-works.md         ← reference copy of how-to-fork-claude.md
│   ├── testing-via-tmux.md     ← reference copy of tmux testing journal
│   └── session-anatomy.md      ← reference copy of fork mechanics journal
├── tools/
│   └── claude-fork             ← the CLI tool (to be built)
└── tests/
    └── test-fork.sh            ← automated test harness (to be built)
```
