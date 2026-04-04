# Partial Screen Fix v2 — Review Notes by agent 4 (2026-04-02)

## Previous Review Incorporated?

Checking my v1 notes against v2 changes:

| v1 Note | Status in v2 | Assessment |
|---------|-------------|------------|
| **Critical: cache path drops ANSI** | FIXED — Task 1 adds `-e` flag, Task 2 uses `parseAnsiLine()` | Good. Both the capture AND the parse are now correct. |
| **Sequential fetch blocks discovery** | FIXED — Task 3 uses `Promise.allSettled` for parallel CP fetches | Good. 1.5s timeout instead of 3s. |
| **References dead code (terminal-renderer.mjs)** | FIXED — Task 3 removed. Span format task dropped entirely. | Good. Correctly identified as no-op since terminal.svg handles both formats. |
| **Missing test verification** | FIXED — Task 3 Step 4 and Task 5 Step 3 run test suites | Good. |
| **Port 3200 vs 3201** | PARTIALLY — Task 4 Step 2 uses 3201, Task 3 Step 2 uses 3202 for test. Main port unclear. | See note below. |

## Remaining Concerns

### 1. Port confusion (minor but operational risk)

Task 3 Step 2 starts a test instance on 3202. Task 4 Step 2 tests against 3201. Task 5 Step 2 uses `restart-server.sh`. Which port is the real one? Sessions.md says 3201 (moved during crash). The restart script may use 3200.

**Recommendation:** Before implementing, verify the current port and ensure all test commands use it consistently. Or better: the implementer reads `restart-server.sh` and the current server process to determine the port.

### 2. Task 2 Step 2: WebSocket cache path also needs parseAnsiLine (good catch)

v2 correctly identifies that the WebSocket initial screen send (line ~748) has the same cache parsing problem and fixes it. This wasn't in v1. Good.

### 3. Task 3: Three-phase approach is clean

Phase 1 (session-add), Phase 2 (screens), Phase 3 (bridges) is a better structure than v1's interleaved loop. Cards appear in the sidebar immediately (phase 1), fill with content shortly after (phase 2), then get live updates (phase 3).

**One subtlety:** Phase 1 sends `session-add` for ALL sessions before any screens. The browser creates empty cards for all sessions. Then screens arrive. This means there's a brief moment where all cards exist but are empty. If the user is looking at the dashboard during load, they'll see cards flash from empty to populated. This is probably fine — better than the current behavior where CP cards stay empty. But worth noting.

### 4. Task 3: `cpSessions` scoped outside the phases

The `cpSessions` variable is used in both Phase 2 (parallel fetch) and Phase 3 (bridge setup). Make sure it's scoped correctly — defined before the phases, used in both. The plan code does this correctly.

### 5. Task 4: `tmux has-session` on every /api/pane request

Every HTTP pane request runs `tmux has-session` to determine routing. This is ~5ms overhead. For the polling fallback (which fires frequently), this adds up. But the polling fallback is a safety net that rarely fires when WebSocket is connected, so acceptable.

**Alternative considered and rejected:** Caching session source in memory. The source can change (session created, removed, migrated). The `has-session` check is the ground truth. 5ms is cheap.

### 6. Task 5: E2E tests not mentioned

Task 5 Step 3 runs `test-server.mjs` and `test-auth.mjs` but NOT `test-dashboard-e2e.mjs`. The E2E tests cover terminal rendering which is exactly what this fix affects.

**Fix:** Add `node test-dashboard-e2e.mjs` to Task 5 Step 3.

### 7. Missing: What happens when CP API returns different span format?

v1 had a whole task (Task 3) for span format normalization. v2 dropped it as "likely no-op." This is probably correct — I verified terminal.svg's `updateLine()` handles both `cls`-based and `fg`-hex-based spans. But the plan should have a verification step: after Task 3 implementation, check that CP sessions render with correct colors by comparing visually to local tmux sessions.

Task 3 Step 3 does say "manual test" but doesn't mention color comparison specifically. Add: "Verify colors render on CP sessions — green prompts, red errors, etc."

## Summary

**v2 is significantly better than v1.** All critical issues addressed. The three-phase discovery, parallel fetch, and parseAnsiLine integration are all correct.

**Ready to implement with minor adjustments:**
1. Verify port before starting
2. Add E2E tests to Task 5
3. Add color verification to Task 3 manual test

**No blocking issues.** Approved for implementation.
