#!/usr/bin/env python3
"""Compute the model-separation study's per-game statistics.

Reads the three model run directories (and the committed copies under runs/)
plus the leaderboard JSON, and emits stats.json with:
- per game and overall: each model's episode scores, mean, bootstrap 95% CI
  (recomputed here on episodes, matching the scoring rule for a single-tier
  game: outcome tiers take normalized[seat], efficiency tiers take
  min(solvedFraction, mean(par/agentActions)^2-capped)),
- invalid-reply rates, mean seconds per agent call, mean tokens per agent call,
- per-game seeds-per-tier needed to separate 1.5B from 7B: two-sample
  z-approximation n_per_group = 2 (z_{0.975})^2 s_p^2 / delta^2 with s_p the
  pooled per-episode SD and delta the observed 1.5B-vs-7B mean difference;
  floored at the observed 4 and reported as "infinite" when delta is 0.

The 7B run was split: sokoban wall-clock-blew the window (the 7B rambled to
the 4096-token reply cap at ~9 tok/s every turn), so the killed full-suite run
kept 16 verified episodes and minesweeper+cube came from a second bundle on
the same server and config. Model run directories therefore merge.
"""

import json
import glob
import math
import random
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Run root: argv[1] overrides, else the committed run bundles shipped beside
# this file. Nothing outside the checkout is read, so the statistics are
# reproducible from the study's own files (Codex P1 on PR #43).
RUNS = HERE / "runs"
MODELS = ["qwen2.5-0.5b", "qwen2.5-1.5b", "qwen2.5-7b"]
MODEL_RUN_DIRS = {
    "qwen2.5-0.5b": ["qwen2.5-0.5b"],
    "qwen2.5-1.5b": ["qwen2.5-1.5b"],
    "qwen2.5-7b": ["qwen2.5-7b", "qwen2.5-7b-part2"],
}
GAMES = ["tictactoe", "mastermind", "connect4", "sliding", "sokoban", "minesweeper", "cube"]
DRAW = 10000


def episode_score(t):
    """Episode score e for a one-tier game, matching scoring/score.js."""
    tier_scoring = {"tictactoe": "outcome", "mastermind": "efficiency",
                    "connect4": "outcome", "sliding": "efficiency",
                    "sokoban": "efficiency", "minesweeper": "outcome",
                    "cube": "efficiency"}[t["game"]["id"]]
    outcome = t["end"]["outcome"] or {}
    seat = t["agent"]["seat"]
    if tier_scoring == "outcome":
        return outcome["normalized"][seat]
    solved = outcome.get("solved") is True
    if not solved:
        return 0.0
    par = outcome["par"]
    actions = t["end"]["agentActions"]
    cap = 1.0 if outcome.get("parKind", "reference") == "optimal" else 1.15
    return min(cap, (par / actions) ** 2)


def load_model(model):
    """Merge every run directory recorded for a model into one per-game dict."""
    out = {}
    for run_name in MODEL_RUN_DIRS[model]:
        for f in glob.glob(str(RUNS / run_name / "*" / "*" / "*" / "*" / "public" / "*.json")):
            t = json.load(open(f))
            gid = t["game"]["id"]
            agent_steps = [s for s in t["steps"] if s["by"] == "agent"]
            usage = [s["usage"] for s in agent_steps if s.get("usage")]
            out.setdefault(gid, []).append({
                "seed": t["seed"],
                "e": episode_score(t),
                "invalid": sum(1 for s in agent_steps if s.get("invalid")),
                "calls": len(agent_steps),
                "ms": sum(s.get("ms") or 0 for s in agent_steps),
                "tok_in": sum(u.get("promptTokens") or u.get("inputTokens") or 0 for u in usage),
                "tok_out": sum(u.get("completionTokens") or u.get("outputTokens") or 0 for u in usage),
            })
    return out


def boot_ci(scores, rng):
    if not scores:
        return None
    draws = sorted(sum(rng.choice(scores) for _ in scores) / len(scores) for _ in range(DRAW))
    return (draws[int(0.025 * (DRAW - 1))], draws[int(0.975 * (DRAW - 1))])


