#!/bin/bash
# Bounded /health wait shared by the model-separation-v2 launchers (codex
# #122): the launchers used to wait with an unbounded `until curl /health`
# loop, so a server that stayed alive but never answered /health hung them
# forever and they never reached their bounded completion probe or its
# exhaustion check. This helper gives the health phase its own attempt
# budget and a server-liveness check: a server that dies before /health
# succeeds fails immediately instead of burning the budget.
#
# Usage: wait-healthy.sh <SRV_PID> <LABEL> <LOG_PATH>
# Exits 0 once /health answers; exits 1 loudly (stderr) when the server
# process dies before /health succeeds or the attempt budget runs out.
# Overrides for tests: HEALTH_ATTEMPTS (default 120, ~4 min with the 2 s
# sleep) and WAIT_HEALTH_URL (default http://127.0.0.1:8080/health).
set -u
SRV="$1"; LABEL="$2"; LOG="$3"
URL="${WAIT_HEALTH_URL:-http://127.0.0.1:8080/health}"
ATTEMPTS="${HEALTH_ATTEMPTS:-120}"
for attempt in $(seq 1 "$ATTEMPTS"); do
  if ! kill -0 "$SRV" 2>/dev/null; then
    echo "server $LABEL exited before /health succeeded (log: $LOG)" >&2
    exit 1
  fi
  if curl -sf --connect-timeout 5 --max-time 30 "$URL" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 2
done
echo "server $LABEL /health never succeeded after $ATTEMPTS attempts (log: $LOG)" >&2
exit 1
