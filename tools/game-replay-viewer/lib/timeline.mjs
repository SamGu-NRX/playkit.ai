/**
 * Timeline builder — turns a classified replay log into frames with a
 * reference comparison.
 *
 * Uses the repo's stable transition/reference API
 * (test/helpers/reference-2048.mjs) READ-ONLY: `simulateMove` plus the
 * log's recorded spawn schedule. No solver, no heuristics, no move search —
 * this is replay of the recorded schedule, nothing more.
 *
 * Frame states (explicit, never silent):
 * - ok:                   the observed post-move board matches the reference
 *                         transition exactly
 * - missing-observation:  this frame cannot be compared because a needed
 *                         board was not recorded (the reference chain still
 *                         advances via the recorded schedule)
 * - corrupt:              the event has reader problems or an invalid
 *                         recorded spawn (a spawn after a no-op move, or a
 *                         spawn whose reference cell is occupied after the
 *                         slide); its invalid parts are shown as-is and
 *                         nothing is reconstructed
 * - diverged:             observed post-move board ≠ reference board (both
 *                         are shown; the reference chain keeps reference
 *                         state — it is never re-seeded from observed data)
 * - reference-incomplete: an unrecorded spawn makes the reference chain
 *                         known-incomplete; no divergence verdicts from that
 *                         point on
 * - unverifiable:         the reference chain is unrecoverable after a
 *                         corrupt event; later frames are marked rather than
 *                         silently repaired
 */

import { boardsEqual, cloneBoard, simulateMove } from "../../../test/helpers/reference-2048.mjs";

export const FRAME_STATES = Object.freeze([
  "ok",
  "missing-observation",
  "corrupt",
  "diverged",
  "reference-incomplete",
  "unverifiable",
]);

export function buildTimeline(log) {
  if (log.status !== "accepted") {
    throw new Error("buildTimeline: log was refused — a refused log has no timeline and must not be rendered");
  }

  const frames = [];
  let refBoard = null;
  let chainBroken = false;
  let refIncomplete = false;

  for (const event of log.events) {
    const frame = {
      frameId: `f${event.index}`,
      eventId: event.id,
      index: event.index,
      dir: event.dir,
      dirState: event.dirState,
      state: null,
      observedBefore: event.before,
      observedAfter: event.after,
      referenceBefore: null,
      referenceAfter: null,
      spawn: event.spawn,
      problems: event.problems,
      notes: [],
      compare: null,
    };

    if (event.state === "corrupt") {
      frame.state = "corrupt";
      frame.notes.push("corrupt event: invalid parts are shown as recorded, nothing is reconstructed");
      chainBroken = true;
      refBoard = null;
      frames.push(frame);
      continue;
    }

    if (chainBroken) {
      frame.state = "unverifiable";
      frame.notes.push(
        "reference chain unrecoverable after an earlier corrupt event; this frame is marked, never re-seeded from observed data",
      );
      frames.push(frame);
      continue;
    }

    if (refIncomplete) {
      frame.state = "reference-incomplete";
      frame.notes.push(
        "reference chain incomplete since an earlier unrecorded spawn; no divergence verdict from here on",
      );
      frames.push(frame);
      continue;
    }

    if (refBoard === null && event.before === null) {
      frame.state = "missing-observation";
      frame.notes.push("reference comparison has not started: the first pre-move board is not recorded");
      frames.push(frame);
      continue;
    }

    if (refBoard === null) {
      refBoard = cloneBoard(event.before);
      frame.notes.push("reference chain starts at the first recorded pre-move board");
    }

    const refBefore = cloneBoard(refBoard);
    frame.referenceBefore = refBefore;
    const refAfter = simulateMove(refBefore, event.dir);

    // An invalid recorded spawn is invalid history: the real game never
    // spawns after a no-op move (the move changed nothing), and a spawn
    // whose reference cell is occupied after the slide contradicts the
    // transition. Refuse both: not applied, not silently ignored — the
    // frame is marked corrupt and the reference chain stops here (later
    // frames unverifiable), exactly as for a reader-corrupt event.
    if (event.spawn && boardsEqual(refAfter, refBefore)) {
      frame.state = "corrupt";
      frame.notes.push(
        `invalid spawn record: the move changed nothing (no-op), so no spawn can follow; spawn (r=${event.spawn.r}, c=${event.spawn.c}) is shown as recorded and nothing is applied`,
      );
      chainBroken = true;
      refBoard = null;
      frames.push(frame);
      continue;
    }
    if (event.spawn && refAfter[event.spawn.r][event.spawn.c] !== 0) {
      frame.state = "corrupt";
      frame.notes.push(
        `invalid spawn record: cell (r=${event.spawn.r}, c=${event.spawn.c}) is occupied on the reference board after the slide; the spawn is shown as recorded and nothing is applied`,
      );
      chainBroken = true;
      refBoard = null;
      frames.push(frame);
      continue;
    }
    if (event.spawn) {
      refAfter[event.spawn.r][event.spawn.c] = event.spawn.value;
    }
    frame.referenceAfter = refAfter;

    if (event.after === null) {
      frame.state = "missing-observation";
      frame.notes.push("post-move board not recorded; the reference chain advances via the recorded schedule");
      if (!event.spawn) {
        frame.notes.push("the spawn schedule is unrecorded for this event too: the reference chain becomes incomplete from here on");
        refIncomplete = true;
      }
      refBoard = refAfter;
      frames.push(frame);
      continue;
    }

    if (!event.spawn) {
      frame.state = "reference-incomplete";
      frame.notes.push("spawn unrecorded: the reference board is known to lack the new tile; the reference chain stays incomplete");
      refIncomplete = true;
      refBoard = refAfter;
      frames.push(frame);
      continue;
    }

    const compare = diffCells(event.after, refAfter);
    frame.compare = compare;
    if (compare.length === 0) {
      frame.state = "ok";
    } else {
      frame.state = "diverged";
      frame.notes.push(
        `observed board diverges from the reference replay in ${compare.length} cell(s); the reference chain keeps reference state`,
      );
    }
    refBoard = refAfter;
    frames.push(frame);
  }

  const counts = {};
  for (const state of FRAME_STATES) counts[state] = 0;
  for (const frame of frames) counts[frame.state] += 1;

  return { frames, counts };
}

function diffCells(a, b) {
  const out = [];
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      if (a[r][c] !== b[r][c]) {
        out.push({ r, c, observed: a[r][c], reference: b[r][c] });
      }
    }
  }
  return out;
}
