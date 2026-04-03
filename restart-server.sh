#!/bin/bash
# Restart svg-terminal (systemd unit; default port 3200)
set -e
if systemctl is-enabled svg-terminal.service &>/dev/null; then
  systemctl restart svg-terminal.service
  systemctl --no-pager status svg-terminal.service
else
  cd /srv/svg-terminal
  pkill -f "node.*server.mjs" 2>/dev/null || true
  sleep 1
  nohup node server.mjs > /tmp/svg-terminal-server.log 2>&1 &
  echo "Server restarted on port 3200 (PID: $!)"
  echo "Log: /tmp/svg-terminal-server.log"
fi
