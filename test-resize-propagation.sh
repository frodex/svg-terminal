#!/bin/bash
# Test resize propagation — run while watching the dashboard
SESSION=${1:-resize-test}
echo "Resizing $SESSION every 2 seconds. Watch the dashboard."
echo "Ctrl+C to stop."
while true; do
  echo "→ 100x30"
  tmux resize-window -t "$SESSION" -x 100 -y 30
  sleep 2
  echo "→ 80x24"
  tmux resize-window -t "$SESSION" -x 80 -y 24
  sleep 2
  echo "→ 120x40"
  tmux resize-window -t "$SESSION" -x 120 -y 40
  sleep 2
done
