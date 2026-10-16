#!/usr/bin/env python3
"""Per-run statistics for the release board: invalid replies, forfeits, end
reasons, and per-tier solved fractions, split by scoring kind.

Reads the verified trajectory bundles under reports/release/runs/<run>/ and
emits markdown + JSON. The suite manifest supplies each tier's scoring kind so
efficiency-tier invalid counts are isolated exactly.
"""
import json, sys, glob, os

BASE = '/home/user/work/burst8-playkit-release-board/gauntlet/reports/release'
suite = json.load(open(f'{BASE}/suite.release.json'))
# tier scoring lookup: (gameId, tierId, seed) -> 'outcome' | 'efficiency'
kind = {}
for g in suite['games']:
    for t in g['tiers']:
        for seed in t['seeds']:
            kind[(g['id'], t['id'], seed)] = t['scoring']

runs = sys.argv[1:] or sorted(os.listdir(f'{BASE}/runs'))

def traj_files(run):
    pat = f'{BASE}/runs/{run}/*/*/*/*/*/*.json'
    return glob.glob(pat)

def game_of(f):
    parts = f.split('/')
    i = parts.index('runs')
    return parts[i + 2]

def tier_of(f):
    parts = f.split('/')
    i = parts.index('runs')
    return parts[i + 3]

out = {}
for run in runs:
    per_game = {}
    overall = {'episodes': 0, 'invalid': 0, 'agentActions': 0, 'forfeits': 0}
    for f in traj_files(run):
        d = json.load(open(f))
        g, t = game_of(f), tier_of(f)
        end = d.get('end', {})
        seat = d.get('agent', {}).get('seat', 0)
        agent_steps = [s for s in d.get('steps', []) if s.get('seat') == seat]
        inv = sum(1 for s in agent_steps if s.get('invalid'))
        aa = end.get('agentActions', len(agent_steps))
        reason = end.get('reason')
        outcome = end.get('outcome') or {}
        solved = outcome.get('solved')
        k = kind.get((d['game']['id'], t, d.get('seed')))
        row = per_game.setdefault(g, {
            'episodes': 0, 'invalid': 0, 'agentActions': 0, 'forfeits': 0,
            'solved': 0, 'efficiencyInvalid': 0, 'efficiencyActions': 0,
            'scoring': k, 'endReasons': {},
        })
        row['episodes'] += 1
        row['invalid'] += inv
        row['agentActions'] += aa
        row['endReasons'][reason] = row['endReasons'].get(reason, 0) + 1
        if solved:
            row['solved'] += 1
        if reason == 'forfeit-invalid':
            row['forfeits'] += 1
        if k == 'efficiency':
            row['efficiencyInvalid'] += inv
            row['efficiencyActions'] += aa
        overall['episodes'] += 1
        overall['invalid'] += inv
        overall['agentActions'] += aa
        if reason == 'forfeit-invalid':
            overall['forfeits'] += 1
    for g, row in per_game.items():
        row['invalidRate'] = round(row['invalid'] / row['agentActions'], 4) if row['agentActions'] else None
        row['solvedFraction'] = round(row['solved'] / row['episodes'], 4) if row['episodes'] else None
    overall['invalidRate'] = round(overall['invalid'] / overall['agentActions'], 4) if overall['agentActions'] else None
    out[run] = {'overall': overall, 'perGame': per_game}

json.dump(out, open('/tmp/release-stats.json', 'w'), indent=1, sort_keys=True)
for run in sorted(out):
    o = out[run]['overall']
    print(f"{run}: episodes {o['episodes']} invalid {o['invalid']} ({o['invalidRate']:.1%}) forfeits {o['forfeits']}")
    for g in sorted(out[run]['perGame']):
        row = out[run]['perGame'][g]
        eff = f" eff-invalid {row['efficiencyInvalid']}/{row['efficiencyActions']}" if row['scoring'] == 'efficiency' else ''
        print(f"  {g}: {row['episodes']} eps, invalid {row['invalid']} ({row['invalidRate']:.1%}), solved {row['solved']}/{row['episodes']}, ends {row['endReasons']}{eff}")
