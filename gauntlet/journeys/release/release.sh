#!/usr/bin/env bash
# gauntlet/journeys/release/release.sh — replay the release journeys in order
# and exit non-zero on the first failure:
#
#   A  researcher, terminal      -> journeys/cli/journey.sh (install, episodes,
#                                   suite, model, rate_serve, errors)
#   C  frontier readiness        -> a local Anthropic-wire stub; a capped
#                                   --concurrency 4 run with
#                                   model:anthropic/claude-opus-5-5; spend
#                                   asserted <= the cap; wire body recorded
#   D  Go                        -> if Go is registered, play its on-ramp tier
#                                   and one GNU Go tier; if not registered,
#                                   record the skip and move on (not a failure)
#
# Usage:
#   bash gauntlet/journeys/release/release.sh                 # A, C, D
#   RELEASE_STAGES="C" bash gauntlet/journeys/release/release.sh
#
# Environment:
#   JOURNEY_WORK     scratch dir (default: ${TMPDIR:-/tmp}/gauntlet-release)
#   RELEASE_MAX_USD  journey-C cap (default 1)
#   RELEASE_REASONING_EFFORT  passed to journey C when set (empty default:
#                    pre-#80 trees refuse effort for anthropic; post-#80 trees
#                    accept it — the script passes it only when explicitly set)
#   GAUNTLET_STOCKFISH detected automatically, passed per command (never global)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAUNTLET_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$GAUNTLET_DIR"

WORK="${JOURNEY_WORK:-${TMPDIR:-/tmp}/gauntlet-release}"
mkdir -p "$WORK"
GAUNTLET="node cli/gauntlet.js"
run_gauntlet() { node cli/gauntlet.js "$@"; }
MAX_USD="${RELEASE_MAX_USD:-1}"

fail() { echo "FAIL: $*" >&2; exit 1; }

STOCKFISH_BIN="${GAUNTLET_STOCKFISH:-}"
if [ -z "$STOCKFISH_BIN" ]; then
  for candidate in /usr/games/stockfish /usr/bin/stockfish; do
    [ -x "$candidate" ] && STOCKFISH_BIN="$candidate" && break
  done
fi
echo "release.sh: stockfish=${STOCKFISH_BIN:-none} work=$WORK max_usd=$MAX_USD"

STAGES="${RELEASE_STAGES:-A C D}"

# --- Journey A: the researcher's terminal journey, replayed end to end -------
if [[ " $STAGES " == *" A "* ]]; then
  echo "=== journey A: researcher terminal (journeys/cli/journey.sh)"
  JOURNEY_WORK="$WORK/journey-a" bash journeys/cli/journey.sh install episodes suite model rate_serve errors \
    || fail "journey A (journeys/cli/journey.sh)"
  echo "=== journey A: PASS"
fi

# --- Journey C: frontier readiness against a local Anthropic-wire stub -------
if [[ " $STAGES " == *" C "* ]]; then
  echo "=== journey C: frontier readiness (local Anthropic wire stub)"
  STUB="$WORK/stub-anthropic.mjs"
  cat > "$STUB" <<'STUBEOF'
