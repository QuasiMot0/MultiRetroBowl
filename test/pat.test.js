'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Sim = require('../shared/sim.js');

const DT = 1 / 30;

function advance(g, done) {
  for (let i = 0; i < 275 && !done(); i++) Sim.step(g, DT);
  assert.ok(done(), `stalled in ${g.phase} at ${g.phaseTime}`);
}

function touchdown({ quarter = 1, zeroClock = false, cpu = false } = {}) {
  const g = Sim.createGame({ humans: [!cpu, true], seed: 80 });
  g.quarter = quarter;
  g.ballOn = 96;
  if (cpu) g.picks[0] = 'slant';
  else Sim.input(g, 0, { t: 'pick', play: 'slant' });
  Sim.input(g, 1, { t: 'pick', play: 'zone' });
  advance(g, () => g.phase === 'live');
  g.players.find((p) => p.id === 'QB').x = 111;
  if (zeroClock) g.clock = DT / 2;
  Sim.step(g, DT);
  assert.equal(g.phase, 'result');
  assert.equal(g.message, 'TOUCHDOWN!');
  assert.deepEqual(g.score, [6, 0]);
  return g;
}

test('missing the kick leaves six points and the opponent receives at the 25', () => {
  const g = touchdown();
  advance(g, () => g.phase === 'kick');
  const s = Sim.snapshot(g);
  assert.equal(s.kickKind, 'pat');
  assert.equal(s.possession, 0);
  const clock = s.clock;

  advance(g, () => g.kickMeter > 0.95);
  Sim.input(g, 0, { t: 'kick' });
  assert.equal(g.phase, 'result');
  assert.equal(g.message, 'EXTRA POINT NO GOOD');
  assert.deepEqual(Sim.snapshot(g).events, ['pat_miss']);
  assert.deepEqual(g.score, [6, 0]);
  assert.equal(Sim.snapshot(g).clock, clock);
  advance(g, () => g.phase === 'playcall');
  assert.equal(g.possession, 1);
  assert.equal(g.ballOn, 25);
});

test('a touchdown at zero lets the PAT expire before the game ends', () => {
  const g = touchdown({ quarter: 4, zeroClock: true });
  assert.equal(g.clock, 0);
  advance(g, () => g.phase === 'kick');
  assert.equal(g.quarter, 4);
  advance(g, () => g.phase === 'result');
  assert.equal(g.sub, 'Time expired');
  assert.ok(g.events.includes('pat_miss'));
  assert.deepEqual(g.score, [6, 0]);
  advance(g, () => g.phase === 'gameover');
  assert.ok(g.events.includes('gameover'));
});

test('CPU automatically attempts the extra point before halftime', () => {
  const g = touchdown({ quarter: 2, zeroClock: true, cpu: true });
  advance(g, () => g.phase === 'kick');
  assert.equal(g.quarter, 2);
  advance(g, () => g.phase === 'result');
  assert.ok(g.kickT < Sim.KICK_TIME);
  assert.ok(g.events.includes('pat_good') || g.events.includes('pat_miss'));
  advance(g, () => g.phase === 'playcall');
  assert.equal(g.quarter, 3);
  assert.equal(g.message, 'HALFTIME');
  assert.equal(g.possession, 1);
  assert.equal(g.ballOn, 25);
});
