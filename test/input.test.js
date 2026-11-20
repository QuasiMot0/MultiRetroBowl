const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const GridSim = require('../shared/sim.js');

const source = fs.readFileSync(path.join(__dirname, '../public/js/input.js'), 'utf8');

function controls({ mobile = false } = {}) {
  const canvas = new EventTarget();
  const stick = new EventTarget();
  const window = new EventTarget();
  window.GridSim = GridSim;
  const captured = new Set();
  const messages = [];
  let now = 100;
  const qb = { id: 'QB', side: 'off', x: 30, y: 25 };
  const lb = { id: 'LB', side: 'def', x: 40, y: 25 };
  const safety = { id: 'S1', side: 'def', x: 48, y: 25 };
  const view = {
    phase: 'live', possession: 0, canThrow: true, controlledOffId: 'QB', userDefenderId: 'LB',
    players: [qb, lb, safety], ball: { state: 'held', holder: 'QB', x: qb.x, y: qb.y }
  };
  for (const surface of [canvas, stick]) {
    surface.setPointerCapture = (id) => captured.add(id);
    surface.releasePointerCapture = (id) => {
      if (captured.delete(id)) emit(surface, 'lostpointercapture', { pointerId: id });
    };
  }
  stick.firstElementChild = { style: {} };
  stick.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  window.matchMedia = () => ({ matches: mobile });
  vm.runInNewContext(source, {
    window, document: { getElementById: (id) => id === 'moveStick' ? stick : null }, performance: { now: () => now },
    Render: { screenToField(x, y, out) { out.x = x; out.y = y; }, pxPerYard: () => 1 }
  });
  const input = window.Input;
  input.init(canvas, { getView: () => view, myTeam: () => 0, send: (m) => messages.push({ ...m }) });
  return {
    input, view, qb, lb, safety, captured, messages,
    tick() { input.update(now += 55); },
    pointer(type, id, x, y, pointerType = 'touch') {
      emit(canvas, type, { pointerId: id, clientX: x, clientY: y, pointerType, button: 0, isPrimary: id === 1 });
    },
    stick(type, id, x, y) {
      emit(stick, type, { pointerId: id, clientX: x, clientY: y, pointerType: 'touch', button: 0 });
    },
    key(type, code, extra = {}) { return emit(window, type, { code, ...extra }); },
    blur() { emit(window, 'blur'); }
  };
}

function emit(target, type, fields = {}) {
  const e = Object.assign(new Event(type, { cancelable: true }), fields);
  target.dispatchEvent(e);
  return e;
}

test('a second touch throws while the first touch keeps steering', () => {
  const c = controls();
  c.pointer('pointerdown', 1, 30, 25);
  c.pointer('pointerdown', 2, 32, 25);
  c.pointer('pointermove', 1, 26, 25);
  c.pointer('pointermove', 2, 26, 25);
  c.tick();
  assert.equal(c.input.steer.active, true);
  assert.equal(c.input.aim.valid, true);
  assert.deepEqual(c.messages, [{ t: 'move', x: 26, y: 23.7 }]);
  c.pointer('pointerup', 2, 26, 25);
  assert.deepEqual(c.messages.at(-1), { t: 'throw', x: 43.2, y: 25 });
  c.pointer('pointermove', 1, 24, 25);
  c.tick();
  assert.deepEqual(c.messages.at(-1), { t: 'move', x: 24, y: 23.7 });
  c.pointer('pointerup', 1, 24, 25);
  assert.deepEqual(c.messages.map((m) => m.t), ['move', 'throw', 'move', 'stop']);
  assert.equal(c.captured.size, 0);
});

test('a mobile thumbstick sends proportional speed while a second touch aims and throws', () => {
  const c = controls({ mobile: true });
  c.view.phase = 'presnap';
  c.stick('pointerdown', 1, 50, 50);
  c.pointer('pointerdown', 2, 30, 25); // even a touch on the QB starts an aim
  c.tick();
  assert.deepEqual(c.messages, []);
  c.view.phase = 'live';
  c.tick();
  assert.deepEqual(c.messages.at(-1), { t: 'move', x: 30, y: 25, speed: 0 });
  c.stick('pointermove', 1, 31, 50);
  c.pointer('pointermove', 2, 24, 25);
  c.tick();
  assert.deepEqual(c.messages.at(-1), { t: 'move', x: 22, y: 25, speed: 0.5 });
  assert.equal(c.input.aim.valid, true);
  c.pointer('pointerup', 2, 24, 25);
  assert.equal(c.messages.at(-1).t, 'throw');
  c.stick('pointermove', 1, 0, 50);
  c.tick();
  assert.deepEqual(c.messages.at(-1), { t: 'move', x: 22, y: 25, speed: 1 });
  c.stick('pointercancel', 1, 0, 50);
  assert.equal(c.messages.at(-1).t, 'stop');
  assert.equal(c.captured.size, 0);
});

