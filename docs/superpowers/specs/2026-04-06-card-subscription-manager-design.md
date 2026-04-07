# Card Subscription Manager — Design Spec
**Date:** 2026-04-06
**Status:** Draft

---

## Summary

A persistent card subscription system that controls which terminal sessions appear in the dashboard. Users manage subscriptions via a "CARDS >" sub-panel in the hamburger menu. Unsubscribed sessions are never sent to the browser — zero rendering and WebSocket cost. A status bar shows card counts, and an orange badge on the top menu alerts when cards are hidden.

---

## User-Facing Behavior

### Top Menu Bar
- Orange badge: `YOU HAVE 7 HIDDEN CARDS` — visible when any cards are unsubscribed. Clicking opens the CARDS panel.

### Hamburger Menu
- New menu item: `CARDS >` — opens a sub-panel (flyout or inline expansion).

### CARDS Sub-Panel

**Header toggles:**
- `[ ] Always show new cards` — auto-subscribe to any new session that appears
- `[ ] Always show MY new cards` — auto-subscribe to sessions owned by the current user (includes sidecars like browser cards)

**Session list** (scrollable, grouped by state):

```
DISPLAYED
  ● cp-SVG-UI-Doctor-02 | root | 2h31m        [⏸][✕]
  ● cp-BATTLETECH-01    | cp-aaronb | 45m      [⏸][✕]

PAUSED
  ⏸ cp-AARON            | root | 1d2h          [▶][✕]

HIDDEN
  ○ cp-old-session       | cp-joshm | 3d        [+]
```

Each row shows: **status icon, session name, owner, age, action buttons**

**Action buttons:**
- `⏸` — sticky-pause (stops data, persists across reload, card stays in UI as paused)
- `✕` — unsubscribe (removes card from UI, not loaded on reload)
- `▶` — resume a sticky-paused session
- `+` — subscribe to a hidden session

### Status Bar (Bottom)
- Text: `25 available / 7 displayed / 2 paused`
- Clicking opens the CARDS panel

### Pause Behavior — Two Layers

| Action | Source | Persistent? | Effect |
|--------|--------|------------|--------|
| Pause via thumbnail ⏸ | Thumbnail button | No — resets on reload | Stops data, card stays in UI with overlay |
| Pause via CARDS menu | Subscription manager | Yes — stored in profile | Stops data, card shows paused on reload |
| Unsubscribe via CARDS menu | Subscription manager | Yes — stored in profile | Card removed entirely, not loaded on reload |

Thumbnail pause does NOT write to the profile. It's a temporary session-level toggle.

---

## Data Model

### New table: `card_subscriptions`

```sql
CREATE TABLE IF NOT EXISTS card_subscriptions (
  user_email TEXT NOT NULL,
  session_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'subscribed',  -- subscribed | paused | unsubscribed
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_email, session_name)
);
```

States:
- `subscribed` — session loaded and active on connect
- `paused` — session loaded but data transmission stopped (sticky)
- `unsubscribed` — session not sent to browser at all

Sessions with no row default to `subscribed` (backward compatible — existing users see all sessions).

### New table: `card_preferences`

