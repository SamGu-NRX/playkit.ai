/**
 * @fileoverview Explicit UI state model for the HUD control layer.
 *
 * The HUD renders only what this model derives, and this model changes only
 * when a *witness* — a fact observed from the tested runtime — arrives.
 * Button clicks are intents, never facts: no state transition may be inferred
 * from a click alone. Every witness maps 1:1 onto the real runtime surface:
 *
 * | Witness           | Emitted from the runtime surface                              |
 * |-------------------|---------------------------------------------------------------|
 * | `snapshot`        | `Runtime.getStats()` (incl. `driverStats`, `solver`)          |
 * | `run-state`       | `HUD.updateRunState(bool)` pushed by start/stop/pause/resume  |
 * | `command-result`  | result of a controller command (detect/start/pause/resume/    |
 * |                   | stop/step/retry), with the post-command `getStats()` snapshot |
 * | `runtime-error`   | `driver.onError` forwarded by `Runtime.handleError`           |
 * | `game-over`       | `driver.onGameOver` forwarded by `Runtime.handleGameOver`     |
 * | `solver-status`   | `SolverManager.getStatus()` via `_notifySolverStatus`         |
 * | `init-failed`     | `Runtime.init` failure reported to the HUD                    |
 * | `reset`           | HUD destroy / re-initialization                               |
 *
 * Where witnesses contradict each other, precedence is fixed and pinned by
 * tests:
 *
 *   1. driver stats (`driverStats.*`) — what the driver is actually doing
 *   2. runtime flags (`isRunning`, `isInitialized`) — what the runtime believes
 *   3. command results — what a completed command returned
 *   4. click intent — never present as a witness at all
 *
 * Honesty rules enforced here:
 *   - A stop reason is always the driver's own verbatim `stopReason` string,
 *     or a known runtime error message. The UI never invents rationale.
 *   - Solver rationale is only ever `solverStatus.lastError`, verbatim.
 *   - Move counts come from `driverStats.moveCount`; absent means `null`.
 *   - Score is NOT modeled here; it is read live from the adapter and may be
 *     `null` (unavailable), which the view must show as "-" rather than a
 *     fabricated number.
 *   - The problem banner is written only at transition moments (a run stops,
 *     a command fails, initialization fails, retries exhaust) and cleared
 *     only when its cause actually resolves. It is never re-derived from
 *     stale run history, so a successful re-detect clears a board-lost
 *     banner instead of resurrecting it.
 *
 * The four headline signals the control surface answers:
 *   found a board / is playing / has fallen back / has stopped — see
 *   `headlineSignals()`.
 *
 * This module is pure: no DOM, no imports, safe under `node --test`.
 */

/** Control phases. */
export const PHASE = {
  NO_BOARD: "no-board",
  READY: "ready",
  PLAYING: "playing",
  PAUSED: "paused",
  STOPPED: "stopped",
};

/** Solver channel states (derived strictly from `SolverManager.getStatus()`). */
export const SOLVER_STATE = {
  UNKNOWN: "unknown",
  LOADING: "loading",
  WASM: "wasm",
  FALLBACK: "fallback",
  ERROR: "error",
};

/** Commands the HUD can dispatch through the controller. */
export const COMMAND = {
  DETECT: "detect",
  START: "start",
  PAUSE: "pause",
  RESUME: "resume",
  STOP: "stop",
  STEP: "step",
  RETRY: "retry",
};

/** Consecutive failed retries allowed before retry is exhausted. */
export const RETRY_LIMIT = 2;

/**
 * Runtime error strings the model may match — verbatim products of the
 * runtime's own thrown errors (`Runtime.start`, `Runtime.step`), never
 * invented.
 */
const RUNTIME_ERROR_PATTERNS = {
  noBoard: /no game detected/i,
  notInitialized: /not initialized/i,
};

/**
 * Create the initial control state (nothing observed yet).
 * @returns {object}
 */
export function createInitialControlState() {
  return {
    phase: PHASE.NO_BOARD,
    board: { name: null },
    run: {
      started: false,
      endedBy: null, // 'user' | 'driver' | 'game-over' | 'runtime' | null
      reason: null, // verbatim driver stopReason, when the driver supplied one
      moveCount: null, // real measured move count from driverStats, or null
    },
    solver: {
      state: SOLVER_STATE.UNKNOWN,
      reason: null, // verbatim solverStatus.lastError or null
      attemptedWasm: false, // a WASM engine exists (so fallback is a real fallback)
      advisory: null, // {kind:'wasm-unavailable', message, nextAction} | null
    },
    problem: null, // {kind, message, nextAction:{kind, label}} | null
    retry: { used: 0, limit: RETRY_LIMIT, exhausted: false, available: false },
    init: { failed: false, reason: null },
  };
}

