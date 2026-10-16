#!/usr/bin/env python3
"""Study statistics for the versus model-separation study.

Reads the two data files score-study.mjs wrote (profile-results.json,
episodes.json), the study-local baseline, and the committed calibration
tables, and writes stats.json:

- per (model, tier): the rhae-v1 mean with score()'s own 10k-draw seeded
  percentile-bootstrap CI, next to the tier's random mean and CI from its
  committed calibration table; squared-outcome and chance-adjusted means
  alongside; invalid-reply rate, seconds per call, tokens per call as their
  own columns (never folded into the score);
- per tier: whether each model beats random with separated intervals, and
  whether the size order is right (monotone point estimates 0.5B < 1.5B < 7B);
- paired-by-seed differences 1.5B minus 0.5B and 7B minus 1.5B per tier with
  10,000-draw percentile-bootstrap CIs (resampling seeds, keeping pairs);
- Spearman rho of model size against score per tier (tie-averaged ranks,
  None when degenerate).

Determinism: every resampling decision comes from a Mersenne Twister seeded
with an FNV-1a hash of its key string, so stats.json is byte-stable for the
same committed bundles. No wall-clock values are written anywhere.
"""

import json
import math
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
GAUNTLET = HERE / "../.."
CALIBRATION = GAUNTLET / "calibration/tables"
MODELS = ["0.5B", "1.5B", "7B"]
MODEL_PARAMS = {"0.5B": 0.5, "1.5B": 1.5, "7B": 7}
TIERS = [
    ("tictactoe", "random-opponent"),
    ("tictactoe", "blunder-opponent"),
    ("connect4", "ladder-1"),
    ("connect4", "ladder-0"),
]
PAIRS = [("1.5B", "0.5B"), ("7B", "1.5B")]
BOOTSTRAP_DRAWS = 10_000


def fnv1a(text):
    """32-bit FNV-1a hash of a UTF-8 string, as a non-negative int."""
    h = 0x811C9DC5
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def rng_for(key):
    return random.Random(fnv1a(key))


def percentile(sorted_values, q):
    """Percentile with linear interpolation, matching scoring/score.js."""
    if len(sorted_values) == 1:
        return sorted_values[0]
    pos = q * (len(sorted_values) - 1)
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return sorted_values[lo]
    return sorted_values[lo] + (pos - lo) * (sorted_values[hi] - sorted_values[lo])


def round6(v):
    return None if v is None else round(v * 1e6) / 1e6


def paired_boot_ci(diffs_by_seed, key):
    """10k-draw percentile-bootstrap 95% CI over paired per-seed differences."""
    seeds = sorted(diffs_by_seed)
    values = [diffs_by_seed[s] for s in seeds]
    rng = rng_for(key)
    n = len(values)
    draws = []
    for _ in range(BOOTSTRAP_DRAWS):
        acc = 0.0
        for _ in range(n):
            acc += values[rng.randrange(n)]
        draws.append(acc / n)
    draws.sort()
    return [round6(percentile(draws, 0.025)), round6(percentile(draws, 0.975))]


