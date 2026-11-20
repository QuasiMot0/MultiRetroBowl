'use strict';
const test = require('node:test');
const assert = require('node:assert');
const GridSim = require('../shared/sim.js');

const DT = 1 / 30;
const PHASES = ['playcall', 'presnap', 'live', 'kick', 'result', 'gameover'];
const STEP_CAP = 200000;

function assertFiniteDeep(v, path) {
  if (typeof v === 'number') {
    assert.ok(Number.isFinite(v), `non-finite number at ${path}: ${v}`);
  } else if (v === undefined) {
    assert.fail(`undefined value at ${path}`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => assertFiniteDeep(x, `${path}[${i}]`));
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) assertFiniteDeep(v[k], `${path}.${k}`);
  }
}

function checkSnapshot(s) {
  assert.ok(PHASES.includes(s.phase), `bad phase ${s.phase}`);
  assertFiniteDeep(s, 'snap');
  // JSON round trip must be lossless (no NaN/undefined/cycles)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), s);
  assert.ok(s.quarter >= 1 && s.quarter <= 4);
  assert.ok(s.down >= 1 && s.down <= 4, `bad down ${s.down}`);
  assert.ok(s.possession === 0 || s.possession === 1);
  assert.ok(s.ballOn >= 0 && s.ballOn <= 100, `bad ballOn ${s.ballOn}`);
  assert.ok(s.toGo >= 1 && s.toGo <= 100, `bad toGo ${s.toGo}`);
  assert.strictEqual(s.players.length, 14);
  for (const p of s.players) {
    if (!p.carrier) {
      assert.ok(p.x >= 0 && p.x <= 120, `player ${p.id} x out of field: ${p.x}`);
      assert.ok(p.y >= -1.01 && p.y <= 54.31, `player ${p.id} y out of field: ${p.y}`);
    }
  }
  assert.ok(['held', 'air', 'dead'].includes(s.ball.state));
  assert.ok(Array.isArray(s.events));
  assert.strictEqual(typeof s.message, 'string');
  assert.strictEqual(typeof s.sub, 'string');
  if (s.phase === 'playcall') {
    assert.strictEqual(s.offPlay, null);
    assert.strictEqual(s.defPlay, null);
  }
}

function runCpuGame(seed, opts) {
  const g = GridSim.createGame(Object.assign({ humans: [false, false], seed }, opts || {}));
  const events = {};
  const quarters = [];
  let steps = 0;
  let snap = GridSim.snapshot(g);
  checkSnapshot(snap);
  while (g.phase !== 'gameover' && steps < STEP_CAP) {
    GridSim.step(g, DT);
    steps++;
    snap = GridSim.snapshot(g);
    checkSnapshot(snap);
    if (quarters[quarters.length - 1] !== snap.quarter) quarters.push(snap.quarter);
    for (const e of snap.events) events[e] = (events[e] || 0) + 1;
  }
  return { g, snap, events, quarters, steps };
}

// advance until predicate true (or cap); returns snapshot
function stepUntil(g, pred, cap = 20000) {
  for (let i = 0; i < cap; i++) {
    if (pred(g)) return true;
    GridSim.step(g, DT);
  }
  return pred(g);
}

const P = (g, id) => g.players.find((p) => p.id === id);

