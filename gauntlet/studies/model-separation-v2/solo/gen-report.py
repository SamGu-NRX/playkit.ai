#!/usr/bin/env python3
"""Render RESULTS_TABLE + VERDICT for REPORT.md from stats.json (deterministic)."""
import json, sys

stats = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'studies/model-separation-v2/solo/stats.json'))
tier_order = [f"{t['game']}/{t['tier']}" for t in stats['tiers']]
shorts = [m['short'] for m in stats['models']]

lines = ["| Tier | Random mean (source) | " + " | ".join(f"{s} rhae-v1 (chance-adj) [n]" for s in shorts) + " |",
         "|---|---|" + "---|" * len(shorts)]
for t in tier_order:
    block = stats['perTier'][t]
    rnd = stats['random'][t]
    rnd_cell = "—" if rnd is None else f"{rnd['mean']:.4g} ({'calibration' if 'calibration' in rnd.get('source','') else 'study-local'}, n={rnd['episodes']})"
    cells = [rnd_cell]
    for s in shorts:
        pm = block['perModel'][s]
        if pm.get('episodes', 0) == 0:
            cells.append(pm.get('note', 'not played'))
            continue
        r = pm['scores']['rhae-v1']; c = pm['scores']['chance-adjusted']
        cells.append(f"{r['mean']:.4g} ({c['mean']:.4g}) [{r['episodes']}]")
    lines.append(f"| {t} | " + " | ".join(cells) + " |")
table = "\n".join(lines)

pool_lines = ["", "Pooled rhae-v1 episode means (all tiers):"]
for s in shorts:
    p = stats['pooled'][s]
    if p['episodes']:
        pool_lines.append(f"- {s}: {p['meanRhaeV1']:.4g} (95% CI [{p['ci95'][0]:.4g}, {p['ci95'][1]:.4g}], n={p['episodes']})")
    else:
        pool_lines.append(f"- {s}: not played")

so_lines = []
for t in tier_order:
    so = stats['perTier'][t]['sizeOrder']
    if so['spearmanRho'] is not None:
        so_lines.append(f"- {t}: Spearman(size, mean) = {so['spearmanRho']:.4g}, monotone-increasing = {so['monotoneIncreasing']}")

verdict = "## Verdict\n\n<!-- VERDICT -->"
print(table + "\n" + "\n".join(pool_lines) + "\n" + "\n".join(so_lines))
