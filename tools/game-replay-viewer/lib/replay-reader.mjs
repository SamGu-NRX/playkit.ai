/**
 * Replay-log reader for playkit.ai move logs.
 *
 * Contract (do not weaken):
 * - NEVER repairs an invalid history. The reader classifies: whole-log
 *   refusals for unusable containers, per-event problems for invalid
 *   entries, and explicit missing-observation states for absent boards.
 *   It never fills gaps, resyncs chains, coerces types, or drops entries
 *   to make a log look valid.
 * - NEVER mutates its input. Tests read fixtures Object.freeze()d.
 * - Boards are 4x4 arrays of tile VALUES (0 = empty, 2, 4, ..., 2^15) —
 *   the same domain the FIX-1 board-encoding contract validates. The
 *   ambiguous value 1 (encodes as exponent 0 = empty) is rejected, as in
 *   BoardEncoder.
 * - Direction convention (project-wide): 0 = Up, 1 = Right, 2 = Down,
 *   3 = Left.
 *
 * Accepted shapes:
 * - Envelope format  { format: "playkit-replay-log/1", source: {...}, moves: [...] }
 * - Legacy bare move array [{dir, before, after, spawn, gained, score, t}, ...]
 *   — the existing bench/fixtures/game-engine.js `logs().moves` shape. It
 *   carries no in-band source identity, so identity is reported "unknown".
 */

export const FORMAT_ID = "playkit-replay-log/1";
export const BOARD_SIZE = 4;
export const MAX_TILE_VALUE = 2 ** 15;

export const REFUSAL_CODES = Object.freeze({
  NOT_AN_OBJECT: "NOT_AN_OBJECT",
  FORMAT_REQUIRED: "FORMAT_REQUIRED",
  FORMAT_UNKNOWN: "FORMAT_UNKNOWN",
  MOVES_MISSING: "MOVES_MISSING",
  MOVES_NOT_ARRAY: "MOVES_NOT_ARRAY",
});

export const PROBLEM_CODES = Object.freeze({
  DIR_MISSING: "DIR_MISSING",
  DIR_UNKNOWN: "DIR_UNKNOWN",
  BOARD_SHAPE: "BOARD_SHAPE",
  BOARD_VALUE: "BOARD_VALUE",
  CHAIN_BREAK: "CHAIN_BREAK",
  SPAWN_MISMATCH: "SPAWN_MISMATCH",
  ID_DUPLICATE: "ID_DUPLICATE",
});

function isTileValue(value) {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (value === 0 ||
      (value >= 2 && value <= MAX_TILE_VALUE && (value & (value - 1)) === 0))
  );
}

/**
 * Validate one board. Returns null when the board is well-formed, otherwise
 * { code, message } with a machine-readable problem code.
 */
export function validateBoard(board, field) {
  if (!Array.isArray(board) || board.length !== BOARD_SIZE) {
    return {
      code: "BOARD_SHAPE",
      message: `${field}: expected a ${BOARD_SIZE}x${BOARD_SIZE} array, got ${
        Array.isArray(board) ? `array of length ${board.length}` : typeof board
      }`,
    };
  }
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    const row = board[r];
    if (!Array.isArray(row) || row.length !== BOARD_SIZE) {
      return {
        code: "BOARD_SHAPE",
        message: `${field}: row ${r} is ${
          Array.isArray(row) ? `length ${row.length}` : typeof row
        }, expected ${BOARD_SIZE}`,
      };
    }
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      const value = row[c];
      if (!isTileValue(value)) {
        const detail =
          value === 1
            ? "value 1 is ambiguous under values encoding (it encodes to exponent 0 = empty); tile values start at 2"
            : `expected 0 or a power of two in [2, ${MAX_TILE_VALUE}]`;
        return {
          code: "BOARD_VALUE",
          message: `${field}: invalid tile at row ${r}, col ${c}: ${JSON.stringify(value)} — ${detail}`,
        };
      }
    }
  }
  return null;
}

function boardsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readDir(entry) {
  if (!("dir" in entry) || entry.dir === null || entry.dir === undefined) {
    return { dir: null, dirState: "missing", problem: { code: "DIR_MISSING", message: "dir: not recorded" } };
  }
  const dir = entry.dir;
  if (typeof dir !== "number" || !Number.isInteger(dir) || dir < 0 || dir > 3) {
    return {
      dir,
      dirState: "unknown",
      problem: {
        code: "DIR_UNKNOWN",
        message: `dir: ${JSON.stringify(dir)} is not a direction (0=Up, 1=Right, 2=Down, 3=Left)`,
      },
    };
  }
  return { dir, dirState: "ok", problem: null };
}

function readSpawn(entry, beforeBoard, afterBoard) {
  const spawn = "spawn" in entry ? entry.spawn : null;
  if (spawn === null || spawn === undefined) return { spawn: null, problem: null };
  if (
    typeof spawn !== "object" ||
    Array.isArray(spawn) ||
    typeof spawn.r !== "number" ||
    typeof spawn.c !== "number" ||
    !isTileValue(spawn.value) ||
    spawn.value === 0
  ) {
    return {
      spawn,
      problem: { code: "SPAWN_MISMATCH", message: `spawn: malformed spawn record ${JSON.stringify(spawn)}` },
    };
  }
  const { r, c, value } = spawn;
  if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) {
    return {
      spawn,
      problem: { code: "SPAWN_MISMATCH", message: `spawn: cell (r=${r}, c=${c}) is outside the board` },
    };
  }
  // Record-level consistency only: the spawn tile must appear in the after
  // board. Whether the cell was empty pre-move is NOT checked here — the
  // reference slide can vacate an occupied `before` cell for the spawn, so
  // full transition consistency is the timeline's reference comparison job.
  if (afterBoard && afterBoard[r][c] !== value) {
    return {
      spawn,
      problem: {
        code: "SPAWN_MISMATCH",
        message: `spawn: after holds ${afterBoard[r][c]} at (r=${r}, c=${c}), recorded spawn value is ${value}`,
      },
    };
  }
  return { spawn, problem: null };
}

/**
 * Read and classify one replay log.
 *
 * @param {*} raw parsed JSON of the log (an envelope object or a legacy
 *   bare move array)
 * @param {{fileName?: string}} [options]
 * @returns the classification: { status, refusals, source, shape, events,
 *   counts }. Never mutates `raw`.
 */
