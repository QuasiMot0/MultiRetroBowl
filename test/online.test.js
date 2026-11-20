'use strict';
/**
 * End-to-end online tests: the real server + real shared/sim.js, two `ws` clients
 * playing a whole game with human-like inputs from both sides.
 *
 * To keep this fast the server is started with the test-only `timeScale` option
 * (sim runs N x real time; state broadcasts stay at 20 per *sim* second) and a
 * short `quarterLength`.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { start } = require('../server/index.js');

const TIME_SCALE = 16;
const QUARTER = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ helpers

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ws client that buffers parsed messages and can wait for a predicate. */
function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const inbox = [];
    const waiters = [];
    const listeners = [];
    const stateRaws = []; // every state frame since connect, verbatim
    ws.on('message', (data) => {
      const raw = data.toString();
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      m._raw = raw;
      if (m.type === 'state') stateRaws.push(raw);
      for (const l of listeners) l(m);
      inbox.push(m);
      if (inbox.length > 5000) inbox.splice(0, inbox.length - 5000);
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
      stateRaws,
      onMsg(fn) { listeners.push(fn); },
      send(obj) { if (ws.readyState === WebSocket.OPEN) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); },
      wait(pred, ms = 3000, label = '') {
        if (typeof pred === 'string') { const type = pred; label = label || type; pred = (m) => m.type === type; }
        const idx = inbox.findIndex(pred);
        if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0]);
        return new Promise((res, rej) => {
          const w = {
            pred, resolve: res, timer: setTimeout(() => {
              waiters.splice(waiters.indexOf(w), 1);
              rej(new Error('timeout waiting for ' + (label || pred.toString())));
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
  a.send({ type: 'create', name: 'Ann' });
  const created = await a.wait('created');
  b.send({ type: 'join', code: created.code, name: 'Ben' });
  const joined = await b.wait('joined');
  await a.wait('start');
  await b.wait('start');
  return { a, b, code: created.code, tokenA: created.token, tokenB: joined.token };
}

const pl = (s, id) => s.players.find((p) => p.id === id);
const hyp = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/**
 * A scripted "human" for one team. Reacts to every state message with at most
 * one or two inputs, like a person dragging a finger.
 */
function attachBot(c, team, seed, log) {
  const rnd = mulberry(seed);
  const bot = { team, enabled: true, playIdx: 0, possessionCount: 0, mode: 'normal', lastPossession: -1, play: null, sent: 0 };
  const NORMAL = ['slant', 'run', 'deep', 'screen'];
  const MODES = ['punt', 'fg', 'normal', 'normal'];
  let prevPhase = null, liveTick = 0, throwAt = 1, thrown = false, kicked = false, kickKey = null;
  const send = (msg) => { bot.sent++; c.send({ type: 'input', msg }); };

  c.onMsg((m) => {
    if (m.type !== 'state' || !bot.enabled) return;
    const s = m.s;
    if (s.paused || s.phase === 'gameover') { prevPhase = s.phase; return; }
    const off = s.possession === team;
    if (off && s.possession !== bot.lastPossession) {
      bot.mode = MODES[bot.possessionCount % MODES.length];
      bot.possessionCount++;
    }
    bot.lastPossession = s.possession;

    if (s.phase === 'playcall' && !s.picked[team]) {
      let play;
      if (off) {
        if (s.fourthDown && bot.mode === 'fg') play = 'fg';
        else if (s.fourthDown) play = s.ballOn >= 62 ? 'fg' : 'punt';
        else if (bot.mode !== 'normal') play = 'slant'; // burn downs with throwaways
        else play = NORMAL[bot.playIdx++ % NORMAL.length];
      } else {
        play = ['man', 'zone', 'blitz'][Math.floor(rnd() * 3)];
      }
      bot.play = play;
      log.picks.push({ team, play, off });
      send({ t: 'pick', play });
      return;
    }

    if (s.phase === 'kick') {
      const key = s.quarter + ':' + s.clock + ':' + s.ballOn;
      if (key !== kickKey) { kickKey = key; kicked = false; }
      if (off && !kicked && s.kickMeter != null && Math.abs(s.kickMeter) < 0.2) { kicked = true; send({ t: 'kick' }); }
      return;
    }

    const wasLive = prevPhase === 'live';
    prevPhase = s.phase;
    if (s.phase !== 'live') return;
    if (!wasLive) {
      liveTick = 0; thrown = false;
      throwAt = 0.7 + rnd() * 0.9;
      if (!off) {
        const pick = ['LB', 'CB1', 'CB2', 'S1', 'S2'][Math.floor(rnd() * 5)];
        if (pick !== s.userDefenderId) send({ t: 'select', id: pick });
      }
    }
    liveTick++;
    const b = s.ball;
    const carrier = b.state === 'held' ? pl(s, b.holder) : null;
    const LOS = 10 + s.ballOn;

    if (off) {
      if (carrier && carrier.id === 'QB' && s.controlledOffId === 'QB' && bot.play !== 'run') {
        if (!thrown && bot.mode !== 'normal' && s.phaseTime > 0.3) {
          thrown = true; // throwaway to the sideline -> incomplete
          send({ t: 'throw', x: carrier.x + 6, y: carrier.y < 26 ? 0 : 53.3 });
          return;
        }
        if (!thrown && s.phaseTime >= throwAt && carrier.x <= LOS + 1) {
          // throw at the most open receiver's current position (+ a little lead)
          let best = null;
          for (const id of ['WR1', 'WR2', 'TE', 'RB']) {
            const r = pl(s, id);
            let open = Infinity;
            for (const d of s.players) if (d.side === 'def') open = Math.min(open, hyp(d.x, d.y, r.x, r.y));
            if (!best || open > best.open) best = { r, open };
          }
          const T = hyp(carrier.x, carrier.y, best.r.x, best.r.y) / 24;
          thrown = true;
          send({ t: 'throw', x: best.r.x + best.r.vx * T, y: best.r.y + best.r.vy * T });
          return;
        }
        if (liveTick === 2) send({ t: 'move', x: carrier.x - 2, y: carrier.y + (rnd() - 0.5) * 4 });
        return;
      }
      if (carrier && s.controlledOffId === carrier.id && carrier.id !== 'QB') {
        // run for the endzone, veer away from the nearest defender, juke when close
        let near = null, nd = Infinity;
        for (const d of s.players) {
          if (d.side !== 'def') continue;
          const dd = hyp(d.x, d.y, carrier.x, carrier.y);
          if (dd < nd && d.x > carrier.x - 1) { nd = dd; near = d; }
        }
        if (nd < 2.2 && !carrier.juking && rnd() < 0.35) { send({ t: 'juke' }); return; }
        if (liveTick % 2 === 0) {
          let ty = carrier.y;
          if (near && nd < 8) ty += near.y > carrier.y ? -5 : 5;
          ty = Math.max(3, Math.min(50, ty));
          send({ t: 'move', x: carrier.x + 8, y: ty });
        }
      }
      return;
    }

    // defense: drive the selected defender at the carrier / landing spot
    if (liveTick % 2 !== 0) return;
    const me = pl(s, s.userDefenderId);
    if (!me) return;
    if (carrier) {
      const T = Math.min(0.5, hyp(me.x, me.y, carrier.x, carrier.y) / 7);
      send({ t: 'move', x: carrier.x + carrier.vx * T, y: carrier.y + carrier.vy * T });
    } else if (b.state === 'air') {
      send({ t: 'move', x: b.tx, y: b.ty });
    }
  });
  return bot;
}

/** Watches a client's states; checks score bookkeeping against events. */
function attachLedger(c, label) {
  const L = {
    label, raws: [], states: 0, events: {}, safeties: 0, results: [], errors: [], firstAt: 0, lastAt: 0,
    last: null, done: false, scoreErrors: [],
  };
  c.onMsg((m) => {
    if (m.type === 'error') L.errors.push(m);
    if (m.type !== 'state' || L.done) return;
    const s = m.s;
    L.states++;
    if (!L.firstAt) L.firstAt = Date.now();
    L.lastAt = Date.now();
    L.raws.push(m._raw);
    for (const e of s.events) L.events[e] = (L.events[e] || 0) + 1;
    const prev = L.last;
    if (prev) {
      const exp = [0, 0];
      const ev = s.events;
      const td = ev.filter((e) => e === 'td').length, fg = ev.filter((e) => e === 'fg_good').length;
      exp[s.possession] += 7 * td + 3 * fg;
      if (s.phase === 'result' && prev.phase !== 'result' && s.message === 'SAFETY!') { exp[1 - s.possession] += 2; L.safeties++; }
      if (s.phase === 'result' && prev.phase !== 'result') L.results.push(s.message);
      const d0 = s.score[0] - prev.score[0], d1 = s.score[1] - prev.score[1];
      // rematch resets scores; otherwise deltas must match events exactly
      if (!(s.score[0] === 0 && s.score[1] === 0 && prev.phase === 'gameover') && (d0 !== exp[0] || d1 !== exp[1])) {
        L.scoreErrors.push({ prev: prev.score, now: s.score, events: ev, msg: s.message });
      }
    }
    L.last = s;
    if (s.phase === 'gameover') L.done = true;
  });
  return L;
}

function captureConsoleErrors() {
  const orig = console.error;
  const seen = [];
  console.error = (...a) => { seen.push(a.map(String).join(' ')); };
  return { seen, restore() { console.error = orig; } };
}

// ------------------------------------------------------------------ tests

describe('online: full game between two scripted humans', () => {
  let srv, a, b, code, tokenB, la, lb, botA, botB, consoleCap, t0;

  before(async () => {
    consoleCap = captureConsoleErrors();
    srv = await start(0, { host: '127.0.0.1', timeScale: TIME_SCALE, quarterLength: QUARTER });
    ({ a, b, code, tokenB } = await pair(srv.port));
  });
  after(async () => {
    consoleCap.restore();
    await a?.close(); await b?.close();
    await srv?.close();
  });

  test('plays to gameover with consistent scores and identical state streams', async () => {
    const log = { picks: [] };
    la = attachLedger(a, 'A');
    lb = attachLedger(b, 'B');
    botA = attachBot(a, 0, 11, log);
    botB = attachBot(b, 1, 22, log);
    t0 = Date.now();
    await a.wait((m) => m.type === 'state' && m.s.phase === 'gameover', 60000, 'gameover A');
    await b.wait((m) => m.type === 'state' && m.s.phase === 'gameover', 5000, 'gameover B');
    const wall = (Date.now() - t0) / 1000;

    const fin = la.last;
    assert.equal(fin.phase, 'gameover');
    assert.equal(fin.quarter, 4);
    assert.deepEqual(la.scoreErrors, [], 'score deltas must match td/fg/safety events');
    const ev = la.events;
    const total = fin.score[0] + fin.score[1];
    assert.equal(total, 7 * (ev.td || 0) + 3 * (ev.fg_good || 0) + 2 * la.safeties, 'final score = 7*TD + 3*FG + 2*safety');
    assert.ok((ev.snap || 0) >= 6, 'several live plays were run: ' + JSON.stringify(ev));
    assert.ok((ev.throw || 0) >= 3, 'throws happened');
    assert.ok((ev.catch || 0) >= 1, 'at least one completion');
    assert.ok((ev.tackle || 0) + (ev.sack || 0) >= 1, 'tackles happened');
    assert.ok(botA.sent + botB.sent > 50, 'bots sent lots of inputs');
    assert.ok(ev.gameover === 1, 'gameover event once');
    // varied play calls incl. 4th-down specials
    const offPicks = new Set(log.picks.filter((p) => p.off).map((p) => p.play));
    const defPicks = new Set(log.picks.filter((p) => !p.off).map((p) => p.play));
    assert.ok(offPicks.has('punt'), 'punted on 4th: ' + [...offPicks]);
    assert.ok(offPicks.has('fg'), 'kicked a FG on 4th: ' + [...offPicks]);
    assert.ok(offPicks.size >= 4, 'varied offense plays: ' + [...offPicks]);
    assert.ok(defPicks.size >= 2, 'varied defense plays');
    assert.ok(la.results.includes('PUNT'), 'a punt was resolved');
    assert.ok((ev.fg_good || 0) + (ev.fg_miss || 0) >= 1, 'a FG was attempted');
    // identical streams to both players, from the first state to gameover
    const upToGameover = (raws) => raws.slice(0, raws.findIndex((r) => r.includes('"phase":"gameover"')) + 1);
    const ra = upToGameover(a.stateRaws), rb = upToGameover(b.stateRaws);
    assert.ok(ra.length > 100);
    assert.equal(ra.length, rb.length, 'same number of states');
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) assert.fail('state #' + i + ' differs between clients');
    }
    // ~20 states per sim-second (timeScale x wall)
    const rate = la.states / (wall * TIME_SCALE);
    assert.ok(rate > 13 && rate < 23, 'state rate per sim-second ~20, got ' + rate.toFixed(1));
    assert.deepEqual(la.errors, []);
    assert.deepEqual(lb.errors, []);
    assert.deepEqual(consoleCap.seen, [], 'server logged errors');
  });

  test('rematch from gameover resets the game', async () => {
    botA.enabled = false; botB.enabled = false;
    a.clear(); b.clear();
    a.send({ type: 'rematch' });
    await b.wait('rematch_requested');
    // only one side asked: still game over
    await sleep(60);
    assert.equal(srv.rooms.get(code).game.phase, 'gameover');
    b.send({ type: 'rematch' });
    const st = await a.wait((m) => m.type === 'state' && m.s.phase === 'playcall', 3000, 'fresh playcall');
    assert.deepEqual(st.s.score, [0, 0]);
    assert.equal(st.s.quarter, 1);
    assert.equal(st.s.possession, 0);
    assert.equal(st.s.down, 1);
    assert.equal(st.s.ballOn, 25);
    assert.equal(st.s.paused, false);
    assert.ok(st.s.clock > QUARTER - 1, 'clock reset to quarterLength');
  });

  test('mid-game disconnect pauses; rejoin keeps score and unpauses', async () => {
    botA.enabled = true; botB.enabled = true;
    a.clear();
    // play the rematch until someone scores (or we reach the 2nd half)
    const mid = await a.wait((m) => m.type === 'state' && m.s.phase === 'result' &&
      (m.s.score[0] + m.s.score[1] > 0 || m.s.quarter >= 3), 60000, 'scored or 2nd half');
    botB.enabled = false;
    await b.close();
    await a.wait('opponent_left');
    const p1 = await a.wait((m) => m.type === 'state' && m.s.paused === true, 2000, 'paused state');
    await sleep(150); // > 1 sim-second at this time scale
    const p2 = await a.wait((m) => m.type === 'state' && m.s.paused === true, 2000, 'still paused');
    assert.deepEqual(p2.s.score, p1.s.score);
    assert.equal(p2.s.clock, p1.s.clock, 'clock frozen while paused');
    assert.equal(p2.s.phase, p1.s.phase);
    assert.equal(p2.s.phaseTime, p1.s.phaseTime, 'phase timer frozen while paused');
    assert.ok(p1.s.score[0] + p1.s.score[1] >= mid.s.score[0] + mid.s.score[1]);

    b = await client(srv.port);
    b.send({ type: 'rejoin', code, token: tokenB });
    const rj = await b.wait('rejoined');
    assert.equal(rj.team, 1);
    const stB = await b.wait('start');
    assert.equal(stB.team, 1);
    await a.wait('opponent_back');
    const back = await b.wait((m) => m.type === 'state' && m.s.paused === false, 2000, 'unpaused');
    assert.deepEqual(back.s.score, p2.s.score, 'score kept across rejoin');
    assert.equal(back.s.quarter, p2.s.quarter);
    // the game keeps running after the rejoin
    await b.wait((m) => m.type === 'state' && m.s.phase !== back.s.phase, 5000, 'game progresses');
    assert.deepEqual(consoleCap.seen, [], 'server logged errors');
  });
});

/** Start a server whose sockets/timers are always torn down, even if the test fails. */
async function scopedServer(t, opts) {
  const srv = await start(0, Object.assign({ host: '127.0.0.1' }, opts));
  t.after(() => srv.close());
  return srv;
}

describe('online: real-time rate and hardening', () => {
  test('state messages arrive at ~20Hz in real time', async (t) => {
    const srv = await scopedServer(t);
    const { a, b } = await pair(srv.port);
    await a.wait('state');
    const t0 = Date.now();
    let n = 0;
    a.onMsg((m) => { if (m.type === 'state') n++; });
    await sleep(1000);
    const hz = n / ((Date.now() - t0) / 1000);
    assert.ok(hz >= 16 && hz <= 23, 'got ' + hz.toFixed(1) + ' Hz');
    await a.close(); await b.close(); await srv.close();
  });

  test('input flood is rate-limited per socket and the other player is unaffected', async (t) => {
    const counts = [0, 0];
    const sim = require('./fixtures/fake-sim.js');
    const counting = Object.assign({}, sim, {
      input(g, team, msg) { counts[team]++; return sim.input(g, team, msg); },
    });
    const srv = await scopedServer(t, { sim: counting });
    const { a, b } = await pair(srv.port);
    for (let i = 0; i < 1000; i++) a.send({ type: 'input', msg: { t: 'move', x: i, y: 1 } });
    await sleep(100);
    for (let i = 0; i < 5; i++) b.send({ type: 'input', msg: { t: 'pick', play: 'zone' } });
    await sleep(200);
    assert.ok(counts[0] <= 80, 'flood should be capped near the burst size, got ' + counts[0]);
    assert.ok(counts[0] >= 30, 'normal burst allowed, got ' + counts[0]);
    assert.equal(counts[1], 5, 'other socket unaffected');
    // a socket that keeps flooding way past the limit is dropped
    const closed = new Promise((r) => a.ws.once('close', r));
    for (let i = 0; i < 3000; i++) a.send({ type: 'ping', t: i });
    await closed;
    const st = await b.wait('opponent_left', 2000);
    assert.ok(st);
    assert.equal(srv.stats().bindings, 1);
    await b.close(); await srv.close();
  });

  test('malicious inputs cannot drive the other team (real sim)', async (t) => {
    const srv = await scopedServer(t);
    const { a, b, code } = await pair(srv.port);
    const room = srv.rooms.get(code);
    const g = room.game;
    // defense (team 1) tries offense-only actions and offense picks
    b.send({ type: 'input', msg: { t: 'pick', play: 'punt' } });
    b.send({ type: 'input', msg: { t: 'pick', play: 'slant' } });
    a.send({ type: 'input', msg: { t: 'select', id: 'CB1' } });
    a.send({ type: 'input', msg: { t: 'pick', play: 'zone' } });
    await sleep(80);
    assert.deepEqual(g.picks, [null, null]);
    assert.equal(g.userDefenderId, 'S1');
    a.send({ type: 'input', msg: { t: 'pick', play: 'slant' } });
    b.send({ type: 'input', msg: { t: 'pick', play: 'man' } });
    await a.wait((m) => m.type === 'state' && m.s.phase === 'live', 3000, 'live');
    const qb = g.players.find((p) => p.id === 'QB');
    b.send({ type: 'input', msg: { t: 'throw', x: 60, y: 10 } });
    b.send({ type: 'input', msg: { t: 'juke' } });
    b.send({ type: 'input', msg: { t: 'move', x: 0, y: 0 } }); // moves b's own S1 only
    b.send({ type: 'input', msg: { t: 'move', x: NaN, y: 1e309 } });
    b.send('{"type":"input","msg":{"t":"move","x":1e999,"y":-1e999}}');
    b.send({ type: 'input', msg: { t: 'select', id: 'QB' } });
    b.send({ type: 'input', msg: { t: 'select', id: '__proto__' } });
    await sleep(80);
    assert.equal(g.ball.holder === 'QB' || g.phase !== 'live', true, 'defense cannot throw');
    assert.equal(qb.hasTarget, false, 'defense cannot steer the QB');
    assert.equal(qb.jukeT, 0, 'defense cannot juke the carrier');
    assert.equal(g.userDefenderId, 'S1');
    assert.equal(g.players.find((p) => p.id === 'S1').tx, 0);
    await a.close(); await b.close(); await srv.close();
  });

  test('ended rooms are cleaned up (no leaks)', async (t) => {
    const srv = await scopedServer(t, { roomTtlMs: 150 });
    for (let i = 0; i < 5; i++) {
      const { a, b } = await pair(srv.port);
      await a.close(); await b.close();
    }
    // waiting-room host that disconnects
    const h = await client(srv.port);
    h.send({ type: 'create' });
    await h.wait('created');
    await h.close();
    await sleep(100);
    assert.equal(srv.stats().bindings, 0, 'no socket bindings left');
    await sleep(300);
    assert.equal(srv.stats().rooms, 0, 'expired rooms deleted');
    await srv.close();
  });

  test('room cap refuses new rooms', async (t) => {
    const srv = await scopedServer(t, { maxRooms: 1 });
    const a = await client(srv.port);
    const b = await client(srv.port);
    a.send({ type: 'create' });
    await a.wait('created');
    b.send({ type: 'create' });
    const e = await b.wait('error');
    assert.equal(e.reason, 'server_full');
    await a.close(); await b.close(); await srv.close();
  });
});

test('rejoin with a multi-byte token of matching length is rejected without a server error', async (t) => {
  const cap = captureConsoleErrors();
  t.after(() => cap.restore());
  const srv = await start(0, { host: '127.0.0.1' });
  t.after(() => srv.close());
  const { a, b, code } = await pair(srv.port);
  const c = await client(srv.port);
  c.send({ type: 'rejoin', code, token: 'é'.repeat(32) });
  const e = await c.wait('error');
  assert.equal(e.reason, 'bad_token');
  assert.deepEqual(cap.seen, []);
  await a.close(); await b.close(); await c.close();
});
