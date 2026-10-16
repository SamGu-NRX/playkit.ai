#!/usr/bin/env python3
"""Paired per-episode comparison: fixed (per-episode agent) run vs PR #43's run.

The leak-recheck study reran PR #43's model-separation suite on the
episode-isolation fix. This script pairs episodes by (game, seed) and splits
every difference into three classes, because the two heads also differ in
trajectory schema (#42's usage accounting adds token fields to steps):

- byte-identical: trajectories match after stripping machine fields
  (per-step ms, per-reply responseId, episode timestamps);
- schema-only: the JSON differs but the agent's reply sequence and the
  episode score are identical — the isolation fix changed nothing observable;
- behavioral: the reply sequence or the episode score differs.

Scores use the model-separation study's own episode_score, imported from
../model-separation/compute-stats.py so the two studies cannot drift.
Reports the pooled paired mean difference (fixed minus #43) with a paired
bootstrap 95% CI over the (game, seed) pairs, and per-game mean differences.

Usage: paired-diff.py RUNDIR_FIXED RUNDIR_43
"""

import importlib.util
import json
import random
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "mstats", HERE.parent / "model-separation" / "compute-stats.py")
mstats = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mstats)
episode_score = mstats.episode_score

STRIP_KEYS = {"ms", "responseId", "startedAt", "finishedAt"}


def strip(obj):
    if isinstance(obj, dict):
        return {k: strip(v) for k, v in obj.items() if k not in STRIP_KEYS}
    if isinstance(obj, list):
        return [strip(v) for v in obj]
    return obj


def load(run_dir):
    root = Path(run_dir)
    out = {}
    for f in sorted(root.glob("*/*/*/*/public/*.json")):
        t = json.load(open(f))
        key = f"{t['game']['id']}/{t['tier']}/{t['seed']}"
        agent_steps = [s for s in t["steps"] if s["by"] == "agent"]
        out[key] = {
            "traj": t,
            "score": episode_score(t),
            "replies": [(s.get("seat"), s.get("reply", {}).get("text")) for s in agent_steps],
            "calls": len(agent_steps),
            "invalid": sum(1 for s in agent_steps if s.get("invalid")),
        }
    return out


def main():
    fixed, orig = load(sys.argv[1]), load(sys.argv[2])
    keys = sorted(set(fixed) & set(orig))
    only_fixed = sorted(set(fixed) - set(orig))
    only_orig = sorted(set(orig) - set(fixed))
    rows, n_ident, n_schema = [], 0, 0
    for k in keys:
        a, b = fixed[k], orig[k]
        ta, tb = strip(a["traj"]), strip(b["traj"])
        if ta == tb:
            n_ident += 1
            cls = "identical"
        elif a["replies"] == b["replies"] and a["score"] == b["score"]:
            n_schema += 1
            cls = "schema-only"
        else:
            cls = "BEHAVIORAL"
        rows.append((k, b["score"], a["score"], a["score"] - b["score"], cls))
    behavioral = [r for r in rows if r[4] == "BEHAVIORAL"]

    print(f"paired episodes: {len(rows)}  identical: {n_ident}  "
          f"schema-only: {n_schema}  behavioral: {len(behavioral)}")
    print(f"unpaired: fixed-only {len(only_fixed)}  #43-only {len(only_orig)}")
    for k in only_fixed:
        print(f"  fixed-only {k}")
    for k in only_orig:
        print(f"  #43-only {k}")

    print("\nper-episode (score #43 -> fixed):")
    for k, e0, e1, d, cls in rows:
        print(f"  {k:52s} {e0:7.4f} -> {e1:7.4f}  ({d:+.4f})  {cls}")

    diffs = [r[3] for r in rows]
    if diffs:
        rng = random.Random(20261015)
        n = len(diffs)
        boots = sorted(sum(rng.choice(diffs) for _ in range(n)) / n for _ in range(10000))
        lo, hi = boots[int(0.025 * 9999)], boots[int(0.975 * 9999)]
        print(f"\npooled paired diff (fixed - #43): mean {statistics.fmean(diffs):+.4f} "
              f"95% CI [{lo:+.4f}, {hi:+.4f}] over {n} pairs")
        games = sorted({r[0].split('/')[0] for r in rows})
        print("per-game mean diff:")
        for g in games:
            gd = [r[3] for r in rows if r[0].split('/')[0] == g]
            print(f"  {g:12s} {statistics.fmean(gd):+.4f} (n={len(gd)})")
        calls_a = sum(fixed[k]["calls"] for k in keys)
        calls_b = sum(orig[k]["calls"] for k in keys)
        inv_a = sum(fixed[k]["invalid"] for k in keys)
        inv_b = sum(orig[k]["invalid"] for k in keys)
        print(f"agent calls: #43 {calls_b} -> fixed {calls_a}; "
              f"invalid replies: #43 {inv_b} -> fixed {inv_a}")
    sys.exit(0)


if __name__ == "__main__":
    main()
