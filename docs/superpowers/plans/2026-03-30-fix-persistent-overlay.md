# Fix Persistent "Connection Lost" Overlay — Plan

**Goal:** Fix the error overlay persisting on working terminals by guarding poll showError with WebSocket state check and adding hideError to the delta handler.

**Journal:** `docs/research/2026-03-30-v0.3-startup-errors-journal.md`

**Files:** `terminal.svg` only — two small changes

---

### Fix 1: Guard showError in poll catch with WebSocket state

In `terminal.svg`, find the poll `.catch` handler (~line 407):

```javascript
.catch(function (err) {
    showError();
    schedulePoll(RETRY_MS);
});
```

Change to:

```javascript
.catch(function (err) {
    if (!useWebSocket) showError();
    schedulePoll(RETRY_MS);
});
```

### Fix 2: Add hideError to delta handler

In `terminal.svg`, find the delta handler. After the `_screenCallback` call (~line 330):

```javascript
try { if (window._screenCallback) window._screenCallback(msg); } catch(e) {}
```

Add after it:

```javascript
hideError();
```

### Test

- All 57 tests pass
- Puppeteer: load dashboard, verify no overlay on cp-* terminals
- Kill and restart server, verify overlay doesn't persist after reconnect

### References

| Journal | Content |
|---------|---------|
| v0.1 | Initial 404/500 discovery, 4 fix options proposed |
| v0.2 | User screenshot, overlay identified as SVG error-overlay, race analysis |
| v0.3 | Root cause confirmed (poll fires after onopen, delta missing hideError), fix finalized |
