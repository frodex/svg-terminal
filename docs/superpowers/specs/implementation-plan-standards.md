# Implementation Plan Standards

## Purpose

An implementation plan is a contract between the planner and the implementing agent(s). The implementing agent may have zero context about the project. The plan must be sufficient — no ambiguity, no assumptions, no "see the code for details."

---

## Rule 1: Agent Interchangeability

Two agents unfamiliar with the project must be able to produce identical, working artifacts by following the plan independently. If not, the plan is incomplete.

**Test:** Remove all context except the plan document itself. Can an agent:
- Find every file that needs to change?
- Know the exact function signatures to call or modify?
- Know what data structures are passed and returned?
- Know what tests to write and what they should assert?
- Know what other systems/callers are affected by the change?

If any answer is "they'd have to read the code to figure it out" — add that information to the plan.

**Required for every code step:**
- Exact file path
- Exact function name (as it exists in the repo, not renamed or abbreviated)
- Exact parameter names and types
- Return type/shape with example values
- Line number ranges (approximate is fine, but function names must be exact)

**Required for every data structure:**
- Exact property names (not `sessions` when the code uses `name`)
- Shape of collections (array vs object, Map vs Set)
- Example values showing the actual data

---

## Rule 2: Current State Verification

The plan must match the current state of the repo. Not what the docs say. Not what a previous plan said. The actual running code.

**Before writing any plan:**
1. Read every function that will be modified — exact signatures, current behavior
2. Read every data structure that will be consumed or produced — exact shape
3. Read every caller of functions being modified — downstream impact
4. Read every test that exercises code being modified — what needs updating
5. Grep for every string/identifier being renamed or removed — find all references

**The plan must include for each mutation:**
- Current function signature (as-is)
- Proposed function signature (to-be)
- All callers of the function and whether they need updating
- All consumers of data structures being changed and whether they need updating
- All test files that reference the code being changed

**Cross-system impact:**
- If the mutation affects an API that other applications call (helper apps, sidecar apps, CLI tools, test harnesses), the plan must:
  - List every known consumer
  - Describe what changed from the consumer's perspective
  - Provide example usage showing the new interface
  - Include a migration note or phasing plan if consumers can't be updated simultaneously

---

## Rule 3: No Unverified Claims

Every factual claim in the plan must be verified against the code. Not assumed. Not remembered from a previous conversation.

**Red flags — never write these without verifying:**
- "This function returns X" — read the function
- "This endpoint accepts X" — read the handler
- "This is a Map/Set/Array" — read the declaration
- "No callers use this" — grep the entire repo
- "This variable exists" — grep for it
- "This column exists in the schema" — read the schema

**If a claim requires verification, include the verification command:**
```
grep -n 'functionName' server.mjs  # verified: line 501
```

---

## Rule 4: Test Completeness

Every behavioral change must have a corresponding test. The plan must include:

- The test code (not "write tests for X" — the actual test)
- The exact command to run the test
- The expected output (pass/fail and why)
- What the test proves about the behavioral change

**Test fixtures:**
- If tests require real sessions, databases, or external services, the plan must specify the fixture strategy (mock, stub, spawn, or use real)
- If tests depend on environment variables, list them with values

---

## Rule 5: Phasing and Rollback

If the plan involves multiple steps that must be deployed together:
- Document which steps are atomic (must ship together)
- Document rollback procedure for each phase
- Document any dual-accept windows needed (e.g., old and new auth both work during deploy)
- Document what breaks if only half the steps are applied

---

## Rule 6: Schema and Interface Contracts

For every schema change (database, API, WebSocket message format):
- Show the before and after schema
- Show the migration path (ALTER TABLE with try/catch for idempotency)
- List every consumer of the old schema
- Provide the new interface contract with example payloads

For every API endpoint change:
- Current request/response format with example
- New request/response format with example
- List of all clients that call the endpoint (grep the repo)
- Migration path if the format changes

---

## Rule 7: Single Review Round

The plan should require at most ONE review round. Achieve this by:

1. **Verify before writing** — read the code, don't assume
2. **Include all references** — file paths, function names, line numbers, data shapes
3. **Self-review checklist before submitting:**
   - [ ] Every function name in the plan exists in the repo (grepped)
   - [ ] Every variable/constant referenced exists (grepped)
   - [ ] Every data structure shape matches the actual code
   - [ ] Every caller of modified functions is listed
   - [ ] Every test file touching modified code is listed
   - [ ] Every schema change has a migration path
   - [ ] Every API change lists all consumers
   - [ ] No placeholder steps ("add appropriate error handling")
   - [ ] No unverified claims ("this returns X")
   - [ ] Code examples use exact function signatures from the repo

---

## Anti-patterns

| Pattern | Problem | Fix |
|---------|---------|-----|
| "See the code for details" | Agents can't see what you saw | Include the details |
| "Similar to Task N" | Agents may read tasks out of order | Repeat the code |
| "Update callers as needed" | Which callers? How many? | List every caller with the change |
| "Handle edge cases" | Which edges? | Name them and show the handling |
| Variable name doesn't match repo | Agent writes broken code | Grep before writing |
| Data structure shape assumed | `{ sessions: [...] }` vs array | Read the actual return value |
| "No active callers" without grep | Hidden callers break at runtime | `grep -rn 'functionName' .` |
| Test says "Expected: pass" | Pass how? What output? | Show exact assertion |
| Schema migration not specified | Existing databases break on deploy | ALTER TABLE with try/catch |
