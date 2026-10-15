#!/usr/bin/env node
/**
 * The Gauntlet wire protocol: a language-neutral, JSON Lines server over
 * stdin and stdout. One episode per reset; every episode is driven by the
 * core runner (`runEpisode`) through a "remote agent" whose `act()` forwards
 * the turn to the protocol client and awaits the reply — so action budgets,
 * invalid-attempt handling, seeded opponents, and trajectory recording all
 * come from the core and never from a second implementation.
 *
 * Requests (one JSON object per stdin line):
 *   {"id", "op": "list"}
 *   {"id", "op": "reset", "game", "tier", "seed", "split", "agentId", "track"}
 *   {"id", "op": "act", "text"}
 *   {"id", "op": "trajectory"}
 *   {"id", "op": "close"}
 *
 * Responses (one JSON object per stdout line, echoing "id"):
 *   {"id", "ok": true, "games": [...]}
 *   {"id", "ok": true, "turn": {"seat", "observation", "legalActions", "feedback"}}
 *   {"id", "ok": true, "done": true, "end": {...}}
 *   {"id", "ok": true, "trajectory": {...}}
 *   {"id", "ok": false, "error": "..."}
 *
 * After reset and after every act, the response carries either the next
 * agent turn (`legalActions` is null on the official track) or the finished
 * episode's `end`. Errors — unknown game, act before reset, malformed JSON —
 * are responses, never crashes. Logs go to stderr only.
 *
 * Run with: node gauntlet/protocol/server.js
 * See protocol/README.md for the full wire contract.
 *
 * @module
 */

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { getGame, listGames } from '../games/index.js';
import { runEpisode } from '../core/runner.js';
import { publicSeed } from '../core/seeds.js';

/** @import { Agent, AgentReply, Game, Trajectory, TierSpec, TurnContext, Usage } from '../core/types.js' */

const TRACKS = new Set(['baseline', 'official', 'community']);
const SPLITS = new Set(['public', 'eval']);

/**
 * Log a line to stderr. stdout carries protocol traffic only.
 *
 * @param {string} message
 */
export function log(message) {
  process.stderr.write(`[gauntlet-protocol] ${message}\n`);
}

/**
 * @param {*} err
 * @returns {string}
 */
