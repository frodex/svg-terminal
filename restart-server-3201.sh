#!/bin/bash
# Restart svg-terminal server on temporary port 3201
# Used during development to isolate from stale clients on 3200
cd /srv/svg-terminal
pkill -f "node.*server.mjs" 2>/dev/null
sleep 1
nohup node server.mjs --port 3201 > /tmp/svg-terminal-server.log 2>&1 &
echo "Server restarted on port 3201 (PID: $!)"
echo "Log: /tmp/svg-terminal-server.log"
