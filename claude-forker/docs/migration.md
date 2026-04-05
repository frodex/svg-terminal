# claude-fork migration notes

## Project directory encoding (v0.2.0)

Claude Code stores sessions under `~/.claude/projects/<sanitized-cwd>/`, where **sanitized-cwd** matches `sanitizePath()` in `sessionStoragePortable.ts`: every non-alphanumeric character becomes `-`, with no run collapsing. Paths longer than 200 characters use a 200-character prefix plus a `-` and a base-36 djb2 hash suffix.

**Legacy directories** created by older `claude-fork` builds used slash-only encoding (`/` → `-`). The tool resolves targets in this order:

1. Current encoding (`encode_cwd()` as above)
2. Legacy: `path.replace("/", "-")`
3. For long paths only: prefix match when multiple hashes could disagree (e.g. Bun vs Node)

New forks always write under (1). Existing legacy dirs keep working without manual migration.

## NFC (Unicode)

Claude Code’s worktree path list may NFC-normalize paths. This implementation does not; on typical ASCII Linux paths behavior matches. If you hit non-ASCII path mismatches, normalize paths when extending `list_git_worktree_paths`.
