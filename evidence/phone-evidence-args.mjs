/**
 * CLI parsing for the Burst14 phone-run evidence driver, extracted pure so
 * tests can pin the accepted flag forms without Playwright (the driver file
 * itself stays outside the typecheck program).
 *
 * Both spellings work: `--name value` and the documented `--name=value` (the
 * driver usage header always showed the = form, but the old inline parser
 * only read the space form, so the documented "--label=before --out=..."
 * invocation silently fell back to the defaults — wrong directory, wrong
 * label prefix on every artifact).
 */

/**
 * @param {string[]} argv
 * @param {string} defaultOut
 * @returns {{ label: string, outDir: string, only: string[] }}
 */
export function parseCliArgs(argv, defaultOut) {
  /**
   * @param {string} name
   * @param {string} fallback
   * @returns {string}
   */
  function argValue(name, fallback) {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq !== undefined) return eq.slice(`--${name}=`.length) || fallback;
    const at = argv.indexOf(`--${name}`);
    return at !== -1 && argv[at + 1] ? argv[at + 1] : fallback;
  }
  return {
    label: argValue("label", "after"),
    outDir: argValue("out", defaultOut),
    only: argv.filter((a) => a.startsWith("--only=")).map((a) => a.slice("--only=".length)),
  };
}
