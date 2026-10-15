/**
 * Bridge between PlayKit Gauntlet and the playkit.ai overlay: any Gauntlet
 * agent drives a live 2048 page through the overlay's real adapter and
 * driver, while Gauntlet's 2048 rules referee every transition.
 *
 * @module
 */

export { referee } from './referee.js';
export { toSolverEngine } from './solver-engine.js';
export { createBridgeLog, endBridgeLog, recordStep, verifyBridgeLog } from './session-log.js';
export { playBridgeSession } from './session.js';
export { loadOverlayModules } from './overlay-loader.js';

export {};
