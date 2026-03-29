#!/bin/bash
# Restart svg-terminal server — kill and restart in one command
# Safe to run while connected via the dashboard
cd /srv/svg-terminal
pkill -f "node.*server.mjs" 2>/dev/null
sleep 1
nohup node server.mjs > /tmp/svg-terminal-server.log 2>&1 &
echo "Server restarted (PID: $!)"
echo "Log: /tmp/svg-terminal-server.log"
