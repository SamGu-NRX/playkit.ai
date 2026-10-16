base: alpha
title: [obvious-fleet] calib(gauntlet): go calibration at v1.0.0, current random baseline, and refusals that name their fix
draft: true
---

fleet-packet: burst14-playkit-calibration-sync

## What changed

Go can now be scored and ranked. The branch lands four things, each small and each load-bearing:

- **`gauntlet/calibration/tables/go.json` (+ meta)** — the first calibration table for go (v1.0.0). 144 episodes: 4 tiers × 12 public seeds × 3 baseline agents (random / greedy / engine) against GNU Go 3.8, 785.4 s, `capHit false`, 12 episodes per baseline/tier. Command: `node calibration/run.js --games=go`.
- **`gauntlet/scoring/baselines/random-public.json` regenerated** from all 18 committed tables via `node scoring/generate-baseline.js` (sha256 `6cd8b80f…`). First chance-adjusted entries for go, and the wordle baseline moved to the game's installed version 1.1.0. Until now every `leaderboard --scoring-profile chance-adjusted` run over the full registry refused; now it renders.
- **`gauntlet/calibration/REPORT.md` re-rendered** with `node calibration/render-report.js` from committed tables and metas — no games re-run. It carries go's section and go's five within-noise ordering findings (see the decisions section).
- **chance-adjusted refusal messages name their fix.** `baseline-tier-missing` and `baseline-version` in `gauntlet/scoring/score.js` now end with the command that resolves them: `node scoring/generate-baseline.js`, and — when a game has no entry at all, which usually means its calibration table is missing or stale too — `node calibration/run.js --games=<id>` first. Before: `…cannot rescale this tier`. After: `…cannot rescale this tier — regenerate the baseline with node scoring/generate-baseline.js`.
- **`gauntlet/next-packets/stale-tictactoe-baseline/` deleted.** That packet asked for two things: a regenerated baseline carrying tictactoe at its installed version, and a conformance check that fails when any committed baseline is older than its game. Both exist (PR #88's `versions-current.test.js`, merged in 55b740c, plus this packet's baseline regeneration), so the note is done.

`test/integration/versions-current.test.js` — the tripwire #88 left red — now passes at head: every benchmark game has a table at its installed version and a baseline measured on it.

## Why

PR #88 made the scoreboard refuse loudly whenever data drifted, and two things tripped it immediately: go had no table (the game registered in #85/#97 got no calibration run), and the wordle baseline was measured on v1.0.0 while the game is at v1.1.0. That is the tripwire doing its job. This packet does the work the tripwire names — measure go, regenerate the shared baseline — instead of weakening the check. The refusal-message change closes the same gap for the user-facing path: PR #86 (journey B) showed a user hitting `baseline-version` in the CLI and getting "a stale baseline cannot rescale this tier" with no next step. The suite failure and the CLI refusal now point at the same two commands.

## How it works

The loop this packet closes, end to end:

1. Register a game → calibrate it (`node calibration/run.js --games=<id>`).
2. Regenerate the scoring baseline (`node scoring/generate-baseline.js`) — re-derived from every committed table, never hand-edited.
3. `versions-current.test.js` verifies every table and baseline entry matches the installed game version (fails with a named list when not).
4. `leaderboard --scoring-profile chance-adjusted` rescales outcomes against the committed baseline; on drift it refuses, naming the repair command.

## Alternatives considered

- **Self-healing leaderboard** — regenerate a missing or stale baseline at scoring time instead of refusing. Rejected: a board that silently recomputes its own yardstick defeats the verify/salt posture; the refusal keeps which numbers rescaled which episodes auditable, and the regeneration command is now one line away.
- **CI cron to recalibrate on drift.** Rejected for this repo: it needs `.github/` workflows (kept out of the gauntlet on purpose — the no-CI decision is recorded as open), it burns ~80 CPU-min per night to catch a drift a deterministic unit test already catches exactly, and it would recalibrate games nobody asked about. The tripwire plus named commands is the same outcome with explicit human go/no-go per game.

## Verification

All on the branch at f50b3ea (typecheck and `npm ci` clean; GNU Go 3.8 and Stockfish 17.1 installed on the sandbox):

| Check | Command | Result |
|---|---|---|
| Tripwire red before work, green after | `node --test test/integration/versions-current.test.js` | red at alpha 45ded07 (2 findings: go table missing, wordle baseline 1.0.0 vs 1.1.0); `# pass 1 / # fail 0` at head (evidence/versions-current-after.txt) |
| Refusal tests red before fix, green after | `node --test scoring/score.test.js` | `not ok 20` at 262e70d (test only); `# tests 20 / # pass 20 / # fail 0` at head |
| New refusal text, live | `node -e` calling `score()` with a stale/missing baseline | `baseline-version` and `baseline-tier-missing` messages both end with the repair command (evidence/refusal-after-fix.txt); only score.js and its test reference the old wording |
| Go calibration run | `node calibration/run.js --games=go --report=/tmp/go-report.md` | EXIT=0; 144 episodes, 785.4 s, capHit false (tables/go.json.meta.json) |
| Report re-render | `node calibration/render-report.js` | 18 tables; 1 violation + 16 within-noise warnings; calibration tests `16/16` |
| Baseline regen | `node scoring/generate-baseline.js` | `wrote scoring/baselines/random-public.json (sha256 6cd8b80f…)` |
| End-to-end boards | `suite build --split public --seeds-per-tier 1` → `run --agent random` → three `leaderboard` renders | 76/76 episodes (8 engine episodes replayed after reinstalling the engines on a recycled sandbox), 0 invalid actions; rhae-v1 0.0416, chance-adjusted 0.0171, squared-outcome 0.0161 (evidence/lb-*.txt) |
| Full gauntlet suite | `npm test` (detached) | `# tests 961 / # pass 959 / # fail 0 / # skipped 2` (zstd sampler + opt-in live local model), EXIT=0 — with go included in calibration, scoring, and the registry for the first time |

History note: the task snapshot expected PR #88 open; on checkout it was already merged (55b740c), so this branch continues as the recorded work branch `obv/burst12-playkit-calibration-current`. `git merge origin/alpha` fast-forwarded (alpha 45ded07 already contains the branch's old tip 232f7d2), the branch tip is alpha + this packet's commits, and nothing was rebased or force-pushed. Because #88 is merged and this packet is new work, the description ships here per the fleet-packet flow; the maintainer opens the PR from this PR.md.

## Go's ordering findings (decision territory, reported not fixed)

All within noise at 12 seeds — the 95% intervals do not separate, so these are warnings in the report, not violations:

- greedy ≥ engine on ladder-1 (greedy 1 [1, 1] vs engine 0.75 [0.5, 1]), ladder-2, and ladder-4;
- random rises 0 → 0.25 and greedy rises 0.375 → 0.625 into ladder-4.

This is the same shape the go9 packet flagged for a full-seed recheck. Options from here: re-measure at more seeds (the report's own advice), or retune the ladder — both change tier parameters, which is a decision, not part of this packet. The one violation in the report, chess-puzzles b-monotonic at r1800, is pre-existing on alpha and outside this packet's allowed path list; flagged for its owner.

## What is not verified

- **No CI runs on gauntlet/ (open decision, untouched).** The full-suite line above is this sandbox's run, with the engines present; a machine without stockfish/gnugo sees those conformance suites skip with named install commands.
- **Bootstrap intervals on the proof suite are degenerate.** One episode per tier leaves nothing to resample, so every CI equals its point estimate. The 76-episode run demonstrates that the boards render, not interval quality; the committed tables (12 episodes/tier) carry the real intervals.
- **GNU Go cross-machine determinism is assumed, not re-verified.** The go engine arm replays history before each `genmove`; the run pins seeds, but byte-identical tables on a different GNU Go build were not re-run on a second box.
- **Cost columns read `unknown`** for the proof run — the random agent produces no usage by design.

## Risk

- The refusal-message change is additive text; nothing else in the repo matches the old wording (grep), but a script that string-matches the old exact message would break — it should match `GauntletRefusalError.step` instead.
- The regenerated baseline changes the file hash; existing run dirs record the previous `baselineSha256` and a chance-adjusted leaderboard that mixes entries across hashes refuses with `baseline-mismatch` (#36's guard working as designed). Re-score old runs with the current baseline file if needed.
- Chance-adjusted and squared-outcome rankings shift for wordle (baseline moved versions) and change entirely for go (new entries). No profile formula changed.

## Checklist

- [x] The scope is focused; related changes belong together
- [x] I explained what changed and why
- N/A before/after images — no UI change (CLI error text and data files only)
- N/A video — no motion or interaction change
