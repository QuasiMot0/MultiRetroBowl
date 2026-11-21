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
  for (const play of ['slant', 'stick', 'mesh', 'deep', 'post', 'flood', 'screen', 'tunnel', 'swing']) {
    const g = setup(play);
    assert.deepEqual(Sim.routePreview(Sim.snapshot(g)), [], 'no play preview before the call is revealed');
    Sim.step(g, DT);
    const paths = Sim.routePreview(Sim.snapshot(g));
    assert.ok(paths.some((path) => path.kind === 'pass'));
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

test('playcall diagrams show all receiver and defender assignments without revealing either pick', () => {
  for (const { id, fourthOnly } of Sim.OFFENSE_PLAYS) {
    if (fourthOnly) continue;
    const g = setup(id);
    const s = Sim.snapshot(g);
    const diagram = Sim.playPreview(s, id);
    assert.equal(s.offPlay, null);
    assert.deepEqual(diagram.map((path) => path.id), ['RB', 'WR1', 'WR2', 'TE']);
    Sim.step(g, DT);
    for (const route of Sim.routePreview(Sim.snapshot(g))) {
      assert.deepEqual(route, diagram.find((path) => path.id === route.id));
    }
  }

  for (const { id } of Sim.DEFENSE_PLAYS) {
    const g = Sim.createGame({ seed: 42 });
    Sim.input(g, 0, { t: 'pick', play: 'slant' });
    Sim.input(g, 1, { t: 'pick', play: id });
    const s = Sim.snapshot(g);
    const diagram = Sim.playPreview(s, id);
    assert.equal(s.defPlay, null);
    assert.equal(diagram.length, 7);
    Sim.step(g, DT);
    snapBall(g);
    for (const { id, kind, target, points, radius } of diagram) {
      const defender = g.players.find((p) => p.id === id);
      assert.equal(kind, defender.job);
      if (kind === 'man') assert.equal(target, defender.manId);
      if (kind === 'zone') {
        assert.deepEqual(points[1], { x: defender.zx, y: defender.zy });
        assert.equal(radius, defender.zr);
      }
    }
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
