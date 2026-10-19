import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const release = path.join(here, '..', '..', 'journeys', 'release', 'release.sh');

describe('journeys/release/release.sh stage C output directory', () => {
  it('gives each stage-C pilot invocation a fresh output directory', () => {
    // The results bundle's spend ledger (spend.jsonl) is bundle-wide and is
    // read on every run invocation, resume or not. A stage C that writes to a
    // fixed path under the persistent default $WORK carries every earlier
    // release check's recorded spend against the same cap, until a healthy
    // rehearsal dies on pilot.sh's no-headroom guard. The directory must be
    // allocated fresh per invocation (mktemp -d), still under $WORK.
    const src = readFileSync(release, 'utf8');
    const lines = src.split('\n');
    const sites = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes('SEPARATION_RUN_OUT='));
    assert.equal(
      sites.length,
      1,
      `expected exactly one stage-C SEPARATION_RUN_OUT assignment, found ${sites.length}: ` +
        sites.map(({ index }) => `line ${index + 1}`).join(', ')
    );
    const [site] = sites;
    // The fresh directory may be allocated on a line just above the export
    // (PILOT_OUT="$(mktemp -d ...)"), so judge the assignment's block.
    const block = lines.slice(Math.max(0, site.index - 3), site.index + 1).join('\n');
    assert.match(
      block,
      /mktemp\s+-d/,
      `stage C must allocate a fresh output directory per invocation (mktemp -d) — ` +
        `a fixed path carries the bundle-wide spend ledger across release checks (line ${site.index + 1})`
    );
    assert.match(
      block,
      /\$WORK/,
      'the fresh stage-C directory must stay under the journey work tree (line ' +
        `${site.index + 1})`
    );
  });
});
