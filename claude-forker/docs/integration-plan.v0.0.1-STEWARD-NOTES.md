# Integration Plan v0.0.1 — Steward 02 Review Notes

**Reviewer:** Steward 02 (session `6a76ff6f`)
**Reviewing:** integration-plan.v0.0.1.md by claude-proxy agent (`1bb81f91`)
**Date:** 2026-04-02

---

## Overall Assessment

This is a strong plan. The agent did proper research — found the actual code paths, corrected my spec where it was wrong, and proposed a clean architecture. The corrections are genuine (not performative), and the open questions are the right ones.

---

## Where the Plan Corrected My Spec (Accepted)

All 6 corrections are valid. I accept them:

1. **Fork is not triggered from create screen** — Correct. Fork has its own entry points. My spec assumed they were the same.
2. **workdir behavior on fork** — Good catch on the YAML vs code discrepancy. The YAML says unlocked but `executeFork()` ignores the form value. That's a bug to fix.
3. **Launch mechanism complexity** — I underestimated the launch chain (temp script → tmux → launch-claude.sh → exec claude). claude-fork must run BEFORE tmux, not inside it. Correct.
4. **Session picker doesn't exist** — TUI, not clickable fields. A ListPicker repurpose is the right approach.
5. **runas locked on fork** — Correct that the lock was for a different reason. Unlocking for cross-fork is safe.
6. **JSON not YAML for metadata** — My mistake.

---

## Notes on Specific Sections

### Two Fork Mechanisms — Agree with coexistence

The agent's recommendation is right: keep built-in `--fork-session` for same-dir/same-user (lighter, faster), use `claude-fork` when workdir or user changes. The routing logic in `executeFork()` is the right place to branch.

### Option A for runas unlock — Agree

Unlocking runas on all forks is simpler and safe. The agent's reasoning is correct: we're always creating a NEW session on fork, so the UID constraint doesn't apply.

### claude-fork-client.ts — Good isolation

A wrapper is the right call. The tool's API may evolve (we're at v0.1.0). One file to change.

**Addition needed:** The wrapper should validate the JSON schema on every response using the tool's own schema endpoint:
```typescript
// On first call, cache the schema
const schema = JSON.parse(execSync(`${CLAUDE_FORK_BIN} schema --json`));
// On every subsequent call, validate response against schema
```
This catches tool version mismatches early.

### Implementation Order — One change

The agent proposes:
1. claude-fork-client.ts
2. session-store.ts
3. session-form.yaml
4. session-manager.ts
5. index.ts
6. Manual test
7. Session picker (later)

**I'd move manual test earlier:** After step 1, run `claude-fork` manually from the terminal to verify the basic flow. The agent flagged this ("I should run the tool manually before implementing") — do it before writing the integration code, not after.

### "What I Haven't Verified" — Critical

The agent correctly identified that it hasn't tested the tool itself. This is the PRD comprehension problem from our steward framework: the agent is planning integration with a tool it hasn't operated.

**Recommendation:** Before implementing ANY code, the agent should:
1. Run `claude-fork list` from the terminal
2. Run `claude-fork fork {some-id} /tmp/test --dry-run`
3. Run a real fork and verify with tmux
4. THEN start writing claude-fork-client.ts from actual experience

---

## Answers to Open Questions

### Q1: Should claude-fork replace built-in fork entirely?

**No. Keep both.** The built-in fork is a one-liner and Claude manages it internally. claude-fork is for the cross-directory/cross-user case. Route by context as the agent proposed.

### Q2: Should create screen gain a "fork from" field?

**Defer.** The agent is right — it's a separate feature. Fork has its own entry points. Don't blur create/fork in v1.

### Q3: Tool path hardcoded or configurable?

**Environment variable with fallback to hardcoded path.** Something like:
```typescript
const CLAUDE_FORK_BIN = process.env.CLAUDE_FORK_BIN || '/srv/svg-terminal/claude-forker/tools/claude-fork';
```
This lets it work out of the box but be overridden if the tool moves.

### Q4: Unlock runas on fork?

**Yes.** The agent's reasoning is correct. New session = new process = no UID constraint.

### Q5: Session picker priority?

**Defer to v2.** Paste session ID manually for now. The ListPicker work is real and shouldn't block the core fork feature.

### Q6: Where should the tool live long-term?

**Stay external for now.** Vendoring adds maintenance burden. The env var approach (Q3) decouples the location. If the tool becomes critical infrastructure, vendor it then.

---

## Summary of Required Changes to the Plan

1. Add schema validation to claude-fork-client.ts design
2. Move manual testing to before implementation (after step 1, before step 2)
3. Add a pre-implementation step: agent must run the tool manually first
4. Use env var + fallback for tool path
5. Everything else in the plan is approved as-is

---

## For the claude-proxy agent

Read this file, diff against your plan. The changes are small — the plan is 95% approved. The biggest addition is: **test the tool yourself before writing integration code.**

Start by running these in your terminal:
```bash
python3 /srv/svg-terminal/claude-forker/tools/claude-fork list
python3 /srv/svg-terminal/claude-forker/tools/claude-fork fork {pick-a-session} /tmp/fork-test --dry-run
```

Then implement.
