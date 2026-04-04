# Claude Session Persistence — Complete Guide Journal v0.3
**Date:** 2026-03-31
**Session:** Greg + Claude Opus 4.6 (session `6a76ff6f-ca1e-4be9-b596-b2c0ae588d91`)
**Status:** In Progress — empirically verified + research confirmed
**Preceding:** 2026-03-31-v0.2-claude-resume-fork-mechanics-journal.md
**Changes from v0.2:** Added settings hierarchy (user vs project .claude), file tree relationships (how subagents/tool-results link to parent JSONL), fork-session vs concurrent-resume distinction, encoded-cwd mapping, community tools inventory (9+ projects), brain surgery code attribution, bibliography entries

---

## Part 1 — How Sessions Are Stored

### The Full Session Architecture on Disk

A Claude Code session spans THREE locations on disk:

```
1. SESSION INDEX (maps running PIDs to session IDs)
~/.claude/sessions/
├── {pid}.json                             ← one file per running Claude process
│   {
│     "pid": 3352832,
│     "sessionId": "6a76ff6f-...",
│     "cwd": "/root",
│     "startedAt": 1774973674130,
│     "kind": "interactive",
│     "entrypoint": "cli"
│   }
└── ...

2. CONVERSATION STORAGE (the JSONL tree)
~/.claude/projects/{encoded-cwd}/
├── {session-id}.jsonl                     ← main conversation (append-only)
└── {session-id}/                          ← companion directory
    ├── subagents/
    │   ├── agent-{id}.jsonl               ← subagent's full conversation
    │   ├── agent-{id}.meta.json           ← links agent to parent tool_use
    │   └── agent-{id}/subagents/          ← nested subagents (recursive)
    └── tool-results/
        └── {tool-use-id}.txt              ← large outputs stored out-of-band

3. FILE HISTORY (Esc+Esc rewind backups)
~/.claude/file-history/                    ← overflow file backups (can grow to 300GB+)
```

Where `{encoded-cwd}` replaces `/` with `-` (e.g., `/root` → `-root`, `/srv/svg-terminal` → `-srv-svg-terminal`). See Part 1B for the full mapping.

### The Session Index — How Claude Code Finds Sessions

The `~/.claude/sessions/` directory is the **session registry**. Each running Claude Code process creates a `{pid}.json` file containing the session ID, working directory, and start time. This is the lookup table that `--resume` and `--continue` use.

**How `--resume {id}` works:**
1. Scans `~/.claude/sessions/*.json` for a matching `sessionId` (or scans the projects directory)
2. Gets the `cwd` from the index entry
3. Encodes the CWD: `/root` → `-root`
4. Opens `~/.claude/projects/-root/{id}.jsonl`
5. Follows the parentUuid chain to reconstruct the conversation

**Multiple PIDs can reference the same session ID.** On this machine, PIDs 3352832 and 3386235 both point to session `6a76ff6f` — these are the two concurrent instances from our fork experiment. The index doesn't prevent this; it just records what's running.

**Index entries for dead processes persist.** The `.json` files are not cleaned up when a process exits normally or crashes. On this machine, 13 index entries exist and all 13 PIDs are still running (some since March 25).

**Live inventory of this machine (2026-03-31):**

| PID | Session ID (short) | CWD | Running Since |
|-----|-------------------|-----|---------------|
| 903 | 1b483c4a | /root | Mar 25 |
| 82293 | 78676ef8 | /srv | Mar 26 |
| 206145 | 1b483c4a | /root | Mar 27 |
| 574977 | c3c486aa | /srv/marktext-browser | Mar 30 |
| 588136 | ccd91c1e | /srv/svg-terminal | Mar 29 |
| 1552744 | 72fd1d06 | /srv/svg-terminal | Mar 30 |
| 1650780 | c9510550 | /root | Mar 29 |
| 2547698 | 0317c840 | /root | Mar 28 |
| 2572343 | 7099d5d9 | /srv/svg-terminal | Mar 30 |
| 2632687 | 12e85690 | /srv/svg-terminal | Mar 30 |
| 2876404 | e3af93f5 | /root | Mar 28 |
| 3352832 | 6a76ff6f | /root | Mar 31 |
| 3386235 | 6a76ff6f | /root | Mar 31 |

Note: PIDs 903+206145 share session `1b483c4a`. PIDs 3352832+3386235 share session `6a76ff6f`.

### Implications for Brain Surgery

Any tool that modifies session files must be aware of all three locations:

1. **Session index** — if you create a fork with a new UUID, you may need to create an index entry for `--resume` to find it
2. **JSONL + companion directory** — the main conversation plus subagents and tool-results must be consistent
3. **File history** — less critical for surgery, but if restoring to a checkpoint, file-history entries may reference files that no longer exist in the expected state

The main JSONL is NEVER modified in place — only appended. Every user message, assistant response, system event, tool call, and metadata entry is one JSON line appended to the end. The companion files are written independently by subagents and the tool execution system.

### The parentUuid Tree

Every entry has a `parentUuid` field pointing to the entry that precedes it. This forms a **tree**, not a flat list. Most of the time it looks linear, but branches occur naturally and through deliberate forks.

**The basic chain:**
```
entry-1 (parentUuid: null)  ← root node (first message in session)
    ↓
entry-2 (parentUuid: entry-1.uuid)
    ↓
entry-3 (parentUuid: entry-2.uuid)
    ↓
    ...
```

**How branches happen:**

Branches occur when two entries claim the same parent. In our session (`6a76ff6f`), there are **15 branch points** and **16 leaf nodes** across 880 entries.

Most branches are **streaming artifacts** — the assistant's response is split across multiple entries, and the user's next message arrives between parts, creating a fork:

```
[assistant part 1]  uuid=AAA
    ├── [assistant part 2]  parent=AAA  ← assistant continues
    └── [user message]      parent=AAA  ← user typed while assistant was streaming
```

These are harmless micro-branches, typically 1-2 entries deep.

**Deliberate forks** (from concurrent `--resume`) create deeper branches:

```
[system entry]  uuid=5ed38ceb  ← last shared node
    ├── Instance A: [user] parent=5ed38ceb → [assistant] → [user] → ... (continues for 30+ entries)
    └── Instance B: [user] parent=b63ed6ff → [assistant] → [user] → ... (short branch)
```

**Compaction** creates a second root by setting `parentUuid: null` on the `compact_boundary` record:

```
ROOT 1 (parentUuid: null, line 1)  ← original first message
│
├── ... hundreds of pre-compaction entries ...
│
ROOT 2 (parentUuid: null, compact_boundary)  ← compaction resets the chain
│
└── [isCompactSummary] → [post-compaction conversation continues]
```

The loader sees `parentUuid: null` on the compact_boundary and treats it as the new starting point, ignoring everything before it.

### How to Follow Branches

**To reconstruct any single conversation path:**

1. Find a **leaf node** (an entry that no other entry claims as parent)
2. Walk backwards via `parentUuid` from the leaf to the root
3. The resulting chain is one complete, coherent conversation

**To find all branches in a file:**

1. Build a `parent → [children]` map
2. Any parent with 2+ children is a branch point
3. From each branch point, follow each child to its leaf — each path is a branch

**To identify the "main" conversation:**

The main conversation is the longest chain from root to leaf. Short branches off the trunk are streaming artifacts. Deep branches (10+ entries) are deliberate forks or concurrent resumes.

**To identify compaction boundaries:**

