# The frontier pilot runbook — one capped command, chosen suite

`pilot.sh` runs the frontier pilot for ONE model on ONE suite you name, end
to end, under a bundle-wide dollar cap. `separation-run.sh` runs the whole
preregistered separation pilot — the three frontier arms plus the free
random arm on the same suite — and prints the six comparisons with their
verdicts. `rehearse.sh` is `separation-run.sh --rehearse`: the identical
command against loopback stubs, no keys, no spend.

## The arguments are the decision

Every argument is required and none has a default:

```
./pilot.sh SUITE MODEL EFFORT CAP_USD CONCURRENCY [BASE_URL]
./separation-run.sh SUITE CAP_PER_ARM CONCURRENCY [--rehearse]
./rehearse.sh SUITE CAP_PER_ARM CONCURRENCY
```

`SUITE` is a suite manifest file — for the separation pilot, one of the
option files committed under `studies/separation-pilot/outputs/suites/`
(`suite.smallest-8.json`, `suite.larger-12.json`, `suite.pilot-1seed.json`).
The script never builds a suite silently: running a committed option file is
the preregistered choice, and a suite built ad hoc would not be. The options,
their seed/episode counts and their per-model dollar estimates are rendered
in `studies/separation-pilot/REPORT.md`. The budget decision — which option,
what cap — is #36 and stays open; these scripts execute the choice, they do
not make it. `EFFORT` is the reasoning effort (`high` is #102's recorded
choice, what `separation-run.sh` fixes). `CONCURRENCY` is the run's worker
count.

## The dollar cap, precisely

The cap you pass is **bundle-wide**. `pilot.sh` forwards it to
`gauntlet run --max-usd-total`, and the runner enforces it against the
bundle's spend ledger (`run/spend.jsonl`) — the record of every paid call
across every invocation, not just the current one. Resuming therefore cannot
multiply spend: ten resumes and one run draw on the same cap.

Mechanics (pinned by `runs/cap-unwind.test.js`, concurrency 1 and 3, and
documented at the cap stop in `runs/run.js`):

