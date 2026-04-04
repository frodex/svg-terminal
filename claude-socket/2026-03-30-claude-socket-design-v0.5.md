# claude-socket — Design Document

**Date:** 2026-03-30
**Status:** Draft — awaiting user review
**Branch:** camera-only-test
**Research:** claude-socket/2026-03-30-v0.1 through v0.3 agent-tunnel journals

---

## 1. Problem

Agents communicate by dropping files in each other's workspaces or by attempting to read/write through SVG terminals via curl or puppeteer. Both approaches fail:

- **Filesystem:** Works for formal handoffs but is slow and has no real-time capability. Agents poll for files. No conversation flow.
- **Terminal scraping:** Content scrolls off the viewport. Polling timing misses partial responses. Agents waste tokens parsing visual decoration (colors, borders, status bars). Scrollback is fragile. Turn-taking is guesswork.

The root cause: agents are forced to communicate through a medium designed for human eyes (the terminal) when they need structured data. Meanwhile, the svg-terminal server already parses terminal output into structured data — it just doesn't expose it in a form agents can consume directly.

---

## 2. What claude-socket Is

A real-time, structured communication layer for LLM agents. You **wire agents together** — by dragging a cable between terminal cards in the 3D dashboard, or by an agent calling a connect tool. Once wired, agents communicate through native MCP tools. Users observe through visible cables and an optional chat card. The service manages connections, message history, turn-taking, and agent wake-up.

claude-socket handles real-time conversation — questions, debate, negotiation between agents. Formal artifact exchange (documents, specs, handoffs) remains a separate concern.

---

## 3. The Connection Model

### 3.1 Cables, Not Rooms

The primary concept is a **cable** — a visible connection between two or more agent cards in the 3D scene. Rooms are an implementation detail that hold the message history. Users think about wires, not chat rooms.

**Creating a connection:**
- **User drags:** Grab a socket handle on Card A's title bar → drag to Card B → cable appears, agents are connected
- **Agent calls tool:** `socket_connect("api-agent")` → cable appears in the dashboard, same visual result
- **User drags to empty space:** Shows a picker menu of available agents to connect to

**Direction matters:** The initiator (drag source / tool caller) is the requester. The target is the responder. The responder gets woken up with the requester's context.

### 3.2 Three Connection Modes

| Mode | Syntax | What happens |
|------|--------|-------------|
| **Direct** | `A->B` | One private channel between A and B. One cable. |
| **Separated** | `A->(B,C, separated)` | A has separate private channels to B and C. Two cables. B and C don't see each other's conversations. |
| **Combined** | `A->(B,C, combined)` | One shared channel. All three see everything. One hub with cables to each. The "3-way call." |

Implementation:
- Direct → one channel (2 participants)
- Separated → N channels (2 participants each, A is in all of them)
- Combined → one channel (N participants)

### 3.3 Agent Discovery

An agent may not know who to connect to. Two paths:

**Agent-driven discovery:**
```
socket_discover()
→ [{
    id: "cp-api-002",
    name: "API Agent",
    session: "cp-SVG-Terminal_CLAUD-PROXY_integration_01",
    status: "idle",
    working_on: "API server auth endpoints",    // from pane title / tmux metadata
    cwd: "/srv/claude-proxy"
  }, ...]
```

The agent can pick from this list, or present it to the user:
> "I found these agents. Which should I connect to about the auth token format?"
> 1. API Agent (working on auth endpoints)
> 2. DB Agent (working on schema migrations)

**User-driven discovery:**
- Drag from socket into empty space → popup menu shows available agents
- Or: user tells agent "ask the API agent directly" → agent calls `socket_connect("api-agent")`

