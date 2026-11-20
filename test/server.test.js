'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const { start } = require('../server/index.js');
const fakeSim = require('./fixtures/fake-sim.js');

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const REAL_SIM = path.join(ROOT, 'shared', 'sim.js');
const REAL_INDEX = path.join(ROOT, 'public', 'index.html');

// ---------------------------------------------------------------- helpers

/** Raw GET (path is sent verbatim, no URL normalization). */
function get(port, rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** WebSocket client that buffers messages and can wait for one matching a predicate. */
function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const inbox = [];
    const waiters = [];
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch (e) { return; }
      inbox.push(m);
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
      send(obj) { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); },
      /** Wait for (and consume) the first buffered/future message matching pred. */
      wait(pred, ms = 2000, label = '') {
        if (typeof pred === 'string') { const type = pred; label = label || type; pred = (m) => m.type === type; }
        const idx = inbox.findIndex(pred);
        if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0]);
        return new Promise((res, rej) => {
          const w = { pred, resolve: res, timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1);
            rej(new Error('timeout waiting for ' + (label || pred.toString()) + '; inbox types: ' + inbox.map((m) => m.type).join(',')));
          }, ms) };
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Create a room with A, join with B, wait for both starts. */
async function pair(port) {
  const a = await client(port);
  const b = await client(port);
  a.send({ type: 'create', name: 'Alice' });
  const created = await a.wait('created');
  b.send({ type: 'join', code: created.code.toLowerCase(), name: 'Bob' });
  const joined = await b.wait('joined');
  const startA = await a.wait('start');
  const startB = await b.wait('start');
  return { a, b, created, joined, startA, startB };
}

// ---------------------------------------------------------------- static

