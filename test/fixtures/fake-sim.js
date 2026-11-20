'use strict';
// Minimal stand-in for shared/sim.js with the same API, used by server tests.
// Records inputs so tests can verify forwarding (visible via snapshot().inputs).

const OFFENSE_PLAYS = [{ id: 'slant', name: 'Slant', desc: '' }, { id: 'run', name: 'Run', desc: '' }];
const DEFENSE_PLAYS = [{ id: 'zone', name: 'Zone', desc: '' }];

function createGame(opts) {
  opts = opts || {};
  return {
    opts,
    teamNames: (opts.teamNames || ['HOME', 'AWAY']).slice(),
    phase: 'playcall',
    phaseTime: 15,
    paused: false,
    time: 0,
    steps: 0,
    inputs: [],
    events: [],
    resets: 0,
  };
}

function step(game, dt) {
  if (game.paused) return;
  game.steps++;
  game.time += dt;
}

function input(game, team, msg) {
  if (!msg || typeof msg.t !== 'string') return;
  game.inputs.push({ team, t: msg.t, play: msg.play });
  // test hook: jump to game over so rematch can be exercised
  if (msg.t === 'debug_gameover') game.phase = 'gameover';
}

function snapshot(game) {
  const ev = game.events;
  game.events = [];
  return {
    phase: game.phase,
    phaseTime: game.phaseTime,
    paused: !!game.paused,
    teamNames: game.teamNames,
    time: game.time,
    steps: game.steps,
    inputs: game.inputs.slice(-10),
    resets: game.resets,
    events: ev,
  };
}

function reset(game) {
  const r = game.resets + 1;
  Object.assign(game, createGame(game.opts));
  game.resets = r;
}

module.exports = { createGame, step, input, snapshot, reset, OFFENSE_PLAYS, DEFENSE_PLAYS };