- Every admitted call reserves its worst-case quote (max output tokens at
  the model's price) before starting. Because settled + reserved can never
  pass the cap, **the ledger total never crosses it** — it can land exactly
  on it.
- The first admission that would not fit refuses **before the call starts**:
  a call the cap refuses is never charged. The run then sets
  `stopped: "budget"` and unwinds.
- **Every episode still in flight unwinds**: it ends without a trajectory
  and its already-settled calls are flushed into the ledger with
  `kept: false` — paid spend that stays on the books and is replayed on
  resume. At concurrency C that is up to C episodes' committed spend.
- **A finished episode's spend is always `kept: true`** — the attempt's flag
  is the trajectory-write result — and is never counted as unwound, even
  when the same episode's earlier attempt unwound and its replay finished.
- `run.json` reports the split: `ledger.totalUsd = keptUsd + unwoundUsd`,
  `ledger.unwoundCalls`, `ledger.cap`. The `resume` command replays the
  unwound episodes as new attempts; the pre-write dedupe and resume
  machinery already count nothing twice.

**Worst case paid-but-discarded at one cap stop** — money that leaves the
budget and buys no trajectory: the committed spend of the episodes in flight
at the stop, bounded by `min(concurrency × per-episode spend, cap)`. The
pre-flight line `pilot.sh` prints before the first paid call shows this
number for your cap and concurrency (per-episode spend taken as the
estimate's high side per job).

**Headroom guidance.** Pick a cap that clears the whole suite with room:
estimate-high (the pre-flight line shows it) **plus** a few
concurrency × per-episode-high. A cap that only matches the estimate grinds:
the run stops near the end, each resume advances a call or two while more
unwinds around it, and after `PILOT_MAX_RESUMES` (default 10) invocations the
script aborts loudly with work unplayed. A cap that cannot afford even one
call aborts immediately with the same loudness (`stopped=budget` with zero
calls this invocation). Both failures are messages, not spins — raise the
cap. The `$` amount at risk of being discarded at any ONE stop is still
bounded as above; it does not grow with the cap.

## Keys, wires, and what counts as live

`pilot.sh` reads each arm's key from **its own** variable and passes the
variable's name to the agent with `--api-key-env`; the key is read at call
time and never printed. A key is never taken from one provider's variable
and sent to another's host.

| Model | Wire | Key variable | Default base |
|---|---|---|---|
| `anthropic/*` | Anthropic Messages | `ANTHROPIC_API_KEY` | `https://api.anthropic.com` |
| `openai/*` | OpenAI Responses | `OPENAI_API_KEY` | `https://api.openai.com` |
| `openai-chat/gemini-*` | Gemini OpenAI-compatible | `GEMINI_API_KEY` | Google's OpenAI-compat endpoint (set by the script) |
| `openai-chat/<other>` | OpenAI chat completions | `OPENAI_API_KEY` | none — a live run refuses without `BASE_URL` |

A run is a **rehearsal only** when `BASE_URL` is loopback
(`http://127.0.0.1:*` / `http://localhost:*`): a dummy key is injected when
the arm's own variable is unset, and nothing is spent. Any other explicit
`BASE_URL` is live and is never called a rehearsal; no `BASE_URL` means live
against the provider's public API, which requires the arm's own key variable
and refuses to start without it.

`PILOT_REQUESTS_PER_MINUTE`, when set, is forwarded as
`--requests-per-minute` — use it if a provider's tier limits you.

## Rehearsal

`./rehearse.sh SUITE CAP_PER_ARM CONCURRENCY` = `separation-run.sh … --rehearse`.
It starts one stub per wire from `stubs/` on 127.0.0.1 (ports 8081/8082/8083,
Anthropic Messages / OpenAI Responses / Gemini chat-completions shapes), each
accepting any key and talking to nothing off-machine. The stubs return
plausible replies under injected faults — 429 with retry-after, 529/503 with
Retry-After, hard refusals, truncated JSON — at rates set so one rehearsal
meets every reply shape a live run meets; tune per stub with
`STUB_RATE_LIMIT_EVERY`, `STUB_OVERLOAD_EVERY`, `STUB_REFUSE_EVERY`,
`STUB_TRUNCATE_EVERY` (`0` disables).

Rehearsal cap arithmetic: the stubs' usage tokens price out far above a real
frontier call (they replay big token counts), so pass a cap that clears the
suite's job count generously — for the 76-job `suite.pilot-1seed.json`, $10
per arm finishes with all six comparisons printed, while a small cap (e.g.
$2) deliberately exercises the cap-stop/resume path and ends in the loud
abort. Both are useful; the completing one is the pre-flight green light.

The random arm and the preregistered analysis run exactly as live in a
rehearsal — pairing, bootstrap and verdicts included.

## What the scripts run, in order

`pilot.sh` (per model arm):

1. `gauntlet estimate --no-probes` — local: no API calls, no engines, no
   spend. Tier pars and calibration come from the committed tables; for a
   committed option the result matches that option's per-model estimate in
   `studies/separation-pilot/outputs/estimates/`. (Older runbooks timed this
   step because probe episodes ran go-ladder GTP probes; `--no-probes` drops
   the probes and the hang with them.)
2. Pre-flight line — jobs, estimate-high, cap, concurrency, worst-case
   discarded — printed **before** the first paid call.
3. `gauntlet run --max-usd-total CAP --concurrency C`, resuming with
   `--resume` until the bundle completes, each attempt summarized from
   `run.json` (`stopped`, `unplayed`, `failed`, invocation calls, ledger
   total vs cap). Aborts loudly on error, on zero-headroom, or after
   `PILOT_MAX_RESUMES`.
4. `gauntlet verify` — replay-verify every trajectory in the bundle.
5. `gauntlet leaderboard` under all three scoring profiles (`rhae-v1`,
   `_chance-adjusted`, `squared-outcome`) — profiles fail independently;
   which one is the published floor is decision #36 and stays open.
6. `gauntlet estimate --no-probes --against` — actual calls/tokens/dollars
   against the estimate's low and high.

`separation-run.sh`: the three model arms through `pilot.sh` (effort
`high`), then the free random arm on the same suite (`--agent random`, same
seeds, no cap needed), `verify` on its bundle, a per-arm ledger-vs-cap
summary, then `studies/separation-pilot/analyze.mjs` on the four bundles —
which replay-verifies and mirror-scores every trajectory, prints the six
preregistered comparisons (3 model-vs-model + 3 model-vs-random, paired by
seed) with pooled 95% seeded-percentile intervals and the
SEPARATED / NOT_SEPARATED verdicts, and exits 0 with the verdicts as data
either way.

Outputs: `separation-run.sh` writes everything under
`journeys/pilot/runs/separation-<suite>-<timestamp>/` (override with
`SEPARATION_RUN_OUT`; `pilot.sh` alone uses `runs/<model>-<timestamp>`,
override with `PILOT_OUT`). Each arm's directory holds its `run/` bundle,
estimate, leaderboards, per-attempt console transcripts; the analysis
transcript lands beside the arm directories.
