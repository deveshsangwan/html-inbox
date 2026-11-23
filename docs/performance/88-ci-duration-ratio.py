"""Pair TAP durations between the failing and green Ubuntu Node 20 shard 2/2 logs.

Rule: strip ANSI codes; take top-level "ok N - name" / "not ok N - name" lines; read the
next duration_ms; key by test name (a repeated name keeps its last occurrence); keep pairs
whose green duration exceeds 50 ms. Usage: python3 -I 88-ci-duration-ratio.py RED_LOG GREEN_LOG
"""
import re
import statistics
import sys


def parse(path):
    text = re.sub(r"\x1b\[[0-9;]*m", "", open(path, errors="replace").read())
    lines = text.splitlines()
    durations = {}
    for index, line in enumerate(lines):
        match = re.match(r"^(?:not )?ok \d+ - (.*)$", line[29:])
        if not match:
            continue
        for following in lines[index + 1:index + 6]:
            found = re.search(r"duration_ms: ([\d.]+)", following)
            if found:
                durations[match.group(1)] = float(found.group(1))
                break
    return durations


red, green = parse(sys.argv[1]), parse(sys.argv[2])
pairs = [red[name] / green[name] for name in red if name in green and green[name] > 50]
print(f"pairs={len(pairs)} median_ratio={statistics.median(pairs):.3f}")
