#!/usr/bin/env python3
"""Poll the qwen rerun until done; prints fresh episode count."""
import json, glob, sys
done = []
for f in glob.glob('/home/user/work/burst8-playkit-release-board/gauntlet/reports/release/runs/run-qwen/*/*/*/*/*/*.json'):
    d = json.load(open(f))
    if d['game']['id'] in ('tictactoe', 'cube', 'holdem') and d['finishedAt'] > '2026-10-16T08:05':
        done.append(f"{d['game']['id']}/{d['tier']} end={d['end']['reason']}")
print(len(done), sorted(done))