test('exports the documented API', () => {
  for (const fn of ['createGame', 'step', 'input', 'snapshot', 'reset']) {
    assert.strictEqual(typeof GridSim[fn], 'function', fn);
  }
  const offIds = GridSim.OFFENSE_PLAYS.map((p) => p.id);
  assert.deepStrictEqual(offIds, ['slant', 'deep', 'screen', 'run', 'punt', 'fg']);
  assert.deepStrictEqual(GridSim.DEFENSE_PLAYS.map((p) => p.id), ['man', 'zone', 'blitz']);
  for (const p of GridSim.OFFENSE_PLAYS.concat(GridSim.DEFENSE_PLAYS)) {
    assert.strictEqual(typeof p.name, 'string');
    assert.strictEqual(typeof p.desc, 'string');
  }
  const g = GridSim.createGame({ humans: [true, true], seed: 1 });
  const s = GridSim.snapshot(g);
  assert.strictEqual(s.phase, 'playcall');
  assert.strictEqual(s.quarter, 1);
  assert.strictEqual(s.clock, 150);
  assert.deepStrictEqual(s.score, [0, 0]);
  assert.deepStrictEqual(s.teamNames, ['HOME', 'AWAY']);
  assert.strictEqual(s.possession, 0);
  assert.strictEqual(s.ballOn, 25);
  assert.strictEqual(s.down, 1);
  assert.strictEqual(s.toGo, 10);
  assert.strictEqual(s.userDefenderId, 'S1');
  assert.strictEqual(s.fourthDown, false);
  assert.strictEqual(s.kickMeter, null);
  checkSnapshot(s);
});

test('CPU vs CPU full games reach gameover across seeds', () => {
  const totals = {};
  for (const seed of [11, 222, 3333, 44444, 555555]) {
    const { snap, events, quarters, steps } = runCpuGame(seed);
    assert.strictEqual(snap.phase, 'gameover', `seed ${seed} did not finish in ${steps} steps`);
    assert.deepStrictEqual(quarters, [1, 2, 3, 4], `seed ${seed} quarters ${quarters}`);
    for (const sc of snap.score) {
      assert.ok(Number.isInteger(sc) && sc >= 0, `bad score ${sc}`);
    }
    assert.strictEqual(events.gameover, 1);
    assert.ok(events.snap > 10, 'should have run plenty of plays');
    for (const k in events) totals[k] = (totals[k] || 0) + events[k];
  }
  assert.ok(totals.td >= 1, 'expected at least one touchdown');
  assert.ok(totals.catch >= 1, 'expected at least one completion');
  assert.ok(totals.tackle >= 1, 'expected at least one tackle');
});

test('short quarters still finish and scoring matches events', () => {
  const { snap, events } = runCpuGame(98765, { quarterLength: 40 });
  assert.strictEqual(snap.phase, 'gameover');
  const pts = snap.score[0] + snap.score[1];
  // TD = 7, FG = 3, safety = 2 (safety has no dedicated event, so allow remainder)
  const known = (events.td || 0) * 7 + (events.fg_good || 0) * 3;
  assert.ok(pts >= known && (pts - known) % 2 === 0, `points ${pts} vs events ${JSON.stringify(events)}`);
});

test('picks from the wrong team / invalid picks are ignored', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 5 });
  // team 1 is defense: offense play is invalid for them
  GridSim.input(g, 1, { t: 'pick', play: 'slant' });
  assert.strictEqual(g.picks[1], null);
  // team 0 is offense: defense play invalid
  GridSim.input(g, 0, { t: 'pick', play: 'zone' });
  assert.strictEqual(g.picks[0], null);
  // punt/fg only on 4th down
  GridSim.input(g, 0, { t: 'pick', play: 'punt' });
  GridSim.input(g, 0, { t: 'pick', play: 'fg' });
  assert.strictEqual(g.picks[0], null);
  // garbage
  GridSim.input(g, 0, null);
  GridSim.input(g, 2, { t: 'pick', play: 'slant' });
  GridSim.input(g, 0, { t: 'pick', play: 'nope' });
  GridSim.input(g, 0, { t: 'throw', x: 50, y: 20 });
  assert.strictEqual(g.picks[0], null);
  assert.strictEqual(g.phase, 'playcall');
  // valid
  GridSim.input(g, 0, { t: 'pick', play: 'deep' });
  assert.strictEqual(GridSim.snapshot(g).picked[0], true);
  assert.strictEqual(GridSim.snapshot(g).offPlay, null, 'plays hidden during playcall');
  GridSim.input(g, 1, { t: 'pick', play: 'man' });
  GridSim.step(g, DT);
  const s = GridSim.snapshot(g);
  assert.strictEqual(s.phase, 'presnap');
  assert.strictEqual(s.offPlay, 'deep');
  assert.strictEqual(s.defPlay, 'man');
});

