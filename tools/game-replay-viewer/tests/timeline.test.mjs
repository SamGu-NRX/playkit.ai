/**
 * Timeline tests — frame states against the committed synthetic fixtures,
 * using the repo's reference API read-only.
 */
import assert, { deepStrictEqual, strictEqual, throws } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { readReplayLog } from "../lib/replay-reader.mjs";
import { buildTimeline, FRAME_STATES } from "../lib/timeline.mjs";

const here = new URL(".", import.meta.url).pathname;
const fixturesDir = join(here, "..", "fixtures");
const load = (name) => readReplayLog(JSON.parse(readFileSync(join(fixturesDir, name), "utf8")), { fileName: name });

test("frame states are the documented six", () => {
  deepStrictEqual([...FRAME_STATES], [
    "ok",
    "missing-observation",
    "corrupt",
    "diverged",
    "reference-incomplete",
    "unverifiable",
  ]);
});

test("buildTimeline refuses to run on a refused log", () => {
  const refused = load("refused-not-object.json");
  throws(() => buildTimeline(refused), /refused/);
});

test("valid log: every frame is ok and frame ids agree with event ids", () => {
  const read = load("valid-seed7.json");
  const timeline = buildTimeline(read);
  strictEqual(timeline.frames.length, read.counts.events);
  deepStrictEqual(timeline.counts, { ...timeline.counts, ok: read.counts.events });
  timeline.frames.forEach((frame, i) => {
    strictEqual(frame.state, "ok", `frame ${i} should be ok`);
    strictEqual(frame.frameId, `f${i}`);
    strictEqual(frame.eventId, read.events[i].id);
    deepStrictEqual(frame.compare, []);
  });
});

test("missing-observations: frames without a needed board are explicit, reference chain still advances", () => {
  const timeline = buildTimeline(load("missing-observations.json"));
  deepStrictEqual(
    timeline.frames.map((f) => f.state),
    ["ok", "missing-observation", "ok", "ok", "missing-observation", "reference-incomplete"],
  );
  const first = timeline.frames[1];
  strictEqual(first.observedAfter, null, "observed stays null — nothing invented");
  strictEqual(first.referenceAfter === null, false, "reference chain advanced via the recorded schedule");
  deepStrictEqual(first.compare, null, "no comparison happened for a missing observation");
  // Event 5 loses its spawn along with its boards, so frame 6 cannot be
  // verified against the reference: reference-incomplete, never a false
  // divergence.
  strictEqual(timeline.frames[5].compare, null);
});

test("corrupt-events: corrupt frames are marked, and the trailing clean event is unverifiable — never re-seeded", () => {
  const timeline = buildTimeline(load("corrupt-events.json"));
  deepStrictEqual(
    timeline.frames.map((f) => f.state),
    ["ok", "corrupt", "corrupt", "corrupt", "corrupt", "corrupt", "corrupt", "unverifiable"],
  );
  const unverifiable = timeline.frames[7];
  strictEqual(unverifiable.referenceBefore, null, "no reference re-seeding from observed data");
  strictEqual(unverifiable.referenceAfter, null);
  strictEqual(unverifiable.observedBefore !== null, true, "observed boards still shown as recorded");
  const corrupt = timeline.frames[1];
  strictEqual(corrupt.observedBefore !== null, true, "recorded boards stay as recorded");
  strictEqual(corrupt.referenceAfter, null, "no reference transition is computed for a corrupt event");
});

test("diverged-chain: divergence is marked at the origin and can legitimately heal — per-frame truth, no re-seeding", () => {
  const timeline = buildTimeline(load("diverged-chain.json"));
  deepStrictEqual(
    timeline.frames.map((f) => f.state),
    ["ok", "ok", "diverged", "ok", "ok"],
  );
  const origin = timeline.frames[2];
  deepStrictEqual(origin.compare, [{ r: 0, c: 0, observed: 2, reference: 0 }]);
  // The reference chain kept reference state (never re-seeded from the
  // observed boards); the extra tile later coincided with a reference spawn
  // cell, so the boards realign. Healing is a real outcome of per-frame
  // comparison, and the tool reports it rather than claiming a defect.
  strictEqual(timeline.frames[3].referenceBefore !== null, true, "reference chain continued from reference state");
  const healed = timeline.frames[4];
  strictEqual(healed.state, "ok");
});

test("an unrecorded spawn makes the reference chain incomplete from that frame on — no false divergences", () => {
  const moves = JSON.parse(readFileSync(join(fixturesDir, "valid-seed7.json"), "utf8")).moves.slice(0, 3);
  moves[1].spawn = null; // the schedule loses one spawn; boards stay consistent
  const timeline = buildTimeline(readReplayLog({ format: "playkit-replay-log/1", moves }, { fileName: "spawnless.json" }));
  deepStrictEqual(
    timeline.frames.map((f) => f.state),
    ["ok", "reference-incomplete", "reference-incomplete"],
  );
  strictEqual(timeline.frames[2].compare, null, "no verdict when the reference is known-incomplete");
});

