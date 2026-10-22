# gauntlet/bridge/browser — real-Chromium bridge sessions

Proof that the PlayKit Gauntlet bridge works in a real browser, not a jsdom
stand-in: a vendored copy of gabrielecirulli/2048 runs in real Chromium, the
overlay attaches the way a user attaches it (the bookmarklet), the Gauntlet
agent plays through the overlay's own runtime, and every tile transition is
refereed by `gauntlet/bridge`.

This package is intentionally self-contained: it has its own `package.json`,
lockfile, and `node_modules` (Playwright is its only dependency), so the main
Gauntlet package stays dependency-free. `gauntlet/tsconfig.json` excludes its
`node_modules` and vendored tree.

## What a test run does

1. Builds the bookmarklet bundle with the repo's own zero-dependency bundler
   (`node scripts/build-phase0.js` → `dist/2048-hud.min.js`, entry
   `src/runtime/bookmarklet.js`). `dist/` is gitignored; nothing generated is
   committed.
2. Serves everything from one local server bound to `127.0.0.1` on an
   ephemeral port (tests make no network calls beyond this server):
   - `/2048/` — the vendored game, `vendor/PIN.md` records the pin;
   - `/2048-faulty/` — the same tree with exactly one line of
     `js/game_manager.js` patched (see `faulty-copy.mjs`);
   - `/bookmarklet/2048-hud.min.js` — the overlay bundle;
   - `/gauntlet/` — this repo's Gauntlet package, so the page can
     `import('/gauntlet/bridge/session.js')`.
3. Opens the page in headless Chromium, waits for the game to construct, then
   evaluates the bookmarklet from `src/bookmarklet/loader.js` (the exact
   string a user would paste, with `CDN_URL` pointed at the local server).
   Its script tag loads the bundle in the page's main world and
   `window.ai2048Runtime` appears — the overlay's real runtime.
4. Stops the runtime's own auto-play loop, keeps its driver, wires the
   Gauntlet engine in through `driver.setSolverEngine` (inside
   `playBridgeSession`), and steps the driver move by move. The referee
   checks every transition against the rules; the whole log is replayed by
   `verifyBridgeLog` at the end. Results return to Node through
   `page.exposeFunction('__bridgeReport', …)`.

## Tests

- `bridge-browser.tests.mjs`
  1. **Greedy baseline session** — 200-move cap on the vendored page; every
     move refereed, log verifies, divergence share and per-move latency
     reported.
  2. **Expectimax engine session** — same, with `baselines.engine({depth:2})`.
  3. **Fault check** — the tampered copy (`/2048-faulty/`) merges a tile twice
     in one move ([2,2,2] slides to [8] where the rules produce [4,2]). The
     session must stop at the referee (`endedWhy: "referee: …"`) on the first
     offending move, with `boardBefore`/`boardAfter` captured, and the replay
     must fail exactly at that step. The page's `Math.random` is pinned to a
     fixed seed for this test so the first offending move is reproducible.

## Running

```sh
cd gauntlet/bridge/browser
npm ci
npx playwright install chromium        # plus --with-deps on fresh machines
npm test
```

## Documented test conditions (no `src/` changes)

- **No touch input.** The harness runs a desktop-no-touch profile
  (`window.Touch`/`window.TouchEvent` set to `undefined` via `addInitScript`).
  The overlay adapter's touch fallback is a silent no-op there, exactly as on
  a desktop browser without touch, so each `sendMove` delivers exactly one
  keyboard move. Without this, a touch-capable Chromium would deliver each
  move twice (keyboard + synthetic touch) and every session would diverge
  immediately — a property of the overlay's adapter, documented here rather
  than patched around.
- **Auto-play quiesced.** The bookmarklet's `quickStart` starts the overlay's
  own solver loop. The harness stops it as soon as the runtime appears and
  records `preMoves` — how many moves (if any) the loop made before the
  Gauntlet session took over — in every report.