test('playcall timeout auto-fills slant / zone', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 6 });
  stepUntil(g, (x) => x.phase !== 'playcall', 1000);
  assert.strictEqual(g.phase, 'presnap');
  assert.strictEqual(g.offPlay, 'slant');
  assert.strictEqual(g.defPlay, 'zone');
});

test('human move moves the QB; throw ignored past LOS rules for defense', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 7 });
  GridSim.input(g, 0, { t: 'pick', play: 'deep' });
  GridSim.input(g, 1, { t: 'pick', play: 'zone' });
  stepUntil(g, (x) => x.phase === 'live');
  const snapEvents = GridSim.snapshot(g).events;
  assert.ok(snapEvents.includes('snap'));
  const qb = P(g, 'QB');
  const x0 = qb.x, y0 = qb.y;
  assert.strictEqual(GridSim.snapshot(g).controlledOffId, 'QB');
  // move ignored from defense team for QB
  GridSim.input(g, 1, { t: 'throw', x: x0 + 20, y: y0 });
  assert.strictEqual(g.ball.state, 'held');
  GridSim.input(g, 0, { t: 'move', x: x0 - 3, y: y0 + 3 });
  for (let i = 0; i < 11; i++) GridSim.step(g, DT);
  assert.ok(qb.x < x0 - 0.8, `QB should move back (x ${x0} -> ${qb.x})`);
  assert.ok(qb.y > y0 + 0.8, `QB should move sideways (y ${y0} -> ${qb.y})`);
  // The QB accelerates up to his running speed.
  const sp = Math.hypot(qb.vx, qb.vy);
  assert.ok(sp > 5.0, `QB should be near top speed, got ${sp}`);
  // stop -> QB holds still
  GridSim.input(g, 0, { t: 'stop' });
  for (let i = 0; i < 10; i++) GridSim.step(g, DT);
  assert.ok(Math.hypot(qb.vx, qb.vy) < 0.5, 'QB should stop after stop');
});

test('human offense throw to an open receiver can complete', () => {
  let completions = 0;
  let attempts = 0;
  for (let seed = 1; seed <= 12 && completions === 0; seed++) {
    const g = GridSim.createGame({ humans: [true, false], seed: seed * 101 });
    for (let play = 0; play < 3 && completions === 0; play++) {
      stepUntil(g, (x) => x.phase === 'playcall');
      if (g.possession !== 0) break;
      GridSim.input(g, 0, { t: 'pick', play: 'slant' });
      stepUntil(g, (x) => x.phase === 'live');
      stepUntil(g, (x) => x.phase !== 'live' || x.liveT >= 1.3);
      if (g.phase !== 'live' || g.ball.holder !== 'QB') continue;
      // pick the most open eligible receiver and lead it
      const qb = P(g, 'QB');
      let best = null;
      for (const id of ['WR1', 'WR2', 'TE', 'RB']) {
        const r = P(g, id);
        const T = GridSim.passFlightTime(Math.hypot(r.x - qb.x, r.y - qb.y));
        const tx = r.x + r.vx * T, ty = r.y + r.vy * T;
        let open = Infinity;
        for (const d of g.players.filter((p) => p.side === 'def')) open = Math.min(open, Math.hypot(d.x - tx, d.y - ty));
        if (!best || open > best.open) best = { tx, ty, open };
      }
      GridSim.input(g, 0, { t: 'throw', x: best.tx, y: best.ty });
      assert.strictEqual(g.ball.state, 'air');
      attempts++;
      let caught = false;
      for (let i = 0; i < 400 && g.phase === 'live'; i++) {
        GridSim.step(g, DT);
        if (g.ball.state === 'held' && g.ball.holder !== 'QB') caught = true;
        if (caught) break;
      }
      if (caught) {
        completions++;
        const s = GridSim.snapshot(g);
        assert.ok(s.events.includes('catch'));
        assert.notStrictEqual(s.controlledOffId, 'QB');
        assert.strictEqual(s.controlledOffId, g.ball.holder);
      }
    }
  }
  assert.ok(attempts > 0, 'should have attempted throws');
  assert.ok(completions > 0, `expected a completion in ${attempts} attempts`);
});

