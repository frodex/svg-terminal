# Remove Active Terminal Z-Slide — Plan

**Goal:** Remove the Z-slide "bump forward" effect in multi-focus mode. Active terminal distinguished by gold header background only, no Z movement.

**Why:** The Z-slide adds complexity (`_savedZ` tracking, restore on deselect, creep bug history) for a subtle effect. The gold header (`#4a4020` background, PRD §7.3) already indicates which terminal is active.

**Files:** `dashboard.mjs` only

---

### TO MAKE SURE WE ARE ON SAME PAGE - THIS "EVENT" HAPPENS WHEN YOU CLICK ON A CARD TO SWITCH FOCUS, CARD GETTING FOCUS MOVES FORWARD, CARD LOOSING FOCUS RECEEDS. THIS IS WHAT WE ARE GETTING RID OF.

### Changes

**1. Remove `READING_Z_OFFSET` constant** (line 1840)

Delete: `const READING_Z_OFFSET = 25;`

**2. Remove Z-slide from `setActiveInput()`** (lines 1850-1872)

Remove the "slide previous active back" block:

```javascript
  if (prevActive && prevActive !== sessionName) {
    const prevT = terminals.get(prevActive);
    if (prevT && prevT._savedZ !== undefined) {
      prevT.targetPos.z = prevT._savedZ;
      prevT.morphFrom = { ...prevT.currentPos };
      prevT.morphStart = clock.getElapsedTime();
      delete prevT._savedZ;
    }
  }
```

Remove the "slide new active forward" block:

```javascript
  const t = terminals.get(sessionName);
  if (t && focusedSessions.size > 1) {
    if (t._savedZ === undefined) {
      t._savedZ = t.targetPos.z;
      t.targetPos.z += READING_Z_OFFSET;
      t.morphFrom = { ...t.currentPos };
      t.morphStart = clock.getElapsedTime();
    }
  }
```

**3. Remove Z-restore from `deselectTerminals()`** (lines 1963-1976)

Remove the "slide active back" block:

```javascript
  if (activeInputSession) {
    const t = terminals.get(activeInputSession);
    if (t && t._savedZ !== undefined) {
      t.targetPos.z = t._savedZ;
      t.morphFrom = { ...t.currentPos };
      t.morphStart = clock.getElapsedTime();
      delete t._savedZ;
    }
  }
  for (const [name, term] of terminals) {
    delete term._savedZ;
  }
```

**4. Remove `_savedZ` references** — grep for any remaining uses.

---

### What Stays

- Gold header background for active terminal (CSS `.terminal-3d.input-active header`)
- `setActiveInput()` function (still sets `activeInputSession`, updates styles, shows controls)
- `deselectTerminals()` function (still clears `activeInputSession`, hides input bar)

### Test

- All 57 tests must pass
- Multi-focus: click between cards — gold header moves, no Z movement
- Deselect (click empty space) — no Z snap-back animation

### References

- PRD §7.4: Z-slide documentation and Z-creep bug history
- PRD §7.3: Gold header is the active indicator (no border/box-shadow — triggers re-rasterization)