// ---------------------------------------- invalid recorded spawns (timeline-level)

/**
 * Reader-level-consistent logs whose recorded spawn the TRANSITION
 * contradicts. Isolated regressions for each invalid-spawn defect, each
 * with and without an after board (both code paths).
 */

test("a spawn on an occupied reference cell is corrupt, not silently ignored — with after boards", () => {
  const before = [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const slid = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [2, 0, 0, 0]]; // Down moved the 2 to (3,0)
  const log = readReplayLog(
    {
      format: "playkit-replay-log/1",
      moves: [
        // The spawn claims (3,0) — the very cell the slide just filled. The
        // observed after matches the slide, so the fix-less timeline noted
        // "not overwritten" and reported ok on a record that never happened.
        { id: "m0001", dir: 2, before, after: slid, spawn: { r: 3, c: 0, value: 2 } },
        { id: "m0002", dir: 1, before: slid, after: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 2, 2]], spawn: { r: 3, c: 2, value: 2 } },
      ],
    },
    { fileName: "occupied-after.json" },
  );
  strictEqual(log.counts.corrupt, 0, "isolated: the reader alone cannot catch this — both events read clean");
  const timeline = buildTimeline(log);
  deepStrictEqual(timeline.frames.map((f) => f.state), ["corrupt", "unverifiable"]);
  strictEqual(timeline.frames[0].referenceAfter, null, "nothing is applied to the reference chain");
  assert.match(timeline.frames[0].notes.join(" "), /occupied/);
});

test("a spawn on an occupied reference cell is corrupt — without an after board too", () => {
  const before = [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const log = readReplayLog(
    {
      format: "playkit-replay-log/1",
      moves: [
        { id: "m0001", dir: 2, before, after: null, spawn: { r: 3, c: 0, value: 2 } },
        { id: "m0002", dir: 1, before: null, after: null, spawn: null },
      ],
    },
    { fileName: "occupied-no-after.json" },
  );
  strictEqual(log.counts.corrupt, 0, "isolated: reader-level state is missing, not corrupt");
  const timeline = buildTimeline(log);
  deepStrictEqual(timeline.frames.map((f) => f.state), ["corrupt", "unverifiable"]);
  strictEqual(timeline.frames[0].referenceAfter, null);
  assert.match(timeline.frames[0].notes.join(" "), /occupied/);
});

test("a spawn after a no-op move is corrupt, not applied-and-reported-ok — with after boards", () => {
  const before = [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const log = readReplayLog(
    {
      format: "playkit-replay-log/1",
      moves: [
        // Up changes nothing here, yet the log records a spawn at (1,0) and
        // an after board carrying it: the fix-less timeline applied the
        // spawn to the reference and reported ok on an impossible history.
        { id: "m0001", dir: 0, before, after: [[2, 0, 0, 0], [2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], spawn: { r: 1, c: 0, value: 2 } },
        { id: "m0002", dir: 0, before: [[2, 0, 0, 0], [2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], after: [[4, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 2]], spawn: { r: 3, c: 3, value: 2 } },
      ],
    },
    { fileName: "noop-after.json" },
  );
  strictEqual(log.counts.corrupt, 0, "isolated: the reader alone cannot catch this — both events read clean");
  const timeline = buildTimeline(log);
  deepStrictEqual(timeline.frames.map((f) => f.state), ["corrupt", "unverifiable"]);
  strictEqual(timeline.frames[0].referenceAfter, null, "the phantom spawn is never applied");
  assert.match(timeline.frames[0].notes.join(" "), /no-op/);
});

test("a spawn after a no-op move is corrupt — without an after board too", () => {
  const before = [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const log = readReplayLog(
    {
      format: "playkit-replay-log/1",
      moves: [
        { id: "m0001", dir: 0, before, after: null, spawn: { r: 1, c: 0, value: 2 } },
        { id: "m0002", dir: 1, before: null, after: null, spawn: null },
      ],
    },
    { fileName: "noop-no-after.json" },
  );
  strictEqual(log.counts.corrupt, 0, "isolated: reader-level state is missing, not corrupt");
  const timeline = buildTimeline(log);
  deepStrictEqual(timeline.frames.map((f) => f.state), ["corrupt", "unverifiable"]);
  strictEqual(timeline.frames[0].referenceAfter, null);
  assert.match(timeline.frames[0].notes.join(" "), /no-op/);
});

test("legacy moveLog (the bench shape: id-less entries, spawn recorded) loads and compares", () => {
  const timeline = buildTimeline(load("legacy-moveLog.json"));
  strictEqual(timeline.frames.length, 5);
  timeline.frames.forEach((frame) => {
    strictEqual(frame.state, "ok");
    strictEqual(frame.spawn !== null, true, "bench moveLog entries record spawn");
  });
});