export function readReplayLog(raw, { fileName = "(input)" } = {}) {
  const refusals = [];
  if (typeof raw !== "object" || raw === null) {
    return refused(
      [{ code: "NOT_AN_OBJECT", message: `expected a log object or bare move array, got ${raw === null ? "null" : typeof raw}` }],
      fileName,
    );
  }

  const isLegacy = Array.isArray(raw);
  if (!isLegacy) {
    const format = raw.format;
    if (format === undefined) {
      refusals.push({
        code: "FORMAT_REQUIRED",
        message: "log object has no format field — pass format: \"playkit-replay-log/1\" (a bare move array is also accepted)",
      });
    } else if (format !== FORMAT_ID) {
      refusals.push({
        code: "FORMAT_UNKNOWN",
        message: `format ${JSON.stringify(format)} is not supported (expected ${JSON.stringify(FORMAT_ID)})`,
      });
    }
    if (!("moves" in raw) || raw.moves === undefined) {
      refusals.push({ code: "MOVES_MISSING", message: "log object has no moves field" });
    } else if (!Array.isArray(raw.moves)) {
      refusals.push({ code: "MOVES_NOT_ARRAY", message: `moves: expected an array, got ${typeof raw.moves}` });
    }
    if (refusals.length > 0) return refused(refusals, fileName);
  }

  const rawMoves = isLegacy ? raw : raw.moves;
  const source = readSource(raw, isLegacy);

  const events = [];
  const seenIds = new Set();
  let prevAfter = null;

  for (let i = 0; i < rawMoves.length; i += 1) {
    const entry = rawMoves[i];
    const problems = [];

    const idProvided = typeof entry === "object" && entry !== null && typeof entry.id === "string" && entry.id !== "";
    const id = idProvided ? entry.id : `e${i}`;
    if (seenIds.has(id)) {
      problems.push({ code: "ID_DUPLICATE", message: `id ${JSON.stringify(id)} was already used by an earlier move` });
    }
    seenIds.add(id);

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      events.push({
        index: i,
        id,
        idAssigned: !idProvided,
        dir: null,
        dirState: "missing",
        before: null,
        beforeState: "corrupt",
        after: null,
        afterState: "corrupt",
        spawn: null,
        gained: null,
        score: null,
        problems: [{ code: "DIR_MISSING", message: `move ${i} is ${entry === null ? "null" : typeof entry}, not a move record` }],
        state: "corrupt",
      });
      prevAfter = null;
      continue;
    }

    const dirRead = readDir(entry);
    if (dirRead.problem) problems.push(dirRead.problem);

    const beforePresent = entry.before !== null && entry.before !== undefined;
    const afterPresent = entry.after !== null && entry.after !== undefined;
    const beforeProblem = beforePresent ? validateBoard(entry.before, `before[${i}]`) : null;
    const afterProblem = afterPresent ? validateBoard(entry.after, `after[${i}]`) : null;
    if (beforeProblem) problems.push(beforeProblem);
    if (afterProblem) problems.push(afterProblem);

    const validBefore = beforePresent && !beforeProblem ? entry.before : null;
    const validAfter = afterPresent && !afterProblem ? entry.after : null;

    if (validBefore && prevAfter && !boardsEqual(validBefore, prevAfter)) {
      problems.push({
        code: "CHAIN_BREAK",
        message: `before[${i}] does not continue after[${i - 1}]: the recorded history has a gap or an edit`,
      });
    }

    const spawnRead = readSpawn(entry, validBefore, validAfter);
    if (spawnRead.problem) problems.push(spawnRead.problem);

    const state = problems.length > 0 ? "corrupt" : beforePresent && afterPresent ? "ok" : "missing";
    events.push({
      index: i,
      id,
      idAssigned: !idProvided,
      dir: dirRead.dir,
      dirState: dirRead.dirState,
      before: validBefore,
      beforeState: beforePresent ? (beforeProblem ? "corrupt" : "present") : "missing",
      after: validAfter,
      afterState: afterPresent ? (afterProblem ? "corrupt" : "present") : "missing",
      spawn: spawnRead.spawn ?? null,
      gained: entry.gained === undefined ? null : entry.gained,
      score: entry.score === undefined ? null : entry.score,
      problems,
      state,
    });

    prevAfter = validAfter;
  }

  const counts = {
    events: events.length,
    ok: events.filter((e) => e.state === "ok").length,
    missing: events.filter((e) => e.state === "missing").length,
    corrupt: events.filter((e) => e.state === "corrupt").length,
  };

  return {
    status: "accepted",
    fileName,
    shape: isLegacy ? "legacy-moveLog" : "envelope",
    format: isLegacy ? null : raw.format,
    synthetic: !isLegacy && raw.synthetic === true,
    source,
    events,
    counts,
  };
}

function readSource(raw, isLegacy) {
  if (isLegacy) {
    return {
      identityState: "unknown",
      name: null,
      seed: null,
      scenario: null,
      recordedBy: null,
      note: "legacy bare move array (bench/fixtures/game-engine.js logs().moves) — no in-band source identity",
    };
  }
  const source = typeof raw.source === "object" && raw.source !== null ? raw.source : null;
  const name = source && typeof source.name === "string" && source.name !== "" ? source.name : null;
  return {
    identityState: name === null ? "unknown" : "recorded",
    name,
    seed: source && Number.isInteger(source.seed) ? source.seed : null,
    scenario: source && typeof source.scenario === "string" ? source.scenario : null,
    recordedBy: source && typeof source.recordedBy === "string" ? source.recordedBy : null,
    note: null,
  };
}

function refused(refusals, fileName) {
  return {
    status: "refused",
    fileName,
    shape: null,
    format: null,
    synthetic: false,
    source: { identityState: "unknown", name: null, seed: null, scenario: null, recordedBy: null, note: null },
    events: [],
    refusals,
    counts: { events: 0, ok: 0, missing: 0, corrupt: 0 },
  };
}
