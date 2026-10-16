# Next packet: stale tictactoe scoring baseline blocks `chance-adjusted`

`node cli/gauntlet.js leaderboard --scoring-profile chance-adjusted` refuses at
alpha with:

```
error: [gauntlet/scoring/score.js] baseline-version: the scoring baseline for
"tictactoe" was measured on game version 1.1.0 but the trajectory
tictactoe/perfect-opponent/tictactoe/perfect-opponent/public/0 records game
version 1.2.0; a stale baseline cannot rescale this tier
```

Provenance (verified 2026-10-16 on a checkout of alpha at d016791):

- `games/tictactoe/index.js:142` declares `version: '1.2.0'`.
- `scoring/baselines/random-public.json` records tictactoe at `"version": "1.1.0"`
  (perfect-opponent tier, mean 0.0625, 8 episodes).
- Baseline commit: 84ce154 ("data(gauntlet): full 13-game recalibration,
  baseline, and rating ladder"). Bump commit: 0c5140a ("chore(gauntlet): bump
  tictactoe/holdem/cube for unbumped outcome and observation changes") — the
  game version moved to 1.2.0 without re-measuring the baseline.
- The same commit bumped holdem and cube; their baselines are presumably stale
  the same way (not exercised by the 7-game public suite).

Suggested fix: re-run the baseline calibration for tictactoe (and holdem/cube)
at their current versions, or regenerate `random-public.json` with the
calibration tables, and add a conformance check that fails when any committed
baseline version is older than its game's declared version.

`rhae-v1` and `squared-outcome` leaderboards are unaffected; observed with a
104-episode Qwen2.5-1.5B run over the 7-game public suite
(`journeys/model/` kit).

Evidence: `/home/user/work/evidence-shots/ev-08-journey3-leaderboards.png`
(out of repo; reproduced verbatim above).
