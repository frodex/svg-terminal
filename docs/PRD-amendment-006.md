# PRD Amendment 006 — Unix socket claude-proxy API + svg-terminal systemd service

**Date:** 2026-04-03  
**Status:** As-built (this host)  
**Relates to:** PRD §3.x (claude-proxy integration), Phase C transport, operations module  
**Journal:** `/srv/claude-proxy/docs/research/2026-04-03-v0.1-phase-c-socket-systemd-journal.md`

---

## 1. Summary

This amendment records two shipped changes:

1. **claude-proxy** exposes a **Unix domain socket** JSON-RPC API (same capabilities as the HTTP/WebSocket stack where implemented), in addition to **TCP `127.0.0.1:3101`** for browsers and OAuth.
2. **svg-terminal** consumes claude-proxy via that socket (not via `http://127.0.0.1:3101` for session discovery, screen, input, resize, scroll) and runs under **systemd** on this host so the dashboard stays up across reboots.

---

## 2. Problem

- Local integration over **HTTP to a fixed port** is awkward to permission and easy to misconfigure when claude-proxy is otherwise “the SSH service.”
- svg-terminal was often started with **manual `node` + `nohup`** or a shell script that **`pkill`**’d processes — no clean boot guarantee, weak logging contract.

---

## 3. Resolution

### 3.1 claude-proxy: socket server

- **Socket path (configured):** `/run/claude-proxy/api.sock`
- **Mode:** `0660` (`socket_mode: 432` decimal in YAML — same numeric mode Node `chmod` expects for `rw-rw----`).
- **Protocol:** Newline-delimited JSON; request/response and push events for terminal streaming (`subscribe` / `unsubscribe` / `input`, plus **`resize`** and **`scroll`** RPCs aligned with the existing WebSocket behavior).
- **YAML:** `claude-proxy.yaml` includes an `api:` block with `port`, `host`, and `socket` (see platform repo).

### 3.2 svg-terminal: client behavior

- **Default socket:** `CLAUDE_PROXY_SOCKET=/run/claude-proxy/api.sock` (override via environment).
- **Default user for unauthenticated server paths:** `CLAUDE_PROXY_USER=root` where applicable.
- **Dashboard:** Uses `linux_user` from authenticated session when calling `listSessions`, `getSessionScreen`, `subscribe`, `input`, `resize`, `scroll`.

### 3.3 svg-terminal: systemd unit (this host)

**File on disk:** `/etc/systemd/system/svg-terminal.service`

```ini
[Unit]
Description=SVG Terminal dashboard (HTTP/WebSocket)
Documentation=file:///srv/svg-terminal/server.mjs
After=network.target claude-proxy.service

[Service]
Type=simple
User=root
WorkingDirectory=/srv/svg-terminal
ExecStart=/usr/bin/node server.mjs
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3200
Environment=CLAUDE_PROXY_SOCKET=/run/claude-proxy/api.sock
Environment=CLAUDE_PROXY_USER=root
Environment=PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
```

**Enable / start:**

```bash
systemctl daemon-reload
systemctl enable --now svg-terminal
```

**Logs:**

```bash
journalctl -u svg-terminal -f
```

**Operational note:** `restart-server.sh` in the svg-terminal repo prefers `systemctl restart svg-terminal` when the unit is enabled; otherwise it falls back to the legacy `nohup` path.

---

## 4. Dependency graph

```
claude-proxy.service
  ├── SSH :3100 (lobby)
  ├── HTTP/WS :3101 (browser API)
  └── Unix socket /run/claude-proxy/api.sock (local JSON-RPC)

svg-terminal.service (After=claude-proxy.service)
  └── HTTP :3200 (dashboard) → claude-proxy via CLAUDE_PROXY_SOCKET
```

---

## 5. Out of scope / follow-up

- OAuth-specific flows **through** the Unix socket only (internal auth RPC exists; full browser login story may remain Phase D per prior plan).
- Reproducible **checked-in** copy of `svg-terminal.service` for non-systemd installs (optional example file).
- Pushing **`session-end`** (and similar) to socket subscribers for all clients — optional enhancement.

---

## 6. Verification checklist (operators)

| Step | Expected |
|------|----------|
| `systemctl is-active claude-proxy` | `active` |
| `ls -l /run/claude-proxy/api.sock` | socket exists |
| `systemctl is-active svg-terminal` | `active` |
| `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3200/` | `200` |
| `journalctl -u claude-proxy -n 20` | `[socket] listening on …` |
