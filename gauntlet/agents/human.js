/**
 * The human agent: a person playing a Gauntlet episode at the terminal.
 *
 * `gauntlet play --agent human` (or `human:<name>`) seats this agent and the
 * game runs exactly as it does for any other agent — same runner, same
 * referee, same trajectory shape — so the recording verifies like any other
 * and can be scored, replayed, and filed beside model runs. The point is the
 * RHAE human baseline: scoring's `h` is "solved pass@2 by at least two
 * humans" (docs/DESIGN.md section 5), and until now there was no way for a
 * person to play an episode at all.
 *
 * Input and output:
 *
 *   - The rules are printed once, on the agent's first turn.
 *   - Every turn prints the observation text, the previous invalid attempt's
 *     referee reason (when there is one), the legal actions numbered when
 *     there are few (at most `maxNumbered`), and a prompt.
 *   - All of this goes to stderr, so stdout stays machine-readable (the
 *     `play` summary) and the transcript can be captured with `2>`.
 *
 * Input grammar, one line per turn:
 *
 *   <number>        play the numbered legal action from the list above
 *   <action text>   anything else non-empty is forwarded verbatim to the
 *                   referee: the game's parseAction and legality check judge
 *                   it exactly as they judge any agent reply
 *   help (h, ?)     print the input help and re-prompt
 *   quit (q, exit, forfeit)
 *                   forfeit the episode (see below)
 *
 *   Empty lines and out-of-range or non-numeric input when a numbered list is
 *   shown are agent-grammar errors: they re-prompt and never consume an
 *   action. An illegal — or game-unparseable — action text takes the normal
 *   invalid path: it consumes an attempt, returns as feedback next turn, and
 *   after enough consecutive invalid attempts forfeits the episode, exactly
 *   as for every other agent. The agent deliberately does NOT pre-validate
 *   action text against the legal list, so a human-baseline run measures
 *   invalid-action rates under the same referee as a model run.
 *
 * Quitting: the Agent contract has no quit signal — the runner ends an
 * episode as forfeit only through the invalid-reply path. On `quit` (or EOF
 * on stdin: a player who closed the input has stopped playing) the agent
 * returns an empty reply — guaranteed invalid under `extractAction` — marked
 * `meta: { human: { quit: true } }`, and keeps returning it without further
 * prompting until the episode ends as `forfeit-invalid` (agent 0, everyone
 * else 1, the standard forfeit outcome). The `meta.human.quit` marks make the
 * forfeited steps self-explanatory in the trajectory and in the
 * studies/human-baseline kit.
 *
 * Works without a TTY: stdin is read through readline regardless of what it
 * is attached to, so scripted input (`... < script.txt`) drives a full
 * episode. Node-only (imports `node:*`), unlike the browser-safe baseline
 * agents.
 *
 * @module
 */

import readline from 'node:readline';

/** @import { Agent, AgentReply, TurnContext } from '../core/types.js' */

/**
 * One readline interface per input stream, shared by every human agent
 * seated from that stream. Sharing (instead of one interface per agent)
 * is what makes sequential episodes on one stream work: read-but-
 * unconsumed lines stay in the stream-level `buffer`, and explicit
 * subscribe/pause moves ownership between agents. `eof` records that the
 * stream has ended so a late subscriber takes the forfeit path immediately.
 *
 * @typedef {object} SharedInput
 * @property {readline.Interface} rl
 * @property {string[]} buffer Lines read but not yet consumed, retained at
 *   the stream level so they survive across agents (episodes).
 * @property {Set<{ onClose: () => void }>} subscribers
 * @property {boolean} eof
 */

/** @type {WeakMap<import('node:stream').Readable, SharedInput>} */
const sharedInputs = new WeakMap();

/**
 * @param {import('node:stream').Readable} input
 * @returns {SharedInput}
 */
function acquireInput(input) {
  let shared = sharedInputs.get(input);
  if (shared !== undefined) return shared;
  const rl = readline.createInterface({ input, terminal: false });
  shared = {
    rl,
    buffer: [],
    subscribers: new Set(),
    eof: false,
  };
  rl.on('line', (line) => {
    // Stream-level retention: lines land in the shared buffer whether or
    // not an agent is subscribed, so a resume flush (a whole piped script
    // parsed into line events in one tick) is never dropped with a
    // disposed agent's private queue.
    shared.buffer.push(line);
  });
  rl.on('close', () => {
    shared.eof = true;
    for (const subscriber of shared.subscribers) subscriber.onClose();
  });
  sharedInputs.set(input, shared);
  return shared;
}

