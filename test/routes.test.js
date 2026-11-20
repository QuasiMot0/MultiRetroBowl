'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Sim = require('../shared/sim.js');

const DT = 1 / 30;

function setup(play) {
  const g = Sim.createGame({ humans: [true, true], seed: 42 });
  Sim.input(g, 0, { t: 'pick', play });
  Sim.input(g, 1, { t: 'pick', play: 'zone' });
  return g;
}

function snapBall(g) {
  for (let i = 0; i < 40 && g.phase === 'presnap'; i++) Sim.step(g, DT);
  assert.equal(g.phase, 'live');
}

test('pass play previews use the receivers’ actual assignments before and after the snap', () => {
  for (const play of ['slant', 'screen', 'deep']) {
    const g = setup(play);
    assert.deepEqual(Sim.routePreview(Sim.snapshot(g)), [], 'no play preview before the call is revealed');
    Sim.step(g, DT);
    const paths = Sim.routePreview(Sim.snapshot(g));
    assert.ok(paths.length >= 3);
    snapBall(g);
    assert.deepEqual(Sim.routePreview(Sim.snapshot(g)), paths);
    for (const { id, points } of paths) {
      const p = g.players.find((player) => player.id === id);
      assert.deepEqual(points.slice(1, 1 + p.route.length), p.route);
    }
    Sim.input(g, 0, { t: 'throw', x: 45, y: 20 });
    assert.deepEqual(Sim.routePreview(Sim.snapshot(g)), [], 'hide assignments once the QB releases the ball');
  }
});

test('run preview guides the RB to the called lane, then clears past the hole', () => {
  const g = setup('run');
  Sim.step(g, DT);
  const s = Sim.snapshot(g);
  const route = Sim.routePreview(s).find((path) => path.kind === 'run');
  assert.equal(route.id, 'RB');
  assert.equal(Math.sign(route.points[0].y - Sim.FIELD_WIDTH / 2), Math.sign(s.runHoleY - Sim.FIELD_WIDTH / 2));
  assert.equal(route.points.at(-1).y, s.runHoleY);
  assert.ok(Math.abs(s.runHoleY - g.runHoleY) < 0.01);
  snapBall(g);
  assert.ok(Math.abs(g.players.find((p) => p.id === 'RB').y - route.points[0].y) < 0.3);
  assert.equal(Sim.snapshot(g).runHoleY, s.runHoleY, 'the lane stays fixed at the snap');

  for (let i = 0; i < 15 && !g.handedOff; i++) Sim.step(g, DT);
  const carry = Sim.snapshot(g);
  assert.equal(carry.ball.holder, 'RB');
  assert.deepEqual(Sim.routePreview(carry).find((path) => path.kind === 'run'), route);
  carry.ball.x = route.points.at(-1).x;
  assert.deepEqual(Sim.routePreview(carry), []);
});
