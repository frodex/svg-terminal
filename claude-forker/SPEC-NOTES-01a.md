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
claude-fork <source-session-id> <source-cwd> <target-cwd> [options]

Options:
  --user <username>     Target user (default: current user)
  --dry-run             Show what would happen, don't do it
  --quiet               Output only the new UUID on success (for scripts)
  --no-companion        Skip copying subagent/tool-result companion files

Exit codes:
  0  Success (new UUID on stdout)
  1  Source session not found
  2  Target user invalid or missing ~/.claude/
  3  Target directory creation failed
  4  CWD rewrite failed
  5  Chain integrity check failed after write
```

**Example calls:**

```bash
# Same user, different project
claude-fork 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 /root /srv/svg-terminal

# Different user
claude-fork 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 /root /srv/svg-terminal --user greg

# Dry run
claude-fork 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 /root /srv/new-project --dry-run

# Script mode (just the UUID)
NEW_ID=$(claude-fork 6a76ff6f /root /srv/proj --quiet)
```

---

## What Happens Step by Step

### Step 1 — Resolve source

```
Input:  source-session-id, source-cwd
Action: Encode source-cwd (/ → -), look up JSONL at:
        ~{source-user}/.claude/projects/{encoded-source-cwd}/{session-id}.jsonl
Check:  File exists? → exit 1 if not
Check:  Is source session currently running? → warn (not block)
Check:  Has source been compacted? → warn ("fork will have summary context only")
Report: Source size, record count, compaction status
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

## UI Validation (claude-proxy side)

Before calling `claude-fork`, the UI should validate:

| Field | Validation | Error |
|-------|-----------|-------|
| Session name | Non-empty, valid tmux name | "Session name required" |
| Source session ID | Matches UUID format | "Invalid session ID" |
| Working directory | Valid path or `~` | "Invalid path" |
| Run as user | User exists in /etc/passwd | "User not found" |
| Source exists | JSONL file exists at encoded path | "Source session not found at {path}" |

### UI should display before submit:

```
Fork summary:
  Source: 6a76ff6f (root@/root, 4.2MB, 1200 records, not compacted)
  Target: /srv/svg-terminal (as user: root)
  New session will load source's full conversation history
  Target has CLAUDE.md: Yes
  Target has .claude/settings.json: Yes

  [s=submit, e=edit, esc=cancel]
```

### UI warning conditions:

| Condition | Warning |
|-----------|---------|
| Source is currently running | "Source session is ACTIVE — fork will capture current state" |
| Source has been compacted | "Source was compacted — fork gets summary, not full history" |
| Target user has no cleanupPeriodDays | "Target user's sessions auto-delete after 30 days — set cleanupPeriodDays" |
| Target has no CLAUDE.md | "Target has no project instructions — agent will use only conversation history" |
| Source > 10MB | "Large session — fork may take a moment" |
| Target already has forks from same source | "Target already has N forks from this source" |

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
