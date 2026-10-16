# Human baseline kit

Turn a folder of human-played Gauntlet episodes into the per-tier numbers the
RHAE human baseline needs. The playing half is the human agent
(`gauntlet play --agent human` — see `agents/human.js`): a person plays at the
terminal, the recording verifies like any other trajectory, and this script
reports on the folder. **Report only — no scoring rule is read or changed.**

Why: Gauntlet's scoring follows ARC-AGI-3's RHAE, `S = min(1.15, (h/a)^2)`,
where `h` is a human baseline — ARC-AGI-2's rule that every task is "solved
pass@2 by at least two humans" (`docs/DESIGN.md` section 5). Gauntlet has been
substituting solver par for `h` because no person could play an episode at
all. This kit is the collection side: record people, verify, and read off the
solved fraction and the action counts against par.

## Usage

```sh
# A person (or a script standing in for one) plays one episode:
cd gauntlet
gauntlet play --game sokoban --tier one-box --agent human --out ~/human-runs/sokoban-one-box-0.json

# Verify the way any recording is verified:
gauntlet verify ~/human-runs

# The kit: verify again (same verifier) and report per tier:
node studies/human-baseline/report.mjs ~/human-runs
node studies/human-baseline/report.mjs ~/human-runs --json --out report.json
```

Paths may be trajectory files or directories (walked recursively; `run.json`,
`suite.json`, `leaderboard.json` and `_*` files are skipped, so `gauntlet run
--out` bundles and plain folders both work). Exit status is 1 when any
trajectory fails verification — failures are listed and contribute to no row.

## Columns

| column | meaning |
| --- | --- |
| `n` | verified episodes in the tier row |
| `solved` | fraction with `outcome.solved === true` (efficiency tiers; outcome tiers leave it unset — read their result from `meanScore`) |
| `meanScore` | mean of `outcome.normalized[agentSeat]` — the episode score exactly as the runner recorded it |
| `meanActions` | mean agent actions per episode, invalid attempts included — the same count scoring uses |
| `meanInvalid` | mean invalid attempts per episode |
| `par` | mean recorded par (efficiency tiers; `—` when the tier's outcomes carry none) |
| `actions/par` | mean of agentActions/par — 1.00 is par play, 2.00 twice par |

## Notes

- Verification is `verifyTrajectory` from `core/trajectory.js`, the same
  verifier `gauntlet verify` runs, so a folder that passes here passes there.
- The rows are measurements, not scores: what a *scored* human entry would
  earn depends on the floor-profile decision (#36) and on whether invalid
  replies count in win/lose games — both open; this kit stays out of them.
- A human run lands on the community track (the leaderboard keeps it out of
  the official table), and `human:<name>` records who played in the agent id.