Search for entries with `parentUuid: null` AND `type: "system"` AND `subtype: "compact_boundary"`. Everything before the boundary is pre-compaction history. Everything after (following the new chain from the boundary's child) is the active conversation.

When Claude Code loads a session (for display or resume), it follows the parentUuid chain from the most recent leaf backwards. If it hits a `compact_boundary` (parentUuid: null), it starts from the compact summary instead of the original root. This is NOT just chronological — the chain determines which entries belong to which conversation branch.

### Session Directory Structure

Each session can also have a companion directory:
```
~/.claude/projects/{encoded-cwd}/{session-id}/
├── subagents/
│   ├── agent-{id}.jsonl       ← subagent conversation
│   └── agent-{id}.meta.json   ← subagent metadata
└── tool-results/
    └── {id}.txt               ← large tool outputs stored out-of-band
```

### Record Types

| Type | Purpose | Key Fields |
|------|---------|------------|
| `user` | User messages, tool results, compact summaries | `parentUuid`, `message`, `permissionMode` |
| `assistant` | Claude responses | `parentUuid`, `message` (includes `model`, `content[]`, `usage`) |
| `system:compact_boundary` | Marks compaction point | `parentUuid: null`, `logicalParentUuid`, `compactMetadata` |
| `system:turn_duration` | Turn timing metadata | `durationMs`, `messageCount` |
| `system:stop_hook_summary` | Hook execution results | `hookCount`, `hookInfos`, `hookErrors` |
| `system:local_command` | Slash command events | `content`, `level` |
| `progress` | Tool progress events | `data`, `parentToolUseID` |
| `file-history-snapshot` | Pre-edit file backups (Esc+Esc rewind) | `snapshot.trackedFileBackups` |
| `queue-operation` | Message queue ops | `operation`, `content` |
| `last-prompt` | Records last user prompt | `lastPrompt` |

---

## Part 1B — Settings Hierarchy: User vs Project .claude

### The 5-Level Scope System

When Claude Code starts, settings are loaded from multiple sources. More specific scopes override broader ones:

```
1. Managed (highest)     → /etc/claude-code/ or IT-deployed plist/registry
2. Command line args     → --model, --permission-mode, etc.
3. Local                 → {project}/.claude/settings.local.json (gitignored)
4. Project               → {project}/.claude/settings.json (committed)
5. User (lowest)         → ~/.claude/settings.json
```

**Scalar settings:** More specific scope wins entirely.
**Array settings:** For `permissions.allow`, `permissions.deny`, sandbox paths, `claudeMdExcludes`, and `allowedHttpHookUrls` — arrays MERGE (concatenate) across scopes, not replace.

### CLAUDE.md Loading Order

1. Managed policy: `/etc/claude-code/CLAUDE.md` (Linux/WSL)
2. User level: `~/.claude/CLAUDE.md`
3. Walk up directory tree from CWD: `./CLAUDE.md`, `../CLAUDE.md`, `../../CLAUDE.md`, etc.
4. Project level: `./.claude/CLAUDE.md`
5. Subdirectory CLAUDE.md files load on-demand when Claude reads files in those directories

User-level rules load first (lower priority). Project rules load after (higher priority). A project `.claude/` directory does NOT create an independent environment — it inherits from user-level with project taking precedence.

### What This Means for the Inspector

When you `cd /srv/PHAT-TOAD-with-Trails/inspector && claude`:
- `~/.claude/settings.json` loads first (cleanupPeriodDays, hooks, permissions)
- `/srv/PHAT-TOAD-with-Trails/inspector/.claude/settings.json` loads second and overrides/merges
- `/srv/PHAT-TOAD-with-Trails/inspector/CLAUDE.md` loads as project instructions
- `~/.claude/CLAUDE.md` loads as user instructions (lower priority)
- Skills from both `~/.claude/skills/` AND `.claude/skills/` are available

### The Two .claude Directories Are Unrelated Systems

| Path | Purpose | Created by |
|------|---------|-----------|
| `~/.claude/projects/{encoded-cwd}/` | Session storage (JSONL files) | Claude Code automatically |
| `{project}/.claude/` | Project configuration (settings, agents, rules) | User/team manually |

These have NO relationship. The `encoded-cwd` path is how sessions are namespaced by working directory. The project `.claude/` is how project-specific configuration is stored. They happen to both start with `.claude` but are completely separate systems.

### The Encoded-CWD Mapping

Rule: every `/` in the absolute path becomes `-`. Not documented officially.

| Working directory | Session storage path |
|---|---|
| `/root` | `~/.claude/projects/-root/` |
| `/srv/svg-terminal` | `~/.claude/projects/-srv-svg-terminal/` |
| `/home/greg/projects/foo` | `~/.claude/projects/-home-greg-projects-foo/` |
| `/srv/PHAT-TOAD-with-Trails/inspector` | `~/.claude/projects/-srv-PHAT-TOAD-with-Trails-inspector/` |

**Collision risk:** `/srv/foo` and `/srv-foo` would both encode to `-srv-foo`. Unlikely in practice.

### Critical: CWD at Launch ≠ Project Being Worked On

The encoded CWD is determined by where `claude` was LAUNCHED from, not where the agent does its work. On this machine, most sessions are launched from `/root` via claude-proxy's tmux launcher, even though they work on projects in `/srv/`:

| Session | Launched from | Stored in | Actually works on |
|---------|--------------|-----------|-------------------|
| `e3af93f5` (svg-terminal agent 3) | `/root` | `-root/` | `/srv/svg-terminal/` |
| `0317c840` (svg-terminal agent 2) | `/root` | `-root/` | `/srv/svg-terminal/` |
| `35f38ccc` (claude-proxy agent) | `/root` | `-root/` | `/srv/claude-proxy/` |
| `6a76ff6f` (this steward session) | `/root` | `-root/` | `/srv/PHAT-TOAD-with-Trails/` |
| `72fd1d06` (svg-terminal agent 4) | `/srv/svg-terminal` | `-srv-svg-terminal/` | `/srv/svg-terminal/` |
| `c3c486aa` (marktext agent) | `/srv/marktext-browser` | `-srv-marktext-browser/` | `/srv/marktext-browser/` |

**To resume `e3af93f5`, you must `cd /root` first**, even though all its work is in `/srv/svg-terminal/`. The project-level `.claude/settings.json` and `CLAUDE.md` at `/srv/svg-terminal/` load based on where the agent reads files (Claude Code walks up from file paths), NOT based on where the JSONL is stored.

**This creates a problem for fork-to-new-project:** If you want to take a trusted agent (e.g., this steward session stored in `-root/`) and fork it to work on a new project at `/srv/new-project/`, the fork would also end up in `-root/` — because `--fork-session` preserves the CWD context. The forked session would then load `/root/CLAUDE.md` instead of `/srv/new-project/CLAUDE.md`.

See Part 12 for the process to relocate a forked session to a new project directory.

---

## Part 1C — The Session File Tree: How Files Link Together

### The Complete Tree

```
~/.claude/projects/{encoded-cwd}/
├── {session-id}.jsonl                              ← main conversation
├── {session-id}/
│   ├── subagents/
│   │   ├── agent-{agent-id}.jsonl                  ← subagent's full conversation
│   │   ├── agent-{agent-id}.meta.json              ← links agent to parent tool_use
│   │   └── agent-{agent-id}/
│   │       └── subagents/                          ← nested subagents (recursive)
│   └── tool-results/
│       └── {tool-use-id}.txt                       ← large outputs stored out-of-band
├── {other-session-id}.jsonl                        ← different session
└── ...
```

### How Subagents Link to the Parent

When the parent dispatches an Agent tool:

1. **In the parent JSONL:** An `assistant` entry contains a `tool_use` content block with `name: "Agent"` and a unique tool_use ID
2. **On disk:** `agent-{agent-id}.meta.json` records the mapping between the agent ID and the parent's tool_use ID
3. **Subagent runs:** Its conversation is written to `agent-{agent-id}.jsonl` — completely independent of the parent JSONL
4. **When done:** The subagent returns a summary. The parent JSONL records a `tool_result` with the summary text
5. **The parent never sees the subagent's full conversation** — only the returned summary

### What This Means for Backup/Restore

| What you backup | What works on resume | What's lost |
|---|---|---|
| Main JSONL only | Main conversation intact, summaries visible | Subagent full conversations, large tool outputs |
| Main JSONL + tool-results/ | Main conversation + large outputs | Subagent full conversations |
| Main JSONL + full directory tree | Everything | Nothing |

**For full fidelity: always copy the `{session-id}/` directory alongside the `{session-id}.jsonl`.**

### file-history-snapshot Records

These are NOT session persistence — they're the Esc+Esc file rewind feature. Each `file-history-snapshot` entry records the state of edited files BEFORE the edit:

```json
{
  "type": "file-history-snapshot",
  "messageId": "8be1ef10-...",
  "snapshot": {
    "trackedFileBackups": {
      "/srv/svg-terminal/dashboard.mjs": "...file content before edit..."
    }
  }
}
```

These can be large (full file contents embedded). The `~/.claude/file-history/` directory stores overflow backups. One user reported 300GB accumulated in this directory. There is no automatic cleanup.

---

## Part 2 — How Forking Works

### Two Different Mechanisms — Don't Confuse Them

| Mechanism | What happens | File result | Supported? |
|---|---|---|---|
| `--fork-session` | Creates NEW JSONL with NEW session ID, copies history | Two independent files | Yes — official |
| Concurrent `--resume` | Both instances write to SAME JSONL, diverging parentUuid chains | One file, two branches | Works but not recommended |

**`--fork-session` = file-level copy.** The new session is completely independent. Changes to one never affect the other.

**Concurrent resume = tree within one file.** Both instances share the same JSONL. Entries are interleaved chronologically but separated by parentUuid chains. Each instance only sees its own chain in context.

### Can You Fork from Inside a Running Session?

**No built-in way.** There is no `/fork` or `/checkpoint` slash command. `--fork-session` is a CLI flag that only works at launch time:

```bash
claude --continue --fork-session     # fork most recent session
claude --resume {id} --fork-session  # fork a specific session
```

**Synthetic checkpoint from inside a session:** The running agent can create a backup using its Bash tool:

```bash
# Agent runs this to create a checkpoint
SESSION_ID="6a76ff6f-ca1e-4be9-b596-b2c0ae588d91"
ENCODED_CWD="-root"
SRC="$HOME/.claude/projects/$ENCODED_CWD"
DEST="/srv/checkpoints/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
cp "$SRC/$SESSION_ID.jsonl" "$DEST/"
cp -r "$SRC/$SESSION_ID/" "$DEST/" 2>/dev/null
echo "Checkpoint saved to $DEST"
```

This creates a backup of the current state. To restore it later, copy back and resume. However, this is NOT a true fork — it's a snapshot. The session ID is the same, so restoring it would overwrite the live session.

**True in-session fork would require:** Copy the JSONL to a new filename with a new UUID, update all internal `sessionId` fields. No tool currently does this. It's the top item on the research agenda.

### Discovery: Live Fork Experiment (2026-03-31)

### Discovery: Live Experiment (2026-03-31)

We ran `claude --resume 6a76ff6f` in a second terminal while the original session was still running. Both instances wrote to the same JSONL file.

**File:** `/root/.claude/projects/-root/6a76ff6f-ca1e-4be9-b596-b2c0ae588d91.jsonl`

### The Fork in the parentUuid Chain

Before the fork, both instances share one linear chain. After the fork, two branches diverge:

```
                    [shared history]
                         |
                    [5ed38ceb]  ← last shared node (system entry, 16:11:59 UTC)
                    /          \
                   /            \
    Instance A chain        Instance B chain
           |                       |
    [afda1b81]              [32e01ee1]
    parent=5ed38ceb         parent=b63ed6ff  ← different parent!
    "what was the           "what time is it
     last question?"         in london?"
           |                       |
    [58571a8b]              [e64ea87a]
         ...                     ...
```

**Key finding:** Instance B's first entry does NOT parent from Instance A's last entry. It parents from an earlier point in the shared history (`b63ed6ff`). This means the resume operation reconstructed context up to a certain point and forked from THERE — not necessarily from the most recent message.

### What Each Instance Sees

Each instance loads only its own parent chain into context. Instance A has no memory of Instance B's messages and vice versa. They are effectively two agents who share a childhood but diverge.

**A third instance resuming later would need to pick one branch.** The selection logic appears to follow the most recent leaf node's parent chain, but this is unconfirmed when multiple branches have recent activity.

### Official Documentation Confirms

From `code.claude.com`:

> "Same session in multiple terminals: If you resume the same session in multiple terminals, both terminals write to the same session file. Messages from both get interleaved, like two people writing in the same notebook. Nothing corrupts, but the conversation becomes jumbled."

The recommendation is `--fork-session` for parallel work.

---

## Part 3 — How Compaction Works

### What Triggers Compaction

- **Manual:** User runs `/compact` slash command
- **Automatic:** Context approaches the model's limit (observed at 632,933 tokens in one session)

### What Happens During Compaction

Three records are appended to the JSONL:

**Record 1 — `compact_boundary`:**
```json
{
  "parentUuid": null,
  "logicalParentUuid": "09d777b3-...",
  "type": "system",
  "subtype": "compact_boundary",
  "compactMetadata": {
    "trigger": "manual",
    "preTokens": 632933,
    "preCompactDiscoveredTools": ["TaskCreate", "TaskList", "TaskUpdate"]
  }
}
```

- `parentUuid: null` — resets the chain. The loader treats this as a new starting point.
- `logicalParentUuid` — points to the last real message before compaction (for tooling that needs the full history)
- `preTokens` — how many tokens existed before compaction

**Record 2 — Compact summary (user message with `isCompactSummary: true`):**
```json
{
  "parentUuid": "<compact_boundary uuid>",
  "isCompactSummary": true,
  "isVisibleInTranscriptOnly": true,
  "type": "user",
  "message": {
    "role": "user",
    "content": "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion...\n\nSummary:\n1. Primary Request and Intent:..."
  }
}
```

This is an LLM-generated summary of everything before the boundary. It becomes the opening context for the post-compaction conversation.

**Record 3 — First post-compaction assistant response:**
Normal assistant entry parenting from the summary record.

### What Survives Compaction

| Preserved | Lost |
|-----------|------|
| Key decisions and architectural choices | Exact code snippets from early conversation |
| File paths and project structure | Specific line numbers referenced early |
| What was done (high-level) | Early instructions not in CLAUDE.md |
| Current working direction | Nuanced investigation chains |
| Tool names that were used | Exact error messages from early debugging |
| | Skill descriptions (only invoked skills survive) |
| | Emotional/tonal context of early exchanges |
| | Correction patterns ("Greg pushed back on X") |

### Critical: Pre-Compaction Records Stay in the File

The JSONL is append-only. All pre-compaction records are physically present. They can be read by external tools. But the Claude Code loader skips them — it sees `parentUuid: null` on the `compact_boundary` and starts fresh from the summary.

**There is no "un-compact" operation.** Once compacted, the model cannot see the original messages — only the summary.

---

## Part 4 — Supported Preservation Techniques

### 4.1 — `--fork-session` (Supported)

```bash
claude --continue --fork-session
```

Creates a new session ID with a copy of the conversation history up to that point. The original session continues independently.

**Use case:** Create a checkpoint before the session grows too large or before compaction. The fork preserves full uncompressed context.

**Limitation:** Creates a new session file. The forked session has a different ID. You need to track which fork represents which checkpoint.

### 4.2 — `/compact` with Manual Timing (Supported)

```bash
# Inside a session:
/compact
```

Triggers compaction at a moment you choose, rather than waiting for automatic compaction. You control when the summary is generated — ideally after a natural milestone when the summary will capture the important state.

**Use case:** Controlled context management. Better summaries than automatic compaction because the conversation is at a natural breakpoint.

### 4.3 — `--resume` (Supported)

```bash
claude --resume {session-id}
```

Loads a session from its JSONL file. If the session has been compacted, loads from the compact summary forward. If not compacted, loads the full history.

**Use case:** Continue a previous session. Works across terminal restarts, reboots, etc.

**Limitation:** Session must be in `~/.claude/projects/{encoded-cwd}/`. The `{encoded-cwd}` must match the directory the session was started from.

### 4.4 — `--continue` (Supported)

```bash
claude --continue
```

Resumes the most recent session in the current working directory.

---

## Part 5 — Unsupported But Working Techniques

### 5.1 — Manual JSONL Backup and Restore

```bash
# Backup
cp ~/.claude/projects/-root/{session-id}.jsonl /safe/location/
cp -r ~/.claude/projects/-root/{session-id}/ /safe/location/

# Restore
cp /safe/location/{session-id}.jsonl ~/.claude/projects/-root/
cp -r /safe/location/{session-id}/ ~/.claude/projects/-root/
claude --resume {session-id}
```

**Works because:** The JSONL is self-contained. The session ID in the filename matches the session ID inside the records. Claude Code finds it by scanning the directory for matching files.

**Risks:**
- If the original is still in place, you overwrite the live file
- If the session was started from a different CWD, you need to put it in the right `{encoded-cwd}` directory
- Subagent and tool-result files must be copied too for full fidelity

**Use case:** Preserve a session at a specific point in time. Restore to that point later. This is how we preserved session `6a76ff6f` and the terminated PHAT TOAD sessions.

### 5.2 — JSONL Truncation for Point-in-Time Snapshots

```bash
# Count lines up to the desired checkpoint
head -n {N} session.jsonl > session-checkpoint.jsonl
```

**Theory:** Since the JSONL is append-only and each record is self-contained, truncating at a specific line should produce a valid session file representing the conversation up to that point. The parentUuid chain from the last entry would be intact.

**Risks:**
- Untested officially
- Could truncate mid-record if line count is wrong
- Might confuse Claude Code if it expects certain trailing records (turn_duration, etc.)
- Need to verify the last entry is a complete conversation turn

**Use case:** Create a snapshot at a specific turn without forking. More precise than `--fork-session` because you choose the exact line.

### 5.3 — Branch Extraction from Forked JSONL

When two instances write to the same file (as in our experiment), the file contains two interleaved branches. You can extract a single branch by following one parentUuid chain:

```python
# Walk one branch
def extract_branch(jsonl_path, leaf_uuid):
    entries = {}
    for line in open(jsonl_path):
        obj = json.loads(line)
        entries[obj['uuid']] = obj

    chain = []
    current = leaf_uuid
    while current and current in entries:
        chain.append(entries[current])
        current = entries[current].get('parentUuid')

    return list(reversed(chain))
```

**Works because:** The parentUuid chain is a proper linked list. Following it from any leaf gives you exactly one coherent conversation.

**Use case:** After accidentally running two instances on the same session, extract each branch as a clean standalone transcript.

### 5.4 — Concurrent Resume for Parallel Work

Running `claude --resume {same-id}` in multiple terminals. Both write to the same file. Each sees only its own branch.

**Works but not recommended.** The official docs say to use `--fork-session` instead. The interleaved JSONL makes future resumes unpredictable (which branch does it follow?).

---

## Part 6 — Preservation Strategy

### For Long-Running Sessions (like this one)

**Recommended cadence:**

1. **Fork at natural milestones:**
   ```bash
   claude --continue --fork-session
   ```
   Do this after completing a major piece of work, before starting something new. Each fork is a frozen checkpoint with full uncompressed context.

2. **Backup the JSONL periodically:**
   ```bash
   cp ~/.claude/projects/-root/6a76ff6f-ca1e-4be9-b596-b2c0ae588d91.jsonl \
      /srv/PHAT-TOAD-with-Trails/sessions/preserved-sessions/
   ```
   This preserves the current state including any forks or compaction. Cheaper than forking because it doesn't create a new session.

3. **Before manual compaction:** Always backup first. Compaction is irreversible from the model's perspective.

4. **Track checkpoints in a manifest:**
   ```markdown
   | Checkpoint | Type | Session ID | Date | Context State |
   |------------|------|-----------|------|---------------|
   | initial | backup | 6a76ff6f | 2026-03-28 | uncompressed, 1.5MB |
   | post-steward | backup | 6a76ff6f | 2026-03-31 10:58 | uncompressed, 2.3MB |
   | pre-compact | fork | {new-id} | TBD | uncompressed, full |
   | post-compact | backup | 6a76ff6f | TBD | compacted |
   ```

### For Session Character Preservation

The "character" of a session is the full uncompressed context — the corrections, the tone, the patterns of interaction. Once compacted, the summary preserves WHAT was learned but not the EXPERIENCE of learning it.

**To preserve character maximally:**
1. Fork before compaction — this freezes the full uncompressed state
2. The fork can be resumed at any time to get the original character back
3. The original session continues with compacted context — good enough for ongoing work but with reduced character fidelity

**The half-life of character** is tied to context window size, not calendar time. A session at 50% context capacity has full character. At 90%, early experiences are about to be compressed. At 100%, compaction fires and the early character is summarized away.

### For This Session Specifically

```
Session: 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91
Location: /root/.claude/projects/-root/
CWD at start: /root
Current size: ~2.4MB
Compacted: No
Character state: Full — all original exchanges intact

Backup (stale): /srv/PHAT-TOAD-with-Trails/sessions/preserved-sessions/6a76ff6f-*.jsonl
Backup date: 2026-03-31 10:58 UTC
```

**Immediate action items:**
- [ ] Fresh backup of current JSONL (post-fork-experiment, post-research)
- [ ] Fork session to create a frozen checkpoint with current full character
- [ ] Record fork session ID in resume-agent.md
- [ ] Set reminder to fork again before context reaches 80% capacity

---

## Part 7 — Community Tools and Prior Art

### Viewers / Browsers

| Tool | URL | What It Does | Stars |
|------|-----|-------------|-------|
| **tail-claude** | github.com/kylesnowschwartz/tail-claude | Go TUI — scrollable conversations, expandable tool calls, token counts, live tailing, session picker | 127 |
| **claude-code-trace** | github.com/delexw/claude-code-trace | Tauri desktop app + web + terminal — reads ~/.claude/, renders conversations, MCP tool detection | 47 |
| **claude-JSONL-browser** | github.com/withLinda/claude-JSONL-browser | Next.js web tool — converts JSONL to Markdown, search, export, live demo at jsonl.withlinda.dev | 29 |
| **clog** | github.com/HillviewCap/clog | Single-file web app — session grouping, token metrics, tool visualization, real-time monitoring | 20 |
| **cclv** | github.com/albertov/cclv | Lightweight TUI for viewing session logs | 4 |

### Search / Management

| Tool | URL | What It Does | Stars |
|------|-----|-------------|-------|
| **claude-historian-mcp** | github.com/Vvkmnn/claude-historian-mcp | MCP server — queries local JSONL history across 11 scopes, TF-IDF scoring, zero deps, offline | 218 |
| **claude-history** | github.com/raine/claude-history | Rust TUI — fuzzy search, resume/fork from UI, cross-project forking, worktree-aware, export | 127 |
| **cc-sessions-cli** | github.com/erans/cc-sessions-cli | Node CLI — list/sort/filter sessions, multiple output formats, tool usage tracking | 2 |

### File Recovery

| Tool | URL | What It Does | Stars |
|------|-----|-------------|-------|
| **claude-file-recovery** | github.com/hjtenklooster/claude-file-recovery | Python — reconstructs files from JSONL transcripts, point-in-time recovery, colored diffs | 99 |

### Pruning / Brain Surgery

| Tool | URL | What It Does | Stars |
|------|-----|-------------|-------|
| **clawdbot-session-pruner** | github.com/meridianix/clawdbot-session-pruner | Python — surgical truncation of tool results >5KB, keeps first+last 2.5KB, dry-run mode. Real-world: 2.3MB → 180KB (92% reduction) | 3 |

### Bug Fixes

| Tool | URL | What It Does | Stars |
|------|-----|-------------|-------|
| **claude-code-thinking-blocks-fix** | github.com/miteshashar/claude-code-thinking-blocks-fix | Fixes API errors from streaming corruption in JSONL | 9 |

### What Doesn't Exist Yet

No tool currently handles:
- **Full brain surgery** — arbitrary entry removal with parentUuid chain repair
- **In-session forking** — creating a checkpoint from inside a running session with a new session ID
- **Branch extraction** — splitting a multi-branch JSONL (from concurrent resume) into separate clean files
- **Session merging** — combining two sessions into one (e.g., for inspector analysis)
- **Automated preservation** — periodic fork/backup with manifest tracking

The brain surgery code in Part 9 of this journal is **speculative** — written from understanding of the JSONL format but not tested against Claude Code's loader. The parentUuid chain walking is based on empirical observation from our fork experiment. The `clawdbot-session-pruner` is the closest existing tool (truncates tool outputs) but doesn't do arbitrary entry removal.

---

## Part 8 — Research Agenda

### Confirmed Understanding — No Further Research Needed

- [x] JSONL is append-only, never modified in place
- [x] parentUuid chain determines conversation reconstruction
- [x] Compaction appends boundary + summary, doesn't delete
- [x] --fork-session creates independent snapshot
- [x] Multiple --resume instances write to same file, different branches
- [x] Each instance sees only its own parentUuid chain

### Needs Empirical Testing (High Priority)

0. **In-session forking.** Can a running agent fork itself by copying its own JSONL + generating a new session UUID? What fields need to be updated in the copy? Does Claude Code's session index need to be refreshed? This is the most valuable missing capability.

### Needs Empirical Testing

1. **JSONL truncation for snapshots.** Does `head -n N session.jsonl` produce a valid resumable session? What if the last line is a system record instead of an assistant record? Does Claude Code handle partial turns gracefully?

2. **Branch selection on resume after fork.** When a JSONL has two branches (from concurrent resume), which branch does a new `--resume` follow? The most recent entry? The longest chain? Is it deterministic?

3. **Fork timing relative to compaction.** If you fork DURING compaction (after boundary is written but before summary), what state does the fork capture? Is the fork atomic?

4. **Context capacity monitoring.** Is there a way to query current token count from within a session? The `compactMetadata.preTokens` field suggests Claude Code tracks this. Can we access it before compaction triggers?

5. **Multiple forks from same point.** Can you fork the same session 10 times to create 10 independent branches? Are there limits?

6. **Fork from a backup.** If you restore a backup JSONL and then fork, does the fork work correctly? Does it get a new session ID even though the JSONL was copied?

7. **Subagent and tool-result preservation.** When forking, are subagent JONLs and tool-result files also forked? Or does only the main JSONL get copied?

### Needs Source Code Analysis

8. **The resume branch selection algorithm.** When loading a JSONL with multiple branches, how does Claude Code choose which leaf to follow? Is it the entry with the latest timestamp? The entry with the most descendants?

9. **The context reconstruction pipeline.** When --resume loads a session, does it: (a) read all lines, build a tree, walk one branch? or (b) read lines sequentially and follow parentUuid pointers? The performance implications are different for large files.

10. **The compact summary generation prompt.** What prompt does Claude Code use to generate the compact summary? Understanding this would help predict what survives compaction and how to structure conversations for better summaries.

### Needs Community/Anthropic Input

11. **Official support for session checkpointing.** GitHub issue #25695 requests a `/checkpoint` command. Has there been any Anthropic response? Is this on a roadmap?

12. **Session export format.** Is there an official or community-standard format for exporting a session as a portable artifact? The JSONL + subagents + tool-results structure is implicit — there's no manifest saying "these files belong together."

13. **Session size limits.** Is there a maximum JSONL file size? What happens when a session grows to 100MB+ (heavy tool use, many subagents)?

14. **The `isSidechain` field.** What creates sidechain records? Our experiment showed `isSidechain: false` on all entries including the forked branch. When is it `true`?

---

## Part 8 — Session Cleanup and Retention

### The 30-Day Kill

**Claude Code automatically deletes session files older than 30 days.** This is the default and it runs on session startup — meaning opening a new Claude Code session triggers cleanup of old ones.

From Simon Willison's research:
> "Claude Code has a nasty default behavior of deleting these after 30 days."

**How to prevent it:** Add to `~/.claude/settings.json`:
```json
{
  "cleanupPeriodDays": 99999
}
```

**CRITICAL BUG:** Do NOT set `cleanupPeriodDays: 0`. Per GitHub issue #23710:
> "Setting `cleanupPeriodDays: 0` completely prevents session transcripts from being written to disk, causing silent data loss."

The schema says 0 means "disable cleanup" but the code treats it as "disable persistence entirely." Use a very large number instead.

### What Grows Without Bounds

| Directory | What's in it | Cleanup | Risk |
|-----------|-------------|---------|------|
| `~/.claude/projects/` | Session JSONL files | 30-day default | Sessions lost |
| `~/.claude/projects/*/subagents/` | Subagent JONLs + meta | Unknown — likely tied to parent session | Orphaned after parent deleted |
| `~/.claude/projects/*/tool-results/` | Large tool outputs | Unknown | Disk bloat |
| `~/.claude/debug/` | Debug/trace logs | None | One user hit 734MB |
| `~/.claude/file-history/` | Pre-edit file backups | None | One user hit 300GB |
| `~/.claude-worktrees/` | Git worktrees from parallel tasks | None — no cleanup on crash | Orphaned worktrees accumulate |

### The Disk-Full Catastrophe

From GitHub issue #24207:
> "When disk fills completely... write to `.claude.json` fails → zero-length file created → invalid JSON read → config treated as corrupted → default config overwrites all settings → OAuth/API tokens wiped → re-authentication required. No warning. No graceful degradation. No recovery path."

### Immediate Actions for This Session

```bash
# 1. Prevent automatic cleanup
# Add to ~/.claude/settings.json:
# "cleanupPeriodDays": 99999

# 2. Check current disk usage
du -sh ~/.claude/projects/ ~/.claude/debug/ ~/.claude/file-history/ 2>/dev/null

# 3. Monitor periodically
watch -n 3600 'du -sh ~/.claude/'
```

---

## Part 9 — Brain Surgery: Editing Session Context

### Can You Remove Entries from a JSONL?

**Yes — but it's unsupported and requires understanding the parentUuid chain.**

The JSONL is a text file. You can edit it. But removing entries breaks the parent chain unless you repair the links.

### Technique: Removing the Last N Minutes

To remove the last 20 minutes of dialogue from a session:

**Step 1 — Find the cut point:**
```python
import json
from datetime import datetime, timedelta

cutoff = "2026-03-31T16:00:00Z"  # everything after this gets removed

with open('session.jsonl') as f:
    lines = f.readlines()

keep = []
remove = []
for line in lines:
    obj = json.loads(line)
    ts = obj.get('timestamp', '')
    if ts and ts > cutoff:
        remove.append(obj)
    else:
        keep.append(line)
```

**Step 2 — Find the new leaf node:**

The last entry in `keep` must be a valid conversation endpoint. Ideally an `assistant` or `system` entry. If the last kept entry is a `user` message with no response, the session will look like it's waiting for a response.

**Step 3 — Write the truncated file:**
```python
with open('session-surgery.jsonl', 'w') as f:
    for line in keep:
        f.write(line)
```

**Step 4 — Verify the chain is intact:**
```python
# Check that every parentUuid in the kept entries points to another kept entry
kept_uuids = set()
for line in keep:
    obj = json.loads(line)
    if 'uuid' in obj:
        kept_uuids.add(obj['uuid'])

for line in keep:
    obj = json.loads(line)
    parent = obj.get('parentUuid')
    if parent and parent not in kept_uuids:
        print(f"BROKEN CHAIN: {obj['uuid']} points to removed parent {parent}")
```

**Step 5 — Replace and resume:**
```bash
cp session.jsonl session.jsonl.pre-surgery  # backup!
cp session-surgery.jsonl session.jsonl
claude --resume {session-id}
```

### Technique: Removing a Specific Branch

After a fork experiment (like ours), you might want to remove one branch:

```python
def entries_on_chain(entries_by_uuid, leaf_uuid):
    """Walk backwards from leaf, return all UUIDs on this chain."""
    chain = set()
    current = leaf_uuid
    while current and current in entries_by_uuid:
        chain.add(current)
        current = entries_by_uuid[current].get('parentUuid')
    return chain

# Keep only entries on the desired branch
desired_chain = entries_on_chain(entries_by_uuid, desired_leaf_uuid)
keep = [line for line, obj in zip(lines, objects)
        if obj.get('uuid') in desired_chain
        or obj.get('type') in ('file-history-snapshot', 'queue-operation', 'last-prompt')]
```

### Technique: Removing Tool Call Bloat

Sessions get large because of tool calls (especially `Bash` outputs and `Read` results). You can strip tool result content while preserving the chain:

```python
for line in lines:
    obj = json.loads(line)
    if obj.get('type') == 'user':
        msg = obj.get('message', {})
        if isinstance(msg, dict):
            content = msg.get('content', [])
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get('type') == 'tool_result':
                        # Replace content with a stub
                        block['content'] = '[tool output removed during surgery]'
    # Write modified entry
```

**Risk:** The agent loses the tool output context. It may re-run tools or make incorrect assumptions about results it can no longer see.

### Brain Surgery Risks

| Technique | Risk Level | What Can Go Wrong |
|-----------|-----------|-------------------|
| Truncate last N minutes | Low | Session ends at odd point, may need to trim to clean boundary |
| Remove one branch | Medium | Other entries (file-history-snapshot) might reference removed UUIDs |
| Strip tool outputs | High | Agent loses factual basis for decisions it already made |
| Edit message content | Very High | Agent's responses become inconsistent with the modified prompts |
| Remove entries mid-chain | Very High | Broken parentUuid chain, session won't load |

### The Safe Pattern

1. **Always backup before surgery:** `cp session.jsonl session.jsonl.pre-surgery`
2. **Fork first:** `claude --continue --fork-session` creates a clean snapshot before you touch anything
3. **Verify the chain** after any modification
4. **Test the resume** before deleting the backup

---

## Part 10 — Step-by-Step Guide: Preserving and Reusing a Trusted Agent

### Initial Setup (do this once)

**1. Prevent automatic cleanup:**
```bash
# Edit ~/.claude/settings.json — add:
# "cleanupPeriodDays": 99999
```

**2. Create a preservation directory:**
```bash
mkdir -p /srv/PHAT-TOAD-with-Trails/sessions/preserved-sessions
mkdir -p /srv/PHAT-TOAD-with-Trails/sessions/checkpoints
```

**3. Record the session in a manifest:**
Create `/srv/PHAT-TOAD-with-Trails/sessions/checkpoint-manifest.md`:
```markdown
| ID | Date | Type | Context State | Notes |
|----|------|------|---------------|-------|
| 6a76ff6f | 2026-03-28 | backup | uncompressed | initial session |
```

### At Natural Milestones (do this regularly)

**4. Fork to create a frozen checkpoint:**
```bash
claude --continue --fork-session
```
Record the NEW session ID in the manifest. This fork is a point-in-time snapshot with full uncompressed context.

**5. Backup the live session:**
```bash
SESSION=6a76ff6f-ca1e-4be9-b596-b2c0ae588d91
SRC=~/.claude/projects/-root
DEST=/srv/PHAT-TOAD-with-Trails/sessions/preserved-sessions

cp $SRC/$SESSION.jsonl $DEST/
cp -r $SRC/$SESSION/ $DEST/ 2>/dev/null
```

**6. Update the manifest** with date, size, and whether compaction has occurred.

### Before Compaction

**7. ALWAYS fork before compaction:**
```bash
# Fork first — this preserves full uncompressed context
claude --continue --fork-session
# Record the fork ID in the manifest
# NOW you can safely compact the original
/compact
```

The fork preserves the full character. The original continues with compacted context.

### To Restore a Trusted Agent

**8. From backup (same session, may have diverged):**
```bash
SESSION=6a76ff6f-ca1e-4be9-b596-b2c0ae588d91
SRC=/srv/PHAT-TOAD-with-Trails/sessions/preserved-sessions
DEST=~/.claude/projects/-root

# Backup current state first
cp $DEST/$SESSION.jsonl $DEST/$SESSION.jsonl.current

# Restore from checkpoint
cp $SRC/$SESSION.jsonl $DEST/
cp -r $SRC/$SESSION/ $DEST/ 2>/dev/null

# Resume
claude --resume $SESSION
```

**Warning:** This overwrites the current live JSONL. Back it up first.

**9. From a fork checkpoint (different session ID, clean snapshot):**
```bash
claude --resume {fork-session-id}
```

No file copying needed — the fork already has its own JSONL. Just resume it.

**10. From a surgically modified version:**
```bash
# After performing brain surgery on a copy:
cp session-surgery.jsonl ~/.claude/projects/-root/$SESSION.jsonl
claude --resume $SESSION
```

### Monitoring

**11. Check context health periodically:**
```bash
# File size as proxy for context size
ls -lh ~/.claude/projects/-root/6a76ff6f-*.jsonl

# Check for compaction markers
grep -c "compact_boundary" ~/.claude/projects/-root/6a76ff6f-*.jsonl

# Count conversation turns
grep -c '"type":"user"' ~/.claude/projects/-root/6a76ff6f-*.jsonl
```

**12. If compaction has fired unexpectedly:**
- Check the manifest for the most recent pre-compaction backup or fork
- The compacted session's JSONL still contains all pre-compaction records (they're just ignored by the loader)
- A fork from a backup will have the full uncompressed context