/**
 * Derive the solver channel strictly from a `SolverManager.getStatus()`
 * snapshot. `reason` is only ever the manager's own `lastError` string.
 * @param {object|null|undefined} status
 * @returns {{state:string, reason:string|null, attemptedWasm:boolean, advisory:object|null}}
 */
export function deriveSolverState(status) {
  if (!status) {
    return {
      state: SOLVER_STATE.UNKNOWN,
      reason: null,
      attemptedWasm: false,
      advisory: null,
    };
  }

  const attemptedWasm = status.wasm !== null && status.wasm !== undefined;
  const reason =
    status.lastError !== undefined && status.lastError !== null
      ? String(status.lastError)
      : null;

  let state = SOLVER_STATE.UNKNOWN;
  if (status.status === "ready" && status.mode === "wasm") {
    state = SOLVER_STATE.WASM;
  } else if (status.status === "ready" || status.status === "fallback") {
    state = SOLVER_STATE.FALLBACK;
  } else if (status.status === "error") {
    state = SOLVER_STATE.ERROR;
  } else if (status.status === "idle" || status.status === "loading") {
    state = SOLVER_STATE.LOADING;
  }

  // The WASM-unavailable advisory exists only when a WASM engine was actually
  // attempted and the manager ended up on the fallback. No engine (WASM
  // disabled by configuration) is a configuration fact, not a failure.
  const advisory =
    state === SOLVER_STATE.FALLBACK && attemptedWasm
      ? {
          kind: "wasm-unavailable",
          message: reason
            ? `WASM unavailable — playing on the JS fallback solver. Reason: ${reason}`
            : "WASM unavailable — playing on the JS fallback solver (slower). Reload the page to retry loading WASM.",
          nextAction: { kind: "reload", label: "Reload page to retry WASM" },
        }
      : null;

  return { state, reason, attemptedWasm, advisory };
}

/**
 * Derive the primary problem + specific next action from the facts that
 * produce it, using only verbatim reasons.
 * @param {object} run
 * @param {object|null} init
 * @param {object} retry
 * @returns {object|null}
 */
export function deriveProblem(run, init, retry) {
  if (init && init.failed) {
    return {
      kind: "init-failed",
      message: init.reason
        ? `Initialization failed: ${init.reason}`
        : "Initialization failed.",
      nextAction: { kind: "reload", label: "Reload page to retry" },
    };
  }

  if (retry.exhausted) {
    return {
      kind: "retry-exhausted",
      message: `Automatic retries were exhausted after ${retry.used} attempt${retry.used === 1 ? "" : "s"}.`,
      nextAction: {
        kind: "reload",
        label: "Reload the page, then Detect Game",
      },
    };
  }

  if (!run.endedBy) {
    return null;
  }

  const reason = run.reason || "";

  if (run.endedBy === "game-over" || /game over/i.test(reason)) {
    return {
      kind: "game-over",
      message: reason
        ? `The game is over (${reason}). Start a new game, then press Start.`
        : "The game is over. Start a new game, then press Start.",
      nextAction: { kind: "new-game", label: null },
    };
  }

  if (/failed board reads/i.test(reason)) {
    return {
      kind: "board-lost",
      message: reason
        ? `The board disappeared while driving (${reason}). Re-detect it, or reload the page.`
        : "The board disappeared while driving. Re-detect it, or reload the page.",
      nextAction: { kind: "detect", label: "Detect the board again" },
    };
  }

  if (/no board progress/i.test(reason)) {
    return {
      kind: "stalled",
      message: reason
        ? `Driving stopped (${reason}). Retry driving; if the game is actually over, start a new game first.`
        : "Driving stopped after making no board progress. Retry driving.",
      nextAction: { kind: "retry", label: "Retry driving" },
    };
  }

  if (run.endedBy === "driver") {
    return {
      kind: "driver-stopped",
      message: reason
        ? `Driving stopped on its own (${reason}).`
        : "Driving stopped on its own.",
      nextAction: { kind: "retry", label: "Retry driving" },
    };
  }

  // User- or runtime-initiated clean stops are not problems.
  return null;
}

/**
 * Whether retry may be offered for the current stop.
 * Retry re-arms the driver on a freshly detected adapter and restarts
 * driving. It is pointless after a game over (a dead board stays dead).
 * @param {object} state
 * @returns {boolean}
 */
