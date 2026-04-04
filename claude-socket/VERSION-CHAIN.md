# claude-socket Design Document Version Chain

| Version | File | Description |
|---------|------|-------------|
| v0.1 | (not preserved — mutated in place, lesson learned) | Initial design: room-based model, PHAT TOAD references |
| v0.2 | 2026-03-30-claude-socket-design-v0.2.md | Snapshot before user notes incorporated |
| NOTES-01a | 2026-03-30-claude-socket-design-NOTES-01a.md | User's annotated copy with open question answers |
| v0.3 | 2026-03-30-claude-socket-design-v0.3.md | Cable model, NOHUP, sidecar, permissions, tmux wake-up, all questions resolved |
| v0.4 | 2026-03-30-claude-socket-design-v0.4.md | Fixed wake-up model: agents are persistent sessions, not cold starts. "idle" replaces "dormant". |
| v0.5 | 2026-03-30-claude-socket-design-v0.5.md | Added: sessions-must-be-live constraint, full operational procedures (setup, per-agent, caller-assisted, manual), shell scripts, skill file, session-end hooks. |

**Rule:** Highest version number is always the working copy. Step by copying to next version BEFORE making changes.
