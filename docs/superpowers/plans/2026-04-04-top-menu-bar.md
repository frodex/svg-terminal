# Top Menu Bar — Implementation Plan

**Goal:** Add a fixed top menu bar to the 3D dashboard that consolidates group-level controls (layout, session management) and serves as the integration point for OAuth login and claude-proxy web UI features.

**Status:** Not started

---

## Context

### Current state

- **Bottom input bar** (`#input-bar`): visible when a terminal is focused. Shows active session name, WS status dot, input hint, perf indicator. Slides up from `bottom: -50px`.
- **Card header controls** (`.header-controls`): per-card buttons (`−`, `+`, `⊡`, `⊞`, `⬜`, `▦`) shown when focused. Layout operations (`▦` cycle, `⬜` maximize) are group-level but live on individual cards.
- **Help button** (`#help-btn`): fixed top-left, opens frosted-glass help panel.
- **Sidebar** (`.thumbnail-sidebar`): fixed right, always visible.

### Problems with current approach

- Layout controls are **group-level** (affect all focused cards) but placed **per-card** — conceptually wrong and wastes header space.
- No place for **session management** (new session, restart, fork) — these are claude-proxy lobby features with no web equivalent yet.
- No place for **user identity** (logged in as…, logout) — OAuth exists in claude-proxy but the dashboard has no UI for it.
- On mobile, card header buttons are tiny and hard to tap.

### Existing web UI assets

- `/srv/svg-terminal/ui-web/prototype.html`: full prototype of the web UI (login, lobby, session form, admin, export, password). Uses the `#1a1a2e` / `#16213e` dark palette with `#4285f4` accent.
- `/srv/svg-terminal/ui-web/ANSI-UI.md`: complete screen reference for the TUI version (lobby, session form, pickers). Maps 1:1 to what the web UI needs.
- `/srv/svg-terminal/ui-web/oauth-web-ui-references.md`: index of all OAuth/auth design docs across both repos.
- `/srv/claude-proxy/src/api-server.ts`: HTTP/WS API server with auth middleware, session CRUD, OAuth endpoints.
- `/srv/claude-proxy/src/auth/`: OAuth flow, session cookies, user store, provisioner.

---

## Design

### Top menu bar

Fixed position, top of viewport, same z-index layer as sidebar and input bar (outside the CSS3D scene). Frosted glass aesthetic matching help panel.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ☰  │  Layout: [grid ▾]  │  ⊡ Fit All  ⬜ Max All  │  user@… │ ⋮ │
└─────────────────────────────────────────────────────────────────────┘
```

#### Sections (left to right)

1. **Hamburger menu** (`☰`): opens a dropdown with:
   - New session (→ session form or claude-proxy API)
   - Restart session (→ picker)
   - Fork session (→ picker)
   - Settings / preferences
   - Help (replaces `#help-btn`)
   - Logout (when authenticated)

2. **Layout selector** (visible when 2+ cards focused):
   - Dropdown or clickable label showing current layout name
   - On hover: **ghost preview** — frosted-glass rectangles overlaid on the viewport showing slot positions (same aesthetic as help panel)
   - Ghost fades to thin gray outlines after ~1s, persists while hovering
   - On select: ghost flashes, cards animate into position

3. **Group mutation buttons** (visible when 2+ cards focused):
   - `⊡ Fit All`: `optimizeTermToCard` on every focused card
   - `⬜ Max All`: `maximizeCardToSlot` on every focused card
   - Moves these out of per-card headers

4. **User identity** (visible when authenticated):
   - Username or avatar
   - Dropdown: profile, logout

5. **Overflow menu** (`⋮`): less-used items, future extensibility

#### Visibility rules

| State | Top bar | Bottom bar |
|-------|---------|------------|
| Overview (no focus) | Hamburger + user only | Hidden |
| Single focus | Hamburger + user | Visible (session name, input hint, perf) |
| Multi-focus (2+) | Full bar (layout + mutations + hamburger + user) | Visible |

### Ghost layout preview

When hovering a layout option in the dropdown:

1. Semi-transparent frosted rectangles appear on the viewport at the actual slot positions
2. Slots are sized and positioned to match `calculateSlotLayout` output for that layout
3. After ~1s, rectangles fade to thin gray outlines
4. Outlines persist while that option is hovered
5. On click: brief flash, then cards animate into the selected layout
6. Uses same `backdrop-filter: blur()` as help panel

### Card header cleanup

After top bar is implemented:

- Remove `▦` (cycle layout) from per-card header — moved to top bar layout selector
- Remove `⬜` (maximize card→slot) from per-card header — moved to top bar "Max All"
- Keep per-card: `−` (smaller), `+` (bigger), `⊡` (fit term→card), `⊞` (fit card→term), `⌊` (minimize)
- These are **per-card** operations that make sense on the card itself

### OAuth / claude-proxy integration

The top bar's hamburger menu is where web UI features from `ui-web/prototype.html` land:

1. **Login flow**: If not authenticated, hamburger shows "Login" → redirects to OAuth (Google/GitHub/Microsoft) via claude-proxy `/auth/*` endpoints. Session cookie (`cp_session`) returned.
2. **Session management**: "New session" → session form (web version of TUI `session-form.ts`). "Restart" / "Fork" → pickers. These call claude-proxy API (`/api/sessions`, `/api/session/create`, etc.).
3. **User context**: After OAuth, `resolve-user.ts` maps provider identity to a Linux account. The dashboard passes this identity in WebSocket connections and API calls so claude-proxy knows who's operating.

**Implementation order:**
1. Top bar shell (HTML/CSS, visibility logic) — no API calls
2. Layout selector + ghost preview — client-side only
3. Group mutation buttons — client-side only
4. Hamburger menu shell — static links / placeholders
5. OAuth login flow — wires to claude-proxy auth endpoints
6. Session management — wires to claude-proxy session API
7. Remove relocated buttons from card headers

---

## File changes

| File | Changes |
|------|---------|
| `index.html` | Add `#top-bar` element with sections |
| `dashboard.css` | Top bar styles, ghost preview styles, layout dropdown |
| `dashboard.mjs` | Top bar visibility logic, layout selector, ghost preview rendering, group mutation handlers, hamburger menu, OAuth state |
| Card header in `createTerminalDOM` | Remove `▦` and `⬜` after top bar equivalents work |

---

## Dependencies

- Layout system (`calculateSlotLayout`, `LAYOUTS`, `cycleLayout`) — already implemented
- `optimizeTermToCard`, `maximizeCardToSlot` — already implemented
- claude-proxy API server (`/api/sessions`, `/auth/*`) — already implemented
- OAuth providers configured in env vars — already implemented in claude-proxy
- Session cookie middleware — already implemented in both repos

---

## Open questions

- Should the top bar be visible in overview mode (no focus) for session management, or only appear on focus?
- Mobile: should the top bar collapse to just the hamburger on small viewports?
- Ghost preview: should it show card names/labels in the ghost slots, or just rectangles?
- Should "Fit All" apply to all focused cards or all visible cards?
