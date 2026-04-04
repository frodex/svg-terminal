# claude-proxy ANSI Terminal UI — Complete Screen Reference

This document describes every screen, widget, and visual element rendered by the claude-proxy TUI. All rendering is done with raw ANSI escape codes — no external TUI library is used.

Source: `/srv/claude-proxy/src/`

---

## Table of Contents

1. [Lobby Screen](#1-lobby-screen)
2. [Session Form (Create / Edit / Restart / Fork)](#2-session-form)
3. [Restart Picker](#3-restart-picker)
4. [Fork Picker](#4-fork-picker)
5. [Export Picker](#5-export-picker)
6. [Password Prompt](#6-password-prompt)
7. [Session Terminal View](#7-session-terminal-view)
8. [Help Menu](#8-help-menu)
9. [Scrollback Viewer](#9-scrollback-viewer)
10. [Widget Reference](#10-widget-reference)
11. [ANSI Primitives](#11-ansi-primitives)
12. [Color Scheme & Field States](#12-color-scheme--field-states)
13. [Key Input System](#13-key-input-system)
14. [Screen Renderer (WebSocket JSON)](#14-screen-renderer-websocket-json)

---

## 1. Lobby Screen

**Source:** `lobby.ts`, `interactive-menu.ts`

The main landing screen after SSH connection. Uses the generic `renderMenu()` renderer.

### Layout

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  claude-proxy                                            │
│  ──────────────────────────────────── (gray ─×40)        │
│                                                          │
│  Active Sessions                                         │
│                                                          │
│  > [1] my-session [locked] (2 users) [alice, bob]        │
│    [2] other-session (private) @owner (1 user) [owner]   │
│                                                          │
│    [n] New session                                       │
│    [r] Restart previous session                          │
│    [f] Fork a session                                    │
│    [e] Export sessions                                   │
│    [q] Quit                                              │
│                                                          │
│  ──────────────────────────────────── (gray ─×40)        │
│  MOTD text here | Connected as: username | tab to refresh│
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Elements

| Element | Style | Description |
|---------|-------|-------------|
| Title `claude-proxy` | `\x1b[1m` (bold) | Top-left, 2 spaces indent |
| Separator | `\x1b[38;5;245m` (gray) `─` ×40 | Below title and above footer |
| Section title `Active Sessions` | `\x1b[1m` (bold) | Only shown when sessions exist |
| No sessions message | `\x1b[38;5;245m` (gray) | `No active sessions` when empty |
| Cursor arrow `>` | `\x1b[33m` (yellow) | Points to selected item |
| Shortcut key `[n]` | `\x1b[33m` (yellow) | Before each action label |
| Selected item label | `\x1b[1m` (bold) | Current cursor item is bold |
| Footer | `\x1b[38;5;245m` (gray) | MOTD + username + hint |

### Session Item Decorations

```typescript
// From lobby.ts:buildSections()
const lock = s.access?.passwordHash ? ' [locked]' : '';
const vis = s.access?.public === false ? ' (private)' : '';
const vo = s.access?.viewOnly ? ' [view-only]' : '';
const owner = s.access?.owner ? ` \x1b[38;5;245m@${s.access.owner}\x1b[0m` : '';
const host = s.remoteHost ? ` \x1b[36m@${s.remoteHost}\x1b[0m` : '';
// => "session-name [locked] (private) [view-only] @owner @remote (2 users) [alice, bob]"
```

- **Owner** `@username` — gray (`38;5;245`)
- **Remote host** `@hostname` — cyan (`36`)
- **User count** — plain text `(N users)`
- **User names** — plain text `[alice, bob]`

### Navigation

```typescript
// From lobby.ts:handleInput()
// Arrow Up/Down — move cursor (wrapping, skips disabled)
// Enter / Space — select current item
// Shortcut keys (1-9, n, r, f, e, q) — direct select
// Tab — refresh lobby
```

### Rendering Function

```typescript
// interactive-menu.ts:renderMenu()
export function renderMenu(options: MenuOptions): string {
  // 1. Clear screen + home: '\x1b[2J\x1b[H'
  // 2. Title (bold)
  // 3. Gray separator ─×40
  // 4. For each section:
  //    - Section title (bold) if present, else blank line
  //    - For each item:
  //      - Disabled: 6-space indent, gray label
  //      - Normal: 2-space indent, arrow/space, [key] (yellow), label (bold if current), hint (gray)
  // 5. Footer separator + gray footer text
}
```

---

## 2. Session Form

**Source:** `session-form.ts`, `session-form.yaml`, `widgets/flow-engine.ts`, `widgets/renderers.ts`

A multi-field form used for **Create**, **Edit**, **Restart**, and **Fork** modes. Fields are defined in YAML and rendered by the FlowEngine.

### Layout (Navigate Mode)

```
┌──────────────────────────────────────────────────────────┐
│  New Session                                             │
│  ────────────────────────────────────────────── (─×50)   │
│                                                          │
│> Session name: [enter to edit]                           │
│  Run as user: root [LOCKED]                              │
│  Server: --- (grayed)                                    │
│  Working directory: ~ (home directory)                   │
│  Hidden session?: No ✓                                   │
│  View-only?: No ✓                                        │
│  Public session?: Yes ✓                                  │
│  Allowed users: --- (grayed)                             │
│  Allowed groups: --- (grayed)                            │
│  Password:                                               │
│  Skip permissions?: ---  (grayed)                        │
│  Claude session ID: (not visible in create)              │
│                                                          │
│  ↑↓=navigate, enter=edit, s=submit, esc=cancel           │
└──────────────────────────────────────────────────────────┘
```

### Layout (Editing a Field)

```
┌──────────────────────────────────────────────────────────┐
│  New Session                                             │
│  ──────────────────────────────────────────────          │
│                                                          │
│> Session name: my-project█                               │
│  Run as user: root [LOCKED]                              │
│  ...                                                     │
│                                                          │
│  ↑↓=navigate, enter=edit, s=submit, esc=cancel           │
└──────────────────────────────────────────────────────────┘
```

### Field States

```typescript
// widgets/keys.ts
export type WidgetFieldState = 'active' | 'editing' | 'completed' | 'locked' | 'grayed' | 'pending';

export const STATE_COLORS: Record<WidgetFieldState, string> = {
  active:    '\x1b[33m',       // yellow — field nav cursor is here
  editing:   '\x1b[1m',        // bold white — widget is open for input
  completed: '\x1b[32m',      // green — field has a value
  locked:    '\x1b[33;2m',    // yellow dim — read-only
  grayed:    '\x1b[38;5;245m', // dark gray — condition not met
  pending:   '\x1b[2m',        // dim white — not yet visited
};
```

| State | Prefix | Label Color | Value Display | Suffix |
|-------|--------|-------------|---------------|--------|
| `active` | `>` (yellow) | yellow | `[enter to edit]` (dim) | — |
| `editing` | `>` (yellow) | bold | inline widget rendered | — |
| `completed` | ` ` (2 spaces) | green | green value text | `✓` |
| `locked` | `>` or ` ` | yellow dim | value text | `[LOCKED]` (red) |
| `grayed` | ` ` (2 spaces) | gray | `---` | — |
| `pending` | ` ` (2 spaces) | dim | dim value or `[default]` | — |
| `invalid` | — | red (`\x1b[31m`) | — | (missing required) |

### Form Rendering

```typescript
// widgets/renderers.ts:renderFlowForm()
export function renderFlowForm(
  title: string,
  summary: FlowStepSummary[],
  activeWidget: any,
  activeStepId: string,
  invalidIndices?: number[],
): string {
  // 1. Clear screen: '\x1b[2J\x1b[H'
  // 2. Title (bold, 2-space indent)
  // 3. Gray separator ─×50
  // 4. For each field summary:
  //    - editing: yellow >, label:, inline widget render
  //      - ComboInput picker items expanded below when in picker mode
  //    - active: yellow >, label:, value or [enter to edit] dim
  //    - completed: 2-space, green label: value ✓
  //    - grayed: 2-space, gray label: ---
  //    - locked: arrow or space, yellow-dim label: value [LOCKED] red
  //    - pending: 2-space, dim label: dim value or [default]
  // 5. Gray hint line: ↑↓=navigate, enter=edit, s=submit, esc=cancel
}
```

### Inline Widget Rendering

```typescript
// widgets/renderers.ts:renderInlineWidget()
// TextInput:    buffer text + inverse-space cursor block + clear-to-eol
// YesNoPrompt:  [Y/n] or [y/N] (capital = default, bold)
// ListPicker:   [selected item label] ↑↓
// ComboInput:
//   text mode:  buffer + inverse cursor block
//   picker mode: [selected item] ↑↓ (+ expanded list below the field)
```

### ComboInput Expanded Picker (inside form)

When a ComboInput field is in editing/picker mode, the picker items are expanded below the field:

```
> Working directory: [~/projects] ↑↓
    > ~/projects                          (bold, yellow arrow)
      ~/documents                         (gray)
      ~/src                               (gray)
  ↑↓=select, enter=choose, type=freehand
```

### YAML Field Definitions

```yaml
# session-form.yaml — 12 fields total
fields:
  - id: name           # widget: text,         required: true
  - id: runas          # widget: text,         condition: admin-only
  - id: server         # widget: list,         condition: admin-with-remotes
  - id: workdir        # widget: combo
  - id: hidden         # widget: yesno,        default: false
  - id: viewonly       # widget: yesno,        default: false
  - id: public         # widget: yesno,        default: true,  condition: not-hidden
  - id: users          # widget: checkbox,     condition: not-hidden-and-not-public
  - id: groups         # widget: checkbox,     condition: not-hidden-and-not-public
  - id: password       # widget: text-masked
  - id: dangermode     # widget: yesno,        default: false, condition: admin-only
  - id: claudeSessionId # widget: text         (not visible in create mode)
```

### Per-Mode Field Behavior

Each field has per-mode config (`create`, `edit`, `restart`, `fork`):

```yaml
# Example — name field:
modes:
  create:  { visible: true, locked: false }
  edit:    { visible: true, locked: false, prefill: true }
  restart: { visible: true, locked: false, prefill: true }
  fork:    { visible: true, locked: false, prefill: fork-name }
```

- `visible: false` — field not shown
- `locked: true` — field shown but read-only (Enter skips forward)
- `prefill: true` — pre-populate from existing session data
- `prefill: fork-name` — auto-generate fork name: `"session-name-fork_01"`

### Condition Predicates

```typescript
// session-form.ts
const PREDICATES: Record<string, Predicate> = {
  'admin-only':               (acc) => acc._isAdmin === true,
  'admin-with-remotes':       (acc) => acc._isAdmin === true && acc._hasRemotes === true,
  'not-hidden':               (acc) => !acc.hidden,
  'not-hidden-and-not-public': (acc) => !acc.hidden && !acc.public,
};
```

### FlowEngine Modes

```typescript
// widgets/flow-engine.ts
// 'legacy'   — linear progression, auto-advance after each field
// 'navigate' — arrow keys move cursor between fields, Enter to edit
// 'edit'     — currently editing a field's widget
```

- **Legacy mode:** Steps auto-advance. Used for initial linear walkthrough.
- **Navigate mode:** Free cursor movement. Press `s` to submit, `Enter` to edit current.
- **Edit mode:** Widget receives keystrokes. Submit/cancel returns to navigate mode.

```typescript
// Navigate mode key handling:
// Up/Down  — move cursor (skip grayed, don't skip locked)
// Enter    — open widget for editing (or skip if locked)
// s/S      — submit form (validates required fields)
// Esc/CtrlC — cancel form
```

---

## 3. Restart Picker

**Source:** `index.ts:startResumeFlow()`

A ListPicker screen showing previous (dead) sessions that can be restarted.

### Layout

```
┌──────────────────────────────────────────────────────────┐
│ Restart previous session:                                │
│                                                          │
│ > 1. my-session 3/28/2026 02:15 PM @greg                │
│   2. resume-abc123 [view-only] 3/27/2026 11:30 AM @greg │
│   D. Deep scan — browse all past Claude sessions         │
│                                                          │
│   arrows to select, enter to restart, D=deep scan,       │
│   esc to cancel                                          │
└──────────────────────────────────────────────────────────┘
```

### Elements

| Element | Style |
|---------|-------|
| Title | Bold |
| Session items | Numbered `1. name date @owner` |
| `resume-*` named sessions | Gray name (`38;5;245`), rest normal |
| `[view-only]` badge | Plain text |
| Date + owner | Gray (`38;5;245`) |
| Deep scan option | Cyan (`36`) |
| Current cursor | Yellow `>` arrow, bold label |
| Hint | Gray (`38;5;245`) |

### Item Construction

```typescript
// index.ts:startResumeFlow()
const items = dead.map((s, i) => {
  const date = new Date(s.createdAt);
  const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString(
    [], { hour: '2-digit', minute: '2-digit' }
  );
  const owner = s.access?.owner || s.runAsUser;
  const displayName = s.name.startsWith('resume-')
    ? `\x1b[38;5;245m${s.name}\x1b[0m`
    : s.name;
  const vis = s.access?.viewOnly ? ' [view-only]' : '';
  return {
    label: `${i + 1}. ${displayName}${vis} \x1b[38;5;245m${dateStr} @${owner}\x1b[0m`
  };
});
items.push({ label: '\x1b[36mD. Deep scan — browse all past Claude sessions\x1b[0m' });
```

### Navigation

```
Arrow Up/Down — move cursor
Enter         — select: opens SessionForm in restart mode (or deep scan)
D/d           — deep scan shortcut
Esc/q         — cancel, return to lobby
```

---

## 4. Fork Picker

**Source:** `index.ts:startForkFromLobby()`

A ListPicker screen showing active sessions that can be forked (branched).

### Layout

```
┌──────────────────────────────────────────────────────────┐
│ Select session to fork                                   │
│                                                          │
│ > my-session                                             │
│   other-session (no session ID)                          │
│   Cancel                                                 │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Elements

| Element | Style |
|---------|-------|
| Title | Bold |
| Forkable sessions | Normal label |
| Sessions without Claude ID | `(no session ID)`, disabled (gray, not selectable) |
| Cancel option | Always last, selectable |
| Current cursor | Yellow `>` arrow, bold label |

### Item Construction

```typescript
// index.ts:startForkFromLobby()
const items = sessions.map(s => {
  const meta = loadSessionMeta(s.id);
  const hasClaudeId = !!meta?.claudeSessionId;
  return {
    label: `${s.name}${hasClaudeId ? '' : ' (no session ID)'}`,
    disabled: !hasClaudeId,
  };
});
items.push({ label: 'Cancel', disabled: false });
```

---

## 5. Export Picker

**Source:** `index.ts:startExportFlow()`

A CheckboxPicker screen for selecting past JSONL sessions to export as a zip.

### Layout

```
┌──────────────────────────────────────────────────────────┐
│ Export sessions                                          │
│ space=toggle, a=select all, enter=export selected,       │
│ esc=cancel                                               │
│                                                          │
│ > [x] 3/28/2026 02:15 PM 45KB first user message...     │
│   [ ] 3/27/2026 11:30 AM 1.2MB another message here     │
│   [ ] 3/26/2026 09:00 AM 120KB (no message)             │
│                                                          │
│   space=toggle, enter=done, esc=cancel                   │
└──────────────────────────────────────────────────────────┘
```

### Elements

| Element | Style |
|---------|-------|
| Title | Bold |
| Hint | Gray (`38;5;245`) |
| Checkbox selected `[x]` | Green (`32`) |
| Checkbox unselected `[ ]` | Plain |
| Cursor arrow `>` | Yellow (`33`) |
| First message text | Cyan (`36`) |
| `(no message)` | Gray (`38;5;245`) |
| Date | Plain |
| Size | Plain (`45KB` or `1.2MB`) |

### Item Construction

```typescript
// index.ts:startExportFlow()
const items = sessions.map(s => {
  const date = s.date
    ? s.date.toLocaleDateString() + ' ' +
      s.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  const size = s.sizeBytes
    ? (s.sizeBytes > 1048576
      ? `${(s.sizeBytes / 1048576).toFixed(1)}MB`
      : `${Math.round(s.sizeBytes / 1024)}KB`)
    : '';
  const msg = s.firstMessage
    ? `\x1b[36m${s.firstMessage}\x1b[0m`
    : `\x1b[38;5;245m(no message)\x1b[0m`;
  return { label: `${date} ${size} ${msg}` };
});
```

### Extra Navigation

```
a/A           — toggle all on/off (custom, not in CheckboxPicker)
Space         — toggle current item
Enter         — export selected
Esc           — cancel
Arrow Up/Down — navigate
```

### Export Result Screen

After export completes:

```
  Exporting 3 session(s)...
  Exported to: /tmp/claude-export-abc12345.zip

  To download:
  scp server:/tmp/claude-export-abc12345.zip .

  To install on another machine:
  unzip claude-export-*.zip && ./install.sh     (cyan)

  Press any key to return to lobby...
```

### Empty State

```
  No sessions found to export.

  Press any key...
```

---

## 6. Password Prompt

**Source:** `index.ts` (inline, no separate component)

A simple inline password entry for joining locked sessions.

### Layout

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  Password: ****                                          │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Behavior

```typescript
// index.ts password flow
// Each character typed: append to buffer, echo '*'
// Backspace: remove last char, write '\b \b'
// Enter: validate hash against session passwordHash
//   Match    → join session
//   No match → "Wrong password." then return to lobby after 1s
// Esc/Ctrl+C → cancel, return to lobby
```

No widget class is used — this is raw inline input handling:

```typescript
pf.buffer += str;
client.write('*');  // echo mask character
```

---

## 7. Session Terminal View

**Source:** `status-bar.ts`, `session-manager.ts`, `hotkey.ts`

The main view when connected to an active session. Shows live PTY output with a 2-row status bar at the bottom.

### Layout

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  (live terminal PTY output — scroll region)              │
│  $ claude                                                │
│  Claude is thinking...                                   │
│  ...                                                     │
│                                                          │
│──────────────────────────────────────────────────────────│
│ my-session │ [alice] bob charlie                          │ ← status line 1
│                ⌨  alice, bob                             │ ← status line 2
└──────────────────────────────────────────────────────────┘
```

### Status Bar (2 rows)

**Source:** `status-bar.ts`

**Line 1 — Session + Users:**

| Element | Style | Description |
|---------|-------|-------------|
| Session name | Cyan (`36`) | Left side |
| Separator | `│` | Between name and users |
| Size owner | `[username]` in brackets | The user controlling terminal size |
| Active typer names | Yellow (`33`) | Users who typed in last 2 seconds |
| Idle user names | Gray (`90`) | Users not currently typing |

**Line 2 — Typing Indicator:**

| Element | Style |
|---------|-------|
| Padding | Spaces (aligned under users) |
| Keyboard icon | `⌨` |
| Typing user names | Yellow (`33`), comma-separated |

### Status Bar Rendering

```typescript
// status-bar.ts:render()
// Line 1: color(sessionName, 36) + ' │ ' + userParts.join(' ')
//   userParts: each user name colored yellow (33) if typing, gray (90) if idle
//   size owner wrapped in [brackets]

// Line 2: only shown when someone is typing
//   padding + '⌨  ' + color(typers.join(', '), 33)
```

### Frame Composition

```typescript
// status-bar.ts:renderFrame()
// 1. Set scroll region: rows 1 to (clientRows - 2)
// 2. Move to (1,1), write PTY data into scroll region
// 3. Save cursor, hide cursor
// 4. Move to (clientRows-1, 1): clear line, write status line 1
// 5. Move to (clientRows, 1): clear line, write status line 2
// 6. Restore cursor, show cursor
```

The scroll region (`DECSTBM`) prevents PTY output from overwriting the status bar.

### Terminal Title (OSC)

```typescript
// session-manager.ts
const osc = `\x1b]0;[Ctrl-B h help] ${title}\x07`;
// title = "sessionName | user1, user2 | uptime"
```

### Hotkey System (Ctrl+B prefix)

**Source:** `hotkey.ts`

Tmux-style prefix key: `Ctrl+B` (0x02), then a command within 1 second.

| Sequence | Action | Description |
|----------|--------|-------------|
| `Ctrl+B d` | Detach | Return to lobby |
| `Ctrl+B s` | Claim size | Take terminal size ownership |
| `Ctrl+B h` | Help | Show help menu |
| `Ctrl+B ?` | Help | Alias for h |
| `Ctrl+B r` | Redraw | Force screen redraw |
| `Ctrl+B e` | Edit | Edit session settings (owner only) |
| `Ctrl+B b` | Scrollback | Open scrollback viewer |
| `Ctrl+B l` | Dump | Scrollback dump (terminal scrollbar) |
| `Ctrl+B Ctrl+B` | Passthrough | Send literal Ctrl+B to PTY |

```typescript
// hotkey.ts:feed()
// 1. First Ctrl+B sets prefixActive=true, starts 1s timeout
// 2. Next byte within timeout triggers command
// 3. Timeout expiration passes Ctrl+B through to PTY
// 4. Unknown command: passes prefix+data through to PTY
```

---

## 8. Help Menu

**Source:** `session-manager.ts`

Uses the same `renderMenu()` as the lobby. Shown when pressing `Ctrl+B h` or `Ctrl+B ?`.

### Layout

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  claude-proxy help                                       │
│  ────────────────────────────────────                    │
│                                                          │
│  Session actions                                         │
│                                                          │
│  > [esc] Back to session                                 │
│    [d] Detach (back to lobby)         Ctrl-B d           │
│    [s] Claim size ownership           Ctrl-B s           │
│    [r] Redraw screen                  Ctrl-B r           │
│    [l] Scrollback dump                Ctrl-B l — use...  │
│    [b] Scrollback viewer              Ctrl-B b — arr...  │
│    [e] Edit session settings          Ctrl-B e — own...  │
│    [f] Fork session                   Ctrl-B f — bra...  │
│                                                          │
│  Info                                                    │
│                                                          │
│      Title bar shows: session | *owner, users | uptime   │
│      Sessions persist across proxy restarts (tmux-backed)│
│                                                          │
│  ──────────────────────────────────── (gray ─×40)        │
│  arrows to navigate, enter/space to select, esc to return│
└──────────────────────────────────────────────────────────┘
```

### Menu Items

```typescript
// session-manager.ts:helpSections
[
  {
    title: 'Session actions',
    items: [
      { label: 'Back to session',       key: 'esc', action: 'back' },
      { label: 'Detach (back to lobby)', key: 'd', hint: 'Ctrl-B d',                         action: 'detach' },
      { label: 'Claim size ownership',  key: 's', hint: 'Ctrl-B s',                          action: 'claimSize' },
      { label: 'Redraw screen',         key: 'r', hint: 'Ctrl-B r',                          action: 'redraw' },
      { label: 'Scrollback dump',       key: 'l', hint: 'Ctrl-B l — use terminal scrollbar', action: 'scrolldump' },
      { label: 'Scrollback viewer',     key: 'b', hint: 'Ctrl-B b — arrows/pgup/pgdn',      action: 'scrollview' },
      { label: 'Edit session settings', key: 'e', hint: 'Ctrl-B e — owner only',             action: 'editSession' },
      { label: 'Fork session',          key: 'f', hint: 'Ctrl-B f — branch conversation',    action: 'forkSession' },
    ],
  },
  {
    title: 'Info',
    items: [
      { label: 'Title bar shows: session | *owner, users | uptime', action: 'none', disabled: true },
      { label: 'Sessions persist across proxy restarts (tmux-backed)', action: 'none', disabled: true },
    ],
  },
]
```

### Hint Styling

Hints appear after the label in gray (`38;5;245`):

```typescript
// interactive-menu.ts
const hint = item.hint ? ' ' + `\x1b[38;5;245m${item.hint}\x1b[0m` : '';
```

---

## 9. Scrollback Viewer

**Source:** `scrollback-viewer.ts`

A full-screen alternate-buffer viewer for browsing terminal scrollback history.

### Layout

```
┌──────────────────────────────────────────────────────────┐
│ (scrollback content line 1)                              │
│ (scrollback content line 2)                              │
│ ...                                                      │
│ (scrollback content line N)                              │
│──────────────────────────────────────────────────────────│
│ SCROLLBACK 85% | arrows/PgUp/PgDn scroll | g/G top/     │
│ bottom | q exit                                          │
└──────────────────────────────────────────────────────────┘
```

### Construction

```typescript
// scrollback-viewer.ts constructor
// 1. Parse content: split on \n (normalize \r\n and \r)
// 2. Set initial scroll to bottom: max(0, totalLines - viewRows)
// 3. Render into alternate screen buffer
```

### Rendering

```typescript
// scrollback-viewer.ts:render()
// 1. Enter alt screen: '\x1b[?1049h'
// 2. Hide cursor
// 3. For each viewport row:
//    - moveTo(row+1, 1), clearLine
//    - Write line content (preserves ANSI color codes)
//    - Reset colors: '\x1b[0m'
// 4. Status bar at bottom row:
//    - moveTo(rows, 1), clearLine
//    - Reverse-video (color code 7):
//      " SCROLLBACK 85% | arrows/PgUp/PgDn scroll | g/G top/bottom | q exit "
```

### Navigation

| Key | Action | Scroll Amount |
|-----|--------|---------------|
| `↑` / `k` | Scroll up | 3 lines |
| `↓` / `j` | Scroll down | 3 lines |
| `PgUp` / `u` | Page up | 1 full page |
| `PgDn` / `d` / `Space` | Page down | 1 full page |
| `g` / `Home` | Go to top | offset = 0 |
| `G` / `End` | Go to bottom | offset = max |
| Mouse wheel up | Scroll up | 5 lines |
| Mouse wheel down | Scroll down | 5 lines |
| `q` / `Q` / `Esc` | Exit viewer | Leave alt screen |

### Percentage Calculation

```typescript
const pct = this.lines.length > this.viewRows
  ? Math.round((this.scrollOffset / (this.lines.length - this.viewRows)) * 100)
  : 100;
```

---

## 10. Widget Reference

### 10.1 TextInput

**Source:** `widgets/text-input.ts`

Single-line text entry with optional masking.

```typescript
export interface TextInputState {
  buffer: string;     // current text content
  prompt?: string;    // label text
  masked?: boolean;   // show asterisks instead of text
  locked?: boolean;   // ignore all input except Esc/CtrlC
}
```

**Rendering (standalone):**
```
Label: typed text here
```

**Rendering (inline in form):**
```
typed text here█    (█ = inverse space cursor block)
```
If masked: `****█`

**Keys:**
| Key | Action |
|-----|--------|
| Printable chars | Append to buffer (including paste) |
| Backspace | Delete last character |
| Enter | Submit value |
| Tab | Emit tab event (for completion) |
| Esc / Ctrl+C | Cancel |
| `q` (empty buffer only) | Cancel |
| Arrow keys | Ignored |

### 10.2 ListPicker

**Source:** `widgets/list-picker.ts`

Single-select list with arrow navigation.

```typescript
export interface ListPickerState {
  items: ListPickerItem[];   // { label: string; disabled?: boolean }
  cursor: number;            // current selection index
  title?: string;
  hint?: string;
  locked?: boolean;
}
```

**Rendering (standalone):**
```
Title (bold)

  > Item 1 (bold, yellow arrow)
    Item 2
    Disabled item (gray)

  hint text (gray)
```

**Rendering (inline in form):**
```
[selected item label] ↑↓
```

**Keys:**
| Key | Action |
|-----|--------|
| Up/Down | Move cursor (wraps, skips disabled) |
| Enter / Space | Select current item |
| Esc / Ctrl+C / q | Cancel |

### 10.3 CheckboxPicker

**Source:** `widgets/checkbox-picker.ts`

Multi-select list with toggle, optional manual entry slot.

```typescript
export interface CheckboxPickerState {
  items: ListPickerItem[];
  cursor: number;
  selected: Set<number>;       // indices of checked items
  title?: string;
  hint?: string;
  allowManualEntry?: boolean;  // adds "Type to add:" slot at end
  entryBuffer: string;         // text typed in manual entry
}
```

**Rendering:**
```
Title (bold)
hint text (gray)

  > [x] Item 1 (green checkbox)
    [ ] Item 2
    [x] Item 3 (green checkbox)

    > Type to add: custom entry text

  space=toggle, enter=done, esc=cancel (gray)
```

**Keys (normal items):**
| Key | Action |
|-----|--------|
| Space | Toggle selected/unselected |
| Enter | Submit all selected indices |
| Up/Down | Move cursor (wraps) |
| Esc / Ctrl+C | Cancel |

**Keys (manual entry slot):**
| Key | Action |
|-----|--------|
| Printable chars | Append to entry buffer |
| Backspace | Delete last char from entry |
| Enter (non-empty) | Add entry as new item |
| Enter (empty) | Submit selections |
| Up/Down | Navigate away from entry slot |
| Esc | Cancel |

### 10.4 YesNoPrompt

**Source:** `widgets/yes-no.ts`

Boolean yes/no prompt with default.

```typescript
export interface YesNoState {
  prompt: string;
  defaultValue: boolean;   // true=Y default, false=N default
  locked?: boolean;
}
```

**Rendering (standalone):**
```
Hidden session? [Y/n]:     (default=true: Y bold, n lowercase)
Hidden session? [y/N]:     (default=false: N bold, y lowercase)
```

**Rendering (inline in form):**
```
[Y/n]    or    [y/N]
```

**Keys:**
| Key | Action |
|-----|--------|
| y/Y | Answer true |
| n/N | Answer false |
| Enter | Answer with default value |
| Esc / Ctrl+C | Cancel |

### 10.5 ComboInput

**Source:** `widgets/combo-input.ts`

Hybrid picker + free-text entry. Starts in picker mode, switches to text mode on typing or Enter.

```typescript
export interface ComboInputState {
  mode: 'picker' | 'text';
  picker: ListPickerState;   // list of preset options
  text: TextInputState;      // free-text input
}
```

**Rendering (standalone, picker mode):**
Same as ListPicker — full screen with items.

**Rendering (standalone, text mode):**
```
Working directory: (bold)
  esc=back to list, tab=complete (gray)

  Path: /home/user/projects
```

**Rendering (inline in form, picker mode):**
```
[selected item] ↑↓
```
Plus expanded picker items below the field row.

**Rendering (inline in form, text mode):**
```
typed path here█
```

**Keys (picker mode):**
| Key | Action |
|-----|--------|
| Up/Down | Navigate items |
| Enter | Select item → switch to text mode with prefill |
| Space | Select item → submit immediately |
| Tab | Switch to text mode (empty) |
| Printable char | Switch to text mode + type char |
| Esc / Ctrl+C / q | Cancel |

**Keys (text mode):**
| Key | Action |
|-----|--------|
| Printable chars | Type into buffer |
| Backspace | Delete char |
| Enter | Submit text value |
| Tab | Emit tab for completion |
| Esc / Ctrl+C | Return to picker mode (clear buffer) |

---

## 11. ANSI Primitives

**Source:** `ansi.ts`

All terminal control is done through these helper functions:

```typescript
moveTo(row, col)         // '\x1b[{row};{col}H'     — CSI cursor position
setScrollRegion(top, bot) // '\x1b[{top};{bot}r'     — DECSTBM scroll region
clearLine()              // '\x1b[2K'                — erase entire line
color(text, code)        // '\x1b[{code}m{text}\x1b[0m' — SGR color wrap
saveCursor()             // '\x1b7'                  — DEC save cursor
restoreCursor()          // '\x1b8'                  — DEC restore cursor
hideCursor()             // '\x1b[?25l'              — hide cursor
showCursor()             // '\x1b[?25h'              — show cursor
enterAltScreen()         // '\x1b[?1049h'            — alternate screen buffer
leaveAltScreen()         // '\x1b[?1049l'            — main screen buffer
```

### Common Inline Sequences

```
\x1b[2J\x1b[H          — clear screen + home cursor (used by all screen renders)
\x1b[1m                 — bold
\x1b[2m                 — dim
\x1b[0m                 — reset all attributes
\x1b[7m \x1b[0m         — inverse space (cursor block in text inputs)
\x1b[K                  — clear to end of line
\x1b[31m                — red (invalid fields, [LOCKED] tag)
\x1b[32m                — green (completed fields, [x] checkmarks)
\x1b[33m                — yellow (cursor arrow, shortcut keys, typing indicators)
\x1b[33;2m              — yellow dim (locked fields)
\x1b[36m                — cyan (session names, remote hosts, first messages)
\x1b[38;5;245m          — 256-color gray (disabled items, hints, separators, metadata)
\x1b[90m                — bright black/gray (idle user names in status bar)
\x1b]0;...\x07          — OSC set terminal title
\r\n                    — line endings (terminal-safe CR+LF)
```

---

## 12. Color Scheme & Field States

### Color Palette (functional)

| Code | Color | Used For |
|------|-------|----------|
| `1` (bold) | White bold | Titles, section headers, current menu item |
| `2` (dim) | White dim | Pending fields, defaults |
| `7` (reverse) | Inverse | Scrollback status bar, cursor block |
| `31` | Red | Invalid fields, `[LOCKED]` tag |
| `32` | Green | Completed fields (`✓`), selected checkboxes `[x]` |
| `33` | Yellow | Cursor `>`, shortcut keys `[n]`, typing users |
| `33;2` | Yellow dim | Locked fields |
| `36` | Cyan | Session names (status bar), remote hosts, export messages |
| `38;5;245` | 256-gray | Disabled items, hints, separators, metadata, owners |
| `90` | Bright black | Idle user names in status bar |

### Unicode Characters

| Char | Name | Used In |
|------|------|---------|
| `─` (U+2500) | Box horizontal | Separators (×40 or ×50) |
| `│` | Box vertical | Status bar separator |
| `✓` | Checkmark | Completed form fields |
| `⌨` | Keyboard | Typing indicator |
| `↑↓` | Arrows | Picker/navigator hints |

---

## 13. Key Input System

**Source:** `widgets/keys.ts`

All raw terminal input is parsed through `parseKey()`:

```typescript
export function parseKey(data: Buffer): KeyEvent {
  const str = data.toString();

  // Arrow keys — CSI (\x1b[) and SS3 (\x1bO) variants
  '\x1b[A' | '\x1bOA' → { key: 'Up' }
  '\x1b[B' | '\x1bOB' → { key: 'Down' }
  '\x1b[C' | '\x1bOC' → { key: 'Right' }
  '\x1b[D' | '\x1bOD' → { key: 'Left' }

  // Control keys
  '\r' | '\n'          → { key: 'Enter' }
  ' '                  → { key: 'Space' }
  '\x1b' (len 1)       → { key: 'Escape' }
  '\x7f' | '\b'        → { key: 'Backspace' }
  '\t'                 → { key: 'Tab' }
  '\x03'               → { key: 'CtrlC' }

  // Everything else   → { key: str, raw: str }  (printable or paste)
}
```

### Cancel Key Detection

```typescript
export function isCancelKey(key: KeyEvent, allowQ: boolean = true): boolean {
  // Escape, CtrlC always cancel
  // 'q' cancels in non-text contexts (allowQ=true by default)
}
```

---

## 14. Screen Renderer (WebSocket JSON)

**Source:** `screen-renderer.ts`

Converts xterm.js headless terminal buffer into JSON for WebSocket streaming to web clients.

### Data Structures

```typescript
export interface Span {
  text: string;
  fg?: string;           // hex color '#rrggbb' or undefined (default)
  bg?: string;           // hex color '#rrggbb' or undefined (default)
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
}

export interface ScreenLine {
  spans: Span[];         // styled text segments per line
}

export interface ScreenState {
  width: number;
  height: number;
  cursor: { x: number; y: number };
  title: string;
  lines: ScreenLine[];
}
```

### Color Conversion

- **RGB colors:** Direct `(r << 16 | g << 8 | b)` → `#rrggbb`
- **256-palette colors:** Lookup table `PALETTE_256[index]`
  - 0–7: Standard ANSI colors
  - 8–15: Bright ANSI colors
  - 16–231: 6×6×6 color cube (`c ? c*40+55 : 0` per channel)
  - 232–255: 24-step grayscale ramp (`i*10+8`)
- **Default color:** Returns `undefined` (client uses its own default)

### Span Grouping

Adjacent cells with identical attributes (fg, bg, bold, italic, underline, dim, strikethrough) are grouped into a single span. Only non-default attributes are included in the JSON to minimize payload size.

### Trailing Whitespace Trimming

The last span on each line is trimmed of trailing spaces if it has no styling attributes, to reduce bandwidth.

### 256-Color Palette Reference

```typescript
const PALETTE_256: string[] = [
  // 0-7: standard
  '#000000', '#cd0000', '#00cd00', '#cdcd00',
  '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  // 8-15: bright
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00',
  '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
  // 16-231: 6×6×6 cube (216 entries)
  // 232-255: grayscale ramp (24 entries)
];
```
