'use strict';
/**
 * Gameplay sanity from a human's point of view: scripted "humans" using only the
 * public input API must be able to complete passes to open receivers, gain yards
 * running toward daylight, and tackle a carrier they run onto.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../shared/sim.js');

const DT = 1 / 30;
const P = (g, id) => g.players.find((p) => p.id === id);
const defs = (g) => g.players.filter((p) => p.side === 'def');
function until(g, f, cap = 20000) { for (let i = 0; i < cap && !f(g); i++) S.step(g, DT); return f(g); }

/** Yards gained by team 0 on the play that just ended (TD counts to the goal line). */
function gainOf(g, startBallOn, events) {
  if (events.includes('td')) return 100 - startBallOn;
  const p = g.pending;
  return (p.possession === 0 ? p.ballOn : 100 - p.ballOn) - startBallOn;
}

test('human QB: a well-aimed throw to an open receiver usually completes', () => {
  const tally = { catch: 0, int: 0, inc: 0 };
  let n = 0;
  const plays = ['slant', 'screen', 'deep'];
  const covs = ['man', 'zone', 'blitz'];
  for (let i = 0; i < 45; i++) {
    const g = S.createGame({ humans: [true, true], seed: 1000 + i * 37 });
    const play = plays[i % 3], cov = covs[Math.floor(i / 3) % 3];
    S.input(g, 0, { t: 'pick', play });
    S.input(g, 1, { t: 'pick', play: cov });
    until(g, (x) => x.phase === 'live');
    // a human gets rid of it quickly against the blitz
    const at = cov === 'blitz' ? 0.8 : (play === 'deep' ? 1.8 : 1.3);
    until(g, (x) => x.phase !== 'live' || x.liveT >= at);
    if (g.phase !== 'live' || g.ball.holder !== 'QB') continue;
    const qb = P(g, 'QB');
    let best = null;
    for (const id of ['WR1', 'WR2', 'TE', 'RB']) {
      const r = P(g, id);
      let open = Infinity;
      for (const d of defs(g)) open = Math.min(open, Math.hypot(d.x - r.x, d.y - r.y));
      if (!best || open > best.open) best = { r, open };
    }
    if (best.open < 2.5) continue; // nobody open: a human would hold it
    const T = S.passFlightTime(Math.hypot(best.r.x - qb.x, best.r.y - qb.y));
    S.input(g, 0, { t: 'throw', x: best.r.x + best.r.vx * T, y: best.r.y + best.r.vy * T });
    assert.equal(g.ball.state, 'air');
    S.snapshot(g);
    const ev = [];
    while (g.phase === 'live' && g.ball.state === 'air') { S.step(g, DT); ev.push(...S.snapshot(g).events); }
    n++;
    tally[ev.includes('catch') ? 'catch' : ev.includes('int') ? 'int' : 'inc']++;
  }
  assert.ok(n >= 30, 'enough open-receiver throws: ' + n);
  assert.ok(tally.catch / n >= 0.75, 'completion rate to open receivers: ' + JSON.stringify(tally));
  assert.ok(tally.int / n <= 0.1, 'open throws rarely picked: ' + JSON.stringify(tally));
});

test('human QB: throwing into tight man coverage is risky', () => {
  // throw at the spot of the defender shadowing a receiver before the receiver breaks open
  const cases = [['deep', 'CB1', 0.9], ['slant', 'LB', 1.2]];
  let ints = 0, n = 0;
  for (let i = 0; i < 40; i++) {
    const [play, cover, at] = cases[i % 2];
    const g = S.createGame({ humans: [true, true], seed: 500 + i });
    S.input(g, 0, { t: 'pick', play });
    S.input(g, 1, { t: 'pick', play: 'man' });
    until(g, (x) => x.phase === 'live');
    until(g, (x) => x.phase !== 'live' || x.liveT >= at);
    if (g.phase !== 'live' || g.ball.holder !== 'QB') continue;
    const d = P(g, cover), qb = P(g, 'QB');
    const T = S.passFlightTime(Math.hypot(d.x - qb.x, d.y - qb.y));
    S.input(g, 0, { t: 'throw', x: d.x + d.vx * T, y: d.y + d.vy * T });
    S.snapshot(g);
    const ev = [];
    while (g.phase === 'live' && g.ball.state === 'air') { S.step(g, DT); ev.push(...S.snapshot(g).events); }
    n++;
    if (ev.includes('int')) ints++;
  }
  assert.ok(n >= 30);
  assert.ok(ints / n >= 0.25, `throws into coverage should get picked sometimes (${ints}/${n})`);
  assert.ok(ints / n <= 0.8, `but not always (${ints}/${n})`);
});

