# Testing Claude Code Sessions via tmux Journal v0.1
**Date:** 2026-04-01
**Session:** Greg + Claude Opus 4.6 (session `6a76ff6f`)
**Status:** Direction Confirmed — empirically verified
**Preceding:** none
**Changes from prior:** Initial journal — discovery that Claude Code requires a terminal for interactive resume, tmux is the testing harness

---

## The Problem

When testing session operations (fork, resume, relocate), you need to actually launch Claude Code and verify the session loads correctly. But:

1. `claude -p` (print mode) with `--resume` on large sessions times out — it tries to load the full conversation into context before responding
2. `claude --resume` without `-p` opens an interactive TUI that can't be driven from a Bash tool call
3. Piping prompts via stdin (`echo "question" | claude --resume ...`) also stalls on large sessions
4. You can't see the TUI output from a tool call — it renders to the terminal, not stdout

## The Solution: tmux as Test Harness

Launch Claude Code inside a tmux session, then send keystrokes and capture the pane output:

### Launch
```bash
tmux new-session -d -s test-name -x 120 -y 40 "cd /target/dir && claude --resume {session-id}"
```

- `-d` — detached (don't attach our terminal)
- `-s test-name` — named session for easy reference
- `-x 120 -y 40` — reasonable terminal size
- The command string runs Claude Code inside tmux

### Wait for Load
```bash
sleep 10  # Give Claude Code time to parse the JSONL and render
```

Large sessions (4MB+) may need 15-20 seconds. Watch for the welcome banner and context percentage.

### Capture Output
```bash
tmux capture-pane -t test-name -p
```

Returns the current terminal content as text. Look for:
- Welcome banner with project directory
- Context percentage (0% = empty/no history loaded, 32% = history loaded)
- "Recent activity" sidebar entries
- Error messages

### Send Input
```bash
tmux send-keys -t test-name "Your question here" Enter
sleep 15  # Wait for response
tmux capture-pane -t test-name -p
```

### Clean Up
```bash
tmux send-keys -t test-name "/exit" Enter
sleep 3
tmux kill-session -t test-name 2>/dev/null
```

**IMPORTANT:** Always `/exit` before killing. Just killing tmux leaves the Claude process orphaned.

---

## What to Look For in Test Results

### Session loaded successfully
```
Context ███░░░░░░░ 32%          ← history is in context
/srv/forking-test               ← correct project directory
Recent activity                 ← shows prior conversation
```

### Session found but history not loaded
```
Context ░░░░░░░░░░ 0%           ← no history in context
No recent activity               ← nothing from prior conversation
"I don't have any context from a previous conversation"  ← model confirms
```

This means Claude Code found the JSONL file (no "No conversation found" error) but didn't load the records into context. Common cause: CWD mismatch in the JSONL records.

### Session not found
```
No conversation found with session ID: {id}
```

Claude Code couldn't find the JSONL file. Either the encoded-cwd directory is wrong or the file isn't there.

---

## Verified Experiments (2026-04-01)

### Test 1: Copy with new UUID filename, old CWD
- Copied `73487e85.jsonl` as `ae4dd275.jsonl` to `-srv-forking-test/`
- **Result:** Session found (no "not found" error) but no conversation history loaded
- **Conclusion:** Filename UUID doesn't need to match internal sessionId

### Test 2: Copy with matching UUID filename, old CWD
- Copied `73487e85.jsonl` with original name to `-srv-forking-test/`
- **Result:** Same — found but no history
- **Conclusion:** Matching filename doesn't help if CWD is wrong inside records

### Test 3: Copy with CWD rewrite, tiny session
- Rewrote `cwd` field from `/root` to `/srv/forking-test` in every record
- **Result:** Found but no history — session was too small (likely an empty test session)
- **Conclusion:** Inconclusive — the session might have had no real conversation turns

### Test 4: Copy with CWD rewrite, real 4MB session
- Rewrote CWD in session `6a76ff6f` (1146 lines, 4MB, real conversation)
- **Result:** Full success. Context loaded at 32%. Agent knew about PHAT TOAD, the steward framework, everything from the conversation. Identified itself correctly and knew what project it was working on.
- **Conclusion:** CWD rewrite is the key. Copy + rewrite CWD = working fork to new project.

---

## The Pattern for Testing Session Operations

```bash
# 1. Prepare the session file (copy, modify, fork, etc.)
# ... your operation here ...

# 2. Launch in tmux
tmux new-session -d -s test -x 120 -y 40 \
  "cd /target/project && claude --resume {session-id}"

# 3. Wait for load
sleep 10

# 4. Check if it loaded
tmux capture-pane -t test -p
# Look for context %, project dir, recent activity

# 5. Optionally send a question
tmux send-keys -t test "What do you know about this project?" Enter
sleep 15
tmux capture-pane -t test -p

# 6. Clean up
tmux send-keys -t test "/exit" Enter
sleep 3
tmux kill-session -t test 2>/dev/null
```

This is the only reliable way to test session resume from within another Claude Code session. Direct `claude -p --resume` calls stall on large sessions. The tmux approach gives you full visibility into what the loaded session sees.
