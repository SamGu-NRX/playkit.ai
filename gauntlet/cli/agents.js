/**
 * Agent spec parsing for the CLI. Three spec forms:
 *
 *   random                          — the bundled seeded random agent (baseline).
 *   baseline:<game>:<greedy|engine> — that game's bundled baseline, scoped to
 *                                     its own game's episodes in a suite run.
 *   skill:<p>:<expert-spec>         — the skill dial (agents/skill-dial.js):
 *                                     the expert degraded toward random play by
 *                                     a per-turn noise probability p in [0, 1].
 *                                     <expert-spec> is "random" or any baseline
 *                                     spec, e.g. `skill:0.25:baseline:sokoban:
 *                                     engine`. The agent id recorded in
 *                                     trajectories is the dial's own,
 *                                     `dial-<expert id>-p<p*100>`.
 *   community-assisted:<provider>/<model>[:retries=N]
 *                                   — the community-track assisted harness
 *                                     (community/assisted-agent.js): the
 *                                     official-track model agent wrapped so it
 *                                     sees the legal actions every turn and may
 *                                     retry an invalid reply up to N times
 *                                     (default 2) within the same turn. Track
 *                                     "community": the leaderboard keeps these
 *                                     results out of the official table.
 *   human[:name]                    — a person at the terminal
 *                                     (agents/human.js): moves are read line
 *                                     by line from stdin (an action text, its
 *                                     number in the rendered legal list, help,
 *                                     or quit), the rules and observations go
 *                                     to stderr, and the recording verifies
 *                                     like any other. Works without a TTY, so
 *                                     scripted input drives it. Track
 *                                     "community": human baselines stay out of
 *                                     the official table.
 *   model:<provider>/<model>        — an official-track model agent through
 *                                     harness/model-agent.js (provider
 *                                     anthropic, openai or openai-chat;
 *                                     openai-chat speaks any OpenAI-compatible
 *                                     chat-completions server and requires
 *                                     --base-url <url>; every provider reads
 *                                     its key from the env var named by
 *                                     --api-key-env <VAR>). Pair with --prices
 *                                     for cost accounting, or with --dry-run
 *                                     and --script <file> to rehearse offline.
 *
 * Reasoning settings ride with model specs two ways, and are validated to
 * match the provider: --thinking-budget <tokens> (Anthropic extended
 * thinking) and --reasoning-effort <low|medium|high|xhigh|max> (reasoning
 * effort, sent for every provider: openai and openai-chat put it on the wire
 * today, provider anthropic sends it as output_config.effort)
 * as flags, or inline as a trailing `:key=value` list
 * on the model part — `model:anthropic/claude-opus-4-5:thinking-budget=10240`,
 * `model:openai/gpt-5.2:reasoning-effort=high`. A trailing segment that does
 * not match the settings grammar stays part of the model id, so Ollama-style
 * tags like `model:openai-chat/qwen2.5:7b` keep working. Settings are part of
 * the agent identity: the agent id carries a canonical settings suffix, so
 * the leaderboard prints the same model with different settings as different
 * entries.
 *
 * Node-only. The packet modules do the work; this file only resolves specs
 * into per-episode Agent instances.
 *
 * @module
 */

import { createRandomAgent } from '../agents/random.js';
import { skillDial } from '../agents/skill-dial.js';
import { createScriptedAgent } from '../harness/dry-run.js';
import { createModelAgent } from '../harness/model-agent.js';
import { createAssistedAgent } from '../community/assisted-agent.js';
import { createHumanAgent } from '../agents/human.js';
import { getGame } from '../games/index.js';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @import { Agent, Game, TierSpec, TurnContext } from '../core/types.js' */

/**
 * @typedef {object} AgentSpecContext
 * @property {Game<*>} game
 * @property {TierSpec} tier The real tier from the game spec, not a suite copy.
 * @property {string} seed
 * @property {number} agentSeat The seat the runner will seat the agent at.
 */