def average_ranks(values):
    indexed = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(indexed):
        j = i
        while j + 1 < len(indexed) and values[indexed[j + 1]] == values[indexed[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[indexed[k]] = avg
        i = j + 1
    return ranks


def spearman(scores):
    """Spearman rho of model size (1,2,3) against per-model scores.

    Tie-averaged ranks on the score side; None when degenerate (any model
    missing, or zero score variance so the correlation is undefined).
    """
    if len(scores) != 3 or any(s is None for s in scores):
        return None
    size_ranks = [1, 2, 3]
    score_ranks = average_ranks(scores)
    mean = sum(score_ranks) / 3
    var = sum((r - mean) ** 2 for r in score_ranks)
    if var <= 0:
        return None
    d2 = sum((score_ranks[i] - size_ranks[i]) ** 2 for i in range(3))
    return round6(1 - 6 * d2 / (3 * (9 - 1)))


def overlaps(a, b):
    return a[0] <= b[1] and b[0] <= a[1]


def calibration_random(game, tier):
    """The tier's random mean/CI/episodes from its committed calibration table."""
    table = json.loads((CALIBRATION / f"{game}.json").read_text())
    entry = table["baselines"]["random"]["tiers"][tier]
    return {
        "mean": entry["score"]["value"],
        "ci95": entry["score"]["ci95"],
        "episodes": entry["episodes"],
        "gameVersion": table["game"]["version"],
    }


def main():
    profiles = json.loads((HERE / "profile-results.json").read_text())
    episodes = json.loads((HERE / "episodes.json").read_text())

    groups = {(g["game"], g["tier"], g["model"]): g for g in profiles["groups"]}

    def group(game, tier, model):
        return groups.get((game, tier, model))

    def profile_scores(game, tier, model):
        g = group(game, tier, model)
        if g is None or g["scores"]["rhae-v1"]["value"] is None:
            return None
        return {p: g["scores"][p] for p in ("rhae-v1", "squared-outcome", "chance-adjusted")}

    # Per-episode index for pairing and process columns.
    ep_index = {}
    for e in episodes:
        if e["error"] is None:
            ep_index.setdefault((e["game"], e["tier"], e["model"]), {})[e["seed"]] = e

    tiers_out = []
    for game, tier in TIERS:
        cell = {"game": game, "tier": tier, "random": calibration_random(game, tier)}
        models_out = {}
        for model in MODELS:
            g = group(game, tier, model)
            scored = profile_scores(game, tier, model)
            eps = ep_index.get((game, tier, model), {})
            calls = sum(e["calls"] for e in eps.values()) if eps else 0
            invalid = sum(e["invalidCalls"] for e in eps.values()) if eps else 0
            ms = sum(e["secPerCall"] * e["calls"] for e in eps.values()) if eps else 0.0
            tok = sum(e["tokensPerCall"] * e["calls"] for e in eps.values()) if eps else 0.0
            models_out[model] = {
                "episodes": len(eps),
                "errors": g["nErrors"] if g else None,
                "mean": scored["rhae-v1"]["value"] if scored else None,
                "ci95": scored["rhae-v1"]["ci95"] if scored else None,
                "meanSquared": scored["squared-outcome"]["value"] if scored else None,
                "ci95Squared": scored["squared-outcome"]["ci95"] if scored else None,
                "meanChanceAdjusted": scored["chance-adjusted"]["value"] if scored else None,
                "ci95ChanceAdjusted": scored["chance-adjusted"]["ci95"] if scored else None,
                "invalidRate": round6(invalid / calls) if calls else None,
                "secPerCall": round6(ms / calls) if calls else None,
                "tokensPerCall": round6(tok / calls) if calls else None,
                "refusals": {p: g["scores"][p]["refusal"] for p in ("rhae-v1", "squared-outcome", "chance-adjusted") if g and g["scores"][p]["refusal"]},
            }
        cell["models"] = models_out

        # Verdict 1: does each model beat random with separated intervals?
        r = cell["random"]
        beats = {}
        for model in MODELS:
            m = models_out[model]
            if m["mean"] is None:
                beats[model] = None
                continue
            lo_model, hi_model = m["ci95"]
            separated = lo_model > r["ci95"][1] or hi_model < r["ci95"][0]
            beats[model] = {
                "separated": separated,
                "above": m["mean"] > r["mean"] and not overlaps(m["ci95"], r["ci95"]),
            }
        cell["beatsRandom"] = beats

        # Verdict 2: is the size order right (monotone in point estimates)?
        means = [models_out[m]["mean"] for m in MODELS]
        if any(v is None for v in means):
            cell["sizeOrderMonotone"] = None
        else:
            cell["sizeOrderMonotone"] = means[0] < means[1] < means[2]
        cell["spearmanSizeVsScore"] = spearman(means)

        # Paired-by-seed differences under rhae-v1.
        pairs_out = {}
        for big, small in PAIRS:
            a = ep_index.get((game, tier, big), {})
            b = ep_index.get((game, tier, small), {})
            shared = sorted(set(a) & set(b))
            diffs = {s: a[s]["profiles"]["rhae-v1"] - b[s]["profiles"]["rhae-v1"] for s in shared}
            if diffs:
                mean_diff = sum(diffs.values()) / len(diffs)
                pairs_out[f"{big}-minus-{small}"] = {
                    "nPairs": len(diffs),
                    "mean": round6(mean_diff),
                    "ci95": paired_boot_ci(diffs, f"{game}/{tier}/{big}-minus-{small}"),
                    "separated": pairs_separated(diffs, paired_boot_ci(diffs, f"{game}/{tier}/{big}-minus-{small}")),
                }
            else:
                pairs_out[f"{big}-minus-{small}"] = {"nPairs": 0, "mean": None, "ci95": None, "separated": None}
        cell["pairedDiff"] = pairs_out
        tiers_out.append(cell)

    # Pooled across the four tiers (all outcome tiers, so episode scores pool
    # directly under rhae-v1).
    pooled = {}
    for model in MODELS:
        scores = []
        for (game, tier) in TIERS:
            eps = ep_index.get((game, tier, model), {})
            scores.extend(e["profiles"]["rhae-v1"] for e in eps.values())
        if scores:
            rng = rng_for(f"pooled/{model}")
            n = len(scores)
            draws = []
            for _ in range(BOOTSTRAP_DRAWS):
                acc = 0.0
                for _ in range(n):
                    acc += scores[rng.randrange(n)]
                draws.append(acc / n)
            draws.sort()
            pooled[model] = {
                "episodes": n,
                "mean": round6(sum(scores) / n),
                "ci95": [round6(percentile(draws, 0.025)), round6(percentile(draws, 0.975))],
            }
        else:
            pooled[model] = {"episodes": 0, "mean": None, "ci95": None}
    pooled_means = [pooled[m]["mean"] for m in MODELS]
    stats = {
        "format": "playkit-gauntlet-study-model-separation-v2-versus-stats/1",
        "models": MODELS,
        "modelParamsB": MODEL_PARAMS,
        "baseline": profiles["baseline"],
        "tiers": tiers_out,
        "pooled": {
            "models": pooled,
            "sizeOrderMonotone": None if any(v is None for v in pooled_means) else pooled_means[0] < pooled_means[1] < pooled_means[2],
            "spearmanSizeVsScore": spearman(pooled_means),
        },
    }
    (HERE / "stats.json").write_text(json.dumps(stats, indent=1) + "\n")
    print(f"wrote {HERE/'stats.json'}")
    for cell in tiers_out:
        row = " ".join(
            f"{m}={cell['models'][m]['mean'] if cell['models'][m]['mean'] is not None else 'n/a'}"
            for m in MODELS
        )
        print(f"  {cell['game']}/{cell['tier']}: random={cell['random']['mean']} {row} spearman={cell['spearmanSizeVsScore']}")
    print("pooled: " + " ".join(f"{m}={pooled[m]['mean']}" for m in MODELS))


def pairs_separated(diffs, ci):
    """A paired difference separates from zero when its CI excludes 0."""
    if ci is None:
        return None
    return ci[0] > 0 or ci[1] < 0


if __name__ == "__main__":
    main()
