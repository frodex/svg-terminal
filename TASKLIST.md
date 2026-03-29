# svg-terminal — Task List

**Last updated:** 2026-03-29 by agent 3 (session e3af93f5)
**Branch:** `camera-only-test`
**Repo version:** v4 (pending)

---

## Bugs (Known, Reproducible)

### B1. Selection overlay misaligned
**Priority:** HIGH
**Description:** Text selection highlight (blue overlay) is offset from actual text under CSS3D transforms. `getBoundingClientRect()` and `screenToCell()` don't account for the `matrix3d` transform on cards at different Z depths.
**Root cause:** CSS3D hit testing is 2D. The selection overlay coordinates are computed in screen space but the text is inside a 3D-transformed element.
**Fix:** Create `screenToCardCoords(e, terminal)` that inverts the CSS3D matrix3d to map screen pixels to card-local coordinates. Same fix improves header hit testing.
**Affects:** Text selection, copy/paste positioning, cursor position display.

### B2. Cursor offset — cursor leads text too far right
**Priority:** MEDIUM
**Description:** After terminal resize, the cursor position in the SVG is offset from where text actually ends. Cursor appears further right than expected.
**Root cause:** `CELL_W` in terminal.svg is measured once at SVG load. After resize changes the viewBox, the cell width may not match the new layout.
**Fix:** Re-measure `CELL_W` after viewBox changes, or use relative positioning instead of absolute `cursor.x * CELL_W`.

### B3. Title bar size varies between cards
**Priority:** LOW
**Description:** Cards at different Z depths have different-sized headers on screen. Frustum layout puts some cards closer (bigger header) and some further (tiny header).
**Impact:** Visual inconsistency, harder to click small headers (mitigated by coordinate-based hit testing).
**Note:** This is inherent to the frustum approach. Not necessarily a bug — could be a feature if users expect it.

---

## Features (Designed, Not Implemented)

### F1. Merge camera-only-test → dev
**Priority:** HIGH
**Blocker:** B1 (selection overlay) should be fixed first, or merge and fix on dev.
**Description:** The `camera-only-test` branch has all the new architecture. `dev` is behind by ~20 commits.

### F2. URL detection + browser cards
**Priority:** HIGH
**Status:** Implemented, untested by user.
**Description:** terminal.svg detects URLs, underlines them blue. Click opens in new tab. Alt+click creates an iframe card in the 3D scene via `createBrowserDOM()`.
**Needs:** User testing. May need iframe sandboxing adjustments.

### F3. localStorage persistence
**Priority:** HIGH
**Description:** Save per-terminal fontSize, cardW, cardH, mutated flag. Restore on reload. Global default fontSize. Designed in `docs/superpowers/specs/2026-03-28-terminal-persistence-and-scenes-design.md`.
**Depends on:** Stable card sizing (mostly done).

### F4. Size morphing on startup (big bang)
**Priority:** MEDIUM
**Description:** Cards start at origin, small. Fly out and grow to saved sizes. Position AND size interpolate over MORPH_DURATION.
**Depends on:** F3 (need saved sizes to morph toward).

### F5. Dots (red/yellow/green) functional
**Priority:** MEDIUM
**Description:** Currently decorative. Candidates: red=close/remove from focus, yellow=minimize to ring, green=optimize fit.
**User request:** "They need to do something and look better if we keep them."

### F6. ThinkOrSwim workspace system
**Priority:** MEDIUM-LOW
**Description:** Named workspaces, save/load/switch layouts. Color tag bindings (linked objects update together). Quick-switch toolbar.
**Reference:** `/root/.claude/projects/-root/memory/reference_thinkorswim.md`
**Design:** Partially in persistence design spec. Needs full spec.

### F7. Mobile support
**Priority:** LOW
**Description:** Touch controls, virtual arrow keys, full-screen terminal on phone, 2-3 stacked terminals.
**Reference:** `/root/.claude/projects/-root/memory/project_svg_terminal_mobile.md`

### F8. Pinning terminals to world position
**Priority:** LOW
**Description:** Pin a terminal so it stays in world space, doesn't return to ring. Survives focus/unfocus.
**Design:** In persistence spec, Phase 4.

### F9. Groups (rigid body terminal collections)
**Priority:** LOW
**Description:** Bundle terminals into named groups. Move group = move all children. Recursive node model.
**Design:** In persistence spec, Phase 5.

### F10. Named scenes (camera snapshots)
**Priority:** LOW
**Description:** Save camera + terminal layout as named scene. Recall = animated transition. Prezi-style.
**Design:** In persistence spec, Phase 6.

---

## Integration

### I1. claude-proxy v2 integration
**Priority:** HIGH (blocked on UI stabilization)
**Description:** Phase B (adapt client to new API endpoints) and Phase C (merge, QC, code style).
**Docs:** `/srv/claude-proxy/docs/integration/`
**Status:** Architecture agreed in council protocol. Integration docs need revision — dashboard architecture changed significantly (frustum layout, camera-only focus, card factory, browser cards).
**Blocker:** Integration docs must be updated to reflect current dashboard architecture before building Phase B.

### I2. Clickable terminal links → claude-proxy integration
**Priority:** MEDIUM
**Description:** Color tag system — when focus changes to a Claude Code session, linked browser cards navigate to that session's demo URL.
**Reference:** `/root/.claude/projects/-root/memory/project_color_tags.md`

---

## Documentation

### D1. Handoff doc versioning
**Priority:** HIGH
**Description:** Rename resume-agent docs to `agent{N}.handoff-v{repo_version}.md`. Each agent keeps their own file. All handoffs revised when repo version bumps — strip deprecated, keep unique knowledge.
**Current files:**
- `resume-agent.md` → `agent1.handoff-v4.md`
- `resume-agent-v2.md` → `agent2.handoff-v4.md`
- `resume-agent-v3.md` → `agent3.handoff-v4.md`

### D2. Integration docs revision
**Priority:** HIGH
**Description:** claude-proxy integration docs describe the old dashboard architecture. Need revision to reflect camera-only focus, frustum layout, card factory, browser cards.

### D3. Deprecated docs archive
**Priority:** MEDIUM
**Description:** Move deprecated docs to `docs/archive/`. Add deprecation header with link to current version.
**Candidates:**
- `docs/handoff-resize-fix.md` (CSS font scaling approach — abandoned)
- `docs/superpowers/plans/2026-03-28-terminal-resize-keybindings.md` (same)
- `docs/superpowers/specs/2026-03-28-terminal-resize-and-keybindings-design.md` (same)

### D4. Design spec update
**Priority:** MEDIUM
**Description:** `2026-03-28-terminal-persistence-and-scenes-design.md` needs update for camera-only architecture, card factory, browser cards, color tags.

---

## Debug / Testing

### T1. E2E test for URL detection
**Priority:** MEDIUM
**Description:** Add E2E test that verifies URLs in terminal output are detected and clickable.

### T2. E2E test for browser cards
**Priority:** MEDIUM
**Description:** Add E2E test that creates a browser card via `_addBrowserCard()` and verifies it renders.

### T3. E2E test for deselect behavior
**Priority:** MEDIUM
**Description:** Verify click-empty deselects without moving cards. Verify re-select doesn't creep Z.

### T4. Selection overlay E2E test
**Priority:** LOW (after B1 fix)
**Description:** Verify text selection highlight aligns with actual text.