export function deriveRetryAvailable(state) {
  if (state.retry.exhausted) return false;
  if (state.init.failed) return false;
  return (
    state.phase === PHASE.STOPPED &&
    (state.run.endedBy === "driver" || state.run.endedBy === "user") &&
    state.board.name !== null
  );
}

/** Recompute the derived retry availability on a state about to be returned. */
function withDerivedRetry(next) {
  return {
    ...next,
    retry: { ...next.retry, available: deriveRetryAvailable(next) },
  };
}

/**
 * Extract the facts a snapshot contributes, resolving driver-vs-runtime
 * contradictions with driver stats winning.
 * @param {object|null} stats A `Runtime.getStats()` shape
 * @param {object} prev Previous state (fallback for fields stats omits)
 */
function snapshotFacts(stats, prev) {
  const d = stats && stats.driverStats ? stats.driverStats : null;

  const adapterName =
    stats && stats.adapterName ? stats.adapterName : prev.board.name;

  // Precedence 1: the driver's own running/paused flags. The runtime flag is
  // only consulted when no driver stats exist (e.g. before the first start).
  const driverRunning = d ? d.isRunning === true : stats.isRunning === true;
  const driverPaused = d ? d.isPaused === true : false;
  const stopReason =
    d && d.stopReason !== undefined && d.stopReason !== null
      ? String(d.stopReason)
      : null;

  return {
    adapterName,
    driverRunning,
    driverPaused,
    stopReason,
    moveCount: d && typeof d.moveCount === "number" ? d.moveCount : null,
    solverStatus: stats && stats.solver ? stats.solver : null,
  };
}

/**
 * Reduce a `snapshot` witness into the state. The problem banner is written
 * only when this snapshot introduces a stop, and cleared when a run becomes
 * active; otherwise it is carried through untouched.
 */
function applySnapshot(prev, stats) {
  const facts = snapshotFacts(stats, prev);
  const solver = facts.solverStatus
    ? deriveSolverState(facts.solverStatus)
    : prev.solver; // a snapshot without a solver field does not clobber it
  const hadRun = prev.run.started || prev.run.endedBy !== null;

  let phase;
  let endedBy = prev.run.endedBy;
  let reason = facts.stopReason;

  if (facts.driverRunning && !facts.driverPaused) {
    phase = PHASE.PLAYING;
  } else if (facts.driverRunning && facts.driverPaused) {
    phase = PHASE.PAUSED;
  } else if (hadRun || facts.stopReason) {
    phase = PHASE.STOPPED;
  } else {
    phase = facts.adapterName ? PHASE.READY : PHASE.NO_BOARD;
  }

  // Attribute the end of the run — driver facts win over the runtime flag.
  if (phase === PHASE.STOPPED && facts.stopReason) {
    endedBy = /game over/i.test(facts.stopReason) ? "game-over" : "driver";
  }
  // else: preserve an existing endedBy (a user stop already recorded).

  // A running run has no end record; a fresh run clears the previous one.
  if (phase === PHASE.PLAYING || phase === PHASE.PAUSED) {
    endedBy = null;
    reason = null;
  }

  const run = {
    started:
      prev.run.started || phase === PHASE.PLAYING || phase === PHASE.PAUSED,
    endedBy,
    reason: phase === PHASE.STOPPED ? reason ?? prev.run.reason : null,
    moveCount: facts.moveCount !== null ? facts.moveCount : prev.run.moveCount,
  };

  let next = { ...prev, phase, board: { name: facts.adapterName }, run, solver };

  const stopIntroduced =
    phase === PHASE.STOPPED &&
    facts.stopReason !== null &&
    facts.stopReason !== prev.run.reason;
  if (stopIntroduced) {
    next.problem = deriveProblem(run, next.init, next.retry);
  } else if (phase === PHASE.PLAYING || phase === PHASE.PAUSED) {
    next.problem = null;
  }

  return withDerivedRetry(next);
}

/**
 * Reduce a `run-state` witness (the runtime flag channel pushed by
 * start/stop/pause/resume). Without driver stats this channel cannot
 * distinguish pause from stop, so `false` records a runtime-attributed stop
 * that the next snapshot or command result refines.
 */
function applyRunState(prev, isRunning) {
  if (isRunning) {
    if (prev.phase === PHASE.PLAYING) return prev;
    // A run-state(true) flag is a fact that a run is active. The board name
    // may not have been witnessed yet (no snapshot has arrived); it stays
    // unknown rather than being overclaimed as absent, and the next snapshot
    // or command result names it.
    const next = {
      ...prev,
      phase: PHASE.PLAYING,
      run: {
        started: true,
        endedBy: null,
        reason: null,
        moveCount: prev.run.moveCount,
      },
      problem: null,
    };
    return withDerivedRetry(next);
  }

  if (prev.phase !== PHASE.PLAYING && prev.phase !== PHASE.PAUSED) {
    return prev;
  }

  const run = {
    ...prev.run,
    started: true,
    endedBy: prev.run.endedBy ?? "runtime",
  };
  const next = { ...prev, phase: PHASE.STOPPED, run };
  next.problem = deriveProblem(run, next.init, next.retry) || prev.problem;
  return withDerivedRetry(next);
}