describe('static files (fixture dirs)', () => {
  let srv;
  before(async () => {
    srv = await start(0, {
      sim: fakeSim, host: '127.0.0.1',
      publicDir: path.join(FIX, 'public'), sharedDir: path.join(FIX, 'shared'),
    });
  });
  after(() => srv.close());

  test('serves / as index.html with no-cache html', async () => {
    const r = await get(srv.port, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.match(r.headers['cache-control'], /no-store/);
    assert.match(r.body, /fixture/);
  });

  test('serves js, css and /shared/sim.js with correct types', async () => {
    const js = await get(srv.port, '/js/app.js?v=2');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /^text\/javascript/);
    const css = await get(srv.port, '/style.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /^text\/css/);
    const sim = await get(srv.port, '/shared/sim.js');
    assert.equal(sim.status, 200);
    assert.match(sim.headers['content-type'], /^text\/javascript/);
    const head = await get(srv.port, '/style.css', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  });

  test('404 for missing files and directories', async () => {
    assert.equal((await get(srv.port, '/nope.js')).status, 404);
    assert.equal((await get(srv.port, '/js')).status, 404);
    assert.equal((await get(srv.port, '/js/')).status, 404);
    assert.equal((await get(srv.port, '/shared/missing.js')).status, 404);
  });

  test('blocks directory traversal', async () => {
    const attempts = [
      '/../secret.txt',
      '/../../package.json',
      '/%2e%2e/secret.txt',
      '/%2E%2E/%2E%2E/package.json',
      '/js/..%2f..%2fsecret.txt',
      '/shared/../secret.txt',
      '/shared/%2e%2e/secret.txt',
      '/..%5csecret.txt',
      '/%00index.html',
      '/%E0%A4%A',
      '//etc/passwd',
    ];
    for (const p of attempts) {
      const r = await get(srv.port, p);
      assert.notEqual(r.status, 200, 'should not serve ' + p);
      assert.doesNotMatch(r.body, /SECRET|"name"|root:/, 'leaked content for ' + p);
    }
  });

  test('non-GET methods rejected; /health ok', async () => {
    assert.equal((await get(srv.port, '/', 'POST')).status, 405);
    const h = await get(srv.port, '/health');
    assert.equal(h.status, 200);
    assert.equal(h.body, 'ok');
  });
});

describe('static files (real project dirs)', () => {
  let srv;
  before(async () => { srv = await start(0, { sim: fakeSim, host: '127.0.0.1' }); });
  after(() => srv.close());

  test('/ serves public/index.html', { skip: !fs.existsSync(REAL_INDEX) && 'public/index.html missing' }, async () => {
    const r = await get(srv.port, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.equal(r.body, fs.readFileSync(REAL_INDEX, 'utf8'));
  });

  test('/shared/sim.js is served', { skip: !fs.existsSync(REAL_SIM) && 'shared/sim.js missing' }, async () => {
    const r = await get(srv.port, '/shared/sim.js');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/javascript/);
    assert.equal(r.body, fs.readFileSync(REAL_SIM, 'utf8'));
  });

  test('package.json and server source are not reachable', async () => {
    for (const p of ['/package.json', '/server/index.js', '/../package.json', '/shared/../server/index.js', '/%2e%2e/server/index.js']) {
      const r = await get(srv.port, p);
      assert.equal(r.status, 404, p);
    }
  });
});

// ---------------------------------------------------------------- websocket

describe('websocket rooms (fake sim)', () => {
  let srv;
  before(async () => { srv = await start(0, { sim: fakeSim, host: '127.0.0.1', roomTtlMs: 10000 }); });
  after(() => srv.close());

  test('create -> join -> both get start and state', async () => {
    const { a, b, created, joined, startA, startB } = await pair(srv.port);
    assert.match(created.code, /^[A-HJKMNP-Z]{4}$/);
    assert.equal(created.team, 0);
    assert.equal(typeof created.token, 'string');
    assert.equal(joined.code, created.code);
    assert.equal(joined.team, 1);
    assert.notEqual(joined.token, created.token);
    assert.equal(startA.team, 0);
    assert.equal(startB.team, 1);
    assert.deepEqual(startA.names, ['Alice', 'Bob']);
    const sa = await a.wait('state');
    const sb = await b.wait('state');
    assert.equal(sa.s.phase, 'playcall');
    assert.equal(sb.s.paused, false);
    assert.deepEqual(sa.s.teamNames, ['Alice', 'Bob']);
    // sim is stepping and states keep flowing (~20Hz)
    a.clear();
    await sleep(320);
    const states = a.inbox.filter((m) => m.type === 'state');
    assert.ok(states.length >= 4 && states.length <= 10, 'got ' + states.length + ' states in 320ms');
    assert.ok(states[states.length - 1].s.steps > 0);
    await a.close(); await b.close();
  });

  test('input is forwarded with the sender team; invalid inputs dropped', async () => {
    const { a, b } = await pair(srv.port);
    a.send({ type: 'input', msg: { t: 'pick', play: 'slant' } });
    b.send({ type: 'input', msg: { t: 'pick', play: 'zone', team: 0 } }); // team spoofing ignored
    b.send({ type: 'input', msg: { t: 5 } });
    b.send({ type: 'input', msg: 'pick' });
    b.send({ type: 'input', msg: ['pick'] });
    b.send({ type: 'input' });
    const st = await a.wait((m) => m.type === 'state' && m.s.inputs.length >= 2, 2000, 'state with inputs');
    assert.deepEqual(st.s.inputs, [
      { team: 0, t: 'pick', play: 'slant' },
      { team: 1, t: 'pick', play: 'zone' },
    ]);
    await sleep(100);
    const later = a.inbox.filter((m) => m.type === 'state').pop();
    assert.equal(later.s.inputs.length, 2, 'invalid inputs must not reach the sim');
    await a.close(); await b.close();
  });

  test('join errors: bad code and full room', async () => {
    const c = await client(srv.port);
    c.send({ type: 'join', code: 'ZZZZ', name: 'x' });
    const e1 = await c.wait('error');
    assert.match(e1.message, /not found/i);
    c.send({ type: 'join', code: 12345 });
    const e2 = await c.wait('error');
    assert.match(e2.message, /not found/i);

    const { a, b, created } = await pair(srv.port);
    c.send({ type: 'join', code: created.code, name: 'Third' });
    const e3 = await c.wait('error');
    assert.match(e3.message, /full/i);
    await a.close(); await b.close(); await c.close();
  });

  test('disconnect -> opponent_left + paused; rejoin -> opponent_back + unpaused', async () => {
    const { a, b, created, joined } = await pair(srv.port);
    await b.close();
    await a.wait('opponent_left');
    await a.wait((m) => m.type === 'state' && m.s.paused === true, 2000, 'paused state');
    const pausedSteps = a.inbox.filter((m) => m.type === 'state').pop();

    // bad token rejected
    const evil = await client(srv.port);
    evil.send({ type: 'rejoin', code: created.code, token: 'deadbeef' });
    assert.match((await evil.wait('error')).message, /token/i);
    await evil.close();

    // sim doesn't advance while paused
    await sleep(150);
    a.clear();
    const s1 = await a.wait('state');
    await sleep(150);
    const s2 = await a.wait((m) => m.type === 'state' && m !== s1);
    assert.equal(s2.s.steps, s1.s.steps, 'sim should not step while paused');
    void pausedSteps;

    const b2 = await client(srv.port);
    b2.send({ type: 'rejoin', code: created.code.toLowerCase(), token: joined.token });
    const rj = await b2.wait('rejoined');
    assert.equal(rj.team, 1);
    const st = await b2.wait('start');
    assert.equal(st.team, 1);
    await a.wait('opponent_back');
    await a.wait((m) => m.type === 'state' && m.s.paused === false, 2000, 'unpaused state');
    await b2.wait((m) => m.type === 'state' && m.s.paused === false, 2000, 'unpaused state b2');

    // rejoined socket still has team 1 for input
    b2.send({ type: 'input', msg: { t: 'stop' } });
    await a.wait((m) => m.type === 'state' && m.s.inputs.some((i) => i.team === 1 && i.t === 'stop'), 2000, 'b2 input');
    await a.close(); await b2.close();
  });

  test('host can rejoin a waiting room and the code is re-sent', async () => {
    const a = await client(srv.port);
    a.send({ type: 'create', name: 'Solo' });
    const created = await a.wait('created');
    await a.close();
    const a2 = await client(srv.port);
    a2.send({ type: 'rejoin', code: created.code, token: created.token });
    await a2.wait('rejoined');
    const again = await a2.wait('created');
    assert.equal(again.code, created.code);
    const b = await client(srv.port);
    b.send({ type: 'join', code: created.code, name: 'Late' });
    await b.wait('start');
    await a2.wait('start');
    await a2.close(); await b.close();
  });

  test('rematch only after both players request it during gameover', async () => {
    const { a, b } = await pair(srv.port);
    a.send({ type: 'rematch' }); // ignored: not gameover
    a.send({ type: 'input', msg: { t: 'debug_gameover' } });
    await a.wait((m) => m.type === 'state' && m.s.phase === 'gameover', 2000, 'gameover');
    a.send({ type: 'rematch' });
    await b.wait('rematch_requested');
    await sleep(80);
    assert.equal(a.inbox.filter((m) => m.type === 'state').pop().s.phase, 'gameover');
    b.send({ type: 'rematch' });
    const st = await a.wait((m) => m.type === 'state' && m.s.resets === 1, 2000, 'reset state');
    assert.equal(st.s.phase, 'playcall');
    assert.equal(st.s.paused, false);
    await a.close(); await b.close();
  });

  test('ping -> pong echoes t', async () => {
    const c = await client(srv.port);
    c.send({ type: 'ping', t: 1234.5 });
    const p = await c.wait('pong');
    assert.equal(p.t, 1234.5);
    await c.close();
  });

  test('garbage messages do not crash the server', async () => {
    const c = await client(srv.port);
    const junk = ['', 'not json', '{', 'null', '42', '"str"', '[]', '[1,2]', '{"type":5}', '{"type":"nope"}',
      '{"type":"input","msg":null}', '{"type":"input","msg":{"t":{"x":1}}}', '{"type":"join"}',
      '{"type":"rejoin"}', '{"type":"rejoin","code":"ABCD","token":{"a":1}}', '{"type":"create","name":{"x":1}}',
      '{"type":"__proto__"}', '{"type":"rematch"}', '{"type":"ping","t":{"evil":true}}'];
    for (const j of junk) c.send(j);
    c.ws.send(Buffer.from([0xff, 0x00, 0x13]), { binary: true });
    const p = await c.wait('pong');
    assert.equal(p.t, null);
    // a huge payload closes only that socket
    const big = await client(srv.port);
    const closed = new Promise((r) => big.ws.once('close', r));
    big.ws.send('x'.repeat(100 * 1024));
    await closed;
    // server still works
    c.send({ type: 'ping', t: 7 });
    assert.equal((await c.wait('pong')).t, 7);
    const { a, b } = await pair(srv.port);
    await a.wait('state');
    await a.close(); await b.close(); await c.close();
  });

  test('a socket creating a new room abandons its old waiting room', async () => {
    const c = await client(srv.port);
    c.send({ type: 'create' });
    const r1 = await c.wait('created');
    c.send({ type: 'create' });
    const r2 = await c.wait('created');
    assert.notEqual(r1.code, r2.code);
    assert.equal(srv.rooms.has(r1.code), false);
    assert.equal(srv.rooms.has(r2.code), true);
    await c.close();
  });
});

describe('room expiry (short TTL)', () => {
  let srv;
  before(async () => { srv = await start(0, { sim: fakeSim, host: '127.0.0.1', roomTtlMs: 300 }); });
  after(() => srv.close());

  test('room expires after TTL when a player stays away', async () => {
    const { a, b, created, joined } = await pair(srv.port);
    await b.close();
    await a.wait('opponent_left');
    const e = await a.wait('error', 2000);
    assert.match(e.message, /expired/i);
    assert.equal(srv.rooms.has(created.code), false);
    const b2 = await client(srv.port);
    b2.send({ type: 'rejoin', code: created.code, token: joined.token });
    assert.match((await b2.wait('error')).message, /not found/i);
    await a.close(); await b2.close();
  });

  test('rooms are deleted when everyone leaves (after TTL)', async () => {
    const { a, b, created } = await pair(srv.port);
    await a.close(); await b.close();
    await sleep(600);
    assert.equal(srv.rooms.has(created.code), false);
  });
});

describe('close()', () => {
  test('clears timers and closes open sockets', async () => {
    const srv = await start(0, { sim: fakeSim, host: '127.0.0.1' });
    const { a, b } = await pair(srv.port);
    const closedA = new Promise((r) => a.ws.once('close', r));
    const closedB = new Promise((r) => b.ws.once('close', r));
    await srv.close();
    await closedA; await closedB;
    assert.equal(srv.server.listening, false);
  });
});

describe('real shared/sim.js', { skip: !fs.existsSync(REAL_SIM) && 'shared/sim.js missing' }, () => {
  let srv;
  before(async () => { srv = await start(0, { host: '127.0.0.1' }); });
  after(() => srv?.close());

  test('online game runs with the real sim and inputs reach it', async () => {
    const { a, b } = await pair(srv.port);
    const st = await a.wait('state');
    assert.equal(st.s.phase, 'playcall');
    assert.deepEqual(st.s.teamNames, ['Alice', 'Bob']);
    assert.equal(st.s.paused, false);
    assert.ok(Array.isArray(st.s.players));
    // team 0 receives first -> on offense; team 1 is defense
    a.send({ type: 'input', msg: { t: 'pick', play: 'run' } });
    await a.wait((m) => m.type === 'state' && m.s.picked && m.s.picked[0] === true, 2000, 'picked[0]');
    b.send({ type: 'input', msg: { t: 'pick', play: 'zone' } });
    await b.wait((m) => m.type === 'state' && m.s.phase !== 'playcall', 3000, 'leave playcall');
    // disconnect pauses the real sim too
    await b.close();
    await a.wait('opponent_left');
    await a.wait((m) => m.type === 'state' && m.s.paused === true, 2000, 'paused');
    await a.close();
  });
});
