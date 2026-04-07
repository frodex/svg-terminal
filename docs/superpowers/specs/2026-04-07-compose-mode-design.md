# Compose Mode — Text Input Editor Design Spec
**Date:** 2026-04-07
**Status:** Approved

---

## Summary

A rich text input mode for composing messages before sending them to the active terminal. Toggled via Ctrl+Space. In Compose Mode, the bottom input bar expands into a multi-line text editor with spell check, cut/paste, click-to-position cursor, and selection. Terminal interaction shortcuts (Ctrl+Enter, Ctrl+Arrow, Ctrl+Y/N, Ctrl+C) allow responding to agent prompts without leaving the editor. Editor content persists across mode toggles.

---

## Two Input Modes

### Terminal Mode (default)
- All keystrokes go directly to the active terminal — current behavior, unchanged.
- Ctrl+Space switches to Compose Mode.

### Compose Mode
- Bottom input bar expands into a multi-line `<textarea>` or `contenteditable` editor.
- Full modern text editing: spell check, clipboard cut/copy/paste, click-to-position cursor, text selection, word wrap.
- Editor content persists when toggling back to Terminal Mode and returning — you don't lose your work.

---

## Key Bindings — Compose Mode

| Key | Action |
|-----|--------|
| **Enter** | Send editor text to terminal + carriage return (submit) |
| **Shift+Enter** | Send editor text to terminal WITHOUT carriage return (push text, don't submit) |
| **Ctrl+Enter** | Send bare carriage return to terminal (no editor text — for confirming prompts) |
| **Ctrl+Arrow** | Send arrow key to terminal (Up/Down/Left/Right) |
| **Ctrl+Y** | Quick-send `y` + Enter to terminal |
| **Ctrl+N** | Quick-send `n` + Enter to terminal |
| **Ctrl+C** | Send interrupt (SIGINT) to terminal |
| **Ctrl+Space** | Switch back to Terminal Mode |

All other keys are captured by the editor for text composition. Standard editing shortcuts work normally: Ctrl+A (select all), Ctrl+Z (undo), Ctrl+X/C/V (cut/copy/paste), Home/End, Shift+Arrow (selection), etc.

---

## UI — Bottom Bar Expansion

### Terminal Mode (collapsed)
Current input bar appearance — single line showing:
```
● cp-SVG-UI-Doctor-02  |  Keys go to terminal  |  20 available / 7 displayed / 2 paused
```

### Compose Mode (expanded)
Bottom bar expands upward into a multi-line editor:
```
┌─────────────────────────────────────────────────────────────────────┐
│ COMPOSE MODE — Ctrl+Space to return to terminal                     │
│                                                                     │
│ [multi-line text editor area, ~3-5 lines visible, scrollable]       │
│                                                                     │
│ Enter: send+submit | Shift+Enter: send | Ctrl+Enter: bare Enter     │
└─────────────────────────────────────────────────────────────────────┘
```

**Visual indicators:**
- Background color change to distinguish from Terminal Mode (slightly brighter/different tint)
- Mode label: "COMPOSE MODE" with toggle hint
- Key binding cheat sheet along the bottom edge
- Active terminal name still visible

**Sizing:**
- Default: 3 lines visible
- Auto-expands up to ~8 lines as content grows
- Maximum height capped (doesn't cover more than ~30% of viewport)
- Scrollable if content exceeds max height

---

## Data Flow

### Enter (send + submit)
1. Read editor text content
2. Send text as keystrokes to active terminal via `sendInput({ type: 'input', keys: text })`
3. Send carriage return: `sendInput({ type: 'input', keys: '\r' })`
4. Clear editor content

### Shift+Enter (send without submit)
1. Read editor text content
2. Send text as keystrokes to active terminal via `sendInput({ type: 'input', keys: text })`
3. Do NOT send carriage return
4. Clear editor content

### Ctrl+Enter (bare Enter)
1. Send carriage return only: `sendInput({ type: 'input', keys: '\r' })`
2. Do NOT touch editor content

### Ctrl+Arrow
1. Translate to terminal arrow key sequence (uses existing SPECIAL_KEY_MAP)
2. Send to active terminal
3. Do NOT touch editor content

### Ctrl+Y / Ctrl+N
1. Send `y\r` or `n\r` to active terminal
2. Do NOT touch editor content

### Ctrl+C
1. Send `\x03` (ETX) to active terminal
2. Do NOT touch editor content

---

## Implementation Approach

### Editor Element
Use a native `<textarea>` element. Benefits:
- Built-in spell check (browser-native)
- Built-in clipboard handling
- Built-in selection, cursor positioning, undo/redo
- No library dependencies
- Accessible (screen readers, tab order)

`contenteditable` would allow richer formatting but we don't need it — plain text is correct for terminal input.

### DOM Structure
The existing `#input-bar` div expands. Add a `<textarea>` that's hidden in Terminal Mode and shown in Compose Mode:

```html
<div class="input-bar" id="input-bar">
  <!-- existing: status dot, target, hint, perf, card counts -->
  <textarea id="compose-editor" class="compose-editor" 
            spellcheck="true" autocomplete="off"
            placeholder="Type here... Enter to send, Ctrl+Space to exit"></textarea>
</div>
```

### CSS States
- `.input-bar.compose-mode` — expanded height, textarea visible
- `.compose-editor` — hidden by default, shown in compose mode
- Transition on height for smooth expand/collapse

### Keyboard Handler
The existing document-level `keydown` handler currently sends all keys to the terminal. Modify to:
1. Check if Compose Mode is active
2. If active: intercept only the compose-mode shortcuts (Enter, Shift+Enter, Ctrl+Enter, Ctrl+Arrow, Ctrl+Y/N/C, Ctrl+Space). Let all other keys fall through to the textarea.
3. If inactive: existing behavior (send to terminal). Add Ctrl+Space to toggle on.

### State
- `_composeMode` boolean — tracks current mode
- `_composeEditor` reference — the textarea element
- Editor content persists in the textarea DOM naturally (not cleared on toggle)

---

## Edge Cases

- **No active terminal:** Compose Mode can still be entered for typing, but send actions are no-ops (or show a brief warning). The mode is about composing, not about having a target.
- **Terminal changes while composing:** If user clicks a different card, the editor stays open but send target changes. The target label updates to show the new active terminal.
- **Long paste:** Large clipboard paste into the editor is fine (it's a textarea). When sent, it goes as a single `sendInput` call with the full text.
- **Multi-line text in editor:** The textarea supports multiple lines. All lines are concatenated and sent as-is (including newlines for Shift+Enter, or with trailing \r for Enter).
- **Focus management:** When Compose Mode activates, focus moves to the textarea. When it deactivates, focus returns to the document (for terminal key capture).

---

## What Stays Unchanged

- Terminal Mode key handling (existing behavior)
- The `sendInput` / `sendDashboardMessage` data path
- SPECIAL_KEY_MAP translations
- Card focus/unfocus behavior
- Mobile input (separate concern)
