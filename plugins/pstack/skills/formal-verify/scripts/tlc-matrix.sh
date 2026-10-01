#!/bin/bash
# Model-checks TLA+ specs with TLC over a matrix of constants read from a
# matrix file, and prints one PASS or FAIL line per run with its distinct
# state count. A failing run prints TLC's error and its counter-example
# reduced to the variables each step changed (tlc-trace.py).
#
# Matrix file, one directive per line (# starts a comment):
#   spec <path.tla>             the spec for the runs below, relative to the file
#   check <cfg line>            an INVARIANTS or PROPERTIES line, kept until the next spec
#   run <label> | <Name=Value ...>   one TLC run with those CONSTANTS
#
# Usage: tlc-matrix.sh <matrix-file> [label-substring]
#   TLC_JAR=<path>     use this tla2tools.jar instead of downloading TLA_VERSION
#   TLC_CACHE=<dir>    where the downloaded jar lives (default ~/.cache/tla)
#   JAVA=<path>        the java binary (default: java on PATH)
#   TLC_WORKERS=<n>    TLC worker threads (default auto)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TLA_VERSION=v1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
JAVA=${JAVA:-java}
TLC_WORKERS=${TLC_WORKERS:-auto}

matrix=${1:?usage: tlc-matrix.sh <matrix-file> [label-substring]}
only=${2:-}
MATRIX_DIR=$(cd "$(dirname "$matrix")" && pwd)

if ! "$JAVA" -version > /dev/null 2>&1; then
  echo "FAIL $JAVA has no runtime (on macOS /usr/bin/java is a stub; set JAVA=/opt/homebrew/opt/openjdk/bin/java)"
  exit 1
fi

if [ -z "${TLC_JAR:-}" ]; then
  TLC_CACHE=${TLC_CACHE:-$HOME/.cache/tla}
  TLC_JAR="$TLC_CACHE/tla2tools-$TLA_VERSION.jar"
  mkdir -p "$TLC_CACHE"
  if [ ! -f "$TLC_JAR" ]; then
    curl -LSf -o "$TLC_JAR.part" "https://github.com/tlaplus/tlaplus/releases/download/$TLA_VERSION/tla2tools.jar" \
      || { echo "FAIL download tla2tools.jar $TLA_VERSION"; exit 1; }
    mv "$TLC_JAR.part" "$TLC_JAR"
  fi
  SHA=$(command -v sha256sum || echo "shasum -a 256")
  got=$($SHA "$TLC_JAR" | cut -d' ' -f1)
  [ "$got" = "$TLA_SHA256" ] || { echo "FAIL $TLC_JAR has sha256 $got, want $TLA_SHA256"; exit 1; }
fi

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
fail=0
run=0
spec=""
checks=""

check_run() {
  local label=$1 consts=$2
  [ -n "$spec" ] || { echo "FAIL run '$label' before any spec line"; fail=1; return; }
  case $label in *"$only"*) ;; *) return ;; esac
  run=$((run + 1))
  local name
  name=$(basename "$spec" .tla)
  {
    echo "CONSTANTS"
    for c in $consts; do echo "  ${c%%=*} = ${c#*=}"; done
    echo "SPECIFICATION Spec"
    printf '%s\n' "$checks"
  } > "$OUT/MC.cfg"
  cp "$MATRIX_DIR/$spec" "$OUT/"
  # Modules the spec EXTENDS or INSTANCEs that live beside it.
  for dep in "$MATRIX_DIR/$(dirname "$spec")"/*.tla; do
    [ "$(basename "$dep")" = "$name.tla" ] || cp "$dep" "$OUT/" 2>/dev/null
  done
  if "$JAVA" -XX:+UseParallelGC -cp "$TLC_JAR" tlc2.TLC -workers "$TLC_WORKERS" -cleanup -metadir "$OUT/states-$run" \
      -config "$OUT/MC.cfg" "$OUT/$name.tla" > "$OUT/tlc.log" 2>&1 \
      && grep -q "No error has been found" "$OUT/tlc.log"; then
    echo "PASS $name $label $(grep -o '[0-9,]* distinct states found' "$OUT/tlc.log" | head -1)"
  else
    echo "FAIL $name $label: $(grep -m1 "^Error:" "$OUT/tlc.log")"
    grep "^Error:" "$OUT/tlc.log" | sed -n '2,5p'
    if grep -q "counter-example" "$OUT/tlc.log"; then
      python3 "$HERE/tlc-trace.py" "$OUT/tlc.log"
    else
      grep -v "^\s*$" "$OUT/tlc.log" | tail -40
    fi
    fail=1
  fi
}

while IFS= read -r line || [ -n "$line" ]; do
  line=${line%%#*}
  [ -n "${line// /}" ] || continue
  read -r kw rest <<< "$line"
  case $kw in
    spec) spec=$rest; checks="" ;;
    check) checks="$checks${checks:+$'\n'}$rest" ;;
    run) label=${rest%%|*}; check_run "${label% }" "${rest#*|}" ;;
    *) echo "FAIL unknown directive: $line"; fail=1 ;;
  esac
done < "$matrix"

[ "$run" -gt 0 ] || { echo "FAIL no run matched '$only'"; fail=1; }
exit $fail
