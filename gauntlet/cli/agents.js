/**
 * Agent spec parsing for the CLI. Three spec forms:
 *
 *   random                          — the bundled seeded random agent (baseline).
 *   baseline:<game>:<greedy|engine> — that game's bundled baseline, scoped to
 *                                     its own game's episodes in a suite run.
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
 * thinking) and --reasoning-effort <low|medium|high> (OpenAI reasoning,
 * including Gemini through its OpenAI-compatible endpoint) as flags, or
 * inline as a trailing `:key=value` list on the model part —
 * `model:anthropic/claude-opus-4-5:thinking-budget=10240`,
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
import { createScriptedAgent } from '../harness/dry-run.js';
import { createModelAgent } from '../harness/model-agent.js';
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
 * @property {'baseline' | 'official'} track
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
 * @property {'low' | 'medium' | 'high'} [reasoningEffort] --reasoning-effort:
 *   OpenAI reasoning effort for providers "openai" (reasoning.effort) and
 *   "openai-chat" (the chat-completions reasoning_effort field, which is how
 *   Google's Gemini OpenAI-compatible endpoint takes it); provider
 *   "anthropic" rejects it. Recorded in run.json's limits and in the agent
 *   id's settings suffix.
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
 * Per-game baseline factories: each game packet names its baselines
 * differently, and this is the single place those names map onto the CLI's
 * `greedy` and `engine` kinds. Games whose packet ships exactly one baseline
 * (sliding) resolve both kinds to it.
 *
 * @type {Record<string, (kind: 'greedy' | 'engine', context: AgentSpecContext) => Promise<Agent>>}
 */
const BASELINE_FACTORIES = {
  async chess(kind, { tier, seed, agentSeat }) {
    const { createGreedyBaselineAgent, createEngineBaselineAgent } = await import('../games/chess/baselines.js');
    return kind === 'greedy'
      ? createGreedyBaselineAgent()
      : createEngineBaselineAgent({ tier, seed, seat: agentSeat });
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
  async mastermind(kind, { seed }) {
    const { createGreedyAgent, createEngineAgent } = await import('../games/mastermind/baselines.js');
    return kind === 'greedy'
      ? createGreedyAgent({ episodeSeed: seed })
      : createEngineAgent({ episodeSeed: seed });
  },
  async holdem(kind, { seed, agentSeat }) {
    const { makeBaseline } = await import('../games/holdem/baselines.js');
    return makeBaseline(kind, seed, agentSeat);
  },
};

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
    const factory = BASELINE_FACTORIES[gameId];
    if (!factory) {
      throw new Error(
        `game "${gameId}" ships no baseline agents; games with baselines: ${Object.keys(BASELINE_FACTORIES).join(', ')}`
      );
    }
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
        return factory(kind, context);
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
      const m = /(,|:)(thinking-budget=(\d+)|reasoning-effort=(low|medium|high))$/.exec(model);
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
      effectiveReasoningEffort = /** @type {'low' | 'medium' | 'high'} */ (
        suffixSettings['reasoning-effort']
      );
    }

    // Settings are provider-specific; a mismatched pairing is a loud error,
    // not a silent no-op.
    if (effectiveThinkingBudget !== undefined && provider !== 'anthropic') {
      throw new Error(
        `agent spec "${text}": thinking-budget only applies to provider "anthropic" (Anthropic extended thinking), got provider "${provider}"${provider === 'openai' || provider === 'openai-chat' ? ' — use reasoning-effort for OpenAI reasoning' : ''}`
      );
    }
    if (effectiveReasoningEffort !== undefined && provider === 'anthropic') {
      throw new Error(
        `agent spec "${text}": reasoning-effort does not apply to provider "anthropic" — use thinking-budget for Anthropic extended thinking`
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

    if (provider === 'openai-chat' && !options.baseUrl) {
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
              ? { reasoningEffort: effectiveReasoningEffort }
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
    `unknown agent spec "${text}"; expected "random", "baseline:<game>:<greedy|engine>" or "model:<provider>/<model>"`
  );
}
