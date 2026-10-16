# Word list sources and licences

The Wordle game bundles four word lists as generated JavaScript data modules:

| File | Words | Role |
| --- | --- | --- |
| `data/words-4.js` | 3,903 guesses / 2,154 answers | the `four-letter-10` tier |
| `data/words-5.js` | 8,636 guesses / 3,251 answers | the `classic` and `hard-mode` tiers |

Both modules export `GUESS_WORDS` (every legal guess) and `ANSWER_WORDS`
(hidden answers), sorted, uppercase, one string per entry. **Generated data —
do not edit by hand.**

## Derivation

1. Download the ENABLE1 word list and keep every entry that is pure ASCII
   lowercase `a-z` and exactly 4 (resp. 5) characters long. That is the
   guess list.
2. Download the SCOWL-derived Hunspell `en_US` dictionary (the standard
   American English spell-check word list), strip the affix flags after the
   `/` in each entry, and keep pure lowercase alphabetic roots. The answer
   list is the intersection: guess-list words that also appear there.

Commands (run from a directory holding `enable.txt` and `en_US.dic`):

```sh
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const enable = readFileSync("enable.txt", "utf8").split(/\r?\n/)
  .map(w => w.trim().toLowerCase()).filter(w => /^[a-z]+$/.test(w));
const enUs = new Set(readFileSync("en_US.dic", "utf8").split(/\r?\n/).slice(1)
  .map(l => l.replace(/\/.*$/, "").trim().toLowerCase())
  .filter(w => /^[a-z]+$/.test(w)));
for (const len of [4, 5]) {
  const guesses = [...new Set(enable.filter(w => w.length === len))].sort();
  const answers = guesses.filter(w => enUs.has(w));
  writeFileSync(`g${len}.txt`, guesses.join(" "));
  writeFileSync(`a${len}.txt`, answers.join(" "));
}'
```

(Committed by hand from this output on 2026-10-16; the committed modules hold
the words as sorted string-literal arrays.)

## Sources

### ENABLE1 — guess lists

- Downloaded 2026-10-16 from
  <https://www.wordgamedictionary.com/enable/download/enable.txt>
  (172,819 entries, one word per line, CRLF).
- SHA-256 of the downloaded file:
  `d3fbe8485022088fcf527edcde2fbdc18b4bbc141ac58123c9adb462e086eaf7`.
- ENABLE (the Enhanced North American Benchmark Lexicon) was compiled by Alan
  Beale and Mendel Cooper and released into the public domain; it is the
  standard word-list source for open-source word games. No attribution is
  required for public-domain material, but this file records the provenance
  anyway.

### SCOWL-derived Hunspell en_US — the answer ("common word") filter

- Downloaded 2026-10-16 from
  <https://github.com/en-wl/wordlist/releases/download/rel-2026.02.25/hunspell-en_US-2026.02.25.zip>
  (`en_US.dic`, 47,551 dictionary entries; 47,151 alphabetic roots after
  flag-stripping).
- SHA-256 of `en_US.dic`:
  `ab012ae86ce4b46b60db5b150869288de9c4a87bc747911764e582125b1b961e`.
- The SCOWL-derived English word lists are distributed under the following
  permission notice, quoted from the `Copyright` file shipped with the
  SCOWL 7.1 sources and the `aspell6-en-2026.02.25-0` package
  (<https://github.com/en-wl/wordlist>, tag `rel-2026.02.25`):

  > The collective work is Copyright 2000-2011 by Kevin Atkinson as well
  > as any of the copyrights mentioned below:
  >
  >   Copyright 2000-2011 by Kevin Atkinson
  >
  >   Permission to use, copy, modify, distribute and sell these word
  >   lists, the associated scripts, the output created from the scripts,
  >   and its documentation for any purpose is hereby granted without fee,
  >   provided that the above copyright notice appears in all copies and
  >   that both that copyright notice and this permission notice appear in
  >   supporting documentation. Kevin Atkinson makes no representations
  >   about the suitability of this array for any purpose. It is provided
  >   "as is" without express or implied warranty.

That notice (an MIT-style licence with attribution) is compatible with
redistribution in this Apache-2.0 repository: the notice is reproduced here,
satisfying its "copyright notice appears in all copies" condition for the
derived data committed under `gauntlet/games/wordle/data/`.

## Why these lists

- The guess list needs to be large (near-complete English coverage) so that
  information-gathering guesses are not artificially restricted; ENABLE is
  public domain and is the de facto standard for that.
- The answer list needs to contain words a player would plausibly know. The
  standard American English spell-check dictionary is a principled,
  reproducible "common word" filter: it keeps `aback`, `abbey`, `crane` and
  drops ENABLE's obscure remainder (`aalii`, `zanza`, ...). Every answer is a
  legal guess.

## Regeneration check

`wordle.test.js` asserts the exact list sizes above (3,903 / 2,154 / 8,636 /
3,251), so an accidental regeneration drift, truncation or re-sorting fails
the build instead of silently changing the benchmark.
