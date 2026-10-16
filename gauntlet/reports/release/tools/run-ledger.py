#!/usr/bin/env python3
"""Build the run-sequence ledger: per-run provenance from run.json files."""
import json, os

BASE = '/home/user/work/burst8-playkit-release-board/gauntlet/reports/release/runs'
rows = []
for run in sorted(os.listdir(BASE)):
    rp = f'{BASE}/{run}/run.json'
    d = json.load(open(rp))
    c = d['counts']
    rows.append((run, c['jobs'], c['played'], c['skipped'], c['replayed'], c['failed'],
                 d.get('agent', {}).get('id') or d.get('agent', {}).get('key') or d.get('agent', {}).get('spec') or '?'))
print('| run | jobs | played | reused (verified) | replayed | failed | agent |')
print('|---|---:|---:|---:|---:|---:|---|')
for r in rows:
    print(f'| {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]} | {r[5]} | `{r[6]}` |')