/**
 * @typedef {object} AgentSpec
 * @property {string} text The spec as written.
 * @property {string | null} gameId For `baseline:` specs, the game they scope to.
 * @property {'baseline' | 'official' | 'community'} track
 * @property {boolean} dryRun True when the spec runs offline by construction.
 * @property {(context: AgentSpecContext) => Agent | Promise<Agent>} createForEpisode
 *   Build the agent for one episode; seeded agents are per-episode by design.
 */

/**
 * @typedef {object} ParseAgentSpecOptions
 * @property {boolean} [dryRun] --dry-run: rehearse a model spec offline.
 * @property {string} [prices] --prices: path to a price file (PriceFile JSON).
 * @property {string} [script] --script: reply script for --dry-run runs.
 * @property {string} [baseUrl] --base-url: API root. Required for
 *   `openai-chat` (any OpenAI-compatible chat-completions server); optional
 *   for `anthropic`/`openai`, where it overrides the provider's public API.
 * @property {string} [apiKeyEnv] --api-key-env: the environment variable that
 *   holds the provider API key. The key itself is read from the environment
 *   at call time and never appears in the spec, the trajectory, or logs.
 * @property {number} [maxOutputTokens] --max-output-tokens: per-reply output
 *   token cap for live model specs, sent as the provider's max_tokens /
 *   max_output_tokens and recorded in run.json's limits.
 * @property {number} [thinkingBudget] --thinking-budget: Anthropic
 *   extended-thinking budget in tokens (budget_tokens), provider "anthropic"
 *   only, minimum 1024. Recorded in run.json's limits and in the agent id's
 *   settings suffix.
 * @property {'low' | 'medium' | 'high' | 'xhigh' | 'max'} [reasoningEffort]
 *   --reasoning-effort: reasoning effort, accepted for every provider —
 *   "openai" sends reasoning.effort and "openai-chat" the chat-completions
 *   reasoning_effort field (which is how Google's Gemini OpenAI-compatible
 *   endpoint takes it); the "anthropic" pairing is validated per model by the
 *   harness (harness/model-agent.js), which owns the wire contract. Recorded
 *   in run.json's limits and in the agent id's settings suffix.
 * @property {number} [callTimeoutMs] --call-timeout-ms: per-attempt timeout
 *   for live model specs; a timed-out attempt is retryable like a network
 *   error. Recorded in run.json's limits.
 */

/**
 * Load a reply script for the dry-run scripted agent. The file's default
 * export is either an array of reply strings (consumed in order) or a
 * function of the TurnContext returning a reply string or { text, meta? }.
 * `.json` files hold a plain array of reply strings.
 *
 * @param {string} path
 * @returns {Promise<string[] | ((ctx: TurnContext) => string | { text: string, meta?: * })>}
 */
async function importScriptFile(path) {
  if (path.endsWith('.json')) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
      throw new Error(`script file "${path}" must hold a JSON array of reply strings`);
    }
    return /** @type {string[]} */ (parsed);
  }
  const mod = await import(pathToFileURL(path).href);
  const exported = mod.default;
  if (typeof exported !== 'function' && !Array.isArray(exported)) {
    throw new Error(
      `script file "${path}" must default-export an array of reply strings or a function of the turn context`
    );
  }
  return exported;
}

/**
 * Per-game baseline factories for packets whose factory signature differs
 * from the standard shape (and for `sliding`, whose baseline lives outside
 * `games/<id>/baselines.js`). Everything else resolves through the standard
 * packet shape — `games/<id>/baselines.js` exporting `createGreedyAgent` and
 * `createEngineAgent`, each taking `({ episodeSeed })` — via
 * defaultBaselineFactory below, so a newly registered packet (wordle,
 * sudoku, go) is baseline-playable with no edit here. Exported for tests.
 *
 * @type {Record<string, (kind: 'greedy' | 'engine', context: { tier: TierSpec, seed: string, agentSeat: number }) => Promise<Agent>>}
 */