test('throw is rejected once the QB is past the line of scrimmage', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 8 });
  GridSim.input(g, 0, { t: 'pick', play: 'deep' });
  GridSim.input(g, 1, { t: 'pick', play: 'zone' });
  stepUntil(g, (x) => x.phase === 'live');
  const qb = P(g, 'QB');
  qb.x = 10 + g.ballOn + 3; // teleport past LOS
  GridSim.input(g, 0, { t: 'throw', x: qb.x + 10, y: qb.y });
  assert.strictEqual(g.ball.state, 'held');
});

test('select changes userDefenderId only for defense and only to defenders', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 9 });
  GridSim.input(g, 1, { t: 'select', id: 'CB1' });
  assert.strictEqual(GridSim.snapshot(g).userDefenderId, 'CB1');
  GridSim.input(g, 0, { t: 'select', id: 'LB' }); // offense team: ignored
  assert.strictEqual(g.userDefenderId, 'CB1');
  GridSim.input(g, 1, { t: 'select', id: 'QB' }); // not a defender
  assert.strictEqual(g.userDefenderId, 'CB1');
  GridSim.input(g, 1, { t: 'select', id: 'S2' });
  assert.strictEqual(g.userDefenderId, 'S2');
  // the selected defender follows move input during live
  GridSim.input(g, 0, { t: 'pick', play: 'run' });
  GridSim.input(g, 1, { t: 'pick', play: 'zone' });
  stepUntil(g, (x) => x.phase === 'live');
  const s2 = P(g, 'S2');
  const y0 = s2.y;
  GridSim.input(g, 1, { t: 'move', x: s2.x, y: y0 + 6 });
  for (let i = 0; i < 14; i++) GridSim.step(g, DT);
  assert.ok(s2.y > y0 + 2, 'user defender should follow move target');
});

test('fourth-down punt changes possession', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 10 });
  g.down = 4; g.toGo = 8; g.ballOn = 30;
  assert.strictEqual(GridSim.snapshot(g).fourthDown, true);
  GridSim.input(g, 0, { t: 'pick', play: 'punt' });
  GridSim.input(g, 1, { t: 'pick', play: 'man' });
  stepUntil(g, (x) => x.phase === 'result');
  assert.strictEqual(g.message, 'PUNT');
  stepUntil(g, (x) => x.phase === 'playcall');
  assert.strictEqual(g.possession, 1);
  assert.strictEqual(g.ballOn, 30); // 100 - (30 + 40)
  assert.strictEqual(g.down, 1);
  assert.strictEqual(g.toGo, 10);
});

test('punt deep in opponent territory is a touchback at the 20', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 12 });
  g.down = 4; g.toGo = 8; g.ballOn = 60;
  GridSim.input(g, 0, { t: 'pick', play: 'punt' });
  GridSim.input(g, 1, { t: 'pick', play: 'zone' });
  stepUntil(g, (x) => x.phase === 'playcall' && x.possession === 1);
  assert.strictEqual(g.ballOn, 20);
});

test('FG kick with meter locked near 0 is good from short range', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 13 });
  g.down = 4; g.toGo = 5; g.ballOn = 85;
  GridSim.input(g, 0, { t: 'pick', play: 'fg' });
  GridSim.input(g, 1, { t: 'pick', play: 'blitz' });
  stepUntil(g, (x) => x.phase === 'kick');
  const s = GridSim.snapshot(g);
  assert.strictEqual(s.phase, 'kick');
  assert.ok(Math.abs(s.kickMeter) < 0.2);
  GridSim.input(g, 1, { t: 'kick' }); // defense can't kick
  assert.strictEqual(g.phase, 'kick');
  GridSim.input(g, 0, { t: 'kick' });
  assert.strictEqual(g.phase, 'result');
  assert.deepStrictEqual(g.score, [3, 0]);
  const r = GridSim.snapshot(g);
  assert.ok(r.events.includes('fg_good'));
  assert.strictEqual(r.message, 'FIELD GOAL GOOD');
  stepUntil(g, (x) => x.phase === 'playcall');
  assert.strictEqual(g.possession, 1);
  assert.strictEqual(g.ballOn, 25);
});

