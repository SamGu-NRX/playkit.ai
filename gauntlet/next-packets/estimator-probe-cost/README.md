# Next packet: estimator probe cost and null low basis

Two rough edges observed running the estimator over the 7-game public suite
(104 jobs) before a 1.5B model run (`journeys/model/journey.sh`):

1. **Probe episodes can dominate wall clock.** The estimator plays engine
   baseline probe episodes on the chess-stockfish tiers (2 seeds each) to get
   a low basis. On the cmp_vTmuiAfy sandbox these probes took longer than the
   entire 104-episode model run that followed. A `--skip-probes` flag (with
   the estimate marked low-basis-only) would make the pre-run step practical
   on small boxes.
2. **Totals can null themselves.** Minesweeper and Mastermind have no low
   basis, so `estimate.json` totals come out as `callsLow: null, usdLow: null`
   even though every priced game has numbers. The summary row then shows "—"
   for the low side, and a reader can mistake "null" for "nothing was
   estimated". Consider reporting per-game rows always and totals as
   "high only" instead of nulling both sides.

Observed estimate-vs-actual after the run: high 11,916 calls vs 594 actual
(5.0% of the ceiling), per-game USD highs $1.11 vs $0.102 actual nominal.

Evidence: `/home/user/work/evidence-shots/ev-05-journey3-estimate-before.png`,
`/home/user/work/evidence-shots/ev-07-journey3-run-done.png` (out of repo).
