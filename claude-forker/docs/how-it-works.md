# How to Fork a Claude Code Session

**Verified:** 2026-04-01 — tested with real 4MB session, full context preserved
**Reference:** `docs/research/2026-03-31-v0.2-claude-resume-fork-mechanics-journal.md` for full details

---

## What You Need to Know

A Claude Code session is stored as:
```
~/.claude/projects/{encoded-cwd}/{session-id}.jsonl     ← conversation tree
~/.claude/projects/{encoded-cwd}/{session-id}/          ← subagents + tool-results
```

The `{encoded-cwd}` is the launch directory with `/` replaced by `-`:
- `/root` → `-root`
- `/srv/svg-terminal` → `-srv-svg-terminal`
- `/home/greg/projects/foo` → `-home-greg-projects-foo`

**Every record in the JSONL has a `cwd` field.** The loader checks this against the current working directory. If they don't match, the session is found but history is NOT loaded — the agent starts fresh with no memory.

---

## Method 1: Fork to Same Project (Official)

```bash
cd /original/project/dir
claude --resume {session-id} --fork-session
```

Creates a new session ID, new JSONL, same project directory. The original is unchanged.

**When to use:** Checkpointing. Preserving a trusted agent before risky work or compaction.

---

## Method 2: Fork to an Existing Project

The target project already exists with its own `CLAUDE.md`, `.claude/settings.json`, code, etc. You want a trusted agent's memory deployed there.

**Step 1 — Generate a new UUID and copy with CWD rewrite:**
```bash
SOURCE_ID="6a76ff6f-ca1e-4be9-b596-b2c0ae588d91"
SOURCE_CWD="/root"
TARGET_PATH="/srv/svg-terminal"
NEW_ID=$(python3 -c "import uuid; print(uuid.uuid4())")

SOURCE_ENCODED=$(echo "$SOURCE_CWD" | sed 's|/|-|g')
TARGET_ENCODED=$(echo "$TARGET_PATH" | sed 's|/|-|g')

mkdir -p ~/.claude/projects/$TARGET_ENCODED

python3 -c "
import json
with open('$HOME/.claude/projects/$SOURCE_ENCODED/$SOURCE_ID.jsonl') as f:
    lines = f.readlines()
with open('$HOME/.claude/projects/$TARGET_ENCODED/$NEW_ID.jsonl', 'w') as f:
    for line in lines:
        obj = json.loads(line)
        if obj.get('cwd') == '$SOURCE_CWD':
            obj['cwd'] = '$TARGET_PATH'
        f.write(json.dumps(obj) + '\n')
print(f'Wrote {len(lines)} records as $NEW_ID')
"

# Copy companion files if they exist
cp -r ~/.claude/projects/$SOURCE_ENCODED/$SOURCE_ID/ \
   ~/.claude/projects/$TARGET_ENCODED/$NEW_ID/ 2>/dev/null
```

**Step 2 — Resume from target:**
```bash
cd /srv/svg-terminal
claude --resume $NEW_ID
```

The agent loads with full memory AND reads the target project's `CLAUDE.md` and `.claude/settings.json`. It has old knowledge but new project instructions.

**Why a new UUID:** Each fork gets its own identity. You can fork the same source 10 times to the same directory — each fork is independent. No overwrite risk.

**When to use:** Deploying a steward or trusted agent to work on a different project.

---

## Method 3: Fork to a New Project

Same as Method 2, but create the project first:
```bash
mkdir -p /srv/new-project/.claude

cat > /srv/new-project/CLAUDE.md << 'EOF'
# New Project
You are starting a new project. Read your conversation history for context.
EOF
```

Then follow Method 2 steps. The agent arrives in an empty project with full memory of its past work.

**When to use:** Starting a new project with an experienced agent instead of a blank one.

---

## Method 4: Multiple Forks to Same Directory

Fork the same source repeatedly. Each gets a unique UUID — no collisions.

```bash
# Fork A
FORK_A=$(python3 -c "import uuid; print(uuid.uuid4())")
# ... copy + CWD rewrite to $FORK_A.jsonl ...

# Fork B (same source, different UUID)
FORK_B=$(python3 -c "import uuid; print(uuid.uuid4())")
# ... copy + CWD rewrite to $FORK_B.jsonl ...

# Both coexist:
ls ~/.claude/projects/-srv-target/
# a7da9a5d-8424-453b-84a5-05e2e36a0fa7.jsonl  ← Fork A
# 08d49f3d-dd06-4031-9813-5f8b8f0da792.jsonl  ← Fork B

# Resume whichever you want:
cd /srv/target
claude --resume $FORK_A   # or $FORK_B
```

**Verified 2026-04-01:** Two forks of the same 4MB session coexisted in `-srv-forking-test/` with different UUIDs. Both loaded full context at ~34%. Both had complete memory. The internal `sessionId` field does NOT need to match the filename — Claude Code finds sessions by scanning the directory for `.jsonl` files, not by matching internal IDs.

