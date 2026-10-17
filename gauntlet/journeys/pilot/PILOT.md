# Pilot journey — one-command capped frontier pilots, rehearsed without spend

Pilot tooling coordinates suite construction, estimates, dollar-capped resumable
evaluations, replay verification, scoring comparisons, and actual-versus-estimated
cost analysis. Local loopback stubs for Anthropic Messages, OpenAI Responses, and
OpenAI-compatible chat-completions APIs emulate provider replies, usage, and
common failures for no-spend rehearsals.

## Live pilot: `pilot.sh MODEL EFFORT MAX_USD [BASE_URL]`

Runs the full pilot for ONE model end to end. Without `BASE_URL` it calls the
real provider — it then requires the provider's API key in the environment
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) and refuses to start without it, so a
live run never half-starts unpaid. With `BASE_URL` it aims the model agent at
that root instead (rehearsals pass a `127.0.0.1` stub).

Steps, in the order of `reports/release/RUN-SEQUENCE.md`, capped and per model:

1. `suite build --split public --seeds-per-tier 1` — built on the current tree,
   and the script prints the current game/job count. The public split has grown
   since the release evidence was captured (the projection board records
   13 games / 49 jobs; the current tree carries 18 games / 76 jobs), so the
   count is reported live instead of pinned.
2. `estimate` — local probe episodes and tier pars; no API calls, no spend.
   Output lands in `runs/<model>-<stamp>/estimate/`.
3. `run --max-usd MAX_USD` — resuming with `--resume` until the bundle
   completes (each resume re-verifies finished trajectories and replays only
   what is missing; a failed episode is replayed, a completed one untouched).
   `PILOT_MAX_RESUMES` bounds the loop (default 10).
4. `verify` — replay-verify every trajectory in the bundle.
5. `leaderboard` under all three scoring profiles — rhae-v1,
   chance-adjusted, squared-outcome. Decision #36 (the floor profile) is an
   open call; publishing all three keeps it open rather than pre-deciding it.
6. `estimate --against` — what the run actually cost vs the estimate.

Every console transcript is teed under `runs/<model>-<stamp>/`.

### The dollar cap, precisely

The cap binds **per run invocation** on **settled spend**: a turn's cost only
counts once its provider call settles, and a turn that never settles (process
kill, unhandled provider error) is not billed against it — though the response
could still cost money. Worst case for the suite with cap C is roughly
C + (one turn) per invocation: the in-flight turn's worst-case quote, not its
settled cost, can land after the check. `quoteWorstCaseUsd` already reserves
the outstanding calls inside that accounting, so the overage is bounded by the
reservation, not by the whole run. The bound is enforced by the harness; the
provider-side hard limits are whatever the console budget is — the two are
independent and both worth setting for a real pilot.