---

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    svg-terminal (server.mjs)                      │
│                                                                  │
│  Existing                          New                           │
│  ───────                           ───                           │
│  /ws/terminal (screen/delta)       Socket Service                │
│  /api/sessions                     ├─ /api/socket/*   (REST)     │
│  /api/input                        └─ /ws/socket      (WS)      │
│                                                                  │
│                                    Manages:                      │
│                                    - Channels (backing store     │
│                                      for cables)                 │
│                                    - Message history             │
│                                    - Participant state           │
│                                    - Turn management             │
│                                    - Wake-up (tmux send-keys)    │
│                                    - Agent discovery             │
│                                    - Persistence (SQLite)        │
└──────┬────────────┬────────────────────┬─────────────────────────┘
       │            │                    │
       ▼            ▼                    ▼
┌────────────┐ ┌──────────────┐
│ MCP Server  │ │ Dashboard    │
│ (per-agent) │ │              │
│             │ │ Cable render │
│ Stateless   │ │ (3D lines)  │
│ subprocess  │ │              │
│             │ │ Chat card    │
│             │ │ (sidecar)    │
└──────┬─────┘ │              │
       │       │ Socket UX    │
       ▼       │ (drag handle) │
┌────────────┐ └──────────────┘
│ Claude Code │
│ Agent       │
│             │
│ Uses socket │
│ as native   │
│ MCP tools   │
└────────────┘
┌────────────┐
│ Claude Code │
│ Agent       │
│             │
│ Uses socket │
│ as native   │
│ MCP tools   │
└────────────┘
```

### 4.1 Socket Service

New module: `claude-socket/socket-service.mjs`, imported by `server.mjs`.

- **Channels** — created implicitly when a cable is connected. Each channel has participants, message history, turn state.
- **Messages** — append-only log per channel. Full history always available.
- **Participants** — track status: `active` (in a turn) / `idle` (session alive, waiting for input) / `invited`. Linked to claude-proxy session IDs.
- **Turn management** — three modes: `free` (anyone speaks), `round-robin` (sequential), `steward-directed` (steward picks next).
- **Wake-up** — when a message targets a idle participant, injects a prompt into their tmux pane via `tmux send-keys`.
- **Discovery** — queries claude-proxy for available sessions, merges with local tmux session metadata (pane titles, cwd, activity).
- **Persistence** — SQLite. Channels and messages survive server restart.
- **WebSocket** — real-time event stream to MCP servers, dashboard cables, and chat cards.

### 4.2 MCP Server (Tunnel Tools for Agents)

Standalone Node.js process. Configured globally in `~/.claude/mcp_servers.json`. One instance per Claude Code session. Stateless — all state lives in the socket service.

**Tools:**

| Tool | Purpose | Returns |
|------|---------|---------|
| `socket_discover()` | List available agents with metadata | `[{id, name, session, status, working_on, cwd}]` |
| `socket_connect(target, context?)` | Connect to another agent (creates cable + channel) | `{channel_id, target_status}` |
| `socket_connect(targets[], {mode?})` | Multi-connect. Agent negotiates mode (separated/combined). | `{channel_ids: [...]}` |
| `socket_send(channel, content, {to?, nohup?})` | Send message. `nohup: true` = deliver without waking idle recipients. | `{message_id}` |
| `socket_read(channel, since?)` | Read messages since last read or message ID | `{messages: [...], participants: [...]}` |
| `socket_yield(channel, summary?)` | Signal turn complete | `{next_participant?}` |
| `socket_disconnect(channel)` | Leave a channel (cable removed) | `{disconnected: true}` |
| `socket_channels()` | List my active connections | `[{channel_id, participants, messageCount}]` |

**Connection flow from agent's perspective:**

```
1. Agent realizes it needs another agent's input
2. socket_discover() → sees available agents
3. socket_connect("api-agent", "Need auth token format details")
   → tunnel service creates channel
   → tunnel service wakes api-agent if idle
   → cable appears in dashboard
   → returns {channel_id: "ch-a1b2", target_status: "waking"}
4. socket_read("ch-a1b2", {wait: true})
   → blocks until api-agent responds
   → returns messages
5. Continue conversation via socket_send / socket_read
6. socket_yield("ch-a1b2", "Got auth token answer")
   → or socket_disconnect if done entirely
```

### 4.3 Dashboard Integration

**Cable rendering:**
- 3D lines/curves between connected cards in the scene
- Rendered via Three.js Line or CatmullRomCurve3 (smooth bezier between card positions)
- Cable state reflected visually:
  - **Connected + idle:** Subtle line (dim color)
  - **Active / data flowing:** Pulse animation or glow
  - **Waking target:** Dashed/blinking while agent is being summoned
- Color: **white** end = initiator, **green** end = responder. **Red/black** = error state.
- Curve: spline from center of one card to center of the other(s)

**Socket handle on cards:**
- Small circular affordance on the title bar (next to the existing dot controls)
- Cursor changes on hover to indicate "draggable connector"
- Drag from socket → cable follows cursor → drop on another card's socket or empty space

**Empty-space drop → agent picker:**
- When cable is dropped on empty space, shows a floating menu
- Lists available agents (from `socket_discover` data)
- User selects → connection created to that agent's card
- If agent has no card visible yet, card is created and added to the scene

**Chat card (always created, sidecar):**
- Chat card is ALWAYS created when a cable is connected — for both direct and combined modes
- Attaches as a **sidecar** to the initiator's terminal card (magnetically snapped to the side)
- Can be detached and repositioned freely in 3D space, re-attached by dragging back near the terminal card
- Chat card shows message thread, user can type as steward

### 4.4 Wake-Up Flow

Agents are **persistent Claude Code sessions** managed by claude-proxy. They are not dead processes — they are live sessions sitting at the Claude Code `>` prompt, waiting for input. They already have their MCP tools loaded, their conversation history, their project context.

Wake-up is simply: **type a message into their existing session.**

```
socket_connect("api-agent", "Need auth token format") is called
         │
         ▼
Socket Service looks up api-agent:
  session_id: "cp-api-002"
  status: "idle"
         │
         ▼
Socket Service types into the running session:
  tmux send-keys -t cp-api-002 "<message>" Enter
         │
         ▼
Message lands as a new user turn in the agent's existing Claude Code session
  → Agent already has MCP tools loaded (socket_read, socket_send, etc.)
  → Agent calls socket_read("ch-a1b2") → gets conversation history
  → Agent responds via socket_send
  → Agent finishes → socket_yield
         │
         ▼
Socket Service marks api-agent as "idle" again
Cable stays visible (connection persists, agent is just between turns)
```

**Wake-up message** (typed into the agent's running Claude Code prompt):

```
You have a message from UI Agent on claude-socket channel ch-a1b2.
Context: "Need auth token format details"
Use socket_read to get the conversation, then respond with socket_send.
Call socket_yield when you're done.
```

This is not starting a new process. The agent's full context is intact — they know their project, their tools, their history. The message is just another user turn.

---

## 5. Message Format

```json
{
  "id": "msg-a1b2c3d4",
  "channel_id": "ch-x9y8z7",
  "from": {
    "id": "ui-agent",
    "name": "UI Agent",
    "type": "agent"
  },
  "to": null,
  "type": "message",
  "content": "What format should auth tokens use?",
  "timestamp": "2026-03-30T14:23:01.000Z",
  "turn_id": "turn-003"
}
```

**Message types:**

| Type | Meaning |
|------|---------|
| `message` | Conversation message from an agent |
| `steward` | Message from user/steward via chat card |
| `connect` | Agent connected (cable created) |
| `disconnect` | Agent disconnected (cable removed) |
| `yield` | Agent finished their turn |
| `system` | Service announcement (wake-up sent, agent idle, error, etc.) |

---

## 6. Persistence

SQLite. Reuses existing `better-sqlite3` dependency.

```sql
CREATE TABLE channels (
  id TEXT PRIMARY KEY,              -- "ch-" + randomUUID short
  name TEXT,                        -- auto-generated or user-provided
  mode TEXT DEFAULT 'direct',       -- 'direct' | 'combined'
  turn_mode TEXT DEFAULT 'free',    -- 'free' | 'round-robin' | 'steward-directed'
  turn_current TEXT,
  initiator_id TEXT NOT NULL,       -- who started the connection
  created TEXT NOT NULL,
  archived INTEGER DEFAULT 0
);

CREATE TABLE participants (
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                -- 'agent' | 'steward'
  role TEXT DEFAULT 'participant',   -- 'initiator' | 'responder' | 'participant'
  status TEXT DEFAULT 'invited',     -- 'invited' | 'active' (in turn) | 'idle' (session alive, between turns)
  session_id TEXT,                   -- claude-proxy session ID
  joined TEXT,
  PRIMARY KEY (channel_id, agent_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT,                        -- null = broadcast
  type TEXT NOT NULL,
  content TEXT,
  turn_id TEXT,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

CREATE INDEX idx_messages_channel_ts ON messages(channel_id, timestamp);
```

**Key schema decisions:**
- `channels` not `rooms` — aligns with cable metaphor
- `initiator_id` tracks who started the connection (drag direction)
- `role` on participants: `initiator` vs `responder` preserves the direction semantics
- `mode`: `direct` (1:1 or separated) vs `combined` (multi-party shared)
- "Separated" connections are multiple `direct` channels sharing the same initiator. Each is an independent channel with its own message history. The initiator sees them as separate conversations. There is no `separated` mode value — it's just multiple `direct` channels created together.

---

## 7. REST API

All endpoints under `/api/socket/`.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/socket/discover` | List available agents (merges claude-proxy + tmux) |
| `POST` | `/api/socket/connect` | Create a connection (cable + channel) |
| `GET` | `/api/socket/channels` | List active channels |
| `GET` | `/api/socket/channels/:id` | Get channel state + recent messages |
| `POST` | `/api/socket/channels/:id/send` | Send a message |
| `GET` | `/api/socket/channels/:id/messages?since=X` | Read messages |
| `POST` | `/api/socket/channels/:id/yield` | Signal turn complete |
| `POST` | `/api/socket/channels/:id/disconnect` | Leave (remove cable) |
| `DELETE` | `/api/socket/channels/:id` | Archive a channel |

**WebSocket:** `/ws/socket?channel=X` — real-time event stream.

**WebSocket for dashboard:** `/ws/socket/cables` — stream of cable create/destroy/state-change events for rendering all cables in the 3D scene.

---

## 8. Dashboard UX

### 8.1 Socket Handle

- Small circle (or plug icon) on the right side of each card's title bar header
- Distinct from the existing dot controls (close/minimize/optimize on left)
- On hover: cursor changes, tooltip "Connect to another agent"
- On drag: a cable line follows the cursor from the source card

### 8.2 Cable Drag Interaction

```
mousedown on socket handle
  → enter cable-dragging mode
  → render temporary line from source card to cursor position

mousemove
  → update cable endpoint to cursor
  → highlight valid drop targets (other cards' socket handles glow)

mouseup on another card's socket
  → POST /api/socket/connect {from: sourceAgent, to: targetAgent}
  → cable rendered permanently between cards
  → agents are connected

mouseup on empty space
  → show floating agent picker menu at cursor position
  → [{name, session, status, working_on}]
  → user selects → connect to that agent
  → if agent has no visible card, create one
```

### 8.3 Cable Rendering

- Three.js line geometry (spline) between card center positions
- Updates each frame as cards move (drag, orbit, focus transitions)
- Color: white end = initiator, green end = responder (from session-start perspective). Red/black = error state.
- Pulse animation when data is flowing; dim when idle; dashed/blinking when waking target

### 8.4 Cable Interactions

- **Right-click cable** → context menu: "Open chat card", "Disconnect", "Show history"
- **Hover cable** → tooltip with channel name, participant count, last message time
- Cables persist visually even when agents are idle (connection lives, agent sleeps)

### 8.5 Chat Card (Sidecar)

- **Always created** when a cable is connected — every connection gets a chat card
- Uses card factory: `createChatCardDOM(channelId)`
- **Sidecar attachment:** Magnetically snaps to the side of the initiator's terminal card. Moves with it during drag/orbit/focus.
- **Detach/re-attach:** User can pull the chat card away to position freely. Dragging back near a terminal card re-attaches (magnetic snap zone).
- Content area: scrollable message list
  - Agent messages: left-aligned with agent name/avatar
  - Steward messages: right-aligned or visually distinct
  - System messages: centered, muted
- Input area: text field + send button at bottom
- Header: channel name, participant status dots, connection mode badge
- Lives in 3D scene like any card — focusable, draggable, resizable

---

## 9. Observability Model

The user has **three levels** of visibility into any agent interaction:

1. **Cables** — at a glance, see which agents are connected. Color/animation shows activity.
2. **Chat Card** — the structured conversation thread. What was said, by whom.
3. **Terminal Cards** — each agent's raw terminal. Tool calls, reasoning, errors. HOW the agent arrived at what it said.

Cables are the dashboard-level view (spatial, instant). Chat cards are the conversation-level view. Terminal cards are the debug-level view. The user zooms into whichever level of detail they need.

---

## 10. Deadlock Prevention and NOHUP

### The Problem

Agent 1 sends Agent 2 a task via claude-socket ("produce accepted.prd and let me know when it's ready"). Agent 1 goes to sleep. Agent 2 completes the work, writes the file, **forgets to report back**, and goes to sleep. The channel is now dead — no one is awake to advance the conversation.

### Session-End Hooks

Agents MUST report to connected agents before going to sleep. This is enforced via agent rules / session-end hooks:

- Before an agent's session ends, check for active claude-socket channels
- For each channel: send a status message — either the deliverable ("accepted.prd is ready at /path") or an explicit sleep signal
- If the agent fails to report, the socket service can detect the idle transition and notify the other participant(s) via a `system` message: "Agent 2 went idle without yielding on channel ch-a1b2"

### NOHUP

An agent can signal: **"I am going to sleep. Do not reply to this message."**

```
socket_send(channel, "accepted.prd is ready at /srv/project/accepted.prd", {nohup: true})
```

The `nohup` flag tells the socket service:
- Deliver this message to the channel
- Do NOT wake any idle participants in response to this message
- The recipient will see it next time they naturally wake up (or are woken by someone else)

**Use cases:**
- Agent delivers a file and doesn't need a response right now
- Agent posts a status update ("50% done, will continue next turn") without triggering a wake-up loop
- Agent is done with the conversation entirely and wants a clean exit

Without NOHUP, every message to a idle agent triggers a wake-up. This creates ping-pong: Agent 1 reports → wakes Agent 2 → Agent 2 acknowledges → wakes Agent 1 → infinite loop. NOHUP breaks the cycle.

### Deadlock Detection

Even with hooks, deadlocks can happen. The socket service monitors channels for:
- All participants idle + no pending NOHUP messages → **deadlock**
- Action: send a `system` message visible in the chat card: "All participants are idle. Channel stalled."
- The user (watching in svg-terminal) sees this and can intervene — either wake an agent manually or type into the chat card.

---

## 11. Discovery and Permissions

### Permission Model

Discovery respects the existing user/group/other permission system. When a user or agent drags a cable, available targets are color-coded:

| Color | Meaning | Capability |
|-------|---------|------------|
| **Black** | Unavailable | Cannot connect. No permission on that session. |
| **White** | Read-only | Can observe the agent's chat messages but cannot send. |
| **Green** | Read/Write | Full connection — can send and receive messages. |

Permissions derive from the agent's session ownership. An agent can only connect to sessions their user has access to. This is checked at `POST /api/socket/connect` time and reflected visually during cable drag.

### Discovery Sources

- **claude-proxy API** — `GET /api/sessions` returns managed sessions with metadata
- **Local tmux** — `tmux list-sessions` returns local sessions with pane titles, cwd
- **Unified identity:** Session IDs from both sources are used as-is. claude-proxy sessions are prefixed `cp-*`, local tmux sessions are not. The discovery endpoint merges both lists.

---

## 12. Approaches Considered and Rejected

### Abstract Room Model (Earlier Draft)

Create named rooms, invite agents via API. Rejected in favor of cable model because:
- Requires user to think in abstractions (rooms, invitations) instead of physical gestures
- Doesn't map to the spatial metaphor of svg-terminal's 3D scene
- Heavier initialization ceremony (name room → invite → wait for join)
- Cable model: drag and drop. Done.

### CLI Wrapper Tunnel

Wrap Claude Code invocations in a `tunnel-agent` script. Rejected because:
- Loses tool-level visibility in the terminal
- Agent can't use tunnel mid-conversation
- Reintroduces parsing problem

### Filesystem + Notification Hybrid

Extend filesystem inbox/outbox with WebSocket notifications. Rejected because:
- Slow even with fs.watch
- Agents still read files, not structured tools
- Doesn't solve wake-up

---

## 13. Prerequisite: Sessions Must Be Live

**Constraint:** A session must be started and visible in svg-terminal before agents can connect to it. No invisible targets, no background session spawning, no wake-up of retired sessions.

- Discovery only returns sessions that have cards in the dashboard
- Cable drag targets = visible cards only
- If you need to bring back a retired session, use claude-proxy to restart it first, then cable to it
- The socket service does NOT manage session lifecycle — that's claude-proxy's job

This keeps the socket service simple: it types into running sessions. It doesn't spawn, resume, or manage them.

---

## 14. Setup and Operational Procedures

### 14.1 Infrastructure Setup (One-Time)

**svg-terminal server** must have the socket service enabled:
```bash
# Socket service is built into server.mjs — no separate install.
# Starts automatically when svg-terminal server starts.
# SQLite database created on first use at data/claude-socket.db
```

**MCP server installed globally:**
```bash
# Install the MCP server binary/script
cp claude-socket/socket-mcp-server.mjs /usr/local/lib/claude-socket-mcp.mjs

# Configure globally for all Claude Code sessions
cat >> ~/.claude/mcp_servers.json << 'EOF'
{
  "claude-socket": {
    "command": "node",
    "args": ["/usr/local/lib/claude-socket-mcp.mjs"],
    "env": {
      "CLAUDE_SOCKET_URL": "ws://localhost:3200/ws/socket"
    }
  }
}
EOF
```

**Verify installation:**
```bash
# Shell script — no agent context burned
claude-socket/bin/verify-setup.sh
# Checks: svg-terminal running, socket service responding,
#         MCP server config exists, test connection succeeds
```

### 14.2 Per-Agent Setup

Every Claude Code session that will participate in claude-socket needs:

1. **MCP server in config** — handled by global install above. New sessions pick it up automatically.
2. **claude-socket skill** — a skill file that teaches the agent the protocol (yield, nohup, turn-taking norms). Installed to the project's `.claude/skills/` or globally to `~/.claude/skills/`.
3. **Session-end hook** — enforces "report to connected channels before sleeping." Configured in `.claude/settings.json` hooks.

**The skill file** (`claude-socket-protocol.md`):
```markdown
# claude-socket Protocol
- When you receive a claude-socket wake-up message, call socket_read first
- Respond with socket_send
- Call socket_yield when your turn is done
- Use nohup: true if delivering a file/status and you don't need a response
- Before ending your session, check socket_channels() and report to any active channels
```

**The session-end hook** (`.claude/settings.json`):
```json
{
  "hooks": {
    "preToolCall": [{
      "matcher": "stop",
      "command": "claude-socket/bin/check-active-channels.sh"
    }]
  }
}
```

### 14.3 Readiness Check Script

A zero-context shell script that verifies a session is claude-socket ready:

```bash
# claude-socket/bin/check-ready.sh <session-id>
# Returns 0 if ready, 1 if not, with human-readable output:
#   ✓ Session cp-api-002 is running
#   ✓ MCP server configured
#   ✓ claude-socket skill installed
#   ✓ Session-end hook configured
#   ✗ Missing: session-end hook  ← actionable
```

### 14.4 Calling Agent Procedures

**Before connecting:**
1. Agent calls `socket_discover()` → sees available sessions with readiness status
2. Discovery response includes a `ready` boolean per session — true only if MCP + skill + hook are all present
3. If target is not ready, agent can either:
   - Tell the user: "Agent B's session isn't set up for claude-socket. Run `claude-socket/bin/setup-session.sh cp-api-002` to configure it."
   - Or (if permitted): run the setup script itself via bash tool

**Connecting:**
1. `socket_connect("api-agent", "Need auth token format details")`
2. Socket service verifies target session is live and visible in svg-terminal
3. Socket service types wake-up message into target's Claude Code prompt
4. Cable appears in dashboard, chat card sidecar created
5. Caller waits with `socket_read(channel, {wait: true})` or continues working

**During conversation:**
- `socket_send` / `socket_read` for messages
- `socket_yield` when turn is done
- `socket_send(..., {nohup: true})` for fire-and-forget deliveries

**Disconnecting:**
- `socket_disconnect(channel)` — cable removed, chat card remains as archive

### 14.5 Receiving Agent Procedures

**When a wake-up message arrives:**
1. Agent sees a new user message in their running session: "You have a message from UI Agent on claude-socket channel ch-a1b2..."
2. Agent already has MCP tools loaded (session was running, MCP server was configured)
3. Agent already has the claude-socket skill loaded (knows the protocol)
4. Agent calls `socket_read("ch-a1b2")` → gets full conversation history
5. Agent processes, responds with `socket_send`
6. Agent calls `socket_yield` when done

**Before ending session:**
1. Session-end hook fires `check-active-channels.sh`
2. If active channels exist, hook warns the agent: "You have active claude-socket channels. Report status before sleeping."
3. Agent sends final status to each channel (with `nohup: true` if no response needed)
4. Agent disconnects or leaves channels open for future turns

### 14.6 Caller-Assisted Setup

The calling agent can set up the receiving agent without burning the receiver's context:

```bash
# claude-socket/bin/setup-session.sh <session-id>
# Idempotent. Runs from OUTSIDE the target session.
# 1. Checks if MCP server is configured for the target session's user
# 2. Installs claude-socket skill to the target's project
# 3. Configures session-end hook
# 4. Runs verify and reports status
```

This script runs as a bash command from the calling agent's terminal. It modifies the target session's configuration files on disk — no need to type into the target session or burn its context.

**When the caller should use this:**
- `socket_discover()` returns `ready: false` for the target
- Caller runs `setup-session.sh cp-api-002`
- Re-runs discover → target now shows `ready: true`
- Caller proceeds with `socket_connect`

### 14.7 Manual Setup (No Agent Assistance)

For users who don't want agents handling setup:

```bash
# Full setup for all sessions on this machine:
claude-socket/bin/setup-all.sh

# Setup for one specific session:
claude-socket/bin/setup-session.sh cp-api-002

# Verify everything:
claude-socket/bin/verify-setup.sh

# List which sessions are ready:
claude-socket/bin/list-ready.sh
```

All scripts are shell — zero tokens burned, zero agent context used.

---

## 15. File Structure

```
svg-terminal/
├── claude-socket/
│   ├── socket-service.mjs          # Channel, message, participant, turn, discovery
│   ├── socket-mcp-server.mjs       # MCP server (standalone process for agents)
│   ├── socket-db.mjs               # SQLite schema and queries
│   ├── cable-renderer.mjs          # Three.js cable rendering (lines, curves, animations)
│   ├── chat-card.mjs               # Chat card DOM + rendering for dashboard
│   ├── chat-card.css               # Chat card styles
│   ├── claude-socket-protocol.md   # Skill file — teaches agents the protocol
│   ├── test-socket.mjs             # Tests
│   └── bin/
│       ├── setup-session.sh        # Configure one session for claude-socket
│       ├── setup-all.sh            # Configure all sessions on this machine
│       ├── verify-setup.sh         # Verify infrastructure + config
│       ├── check-ready.sh          # Check if a specific session is ready
│       ├── list-ready.sh           # List all ready sessions
│       └── check-active-channels.sh # Session-end hook — warn if channels open
├── server.mjs                      # Imports socket-service, mounts routes + WS
├── dashboard.mjs                   # Imports cable-renderer + chat-card, adds socket UX
└── index.html                      # Cable/chat styles if needed
```

---

## 16. Resolved Questions

1. **~~claude-proxy wake-up API~~** — Not needed. Wake-up uses `tmux send-keys` directly. The socket service already lives in server.mjs which has tmux access. No external API call required.
2. **MCP server deployment** — Global `~/.claude/mcp_servers.json`. The entry passes `CLAUDE_SOCKET_URL` as an env var (standard MCP pattern). Default: `ws://localhost:3200/ws/socket` (svg-terminal's port). One config file, zero magic.
3. **Sidecar snap mechanics** — Initial defaults: 50px snap zone, sidecar follows terminal during focus transitions, detaches on explicit drag away. Will iterate during implementation.
4. **NOHUP edge cases** — All participants NOHUP simultaneously → deadlock detector catches it, surfaces to user in chat card. NOHUP to active participants → no-op (delivers normally). NOHUP messages are always visible in the chat card for observability.
5. **Channel lifecycle** — Open until terminated by any participant. Everyone has termination authority in v1.
6. **Multi-connect mode** — Agents negotiate outbound mode (separated vs combined) themselves.
7. **Chat card creation** — Always created. Sidecar-attached to initiator's terminal card.
8. **Discovery permissions** — Color-coded during cable drag: black = unavailable, white = read-only, green = R/W. Respects existing UGO permission model.