/**
 * @typedef {object} HumanAgentOptions
 * @property {string} [name] Player name for the agent id: `human:<name>`.
 *   The name is descriptive only — the trajectory's agent id records it, but
 *   nothing keys scores or identity to it.
 * @property {import('node:stream').Readable} [input] The stream to read moves
 *   from. Default `process.stdin`.
 * @property {import('node:stream').Writable} [output] The stream the rules,
 *   observations and prompts are written to. Default `process.stderr`.
 * @property {number} [maxNumbered] Largest legal-action count that is printed
 *   numbered. Above it the list is summarized (the count only) and the player
 *   types the action text. Default 64 — the same threshold observations use
 *   for embedding the legal-action list.
 */

const HELP_TEXT = [
  'input:',
  '  <number>        play the numbered legal action from the list above',
  '  <action text>   play that action — the referee judges it exactly like',
  '                  any agent reply (an illegal or unparseable action',
  '                  consumes an attempt, just as for every other agent)',
  '  help (h, ?)     show this help and re-prompt',
  '  quit (q, exit, forfeit)',
  '                  forfeit the episode; the recording ends forfeit-shaped',
  'Empty lines and out-of-range numbers re-prompt and never consume an action.',
].join('\n');

/**
 * Build the human agent for one episode. One agent instance reads one input
 * stream, so — like model agents — create one per episode, not one shared
 * across a concurrent suite run.
 *
 * @param {HumanAgentOptions} [options]
 * @returns {Agent}
 */