---

## Part 11 — Implications for PHAT TOAD

### Session persistence is context engineering

From the fork experiment and this research, the fundamental insight is: **an agent is a path through a tree of context, not a file.** The JSONL is the tree. The parentUuid chain is the path. The model weights are shared by all agents. The only unique thing about an agent is its specific path through its context tree.

This means PHAT TOAD's node-memory, PRD, and handoff artifacts are not just documentation — they are **context engineering.** They shape what future agents see when they start, which determines what those agents are capable of.

### Compaction is the enemy of character

The steward framework, the questionnaire responses, the correction patterns — these are the "character" of a session. Compaction summarizes them into flat facts. "Agent 3 said 'optimizing for clean rather than complete'" becomes a bullet point, not an experience.

For PHAT TOAD's node-0 and long-running steward sessions, **pre-compaction forks are essential.** They preserve the full reasoning chain that produced the framework decisions.

### The inspector needs branch-aware extraction

The inspector's extraction tools currently read JSONL chronologically. After learning about parentUuid chains and branches, the tools MUST be updated to follow chains, not timestamps. The `extract-dialogue.py` in `inspector/tools/` needs a branch-walking mode.

### Session preservation should be a PHAT TOAD node operation

The Work Surface Manager (Solution 01) should include session preservation as a node-level operation:
- Fork at milestone completion
- Backup before compaction
- Track checkpoint manifest per node
- Restore from checkpoint for regression testing or character recovery

