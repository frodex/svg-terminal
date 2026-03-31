# Server-to-Browser Command Channel — Design Spec

**Date:** 2026-03-30
**Status:** Approved
**Branch:** camera-only-test

---

## 1. Purpose

A general-purpose server-to-browser push channel using Server-Sent Events (SSE). Foundation for reload commands, DOM injection, follow-along mode, cross-browser awareness, and future admin commands.

---

## 2. Architecture

### SSE Endpoint

`GET /api/events` — browser opens `EventSource`, server holds the connection open and pushes commands as needed. Browser auto-reconnects on disconnect (built into EventSource spec).

### Command Format

Server sends named events with JSON data:

```
event: reload
data: {}

event: dom
data: {"id":"status-bar","html":"<span>3 browsers connected</span>"}
```

### Command Types

| Command | Payload | Browser Action |
|---------|---------|----------------|
| `reload` | `{}` or none | `location.reload()` |
| `dom` | `{ id, html }` | `document.getElementById(id).innerHTML = html` |

Extensible — new commands added by adding a handler on the client and a trigger on the server.

---

## 3. Server Side (server.mjs)

### Connected clients set

```js
const sseClients = new Set();
```

### SSE endpoint

`GET /api/events`:
- Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
- Send `retry: 3000\n\n` (reconnect interval)
- Add `res` to `sseClients`
- On `close` event, remove from `sseClients`

### Broadcast function

```js
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}
```

Available to any server code — resize sync, admin commands, future features.

### Admin reload endpoint

`POST /api/admin/reload`:
- Calls `broadcast('reload', {})`
- Returns `{ ok: true, clients: sseClients.size }`

### Connected count

`GET /api/admin/clients`:
- Returns `{ count: sseClients.size }`

---

## 4. Client Side (dashboard.mjs)

### On page load

```js
const eventSource = new EventSource('/api/events');

eventSource.addEventListener('reload', function() {
  location.reload();
});

eventSource.addEventListener('dom', function(e) {
  const data = JSON.parse(e.data);
  const el = document.getElementById(data.id);
  if (el) el.innerHTML = data.html;
});

eventSource.onopen = function() {
  console.log('[SSE] connected');
};

eventSource.onerror = function() {
  console.log('[SSE] disconnected, auto-reconnecting...');
};
```

---

## 5. Triggering Reload

### Manual

```bash
curl -X POST http://localhost:3201/api/admin/reload
```

### Dev mode (optional, future)

File watcher on dashboard.mjs, terminal.svg, server.mjs — any change triggers `broadcast('reload', {})`. Not implemented initially.

---

## 6. Constraints

| Constraint | Reason |
|-----------|--------|
| SSE is server-to-client only | Browser-to-server uses existing WebSocket and HTTP POST |
| No auth on /api/admin/reload initially | Dev mode only. Add auth when user management is wired. |
| EventSource auto-reconnects | Browser handles reconnection, no custom retry logic needed |
| One SSE connection per browser tab | Each `<object>` SVG does NOT open its own SSE — only dashboard.mjs |

---

## 7. Testing

- Start server, open browser, verify `[SSE] connected` in console
- Run `curl -X POST localhost:3201/api/admin/reload` — browser reloads
- Kill server, restart — browser auto-reconnects SSE
- Check `/api/admin/clients` returns correct count