export function createHumanAgent(options = {}) {
  const name = options.name;
  const id = name ? `human:${name}` : 'human';
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const maxNumbered = options.maxNumbered ?? 64;
  if (!Number.isInteger(maxNumbered) || maxNumbered < 1) {
    throw new Error(
      `createHumanAgent: maxNumbered must be an integer >= 1, got ${options.maxNumbered}`
    );
  }
  if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
    throw new Error('createHumanAgent: name must be a non-empty string when given');
  }

  // Input plumbing: one readline interface PER INPUT STREAM, shared by
  // every human agent seated from that stream (a WeakMap keyed by the
  // stream). Re-creating an interface per agent would steal already-buffered
  // lines and never release the stream; a shared interface with explicit
  // ownership does both jobs:
  //
  //   - Lines land in the SHARED stream-level buffer, not in the reading
  //     agent's queue. Pausing the interface does NOT retain a chunk that
  //     is already buffered: resuming for a new agent flushes every line
  //     in such a chunk in one tick, so a whole piped script can land
  //     while one episode is still reading. Because the buffer is shared,
  //     the lines that agent does not consume survive its dispose() and
  //     are still there for the next episode's agent.
  //   - dispose() unsubscribes; when the last subscriber leaves, the
  //     interface pauses and the stream is released for the next episode's
  //     agent (who resumes it) instead of holding process.stdin forever.
  let closed = false;
  let started = false;
  let rulesShown = false;
  let quitting = false;
  /** @type {{ onClose: () => void } | null} */
  let subscription = null;
  /** @type {ReturnType<typeof acquireInput> | null} */
  let shared = null;

  /**
   * Attach to the shared interface lazily, on the first turn, so an agent
   * built but never seated does not hold the process's stdin open. Later
   * turns re-arm the interface idleInput() paused: without this, an
   * interactively typed move would sit in the stream and never flow after
   * turn 1.
   *
   * @returns {void}
   */
  function startInput() {
    if (started) {
      // Turn 2+ of the same episode: idleInput() paused the shared interface
      // when this agent was its only subscriber. Resume so typed input flows
      // again — harmless with more than one subscriber (only a sole
      // subscriber ever pauses it), and piped flushes are absorbed by the
      // stream-level shared buffer by design.
      if (shared !== null && !shared.eof) {
        shared.rl.resume();
      }
      return;
    }
    started = true;
    shared = acquireInput(input);
    subscription = {
      onClose: () => {
        closed = true;
      },
    };
    shared.subscribers.add(subscription);
    if (shared.eof) {
      // The stream ended before this agent subscribed (a previous episode
      // consumed the script): take the forfeit path immediately.
      closed = true;
    } else {
      shared.rl.resume();
    }
  }

  /**
   * Release the stream while this agent is not awaiting a line: pause the
   * shared interface when this agent is its only subscriber, so piped data
   * waits for the next reader instead of piling into this agent's queue.
   *
   * @returns {void}
   */
  function idleInput() {
    if (shared !== null && shared.subscribers.size === 1 && !shared.eof) {
      shared.rl.pause();
    }
  }

  /**
   * The next input line, or null at EOF. Resolves as soon as a line is
   * buffered or the input stream closes.
   *
   * @returns {Promise<string | null>}
   */
  async function nextLine() {
    for (;;) {
      const line = shared !== null ? shared.buffer.shift() : undefined;
      if (line !== undefined) return line;
      if (closed) return null;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /**
   * @param {string} text
   * @returns {void}
   */
  function say(text) {
    output.write(`${text}\n`);
  }

  /**
   * The forfeit reply: an empty text is guaranteed invalid under the runner's
   * `extractAction` ("no action found in reply"), so it walks the standard
   * invalid path to a forfeit without pretending to be a game action.
   *
   * @returns {AgentReply}
   */
  function quitReply() {
    return { text: '', meta: { human: { quit: true } } };
  }

  return {
    id,
    track: /** @type {'community'} */ ('community'),
    async act(ctx) {
      startInput();

      try {
        if (quitting) {
          // Already quitting: no further prompting, just keep feeding the
          // invalid path until the runner's forfeit threshold ends the episode.
          return quitReply();
        }

      if (!rulesShown) {
        rulesShown = true;
        say('=== PlayKit Gauntlet — human at the terminal ===');
        say(
          `game     ${ctx.spec.title} (${ctx.spec.id} v${ctx.spec.version}), tier ${ctx.tier.id}`
        );
        say(`seat     ${ctx.seat}${ctx.spec.seats > 1 ? ` of ${ctx.spec.seats}` : ''}`);
        say(`rules    ${ctx.spec.rulesText}`);
        say(HELP_TEXT);
      }

      const legal = ctx.legalActions;
      say('');
      say(`--- turn ${ctx.turn + 1} (seat ${ctx.seat}) ---`);
      say(ctx.observation.text);
      if (ctx.feedback) {
        say(`Your last action was rejected: ${ctx.feedback}`);
      }
      if (Array.isArray(legal)) {
        if (legal.length <= maxNumbered) {
          say(`legal actions (${legal.length}):`);
          legal.forEach((action, i) => say(`  ${i + 1}) ${action}`));
        } else {
          say(
            `legal actions: ${legal.length} (too many to list — type the action text; see the rules above)`
          );
        }
      }

      for (;;) {
        output.write('Move — number, action text, help, quit: ');

        const line = await nextLine();
        if (line === null) {
          say('');
          say('input closed — forfeiting (the recording ends forfeit-shaped).');
          quitting = true;
          return quitReply();
        }
        const text = line.trim();

        if (text === '') {
          say('(empty line ignored — type an action, its number, help, or quit)');
          continue;
        }

        if (/^-?\d+$/.test(text)) {
          const n = Number(text);
          if (Array.isArray(legal) && n >= 1 && n <= legal.length) {
            return { text: /** @type {string} */ (legal[n - 1]) };
          }
          say(
            `(no legal action number ${text}${
              Array.isArray(legal) ? ` — pick 1 to ${legal.length}` : ''
            })`
          );
          continue;
        }

        if (text === 'help' || text === 'h' || text === '?') {
          say(HELP_TEXT);
          continue;
        }

        if (text === 'quit' || text === 'q' || text === 'exit' || text === 'forfeit') {
          say('quitting — the episode ends forfeit-shaped (your score: 0).');
          quitting = true;
          return quitReply();
        }

        // Anything else is the action text: forwarded verbatim. The referee
        // (parseAction + legality) decides, the same as for any agent — an
        // illegal action consumes an attempt and comes back as feedback.
        return { text: line.trim() };
      }
      } finally {
        // The turn is over (action, quit, or forfeit): release the stream so
        // the next episode's agent — or the next reader of this stream —
        // owns it.
        idleInput();
      }
    },

    /**
     * Release the input stream: unsubscribe from the shared interface and,
     * when this was the last subscriber, pause it. The runner calls this at
     * episode end; without it the interface would hold the stream (and the
     * process's stdin) open after the episode.
     *
     * @returns {Promise<void>}
     */
    async dispose() {
      if (subscription !== null && shared !== null) {
        shared.subscribers.delete(subscription);
        subscription = null;
        if (shared.subscribers.size === 0) {
          shared.rl.pause();
        }
      }
      shared = null;
      started = false;
    },
  };
}