test('FG kick timeout locks at a value and resolves', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 14 });
  g.down = 4; g.ballOn = 40; // 77 yard attempt: threshold floor
  GridSim.input(g, 0, { t: 'pick', play: 'fg' });
  GridSim.input(g, 1, { t: 'pick', play: 'zone' });
  stepUntil(g, (x) => x.phase === 'result', 1000);
  assert.strictEqual(g.phase, 'result');
  assert.ok(['FIELD GOAL GOOD', 'NO GOOD'].includes(g.message));
});

test('incomplete pass at fourth down is a turnover on downs', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 15 });
  g.down = 4; g.toGo = 3; g.ballOn = 50;
  GridSim.input(g, 0, { t: 'pick', play: 'deep' });
  GridSim.input(g, 1, { t: 'pick', play: 'zone' });
  stepUntil(g, (x) => x.phase === 'live');
  const qb = P(g, 'QB');
  GridSim.input(g, 0, { t: 'throw', x: qb.x + 5, y: 0 }); // throw it away at the sideline
  stepUntil(g, (x) => x.phase !== 'live');
  if (g.message === 'TURNOVER ON DOWNS') {
    stepUntil(g, (x) => x.phase === 'playcall');
    assert.strictEqual(g.possession, 1);
    assert.strictEqual(g.ballOn, 50);
    assert.strictEqual(g.down, 1);
  } else {
    // a defender may have picked it off
    assert.strictEqual(g.message, 'INTERCEPTED!');
  }
});

test('sack: a human QB who holds the ball forever gets sacked', () => {
  const g = GridSim.createGame({ humans: [true, false], seed: 16 });
  GridSim.input(g, 0, { t: 'pick', play: 'slant' });
  stepUntil(g, (x) => x.phase === 'live');
  stepUntil(g, (x) => x.phase !== 'live', 1000);
  assert.strictEqual(g.phase, 'result');
  assert.ok(/SACK/.test(g.message) || g.message === 'TURNOVER ON DOWNS' || g.message === 'SAFETY!', g.message);
});

test('ball in the air at the live cutoff is incomplete', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 17 });
  GridSim.input(g, 0, { t: 'pick', play: 'deep' });
  GridSim.input(g, 1, { t: 'pick', play: 'zone' });
  stepUntil(g, (x) => x.phase === 'live');
  // keep defenders away from the QB
  g.players.filter((p) => p.side === 'def').forEach((p) => { p.x = 119; });
  stepUntil(g, (x) => x.liveT >= 11.9 || x.phase !== 'live', 1000);
  assert.strictEqual(g.phase, 'live');
  const qb = P(g, 'QB');
  GridSim.input(g, 0, { t: 'throw', x: qb.x + 40, y: qb.y });
  assert.strictEqual(g.ball.state, 'air');
  stepUntil(g, (x) => x.phase !== 'live', 100);
  assert.strictEqual(g.message, 'INCOMPLETE');
});

test('safety when the carrier is downed in his own endzone', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 18 });
  g.ballOn = 2;
  GridSim.input(g, 0, { t: 'pick', play: 'slant' });
  GridSim.input(g, 1, { t: 'pick', play: 'man' });
  stepUntil(g, (x) => x.phase === 'live');
  const qb = P(g, 'QB');
  const dl = P(g, 'DL1');
  dl.x = qb.x; dl.y = qb.y + 0.3; dl.freeT = 5;
  GridSim.step(g, DT);
  assert.strictEqual(g.message, 'SAFETY!');
  assert.deepStrictEqual(g.score, [0, 2]);
  stepUntil(g, (x) => x.phase === 'playcall');
  assert.strictEqual(g.possession, 1, 'scoring team gets the ball');
  assert.strictEqual(g.ballOn, 25);
});

