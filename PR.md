base: alpha
title: [obvious-fleet] Fix review findings: misc — fresh stage-C pilot dir + kernel-assigned stub ports
draft: true
---
fleet-packet: burst17-playkit-review2-misc

Two review findings from the burst17 review2 sweep, fixed fail-first on `obv/burst17-playkit-review2-misc` (base alpha `c70b4d8`, 2 commits). The other two packet findings are already fixed on alpha by earlier merged PRs — confirmation replies posted on their threads.

## Fixes

### 1. Release checks inherit earlier spend (PR #114, P1) — fixed `cd9e9c1`

Stage C always wrote the rehearsal to a fixed `$WORK/pilot`, and the default `$WORK` survives between invocations. A results bundle's spend ledger (`spend.jsonl`) is bundle-wide and read on every run invocation — resume or not — so each repeated release check inherited every earlier check's recorded spend against the same cap, until a healthy rehearsal died on `pilot.sh`'s no-headroom guard.

Each stage-C invocation now allocates a fresh directory under `$WORK` with `mktemp -d`.

**Demonstrated live** (cap $2, reused `JOURNEY_WORK`): the old script's second check resumed the first check's bundle — ledger carried forward at $1.417, each attempt played 1 call, gave up after 10 invocations with 13 unplayed (`FAIL: journey C`). The fixed script on the same directory opened a fresh bundle and its attempt 1 played 189 calls ($1.346 from a zero ledger).

**Fail-first test:** `gauntlet/test/journeys/release-stage-c.test.js` — asserts exactly one `SEPARATION_RUN_OUT` site with an `mktemp -d` allocation in its block; fails on the fixed-path assignment (verified against pristine alpha), passes on the branch.

### 2. Selected ports can be taken (PR #114, P2) — fixed `f2a064e`

The rehearsal allocated each stub's port with a bind-probe that closed its listener before the stub started — another process could take the port in that window, and the losing stub died on `EADDRINUSE` and aborted the rehearsal. Two stubs could also probe-allocate the same port.

Each stub now binds port 0 itself and writes the kernel-assigned port to a `--port-file`; the launcher reads the assigned port from the file. The port is assigned at bind time and held by the stub for its whole life — no window, no collision. `--port 0` without `--port-file` refuses loudly naming `--port-file`; an explicit fixed port keeps working.

**Fail-first tests:** `gauntlet/test/journeys/separation-stubs.test.js` (ephemeral bind + report + ping, two concurrent stubs get distinct ports, loud refusal, script syntax) — 3 of 4 fail on pristine alpha (the stub cannot start under `--port 0`; the refusal message does not name `--port-file`), 4 of 4 pass on the branch.

## Disposition

| # | Finding | Thread | Disposition |
|---|---------|--------|-------------|
| 1 | Quote the full cost of every assisted retry (PR #117, P1) | https://github.com/SamGu-NRX/playkit.ai/pull/117#discussion_r4304947611 | Already fixed on alpha: `b42e4cf` in merged PR #117 (merge `c70b4d8`). Reply posted (r4305387923). Re-verified this session: focused 56/56 on alpha incl. the quote-bounding tests. |
| 2 | Retire the stale example-confound patch target (PR #108, P1) | https://github.com/SamGu-NRX/playkit.ai/pull/108#discussion_r4301707766 | Already fixed on alpha: `ccf1bf2` in merged PR #111 (merge `c7351f3`) — test rewritten split-by-guard, 1.0.0 observation reconstructed and hash-certified against the committed study trajectory, live-drift guard added. Reply posted this session. Re-verified: 12/12 on alpha. |
| 3 | Release checks inherit earlier spend (PR #114, P1) | https://github.com/SamGu-NRX/playkit.ai/pull/114#discussion_r4304977608 | Fixed in this packet: `cd9e9c1` + fail-first test + live before/after demonstration. Reply posted. |
| 4 | Selected ports can be taken (PR #114, P2) | https://github.com/SamGu-NRX/playkit.ai/pull/114#discussion_r4304977613 | Fixed in this packet: `f2a064e` + fail-first tests. Reply posted. |

## Verification

- Baseline (pristine alpha `c70b4d8`): full suite 1162 tests / 1159 pass / 0 fail / 3 skip, EXIT 0; typecheck EXIT 0.
- Branch: focused new tests 5/5; focused already-fixed confirmations 56/56 (assisted + model-agent) and 12/12 (patch-example-agent); typecheck EXIT 0.
- Full suite + typecheck on branch head `f2a064e`: 1167 tests / 1164 pass / 0 fail / 3 skip, EXIT 0 (+5 = this packet's new tests, all passing over the 1162/1159/0/3 baseline); typecheck EXIT 0.
- Stage-C rehearsal exercised end to end with the new port mechanism (three stubs on kernel-assigned ports, four arms, stub-replies only — zero paid calls).

Zero paid API calls throughout (stubs on loopback; no keys set).

Human author: Sam Gu (sgu07966@gmail.com)

🔗 [Obvious Project](https://app.obvious.ai/p/agent-tools-PQyawTQb) · 🧵 [Obvious Thread](https://app.obvious.ai/p/agent-tools-PQyawTQb?thread=th_mJYKzIMz) · 🔀 [Obvious PR Artifact](https://app.obvious.ai/link/pr-artifact/fix-review-findings-misc-task:todo_6IUrwten)
