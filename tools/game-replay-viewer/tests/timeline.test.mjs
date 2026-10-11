/**
 * Timeline tests — frame states against the committed synthetic fixtures,
 * using the repo's reference API read-only.
 */
import { deepStrictEqual, strictEqual, throws } from "node:assert";
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

test("legacy moveLog (the bench shape: id-less entries, spawn recorded) loads and compares", () => {
  const timeline = buildTimeline(load("legacy-moveLog.json"));
  strictEqual(timeline.frames.length, 5);
  timeline.frames.forEach((frame) => {
    strictEqual(frame.state, "ok");
    strictEqual(frame.spawn !== null, true, "bench moveLog entries record spawn");
  });
});
