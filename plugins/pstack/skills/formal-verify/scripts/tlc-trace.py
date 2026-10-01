#!/usr/bin/env python3
"""Reduce a TLC counter-example to what each step changed.

Reads a TLC log (a file argument or stdin), finds the behaviour after
"The following behavior constitutes a counter-example", and prints one block
per state: its number and action, then only the variables whose value
differs from the previous state. The first state prints every variable.
A "Back to state" line (a liveness lasso) is printed as is.

Usage: tlc-trace.py [tlc.log]
"""
import re
import sys

STATE = re.compile(r"^State (\d+): <(.*)>$|^State (\d+): (.*)$")
BACK = re.compile(r"^Back to state (\d+)")
VAR = re.compile(r"^/\\ (\w+) = (.*)$")


def parse(lines):
    """Yield (header, {var: value}) per state; header is the State line."""
    header, values, var = None, {}, None
    started = False
    for raw in lines:
        line = raw.rstrip("\n")
        if not started:
            started = "counter-example" in line
            continue
        if STATE.match(line) or BACK.match(line):
            if header is not None:
                yield header, values
            header, values, var = line, {}, None
            continue
        m = VAR.match(line)
        if m:
            var = m.group(1)
            values[var] = m.group(2)
        elif var is not None and line.startswith(" "):
            values[var] += "\n" + line
        elif not line.strip() and header is not None and values:
            yield header, values
            header, values, var = None, {}, None
    if header is not None:
        yield header, values


def main():
    src = open(sys.argv[1]) if len(sys.argv) > 1 else sys.stdin
    prev = {}
    for header, values in parse(src):
        m = STATE.match(header)
        if m:
            num = m.group(1) or m.group(3)
            action = (m.group(2) or m.group(4) or "").strip()
            action = re.sub(r" line \d+, col \d+ to line \d+, col \d+ of module \w+$", "", action)
            print(f"--- state {num}: {action}")
        else:
            print(f"--- {header}")
            continue
        for var, value in values.items():
            if prev.get(var) != value:
                print(f"    {var} = {value}")
        prev = values


if __name__ == "__main__":
    main()