Resume interacts with the cap in one way that matters: a cap stop unwinds the
**episode in flight** without writing it, and a resume replays that episode
from scratch. An episode whose full cost exceeds the cap can therefore never
finish under that cap — the resume-loop failure mode in `pilot.sh`
(`giving up after N invocations`) is the symptom; raise the cap. Episodes with
a `maxActions` budget in the thousands (2048's top tiers) are the ones that can
do this for real models that keep playing legally.

### Effort choice

`RUN-SEQUENCE.md` names no effort level. The rehearsals and the recommended
pilot use `high`: all three pilot models document a `high` level in their
capability rows, and it is the highest level common to Anthropic, OpenAI, and
the Gemini OpenAI-compatible wire, so one effort keeps the three runs
comparable without per-provider special-casing. Record the choice in any
leaderboard reporting.

## Rehearsal: `rehearse.sh MODEL [EFFORT] [PORT]`

One command, no spend, no keys: starts the matching loopback stub for the
model's wire (127.0.0.1 only, accepts any key), then runs `pilot.sh` against
it with a low cap (`REHEARSAL_MAX_USD`, default $1) chosen to bind mid-suite,
so the resume path is exercised rather than assumed. Stub fault rates (every
5th request 429 with `retry-after`, every 13th overloaded 529/503, every 11th
refusal, every 7th truncated reply) are set so one rehearsal meets every reply
shape a live run meets; override with `STUB_*_EVERY` variables (0 disables).

The stub replies are deliberately never a legal action in any registered game,
so every episode ends forfeit-invalid after exactly three priced calls — the
same ending a live model with format problems reaches. That bound is what lets
a low rehearsal cap bind and still finish: see the cap note above for why an
occasionally-legal stub reply would make the rehearsal unfinishable. A
rehearsal exercises plumbing (cap, resume, verify, leaderboards,
estimate-vs-actual, all three wires' reply shapes and faults), not play
quality.

## Stubs (`stubs/`)

- `anthropic.mjs` — POST `/v1/messages`, documented Anthropic Messages shape:
  thinking + text content blocks, `stop_reason` `end_turn` / `max_tokens`
  (truncated) / `refusal` with `stop_details`, `usage.input_tokens` /
  `usage.output_tokens` with `output_tokens_details.thinking_tokens`.
  Overload is HTTP 529 `overloaded_error`; rate limit is HTTP 429 with
  `retry-after`.
- `openai.mjs` — POST `/v1/responses`, documented Responses API shape:
  reasoning + message output items, `status` `completed` / `incomplete` with
  `incomplete_details.reason` `max_output_tokens`, refusal content part,
  `usage.input_tokens` / `usage.output_tokens` with
  `output_tokens_details.reasoning_tokens`. Overload is HTTP 503.
- `openai-chat.mjs` — POST `/v1/chat/completions`, the wire behind the
  `openai-chat` provider (how the Gemini OpenAI-compatible endpoint is
  reached): `choices[].message` with `content` and `reasoning_content`,
  `finish_reason` `stop` / `length` / refusal via `message.refusal`,
  `usage.prompt_tokens` / `usage.completion_tokens` with
  `completion_tokens_details.reasoning_tokens`. Overload is HTTP 503.

All three: loopback only, any API key accepted (the same contract the real
APIs have), prompt tokens derived from request size (bytes/4 + 50, the
conservative basis the estimate uses), fixed realistic output tokens with a
reasoning portion, one log line per request, and **never** an outbound
connection — a stub cannot spend, leak, or phone home.

## What a rehearsal proves

That the six pilot steps compose against each provider wire; that the dollar
cap binds mid-suite and `--resume` completes the bundle; that truncated,
refusal, 429 (with retry), and overload replies are handled per wire; that
`verify` accepts every produced trajectory; that all three scoring profiles
render; and that actual cost lands inside the estimate. It proves nothing
about model play quality — for that, run the live pilot.

## Outputs

`runs/` is git-ignored. Each rehearsal leaves: `suite.pilot.json`,
`estimate/`, `run/` (the verified bundle), `leaderboard/<profile>/`,
`run-N.console.txt` transcripts, `estimate-against.console.txt`, and the stub
log `stub-<port>.log` with one line per request.

## Known bounds the script applies (this base)

- **`estimate` does not exit here.** Its go-ladder probe episodes wedge — gnugo
  GTP children blocked, node never exits even after writing complete outputs —
  consistent with the GTP-client stale-reply bug the burst13 branch fixes.
  `ESTIMATE_TIMEOUT_SECS` (default 900) bounds step 2; outputs-present after a
  kill is treated as complete with a loud warning, orphaned gnugo instances are
  reaped, and estimate numbers are a scoping aid, never a gate.
- **`estimate --against` has the same non-exit hang.** The comparison table is
  fully printed to the console, then the process wedges. `ESTIMATE_AGAINST_TIMEOUT_SECS`
  (default 600) bounds step 6; a printed `| **Total** |` row counts as the
  deliverable.
- **`RUN_TIMEOUT_SECS`** (default 0 = off; rehearsals 600) bounds each `run`
  invocation so a wedged go episode cannot hang a live pilot forever; a killed
  invocation leaves the bundle exactly as `--resume` expects it.
- **Leaderboard profiles fail independently.** A stale committed scoring
  baseline makes the chance-rescaling profiles refuse a tier with the harness's
  actionable version error (correct behavior; the recal is sibling-owned). One
  profile refusing never loses the other two.