export const BASELINE_FACTORIES = {
  async chess(kind, { tier, seed, agentSeat }) {
    const { createGreedyBaselineAgent, createEngineBaselineAgent } = await import('../games/chess/baselines.js');
    return kind === 'greedy'
      ? createGreedyBaselineAgent()
      : createEngineBaselineAgent({ tier, seed, seat: agentSeat });
  },
  async 'chess-endgames'(kind, { tier, seed, agentSeat }) {
    const { greedyAgent, engineAgent } = await import('../games/chess-endgames/baselines.js');
    return kind === 'greedy'
      ? greedyAgent(tier, seed, agentSeat)
      : engineAgent(tier, seed, agentSeat);
  },
  async minesweeper(kind, { seed }) {
    const { createDeductionAgent, createProbabilityAgent } = await import('../games/minesweeper/baselines.js');
    return kind === 'greedy'
      ? createDeductionAgent({ episodeSeed: seed })
      : createProbabilityAgent({ episodeSeed: seed });
  },
  async '2048'(kind) {
    const { greedy, engine } = await import('../games/2048/baselines.js');
    return kind === 'greedy' ? greedy() : engine();
  },
  async sliding() {
    const { createSlidingSolverAgent } = await import('../agents/sliding-solver.js');
    // The sliding packet ships one baseline, the optimal reference solver;
    // both kinds resolve to it.
    return createSlidingSolverAgent();
  },
  async sokoban(kind) {
    const { greedyAgent, engineAgent } = await import('../games/sokoban/baselines.js');
    return kind === 'greedy' ? greedyAgent() : engineAgent();
  },
  async connect4(kind) {
    const { createGreedyAgent, createEngineAgent } = await import('../games/connect4/baselines.js');
    return kind === 'greedy' ? createGreedyAgent() : createEngineAgent();
  },
  async othello(kind) {
    // The engine baseline takes a node budget, not an options object; the
    // calibration ceiling (#68) runs the packet's 32,000-node negamax.
    const { createGreedyAgent, createEngineAgent } = await import('../games/othello/baselines.js');
    return kind === 'greedy' ? createGreedyAgent() : createEngineAgent(32000);
  },
  async holdem(kind, { seed, agentSeat }) {
    const { makeBaseline } = await import('../games/holdem/baselines.js');
    return makeBaseline(kind, seed, agentSeat);
  },
};

/**
 * Load `games/<id>/baselines.js` and return its standard-shape factory for
 * `kind`, refusing with the reason spelled out when the packet ships no
 * baselines module or lacks the export. Runs at parse time (so a spec for a
 * packet that ships none is refused before any run starts) and again at
 * create time through the module cache.
 *
 * @param {string} gameId
 * @param {'greedy' | 'engine'} kind
 * @returns {Promise<(options: { episodeSeed: string }) => Agent>}
 */
async function standardBaselineCreate(gameId, kind) {
  const exportName = kind === 'greedy' ? 'createGreedyAgent' : 'createEngineAgent';
  let mod;
  try {
    mod = /** @type {Record<string, unknown>} */ (
      await import(`../games/${gameId}/baselines.js`)
    );
  } catch (err) {
    if (/** @type {{ code?: string }} */ (err).code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        `game "${gameId}" ships no baseline agents; games with baselines: ${Object.keys(BASELINE_FACTORIES).join(', ')} — or games/${gameId}/baselines.js exporting createGreedyAgent/createEngineAgent({ episodeSeed })`
      );
    }
    throw err;
  }
  if (typeof mod[exportName] !== 'function') {
    throw new Error(
      `game "${gameId}" ships no ${kind} baseline agents: games/${gameId}/baselines.js does not export ${exportName}({ episodeSeed })`
    );
  }
  return /** @type {(options: { episodeSeed: string }) => Agent} */ (mod[exportName]);
}