---

## Sources

- [How Claude Code works — claude.com/docs](https://code.claude.com/docs/en/how-claude-code-works) — official session management docs
- [Claude Code Session Continuation — blog.fsck.com](https://blog.fsck.com/releases/2026/02/22/claude-code-session-continuation/) — third-party JSONL analysis
- [GitHub issue #14472](https://github.com/anthropics/claude-code/issues/14472) — resume when context exceeds limit
- [GitHub issue #15837](https://github.com/anthropics/claude-code/issues/15837) — resume doesn't preserve context
- [GitHub issue #25695](https://github.com/anthropics/claude-code/issues/25695) — auto-branch into new session request
- [GitHub issue #19199](https://github.com/anthropics/claude-code/issues/19199) — bash_progress events not compacted
- [GitHub issue #30395](https://github.com/anthropics/claude-code/issues/30395) — compact failed
- [claude-history tool](https://github.com/raine/claude-history) — session search/management
- [clog JSONL viewer](https://github.com/HillviewCap/clog) — JSONL browser
- [claude-JSONL-browser](https://github.com/withLinda/claude-JSONL-browser) — web-based viewer
- Live experiment: session `6a76ff6f-ca1e-4be9-b596-b2c0ae588d91`, 2026-03-31 (this session)
- Live JSONL inspection: session `00ff1988-2890-4b90-a0bd-6ab0b055fe88` (compaction example from svg-terminal agent 1)

---

## Part 12 — Forking a Trusted Agent to a New Project

### The Problem

You have a trusted agent — say this steward session (`6a76ff6f`), stored in `~/.claude/projects/-root/` because it was launched from `/root`. You want to fork it and deploy the fork to work on a new project at `/srv/new-project/`.

If you just run `cd /root && claude --resume 6a76ff6f --fork-session`, the fork:
- Gets a new session ID (good)
- Creates a new JSONL in `~/.claude/projects/-root/` (bad — you want it in `-srv-new-project/`)
- Loads `CLAUDE.md` from `/root` (bad — you want `/srv/new-project/CLAUDE.md`)
- Has no awareness of the new project's `.claude/settings.json`

### Process: Fork and Relocate

**Step 1 — Fork from the original CWD:**
```bash
cd /root
claude --resume 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 --fork-session
```

Note the new session ID from the output. Let's call it `{NEW_ID}`.

**Step 2 — Verify the fork was created:**
```bash
ls ~/.claude/projects/-root/{NEW_ID}.jsonl
```

**Step 3 — Create the target project directory:**
```bash
mkdir -p ~/.claude/projects/-srv-new-project/
```

**Step 4 — Move the fork to the new project directory:**
```bash
mv ~/.claude/projects/-root/{NEW_ID}.jsonl ~/.claude/projects/-srv-new-project/
mv ~/.claude/projects/-root/{NEW_ID}/ ~/.claude/projects/-srv-new-project/ 2>/dev/null
```

**Step 5 — Update the session index (if an entry exists):**
```bash
# Find the index entry by session ID
grep -l "{NEW_ID}" ~/.claude/sessions/*.json
# Edit it to update the cwd field to /srv/new-project
```

Or just delete the index entry — Claude Code will recreate it on resume:
```bash
# Find and remove the stale index entry
for f in ~/.claude/sessions/*.json; do
    if grep -q "{NEW_ID}" "$f"; then rm "$f"; fi
done
```

**Step 6 — Resume from the new project directory:**
```bash
cd /srv/new-project
claude --resume {NEW_ID}
```

Claude Code will:
1. Look in `~/.claude/projects/-srv-new-project/` (matching the CWD)
2. Find `{NEW_ID}.jsonl`
3. Load the forked conversation history
4. Load `/srv/new-project/CLAUDE.md` and `/srv/new-project/.claude/settings.json`
5. The agent has its old memories but operates in the new project context

### What the Fork Preserves

| Preserved | NOT preserved |
|-----------|---------------|
| Full conversation history (all context) | Session-scoped permissions (re-approve) |
| The agent's "character" and learned patterns | The old project's CLAUDE.md (new project's loads instead) |
| Knowledge of constraints, anti-patterns, decisions | The old project's .claude/settings.json |
| Tool results and subagent summaries in the chain | Subagent full conversations (if directory not moved) |

### What the New Project Should Have Ready

Before the forked agent arrives, prepare the target project:

```
/srv/new-project/
├── CLAUDE.md                  ← project instructions for the forked agent
├── .claude/
│   └── settings.json          ← project permissions and settings
├── PRD.md                     ← if applicable
├── node-memory/               ← constraints, anti-patterns, break-tests
└── ... (project files)
```

The forked agent will read the NEW project's CLAUDE.md and settings, but it retains all the conversational context from its previous life. This means it knows about PHAT TOAD's framework, the steward analysis patterns, the anti-patterns — AND it sees the new project's instructions.

### Script: Fork-and-Relocate

```bash
#!/bin/bash
# fork-agent-to-project.sh
# Usage: ./fork-agent-to-project.sh <source-session-id> <source-cwd> <target-project-path>

SOURCE_ID="$1"
SOURCE_CWD="$2"
TARGET_PATH="$3"

if [ -z "$SOURCE_ID" ] || [ -z "$SOURCE_CWD" ] || [ -z "$TARGET_PATH" ]; then
    echo "Usage: $0 <session-id> <source-cwd> <target-project-path>"
    echo "Example: $0 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 /root /srv/new-project"
    exit 1
fi

# Encode paths
SOURCE_ENCODED=$(echo "$SOURCE_CWD" | sed 's|/|-|g')
TARGET_ENCODED=$(echo "$TARGET_PATH" | sed 's|/|-|g')

SOURCE_DIR="$HOME/.claude/projects/$SOURCE_ENCODED"
TARGET_DIR="$HOME/.claude/projects/$TARGET_ENCODED"

# Verify source exists
if [ ! -f "$SOURCE_DIR/$SOURCE_ID.jsonl" ]; then
    echo "ERROR: Source session not found at $SOURCE_DIR/$SOURCE_ID.jsonl"
    exit 1
fi

# Fork from source CWD
echo "Step 1: Forking session $SOURCE_ID..."
cd "$SOURCE_CWD"
FORK_OUTPUT=$(claude --resume "$SOURCE_ID" --fork-session --print 2>&1 | head -5)
echo "$FORK_OUTPUT"

# Find the new session ID (most recently modified JSONL in source dir)
NEW_JSONL=$(ls -t "$SOURCE_DIR"/*.jsonl | head -1)
NEW_ID=$(basename "$NEW_JSONL" .jsonl)

if [ "$NEW_ID" = "$SOURCE_ID" ]; then
    echo "ERROR: Fork did not create a new session file"
    exit 1
fi

echo "Fork created: $NEW_ID"

# Create target directory
mkdir -p "$TARGET_DIR"

# Move fork to target
echo "Step 2: Moving to $TARGET_DIR..."
mv "$SOURCE_DIR/$NEW_ID.jsonl" "$TARGET_DIR/"
mv "$SOURCE_DIR/$NEW_ID/" "$TARGET_DIR/" 2>/dev/null

# Clean up session index
echo "Step 3: Cleaning session index..."
for f in "$HOME/.claude/sessions/"*.json; do
    if grep -q "$NEW_ID" "$f" 2>/dev/null; then
        rm "$f"
        echo "  Removed stale index entry: $(basename $f)"
    fi
done

# Verify
echo ""
echo "Done. To resume the forked agent in the new project:"
echo "  cd $TARGET_PATH"
echo "  claude --resume $NEW_ID"
echo ""
echo "The agent will load:"
echo "  JSONL:    $TARGET_DIR/$NEW_ID.jsonl"
echo "  CLAUDE.md: $TARGET_PATH/CLAUDE.md (if exists)"
echo "  Settings:  $TARGET_PATH/.claude/settings.json (if exists)"
```

Save as `/srv/PHAT-TOAD-with-Trails/inspector/tools/fork-agent-to-project.sh`.

### Use Cases

**1. Deploy the steward to a new project:**
```bash
./fork-agent-to-project.sh 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 /root /srv/new-project
```
The forked agent knows PHAT TOAD's framework but operates in the new project's context.

**2. Clone a trusted builder agent:**
```bash
./fork-agent-to-project.sh e3af93f5-13f3-470c-a5ba-94823a102b75 /root /srv/another-frontend
```
Agent 3's knowledge of camera-only architecture, frustum layout, and event routing — but working on a different frontend project.

**3. Create a checkpoint and move it to cold storage:**
```bash
./fork-agent-to-project.sh 6a76ff6f /root /srv/archive/steward-2026-03-31
```
A frozen snapshot of the steward that can be resumed from the archive directory at any time.

### Verified (2026-04-01) — Empirical Testing via tmux

These were tested live using tmux as a test harness (see `docs/research/2026-04-01-v0.1-testing-claude-via-tmux-journal.md`).

**CONFIRMED: The CWD field in JSONL records is the gate.**

| Test | What was done | Result |
|------|--------------|--------|
| Copy with new UUID filename | Copied JSONL to new project dir with random UUID as filename | Found but NO history loaded |
| Copy with matching UUID filename | Same but kept original UUID as filename | Found but NO history loaded |
| Copy with CWD rewrite (tiny session) | Rewrote `cwd` field in all records | Found but no history (session was empty) |
| **Copy with CWD rewrite (real 4MB session)** | Rewrote `cwd` field in all 1146 records | **Full success — 32% context, full memory, agent self-identified correctly** |

**Key findings:**
- Filename UUID does NOT need to match internal `sessionId` — Claude Code finds files by scanning the directory
- The `cwd` field inside EVERY record must match the current working directory — this is what the loader checks
- A session with rewritten CWD loads full conversation history, preserves agent character, and operates in the new project directory
- The fork script at `inspector/tools/fork-agent-to-project.sh` automates this process

**The verified fork-to-new-project process:**
1. Copy JSONL + companion directory to `~/.claude/projects/{target-encoded-cwd}/`
2. Rewrite `cwd` field in every JSONL record to match the target directory
3. `cd /target/project && claude --resume {session-id}`
4. Agent loads with full history, operating in the new project context

### Also Verified (2026-04-01) — New UUID Filename

| Test | Result |
|------|--------|
| Fork with new UUID filename (different from internal sessionId) | **Works.** Full context loaded at 34%. Agent has complete memory. |
| Two forks of same source in same directory (different UUIDs) | **Works.** Both coexist. Both load independently. No collision. |

Claude Code finds sessions by scanning the directory for `.jsonl` files, NOT by matching the filename against internal `sessionId` fields. This means:
- Each fork can have its own UUID (no overwrite risk)
- You can fork the same source 10 times — each gets a unique filename
- The internal `sessionId` is irrelevant for file discovery

**Fork A:** `a7da9a5d-8424-453b-84a5-05e2e36a0fa7.jsonl` — internal sessionId `6a76ff6f` — loaded full context
**Fork B:** `08d49f3d-dd06-4031-9813-5f8b8f0da792.jsonl` — internal sessionId `6a76ff6f` — loaded full context

### Still Unverified

- [ ] Does the official `--fork-session` flag also rewrite CWD, or does it keep the original? (If it keeps the original, that explains why it only works from the same CWD)
- [ ] After CWD rewrite, do subagent `meta.json` files need their CWD updated too?
- [ ] What happens when the forked agent's conversation history references files from the old project that don't exist in the new project? (Tested: the agent mentions old files but doesn't crash)
- [ ] Can this technique be used to merge two sessions by concatenating their JONLs? (Probably not — parentUuid chains would be disconnected)

---

## RESEARCH NEEDED: Next Experiments

### Priority 1 — Build the Tree Surgeon Tool

Now that we understand the full anatomy (session index, JSONL tree, parentUuid chains, CWD gating, UUID filename independence), we can build the tool. Plan:

**Core operations:**
1. `visualize` — render the parentUuid tree, show branch points, leaves, compaction boundaries
2. `extract-branch` — walk one parentUuid chain from leaf to root, output as standalone JSONL
3. `prune-time` — remove all entries after a timestamp, verify chain integrity
4. `prune-branch` — remove one branch from a multi-branch file, repair parent pointers on remaining
5. `fork-to-project` — copy + CWD rewrite + new UUID (DONE — `inspector/tools/fork-agent-to-project.sh`)
6. `strip-tool-bloat` — truncate large tool results (similar to `clawdbot-session-pruner`)

**Implementation language:** Python (agents can run it inline, no build step)

**Safety:** Every operation backs up first, verifies chain integrity after, dry-run mode default

### Priority 2 — In-Session Forking

Can a running agent fork ITSELF? The agent would:
1. Detect its own session ID (scan `~/.claude/sessions/` for matching PID)
2. Find its JSONL path (from the session index entry's CWD)
3. Copy + CWD rewrite + new UUID to target project
4. Report the fork ID so Greg can resume it later

This is the `/checkpoint` command that doesn't exist yet. We could build it as a skill.

### Priority 3 — Compaction Timing Control

Can we detect when compaction is about to trigger? The `compactMetadata.preTokens` field shows token count at compaction time. If we could query current token count BEFORE compaction fires, we could auto-fork at 80% context to preserve full character.

Test: read the JSONL size or entry count as a proxy for token count. Correlate with the context % shown in the TUI.

### Priority 4 — Session Merge

Can two independent sessions be merged into one? Use case: two agents worked on the same project in parallel, we want one agent that knows both histories. Would require:
- Concatenating both JONLs
- Connecting the second session's root to the first session's leaf via parentUuid rewrite
- Resolving conflicting sessionId fields

Likely fragile. Needs experimentation.

### Priority 5 — Cross-Machine Session Transfer

Can a session be moved between machines? The JSONL is self-contained except for:
- File paths in conversation history (references to `/srv/project/file.js`)
- Subagent/tool-result companion files
- Session index entries

If the target machine has the same project at the same path, a simple copy should work. If paths differ, the CWD rewrite technique applies. Needs testing.