test('interception in the endzone is a touchback', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 19 });
  g.ballOn = 90;
  GridSim.input(g, 0, { t: 'pick', play: 'deep' });
  GridSim.input(g, 1, { t: 'pick', play: 'zone' });
  stepUntil(g, (x) => x.phase === 'live');
  // throw into the back of the endzone where only defenders stand
  const tx = 116, ty = 10;
  for (const p of g.players) {
    if (p.side === 'off' && p.id !== 'QB') { p.x = 60; p.y = 50; }
  }
  for (const id of ['CB1', 'CB2', 'S1', 'S2', 'LB']) { const d = P(g, id); d.x = tx; d.y = ty; }
  GridSim.input(g, 1, { t: 'move', x: tx, y: ty }); // keep the selected safety on the landing spot
  let gotInt = false;
  for (let attempt = 0; attempt < 30 && !gotInt; attempt++) {
    const copy = JSON.parse(JSON.stringify(g));
    copy.rngState = (copy.rngState + attempt * 7919) >>> 0;
    GridSim.input(copy, 0, { t: 'throw', x: tx, y: ty });
    stepUntil(copy, (x) => x.phase !== 'live', 200);
    if (copy.message === 'INTERCEPTED!') {
      gotInt = true;
      assert.strictEqual(copy.sub, 'Touchback');
      stepUntil(copy, (x) => x.phase === 'playcall');
      assert.strictEqual(copy.possession, 1);
      assert.strictEqual(copy.ballOn, 20);
    } else {
      assert.strictEqual(copy.message, 'INCOMPLETE');
    }
  }
  assert.ok(gotInt, 'expected at least one interception');
});

test('touchdown scores 7 and gives the ball to the other team', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 20 });
  g.ballOn = 97;
  GridSim.input(g, 0, { t: 'pick', play: 'run' });
  GridSim.input(g, 1, { t: 'pick', play: 'zone' });
  stepUntil(g, (x) => x.phase === 'live');
  stepUntil(g, (x) => x.ball.holder === 'RB');
  const rb = P(g, 'RB');
  // clear the way
  g.players.filter((p) => p.side === 'def').forEach((p) => { p.x = 60; p.y = 50; });
  GridSim.input(g, 0, { t: 'move', x: 115, y: rb.y });
  stepUntil(g, (x) => x.phase !== 'live', 300);
  assert.strictEqual(g.message, 'TOUCHDOWN!');
  assert.deepStrictEqual(g.score, [7, 0]);
  stepUntil(g, (x) => x.phase === 'playcall');
  assert.strictEqual(g.possession, 1);
  assert.strictEqual(g.ballOn, 25);
});

test('first down resets downs and reports gain', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 21 });
  GridSim.input(g, 0, { t: 'pick', play: 'run' });
  GridSim.input(g, 1, { t: 'pick', play: 'zone' });
  stepUntil(g, (x) => x.phase === 'live');
  stepUntil(g, (x) => x.ball.holder === 'RB');
  const rb = P(g, 'RB');
  g.players.filter((p) => p.side === 'def').forEach((p) => { p.x = 100; p.y = 50; });
  GridSim.input(g, 0, { t: 'move', x: 10 + 25 + 15, y: rb.y });
  stepUntil(g, (x) => rb.x >= 10 + 25 + 14, 300);
  // tackle him
  const lb = P(g, 'LB');
  lb.x = rb.x + 0.2; lb.y = rb.y;
  GridSim.step(g, DT);
  assert.strictEqual(g.phase, 'result');
  assert.strictEqual(g.message, '1ST DOWN');
  assert.match(g.sub, /^Gain of 1\d/);
  const s = GridSim.snapshot(g);
  assert.ok(s.events.includes('first_down'));
  assert.ok(s.events.includes('tackle'));
  stepUntil(g, (x) => x.phase === 'playcall');
  assert.strictEqual(g.down, 1);
  assert.strictEqual(g.toGo, 10);
  assert.ok(g.ballOn >= 39);
});