test('human RB: steering toward open space gains yards on average', () => {
  const gains = [];
  for (let i = 0; i < 60; i++) {
    const g = S.createGame({ humans: [true, true], seed: 7000 + i * 13 });
    S.input(g, 0, { t: 'pick', play: 'run' });
    S.input(g, 1, { t: 'pick', play: ['man', 'zone', 'blitz'][i % 3] });
    until(g, (x) => x.phase === 'live');
    const start = g.ballOn;
    let k = 0;
    while (g.phase === 'live') {
      if (g.ball.holder === 'RB' && k++ % 3 === 0) {
        // like a thumb on the screen: aim 8 yards ahead at the widest lane
        const rb = P(g, 'RB');
        let best = null;
        for (let a = -60; a <= 60; a += 15) {
          const r = a * Math.PI / 180, dx = Math.cos(r), dy = Math.sin(r);
          let lane = Infinity;
          for (const d of defs(g)) {
            const px = d.x - rb.x, py = d.y - rb.y;
            const u = Math.max(0, Math.min(8, px * dx + py * dy));
            lane = Math.min(lane, Math.hypot(px - u * dx, py - u * dy));
          }
          const ey = rb.y + dy * 8;
          const score = Math.min(lane, 6) + dx * 1.5 - (ey < 2 || ey > 51 ? 5 : 0);
          if (!best || score > best.score) best = { score, dx, dy };
        }
        S.input(g, 0, { t: 'move', x: rb.x + best.dx * 8, y: rb.y + best.dy * 8 });
        const near = Math.min(...defs(g).map((d) => Math.hypot(d.x - rb.x, d.y - rb.y)));
        if (near < 2) S.input(g, 0, { t: 'juke' });
      }
      S.step(g, DT);
    }
    gains.push(gainOf(g, start, S.snapshot(g).events));
  }
  const avg = gains.reduce((a, b) => a + b, 0) / gains.length;
  const positive = gains.filter((x) => x > 0).length / gains.length;
  assert.ok(avg >= 2.5, 'average gain ' + avg.toFixed(2));
  assert.ok(positive >= 0.6, 'share of positive runs ' + positive.toFixed(2));
  // but the defense still stops most runs short of a touchdown
  assert.ok(gains.filter((x) => x >= 75 - 1).length / gains.length < 0.4, 'not a TD every time');
});

test('human defender: running onto the carrier makes the tackle', () => {
  let n = 0, tackles = 0, byUser = 0, tds = 0;
  for (let i = 0; i < 60; i++) {
    const g = S.createGame({ humans: [false, true], seed: 300 + i * 7 });
    g.picks[0] = 'run'; // CPU offense: force the run for a controlled scenario
    S.input(g, 1, { t: 'pick', play: ['zone', 'man'][i % 2] });
    until(g, (x) => x.phase === 'live');
    S.input(g, 1, { t: 'select', id: i % 3 === 0 ? 'CB1' : 'LB' });
    let last = null;
    while (g.phase === 'live') {
      const c = g.ball.state === 'held' ? P(g, g.ball.holder) : null;
      const me = P(g, g.userDefenderId);
      if (c && c.id === 'RB') {
        const T = Math.min(0.6, Math.hypot(c.x - me.x, c.y - me.y) / 7);
        S.input(g, 1, { t: 'move', x: c.x + c.vx * T, y: c.y + c.vy * T });
        last = c;
      }
      S.step(g, DT);
    }
    const ev = S.snapshot(g).events;
    n++;
    if (ev.includes('td')) tds++;
    if (ev.includes('tackle') && last) {
      tackles++;
      const me = P(g, g.userDefenderId);
      if (Math.hypot(me.x - last.x, me.y - last.y) < 0.95) byUser++;
    }
  }
  assert.ok(tackles / n >= 0.85, `runs end in tackles (${tackles}/${n})`);
  assert.ok(tds / n <= 0.05, `defense rarely gives up a TD on a run (${tds}/${n})`);
  assert.ok(byUser / tackles >= 0.25, `the human defender makes a fair share of the tackles (${byUser}/${tackles})`);
});

