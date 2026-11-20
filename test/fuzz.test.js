'use strict';
/**
 * Robustness fuzz for shared/sim.js: random / garbage inputs from both teams in
 * every phase. The sim must never throw, never emit non-finite numbers, never
 * stall in a phase, and one team's inputs must never touch the other team.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../shared/sim.js');

const DT = 1 / 30;
// longest a phase may last (s): playcall 15, presnap 1, live 12 (+ a play's end), kick 4, result 2.5
const PHASE_CAP = { playcall: 16, presnap: 1.5, live: 13, kick: 5, result: 3 };

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JUNK = [NaN, Infinity, -Infinity, 1e308, -1e308, 0, -0, -5, 60, 26.65, 1e-300, '5', '', 'x',
  null, undefined, {}, [], [1, 2], true, false, '__proto__', 'constructor', 'toString', 'hasOwnProperty',
  'QB', 'RB', 'S1', 'DL1', 'CB2', 'WR1', 'slant', 'deep', 'run', 'screen', 'punt', 'fg', 'man', 'zone', 'blitz',
  { valueOf() { return 5; } }];
const TYPES = ['pick', 'move', 'stop', 'throw', 'juke', 'select', 'kick', 'pick', 'move', 'throw',
  '__proto__', 'constructor', 'toString', '', 'PICK', 5, null, undefined, {}];

function walkFinite(v, path) {
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('non-finite ' + path + ' = ' + v); return; }
  if (v === undefined) throw new Error('undefined at ' + path);
  if (v && typeof v === 'object') for (const k of Object.keys(v)) walkFinite(v[k], path + '.' + k);
}

const sideState = (g, side) => JSON.stringify(g.players.filter((p) => p.side === side)
  .map((p) => [p.id, p.hasTarget, p.tx, p.ty, p.jukeT]));

test('fuzz: garbage inputs in every phase never break the sim', () => {
  const seen = {};
  for (let seed = 1; seed <= 80; seed++) {
    const R = rng(seed);
    const pick = (a) => a[Math.floor(R() * a.length)];
    const humans = [R() < 0.85, R() < 0.85];
    const g = S.createGame({ humans, seed, quarterLength: 15 + R() * 30 });
    let phase = g.phase, since = 0, steps = 0;
    while (g.phase !== 'gameover') {
      const n = R() < 0.35 ? 1 + Math.floor(R() * 4) : 0;
      for (let i = 0; i < n; i++) {
        let msg;
        const r = R();
        if (r < 0.04) msg = pick(JUNK);
        else {
          msg = { t: pick(TYPES), x: pick(JUNK), y: pick(JUNK), play: pick(JUNK), id: pick(JUNK) };
          if (R() < 0.6) { msg.x = R() * 160 - 20; msg.y = R() * 90 - 20; }
        }
        const team = R() < 0.92 ? (R() < 0.5 ? 0 : 1) : pick(JUNK);
        const off = g.possession, def = 1 - off;
        const before = { offSide: sideState(g, 'off'), defSide: sideState(g, 'def'), ball: JSON.stringify(g.ball),
          picks: g.picks.slice(), udef: g.userDefenderId, phase: g.phase };
        assert.doesNotThrow(() => S.input(g, team, msg), 'input threw: ' + JSON.stringify(msg));
        if (team === def) {
          // defense can only steer its own defender / pick its own coverage
          assert.equal(sideState(g, 'off'), before.offSide, 'defense input moved offense: ' + JSON.stringify(msg));
          assert.equal(JSON.stringify(g.ball), before.ball, 'defense input touched the ball');
          assert.equal(g.picks[off], before.picks[off]);
          assert.equal(g.phase, before.phase);
        } else if (team === off && g.phase === before.phase) {
          assert.equal(sideState(g, 'def'), before.defSide, 'offense input moved defense: ' + JSON.stringify(msg));
          assert.equal(g.userDefenderId, before.udef, 'offense switched the user defender');
          assert.equal(g.picks[def], before.picks[def]);
        } else if (team !== 0 && team !== 1) {
          assert.equal(sideState(g, 'off') + sideState(g, 'def'), before.offSide + before.defSide, 'bad team id had an effect');
        }
      }
      S.step(g, R() < 0.01 ? pick(JUNK) : DT);
      steps++;
      since += DT;
      if (g.phase !== phase) {
        seen[phase] = true;
        phase = g.phase; since = 0;
      }
      assert.ok(since <= (PHASE_CAP[phase] || 1e9), `stuck in ${phase} for ${since.toFixed(1)}s (seed ${seed})`);
      if (steps % 4 === 0) {
        const s = S.snapshot(g);
        walkFinite(s, 'snap');
        assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
        assert.ok(s.down >= 1 && s.down <= 4 && s.toGo >= 1 && s.ballOn >= 0 && s.ballOn <= 100);
      }
      assert.ok(steps < 200000, 'game never ended (seed ' + seed + ')');
    }
    seen.gameover = true;
    // inputs after gameover are ignored, snapshot still valid
    S.input(g, 0, { t: 'pick', play: 'slant' });
    walkFinite(S.snapshot(g), 'final');
  }
  for (const p of ['playcall', 'presnap', 'live', 'kick', 'result', 'gameover']) assert.ok(seen[p], 'fuzz never reached ' + p);
});

test('fuzz: hostile game/options objects do not throw', () => {
  const bad = [undefined, null, {}, { humans: 'yes', teamNames: 5, quarterLength: NaN, seed: 'abc' },
    { quarterLength: -1, seed: Infinity }, { teamNames: [null, { toString() { return 'X'; } }] }];
  for (const o of bad) {
    const g = S.createGame(o);
    for (let i = 0; i < 200; i++) S.step(g, DT);
    walkFinite(S.snapshot(g), 'snap');
  }
  assert.doesNotThrow(() => S.input(null, 0, { t: 'move', x: 1, y: 1 }));
  assert.doesNotThrow(() => S.input({}, 0, null));
  assert.doesNotThrow(() => S.step(null, DT));
  assert.doesNotThrow(() => S.reset(null));
});