test('second half kicks off to team 1 and game ends after Q4', () => {
  const g = GridSim.createGame({ humans: [false, false], seed: 22, quarterLength: 30 });
  let sawHalf = false;
  stepUntil(g, (x) => {
    if (x.quarter === 3 && !sawHalf) {
      sawHalf = true;
      assert.strictEqual(x.possession, 1);
      assert.strictEqual(x.ballOn, 25);
      assert.strictEqual(x.down, 1);
      assert.strictEqual(x.message, 'HALFTIME');
    }
    return x.phase === 'gameover';
  }, STEP_CAP);
  assert.ok(sawHalf);
  assert.strictEqual(g.phase, 'gameover');
  const s = GridSim.snapshot(g);
  assert.ok(s.events.includes('gameover'));
  // step/input are no-ops after gameover
  GridSim.step(g, DT);
  GridSim.input(g, 0, { t: 'pick', play: 'slant' });
  assert.strictEqual(g.phase, 'gameover');
});

test('paused game does not advance', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 23 });
  g.paused = true;
  const t0 = g.phaseTime;
  for (let i = 0; i < 100; i++) GridSim.step(g, DT);
  assert.strictEqual(g.phaseTime, t0);
  assert.strictEqual(GridSim.snapshot(g).paused, true);
});

test('snapshot drains events', () => {
  const g = GridSim.createGame({ humans: [true, true], seed: 24 });
  GridSim.input(g, 0, { t: 'pick', play: 'slant' });
  GridSim.input(g, 1, { t: 'pick', play: 'zone' });
  stepUntil(g, (x) => x.phase === 'live');
  const a = GridSim.snapshot(g);
  assert.ok(a.events.includes('snap'));
  const b = GridSim.snapshot(g);
  assert.deepStrictEqual(b.events, []);
});

test('reset starts a fresh game with the same options', () => {
  const { g } = runCpuGame(31, { quarterLength: 30, teamNames: ['A', 'B'] });
  assert.strictEqual(g.phase, 'gameover');
  GridSim.reset(g);
  const s = GridSim.snapshot(g);
  assert.strictEqual(s.phase, 'playcall');
  assert.deepStrictEqual(s.score, [0, 0]);
  assert.strictEqual(s.quarter, 1);
  assert.strictEqual(s.clock, 30);
  assert.deepStrictEqual(s.teamNames, ['A', 'B']);
  assert.strictEqual(s.possession, 0);
});

test('determinism: same seed + same inputs -> identical snapshots', () => {
  function play(seed) {
    const g = GridSim.createGame({ humans: [true, false], seed, quarterLength: 60 });
    let steps = 0;
    while (g.phase !== 'gameover' && steps < STEP_CAP) {
      if (g.phase === 'playcall' && g.possession === 0 && !g.picks[0]) {
        GridSim.input(g, 0, { t: 'pick', play: ['slant', 'deep', 'run', 'screen'][steps % 4] });
      }
      if (g.phase === 'live' && g.possession === 0 && g.ball.holder === 'QB' && g.liveT > 1.5) {
        const r = P(g, 'WR2');
        GridSim.input(g, 0, { t: 'throw', x: r.x + 3, y: r.y });
      }
      if (g.phase === 'live' && g.possession === 1 && steps % 20 === 0) {
        const c = g.players.find((p) => p.id === (g.ball.holder || 'QB'));
        GridSim.input(g, 0, { t: 'move', x: c.x, y: c.y });
      }
      GridSim.step(g, DT);
      steps++;
    }
    return JSON.stringify(GridSim.snapshot(g)) + '|' + steps;
  }
  const a = play(4242);
  const b = play(4242);
  assert.strictEqual(a, b);
  const c = play(4243);
  assert.notStrictEqual(a, c);
});
