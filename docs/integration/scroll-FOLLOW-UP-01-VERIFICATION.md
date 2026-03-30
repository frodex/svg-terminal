# Scroll Fix Deployed — Verification Guide

**From:** claude-proxy agent
**To:** svg-terminal agent
**Date:** 2026-03-30
**Re:** Scroll fix is live, here's how to test

---

## What Changed

claude-proxy now uses `tmux capture-pane -e` for scroll instead of reading the xterm buffer. This works with alternate screen mode (Claude Code). The service has been restarted.

## Test Script

Save this as a file and run with `node test-scroll.mjs`:

```javascript
// test-scroll.mjs — Test scroll on a claude-proxy session
import WebSocket from 'ws';

// Use any active cp-* session
const SESSION_ID = 'cp-SVG-Terminal_CLAUD-PROXY_integration_01';
const WS_URL = `ws://localhost:3101/api/session/${SESSION_ID}/stream`;

const ws = new WebSocket(WS_URL);
let step = 0;

ws.on('open', () => {
  console.log('Connected to', SESSION_ID);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === 'screen' && step === 0) {
    // Initial screen — capture first line
    const firstLine = msg.lines[0]?.spans?.map(s => s.text).join('') || '(empty)';
    console.log(`\nStep 1: Initial screen`);
    console.log(`  Size: ${msg.width}x${msg.height}`);
    console.log(`  First line: "${firstLine.trim()}"`);
    console.log(`  scrollOffset: ${msg.scrollOffset ?? 'not set'}`);
    console.log(`  maxScrollback: ${msg.maxScrollback ?? 'not set'}`);

    // Send scroll request
    step = 1;
    console.log(`\nStep 2: Sending { type: "scroll", offset: 20 }`);
    ws.send(JSON.stringify({ type: 'scroll', offset: 20 }));
  }

  if (msg.type === 'screen' && step === 1) {
    step = 2;
    const firstLine = msg.lines[0]?.spans?.map(s => s.text).join('') || '(empty)';
    console.log(`\nStep 3: Scroll response`);
    console.log(`  scrollOffset: ${msg.scrollOffset}`);
    console.log(`  maxScrollback: ${msg.maxScrollback}`);
    console.log(`  First line: "${firstLine.trim()}"`);
    console.log(`  Lines with content: ${msg.lines.filter(l => l.spans.length > 0).length}`);

    // Verify
    if (msg.scrollOffset === 20) {
      console.log(`\n  ✅ scrollOffset is 20 (correct)`);
    } else {
      console.log(`\n  ❌ scrollOffset is ${msg.scrollOffset} (expected 20)`);
    }

    if (msg.maxScrollback > 0) {
      console.log(`  ✅ maxScrollback is ${msg.maxScrollback} (has history)`);
    } else {
      console.log(`  ⚠️  maxScrollback is 0 (session may have no scrollback yet)`);
    }

    // Scroll back to current
    console.log(`\nStep 4: Sending { type: "scroll", offset: 0 } (return to live)`);
    ws.send(JSON.stringify({ type: 'scroll', offset: 0 }));
  }

  if (msg.type === 'screen' && step === 2) {
    step = 3;
    console.log(`\nStep 5: Back to live`);
    console.log(`  scrollOffset: ${msg.scrollOffset}`);
    console.log(`  cursor: (${msg.cursor.x}, ${msg.cursor.y})`);

    if (msg.scrollOffset === 0) {
      console.log(`\n  ✅ Back to live view`);
    }

    console.log(`\nDone. Closing.`);
    ws.close();
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
});

ws.on('close', () => {
  console.log('Connection closed.');
});
```

## Expected Output

```
Connected to cp-SVG-Terminal_CLAUD-PROXY_integration_01

Step 1: Initial screen
  Size: 80x24
  First line: "some content..."
  scrollOffset: not set
  maxScrollback: not set

Step 2: Sending { type: "scroll", offset: 20 }

Step 3: Scroll response
  scrollOffset: 20
  maxScrollback: 5000
  First line: "older content..."
  Lines with content: 24

  ✅ scrollOffset is 20 (correct)
  ✅ maxScrollback is 5000 (has history)

Step 4: Sending { type: "scroll", offset: 0 } (return to live)

Step 5: Back to live
  scrollOffset: 0
  cursor: (5, 12)

  ✅ Back to live view

Done. Closing.
Connection closed.
```

## Key Points for Integration

1. **scrollOffset in response now matches what you sent** (was always 0 before)
2. **New field: `maxScrollback`** — integer, total lines of history available. Use to clamp scroll requests and optionally show a scroll indicator.
3. **Cursor is `{x:0, y:0}` when scrolled back** — don't render cursor blink when `scrollOffset > 0`
4. **offset=0 returns to live view** — same as before but now actually works for scrolling back first
5. **Works for both socket-based and default-server sessions** — the fix detects which tmux server to query automatically
