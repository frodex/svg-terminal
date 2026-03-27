# Bibliography — svg-terminal

Sources reviewed, referenced, or learned from during development.

| Source | Date | Referenced For |
|--------|------|----------------|
| [ansi-to-svg](https://github.com/F1LT3R/ansi-to-svg) | 2026-03-27 | SVG rendering patterns: hardcoded font metrics (8.4px width, 14px size, 18px line height), `<rect>` for backgrounds before `<text>`, `<path>` for underline/strikethrough, whitespace skip optimization |
| [termtosvg](https://github.com/nbedos/termtosvg) | 2026-03-27 | Best-in-class SVG terminal rendering: `dominant-baseline: text-before-edge` for y-positioning, `textLength` for monospace enforcement, CSS class-based colors (.color0-.color15), `CELL_WIDTH=8 CELL_HEIGHT=17`, `<defs>`+`<use>` line dedup, pyte for VT100 emulation |
| [svg-term-cli](https://github.com/marionebl/svg-term-cli) | 2026-03-27 | Alternative SVG approach: `<symbol>`+`<use>` dedup, `fontSize * 0.6` char width ratio, React+Emotion rendering pipeline (not adopted), horizontal frame layout for animation |
| [termtosvg anim.py source](https://github.com/nbedos/termtosvg/blob/master/termtosvg/anim.py) | 2026-03-27 | Detailed SVG generation code: cell dimensions, text styling attributes, CSS animation with `steps(1, end)`, wide char support via wcwidth |
| [tmux man page — capture-pane](https://www.man7.org/linux/man-pages/man1/tmux.1.html) | 2026-03-27 | `capture-pane -p -e` gives SGR-only re-serialized screen state (no cursor movement codes). `-C` for octal escaping, `-J` for join wrapped lines, `-S`/`-E` for line ranges |
| [tmux Control Mode wiki](https://github.com/tmux/tmux/wiki/Control-Mode) | 2026-03-27 | `%output` notifications for real-time streaming, `pause-after` flow control. Not adopted for POC — capture-pane polling is simpler |
| [ttyd](https://github.com/tsl0922/ttyd) | 2026-03-27 | Existing browser terminal tool using xterm.js. Read-only via `-W` omission. Reference for how `tmux attach -r` provides read-only viewing |
| [GoTTY](https://github.com/sorenisanerd/gotty) | 2026-03-27 | Browser terminal tool, spawns PTY per connection. Confirmed the pattern of `tmux attach -r` for read-only session viewing |
| [tmate](https://github.com/tmate-io/tmate) | 2026-03-27 | tmux fork with relay architecture, msgpack protocol. Different approach (session replication vs screen capture). Not adopted |
| [xterm.js](https://github.com/xtermjs/xterm.js/) | 2026-03-27 | Dominant browser terminal renderer (canvas-based). Not adopted — we're SVG-native. But the canvas approach is the comparison baseline |
| [Intersection Observer API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API) | 2026-03-27 | Visibility-aware polling: detect when SVG enters/leaves viewport with zero polling cost. Used for tiered update rates |
| [claude-proxy source](/srv/claude-proxy/) | 2026-03-27 | First integration target. SSH-based tmux multiplexer, `cp-` prefixed sessions, PtyMultiplexer manages tmux lifecycle, no existing web server. Node.js + ssh2 + node-pty stack |
| [PHAT-TOAD-with-Trails docs](/srv/PHAT-TOAD-with-Trails/) | 2026-03-27 | Future integration target. sessions.md line 59: "live web dashboard (React Flow + ELK, SVG tree with xterm.js terminal windows per node)". SVG viewer becomes per-node terminal display component |
