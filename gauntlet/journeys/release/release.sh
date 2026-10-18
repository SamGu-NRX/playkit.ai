#!/usr/bin/env bash
# gauntlet/journeys/release/release.sh — replay the release journeys in order
# and exit non-zero on the first failure:
#
#   A  researcher, terminal      -> journeys/cli/journey.sh (install, episodes,
#                                   suite, model, rate_serve, errors)
#   C  frontier pilot rehearsal  -> journeys/pilot/rehearse.sh (which drives
#                                   separation-run.sh --rehearse): one loopback
#                                   stub per provider wire (Anthropic Messages,
#                                   OpenAI Responses, OpenAI-compatible chat) on
#                                   free ports, then the three PRICED model arms
#                                   plus the random arm through estimate, capped
#                                   run, verify, and the estimate-vs-actual
#                                   analysis; no spend, no keys — the stubs
#                                   listen on 127.0.0.1 only
#   D  Go                        -> one played + verified episode per GNU Go
#                                   tier; when Go is not registered (or GNU Go
#                                   is not installed) the stage records a skip
#                                   and passes — a skip is not a failure
#   E  a person at the terminal  -> gauntlet play --agent human on
#                                   sokoban/one-box with a scripted stdin (help,
#                                   empty, out-of-range number, then the par
#                                   line), gauntlet verify on the recording,
#                                   and the human-baseline kit report
#
# Usage:
#   bash gauntlet/journeys/release/release.sh                 # A, C, D, E
#   RELEASE_STAGES="C" bash gauntlet/journeys/release/release.sh
#
# Environment:
#   JOURNEY_WORK     scratch dir (default: ${TMPDIR:-/tmp}/gauntlet-release)
#   RELEASE_STAGES   subset of "A C D E" to replay (default: all)
#   RELEASE_MAX_USD  pilot rehearsal cap per model arm (default 10). It must
#                    CLEAR the suite's stub-priced total so every arm runs to
#                    done — a binding cap makes an arm end loudly on the
#                    no-headroom guard instead (raise it for pricier suites).
#   GAUNTLET_STOCKFISH detected automatically, passed per command (never global)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAUNTLET_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$GAUNTLET_DIR"

WORK="${JOURNEY_WORK:-${TMPDIR:-/tmp}/gauntlet-release}"
mkdir -p "$WORK"
GAUNTLET="node cli/gauntlet.js"
run_gauntlet() { node cli/gauntlet.js "$@"; }

fail() { echo "FAIL: $*" >&2; exit 1; }

STOCKFISH_BIN="${GAUNTLET_STOCKFISH:-}"
if [ -z "$STOCKFISH_BIN" ]; then
  for candidate in /usr/games/stockfish /usr/bin/stockfish; do
    [ -x "$candidate" ] && STOCKFISH_BIN="$candidate" && break
  done
fi
echo "release.sh: stockfish=${STOCKFISH_BIN:-none} gnugo=$(command -v gnugo || echo none) work=$WORK"

STAGES="${RELEASE_STAGES:-A C D E}"

# --- Journey A: the researcher's terminal journey, replayed end to end -------
if [[ " $STAGES " == *" A "* ]]; then
  echo "=== journey A: researcher terminal (journeys/cli/journey.sh)"
  JOURNEY_WORK="$WORK/journey-a" bash journeys/cli/journey.sh install episodes suite model rate_serve errors \
    || fail "journey A (journeys/cli/journey.sh)"
  echo "=== journey A: PASS"
fi

# --- Journey C: frontier pilot rehearsal against every provider stub ---------
if [[ " $STAGES " == *" C "* ]]; then
  echo "=== journey C: pilot rehearsal (journeys/pilot/rehearse.sh, all three wires)"
  # rehearse.sh's current contract is SUITE CAP CONCURRENCY and it drives
  # separation-run.sh --rehearse, whose arms are the priced trio in
  # prices.frontier.json (anthropic/claude-opus-5-5, openai/gpt-6-astra,
  # openai-chat/gemini-4-argon) plus the free random arm. Naming a model here
  # (the old per-wire loop) broke against that contract, and openai-chat/
  # gpt-6-astra has no price entry — an unpriced model cannot be cap-enforced.
  # Stubs pick their own free ports; no keys, no spend.
  SUITE="$WORK/suite-public.json"
  run_gauntlet suite build --split public --seeds-per-tier 1 --out "$SUITE" \
    || fail "journey C: suite build"
  SEPARATION_RUN_OUT="$WORK/pilot" \
  bash journeys/pilot/rehearse.sh "$SUITE" "${RELEASE_MAX_USD:-10}" 2 \
    || fail "journey C: pilot rehearsal (all three wires)"
  echo "=== journey C: PASS"
fi

# --- Journey D: Go, one played + verified episode per GNU Go tier ------------
if [[ " $STAGES " == *" D "* ]]; then
  echo "=== journey D: Go"
  if run_gauntlet list 2>/dev/null | grep -qiE "(^|[[:space:]])go v[0-9]"; then
    if [ -z "$(command -v gnugo || true)" ]; then
      echo "journey D: SKIP — Go is registered but no gnugo binary is installed."
      echo "  install it: apt-get install -y gnugo"
    else
      mkdir -p "$WORK/go"
      for tier in ladder-1 ladder-2 ladder-3 ladder-4; do
        run_gauntlet play --game go --tier "$tier" --agent random \
          --out "$WORK/go/go-$tier.json" \
          || fail "journey D: play go/$tier"
        run_gauntlet verify "$WORK/go/go-$tier.json" \
          || fail "journey D: verify go/$tier"
      done
      echo "journey D: played and verified one episode per GNU Go tier (4/4)"
    fi
  else
    echo "journey D: SKIP — Go is not registered on this tree."
    echo "  Installed GNU Go: $(command -v gnugo || echo 'not found') — nothing to drive yet."
  fi
  echo "=== journey D: PASS"
fi

# --- Journey E: a person at the terminal --------------------------------------
if [[ " $STAGES " == *" E "* ]]; then
  echo "=== journey E: human at the terminal (gauntlet play --agent human)"
  EWORK="$WORK/human"
  rm -rf "$EWORK"; mkdir -p "$EWORK"

  # A scripted person: reads the help, sends an empty line, an out-of-range
  # number (none consume an action), then plays the par line for
  # sokoban/one-box public seed 0: up up left up right (5 actions, par 5).
  printf 'help\n\n9\nup\nup\nleft\nup\nright\n' \
    | run_gauntlet play --game sokoban --tier one-box --agent human \
        --out "$EWORK/human-sokoban.json" \
    || fail "journey E: human play"

  PLAY_OUT="$(run_gauntlet verify "$EWORK/human-sokoban.json")" \
    || fail "journey E: verify the human recording"
  echo "$PLAY_OUT"
  echo "$PLAY_OUT" | grep -q "1/1 trajectories verified" \
    || fail "journey E: the human recording did not verify"

  node studies/human-baseline/report.mjs "$EWORK" \
    || fail "journey E: human-baseline kit report"
  echo "=== journey E: PASS"
fi

echo "=== release.sh: all journeys passed: $STAGES"
