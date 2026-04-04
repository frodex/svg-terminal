# claude-fork Integration with claude-proxy

**Status:** Draft — for claude-proxy agent to review, correct, and implement
**Date:** 2026-04-01
**Author:** Steward 02 (session `6a76ff6f`) — wrote the tool, does NOT know claude-proxy internals

---

## What This Spec Is

This tells the claude-proxy agent how to wire `claude-fork` into the session creation UI. I know the tool's API. I don't know claude-proxy's code. The claude-proxy agent should correct anything here that doesn't match reality.

---

## The Tool

```
/srv/svg-terminal/claude-forker/tools/claude-fork
```

Python 3, no dependencies, single file. Call via `python3` or directly (has shebang).

---

## Where It Hooks In

The session creation form already has these fields:

| Field | Current use | Fork use |
|-------|------------|----------|
| Session name | tmux session name | Same — names the fork's tmux session |
| Run as user | User for `su -` | Target user for the fork |
| Working directory | CWD for `claude` | Target project directory |
| Claude session ID | `--resume {id}` | Source session to fork FROM |

When "Claude session ID" is populated, the submit flow changes:

```
CURRENT FLOW (no session ID):
  submit → launch tmux → run `claude` in target dir

FORK FLOW (session ID populated):
  submit → call claude-fork → get new UUID → launch tmux → run `claude --resume {new-uuid}` in target dir
```

---

## Integration Steps

### Step 1 — Detect fork mode

If the "Claude session ID" field has a value, this is a fork. The UI should:
- Change the submit button label from "Create" to "Fork & Launch" (or similar)
- Show a fork summary before submit (see Step 3)

### Step 2 — Dry run on field change

When the user fills in the session ID field (or changes working directory / user), call:

```bash
python3 /srv/svg-terminal/claude-forker/tools/claude-fork fork {session-id} {working-dir} --user {user} --dry-run --json
```

Parse the response. Use the `checks` and `warnings` to populate the UI:

```json
{
  "checks": {
    "sourceExists": true,
    "sourceActive": true,
    "sourceActivePid": 3352832,
    "sourceCompacted": false,
    "sourceRecords": 1462,
    "sourceSizeHuman": "5.4MB",
    "targetDirExists": true,
    "targetHasClaudeMd": true,
    "targetHasSettings": true,
    "targetUserHasClaude": true,
    "targetCleanupProtected": true
  },
  "warnings": [
    "Source session is ACTIVE (PID 3352832)"
  ]
}
```

Show warnings inline in the form. If `checks.sourceExists` is false, show the `suggestions` from the error response in a picker.

### Step 3 — Pre-submit summary

Before executing the fork, show:

```
Fork summary:
  Source: 6a76ff6f (root@/root, 5.4MB, 1462 records)
  ⚠ Source session is ACTIVE (PID 3352832)
  Target: /srv/svg-terminal (as root)
  Target has CLAUDE.md: Yes

  [s=submit, e=edit, esc=cancel]
```

This data comes from the dry-run response.

### Step 4 — Execute fork on submit

```bash
python3 /srv/svg-terminal/claude-forker/tools/claude-fork fork {session-id} {working-dir} --user {user} --json
```

Parse stdout as JSON. Check `status`:

| status | Action |
|--------|--------|
| `"success"` | Use `fork.sessionId` and `resume` command for launch |
| `"error"` | Show `error` and `detail` to user, don't launch |

On success, the response contains everything needed:

```json
{
  "fork": {
    "sessionId": "1574bad0-4e40-4f28-b7aa-2b83228999a5",
    "project": "/srv/svg-terminal",
    "user": "root",
    "jsonlPath": "/root/.claude/projects/-srv-svg-terminal/1574bad0-...",
    "recordsWritten": 1462,
    "cwdFieldsRewritten": 1284,
    "companionFilesCopied": 15
  },
  "resume": "cd /srv/svg-terminal && claude --resume 1574bad0-4e40-4f28-b7aa-2b83228999a5"
}
```

### Step 5 — Launch in tmux

Use `fork.sessionId` instead of the original session ID:

```typescript
// PSEUDO-CODE — adapt to actual claude-proxy launcher

// Current launch (no fork):
// tmux new-session -s {session-name} "cd {working-dir} && claude --resume {original-id}"

// Fork launch:
const forkResult = JSON.parse(execSync(
  `python3 /srv/svg-terminal/claude-forker/tools/claude-fork fork ${sessionId} ${workingDir} --user ${user} --json`
));

if (forkResult.status !== 'success') {
  throw new Error(forkResult.error);
}

// Launch with the FORK's session ID, not the original
const forkId = forkResult.fork.sessionId;
const launchCmd = `cd ${workingDir} && claude --resume ${forkId}`;

// If user changed:
const cmd = user !== currentUser
  ? `su - ${user} -c '${launchCmd}'`
  : launchCmd;

// Wrap in tmux as claude-proxy normally does
tmuxLaunch(sessionName, cmd);
```

### Step 6 — Session metadata

After fork + launch, claude-proxy should record:

```yaml
# In session metadata (however claude-proxy tracks sessions)
session:
  name: CLAUDE-FORK-AUTHOR-fork-01
  forkedFrom: 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91
  forkId: 1574bad0-4e40-4f28-b7aa-2b83228999a5
  forkDate: 2026-04-01T02:04:00Z
  targetDir: /srv/svg-terminal/claude-forker
  user: root
```

This lets the UI show fork lineage — "forked from session X on date Y."

---

## Populating the Session Picker

When the user clicks on the "Claude session ID" field, show available sessions:

```bash
python3 /srv/svg-terminal/claude-forker/tools/claude-fork list --json
```

Returns array of sessions with ID, project, size, status, age. Display as a picker/dropdown. The user selects one, field populates with the session ID.

For a specific user:
```bash
python3 /srv/svg-terminal/claude-forker/tools/claude-fork list --user greg --json
```

### Picker display format

```
6a76ff6f  /root             5.4MB  ACTIVE  0m   (Steward 02)
e3af93f5  /root            20.1MB  ACTIVE  22h  (svg-terminal agent 3)
d0d0fda3  /srv/svg-terminals 11MB  ACTIVE  2d
72fd1d06  /srv/svg-terminal  2.4MB  active  1d
```

The session name in parens would come from claude-proxy's own metadata (if it tracks session names → session IDs).

---

## Error Handling

| Exit code | Meaning | UI action |
|-----------|---------|-----------|
| 0 | Success | Parse JSON, launch |
| 1 | Source not found | Show error + suggestions picker |
| 2 | Target user invalid | Show error, highlight user field |
| 3 | Target dir creation failed | Show error, highlight dir field |
| 4 | CWD rewrite failed | Show error, offer retry |
| 5 | Chain integrity failed | Show error, suggest trying a different source session |

Errors in `--json` mode always return structured JSON on stdout:
```json
{
  "status": "error",
  "exitCode": 1,
  "error": "Source session not found",
  "suggestions": ["6a76ff6f...", "e3af93f5..."]
}
```

---

## What I Don't Know (claude-proxy agent should fill in)

1. **How does claude-proxy store session metadata?** YAML? JSON? Database? The fork lineage (forkedFrom, forkId) needs to be stored wherever session settings live.

2. **How does the tmux launcher work?** I showed pseudo-code. The actual `tmuxLaunch()` function signature and its argument handling is unknown to me.

3. **How does the settings editor (Ctrl+B e) work?** The fork fields might need to appear there for editing after launch.

4. **Does claude-proxy support the `--resume` flag in its launch scripts?** The `scripts/launch-claude.sh` needs to accept the fork UUID and pass it through.

5. **Where is the session creation form rendered?** Is it a TUI component? Which file? The fork detection (Step 1) needs to hook into whatever renders the form.

6. **How does claude-proxy handle session discovery/restart?** If the proxy restarts, does it re-discover sessions from tmux? The forked session needs to survive this.

7. **What happens to the [LOCKED] flag on the session ID field?** In the screenshot, the session ID was `[LOCKED]`. For fork mode, should it stay locked (fork from exactly this ID) or become editable (pick a different source)?

---

## Testing

After integration, verify with:

1. **Normal session creation still works** — no fork, no session ID field
2. **Fork to same directory** — session ID filled, same working dir
3. **Fork to different directory** — session ID filled, different working dir
4. **Fork to different user** — session ID + different user
5. **Session picker populates** — clicking session ID field shows available sessions
6. **Warnings display** — active source, compacted source, no CLAUDE.md at target
7. **Error handling** — invalid session ID shows suggestions
8. **Fork lineage tracked** — metadata records forkedFrom/forkId

Use the tmux test harness (`docs/testing-via-tmux.md`) to verify the launched fork loads context correctly.
