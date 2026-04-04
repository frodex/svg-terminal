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

| Mode          | Syntax                | What happens                                                                                          |
| ------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| **Direct**    | `A->B`                | One private channel between A and B. One cable.                                                       |
| **Separated** | `A->(B,C, separated)` | A has separate private channels to B and C. Two cables. B and C don't see each other's conversations. |
| **Combined**  | `A->(B,C, combined)`  | One shared channel. All three see everything. One hub with cables to each. The "3-way call."          |

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
> 
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
│                                    - Wake-up orchestration       │
│                                    - Agent discovery             │
│                                    - Persistence (SQLite)        │
└──────┬────────────┬────────────────────┬─────────────────────────┘
       │            │                    │
       ▼            ▼                    ▼
┌────────────┐ ┌──────────────┐  ┌──────────────────┐
│ MCP Server  │ │ Dashboard    │  │ claude-proxy API │
│ (per-agent) │ │              │  │ (wake-up)        │
│             │ │ Cable render │  │                  │
│ Stateless   │ │ (3D lines)  │  │ POST /resume     │
│ subprocess  │ │              │  │ POST /send-input │
│             │ │ Chat card    │  │                  │
│             │ │ (optional)   │  │ GET /sessions    │
│             │ │              │  │ (discovery)      │
└──────┬─────┘ │ Socket UX    │  └──────────────────┘
       │       │ (drag handle) │
       ▼       └──────────────┘
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
- **Participants** — track status: `active` / `dormant` / `invited`. Linked to claude-proxy session IDs.
- **Turn management** — three modes: `free` (anyone speaks), `round-robin` (sequential), `steward-directed` (steward picks next).
- **Wake-up** — when a message targets a dormant participant, calls claude-proxy API to resume their session.
- **Discovery** — queries claude-proxy for available sessions, merges with local tmux session metadata (pane titles, cwd, activity).
- **Persistence** — SQLite. Channels and messages survive server restart.
- **WebSocket** — real-time event stream to MCP servers, dashboard cables, and chat cards.

### 4.2 MCP Server (Tunnel Tools for Agents)

Standalone Node.js process. Configured globally in `~/.claude/mcp_servers.json`. One instance per Claude Code session. Stateless — all state lives in the socket service.

**Tools:**

| Tool                                 | Purpose                                            | Returns                                          |
| ------------------------------------ | -------------------------------------------------- | ------------------------------------------------ |
| `socket_discover()`                  | List available agents with metadata                | `[{id, name, session, status, working_on, cwd}]` |
| `socket_connect(target, context?)`   | Connect to another agent (creates cable + channel) | `{channel_id, target_status}`                    |
| `socket_connect(targets[], {mode})`  | Multi-connect: separated or combined               | `{channel_ids: [...]}`                           |
| `socket_send(channel, content, to?)` | Send message (broadcast or directed)               | `{message_id}`                                   |
| `socket_read(channel, since?)`       | Read messages since last read or message ID        | `{messages: [...], participants: [...]}`         |
| `socket_yield(channel, summary?)`    | Signal turn complete                               | `{next_participant?}`                            |
| `socket_disconnect(channel)`         | Leave a channel (cable removed)                    | `{disconnected: true}`                           |
| `socket_channels()`                  | List my active connections                         | `[{channel_id, participants, messageCount}]`     |

**Connection flow from agent's perspective:**

```
1. Agent realizes it needs another agent's input
2. socket_discover() → sees available agents
3. socket_connect("api-agent", "Need auth token format details")
   → tunnel service creates channel
   → tunnel service wakes api-agent if dormant
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
- Direction: asymmetric styling — arrow, thicker end at initiator, or color gradient

**Socket handle on cards:**

- Small circular affordance on the title bar (next to the existing dot controls)
- Cursor changes on hover to indicate "draggable connector"
- Drag from socket → cable follows cursor → drop on another card's socket or empty space

**Empty-space drop → agent picker:**

- When cable is dropped on empty space, shows a floating menu
- Lists available agents (from `socket_discover` data)
- User selects → connection created to that agent's card
- If agent has no card visible yet, card is created and added to the scene

**Chat card (optional per-connection):**

- User can open a chat card for any cable (right-click cable → "Open chat")
- Or: chat card auto-appears for combined (multi-party) connections
- For 1:1 connections, the user may prefer just watching both terminal cards — chat card is optional
- Chat card shows message thread, user can type as steward

### 4.4 Wake-Up Flow

```
socket_connect("api-agent", "Need auth token format") is called
         │
         ▼
Socket Service looks up api-agent:
  session_id: "cp-api-002"
  status: "dormant"
         │
         ▼
Socket Service calls claude-proxy:
  POST /api/session/cp-api-002/send-input
  Body: wake-up prompt (see below)
         │
         ▼
claude-proxy injects into api-agent's tmux pane
         │
         ▼
Claude Code starts new turn
  → MCP server subprocess starts
  → MCP server connects to socket service
  → Agent calls socket_read → gets full history
  → Agent responds → socket_send
  → Agent finishes → socket_yield
  → Claude Code turn ends → MCP subprocess dies
         │
         ▼