```sql
CREATE TABLE IF NOT EXISTS card_preferences (
  user_email TEXT PRIMARY KEY,
  auto_show_new INTEGER NOT NULL DEFAULT 1,      -- always show new cards
  auto_show_own INTEGER NOT NULL DEFAULT 1,       -- always show MY new cards
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Default: both enabled (current behavior — all sessions auto-appear).

---

## Server Changes (server.mjs)

### Session Discovery Filter

`sendSessionDiscovery()` currently sends `session-add` for every session from `cpRequest('listSessions')`. Change to:

1. Query `card_subscriptions` for the user
2. Skip sessions with state `unsubscribed`
3. For sessions with state `paused`, send `session-add` with a `paused: true` flag
4. Sessions with no row or state `subscribed` → send normally

### New Session Handling

When a `session-add` event arrives from claude-proxy (new session created):

1. Check `card_preferences` for the user:
   - If `auto_show_new = 1` → send to browser
   - Else if `auto_show_own = 1` AND session owner matches user → send to browser
   - Else → suppress (don't send `session-add`), increment hidden count
2. Broadcast updated available/displayed/paused counts to the browser

### WS Message Handlers

New messages from browser → server:

| Message | Fields | Server Action |
|---------|--------|--------------|
| `card-set-state` | `{session, state}` | Update `card_subscriptions` row. If `unsubscribed`: remove watcher, send `session-remove` to browser. If `paused`: stop data relay. If `subscribed`: bridge session, send screen data. |
| `card-set-prefs` | `{autoShowNew, autoShowOwn}` | Update `card_preferences` row. |
| `card-list-all` | `{}` | Return all sessions the user can see (including unsubscribed) with name, owner, age, current state. |

New messages from server → browser:

| Message | Fields | Purpose |
|---------|--------|---------|
| `card-list` | `{sessions: [{name, owner, age, state}, ...]}` | Full list for CARDS panel |
| `card-counts` | `{available, displayed, paused}` | Status bar update |

### Count Tracking

Server maintains per-user counts and sends `card-counts` on:
- Initial connect (after discovery)
- Any `card-set-state` change
- New session appears / session ends

---

## Browser Changes (dashboard.mjs)

### CARDS Sub-Panel

- Triggered by `CARDS >` menu item
- Sends `card-list-all` to server on open
- Renders session list grouped by state (displayed → paused → hidden)
- Each row: status icon, name, owner, age, action buttons
- Toggle buttons for auto-show preferences
- Clicking a button sends `card-set-state` message

### State Change Handling

On receiving `card-set-state` response:
- `unsubscribed`: call existing `removeTerminal()` flow (remove DOM, thumbnail, CSS3DObject)
- `paused`: apply same visual as thumbnail pause (overlay, stop data) but mark as `_stickyPaused`
- `subscribed`: if card doesn't exist, server sends `session-add` + screen data; if exists (was paused), resume

### Orange Badge

- New DOM element in top bar: `<span id="hidden-cards-badge">` 
- Styled: orange background, white text, visible when count > 0
- Updated on `card-counts` message
- Text: `YOU HAVE N HIDDEN CARDS`
- Click opens CARDS sub-panel **directly** (not hamburger menu first)

### Status Bar Counts

- New element in bottom status bar
- Text: `X available / Y displayed / Z paused`
- Updated on `card-counts` message
- Click opens CARDS sub-panel **directly** (not hamburger menu first)

### Thumbnail Pause Interaction

Unchanged. Thumbnail ⏸ sets `t._muted = true` (temporary). Does not write to server. Resets on reload. The `_stickyPaused` flag (from CARDS menu) is separate and persists.

---

## Session Lifecycle

### On page load:
1. Browser connects WS
2. Server runs `sendSessionDiscovery()`:
   - Queries `card_subscriptions` for user
   - Sends `session-add` for subscribed sessions
   - Sends `session-add` with `paused: true` for sticky-paused sessions
   - Skips unsubscribed sessions
3. Server sends `card-counts` with available/displayed/paused

### On new session created (server event):
1. Check `card_preferences` for connected users
2. For each user: if auto-show criteria met → send `session-add`, else increment hidden count
3. Send updated `card-counts` to affected browsers

### On session ended (server event):
1. Send `session-remove` to subscribed browsers
2. Remove `card_subscriptions` row (session no longer exists)
3. Send updated `card-counts`

### On user opens CARDS panel:
1. Browser sends `card-list-all`
2. Server returns full list (all sessions user can see) with current state
3. Browser renders list

### On user changes subscription state:
1. Browser sends `card-set-state { session, state }`
2. Server updates `card_subscriptions`
3. Server acts on state change (subscribe/pause/unsubscribe watcher)
4. Server sends `card-counts` update
5. Browser updates UI (add/remove/pause card)

---

## Edge Cases

- **Session ends while unsubscribed**: Server cleans up `card_subscriptions` row. No browser notification needed.
- **New session while CARDS panel is open**: Panel should update (server sends `card-counts`, browser can re-request `card-list-all`).
- **Multiple browser tabs**: Each tab has its own WS. State changes via one tab are persisted server-side. Other tabs get `card-counts` updates but don't auto-sync the full list until they open the CARDS panel.
- **User has no `card_preferences` row**: Defaults to `auto_show_new = 1, auto_show_own = 1` (current behavior).
- **User has no `card_subscriptions` rows**: All sessions default to subscribed (current behavior).

---

## What Stays Unchanged

- Thumbnail ⏸ button behavior (temporary, non-persistent)
- Session discovery via claude-proxy `listSessions`
- WebSocket subscribe/unsubscribe messages (used internally, not exposed to subscription manager)
- Card DOM creation/removal flow (reused by subscription manager)
- All existing layout, focus, Max All functionality
