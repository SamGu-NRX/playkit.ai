/**
 * @fileoverview Shared configuration values for the HUD layer
 */

import { Direction } from "../adapters/index.js";

/**
 * Default move priority order when no user preference is set.
 * @type {number[]}
 */
export const DEFAULT_DIRECTION_PRIORITY = [
  Direction.LEFT,
  Direction.DOWN,
  Direction.RIGHT,
  Direction.UP,
];

/**
 * Default solver configuration that mirrors the runtime defaults.
 * @type {{type: string, heuristic: string, depth: number, probability: number}}
 */
export const DEFAULT_SOLVER_CONFIG = {
  type: "expectimax-depth",
  heuristic: "corner",
  depth: 4,
  probability: 0.0025,
};

/**
 * Limits enforced for solver tuning inputs.
 */
export const SOLVER_LIMITS = {
  MIN_DEPTH: 1,
  MAX_DEPTH: 8,
  MIN_PROBABILITY: 0.0001,
  MAX_PROBABILITY: 0.2,
};

/**
 * Clamp solver settings to safe bounds while preserving precision.
 * @param {{depth:number, probability:number}} config Partial solver config
 * @returns {{depth:number, probability:number}} Normalised values
 */
export function clampSolverConfig({ depth, probability }) {
  const safeDepth = Math.max(
    SOLVER_LIMITS.MIN_DEPTH,
    Math.min(SOLVER_LIMITS.MAX_DEPTH, depth || SOLVER_LIMITS.MIN_DEPTH),
  );

  const safeProbability = Math.max(
    SOLVER_LIMITS.MIN_PROBABILITY,
    Math.min(SOLVER_LIMITS.MAX_PROBABILITY, probability || SOLVER_LIMITS.MIN_PROBABILITY),
  );

  return {
    depth: safeDepth,
    probability: safeProbability,
  };
}
