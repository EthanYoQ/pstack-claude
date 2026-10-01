#!/bin/bash
# Builds a Lean 4 model with lake and fails on any error or any theorem that
# still uses sorry, printing each one with its file and line. A build with
# none prints PASS and the number of declarations lake compiled.
#
# Usage: lean-check.sh <lake-project-dir>
set -uo pipefail
dir=${1:?usage: lean-check.sh <lake-project-dir>}
[ -f "$dir/lakefile.toml" ] || [ -f "$dir/lakefile.lean" ] || { echo "FAIL $dir has no lakefile"; exit 1; }
command -v lake > /dev/null || { echo "FAIL lake is not on PATH (install elan: https://github.com/leanprover/elan)"; exit 1; }

log=$(mktemp)
trap 'rm -f "$log"' EXIT
lake --dir "$dir" build > "$log" 2>&1
status=$?
errors=$(grep -c "error:" "$log")
# Lean quotes sorry with backticks or straight quotes depending on the version.
sorries=$(grep -c "declaration uses .sorry." "$log")
if [ "$status" -ne 0 ] || [ "$errors" -ne 0 ] || [ "$sorries" -ne 0 ]; then
  echo "FAIL $dir: $errors errors, $sorries sorries, lake exit $status"
  grep -E "error:|declaration uses .sorry." "$log"
  [ "$status" -eq 0 ] || grep -v "^\s*$" "$log" | tail -30
  exit 1
fi
# #eval output (a bounded search's counter-example list) arrives as info lines.
grep "^info:" "$log"
echo "PASS $dir: no errors, no sorry"
