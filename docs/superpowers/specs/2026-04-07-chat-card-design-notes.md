# Chat Console Card — Design Notes
**Date:** 2026-04-07
**Status:** Pre-brainstorm notes (continue in next session)

---

## Concept

A shared chat room as a terminal card. Multiple dashboard users can read and write to the same tmux session. Messages are timestamped and tagged with user identity.

## Architecture (simple version)

- `tmux new-session -d -s cp-chat ./chat.sh` — server creates on startup if not exists
- `chat.sh` — script running in tmux that reads stdin and formats output
- Appears in sidebar like any other card, auto-subscribed for all users
- Uses existing `sendInput` path for user input
- Server prepends user identity to input before forwarding to tmux

## Key Design Questions for Next Session

### 1. Input path — unify with compose
- Compose mode already handles: text editing, Enter/Shift+Enter, history
- Chat input should reuse compose — "attach" compose to the chat card
- When compose is attached to chat card, Enter sends `TIMESTAMP/USER: text\n` not raw keys
- Need a way for `composeSend()` to detect card type and format accordingly
- Or: the server-side handles formatting (composeSend sends raw, server prepends identity)
- **Recommendation:** Server-side formatting — compose stays dumb, server adds identity for chat sessions

### 2. User identity
- Server knows who's connected via `getAuthUser(req)` — has email, linux_user, display_name
- When input arrives for the chat session, server wraps: `HH:MM:SS/display_name: <text>\n`
- Regular terminal cards: input passes through raw (current behavior)
- Chat cards: input gets identity-wrapped before `tmux send-keys`

### 3. Card type detection
- How does the server know "cp-chat" is a chat session, not a regular terminal?
- Options:
  - A: Naming convention (`cp-chat-*` prefix)
  - B: Session metadata flag in claude-proxy
  - C: Server config / hardcoded list
  - D: New `card_type` column in card_subscriptions table
- **Recommendation:** A (naming convention) — simplest, no schema changes

### 4. chat.sh script
```bash
#!/bin/bash
# Minimal chat server — runs inside tmux
# Input comes pre-formatted from the server (TIMESTAMP/USER: message)
# This script just cats stdin to stdout (tmux handles the display)
exec cat
```
Actually even simpler — no script needed. Server sends pre-formatted text via `tmux send-keys`. The tmux session just runs `bash` or `cat`. The output IS the chat log because tmux's scrollback buffer preserves it.

### 5. Discovery and auto-join
- Chat sessions should be visible to all users by default
- Maybe a "CHAT" section in the sidebar (above or below terminal cards)
- Or: just another card in the ring, but with a chat icon on the thumbnail
- Auto-subscribe on first visit, persist subscription state like other cards

### 6. Multiple chat rooms
- `cp-chat-general`, `cp-chat-devops`, etc.
- Created by admins via the admin panel or a new "Create chat room" action
- Each is a separate tmux session

### 7. Read-only scrollback
- tmux scrollback buffer = chat history
- Users can scroll back to read older messages
- Existing scroll mechanism works (PgUp/PgDn, mouse wheel)

## What to reuse
- `createCardDOM()` factory (existing)
- `sendInput` / `composeSend` path (existing, server adds formatting)
- Card subscription system (existing — subscribe/pause/unsubscribe)
- Thumbnail with play/pause/stop buttons (existing)
- Compose mode text editor (existing)

## What's new
- Server-side: detect chat sessions, wrap input with identity/timestamp
- Server-side: create chat tmux session on startup
- Dashboard: optional visual distinction for chat cards (icon, color)
- Dashboard: compose knows it's attached to a chat card (for UX hints)

## Implementation estimate
- Server: ~30 lines (create tmux session, identity wrapping in input handler)
- Dashboard: ~10 lines (card type detection for visual distinction)
- chat.sh: 0 lines (just `cat` or bare `bash`)