/**
 * Reduce a `command-result` witness. Command results never outrank facts: a
 * post-command snapshot (when available) is applied first, and only then does
 * the command's own semantics refine attribution (e.g. marking a clean stop
 * as user-initiated).
 */
function applyCommandResult(prev, witness) {
  const { command, ok, error, stats } = witness;
  let next = stats ? applySnapshot(prev, stats) : prev;

  if (command === COMMAND.RETRY) {
    next = applyRetryOutcome(next, ok);
    return withDerivedRetry(next);
  }

  if (!ok) {
    return withDerivedRetry(applyCommandFailure(next, command, error));
  }

  switch (command) {
    case COMMAND.START:
      // The runtime throws on failure, so ok=true means the driver started.
      // A snapshot that already recorded a driver-attributed stop (the run
      // ended the instant it started) outranks the command.
      if (next.phase !== PHASE.STOPPED || next.run.endedBy === "user") {
        next = {
          ...next,
          phase: PHASE.PLAYING,
          run: {
            started: true,
            endedBy: null,
            reason: null,
            moveCount: next.run.moveCount,
          },
          problem: null,
        };
      }
      break;

    case COMMAND.PAUSE:
      if (next.phase !== PHASE.STOPPED) {
        next = { ...next, phase: PHASE.PAUSED };
      }
      break;

    case COMMAND.RESUME:
      if (next.phase === PHASE.PAUSED || next.phase === PHASE.READY) {
        next = {
          ...next,
          phase: PHASE.PLAYING,
          run: { ...next.run, started: true, endedBy: null, reason: null },
          problem: null,
        };
      }
      break;

    case COMMAND.STOP:
      // A driver-supplied stopReason (already in next.run) outranks the
      // command attribution; a clean stop is user-initiated.
      if (!next.run.reason) {
        next = {
          ...next,
          phase: PHASE.STOPPED,
          run: {
            ...next.run,
            started: true,
            endedBy: next.run.endedBy ?? "user",
          },
        };
      }
      break;

    case COMMAND.DETECT:
      // The snapshot already applied the facts. A successful re-detect that
      // found a board clears the current problem — its cause (a missing or
      // undetectable board) just resolved. A game-over problem survives
      // re-detection: finding a dead board does not make it playable.
      if (next.board.name !== null && next.problem?.kind !== "game-over") {
        next = { ...next, problem: null };
      }
      break;

    case COMMAND.STEP:
      // A single step neither starts nor stops the loop.
      break;

    default:
      break;
  }

  return withDerivedRetry(next);
}

/**
 * Retry outcomes update the consecutive-failure counter. Success resets it
 * (and clears the problem: the cause was just re-armed); failure increments
 * it and exhausts retry at the limit.
 */
function applyRetryOutcome(prev, ok) {
  if (ok) {
    return {
      ...prev,
      retry: { ...prev.retry, used: 0, exhausted: false },
      problem: null,
    };
  }

  const used = prev.retry.used + 1;
  const exhausted = used >= prev.retry.limit;
  const next = { ...prev, retry: { ...prev.retry, used, exhausted } };
  if (exhausted) {
    next.problem = deriveProblem(next.run, next.init, next.retry);
  }
  return next;
}

/**
 * Map a failed command onto a problem with a specific next action, matching
 * only the runtime's own pinned error strings.
 */
