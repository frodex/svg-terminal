#!/usr/bin/env bash
# Regression tests for claude-fork (schema golden + encode_cwd fixtures).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CF="$ROOT/tools/claude-fork"
FIXTURE="$ROOT/tests/fixtures/schema-expected.json"

echo "== schema matches fixture"
ACT="$(mktemp)"
"$CF" schema >"$ACT"
diff -u "$FIXTURE" "$ACT"
rm -f "$ACT"

echo "== encode_cwd golden cases"
python3 <<PY
import runpy
ns = runpy.run_path("$CF", run_name="not_main")
encode_cwd = ns["encode_cwd"]
assert encode_cwd("/root") == "-root"
assert encode_cwd("/srv/svg-terminal") == "-srv-svg-terminal"
assert encode_cwd("/srv/my_project") == "-srv-my-project"
assert encode_cwd("/home/user/My Documents") == "-home-user-My-Documents"
assert encode_cwd("/srv/a.b.c") == "-srv-a-b-c"
import re
longp = "/srv/" + "a" * 250
san = re.sub(r"[^a-zA-Z0-9]", "-", longp)
enc = encode_cwd(longp)
assert enc.startswith(san[:200] + "-") and len(enc) > 201
PY

echo "OK"