test('aim-first touch stays live when the steering touch is lifted', () => {
  const c = controls();
  c.pointer('pointerdown', 1, 42, 25);
  c.pointer('pointerdown', 2, 20, 25);
  c.pointer('pointerdown', 3, 22, 25);
  c.pointer('pointermove', 1, 37, 25);
  c.tick();
  assert.deepEqual([...c.captured], [1, 2]);
  c.pointer('pointerup', 2, 20, 25);
  assert.equal(c.input.aim.active, true);
  c.pointer('pointerup', 1, 37, 25);
  assert.deepEqual(c.messages.map((m) => m.t), ['move', 'stop', 'throw']);
});

test('two touches already held at the snap can steer and aim immediately', () => {
  const c = controls();
  c.view.phase = 'presnap';
  c.pointer('pointerdown', 1, 30, 25);
  c.pointer('pointerdown', 2, 42, 25);
  c.tick();
  assert.deepEqual(c.messages, []);
  assert.deepEqual([...c.captured], [1, 2]);
  c.view.phase = 'live';
  c.tick();
  c.pointer('pointermove', 1, 26, 25);
  c.pointer('pointermove', 2, 37, 25);
  c.tick();
  assert.equal(c.input.steer.active, true);
  assert.equal(c.input.aim.valid, true);
  c.pointer('pointerup', 2, 37, 25);
  assert.deepEqual(c.messages.map((m) => m.t), ['move', 'move', 'throw']);
});

test('WASD steers at equal diagonal distance while the mouse aims and releases', () => {
  const c = controls();
  assert.equal(c.key('keydown', 'KeyW').defaultPrevented, true);
  c.key('keydown', 'KeyA');
  c.pointer('pointerdown', 1, 30, 25, 'mouse');
  c.pointer('pointermove', 1, 23, 25, 'mouse');
  c.tick();
  assert.deepEqual(c.messages[0], { t: 'move', x: 24.34, y: 19.34 });
  assert.equal(c.input.aim.active, true);
  c.pointer('pointerup', 1, 23, 25, 'mouse');
  c.key('keyup', 'KeyA');
  c.tick();
  assert.deepEqual(c.messages.at(-1), { t: 'move', x: 30, y: 17 });
  c.key('keyup', 'KeyW');
  assert.deepEqual(c.messages.map((m) => m.t), ['move', 'throw', 'move', 'stop']);
});

test('S steers a defender down and Shift switches the WASD target', () => {
  const c = controls();
  c.view.possession = 1;
  c.key('keydown', 'KeyS', { key: 's' });
  c.tick();
  assert.deepEqual(c.messages, [{ t: 'move', x: 40, y: 33 }]);
  c.key('keydown', 'ShiftLeft', { key: 'Shift' });
  c.tick();
  assert.deepEqual(c.messages.at(-1), { t: 'select', id: 'S1' });
  assert.equal(c.input.steer.active, false);
  c.view.userDefenderId = c.safety.id;
  c.tick();
  assert.deepEqual(c.messages.at(-1), { t: 'move', x: 48, y: 33 });
});

test('pointer cancellation, blur, and phase changes clear input safely', () => {
  const c = controls();
  c.key('keydown', 'KeyD');
  c.pointer('pointerdown', 1, 40, 25);
  c.pointer('pointermove', 1, 34, 25);
  c.tick();
  c.pointer('pointercancel', 1, 34, 25);
  assert.equal(c.input.steer.active, true);
  c.pointer('pointerdown', 2, 40, 25);
  c.pointer('pointermove', 2, 34, 25);
  c.blur();
  c.key('keydown', 'KeyD', { repeat: true });
  c.tick();
  assert.deepEqual(c.messages.map((m) => m.t), ['move', 'stop']);
  assert.equal(c.captured.size, 0);
  c.key('keydown', 'KeyA');
  c.pointer('pointerdown', 3, 40, 25);
  c.pointer('pointermove', 3, 34, 25);
  c.tick();
  c.view.phase = 'result';
  c.tick();
  c.view.phase = 'live';
  c.pointer('pointerup', 3, 34, 25);
  c.tick();
  assert.deepEqual(c.messages.map((m) => m.t), ['move', 'stop', 'move']);
  assert.equal(c.captured.size, 0);
});

test('aim cancels after the QB crosses the line, while touch steering survives the handoff', () => {
  const c = controls();
  c.pointer('pointerdown', 1, 30, 25);
  c.pointer('pointerdown', 2, 42, 25);
  c.pointer('pointermove', 2, 37, 25);
  c.tick();
  c.view.canThrow = false;
  c.tick();
  c.pointer('pointerup', 2, 37, 25);
  assert.equal(c.input.aim.active, false);
  assert.deepEqual([...c.captured], [1]);
  const rb = { id: 'RB', side: 'off', x: 30, y: 22 };
  c.view.players.push(rb);
  c.view.ball.holder = c.view.controlledOffId = 'RB';
  c.tick();
  assert.equal(c.input.steer.id, 'RB');
  assert.deepEqual(c.messages.map((m) => m.t), ['move', 'move']);
});
