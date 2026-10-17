#!/usr/bin/env bash
# rehearse.sh — rehearse the ENTIRE separation-pilot run path against
# loopback stubs: the same command Sam runs live, one flag different.
#
# Usage: ./rehearse.sh SUITE CAP_PER_ARM CONCURRENCY
#   (exactly separation-run.sh's arguments; the --rehearse flag is added
#   here — no other difference)
#
# Three per-wire stubs (Anthropic Messages, OpenAI Responses, Gemini
# OpenAI-compatible chat completions) on 127.0.0.1 only, accepting any key —
# no real key is needed, none is sent anywhere, nothing is spent. The stubs
# return plausible replays under injected faults (429 with retry-after,
# 529/503 with Retry-After, hard refusals, truncated JSON) at the rates
# stubs/*.mjs default to (override per stub with STUB_RATE_LIMIT_EVERY /
# STUB_OVERLOAD_EVERY / STUB_REFUSE_EVERY / STUB_TRUNCATE_EVERY, 0 disables).
# The random arm and the preregistered analysis run exactly as live.
#
# Rehearsal cap arithmetic: each stub's usage makes one model episode cost a
# few cents against the committed prices, so pass a cap that clears the
# suite's job count in a few cents (see PILOT.md) — e.g. for the 76-job
# pilot-1seed suite a cap of a dollar or two per arm is roomy, and a too-low
# cap exercises the resume path instead (that is what it is for).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 3 || $# -gt 3 ]]; then
  echo "usage: $0 SUITE CAP_PER_ARM CONCURRENCY" >&2
  exit 2
fi

exec "$SCRIPT_DIR/separation-run.sh" "$@" --rehearse