function message(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A single-episode protocol session. Request handling is strictly sequential:
 * every request gets exactly one response, and episode turns are produced by
 * the runner's calls into the remote agent.
 */
export class Session {
  constructor() {
    /** @type {{ resolve: (response: Record<string, *>) => void } | null} */
    this.responseWaiter = null;
    /** @type {Record<string, *> | null} */
    this.stashedResponse = null;
    /** @type {'idle' | 'playing' | 'done'} */
    this.state = 'idle';
    /** @type {(reply: AgentReply) => void} */
    this.replyResolver = () => {};
    /** @type {Trajectory | null} */
    this.trajectory = null;
    /** @type {string | null} */
    this.failure = null;
  }

  /**
   * The next response produced by the episode machinery. Safe to call before
   * or after the response is emitted; ordering is handled here.
   *
   * @returns {Promise<Record<string, *>>}
   */
  nextResponse() {
    if (this.stashedResponse !== null) {
      const stashed = this.stashedResponse;
      this.stashedResponse = null;
      return Promise.resolve(stashed);
    }
    return new Promise((resolve) => {
      this.responseWaiter = { resolve };
    });
  }

  /**
   * Emit a response for whichever request is currently awaiting one.
   *
   * @param {Record<string, *>} response
   * @returns {void}
   */
  emitResponse(response) {
    if (this.responseWaiter !== null) {
      const waiter = this.responseWaiter;
      this.responseWaiter = null;
      waiter.resolve(response);
    } else {
      // Only reachable for failure responses after a turn was already sent;
      // the stash is consumed by the client's next request on this session.
      this.stashedResponse = response;
    }
  }

  /**
   * Handle one parsed request and resolve to its response payload (without
   * the echoed "id"; the transport adds that).
   *
   * @param {*} request
   * @returns {Promise<Record<string, *>>}
   */
  async handle(request) {
    if (
      request === null ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      typeof request.op !== 'string'
    ) {
      return {
        ok: false,
        error: 'each request must be a JSON object with an "op" field',
      };
    }
    switch (request.op) {
      case 'list':
        return this.list();
      case 'reset':
        return this.reset(request);
      case 'act':
        return this.act(request);
      case 'trajectory':
        return this.trajectoryResponse();
      case 'close':
        return { ok: true };
      default:
        return {
          ok: false,
          error: `unknown op ${JSON.stringify(request.op)}; expected one of "list", "reset", "act", "trajectory", "close"`,
        };
    }
  }

  /**
   * @returns {Record<string, *>}
   */
  list() {
    const games = listGames().map((game) => ({
      id: game.spec.id,
      title: game.spec.title,
      version: game.spec.version,
      seats: game.spec.seats,
      information: game.spec.information,
      stochastic: game.spec.stochastic,
      benchmark: game.spec.benchmark,
      tiers: game.spec.tiers.map((tier) => ({
        id: tier.id,
        rank: tier.rank,
        scoring: tier.scoring,
        maxActions: tier.maxActions,
        publicSeeds: tier.publicSeeds,
      })),
    }));
    return { ok: true, games };
  }

  /**
   * @param {Record<string, *>} request
   * @returns {Promise<Record<string, *>>}
   */
  async reset(request) {
    if (this.state === 'playing') {
      return {
        ok: false,
        error:
          'an episode is already in progress; finish it before resetting (one episode per reset)',
      };
    }
    const gameId = request.game;
    if (typeof gameId !== 'string' || gameId.length === 0) {
      return { ok: false, error: 'reset requires a "game" string (see op "list")' };
    }
    /** @type {Game<*>} */
    let game;
    try {
      game = getGame(gameId);
    } catch (err) {
      return { ok: false, error: message(err) };
    }
    const tierId =
      typeof request.tier === 'string' && request.tier.length > 0
        ? request.tier
        : game.spec.tiers[0].id;
    const tier = /** @type {TierSpec | undefined} */ (
      game.spec.tiers.find((t) => t.id === tierId)
    );
    if (!tier) {
      return {
        ok: false,
        error: `game "${gameId}" has no tier ${JSON.stringify(tierId)} (tiers: ${game.spec.tiers
          .map((t) => t.id)
          .join(', ')})`,
      };
    }
    const seed =
      typeof request.seed === 'string' && request.seed.length > 0
        ? request.seed
        : publicSeed(gameId, tierId, 0);
    const split = request.split === undefined ? 'public' : request.split;
    if (typeof split !== 'string' || !SPLITS.has(split)) {
      return { ok: false, error: `split must be "public" or "eval", got ${JSON.stringify(split)}` };
    }
    const track = request.track === undefined ? 'official' : request.track;
    if (typeof track !== 'string' || !TRACKS.has(track)) {
      return {
        ok: false,
        error: `track must be one of "baseline", "official", "community", got ${JSON.stringify(track)}`,
      };
    }
    const agentId =
      typeof request.agentId === 'string' && request.agentId.length > 0
        ? request.agentId
        : 'remote-agent';

    this.startEpisode(game, tierId, seed, split, agentId, track);
    return this.nextResponse();
  }

  /**
   * Start runEpisode with the remote agent and wire its completions to the
   * pending response. The runner calls `agent.act` once per agent decision;
   * each call sends the turn to the client and awaits the client's reply.
   *
   * @param {Game<*>} game
   * @param {string} tierId
   * @param {string} seed
   * @param {string} split
   * @param {string} agentId
   * @param {string} track
   * @returns {void}
   */
  startEpisode(game, tierId, seed, split, agentId, track) {
    this.state = 'playing';
    this.trajectory = null;
    this.failure = null;
    /** @type {import('./server.js').Session} */
    const session = this;
    /** @type {Agent} */
    const agent = {
      id: agentId,
      track: /** @type {'baseline' | 'official' | 'community'} */ (track),
      async act(/** @type {TurnContext} */ ctx) {
        session.emitResponse({
          ok: true,
          turn: {
            seat: ctx.seat,
            observation: ctx.observation,
            legalActions: ctx.legalActions,
            feedback: ctx.feedback,
          },
        });
        // The runner awaits this promise; the client's next `act` request
        // resolves it through the session's reply resolver, which is swapped
        // in here once per agent turn.
        return new Promise((resolve) => {
          session.replyResolver = resolve;
        });
      },
    };
    void runEpisode({ game, tierId, seed, split, agent })
      .then((trajectory) => {
        session.trajectory = trajectory;
        session.state = 'done';
        log(
          `episode finished: ${trajectory.game.id}/${trajectory.tier} seed "${seed}" -> ` +
            `${trajectory.end.reason} (${trajectory.end.agentActions} agent actions, ` +
            `${trajectory.end.invalidActions} invalid)`
        );
        session.emitResponse({ ok: true, done: true, end: trajectory.end });
      })
      .catch((err) => {
        session.state = 'done';
        session.failure = message(err);
        log(`episode failed: ${message(err)}`);
        session.emitResponse({ ok: false, error: `the episode failed: ${message(err)}` });
      });
  }

  /**
   * @param {Record<string, *>} request
   * @returns {Promise<Record<string, *>>}
   */
  async act(request) {
    if (this.state === 'idle') {
      return { ok: false, error: 'no episode is active; send a reset first' };
    }
    if (this.state === 'done') {
      if (this.failure !== null) {
        const failure = this.failure;
        this.failure = null;
        return { ok: false, error: `the previous episode failed: ${failure}` };
      }
      return { ok: false, error: 'the episode is over; reset to start a new one' };
    }
    const text = request.text;
    if (typeof text !== 'string') {
      return { ok: false, error: 'act requires a "text" string with the agent reply' };
    }
    /** @type {AgentReply} */
    const reply = { text };
    if (request.usage !== undefined) {
      if (request.usage === null || typeof request.usage !== 'object') {
        return { ok: false, error: 'usage, when present, must be an object' };
      }
      reply.usage = /** @type {Usage} */ (request.usage);
    }
    if (request.meta !== undefined) {
      reply.meta = request.meta;
    }
    this.replyResolver(reply);
    return this.nextResponse();
  }

  /**
   * @returns {Record<string, *>}
   */
  trajectoryResponse() {
    if (this.state === 'idle') {
      return { ok: false, error: 'no episode has been played; send a reset first' };
    }
    if (this.state === 'playing') {
      return { ok: false, error: 'the episode is still in progress; the trajectory is available once it is done' };
    }
    if (this.failure !== null) {
      return { ok: false, error: `the previous episode failed: ${this.failure}` };
    }
    return { ok: true, trajectory: this.trajectory };
  }
}

/**
 * Write one JSON line, waiting until the stream accepts it.
 *
 * @param {import('node:stream').Writable} output
 * @param {Record<string, *>} value
 * @returns {Promise<void>}
 */
async function writeLine(output, value) {
  const line = JSON.stringify(value);
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => {
      output.write(`${line}\n`, () => resolve());
    })
  );
}

