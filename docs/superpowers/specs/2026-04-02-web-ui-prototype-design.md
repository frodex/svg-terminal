# Web UI Prototype — Design Spec

**Date:** 2026-04-02
**Status:** Approved
**Goal:** Self-contained single-file HTML prototype of the claude-proxy web UI, covering OAuth login and all session management screens. Opens in any browser with no backend required.

---

## 1. Overview

A clickable prototype at `/srv/svg-terminal/ui-web/prototype.html` that demonstrates the full web UI for claude-proxy. All 10 screens are `<div>` sections shown/hidden via a `showScreen()` JS router. Mock data is hardcoded. Visual style matches the existing dark theme (`#1a1a2e`/`#16213e` palette, system fonts, rounded cards).

**Not included:** The live session terminal view — that already exists at the svg-terminal dashboard (`:3200`).

---

## 2. Screens

### Auth Flow
1. **Login** — OAuth provider buttons (Google, GitHub, Microsoft). Centered card.
2. **Pending** — "Access Requested" waiting room. Hourglass icon, email display, check-status button.
3. **Admin** — User management. Pending requests table, pre-approve textarea, all-users table with approval flags.

### Session Management
4. **Lobby** — Session list with badges ([locked], (private), [view-only], @owner, @remote). Action buttons: New, Restart, Fork, Export. Admin + Logout links.
5. **Session Form** — HTML form for create/edit/restart/fork modes. 12 fields from `session-form.yaml`. Conditional visibility (grayed/disabled when condition not met). Locked fields show lock icon. Mode switcher for demo purposes.
6. **Restart Picker** — List of dead sessions with dates. Deep Scan button.
7. **Fork Picker** — List of active sessions. Disabled if no Claude session ID.
8. **Export Picker** — Checkbox multi-select. Date, size, first message. Select All button.
9. **Password Prompt** — Modal overlay for locked sessions.
10. **Help Menu** — Hotkey reference card listing Ctrl+B commands with descriptions.

---

## 3. Visual Style

Matches existing `login.html`/`admin.html`/`pending.html`:
- Background: `#1a1a2e`
- Card/section: `#16213e`, `border-radius: 8-12px`
- Text: `#e0e0e0` body, `#fff` headings, `#999`/`#767676` secondary
- Primary action: `#4285f4` (blue)
- Approve: `#2d6a4f` (green)
- Deny/danger: `#6a2d2d` (red)
- Badges: yellow `#d7d700` for [locked], cyan `#00cdcd` for remote hosts/messages
- Font: `system-ui, sans-serif`
- Form inputs: `#16213e` background, `#333` border, `#4285f4` border when focused

---

## 4. Navigation

```
Login → [mock OAuth] → Lobby (or Pending for "new user" demo)
Pending → [check status] → Lobby
Lobby → New Session → Session Form (create) → Lobby
Lobby → Restart → Restart Picker → Session Form (restart) → Lobby
Lobby → Fork → Fork Picker → Session Form (fork) → Lobby
Lobby → Export → Export Picker → Lobby
Lobby → [click locked session] → Password Prompt → Lobby
Lobby → Admin link → Admin
Lobby → Help → Help Menu → Lobby
Any screen → back/cancel → previous screen
```

---

## 5. Mock Data

Hardcoded in JS:
- 3 active sessions with varied badges
- 3 dead sessions for restart picker
- 3 exportable sessions with dates/sizes
- 5 users (2 pending, 3 approved) for admin
- User groups: `cp-users`, `cp-admins`

---

## 6. Session Form Field States

Maps the YAML field definitions to HTML form behavior:

| Field | Widget | Create | Edit | Restart | Fork |
|-------|--------|--------|------|---------|------|
| name | text input | editable | editable, prefilled | editable, prefilled | prefilled as "X-fork_01" |
| runas | text input | editable (admin) | locked, prefilled | locked, prefilled | locked, prefilled |
| server | select | editable (admin+remotes) | locked | locked | locked |
| workdir | text input | editable | locked | locked | editable, prefilled |
| hidden | checkbox | editable | editable, prefilled | editable, prefilled | editable, prefilled |
| viewonly | checkbox | editable | editable, prefilled | editable, prefilled | editable, prefilled |
| public | checkbox | editable | editable, prefilled | editable, prefilled | editable, prefilled |
| users | multi-select | editable (if private) | editable (if private) | editable (if private) | editable (if private) |
| groups | multi-select | editable (if private) | editable (if private) | editable (if private) | editable (if private) |
| password | password | editable | editable | editable | editable |
| dangermode | checkbox | editable (admin) | editable (admin) | editable (admin) | editable (admin) |
| claudeSessionId | text | hidden | editable | editable | locked, prefilled |

Conditions: `admin-only` fields shown as disabled with "(admin only)" label. `not-hidden` / `not-hidden-and-not-public` fields show "N/A" when condition not met.

---

## 7. File

Single file: `/srv/svg-terminal/ui-web/prototype.html`

Structure:
- `<style>` — all CSS
- `<div id="screen-*">` — one per screen, all hidden except active
- `<script>` — showScreen() router, mock data, form logic, modal handlers
