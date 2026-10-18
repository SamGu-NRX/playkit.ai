/**
 * run-cells resumption order: the completion verdict must run against the
 * expected manifest BEFORE clearStaleBundle's cleanup removes the bundle.
 * Verdict-then-clear let one resumption skip a stale cell that the same
 * invocation then cleared — the cell vanished from disk while the run
 * reported it complete (Codex P1 #4303998316).
 *
 * The ordering is pinned statically: run-cells must derive the expected
 * manifest hash before calling cellComplete, and both dial and no-skill
 * paths must clear only AFTER an incomplete verdict.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

test('run-cells derives the expected manifest before each completion verdict', async () => {
  const source = await readFile(join(here, 'run-cells.mjs'), 'utf8');
  for (const verdict of ['dialVerdict', 'noSkillVerdict']) {
    const deriveAt = source.indexOf(`const { suite } = tierSuite(gameId, tier.id);\n        const ${verdict} = await cellComplete(bundle, gameId, tier.id, seeds, {`);
    assert.ok(deriveAt !== -1, `${verdict}: expected-manifest derivation must feed cellComplete directly`);
    const clearAt = source.indexOf('await clearStaleBundle(bundle, suite,', deriveAt);
    assert.ok(clearAt !== -1 && clearAt > deriveAt, `${verdict}: the stale-bundle clear must follow the verdict, never precede it`);
    assert.ok(
      source.indexOf(`await ${verdict.replace('Verdict', 'Complete')}`) === -1,
      `${verdict}: the verdict call must pass the expected manifest (no bare cellComplete call)`
    );
  }
});

test('cellComplete refusals name a stale manifest before any cleanup can run', async () => {
  const source = await readFile(join(here, 'audit-lib.mjs'), 'utf8');
  const manifestBlock = source.slice(
    source.indexOf('if (opts.expectedManifestSha256 !== undefined)'),
    source.indexOf('const tier =', source.indexOf('if (opts.expectedManifestSha256 !== undefined)'))
  );
  assert.ok(manifestBlock.includes('differs from the expected'), 'manifest mismatch refusal present');
  assert.ok(manifestBlock.includes('no readable suite.json manifest'), 'missing-manifest refusal present');
});
