'use strict';
/**
 * Regression tests for review findings:
 *  1. online FG `kick` honours `at` (the kick time the player saw)
 *  2. `leave` -> opponent_quit + room deleted (not a dropout)
 *  3. `away` / `back` pause & resume; pause clears only when both are present
 *  4. snapshot.canThrow; a QB past the line can't throw but can juke
 *  5. join may take over a disconnected seat 1; net.js re-sends create/join after a reconnect
 *  7. INT in the offense's own endzone is a defensive TD
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const WebSocket = require('ws');

const GridSim = require('../shared/sim.js');
const { start } = require('../server/index.js');
const fakeSim = require('./fixtures/fake-sim.js');

const DT = 1 / 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = (g, id) => g.players.find((p) => p.id === id);

function stepUntil(g, pred, cap = 20000) {
  for (let i = 0; i < cap; i++) {
    if (pred(g)) return true;
    GridSim.step(g, DT);
  }
  return pred(g);
}

function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const inbox = [];
    const waiters = [];
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch (e) { return; }
      inbox.push(m);
      if (inbox.length > 3000) inbox.splice(0, inbox.length - 3000);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        const idx = inbox.findIndex(w.pred);
        if (idx >= 0) {
          waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(inbox.splice(idx, 1)[0]);
        }
      }
    });
    const c = {
      ws,
      inbox,
      send(obj) { ws.send(JSON.stringify(obj)); },
      wait(pred, ms = 2000, label = '') {
        if (typeof pred === 'string') { const type = pred; label = label || type; pred = (m) => m.type === type; }
        const idx = inbox.findIndex(pred);
        if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0]);
        return new Promise((res, rej) => {
          const w = {
            pred, resolve: res, timer: setTimeout(() => {
              waiters.splice(waiters.indexOf(w), 1);
              rej(new Error('timeout waiting for ' + (label || pred.toString()) + '; inbox: ' + inbox.map((m) => m.type).join(',')));
            }, ms),
          };
          waiters.push(w);
        });
      },
      clear() { inbox.length = 0; },
      close() {
        return new Promise((res) => {
          if (ws.readyState === WebSocket.CLOSED) return res();
          ws.once('close', () => res());
          ws.close();
        });
      },
    };
    ws.once('open', () => resolve(c));
    ws.once('error', reject);
  });
}

async function pair(port) {
  const a = await client(port);
  const b = await client(port);
  a.send({ type: 'create', name: 'Alice' });
  const created = await a.wait('created');
  b.send({ type: 'join', code: created.code, name: 'Bob' });
  const joined = await b.wait('joined');
  await a.wait('start');
  await b.wait('start');
  return { a, b, created, joined };
}

const lastState = (c) => c.inbox.filter((m) => m.type === 'state').pop();

// ------------------------------------------------------------------ sim

function kickGame(seed) {
  const g = GridSim.createGame({ humans: [true, true], seed });
  g.down = 4; g.toGo = 5; g.ballOn = 85; // 32-yard try, threshold ~0.51
  GridSim.input(g, 0, { t: 'pick', play: 'fg' });
  GridSim.input(g, 1, { t: 'pick', play: 'zone' });
  stepUntil(g, (x) => x.phase === 'kick');
  // needle crossed zero at ~0.785s; by ~0.98s it is far out (sin(3.94) ~ -0.71)
  stepUntil(g, (x) => x.kickT >= 0.98);
  assert.equal(g.phase, 'kick');
  assert.ok(Math.abs(g.kickMeter) > 0.6, 'needle should be out of the green now');
  return g;
}

describe('#1 kick `at` (lag-compensated FG)', () => {
  test('kick with `at` inside the 0.4s window locks the meter shown at that time', () => {
    const g = kickGame(31);
    const at = Math.PI / 4; // the needle was dead center here
    assert.ok(g.kickT - at < 0.4);
    GridSim.input(g, 0, { t: 'kick', at });
    assert.equal(g.phase, 'result');
    assert.ok(Math.abs(g.kickMeter - Math.sin(at * 4)) < 1e-9);
    assert.equal(g.message, 'FIELD GOAL GOOD');
    assert.deepEqual(g.score, [3, 0]);
  });

  test('`at` outside the window (too old / future / garbage) falls back to now', () => {
    for (const at of [0.5, 5, -1, 'x', NaN, null]) {
      const g = kickGame(32);
      const now = g.kickMeter;
      GridSim.input(g, 0, { t: 'kick', at });
      assert.equal(g.phase, 'result');
      assert.equal(g.kickMeter, now, 'at=' + at);
      assert.equal(g.message, 'NO GOOD');
    }
  });

  test('plain kick (CPU mode / old client) still locks at the current value; snapshot exposes KICK_TIME', () => {
    const g = kickGame(33);
    const now = g.kickMeter;
    const s = GridSim.snapshot(g);
    // the client derives `at` from phaseTime (seconds remaining)
    assert.ok(Math.abs((GridSim.KICK_TIME - s.phaseTime) - g.kickT) < 0.006);
    GridSim.input(g, 0, { t: 'kick' });
    assert.equal(g.kickMeter, now);
  });
});

describe('#4 canThrow', () => {
  test('true while the QB may throw; false once he scrambles past the line; throw ignored, juke works', () => {
    const g = GridSim.createGame({ humans: [true, true], seed: 41 });
    assert.equal(GridSim.snapshot(g).canThrow, false, 'not during playcall');
    GridSim.input(g, 0, { t: 'pick', play: 'slant' });
    GridSim.input(g, 1, { t: 'pick', play: 'zone' });
    stepUntil(g, (x) => x.phase === 'live');
    let s = GridSim.snapshot(g);
    assert.equal(s.canThrow, true);
    assert.equal(s.controlledOffId, 'QB');
    // clear the way and put the QB past the line
    g.players.filter((p) => p.side === 'def').forEach((p) => { p.x = 119; p.y = 50; });
    const qb = P(g, 'QB');
    qb.x = 10 + g.ballOn + 2;
    GridSim.step(g, DT);
    s = GridSim.snapshot(g);
    assert.equal(s.phase, 'live');
    assert.equal(s.ball.holder, 'QB');
    assert.equal(s.canThrow, false);
    assert.equal(s.controlledOffId, 'QB', 'QB is still steerable as a runner');
    GridSim.input(g, 0, { t: 'throw', x: qb.x + 10, y: qb.y });
    assert.equal(g.ball.state, 'held', 'throw past the line is rejected');
    GridSim.input(g, 0, { t: 'juke' });
    assert.ok(qb.jukeT > 0, 'scrambling QB can juke');
    GridSim.input(g, 0, { t: 'move', x: qb.x + 5, y: qb.y });
    assert.equal(qb.hasTarget, true, 'scrambling QB can be steered');
  });

  test('false after a run-play handoff', () => {
    const g = GridSim.createGame({ humans: [true, true], seed: 42 });
    GridSim.input(g, 0, { t: 'pick', play: 'run' });
    GridSim.input(g, 1, { t: 'pick', play: 'zone' });
    stepUntil(g, (x) => x.phase === 'live');
    stepUntil(g, (x) => x.handedOff || x.phase !== 'live', 60);
    if (g.phase === 'live') assert.equal(GridSim.snapshot(g).canThrow, false);
  });
});

describe('#7 interception in the offense\'s own endzone', () => {
  test('is a defensive touchdown; the throwing team gets the ball at its own 25', () => {
    const g = GridSim.createGame({ humans: [true, true], seed: 71 });
    g.ballOn = 5; // LOS at x=15, QB at ~11
    GridSim.input(g, 0, { t: 'pick', play: 'slant' });
    GridSim.input(g, 1, { t: 'pick', play: 'zone' });
    stepUntil(g, (x) => x.phase === 'live');
    const tx = 4, ty = 26;
    for (const p of g.players) if (p.side === 'off' && p.id !== 'QB') { p.x = 60; p.y = 50; }
    for (const id of ['CB1', 'CB2', 'S1', 'S2', 'LB']) { const d = P(g, id); d.x = tx; d.y = ty; }
    for (const id of ['DL1', 'DL2']) { const d = P(g, id); d.x = 90; d.y = 50; }
    let gotInt = false;
    for (let attempt = 0; attempt < 30 && !gotInt; attempt++) {
      const copy = JSON.parse(JSON.stringify(g));
      copy.rngState = (copy.rngState + attempt * 7919) >>> 0;
      GridSim.input(copy, 0, { t: 'throw', x: tx, y: ty });
      assert.equal(copy.ball.state, 'air');
      stepUntil(copy, (x) => x.phase !== 'live', 200);
      const snap = GridSim.snapshot(copy);
      if (copy.message === 'INCOMPLETE') continue;
      gotInt = true;
      assert.equal(copy.message, 'PICK SIX!');
      assert.deepEqual(copy.score, [0, 6]);
      assert.ok(snap.events.includes('int'));
      assert.ok(snap.events.includes('td'));
      stepUntil(copy, (x) => x.phase === 'kick');
      assert.equal(copy.possession, 1, 'the team that made the interception kicks the extra point');
      GridSim.input(copy, 0, { t: 'kick' });
      assert.equal(copy.phase, 'kick', 'the throwing team cannot take the extra point');
      GridSim.input(copy, 1, { t: 'kick' });
      assert.deepEqual(copy.score, [0, 7]);
      stepUntil(copy, (x) => x.phase === 'playcall');
      assert.equal(copy.possession, 0, 'team that threw it gets the ball back');
      assert.equal(copy.ballOn, 25);
      assert.equal(copy.down, 1);
      assert.equal(copy.toGo, 10);
    }
    assert.ok(gotInt, 'expected at least one interception');
  });
});

// ------------------------------------------------------------------ server (fake sim)

describe('server: leave / away / back / seat takeover (fake sim)', () => {
  let srv;
  before(async () => { srv = await start(0, { sim: fakeSim, host: '127.0.0.1', roomTtlMs: 10000 }); });
  after(() => srv.close());

  test('#2 leave -> opponent_quit, room deleted, no opponent_left', async () => {
    const { a, b, created } = await pair(srv.port);
    a.send({ type: 'leave' });
    await a.close();
    await b.wait('opponent_quit');
    assert.equal(srv.rooms.has(created.code), false);
    await sleep(150);
    assert.ok(!b.inbox.some((m) => m.type === 'opponent_left' || m.type === 'error'), b.inbox.map((m) => m.type).join(','));
    // the remaining socket is free to start a new room
    b.send({ type: 'create', name: 'Bob' });
    await b.wait('created');
    await b.close();
  });

  test('#2 leave while waiting for an opponent deletes the room', async () => {
    const a = await client(srv.port);
    a.send({ type: 'create', name: 'Solo' });
    const created = await a.wait('created');
    a.send({ type: 'leave' });
    await sleep(80);
    assert.equal(srv.rooms.has(created.code), false);
    await a.close();
  });

  test('#3 away pauses, back resumes; pause clears only when both are present', async () => {
    const { a, b } = await pair(srv.port);
    a.send({ type: 'away' });
    const left = await b.wait('opponent_left');
    assert.equal(left.reason, 'away');
    await b.wait((m) => m.type === 'state' && m.s.paused === true, 2000, 'paused');
    await sleep(120);
    b.clear();
    const s1 = await b.wait('state');
    await sleep(120);
    const s2 = await b.wait((m) => m.type === 'state' && m !== s1);
    assert.equal(s2.s.steps, s1.s.steps, 'no stepping while away');

    // both away, then a comes back: still paused, a is told b is away
    b.send({ type: 'away' });
    await a.wait((m) => m.type === 'opponent_left' && m.reason === 'away', 2000, 'a sees b away');
    a.clear();
    a.send({ type: 'back' });
    await b.wait('opponent_back');
    await a.wait((m) => m.type === 'opponent_left' && m.reason === 'away', 2000, 'status re-sent to a');
    await sleep(120);
    assert.equal(lastState(a).s.paused, true, 'still paused while b is away');

    b.send({ type: 'back' });
    await a.wait('opponent_back');
    await a.wait((m) => m.type === 'state' && m.s.paused === false, 2000, 'unpaused');
    await a.close(); await b.close();
  });

  test('#3 away player whose socket dies is un-awayed by rejoin', async () => {
    const { a, b, joined } = await pair(srv.port);
    b.send({ type: 'away' });
    await a.wait((m) => m.type === 'opponent_left' && m.reason === 'away');
    await b.close();
    await a.wait((m) => m.type === 'opponent_left' && !m.reason);
    const b2 = await client(srv.port);
    b2.send({ type: 'rejoin', code: joined.code, token: joined.token });
    await b2.wait('rejoined');
    await a.wait('opponent_back');
    await a.wait((m) => m.type === 'state' && m.s.paused === false, 2000, 'unpaused after rejoin');
    await a.close(); await b2.close();
  });

  test('#3 a disconnect while the other is away keeps the game paused after rejoin', async () => {
    const { a, b, created } = await pair(srv.port);
    a.send({ type: 'away' });
    await b.wait((m) => m.type === 'opponent_left' && m.reason === 'away');
    await b.close();
    await sleep(50);
    const b2 = await client(srv.port);
    // b2 takes the dropped seat via join (also covers #5)
    b2.send({ type: 'join', code: created.code, name: 'Bob2' });
    await b2.wait('joined');
    await b2.wait((m) => m.type === 'opponent_left' && m.reason === 'away', 2000, 'b2 told a is away');
    await sleep(120);
    assert.equal(lastState(b2).s.paused, true);
    a.send({ type: 'back' });
    await b2.wait('opponent_back');
    await b2.wait((m) => m.type === 'state' && m.s.paused === false, 2000, 'unpaused');
    await a.close(); await b2.close();
  });

  test('#5 join takes over a disconnected seat 1 (lost joined ack), but not a connected one', async () => {
    const { a, b, created, joined } = await pair(srv.port);
    const c = await client(srv.port);
    c.send({ type: 'join', code: created.code, name: 'Eve' });
    assert.equal((await c.wait('error')).reason, 'full');
    await b.close();
    await a.wait('opponent_left');
    c.send({ type: 'join', code: created.code, name: 'Bob' });
    const j = await c.wait('joined');
    assert.equal(j.team, 1);
    assert.notEqual(j.token, joined.token);
    const st = await c.wait('start');
    assert.equal(st.team, 1);
    assert.deepEqual(st.names, ['Alice', 'Bob']);
    await a.wait('opponent_back');
    await a.wait((m) => m.type === 'state' && m.s.paused === false, 2000, 'unpaused');
    // c's inputs count as team 1
    c.send({ type: 'input', msg: { t: 'stop' } });
    await a.wait((m) => m.type === 'state' && m.s.inputs.some((i) => i.team === 1 && i.t === 'stop'), 2000, 'team 1 input');
    // the old token is no longer valid
    const old = await client(srv.port);
    old.send({ type: 'rejoin', code: created.code, token: joined.token });
    assert.equal((await old.wait('error')).reason, 'bad_token');
    await a.close(); await c.close(); await old.close();
  });
});

// ------------------------------------------------------------------ server (real sim): scripted 2-client checks

describe('server + real sim: lag-compensated kick and quit', () => {
  let srv;
  before(async () => { srv = await start(0, { host: '127.0.0.1' }); });
  after(() => srv.close());

  test('#1 kick sent ~150ms late with `at` from the seen snapshot is good', async () => {
    const { a, b, created } = await pair(srv.port);
    const g = srv.rooms.get(created.code).game;
    g.down = 4; g.toGo = 5; g.ballOn = 85; // 32-yard try (threshold ~0.51)
    a.send({ type: 'input', msg: { t: 'pick', play: 'fg' } });
    b.send({ type: 'input', msg: { t: 'pick', play: 'zone' } });
    // the "seen" snapshot: needle near dead center
    const seen = await a.wait((m) => m.type === 'state' && m.s.phase === 'kick' && m.s.kickMeter != null &&
      Math.abs(m.s.kickMeter) < 0.12 && m.s.phaseTime < 3.9, 6000, 'centered needle');
    await sleep(150); // reaction + latency: the live needle has swung well out of the green
    const at = GridSim.KICK_TIME - seen.s.phaseTime;
    a.send({ type: 'input', msg: { t: 'kick', at } });
    const res = await a.wait((m) => m.type === 'state' && m.s.phase === 'result', 3000, 'result');
    assert.equal(res.s.message, 'FIELD GOAL GOOD', 'locked meter ' + res.s.kickMeter);
    assert.ok(Math.abs(res.s.kickMeter - seen.s.kickMeter) < 0.08);
    await a.close(); await b.close();
  });

  test('online touchdown and timed extra point reach both players', async () => {
    const { a, b, created } = await pair(srv.port);
    try {
      const g = srv.rooms.get(created.code).game;
      a.send({ type: 'input', msg: { t: 'pick', play: 'slant' } });
      b.send({ type: 'input', msg: { t: 'pick', play: 'zone' } });
      await a.wait((m) => m.type === 'state' && m.s.phase === 'live', 4000, 'snap');
      P(g, 'QB').x = 111;

      const td = await b.wait((m) => m.type === 'state' && m.s.events.includes('td'), 2000, 'touchdown');
      assert.deepEqual(td.s.score, [6, 0]);
      const seen = await a.wait((m) => m.type === 'state' && m.s.phase === 'kick' && m.s.kickKind === 'pat' &&
        Math.abs(m.s.kickMeter) < 0.12 && m.s.phaseTime < 3.9, 5000, 'centered extra point meter');
      a.send({ type: 'input', msg: { t: 'kick', at: GridSim.KICK_TIME - seen.s.phaseTime } });

      const made = await b.wait((m) => m.type === 'state' && m.s.events.includes('pat_good'), 2000, 'made extra point');
      assert.equal(made.s.message, 'EXTRA POINT GOOD');
      assert.deepEqual(made.s.score, [7, 0]);
      const next = await b.wait((m) => m.type === 'state' && m.s.phase === 'playcall' && m.s.possession === 1,
        4000, 'opponent possession');
      assert.equal(next.s.ballOn, 25);
    } finally {
      await a.close(); await b.close();
    }
  });

  test('#2 quitting mid-game: opponent gets opponent_quit (not opponent_left)', async () => {
    const { a, b, created } = await pair(srv.port);
    b.send({ type: 'leave' });
    b.ws.close();
    await a.wait('opponent_quit');
    await sleep(100);
    assert.ok(!a.inbox.some((m) => m.type === 'opponent_left'));
    assert.equal(srv.rooms.has(created.code), false);
    await a.close();
  });
});

// ------------------------------------------------------------------ client net.js (#5, #2)

function loadNet() {
  const sockets = [];
  const timers = [];
  class FakeWS {
    constructor(u) { this.url = u; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(d) { this.sent.push(JSON.parse(d)); }
    close() { this.readyState = 3; }
    // test helpers
    _open() { this.readyState = 1; this.onopen && this.onopen(); }
    _msg(m) { this.onmessage && this.onmessage({ data: JSON.stringify(m) }); }
    _drop() { this.readyState = 3; this.onclose && this.onclose(); }
  }
  const store = new Map();
  const ctx = {
    WebSocket: FakeWS,
    location: { protocol: 'http:', host: 'test' },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: { visibilityState: 'visible', addEventListener() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    console,
    JSON,
    Date,
    Math,
  };
  ctx.window = ctx;
  ctx.window.addEventListener = () => {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'net.js'), 'utf8'), ctx);
  return { Net: ctx.Net, sockets, timers, store };
}

describe('client net.js', () => {
  test('#5 join is re-sent after the socket drops before `joined`; then rejoin is used', () => {
    const { Net, sockets, timers } = loadNet();
    Net.sendWhenOpen({ type: 'join', code: 'ABCD', name: 'Bob' });
    assert.equal(sockets.length, 1);
    sockets[0]._open();
    assert.deepEqual(sockets[0].sent.map((m) => m.type), ['join']);
    sockets[0]._drop(); // lost before the ack
    timers.splice(0).forEach((fn) => fn()); // reconnect timer
    assert.equal(sockets.length, 2);
    sockets[1]._open();
    assert.deepEqual(sockets[1].sent.map((m) => m.type), ['join'], 'join re-sent on reconnect');
    sockets[1]._msg({ type: 'joined', code: 'ABCD', team: 1, token: 'tok' });
    sockets[1]._drop();
    timers.splice(0).forEach((fn) => fn());
    sockets[2]._open();
    assert.deepEqual(sockets[2].sent.map((m) => m.type), ['rejoin'], 'acknowledged: rejoin, not join');
  });

  test('#5 an error for the hello clears it (no endless re-join)', () => {
    const { Net, sockets, timers } = loadNet();
    Net.sendWhenOpen({ type: 'join', code: 'ABCD', name: 'Bob' });
    sockets[0]._open();
    sockets[0]._msg({ type: 'error', message: 'Room is full', reason: 'full' });
    sockets[0]._drop();
    timers.splice(0).forEach((fn) => fn());
    sockets[1]._open();
    assert.deepEqual(sockets[1].sent, []);
  });

  test('#2 Net.leave sends `leave` before closing; opponent_quit forgets the session', () => {
    const { Net, sockets, store } = loadNet();
    Net.sendWhenOpen({ type: 'create', name: 'A' });
    sockets[0]._open();
    sockets[0]._msg({ type: 'created', code: 'WXYZ', team: 0, token: 't0' });
    assert.ok(Net.getSession());
    sockets[0]._msg({ type: 'opponent_quit' });
    assert.equal(Net.getSession(), null);
    assert.equal(store.size, 0);
    Net.leave();
    assert.equal(sockets[0].sent.pop().type, 'leave');
    assert.equal(sockets[0].readyState, 3);
  });
});
