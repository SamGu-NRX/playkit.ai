import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const release = path.join(here, '..', '..', 'journeys', 'release', 'release.sh');

/**
 * Run release.sh with stage C selected and return the SEPARATION_RUN_OUT the
 * stage-C pilot rehearsal was handed.
 *
 * The rehearsal itself is intercepted at the PATH-stub boundary so the test
 * observes exactly what release.sh allocates without running a rehearsal: a
 * `bash` stub records the SEPARATION_RUN_OUT environment variable that the
 * `journeys/pilot/rehearse.sh` invocation receives, and a `node` stub no-ops
 * the `run_gauntlet suite build` prerequisite. The directory allocation
 * itself — `mktemp -d` under $WORK — still runs for real; that is the
 * behavior under test. Everything lives in a per-test temp sandbox
 * (JOURNEY_WORK): no repository state, no network, no engines.
 *
 * @param {string} work JOURNEY_WORK for the invocation.
 * @param {string} stubs directory holding the node and bash PATH stubs.
 * @param {string} capture file the bash stub writes SEPARATION_RUN_OUT into.
 * @returns {string} the output directory handed to the rehearsal.
 */
const runStageC = (work, stubs, capture) => {
  // Snapshot the work tree before the invocation: a fresh allocation must
  // create a directory that did not exist before it.
  const before = new Set(readdirSync(work));
  execFileSync('/bin/bash', [release], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH}`,
      JOURNEY_WORK: work,
      RELEASE_STAGES: 'C',
      STAGEC_CAPTURE: capture,
    },
  });
  assert.ok(existsSync(capture), 'release.sh did not invoke the stage-C pilot rehearsal');
  const out = readFileSync(capture, 'utf8');
  // Remove the capture so the next invocation has to produce it again.
  rmSync(capture);
  assert.ok(
    out.length > 0,
    'the stage-C rehearsal was invoked without SEPARATION_RUN_OUT — ' +
      'separation-run.sh then falls back to a shared default path under the repo'
  );
  assert.ok(
    existsSync(out) && statSync(out).isDirectory(),
    `the rehearsal was handed "${out}", which is not an existing directory`
  );
  assert.ok(
    out.startsWith(`${work}/`),
    `the rehearsal was handed "${out}", outside the journey work tree ${work}`
  );
  assert.notEqual(
    out,
    path.join(work, 'pilot'),
    'the rehearsal was handed the fixed $WORK/pilot directory stage C used to ' +
      'reuse — a results bundle records its spend ledger (spend.jsonl) ' +
      'bundle-wide, so a reused directory carries earlier release checks ' +
      'against the same cap'
  );
  assert.ok(
    !before.has(path.basename(out)),
    `the rehearsal was handed "${out}", which already existed in the journey ` +
      'work tree before this invocation — a results bundle records its spend ' +
      'ledger (spend.jsonl) bundle-wide, so a reused directory carries ' +
      "earlier release checks' recorded spend against the same cap"
  );
  return out;
};

describe('journeys/release/release.sh stage C output directory', () => {
  it('hands each rehearsal invocation a fresh output directory allocated under the journey work tree', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'release-stage-c-'));
    const stubs = path.join(sandbox, 'stubs');
    const work = path.join(sandbox, 'journey-work');
    const capture = path.join(sandbox, 'captured-separation-run-out');
    mkdirSync(stubs);

    // The regression this pins: stage C pointed the rehearsal at the fixed
    // $WORK/pilot, and the default $WORK survives between invocations. Plant
    // that directory with a ledger marker; neither invocation may pick it.
    const stale = path.join(work, 'pilot');
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, 'spend.jsonl'), '{"reused":"stale"}\n');

    // PATH stubs — everything else, mktemp included, stays real:
    //   node — `run_gauntlet suite build` is a prerequisite, not the subject: exit 0
    //   bash — the rehearsal invocation records SEPARATION_RUN_OUT and exits 0
    writeFileSync(
      path.join(stubs, 'node'),
      `#!/bin/sh\n[ "$1" = "cli/gauntlet.js" ] && exit 0\nexec '${process.execPath}' "$@"\n`
    );
    writeFileSync(
      path.join(stubs, 'bash'),
      '#!/bin/sh\n' +
        'case "${1##*/}" in\n' +
        "  rehearse.sh) printf '%s' \"${SEPARATION_RUN_OUT-}\" > \"$STAGEC_CAPTURE\"; exit 0;;\n" +
        '  *) exec /bin/bash "$@";;\n' +
        'esac\n'
    );
    chmodSync(path.join(stubs, 'node'), 0o755);
    chmodSync(path.join(stubs, 'bash'), 0o755);

    const first = runStageC(work, stubs, capture);
    const second = runStageC(work, stubs, capture);
    assert.notEqual(
      first,
      second,
      'back-to-back stage-C invocations shared one output directory — the ' +
        'second rehearsal starts from the first one\'s recorded spend'
    );
  });
});
