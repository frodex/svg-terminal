#!/bin/bash
# fork-agent-to-project.sh — Fork an existing Claude Code session to a new project directory
#
# This rewrites the CWD field in every JSONL record so Claude Code loads the
# conversation history when resumed from the new project directory.
#
# Usage: ./fork-agent-to-project.sh <session-id> <source-cwd> <target-project-path>
#
# Example:
#   ./fork-agent-to-project.sh 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 /root /srv/new-project
#
# Verified working: 2026-04-01 (tested with real 4MB session, full context preserved)

set -euo pipefail

SOURCE_ID="${1:-}"
SOURCE_CWD="${2:-}"
TARGET_PATH="${3:-}"

if [ -z "$SOURCE_ID" ] || [ -z "$SOURCE_CWD" ] || [ -z "$TARGET_PATH" ]; then
    echo "Usage: $0 <session-id> <source-cwd> <target-project-path>"
    echo ""
    echo "Example:"
    echo "  $0 6a76ff6f-ca1e-4be9-b596-b2c0ae588d91 /root /srv/new-project"
    echo ""
    echo "This will:"
    echo "  1. Copy the session JSONL from the source project directory"
    echo "  2. Rewrite the CWD field in every record to match the target project"
    echo "  3. Place the rewritten JSONL in the target's encoded project directory"
    echo "  4. Copy subagent and tool-result companion files"
    echo ""
    echo "Then resume with:"
    echo "  cd <target-project-path> && claude --resume <session-id>"
    exit 1
fi

# Encode paths (replace / with -)
SOURCE_ENCODED=$(echo "$SOURCE_CWD" | sed 's|/|-|g')
TARGET_ENCODED=$(echo "$TARGET_PATH" | sed 's|/|-|g')

SOURCE_DIR="$HOME/.claude/projects/$SOURCE_ENCODED"
TARGET_DIR="$HOME/.claude/projects/$TARGET_ENCODED"

SOURCE_JSONL="$SOURCE_DIR/$SOURCE_ID.jsonl"

# Verify source exists
if [ ! -f "$SOURCE_JSONL" ]; then
    echo "ERROR: Source session not found at $SOURCE_JSONL"
    echo ""
    echo "Available sessions in $SOURCE_DIR/:"
    ls "$SOURCE_DIR"/*.jsonl 2>/dev/null | head -10 || echo "  (none)"
    exit 1
fi

SOURCE_SIZE=$(du -h "$SOURCE_JSONL" | cut -f1)
echo "Source: $SOURCE_JSONL ($SOURCE_SIZE)"
echo "Target: $TARGET_DIR/$SOURCE_ID.jsonl"
echo ""

# Create target directory
mkdir -p "$TARGET_DIR"
echo "Step 1: Created $TARGET_DIR"

# Generate a new UUID for the fork (prevents overwrite on repeat forks)
FORK_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
echo "Step 2: New fork UUID: $FORK_ID"

# Rewrite CWD in every record
echo "Step 3: Rewriting CWD from '$SOURCE_CWD' to '$TARGET_PATH'..."
python3 -c "
import json, sys

source_cwd = '$SOURCE_CWD'
target_cwd = '$TARGET_PATH'
count = 0

with open('$SOURCE_JSONL') as f:
    lines = f.readlines()

with open('$TARGET_DIR/$FORK_ID.jsonl', 'w') as f:
    for line in lines:
        obj = json.loads(line)
        if obj.get('cwd') == source_cwd:
            obj['cwd'] = target_cwd
            count += 1
        f.write(json.dumps(obj) + '\n')

print(f'  Rewrote CWD in {count} of {len(lines)} records')
"

# Copy companion directory (subagents, tool-results)
if [ -d "$SOURCE_DIR/$SOURCE_ID" ]; then
    echo "Step 4: Copying companion files (subagents, tool-results)..."
    cp -r "$SOURCE_DIR/$SOURCE_ID/" "$TARGET_DIR/$FORK_ID/"
    COMPANION_COUNT=$(find "$TARGET_DIR/$FORK_ID/" -type f | wc -l)
    echo "  Copied $COMPANION_COUNT companion files"
else
    echo "Step 4: No companion directory found (no subagents/tool-results)"
fi

# Create target project directory if it doesn't exist
mkdir -p "$TARGET_PATH"
echo "Step 4: Ensured $TARGET_PATH exists"

# Create target project directory if it doesn't exist
mkdir -p "$TARGET_PATH"
echo "Step 5: Ensured $TARGET_PATH exists"

TARGET_SIZE=$(du -h "$TARGET_DIR/$FORK_ID.jsonl" | cut -f1)
echo ""
echo "========================================="
echo "Done. Forked session ready."
echo "========================================="
echo ""
echo "To resume:"
echo "  cd $TARGET_PATH"
echo "  claude --resume $FORK_ID"
echo ""
echo "The agent will load:"
echo "  JSONL:      $TARGET_DIR/$FORK_ID.jsonl ($TARGET_SIZE)"
echo "  CLAUDE.md:  $TARGET_PATH/CLAUDE.md (if exists)"
echo "  Settings:   $TARGET_PATH/.claude/settings.json (if exists)"
echo ""
echo "Source: $SOURCE_JSONL (unchanged)"
echo "Fork:   $TARGET_DIR/$FORK_ID.jsonl (new UUID, safe to re-fork)"