- **HUD visibility contract satisfied via prototype no-ops.** Found during
  this work: the overlay HUD (`src/hud/hud.js`) has no `pause()`/`resume()`,
  but `Runtime.init()` registers it with the `VisibilityHandler`, which
  throws in any real browser — the bookmarklet path never finishes
  initializing (no `window.ai2048Runtime`). jsdom tests never reach this
  registration. The harness installs non-enumerable no-op `pause`/`resume`
  on `Object.prototype` before page scripts run, so the HUD passes the
  capability check while the Driver keeps its real methods; a benchmark page
  is always visible, so correct HUD pause/resume would never fire anyway.
  This is a documented test condition, not a fix — the fix belongs in
  `src/hud/hud.js` and is out of scope here.
- **Adapter registry exposed via native ESM.** Found during this work: the
  repo's zero-dependency bundler (`scripts/build-phase0.js`) emits
  `export { X } from "./y.js"` as `exports.X = require(y).X` without a local
  binding for X, so `src/adapters/index.js` — whose own `detectGame()` calls
  `globalAdapterRegistry.detectAdapter()` — throws
  `ReferenceError: globalAdapterRegistry is not defined` in the built bundle
  in any real browser, and `Runtime.init` never completes. The harness first
  imports the overlay's unmodified sources via the browser's native ESM
  loader and exposes the real `globalAdapterRegistry` as the global the bare
  identifier resolves to. The registry is a stateless page scanner, so the
  adapter instance the runtime receives is equivalent to the one the bundled
  copy would have produced. Fixing the bundler belongs in
  `scripts/build-phase0.js` and is out of scope here.
- **WASM solver not hosted.** The bundle's WASM solver fetch resolves relative
  to the fixture page and 404s; `SolverManager` falls back to its built-in
  naive engine, exactly the degradation path the overlay ships for missing
  assets. Irrelevant to the benchmark: the Gauntlet engine replaces the
  driver's engine before the session starts.
- **Fault copy provenance.** The tampered page is served from the same pinned
  tree with the one-line patch applied at serve time, so the vendored
  directory stays byte-identical to upstream and the deviation is reviewable
  in `faulty-copy.mjs`.

## Model sessions (`model-session.mjs`)

A language model can sit behind the same choreography: `runBrowserModelSession`
runs the attachment path above unchanged, but the agent wired through
`driver.setSolverEngine` is a page-side proxy whose `act(ctx)` forwards the
turn context to Node over Playwright's `page.exposeFunction`. In Node, the
official-track agent (`harness/model-agent.js`, `provider: "openai-chat"`)
builds the official turn message and calls the OpenAI-compatible server on
`127.0.0.1`; the reply text travels back and the overlay path parses it
exactly like any official-track reply (`extractAction` → `parseAction`).

The model call runs in Node, not in the page, for two reasons: the page never
needs CORS access to the model server, and every call is logged in this
process with its latency and token usage (`modelTurns`, `modelLatencyMs`,
`totalPromptTokens` / `totalCompletionTokens` on the report). A model call
that fails after retries is recorded and becomes an empty reply — the driver
falls back, the step is logged with `chosen: null`, and the session continues.
The failed turn records the real retry count the client performed: the
provider client attaches `retries` to every throw (`retryError` in
`harness/model-agent.js`), so an exhausted retry storm records the exhausted
count and an immediately-failing non-retryable status records 0 — the report
never undercounts retries exactly on the failing turns where the count
matters, and `null` is reserved for throws that carry no count at all.

The session timeout (`timeoutMs`, default 600000) is enforced from Node, not
from the page: the session-driving `page.evaluate` runs detached and is raced
against the report channel and the timeout, so a model endpoint that stalls
forever settles the caller at `timeoutMs` (the stub-server test pins this —
the caller settles within roughly the timeout itself, not a generous
ceiling — and asserts no browser context is left open afterwards) and cleanup
still closes the wedged page.

