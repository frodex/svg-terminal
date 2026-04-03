# PRD Amendment 005 — User Identity Flow and Title Updates for Browser Sessions

**Date:** 2026-04-02
**Status:** Planned
**Relates to:** PRD §3.4 (WebSocket), claude-proxy session-manager, api-server
**Discovered during:** Layout system design session (SESSION-001 / 206fe1ef)

---

## 1. Problem

Terminal card titles don't update typing indicators or idle timers when users type through svg-terminal's browser UI. Titles DO update when typing directly in bash (SSH to tmux). The title format is `"SESSION NAME | *user1, user2 | idle_time"` and should show who is typing and how long since last activity.

---

## 2. Root Cause

### Two Input Paths, Only One Updates Titles

**Direct SSH/bash input (works):**
```
SSH client → claude-proxy session-manager.ts → onPassthrough():
  1. client.lastKeystroke = Date.now()
  2. session.statusBar.recordKeystroke(client.username)
  3. session.pty.write(data)
  4. this.updateTitle(sessionId)  ← immediately recomposes title with typing indicator
```

**svg-terminal browser input (broken):**
```
Browser → dashboard.mjs WebSocket → server.mjs → forward to claude-proxy api-server.ts:
  1. session.pty.write(Buffer.from(bytes))
  ← That's it. No keystroke recording, no title update, no user identity.
```

### Three Specific Gaps

1. **No `statusBar.recordKeystroke()` call** in api-server.ts input handler — typing indicator never activates for WebSocket input
2. **No user identity** in the forwarded message — svg-terminal strips session/pane but doesn't add the authenticated user
3. **`composeTitle()` in api-server.ts doesn't include typing state** — even if keystroke were recorded, the API's title builder doesn't check `statusBar.isTyping()`

---

## 3. Current Auth Chain

svg-terminal already authenticates browser users:

```
Browser → OIDC login → session cookie → getAuthUser(req) returns:
  { email, display_name, linux_user, status, can_approve_users, ... }
```

The user object is available at WebSocket connection time (`handleDashboardWs`, line 636) but is NOT stored on the connection or forwarded with input messages.

When auth is disabled (development), `getAuthUser` returns:
```js
{ email: 'root@localhost', status: 'approved', linux_user: 'root', display_name: 'Development' }
```

---

## 4. Fix Plan

### 4.1 svg-terminal: Attach User to WebSocket Connection

**File:** `server.mjs`, `handleDashboardWs()` (~line 634)

Store the authenticated user on the WebSocket connection object so it's available when forwarding input:

```js
async function handleDashboardWs(ws, req) {
  const user = getAuthUser(req);
  // ... existing auth check ...
  ws._user = user;  // store for input forwarding
  dashboardClients.add(ws);
```

### 4.2 svg-terminal: Include User in Forwarded Input

**File:** `server.mjs`, input forwarding (~line 698)

When forwarding input to claude-proxy, include the user identity:

```js
if (cpUpstream && cpUpstream.readyState === 1) {
  const fwd = { ...msg };
  delete fwd.session;
  delete fwd.pane;
  // Include user identity so claude-proxy can update typing indicators
  if (ws._user) {
    fwd.user = ws._user.display_name || ws._user.linux_user || ws._user.email;
  }
  cpUpstream.send(JSON.stringify(fwd));
  return;
}
```

### 4.3 claude-proxy: Record Keystrokes from Stream Input

**File:** `/srv/claude-proxy/src/api-server.ts`, WebSocket input handler (~line 808)

After writing to PTY, record the keystroke for typing indicators:

```typescript
if (msg.type === 'input') {
  // ... existing key translation ...
  session.pty.write(Buffer.from(bytes));
  // Record keystroke for typing indicator and idle timer
  const username = msg.user || 'web';
  session.statusBar.recordKeystroke(username);
}
```

### 4.4 claude-proxy: Update composeTitle to Include Typing State

**File:** `/srv/claude-proxy/src/api-server.ts`, `composeTitle()` (~line 21)

Match the session-manager's title format by including typing indicators:

```typescript
function composeTitle(session: Session): string {
  // ... existing user list ...
  // Add typing indicator (match session-manager.ts behavior)
  const typingUsers = users.filter(u => session.statusBar.isTyping(u.username));
  // Include typing emoji or indicator in title
  // ...
}
```

### 4.5 Future: UGO Permissions for Browser Sessions

The user identity flow established here is the foundation for UGO (User/Group/Other) permissions on browser sessions. Once claude-proxy knows who is connected via the browser:

- Session visibility can be restricted by user/group
- Input permissions can be controlled (read-only viewers vs active users)
- The web UI user list matches the SSH user list

This is out of scope for this amendment but enabled by it.

---

## 5. Testing

1. **With auth disabled:** Input from svg-terminal should show `Development` (or `root`) as the typing user in titles
2. **With auth enabled:** Input should show the authenticated user's display name
3. **Multiple browser users:** Each should show their own identity in the typing indicator
4. **Idle timer:** Should reset when typing through svg-terminal, not just through SSH
5. **Co-browser:** One user typing should show up in all connected browsers' title displays

---

## 6. Files to Modify

| File | Project | Changes |
|---|---|---|
| `server.mjs` | svg-terminal | Store `_user` on WebSocket, include `user` field in forwarded input messages |
| `api-server.ts` | claude-proxy | Record keystrokes from stream input, update `composeTitle()` to include typing state |

### Dependencies

- svg-terminal auth system (already working)
- claude-proxy `statusBar.recordKeystroke()` API (already exists, used by session-manager)
- claude-proxy `statusBar.isTyping()` API (already exists, used by session-manager's updateTitle)

No new APIs needed — the pieces exist, they just need to be connected.

---

## 7. Risk

**Low.** The fix connects existing systems:
- svg-terminal already has the user identity
- claude-proxy already has the typing indicator system
- The only new data is a `user` field on input messages

**Co-browser impact:** None — the fix adds information to the title that was previously missing. No existing behavior changes.