/**
 * Serve the protocol on the given streams until stdin ends or a close op
 * arrives.
 *
 * @param {{ input?: import('node:stream').Readable, output?: import('node:stream').Writable }} [streams]
 * @returns {Promise<void>}
 */
export async function serve(streams = {}) {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const session = new Session();
  const reader = createInterface({ input, crlfDelay: Infinity });
  /** @type {*} */
  let outputError = null;
  output.on('error', (err) => {
    outputError = err; // e.g. EPIPE when the client dies mid-episode
  });
  for await (const line of reader) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    /** @type {*} */
    let request = null;
    let id = null;
    try {
      request = JSON.parse(trimmed);
      if (request !== null && typeof request === 'object' && !Array.isArray(request)) {
        if ('id' in request) id = request.id;
      }
    } catch (err) {
      await writeLine(output, {
        id: null,
        ok: false,
        error: `each request line must be one JSON object: ${message(err)}`,
      });
      continue;
    }
    const response = await session.handle(request);
    await writeLine(output, { id, ...response });
    if (
      request !== null &&
      typeof request === 'object' &&
      !Array.isArray(request) &&
      request.op === 'close'
    ) {
      log('close received; exiting');
      break;
    }
    if (outputError !== null) {
      log(`output stream failed (${message(outputError)}); exiting`);
      break;
    }
  }
  if (session.state === 'playing') {
    log('stdin closed with an episode still in progress; the episode is abandoned');
  }
}

// Run the server only when executed directly, so importing the module is safe.
const invokedDirectly =
  process.argv.length > 1 && process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  log(`serving on stdin/stdout (pid ${process.pid})`);
  void serve();
}