def seeds_needed(a, b):
    """Per-group n to separate means a and b (z-approx, pooled SD)."""
    delta = abs(statistics.fmean(b["e"]) - statistics.fmean(a["e"]))
    if delta == 0:
        return math.inf
    pool = a["e"] + b["e"]
    if len(pool) < 3:
        return math.inf
    s = statistics.stdev(pool)
    if s == 0:
        return 4 if delta > 0 else math.inf
    n = 2 * (1.959964 ** 2) * (s ** 2) / (delta ** 2)
    return max(4, math.ceil(n))


def main():
    global RUNS
    if len(sys.argv) > 1:
        RUNS = Path(sys.argv[1])
    rng = random.Random(20261015)
    stats = {}
    for m in MODELS:
        per_game = load_model(m)
        all_e, all_calls, all_ms, all_inv, tin, tout, all_eps = [], 0, 0, 0, 0, 0, 0
        for g in GAMES:
            eps = per_game.get(g, [])
            if not eps:
                stats.setdefault(m, {})[g] = {"episodes": 0, "note": "not played (see REPORT.md)"}
                continue
            es = [x["e"] for x in eps]
            calls = sum(x["calls"] for x in eps)
            all_e += es
            all_calls += calls
            all_ms += sum(x["ms"] for x in eps)
            all_inv += sum(x["invalid"] for x in eps)
            tin += sum(x["tok_in"] for x in eps)
            tout += sum(x["tok_out"] for x in eps)
            all_eps += len(eps)
            stats.setdefault(m, {})[g] = {
                "episodes": len(eps),
                "mean": round(statistics.fmean(es), 6),
                "ci95": [round(v, 6) for v in boot_ci(es, rng)],
                "invalid_rate": round(sum(x["invalid"] for x in eps) / max(1, sum(x["calls"] for x in eps)), 6),
                "sec_per_call": round(sum(x["ms"] for x in eps) / 1000 / max(1, calls), 3),
                "tok_per_call": round(sum(x["tok_in"] + x["tok_out"] for x in eps) / max(1, calls), 1),
                "solved": sum(1 for x in eps if x["e"] > 0) if g in ("mastermind", "sliding", "sokoban", "cube") else None,
            }
        stats[m]["overall"] = {
            "episodes": all_eps,
            "mean": round(statistics.fmean(all_e), 6),
            "ci95": [round(v, 6) for v in boot_ci(all_e, rng)],
            "invalid_rate": round(all_inv / max(1, all_calls), 6),
            "sec_per_call": round(all_ms / 1000 / max(1, all_calls), 3),
            "tok_in_per_call": round(tin / max(1, all_calls), 1),
            "tok_out_per_call": round(tout / max(1, all_calls), 1),
        }
    seeds = {}
    ep15 = load_model("qwen2.5-1.5b")
    ep7 = load_model("qwen2.5-7b")
    for g in GAMES:
        a = stats["qwen2.5-1.5b"][g]
        b = stats["qwen2.5-7b"][g]
        if not ep15.get(g) or not ep7.get(g):
            seeds[g] = {"observed_gap": None, "seeds_per_tier": None,
                        "note": "comparison unavailable — a model has no episodes"}
            continue
        raw = seeds_needed({"e": [x["e"] for x in ep15[g]]},
                           {"e": [x["e"] for x in ep7[g]]})
        seeds[g] = {"observed_gap": round(b["mean"] - a["mean"], 6), "seeds_per_tier": raw}
    out = HERE / "stats.json"
    out.write_text(json.dumps({"per_model": stats, "seeds_per_tier_1p5_vs_7b": seeds}, indent=2) + "\n")
    print(f"wrote {out} (runs: {RUNS})")
    for m in MODELS:
        o = stats[m]["overall"]
        print(f"{m}: overall {o['mean']:.4f} CI{o['ci95']} invalid {o['invalid_rate']*100:.1f}% "
              f"{o['sec_per_call']}s/call ({o['episodes']} episodes)")
    for g, s in seeds.items():
        gap = s["observed_gap"]
        print(f"seeds {g}: gap {gap:+.4f} -> {s['seeds_per_tier']}" if gap is not None
              else f"seeds {g}: comparison unavailable")


if __name__ == "__main__":
    main()
