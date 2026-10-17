#!/usr/bin/env bash
# rehearse.sh — rehearse the full pilot for ONE model against a loopback stub,
# with a cap low enough to bind, then watch the resume finish. One command, no
# spend, no keys: the stub listens on 127.0.0.1 only and accepts any key.
#
# Usage:
#   ./rehearse.sh MODEL [EFFORT] [PORT]
#
#   MODEL   provider/model — the wire is picked from the provider prefix:
#           anthropic/… → stub Anthropic Messages server,
#           openai/…    → stub OpenAI Responses server,
#           openai-chat/… → stub OpenAI-compatible chat-completions server.
#   EFFORT  default high (RUN-SEQUENCE.md names none; PILOT.md records the choice)
#   PORT    default 8081 (8082/8083 suggested for the other wires)
#
# Stub fault rates (every 5th request 429 + retry-after, every 13th overloaded,
# every 11th refusal, every 7th truncated) are set so one rehearsal meets every
# reply shape a live run meets. Override with STUB_RATE_LIMIT_EVERY,
# STUB_OVERLOAD_EVERY, STUB_REFUSE_EVERY, STUB_TRUNCATE_EVERY (0 disables).
# The rehearsal cap defaults to $1 so the cap binds mid-run and the resume has
# work to finish; override with REHEARSAL_MAX_USD.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo "usage: $0 MODEL [EFFORT] [PORT]" >&2
  exit 2
fi

MODEL="$1"
EFFORT="${2:-high}"
PORT="${3:-8081}"

case "$MODEL" in
  anthropic/*) STUB=anthropic.mjs ;;
  openai/*) STUB=openai.mjs ;;
  openai-chat/*) STUB=openai-chat.mjs ;;
  *) echo "rehearse: MODEL must be provider/model with provider anthropic, openai or openai-chat, got \"$MODEL\"" >&2; exit 2 ;;
esac

CAP="${REHEARSAL_MAX_USD:-1}"
RL="${STUB_RATE_LIMIT_EVERY:-5}"
OL="${STUB_OVERLOAD_EVERY:-13}"
RF="${STUB_REFUSE_EVERY:-11}"
TR="${STUB_TRUNCATE_EVERY:-7}"
# Keep every step bounded so a rehearsal cannot hang on the known go-ladder
# probe wedges of the pre-burst13 GTP client (see PILOT.md).
export ESTIMATE_TIMEOUT_SECS="${ESTIMATE_TIMEOUT_SECS:-240}"
export RUN_TIMEOUT_SECS="${RUN_TIMEOUT_SECS:-600}"
export ESTIMATE_AGAINST_TIMEOUT_SECS="${ESTIMATE_AGAINST_TIMEOUT_SECS:-240}"

OUT="${PILOT_OUT:-$SCRIPT_DIR/runs/rehearsal-$(echo "$MODEL" | tr '/' '-')}"
mkdir -p "$OUT"
STUB_LOG="$OUT/stub-$PORT.log"

node "$SCRIPT_DIR/stubs/$STUB" --port "$PORT" \
  --rate-limit-every "$RL" --overload-every "$OL" \
  --refuse-every "$RF" --truncate-every "$TR" >"$STUB_LOG" 2>&1 &
STUB_PID=$!
cleanup() {
  kill "$STUB_PID" 2>/dev/null || true
  wait "$STUB_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for the stub to accept connections (up to ~10 s).
for _ in $(seq 1 50); do
  if node -e "
    fetch('http://127.0.0.1:$PORT/v1/ping', { method: 'POST', body: '{}' })
      .then(() => process.exit(0))
      .catch((e) => { process.exit(e.cause?.code === 'ECONNREFUSED' ? 1 : 0); });
  " 2>/dev/null; then
    break
  fi
  sleep 0.2
done
if ! kill -0 "$STUB_PID" 2>/dev/null; then
  echo "rehearse: stub failed to start — see $STUB_LOG" >&2
  exit 1
fi
echo "rehearse: stub $STUB on 127.0.0.1:$PORT (pid $STUB_PID, log $STUB_LOG)"

PILOT_OUT="$OUT" "$SCRIPT_DIR/pilot.sh" "$MODEL" "$EFFORT" "$CAP" "http://127.0.0.1:$PORT"
echo "rehearse: done — stub requests in $STUB_LOG"
