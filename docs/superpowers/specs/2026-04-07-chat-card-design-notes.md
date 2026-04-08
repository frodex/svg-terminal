# Chat Console Card — Design Notes
**Date:** 2026-04-07
**Status:** Phase 1 complete
**Preceding:** none

---

## Concept

A shared chat room as a terminal card. Multiple dashboard users can read and write to the same session. Uses the existing compose bar for input.

## Phase 1 — Launch Profile Only (DONE)

Added `chat` as a new `launchProfile` in claude-proxy. The session runs `stty -echo && exec cat` inside tmux via `/bin/bash -c`. Direct keystrokes don't echo (intentional — compose is the input method).

### Changes made

1. **claude-proxy `launch-profiles.ts`** — added `'chat'` profile: command `/bin/bash`, args `['-c', "'stty -echo && exec cat'"]`, `useLauncher: false`, no capabilities
2. **svg-terminal `server.mjs`** — added `'chat'` to `allowedProfiles` set in `buildCreateSessionPayload()`
3. **svg-terminal `index.html`** — added "New chat room [h]" radio button to session kind picker

### Gotchas found

- **Server whitelist:** `buildCreateSessionPayload()` had a hardcoded `allowedProfiles` set. Profiles not in the set silently defaulted to `'claude'`. Had to add `'chat'` explicitly.
- **Double echo:** `/bin/cat` in a PTY gets terminal echo + cat echo. Fixed with `stty -echo` so only cat's echo appears.
- **Direct keystrokes:** Don't produce visible output (canonical mode + no echo). Compose sends via `tmux send-keys` which works correctly. This is desirable — compose is the intended input path.

### What works

- "Session kind" form shows Chat as an option
- Creates a tmux session running `cat` with echo disabled
- Compose bar sends text, `cat` echoes it once
- All connected clients see the output via normal screen update path
- Scrollback = tmux buffer
- Card looks and behaves identically to a terminal card

## Design Decisions

- **`launchProfile` is the type system** — no naming conventions. Session name is whatever the user picks (`cp-<name>`), `launchProfile: 'chat'` identifies chat sessions.
- **Server is identity authority** — client-side identity wrapping rejected (spoofable). Phase 2 adds server-side wrapping.
- **`cat` is the chat process** — simplest possible. tmux scrollback is the message history.
- **Compose is the input method** — direct keystroke input doesn't work by design.

## Phase 2 — Server Identity Wrapping (future)

- Server checks `launchProfile === 'chat'` on input
- Prepends `HH:MM:SS/display_name: ` before forwarding to tmux
- Dashboard stores `launchProfile` on terminal object
- Blocks raw keystroke input for chat sessions explicitly

## Phase 3 — Visual Polish (future)

- Per-user ANSI colors
- Chat icon on thumbnail/header
- Dedicated input field on chat card
- Multi-line message handling
- Read-only terminal flag (no direct keystrokes)