test('human defender: contact with a non-juking carrier is always a tackle', () => {
  // human offense RB runs straight upfield; human defender S1 steers straight at him
  let checked = 0;
  for (let i = 0; i < 20; i++) {
    const g = S.createGame({ humans: [true, true], seed: 90 + i });
    S.input(g, 0, { t: 'pick', play: 'run' });
    S.input(g, 1, { t: 'pick', play: 'zone' });
    until(g, (x) => x.phase === 'live');
    while (g.phase === 'live') {
      const c = g.ball.state === 'held' ? P(g, g.ball.holder) : null;
      if (c && c.id === 'RB') S.input(g, 1, { t: 'move', x: c.x, y: c.y });
      S.step(g, DT);
      if (g.phase === 'live' && c && c.id === 'RB' && c.jukeT <= 0) {
        for (const d of defs(g)) assert.ok(Math.hypot(d.x - c.x, d.y - c.y) >= 0.9, 'defender in contact but no tackle');
        checked++;
      }
    }
  }
  assert.ok(checked > 50);
});

test('human QB: the blitz leaves time for a hot throw, and more when dropping back', () => {
  for (const drop of [false, true]) {
    let minBlitz = Infinity, maxBlitz = 0, minMan = Infinity;
    for (const defense of ['blitz', 'man']) {
      for (let i = 0; i < 10; i++) {
        const g = S.createGame({ humans: [true, true], seed: 40 + i });
        S.input(g, 0, { t: 'pick', play: 'slant' });
        S.input(g, 1, { t: 'pick', play: defense });
        until(g, (x) => x.phase === 'live');
        if (drop) S.input(g, 0, { t: 'move', x: 10 + g.ballOn - 9, y: 26.65 });
        until(g, (x) => x.phase !== 'live');
        assert.ok(g.events.includes('sack'));
        if (defense === 'blitz') {
          minBlitz = Math.min(minBlitz, g.liveT);
          maxBlitz = Math.max(maxBlitz, g.liveT);
        } else {
          minMan = Math.min(minMan, g.liveT);
        }
      }
    }
    assert.ok(minBlitz >= (drop ? 2.25 : 1.5), `QB sacked after only ${minBlitz.toFixed(2)}s`);
    assert.ok(maxBlitz < minMan, 'blitz should still bring pressure sooner than man coverage');
  }
});

test('the QB glides to a stop and passes hang in the air', () => {
  const g = S.createGame({ humans: [true, true], seed: 40 });
  S.input(g, 0, { t: 'pick', play: 'slant' });
  S.input(g, 1, { t: 'pick', play: 'zone' });
  until(g, (x) => x.phase === 'live');
  const qb = P(g, 'QB');
  S.input(g, 0, { t: 'move', x: qb.x - 10, y: qb.y });
  for (let i = 0; i < 8; i++) S.step(g, DT);
  S.input(g, 0, { t: 'stop' });
  const x = qb.x;
  S.step(g, DT);
  assert.ok(qb.vx < -4.5, 'the first braking step retains most of the QB momentum');
  for (let i = 0; i < 8; i++) S.step(g, DT);
  assert.ok(Math.abs(qb.vx) < 0.01 && x - qb.x > 0.4, 'the QB settles after a short glide');

  // Throw from a stationary QB so the peak and range are easy to measure.
  const releaseX = qb.x;
  S.input(g, 0, { t: 'throw', x: releaseX + 23.5, y: qb.y });
  for (let i = 0; i < 15; i++) S.step(g, DT);
  assert.equal(g.ball.state, 'air');
  assert.ok(Math.abs(g.ball.x - (releaseX + 11.75)) < 0.1, 'the pass is halfway to the target after 0.5s');
  assert.ok(g.ball.z > 4.5, 'the pass uses a higher arc');
  assert.ok(Math.abs(g.ball.z - S.passHeight(23.5, 0.5)) < 0.01, 'the preview follows the live ball arc');
});