/**
 * The standard-shape fallback: call the packet's
 * `createGreedyAgent`/`createEngineAgent` with `{ episodeSeed }`.
 *
 * @param {string} gameId
 * @param {'greedy' | 'engine'} kind
 * @param {{ seed: string }} context
 * @returns {Promise<Agent>}
 */
async function defaultBaselineFactory(gameId, kind, { seed }) {
  const create = await standardBaselineCreate(gameId, kind);
  return await create({ episodeSeed: seed });
}

/**
 * Parse an agent spec into a per-episode factory. Throws on unknown specs,
 * unknown baseline games, and model specs that misuse --dry-run/--script.
 *
 * @param {string} text
 * @param {ParseAgentSpecOptions} [options]
 * @returns {Promise<AgentSpec>}
 */
export async function parseAgentSpec(text, options = {}) {
  if (text === 'random') {
    return {
      text,
      gameId: null,
      track: 'baseline',
      dryRun: false,
      createForEpisode({ seed }) {
        return createRandomAgent({ episodeSeed: seed, id: 'random' });
      },
    };
  }

  const baselineMatch = /^baseline:([a-z0-9-]+):(greedy|engine)$/.exec(text);
  if (baselineMatch) {
    const gameId = baselineMatch[1];
    const kind = /** @type {'greedy' | 'engine'} */ (baselineMatch[2]);
    if (
      options.dryRun ||
      options.script ||
      options.prices ||
      options.maxOutputTokens !== undefined ||
      options.callTimeoutMs !== undefined ||
      options.thinkingBudget !== undefined ||
      options.reasoningEffort !== undefined
    ) {
      throw new Error(
        `agent spec "${text}" takes no --dry-run, --script, --prices, --max-output-tokens, --call-timeout-ms, --thinking-budget or --reasoning-effort flags`
      );
    }
    getGame(gameId); // fail fast on an unknown game id
    // Signature-differing entries first; the standard packet shape covers the
    // rest. Games with no explicit entry pre-flight their baselines module at
    // parse time, so a spec for a packet that ships none is refused before any
    // run starts — with the reason spelled out.
    if (!BASELINE_FACTORIES[gameId]) {
      await standardBaselineCreate(gameId, kind);
    }
    const factory = BASELINE_FACTORIES[gameId] ?? defaultBaselineFactory.bind(null, gameId);
    return {
      text,
      gameId,
      track: 'baseline',
      dryRun: false,
      createForEpisode(context) {
        if (context.game.spec.id !== gameId) {
          throw new Error(
            `agent spec "${text}" only plays game "${gameId}", not "${context.game.spec.id}"`
          );
        }
        // One run is one entry: every trajectory in the run bundle is
        // attributed to the spec the researcher asked for, never to a game
        // packet's tier-resolved id (chess names its engine per tier,
        // engine-<tier>). A run spanning several tiers would otherwise mix
        // agent identities in one bundle, and bundle verify's agent-identity
        // rule and the leaderboard's single-entry scoring would refuse it.
        return factory(kind, context).then((agent) => ({ ...agent, id: text }));
      },
    };
  }

  const skillMatch = /^skill:([^:]*):(.*)$/.exec(text);
  if (skillMatch) {
    const pRaw = skillMatch[1];
    const expertSpec = skillMatch[2];
    const p = Number(pRaw);
    if (pRaw === '' || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error(
        `agent spec "${text}": the skill dial's noise probability must be a number in [0, 1], got "${pRaw}"`
      );
    }
    if (
      options.dryRun ||
      options.script ||
      options.prices ||
      options.maxOutputTokens !== undefined ||
      options.callTimeoutMs !== undefined ||
      options.thinkingBudget !== undefined ||
      options.reasoningEffort !== undefined
    ) {
      throw new Error(
        `agent spec "${text}" takes no --dry-run, --script, --prices, --max-output-tokens, --call-timeout-ms, --thinking-budget or --reasoning-effort flags`
      );
    }

    // The dial is a baseline-track agent, so its expert is one too: "random"
    // or any game packet's bundled baseline. A model spec cannot wrap — the
    // dial needs the baseline track's legal actions on every turn.
    if (expertSpec === 'random') {
      return {
        text,
        gameId: null,
        track: 'baseline',
        dryRun: false,
        createForEpisode({ seed }) {
          return skillDial(createRandomAgent({ episodeSeed: seed, id: 'random' }), p, {
            episodeSeed: seed,
          });
        },
      };
    }
    const expertMatch = /^baseline:([a-z0-9-]+):(greedy|engine)$/.exec(expertSpec);
    if (!expertMatch) {
      throw new Error(
        expertSpec.startsWith('model:')
          ? `agent spec "${text}": the skill dial plays the baseline track, so its expert must be "random" or a baseline spec, not a model spec`
          : `agent spec "${text}": the expert must be "random" or "baseline:<game>:<greedy|engine>", got "${expertSpec}"`
      );
    }
    const expertGameId = expertMatch[1];
    const expertKind = /** @type {'greedy' | 'engine'} */ (expertMatch[2]);
    getGame(expertGameId); // fail fast on an unknown game id
    const expertFactory =
      BASELINE_FACTORIES[expertGameId] ?? defaultBaselineFactory.bind(null, expertGameId);
    return {
      text,
      gameId: expertGameId,
      track: 'baseline',
      dryRun: false,
      async createForEpisode(context) {
        if (context.game.spec.id !== expertGameId) {
          throw new Error(
            `agent spec "${text}" only plays game "${expertGameId}", not "${context.game.spec.id}"`
          );
        }
        const expert = await expertFactory(expertKind, context);
        return skillDial(expert, p, { episodeSeed: context.seed });
      },
    };
  }

  const communityMatch = /^community-assisted:([a-z0-9-]+)\/(.+)$/.exec(text);
  if (communityMatch) {
    const provider = communityMatch[1];
    let model = communityMatch[2];
    if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'openai-chat') {
      throw new Error(
        `agent spec "${text}": provider must be "anthropic", "openai" or "openai-chat", got "${provider}"`
      );
    }

    // A trailing `:retries=N` peels off the same way the model spec's settings
    // suffix does; any other colon stays part of the model id (Ollama tags).
    let retries = 2;
    const retriesMatch = /:retries=(\d+)$/.exec(model);
    if (retriesMatch) {
      retries = Number(retriesMatch[1]);
      model = model.slice(0, model.length - retriesMatch[0].length);
    }

    // The flags configure the inner official-track model agent, so the
    // dry-run/script/base-url rules are the model spec's rules. Thinking
    // settings are refused, not forwarded: the assisted harness's retry loop
    // already changes what the inner agent sees per turn, and this packet's
    // study runs temperature-0 local models with neither setting.
    if (
      options.thinkingBudget !== undefined ||
      options.reasoningEffort !== undefined
    ) {
      throw new Error(
        `agent spec "${text}": thinking-budget and reasoning-effort do not apply to the assisted harness; use them on a plain model: spec`
      );
    }
    if (options.dryRun && !options.script) {
      throw new Error(
        `--dry-run for "${text}" requires --script <file> with the replies to replay`
      );
    }
    if (options.script && !options.dryRun) {
      throw new Error(
        `--script <file> only applies with --dry-run; a live "${text}" run calls the provider`
      );
    }
    if (options.dryRun && options.maxOutputTokens !== undefined) {
      throw new Error(
        `--max-output-tokens bounds live provider calls and does not apply to a --dry-run "${text}" rehearsal`
      );
    }
    if (options.dryRun && options.callTimeoutMs !== undefined) {
      throw new Error(
        `--call-timeout-ms bounds live provider calls and does not apply to a --dry-run "${text}" rehearsal`
      );
    }

    // A live openai-chat agent has nowhere to call without a base URL; a
    // --dry-run rehearsal replays scripted replies and never dials a server.
    if (provider === 'openai-chat' && !options.baseUrl && !options.dryRun) {
      throw new Error(
        `agent spec "${text}": the openai-chat provider talks to any OpenAI-compatible chat-completions server, so it requires --base-url <url> (the request goes to <base-url>/v1/chat/completions, or the base URL as-is when it already ends in /chat/completions — e.g. Google's Gemini endpoint https://generativelanguage.googleapis.com/v1beta/openai/chat/completions)`
      );
    }

    const agentId = `community-assisted:${provider}/${model}:retries=${retries}`;

    if (options.dryRun) {
      const script = await importScriptFile(/** @type {string} */ (options.script));
      return {
        text,
        gameId: null,
        track: 'community',
        dryRun: true,
        createForEpisode() {
          return createAssistedAgent({
            inner: createScriptedAgent(script, { id: `model:${provider}/${model}` }),
            retries,
            id: agentId,
          });
        },
      };
    }

    /** @type {Record<string, *> | undefined} */
    const priceFile = options.prices
      ? JSON.parse(readFileSync(options.prices, 'utf8'))
      : undefined;

    return {
      text,
      gameId: null,
      track: 'community',
      dryRun: false,
      createForEpisode() {
        // One FRESH wrapper (and inner model agent) per episode: the inner
        // agent carries its previous reply across calls, so sharing would
        // leak one episode's conversation into the next, as with model specs.
        return createAssistedAgent({
          inner: /** @type {Agent} */ (
            createModelAgent({
              provider: /** @type {'anthropic' | 'openai' | 'openai-chat'} */ (provider),
              model,
              ...(priceFile ? { prices: priceFile } : {}),
              ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
              ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
              ...(options.maxOutputTokens !== undefined
                ? { maxOutputTokens: options.maxOutputTokens }
                : {}),
              ...(options.callTimeoutMs !== undefined
                ? { callTimeoutMs: options.callTimeoutMs }
                : {}),
              id: `model:${provider}/${model}`,
            })
          ),
          retries,
          id: agentId,
        });
      },
    };
  }

  // The human spec seats a person at the terminal (agents/human.js): the
  // same runner and referee as any agent, moves read line by line from
  // stdin. Community track by construction — the leaderboard keeps human
  // baselines out of the official table, and the legal-action list the agent
  // renders needs a non-official track. No flags apply: a human run has no
  // provider, prices, or reply script.
  const humanMatch = /^human(?::([^:]+))?$/.exec(text);
  if (humanMatch) {
    if (
      options.dryRun ||
      options.script ||
      options.prices ||
      options.maxOutputTokens !== undefined ||
      options.callTimeoutMs !== undefined ||
      options.thinkingBudget !== undefined ||
      options.reasoningEffort !== undefined ||
      options.baseUrl !== undefined ||
      options.apiKeyEnv !== undefined
    ) {
      throw new Error(
        `agent spec "${text}" takes no --dry-run, --script, --prices, --base-url, --api-key-env, --max-output-tokens, --call-timeout-ms, --thinking-budget or --reasoning-effort flags; a human plays from stdin`
      );
    }
    return {
      text,
      gameId: null,
      track: 'community',
      dryRun: false,
      createForEpisode() {
        return createHumanAgent(
          humanMatch[1] !== undefined ? { name: humanMatch[1] } : {}
        );
      },
    };
  }

  const modelMatch = /^model:([a-z0-9-]+)\/(.+)$/.exec(text);
  if (modelMatch) {
    const provider = modelMatch[1];
    let model = modelMatch[2];
    if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'openai-chat') {
      throw new Error(
        `agent spec "${text}": provider must be "anthropic", "openai" or "openai-chat", got "${provider}"`
      );
    }

    // A trailing `:key=value` list on the model part is a settings suffix;
    // peel known settings keys from the end. Any trailing segment that does
    // not fully match the grammar stays part of the model id, so model tags
    // that contain colons (Ollama's `qwen2.5:7b`) keep working.
    /** @type {Record<string, string>} */
    const suffixSettings = {};
    for (;;) {
      const m = /(,|:)(thinking-budget=(\d+)|reasoning-effort=(low|medium|high|xhigh|max))$/.exec(model);
      if (!m) break;
      const key = m[3] !== undefined ? 'thinking-budget' : 'reasoning-effort';
      const value = m[3] !== undefined ? m[3] : m[4];
      if (suffixSettings[key] !== undefined) {
        throw new Error(
          `agent spec "${text}": conflicting duplicate "${key}" settings suffix`
        );
      }
      suffixSettings[key] = value;
      model = model.slice(0, model.length - m[0].length);
    }
    if (
      suffixSettings['thinking-budget'] !== undefined &&
      options.thinkingBudget !== undefined
    ) {
      throw new Error(
        `agent spec "${text}": thinking-budget is set both in the spec suffix (${suffixSettings['thinking-budget']}) and with --thinking-budget (${options.thinkingBudget}); use one or the other`
      );
    }
    if (
      suffixSettings['reasoning-effort'] !== undefined &&
      options.reasoningEffort !== undefined
    ) {
      throw new Error(
        `agent spec "${text}": reasoning-effort is set both in the spec suffix (${suffixSettings['reasoning-effort']}) and with --reasoning-effort (${options.reasoningEffort}); use one or the other`
      );
    }

    /** @type {number | undefined} */
    let effectiveThinkingBudget = options.thinkingBudget;
    if (suffixSettings['thinking-budget'] !== undefined) {
      const parsed = Number(suffixSettings['thinking-budget']);
      if (!Number.isInteger(parsed) || parsed < 1024) {
        throw new Error(
          `agent spec "${text}": thinking-budget must be an integer >= 1024 (the Anthropic minimum budget_tokens), got "${suffixSettings['thinking-budget']}"`
        );
      }
      effectiveThinkingBudget = parsed;
    }
    let effectiveReasoningEffort = options.reasoningEffort;
    if (suffixSettings['reasoning-effort'] !== undefined) {
      effectiveReasoningEffort = /** @type {'low' | 'medium' | 'high' | 'xhigh' | 'max'} */ (
        suffixSettings['reasoning-effort']
      );
    }

    // Settings are provider-specific where the wire form is: thinking-budget
    // is Anthropic's budget_tokens, so a mismatched pairing is a loud error.
    // reasoning-effort pairs with every provider — openai/openai-chat put it
    // on the wire today and provider anthropic sends it as output_config.effort
    // (harness/model-agent.js checks the per-model levels) — so there is deliberately
    // no provider refusal for it here.
    if (effectiveThinkingBudget !== undefined && provider !== 'anthropic') {
      throw new Error(
        `agent spec "${text}": thinking-budget only applies to provider "anthropic" (Anthropic extended thinking), got provider "${provider}"${provider === 'openai' || provider === 'openai-chat' ? ' — use reasoning-effort for reasoning models' : ''}`
      );
    }
    if (options.dryRun && effectiveThinkingBudget !== undefined) {
      throw new Error(
        `agent spec "${text}": thinking-budget is a model-agent setting and cannot be combined with --dry-run`
      );
    }
    if (options.dryRun && effectiveReasoningEffort !== undefined) {
      throw new Error(
        `agent spec "${text}": reasoning-effort is a model-agent setting and cannot be combined with --dry-run`
      );
    }
    if (
      provider === 'anthropic' &&
      effectiveThinkingBudget !== undefined &&
      effectiveReasoningEffort !== undefined
    ) {
      throw new Error(
        `agent spec "${text}": thinking-budget and reasoning-effort both steer Anthropic thinking; set one or the other (manual budget mode for pre-4.6 models, adaptive thinking with effort for 4.6 and later)`
      );
    }

    // Canonical settings suffix for the agent identity: the same model with
    // different settings is a different leaderboard entry. With settings set
    // in the spec text itself, the id is byte-identical to the spec; with
    // flag-set settings the suffix is appended here.
    const settingsSuffix =
      (effectiveThinkingBudget !== undefined
        ? `:thinking-budget=${effectiveThinkingBudget}`
        : '') +
      (effectiveReasoningEffort !== undefined
        ? `:reasoning-effort=${effectiveReasoningEffort}`
        : '');
    const agentId = `model:${provider}/${model}${settingsSuffix}`;

    // A live openai-chat agent has nowhere to call without a base URL; a
    // --dry-run rehearsal replays scripted replies and never dials a server,
    // so it is exempt.
    if (provider === 'openai-chat' && !options.baseUrl && !options.dryRun) {
      throw new Error(
        `agent spec "${text}": the openai-chat provider talks to any OpenAI-compatible chat-completions server, so it requires --base-url <url> (the request goes to <base-url>/v1/chat/completions, or the base URL as-is when it already ends in /chat/completions — e.g. Google's Gemini endpoint https://generativelanguage.googleapis.com/v1beta/openai/chat/completions)`
      );
    }
    if (options.dryRun && !options.script) {
      throw new Error(
        `--dry-run for "${text}" requires --script <file> with the replies to replay`
      );
    }
    if (options.script && !options.dryRun) {
      throw new Error(
        `--script <file> only applies with --dry-run; a live "${text}" run calls the provider`
      );
    }

    if (options.dryRun) {
      const script = await importScriptFile(/** @type {string} */ (options.script));
      // One scripted agent per episode, so reply-list scripts restart per
      // episode while every trajectory carries the same model identity.
      return {
        text,
        gameId: null,
        track: 'official',
        dryRun: true,
        createForEpisode() {
          return createScriptedAgent(script, { id: text });
        },
      };
    }

    /** @type {Record<string, *> | undefined} */
    const priceFile = options.prices
      ? JSON.parse(readFileSync(options.prices, 'utf8'))
      : undefined;
    if (
      options.dryRun &&
      (options.maxOutputTokens !== undefined || options.callTimeoutMs !== undefined)
    ) {
      throw new Error(
        `--max-output-tokens and --call-timeout-ms bound live provider calls and do not apply to a --dry-run "${text}" rehearsal`
      );
    }

    return {
      text,
      gameId: null,
      track: 'official',
      dryRun: false,
      createForEpisode() {
        // One FRESH model agent per episode. A model agent carries its
        // previous reply into the next request, so a shared instance would
        // leak one episode's conversation into the next episode's prompts —
        // and race under --concurrency. The price-file parse above stays
        // shared; only the per-episode state is rebuilt.
        return /** @type {Agent} */ (
          createModelAgent({
            provider: /** @type {'anthropic' | 'openai' | 'openai-chat'} */ (provider),
            model,
            ...(priceFile ? { prices: priceFile } : {}),
            ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
            ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
            ...(options.maxOutputTokens !== undefined
              ? { maxOutputTokens: options.maxOutputTokens }
              : {}),
            ...(effectiveThinkingBudget !== undefined
              ? { thinkingBudget: effectiveThinkingBudget }
              : {}),
            ...(effectiveReasoningEffort !== undefined
              ? {
                  // The CLI accepts the wider value set and the anthropic
                  // pairing; the harness validates per model. Its typedef
                  // narrows until the frontier-effort packet widens it,
                  // hence the cast — the value flows through untouched.
                  reasoningEffort: /** @type {'low' | 'medium' | 'high'} */ (effectiveReasoningEffort),
                }
              : {}),
            ...(options.callTimeoutMs !== undefined
              ? { callTimeoutMs: options.callTimeoutMs }
              : {}),
            id: agentId,
          })
        );
      },
    };
  }

  throw new Error(
    `unknown agent spec "${text}"; expected "random", "baseline:<game>:<greedy|engine>", "skill:<p>:<expert-spec>", "community-assisted:<provider>/<model>[:retries=N]", "human[:name]" or "model:<provider>/<model>"`
  );
}