Accounting on every report: `fallbacks` counts steps marked `agentMove: false`,
where the driver played its fixed fallback order after the model produced no
usable action. Those steps remain in `moves` and the session log, but
`agentMoves` and `diverged` exclude them. `verifyBridgeLog` confirms the fallback
direction and audits it like every other observed transition.

Tests: an offline fixture test replays a recorded real-model session log
(`fixtures/model-session-2048.json`) through `verifyBridgeLog`; the pure
report reductions and the full Playwright path are exercised by the default
suite against local stub servers (one stalled endpoint pinning the timeout
contract, one immediately-failing endpoint pinning error-turn recording, one
503-storm endpoint pinning that a failed turn records the retries the client
actually performed); the `gauntlet page` CLI path is exercised end to end by
subprocess tests (see below); the live-model tests are opt-in — skipped with
a named reason unless `GAUNTLET_LOCAL_CHAT_URL` and `GAUNTLET_LOCAL_CHAT_MODEL`
name the model server (serve commands in `harness/PROVIDERS.md`).

## `gauntlet page` — the CLI subcommand (`page-session.mjs`, `cli/page.js`)

`gauntlet page` is the CLI front door for everything above: it attaches any
Gauntlet agent — the same specs `gauntlet run` takes — to the vendored 2048
page through the overlay's own injection path, one move at a time under the
bridge referee, and writes the refereed session log into a run bundle.

```sh
gauntlet page --agent baseline:2048:greedy --out results/page-demo --seed 11111 --moves 200
gauntlet page --agent model:openai-chat/qwen3-4b --base-url http://127.0.0.1:8000 \
  --api-key-env OPENAI_API_KEY --out results/page-model
gauntlet bundle verify results/page-demo
```

Two agent kinds ride the page:

- **In-page baselines** (`baseline:2048:greedy|engine`): the page imports the
  baseline from the vendored Gauntlet package itself — the same choreography
  as `harness.mjs`'s `runBrowserSession`, with no Node round-trip per move.
- **A Node-side agent** (`random`, `model:<provider>/<model>`, dry-run
  scripted agents): `page-session.mjs` generalizes `model-session.mjs`'s
  proxy to any agent object with `act(ctx)` — the turn context crosses
  `page.exposeFunction` into Node, the reply crosses back, and the page
  needs no CORS access to anything. Model agents record their usage;
  `random` and scripted agents record latency with unreported counts, and
  unknown stays unknown — token totals read `unknown`, never 0.

The CLI writes `page/<seed>.json` (the `playkit-gauntlet-bridge-log/1`
session log) and `page/run.json` (provenance and the turn accounting) into
`--out`. The log is a refereed record, so it is auditable, not just a
story: `gauntlet bundle verify` replays every `page/*.json` through
`verifyBridgeLog` — standalone or alongside a `gauntlet run` bundle's
trajectories (reported separately; page sessions are unseeded and never
score). A referee-flagged move makes `gauntlet page` exit non-zero and the
bundle fail verification at exactly that move — demonstrated against the
tampered copy via `--url-path /2048-faulty/`.

`--seed` pins the page's `Math.random` for a reproducible session (the log
file is named by the seed); without it the page's own randomness plays and
the log is named by timestamp. `--timeout-ms` (default 600000) bounds the
whole session — a stalled model endpoint rejects within it instead of
hanging forever. The browser path lives in this nested package because
`playwright` resolves only from here; the main package stays dependency-free
and loads this module dynamically, only for `gauntlet page`.

Tests: subprocess end-to-end cases run the real CLI against the clean page
(bundle verifies), the tampered copy (exit non-zero, verification fails at
the offending step), and a stub OpenAI-compatible endpoint on `127.0.0.1`
(the bundle accounting sums the stub's token usage); offline cases in the
main package verify standalone page-session bundles and page sessions riding
a `gauntlet run` bundle from the recorded fixture log.