**When to use:** Deploying the same trusted agent to the same project at different points in time (weekly fresh forks), or A/B testing different approaches with the same base agent.

---

## Automated Script

```bash
/srv/PHAT-TOAD-with-Trails/inspector/tools/fork-agent-to-project.sh \
  {session-id} {source-cwd} {target-project-path}
```

Handles copy, CWD rewrite, companion files, and session index cleanup.

---

## How to Test That It Worked

Claude Code requires an interactive terminal. Use tmux as the test harness:

```bash
# Launch
tmux new-session -d -s test -x 120 -y 40 \
  "cd /target/project && claude --resume {session-id}"

# Wait for load (10-20s for large sessions)
sleep 15

# Check — look for context %, project dir, recent activity
tmux capture-pane -t test -p

# Optionally verify memory
tmux send-keys -t test "What do you know about this project? Short answer." Enter
sleep 15
tmux capture-pane -t test -p

# Clean up — always /exit before killing
tmux send-keys -t test "/exit" Enter
sleep 3
tmux kill-session -t test 2>/dev/null
```

### What success looks like:
```
Context ███░░░░░░░ 32%           ← history loaded
/srv/target-project              ← correct directory
Recent activity                  ← shows prior conversation
```

### What failure looks like:
```
Context ░░░░░░░░░░ 0%            ← no history
"I don't have any context"       ← agent starts fresh
```

Failure means the CWD rewrite didn't work or was incomplete. Check that EVERY record with a `cwd` field was rewritten.

---

## Anti-Patterns

### 1. Running fork and original simultaneously

Both copies share the same session ID. If both are running, they write to their respective JONLs independently — but if you later move one, the histories have diverged. Use one at a time.

### 2. Forgetting the companion directory

The `{session-id}/` directory contains subagent conversations and large tool outputs. Without it, the agent loses subagent resumability and some tool results show as empty. Always copy both the `.jsonl` AND the directory.

### 3. CWD rewrite missing records

Some record types (`file-history-snapshot`, `queue-operation`, `last-prompt`) may not have a `cwd` field. That's fine — the loader checks `user` and `assistant` records. But if ANY `user` or `assistant` record keeps the old CWD, the chain breaks at that point.

### 4. Forking a compacted session

If the source session has been compacted, the fork carries the compacted summary — not the original full history. Fork BEFORE compaction to preserve full context. Check for compaction:
```bash
grep "compact_boundary" ~/.claude/projects/{encoded-cwd}/{session-id}.jsonl
```
No output = not compacted. Output = compacted (you're getting the summary, not the original).

### 5. Assuming `--fork-session` works cross-directory

`claude --resume {id} --fork-session` only works from the SAME directory the session was created in. This is because the `--resume` lookup uses your current CWD to find the encoded project directory. From a different directory, it says "No conversation found."

### 6. Using `-p` (print mode) for testing

`claude -p --resume` with large sessions stalls indefinitely — it tries to load the full conversation before responding. Always use tmux for testing resume operations.

### 7. Setting `cleanupPeriodDays: 0`

This doesn't disable cleanup — it **disables ALL session persistence**. Sessions are never written to disk. Use `99999` instead:
```json
{ "cleanupPeriodDays": 99999 }
```

### 8. Not backing up before surgery

Any modification to a JSONL is effectively irreversible if something goes wrong. Always:
```bash
cp {session-id}.jsonl {session-id}.jsonl.backup
```

---

## Quick Reference

| I want to... | Method | Command |
|---|---|---|
| Checkpoint current session | Official fork | `claude --continue --fork-session` |
| Resume in same directory | Official resume | `claude --resume {id}` |
| Move agent to existing project | CWD rewrite | `fork-agent-to-project.sh {id} {old-cwd} {new-project}` |
| Move agent to new project | CWD rewrite + setup | Same script + create project dir with CLAUDE.md |
| Test if it worked | tmux harness | Launch in tmux, capture pane, check context % |
| Prevent auto-deletion | Settings | `cleanupPeriodDays: 99999` in settings.json |
| Check for compaction | Grep | `grep compact_boundary {session}.jsonl` |
| Back up a session | Copy | `cp {id}.jsonl + cp -r {id}/` to safe location |

---

## What the Forked Agent Sees

After fork-to-new-project, the agent:
- **HAS:** Full conversation history, learned patterns, corrections, character
- **HAS:** The new project's `CLAUDE.md` and `.claude/settings.json`
- **DOES NOT HAVE:** Session-scoped permissions (must re-approve)
- **DOES NOT HAVE:** The old project's instructions (new project's load instead)
- **MAY REFERENCE:** Files from the old project that don't exist in the new one — this doesn't crash, but the agent may be confused until oriented