Socket Service marks api-agent as "dormant" again
Cable stays visible (connection persists, agent just isn't active)
```

**Wake-up prompt** (injected into the agent's terminal):

```
You have been connected via claude-socket.
Channel: "ch-a1b2" | From: UI Agent
Context: "Need auth token format details"

Use socket_read to get the conversation, then respond with socket_send.
Call socket_yield when you're done with your turn.
```

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

| Type         | Meaning                                                         |
| ------------ | --------------------------------------------------------------- |
| `message`    | Conversation message from an agent                              |
| `steward`    | Message from user/steward via chat card                         |
| `connect`    | Agent connected (cable created)                                 |
| `disconnect` | Agent disconnected (cable removed)                              |
| `yield`      | Agent finished their turn                                       |
| `system`     | Service announcement (wake-up sent, agent dormant, error, etc.) |

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
  status TEXT DEFAULT 'invited',     -- 'invited' | 'active' | 'dormant'
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

| Method   | Endpoint                                    | Purpose                                            |
| -------- | ------------------------------------------- | -------------------------------------------------- |
| `GET`    | `/api/socket/discover`                      | List available agents (merges claude-proxy + tmux) |
| `POST`   | `/api/socket/connect`                       | Create a connection (cable + channel)              |
| `GET`    | `/api/socket/channels`                      | List active channels                               |
| `GET`    | `/api/socket/channels/:id`                  | Get channel state + recent messages                |
| `POST`   | `/api/socket/channels/:id/send`             | Send a message                                     |
| `GET`    | `/api/socket/channels/:id/messages?since=X` | Read messages                                      |
| `POST`   | `/api/socket/channels/:id/yield`            | Signal turn complete                               |
| `POST`   | `/api/socket/channels/:id/disconnect`       | Leave (remove cable)                               |
| `DELETE` | `/api/socket/channels/:id`                  | Archive a channel                                  |

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

- Three.js line geometry between card world positions
- Updates each frame as cards move (drag, orbit, focus transitions)
- Curve: QuadraticBezierCurve3 with a slight droop (gravity feel) or smooth arc
- Color coding:
  - Active conversation: bright (e.g., cyan or green glow)
  - Idle connection: dim gray
  - Waking agent: pulsing/dashed
  - Error/timeout: red
- Direction indicator: small arrow or gradient showing initiator → responder

### 8.4 Cable Interactions

- **Right-click cable** → context menu: "Open chat card", "Disconnect", "Show history"
- **Hover cable** → tooltip with channel name, participant count, last message time
- Cables persist visually even when agents are dormant (connection lives, agent sleeps)

### 8.5 Chat Card

- Created per-channel, optional for direct (1:1) connections, auto-created for combined (multi-party)
- Uses card factory: `createChatCardDOM(channelId)`
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

## 10. Approaches Considered and Rejected

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

## 11. File Structure

```
svg-terminal/
├── claude-socket/
│   ├── socket-service.mjs       # Channel, message, participant, turn, wake-up, discovery
│   ├── socket-mcp-server.mjs    # MCP server (standalone process for agents)
│   ├── socket-db.mjs            # SQLite schema and queries
│   ├── cable-renderer.mjs       # Three.js cable rendering (lines, curves, animations)
│   ├── chat-card.mjs            # Chat card DOM + rendering for dashboard
│   ├── chat-card.css            # Chat card styles
│   └── test-socket.mjs          # Tests
├── server.mjs                   # Imports socket-service, mounts routes + WS
├── dashboard.mjs                # Imports cable-renderer + chat-card, adds socket UX
└── index.html                   # Cable/chat styles if needed
```

---

## 12. Open Questions

1. **claude-proxy wake-up API** — verify exact endpoints for session resume and input injection.
2. **MCP server deployment** — global `~/.claude/mcp_servers.json` is the plan. The MCP server needs `CLAUDE_SOCKET_URL` to find the socket service. How is this set across all agent environments?
3. **Channel lifecycle** — auto-archive after idle period? Max message count? Cable auto-hide after N minutes of dormancy? open until terminated by participant with authority, everyone has authority on ver 1
4. **Turn enforcement** — in `round-robin` and `steward-directed` modes, hard-block or soft-warn for out-of-turn messages? agents should maintain persistence when required to keep convesation active. minimum one controling agent with ability to wake others into a new turn. example agent 1 delivers review.prd to agent 2. prd handoff requests agent produce accepted.prd and let agent 1 know it's ready. AGent 1 goes to sleep and waits to be woken after agent 2 completes work. Problem, agent 2 writes file and forgets to report to agent 1 and goes to sleep. chat is locked with no advancement. possible solution is to add hooks to agent rules at session end to require a report to other agents. This leads to the question of racing. We shold have a NOHUP type of command. Agent 1 reports they have no further tasks and will sleep, do not reply to this message.: NOHUP
5. **Cable visual design** — curve style, color palette, animation specifics. Needs iteration once basic rendering works. just spline from center of one card to the other(s) to start. Green end to red end (white is init agent, green are receiving agents - start of session perspective) red or black can be error states.
6. **Multi-connect UX** — how does the user specify "separated" vs "combined" when dragging to multiple targets? Modifier key? Menu after second connection? AGENTS NEGEOCIATE HOW THEY WANT TO SEND OUTBOUND MESSAGES. 
7. **Chat card auto-creation** — always for combined, never for direct, or user preference? ALWAYS, SHOULD ATTACH AS SIDECAR TO PRIMARY TERMINAL WINDOW AND HAVE A WAY TO DETACH/RE-ATTACH (magnetic?)
8. **Discovery data sources** — claude-proxy API + local tmux? How to unify identities across both? ASSUMES AGENTS HAVE PROPER PERMISSIONS ON THEIR SESSIONS THERE IS A UGO USER MANAGER, WHEN YOU ARE TRYING TO CONNECT WITH THE CABLE, MAYBE TERMINALS THAT CAN ACCEPT ARE COLOR CODED, BLACK NOT AVAIABLE, WHITE IS READ ONLY, GREEN IS R/W?
