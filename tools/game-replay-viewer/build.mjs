#!/usr/bin/env node
/**
 * build.mjs — classify replay-log fixtures, build timelines, write
 * deterministic evidence exports and the frame/ID agreement check.
 *
 * Usage:
 *   node tools/game-replay-viewer/build.mjs \
 *     --fixtures tools/game-replay-viewer/fixtures \
 *     --out tools/game-replay-viewer/evidence
 *
 * Determinism: files are read in sorted order, every export is serialized
 * with sorted object keys and no timestamps, so repeated runs are
 * byte-identical regardless of paths. Exit 0 only when the frame/ID
 * agreement check passes.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FORMAT_ID, readReplayLog } from "./lib/replay-reader.mjs";
import { buildTimeline } from "./lib/timeline.mjs";

function parseArgs(argv) {
  const args = { fixtures: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const take = () => (inline !== null ? inline : argv[++i]);
    if (name === "--fixtures") args.fixtures = take();
    else if (name === "--out") args.out = take();
    else {
      console.error(`build.mjs: unknown argument ${JSON.stringify(name)}`);
      process.exit(2);
    }
  }
  if (!args.fixtures || !args.out) {
    console.error("build.mjs: both --fixtures <dir> and --out <dir> are required");
    process.exit(2);
  }
  return { fixturesDir: resolve(args.fixtures), outDir: resolve(args.out) };
}

/** Deterministic JSON: sorted object keys, arrays in order, no NaN/undefined. */
function stableStringify(value) {
  if (Array.isArray(value)) return value.map(stableStringify);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableStringify(value[key]);
    return out;
  }
  return value;
}

const serialize = (value) => `${JSON.stringify(stableStringify(value), null, 2)}\n`;

const { fixturesDir, outDir } = parseArgs(process.argv.slice(2));
const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort();

const logs = [];
for (const file of files) {
  const raw = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
  const read = readReplayLog(raw, { fileName: file });
  const entry = {
    file,
    status: read.status,
    shape: read.shape,
    synthetic: read.synthetic,
    source: {
      identityState: read.source.identityState,
      name: read.source.name,
      seed: read.source.seed,
      scenario: read.source.scenario,
      recordedBy: read.source.recordedBy,
    },
    refusals: read.refusals,
    counts: read.counts,
    timelineStates: null,
  };
  if (read.status === "accepted") {
    const timeline = buildTimeline(read);
    entry.timelineStates = timeline.counts;
    entry.frames = timeline.frames;
  }
  logs.push(entry);
}

const frameStateAggregate = {};
for (const log of logs) {
  if (!log.timelineStates) continue;
  for (const [state, n] of Object.entries(log.timelineStates)) {
    frameStateAggregate[state] = (frameStateAggregate[state] || 0) + n;
  }
}

const summary = {
  files: files.length,
  accepted: logs.filter((l) => l.status === "accepted").length,
  refused: logs.filter((l) => l.status === "refused").length,
  frameStates: frameStateAggregate,
};

const classification = {
  generatedBy: "tools/game-replay-viewer/build.mjs",
  format: FORMAT_ID,
  note: "all fixtures are synthetic; deterministic export (sorted keys, no timestamps)",
  summary,
  logs: logs.map(({ frames, ...rest }) => rest),
};

mkdirSync(join(outDir, "timeline"), { recursive: true });
writeFileSync(join(outDir, "replay-classification.json"), serialize(classification));
for (const log of logs) {
  if (log.status !== "accepted") continue;
  writeFileSync(
    join(outDir, "timeline", log.file),
    serialize({ file: log.file, source: log.source, timelineStates: log.timelineStates, frames: log.frames }),
  );
}

// ---- frame/ID agreement -------------------------------------------------
// Frames must agree with the source log's event IDs: re-read every fixture,
// re-run the reader, and compare ID sequences against the frames just
// written (round-trip through the files on disk).
const mismatches = [];
let checkedFrames = 0;
for (const log of logs) {
  if (log.status !== "accepted") continue;
  const raw = JSON.parse(readFileSync(join(fixturesDir, log.file), "utf8"));
  const reread = readReplayLog(raw, { fileName: log.file });
  const eventIds = reread.events.map((e) => e.id);
  const onDisk = JSON.parse(readFileSync(join(outDir, "timeline", log.file), "utf8"));
  const frameIds = onDisk.frames.map((f) => f.frameId);
  const diskEventIds = onDisk.frames.map((f) => f.eventId);

  if (onDisk.frames.length !== reread.events.length) {
    mismatches.push({ file: log.file, kind: "frame-count", frames: onDisk.frames.length, events: reread.events.length });
  }
  eventIds.forEach((id, i) => {
    if (diskEventIds[i] !== id) mismatches.push({ file: log.file, kind: "event-id", frame: i, expected: id, got: diskEventIds[i] ?? null });
  });
  frameIds.forEach((id, i) => {
    if (id !== `f${i}`) mismatches.push({ file: log.file, kind: "frame-id", frame: i, expected: `f${i}`, got: id });
  });
  checkedFrames += onDisk.frames.length;
}

const agreement = {
  checkedLogs: logs.filter((l) => l.status === "accepted").length,
  checkedFrames,
  agree: mismatches.length === 0,
  mismatches,
};
writeFileSync(join(outDir, "frame-id-agreement.json"), serialize(agreement));

console.log(
  `build.mjs: ${summary.accepted} accepted, ${summary.refused} refused of ${summary.files} logs; ` +
    `${agreement.checkedFrames} frames checked, agreement ${agreement.agree ? "ok" : "FAILED"}`,
);
if (!agreement.agree) {
  console.error(JSON.stringify(mismatches, null, 2));
  process.exit(1);
}
