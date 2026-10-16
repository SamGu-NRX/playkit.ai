#!/usr/bin/env python3
"""Compare two Gauntlet run bundles episode by episode, ignoring timing.

The leak-recheck study's determinism control (see REPORT.md) reruns PR #43's
0.5B suite on #43's own head with #43's exact serving setup and compares the
rerun's trajectories with the committed ones. Under temperature 0 with a fixed
server seed, everything except wall-clock provenance should reproduce
byte-for-byte. Fields that measure the machine, not the model, are stripped
before comparison:

- `ms` anywhere in the tree (per-step and per-opponent-move latency),
- `responseId` (the server's per-reply id, unique every call),
- `startedAt` / `finishedAt` (top-level episode timestamps),
- `git.commit` and `node` in run.json (rerun tree vs original tree).

Everything else — reply text, actions, token usage, observation hashes,
outcomes — must match. Usage: compare-runs.py RUNDIR_A RUNDIR_B.
"""

import json
import sys
from pathlib import Path

STRIP_KEYS = {"ms", "responseId", "startedAt", "finishedAt"}


def strip(obj):
    if isinstance(obj, dict):
        return {k: strip(v) for k, v in obj.items() if k not in STRIP_KEYS}
    if isinstance(obj, list):
        return [strip(v) for v in obj]
    return obj


def trajectories(run_dir):
    root = Path(run_dir)
    out = {}
    for f in sorted(root.glob("*/*/*/*/public/*.json")):
        rel = str(f.relative_to(root))  # <game>/<tier>/<game>/<tier>/public/<seed>.json
        out[rel] = json.load(open(f))
    return out


def main():
    a_dir, b_dir = sys.argv[1], sys.argv[2]
    a, b = trajectories(a_dir), trajectories(b_dir)
    keys = sorted(set(a) | set(b))
    mismatches = []
    missing = [k for k in keys if k not in a or k not in b]
    for k in keys:
        if k not in a or k not in b:
            continue
        na, nb = strip(a[k]), strip(b[k])
        if na != nb:
            # Name the first differing step field so the report can say what moved.
            diffs = []
            sa = {s.get("seat"): s for s in na.get("steps", []) if s.get("by") == "agent"}
            sb = {s.get("seat"): s for s in nb.get("steps", []) if s.get("by") == "agent"}
            if set(sa) != set(sb):
                diffs.append(f"agent-step count {len(sa)} vs {len(sb)}")
            else:
                for seat in sorted(sa):
                    if sa[seat] != sb[seat]:
                        fa = sa[seat].get("reply", {}).get("text")
                        fb = sb[seat].get("reply", {}).get("text")
                        diffs.append(f"seat {seat}: reply {fa!r} vs {fb!r}"
                                     if fa != fb else f"seat {seat}: other field")
            mismatches.append((k, "; ".join(diffs[:2])))
    print(f"episodes: {len(keys)} compared, {len(missing)} present in only one bundle, "
          f"{len(mismatches)} mismatched")
    for k, why in mismatches:
        print(f"MISMATCH {k}: {why}")
    for k in missing:
        print(f"MISSING {k} (in {'B' if k in b else 'A'} only)")
    only_a = {k for k in a} - set(keys)
    ra = strip(json.load(open(Path(a_dir) / "run.json"))) if (Path(a_dir) / "run.json").exists() else None
    rb = strip(json.load(open(Path(b_dir) / "run.json"))) if (Path(b_dir) / "run.json").exists() else None
    if ra and rb:
        for field in ("calls", "counts", "limits", "agent", "concurrency"):
            if ra.get(field) != rb.get(field):
                print(f"run.json differs on {field}: {json.dumps(ra.get(field))[:200]} vs "
                      f"{json.dumps(rb.get(field))[:200]}")
    rate = len(mismatches) / max(1, len(keys))
    print(f"mismatch rate: {len(mismatches)}/{len(keys)} = {rate:.3f}")
    sys.exit(0 if not mismatches and not missing else 1)


if __name__ == "__main__":
    main()