function applyCommandFailure(prev, command, error) {
  const message = error ? String(error.message || error) : "command failed";

  if (
    command === COMMAND.START ||
    command === COMMAND.RESUME ||
    command === COMMAND.STEP
  ) {
    if (RUNTIME_ERROR_PATTERNS.noBoard.test(message)) {
      return {
        ...prev,
        phase: PHASE.NO_BOARD,
        board: { name: null },
        problem: {
          kind: "no-board-at-start",
          message: "No game board was found, so automation cannot start.",
          nextAction: { kind: "detect", label: "Detect the board again" },
        },
      };
    }

    if (RUNTIME_ERROR_PATTERNS.notInitialized.test(message)) {
      return {
        ...prev,
        init: { failed: true, reason: message },
        phase: PHASE.NO_BOARD,
        problem: deriveProblem(
          prev.run,
          { failed: true, reason: message },
          prev.retry
        ),
      };
    }

    return {
      ...prev,
      problem: {
        kind: "start-failed",
        message: `Starting automation failed: ${message}`,
        nextAction: { kind: "retry", label: "Retry" },
      },
    };
  }

  if (command === COMMAND.DETECT) {
    // A failed detect means detection found nothing. While a run is actually
    // in flight the phase stays what the driver says it is (the runtime nulls
    // its adapter; the next snapshot reconciles the board fact) — the banner
    // reports the failed detection without overclaiming "no board".
    const running =
      prev.phase === PHASE.PLAYING || prev.phase === PHASE.PAUSED;
    const next = running
      ? prev
      : { ...prev, phase: PHASE.NO_BOARD, board: { name: null } };
    if (!next.problem) {
      next = {
        ...next,
        problem: {
          kind: "detect-failed",
          message: "No game board was detected.",
          nextAction: { kind: "detect", label: "Try Detect again" },
        },
      };
    }
    return next;
  }

  // pause/stop failures are transient; a toast reports them without making
  // them a control state.
  return prev;
}

/**
 * Reduce the current state against a witness. Always returns a new object;
 * the input is never mutated.
 *
 * @param {object} state Current control state
 * @param {object} witness One of the documented witness shapes
 * @returns {object} New control state
 */
export function reduceControlState(state, witness) {
  if (!state) {
    state = createInitialControlState();
  }

  switch (witness.type) {
    case "snapshot":
      return applySnapshot(state, witness.stats);

    case "run-state":
      return applyRunState(state, witness.isRunning === true);

    case "command-result":
      return applyCommandResult(state, witness);

    case "runtime-error":
      // Errors carry no facts by themselves; the accompanying snapshot (and
      // the driver's own stopReason) carries the state. Errors that arrive
      // while the driver keeps running (e.g. a solver hiccup the driver fell
      // back from) must not stop the UI.
      return state;

    case "game-over": {
      const statsApplied = witness.stats
        ? applySnapshot(state, witness.stats)
        : state;
      const run = {
        ...statsApplied.run,
        started: true,
        endedBy: "game-over",
        reason:
          statsApplied.run.reason ??
          (witness.reason ? String(witness.reason) : null),
      };
      const next = {
        ...statsApplied,
        phase: PHASE.STOPPED,
        run,
        problem: deriveProblem(run, statsApplied.init, statsApplied.retry),
      };
      return withDerivedRetry(next);
    }

    case "solver-status": {
      const solver = deriveSolverState(witness.status);
      return { ...state, solver };
    }

    case "init-failed": {
      const init = {
        failed: true,
        reason: witness.message ? String(witness.message) : null,
      };
      const next = {
        ...state,
        phase: PHASE.NO_BOARD,
        board: { name: null },
        init,
      };
      next.problem = deriveProblem(next.run, init, next.retry);
      return withDerivedRetry(next);
    }

    case "reset":
      return createInitialControlState();

    default:
      return state;
  }
}

/** The four headline signals, answered from state alone. */
export function headlineSignals(state) {
  return {
    foundBoard: state.board.name !== null,
    playing: state.phase === PHASE.PLAYING,
    fallenBack: state.solver.state === SOLVER_STATE.FALLBACK,
    stopped: state.phase === PHASE.STOPPED,
  };
}

/** Human label for a phase. */
export function describePhase(phase) {
  switch (phase) {
    case PHASE.NO_BOARD:
      return "No board found";
    case PHASE.READY:
      return "Board found";
    case PHASE.PLAYING:
      return "Playing";
    case PHASE.PAUSED:
      return "Paused";
    case PHASE.STOPPED:
      return "Stopped";
    default:
      return "Unknown";
  }
}

/**
 * Solver status line content. The reason (when present) is verbatim from the
 * solver manager; nothing here invents rationale.
 */
export function describeSolver(solver) {
  switch (solver.state) {
    case SOLVER_STATE.WASM:
      return { label: "WASM", title: "Native WASM solver active" };
    case SOLVER_STATE.FALLBACK:
      return {
        label: "Fallback",
        title: solver.reason
          ? `JS fallback solver active (reason: ${solver.reason})`
          : "JS fallback solver active",
      };
    case SOLVER_STATE.ERROR:
      return {
        label: "Error",
        title: solver.reason ? `Solver error: ${solver.reason}` : "Solver error",
      };
    case SOLVER_STATE.LOADING:
      return { label: "Loading…", title: "Solver is loading" };
    default:
      return { label: "—", title: "No solver status reported yet" };
  }
}