import http from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
const [wireLog, urlFile] = process.argv.slice(2);
let served = 0;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    served += 1;
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    appendFileSync(wireLog, JSON.stringify(body) + '\n');
    const last = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : null;
    let text = typeof last?.content === 'string' ? last.content
      : Array.isArray(last?.content) ? last.content.map((b) => b?.text ?? '').join('\n') : '';
    const m = /Legal actions \(\d+[^)]*\): ([a-z0-9, ]+)/.exec(text);
    const reply = m ? `action: ${m[1].split(',')[0].trim()}` : 'action: a1';
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `msg_stub_${served}`, type: 'message', role: 'assistant',
        model: body.model ?? 'claude-opus-5-5',
        content: [{ type: 'text', text: reply }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 280 + served, output_tokens: 5 },
      }));
    }, 30);
  });
});
server.listen(0, '127.0.0.1', () => writeFileSync(urlFile, `http://127.0.0.1:${server.address().port}`));
STUBEOF

  CWORK="$WORK/journey-c"
  rm -rf "$CWORK"; mkdir -p "$CWORK"
  node "$STUB" "$CWORK/wire.jsonl" "$CWORK/url" > "$CWORK/stub.log" 2>&1 &
  STUB_PID=$!
  cleanup_stub() { kill "$STUB_PID" 2>/dev/null || true; }
  trap cleanup_stub EXIT
  for _ in $(seq 1 40); do [ -s "$CWORK/url" ] && break; sleep 0.2; done
  [ -s "$CWORK/url" ] || { cleanup_stub; fail "journey C: stub did not start"; }
  BASE_URL="$(cat "$CWORK/url")"

  cat > "$CWORK/prices.json" <<'PRICESEOF'
{
  "anthropic/claude-opus-5-5": {
    "inputPerMTok": 5,
    "outputPerMTok": 25,
    "source": "nominal opus-class rates against a local wire stub (no external spend)",
    "checked": "2026-10-16"
  }
}
PRICESEOF

  run_gauntlet suite build --split public --games tictactoe,minesweeper \
    --seeds-per-tier 2 --out "$CWORK/suite.json" \
    || { cleanup_stub; fail "journey C: suite build"; }

  EFFORT_ARGS=()
  [ -n "${RELEASE_REASONING_EFFORT:-}" ] && EFFORT_ARGS=(--reasoning-effort "$RELEASE_REASONING_EFFORT")

  ANTHROPIC_API_KEY=stub-local run_gauntlet run --suite "$CWORK/suite.json" \
    --agent model:anthropic/claude-opus-5-5 --base-url "$BASE_URL" \
    --concurrency 4 --max-usd "$MAX_USD" --max-output-tokens 512 \
    --call-timeout-ms 30000 --prices "$CWORK/prices.json" \
    "${EFFORT_ARGS[@]+"${EFFORT_ARGS[@]}"}" \
    --out "$CWORK/run/" \
    || { cleanup_stub; fail "journey C: capped model run"; }

  run_gauntlet bundle verify "$CWORK/run/" \
    || { cleanup_stub; fail "journey C: bundle verify"; }

  node - "$CWORK/run/run.json" "$MAX_USD" <<'SPENDEOF' || { cleanup_stub; fail "journey C: spend exceeded the cap"; }
const j = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const spend = Number(j.spendUsd ?? 0);
const cap = Number(process.argv[3]);
console.log(`journey C: spend ${spend} <= cap ${cap}`);
if (!(spend <= cap)) process.exit(1);
SPENDEOF

  # Record the wire shape the CLI sent (informational).
  if [ -s "$CWORK/wire.jsonl" ]; then
    node - "$CWORK/wire.jsonl" <<'WIREEOF'
const first = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8').split('\n')[0]);
console.log(`journey C wire: keys=${Object.keys(first).join(',')} thinking=${JSON.stringify(first.thinking ?? null)} effort=${JSON.stringify(first.effort ?? first.reasoning_effort ?? first.reasoning ?? null)}`);
WIREEOF
  fi
  cleanup_stub
  trap - EXIT
  echo "=== journey C: PASS"
fi

# --- Journey D: Go, if registered --------------------------------------------
if [[ " $STAGES " == *" D "* ]]; then
  echo "=== journey D: Go"
  if run_gauntlet list 2>/dev/null | grep -qiE '(^|[[:space:]])go([[:space:]]|$)'; then
    echo "Go is registered — wire its tiers into release.sh (this script predates the packet merge)."
    fail "journey D: Go registration detected — wire its tiers into release.sh"
  else
    echo "journey D: SKIP — Go is not registered on this tree."
    echo "  Installed GNU Go: $(command -v gnugo || echo 'not found') — nothing to drive yet."
  fi
  echo "=== journey D: PASS (skip is not a failure)"
fi

echo "=== release.sh: all journeys passed: $STAGES"
