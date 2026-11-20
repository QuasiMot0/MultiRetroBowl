'use strict';
/**
 * Gridiron Duel server.
 *  - Static files from public/ (+ /shared/sim.js)
 *  - WebSocket rooms on /ws (same port), authoritative sim at 30Hz, state at 20Hz
 *
 * Usage: `npm start` (PORT env, default 3000, binds 0.0.0.0)
 * Tests: `const { start } = require('./server'); const srv = await start(0, { sim });`
 *   Extra options (see start()): quarterLength, timeScale (test-only fast-forward),
 *   inputRate / msgRate (per-socket flood limits), maxRooms, roomTtlMs.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const SIM_PATH = path.join(SHARED_DIR, 'sim.js');

const SIM_DT = 1 / 30;            // fixed sim step (s)
const SEND_DT = 1 / 20;           // state broadcast interval (s)
const LOOP_MS = 10;               // single shared loop granularity
const MAX_STEPS_PER_TICK = 6;     // avoid spiral of death after a stall
const ROOM_TTL_MS = 5 * 60 * 1000; // keep room this long for rejoin
const HEARTBEAT_MS = 15000;       // ws-level ping to detect dead phones
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O
const MAX_NAME = 12;
const INPUT_RATE = 60;            // game inputs per second per socket (token bucket, excess dropped)
const MSG_RATE = 120;             // any messages per second per socket (excess dropped)
const FLOOD_KILL_FACTOR = 10;     // > MSG_RATE * this in one second -> socket terminated
const MAX_ROOMS = 2000;           // refuse new rooms beyond this
const MAX_BUFFERED = 256 * 1024;  // skip state frames to a socket that isn't reading

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

/** Resolve a URL pathname to a file path inside an allowed root, or null. */
function resolveStatic(pathname, publicDir, sharedDir) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded === '/' || decoded === '') decoded = '/index.html';

  let root = publicDir;
  let rel = decoded;
  if (decoded.startsWith('/shared/')) {
    root = sharedDir;
    rel = decoded.slice('/shared'.length);
  }
  // Reject any dot-segments outright, then double-check containment.
  const parts = rel.split('/');
  if (parts.some((p) => p === '..' || p === '.')) return null;
  const file = path.resolve(root, '.' + path.posix.normalize(rel));
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

function sendText(res, status, text, extraHeaders) {
  res.writeHead(status, Object.assign({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }, extraHeaders || {}));
  res.end(text);
}

function makeRequestHandler(publicDir, sharedDir) {
  return function onRequest(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      return sendText(res, 400, 'Bad request');
    }
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      return sendText(res, 200, 'ok');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    const file = resolveStatic(url.pathname, publicDir, sharedDir);
    if (!file) return sendText(res, 404, 'Not found');

    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return sendText(res, 404, 'Not found');
      const ext = path.extname(file).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': st.size,
        // HTML never cached; other assets must revalidate so updates show up.
        'Cache-Control': ext === '.html' ? 'no-store, no-cache, must-revalidate' : 'no-cache',
        'Last-Modified': st.mtime.toUTCString(),
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanName(name, fallback) {
  if (typeof name !== 'string') return fallback;
  const s = name.replace(/[^\x20-\x7E]/g, '').trim().slice(0, MAX_NAME).trim();
  return s || fallback;
}

function cleanCode(code) {
  if (typeof code !== 'string') return '';
  return code.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    } catch (e) { /* socket going away */ }
  }
}

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (v4 && !a.internal) out.push(a.address);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Start the server.
 * @param {number} port 0 = random free port
 * @param {object} [opts]
 * @param {object} [opts.sim]        GridSim implementation (default: require('../shared/sim.js'))
 * @param {string} [opts.host]       bind address (default '0.0.0.0')
 * @param {number} [opts.roomTtlMs]  how long a room survives with a missing player (default 5 min)
 * @param {boolean} [opts.log]       log room events (default false)
 * @param {number} [opts.quarterLength] game-seconds per quarter for online games (default: sim default, 150)
 * @param {number} [opts.timeScale]  TEST-ONLY sim speed multiplier (default 1). The sim advances
 *        timeScale x wall time; state broadcasts happen every 1/20 s of *sim* time and the input
 *        rate limit is per sim-second, so a sped-up game looks the same to clients, just faster.
 * @param {number} [opts.inputRate]  max `input` messages per (sim-)second per socket (default 60)
 * @param {number} [opts.msgRate]    max messages of any type per (sim-)second per socket (default 120)
 * @param {number} [opts.maxRooms]   max simultaneous rooms (default 2000)
 * @returns {Promise<{server, wss, port, rooms, stats(), close(): Promise<void>}>}
 */
function start(port = 0, opts = {}) {
  const host = opts.host || '0.0.0.0';
  const roomTtlMs = opts.roomTtlMs != null ? opts.roomTtlMs : ROOM_TTL_MS;
  const log = opts.log ? (...a) => console.log('[gridiron]', ...a) : () => {};
  const publicDir = path.resolve(opts.publicDir || PUBLIC_DIR);
  const sharedDir = path.resolve(opts.sharedDir || SHARED_DIR);
  const posNum = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  const timeScale = posNum(opts.timeScale, 1);
  const quarterLength = posNum(opts.quarterLength, 150);
  const inputRate = posNum(opts.inputRate, INPUT_RATE) * timeScale;
  const msgRate = posNum(opts.msgRate, MSG_RATE) * timeScale;
  const maxRooms = posNum(opts.maxRooms, MAX_ROOMS);
  const maxSteps = Math.ceil(MAX_STEPS_PER_TICK * timeScale);

  let injectedSim = opts.sim || null;
  let loadedSim = null;
  function getSim() {
    if (injectedSim) return injectedSim;
    if (loadedSim) return loadedSim;
    try {
      loadedSim = require(SIM_PATH);
    } catch (e) {
      console.error('[gridiron] could not load shared/sim.js:', e.message);
      loadedSim = null;
    }
    return loadedSim;
  }

  /** code -> room */
  const rooms = new Map();
  /** ws -> { room, team } */
  const bindings = new Map();

  const server = http.createServer(makeRequestHandler(publicDir, sharedDir));
  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) { /* ignore */ }
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });

  // ---- rooms ---------------------------------------------------------------

  function makeCode() {
    for (let i = 0; i < 1000; i++) {
      let c = '';
      for (let j = 0; j < 4; j++) c += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
      if (!rooms.has(c)) return c;
    }
    throw new Error('no free room codes');
  }

  function otherTeam(t) { return t === 0 ? 1 : 0; }

  function connectedCount(room) {
    return room.players.filter((p) => p && p.ws).length;
  }

  function updateExpiry(room) {
    // a player who switched apps counts as missing too, so an abandoned room still expires
    const missing = room.players.some((p) => p && (!p.ws || p.away));
    room.expireAt = missing ? Date.now() + roomTtlMs : 0;
  }

  function deleteRoom(room, reason) {
    if (!rooms.has(room.code) || rooms.get(room.code) !== room) return;
    rooms.delete(room.code);
    for (const p of room.players) {
      if (p && p.ws) {
        bindings.delete(p.ws);
        if (reason) send(p.ws, { type: 'error', message: reason, reason: 'room_closed' });
      }
    }
    log('room', room.code, 'deleted', reason || '');
  }

  function snapshotNow(room) {
    if (!room.game) return;
    const sim = room.sim;
    let s;
    try {
      s = sim.snapshot(room.game);
    } catch (e) {
      console.error('[gridiron] snapshot error in room', room.code, e);
      return;
    }
    const msg = JSON.stringify({ type: 'state', s });
    for (const p of room.players) {
      // a client that stopped reading must not make the server buffer without bound
      if (p && p.ws && p.ws.bufferedAmount < MAX_BUFFERED) send(p.ws, msg);
    }
  }

  /** The game runs only while both seats are filled, connected and in the foreground. */
  function bothActive(room) {
    return room.players.every((p) => p && p.ws && !p.away);
  }

  function refreshPause(room) {
    if (!room.game) return;
    const paused = !bothActive(room);
    // Losing a connection can prevent the browser from releasing movement itself.
    if (paused && !room.game.paused && room.game.phase === 'live') {
      room.sim.input(room.game, 0, { t: 'stop' });
      room.sim.input(room.game, 1, { t: 'stop' });
    }
    room.game.paused = paused;
  }

  /** Tell `ws` why its opponent is missing (if they are). */
  function sendOpponentStatus(room, team, ws) {
    const other = room.players[otherTeam(team)];
    if (!other || !other.ws) send(ws, { type: 'opponent_left' });
    else if (other.away) send(ws, { type: 'opponent_left', reason: 'away' });
  }

  function startGame(room) {
    const sim = getSim();
    if (!sim) return false;
    room.sim = sim;
    room.game = sim.createGame({
      teamNames: [room.players[0].name, room.players[1].name],
      humans: [true, true],
      quarterLength,
      seed: crypto.randomInt(1, 2147483647),
    });
    refreshPause(room);
    room.simAcc = 0;
    room.sendAcc = 0;
    const names = [room.players[0].name, room.players[1].name];
    for (let t = 0; t < 2; t++) send(room.players[t].ws, { type: 'start', team: t, names });
    snapshotNow(room);
    log('room', room.code, 'started', names.join(' vs '));
    return true;
  }

  /** Detach a socket from its room (socket closed, or it started another room). */
  function leaveRoom(ws, intentional) {
    const b = bindings.get(ws);
    if (!b) return;
    bindings.delete(ws);
    const { room, team } = b;
    const p = room.players[team];
    if (!p || p.ws !== ws) return;
    p.ws = null;
    p.away = false;
    room.rematch = [false, false];
    if (!room.game) {
      // Left a room that never started. If the socket moved on to another
      // room, drop it; if it just disconnected, keep it for rejoin (expires).
      if (intentional && !room.players[otherTeam(team)]) return deleteRoom(room);
      updateExpiry(room);
      return;
    }
    refreshPause(room);
    updateExpiry(room);
    const other = room.players[otherTeam(team)];
    if (other && other.ws) {
      send(other.ws, { type: 'opponent_left' });
      snapshotNow(room);
    }
    log('room', room.code, 'team', team, 'disconnected');
  }

  // ---- message handlers ------------------------------------------------------

  function handleCreate(ws, msg) {
    leaveRoom(ws, true);
    if (!getSim()) {
      return send(ws, { type: 'error', message: 'Server game engine unavailable', reason: 'no_sim' });
    }
    if (rooms.size >= maxRooms) {
      return send(ws, { type: 'error', message: 'Server is full, try again later', reason: 'server_full' });
    }
    const code = makeCode();
    const token = newToken();
    const room = {
      code,
      players: [{ ws, token, name: cleanName(msg.name, 'HOME'), away: false }, null],
      game: null,
      sim: null,
      simAcc: 0,
      sendAcc: 0,
      rematch: [false, false],
      expireAt: 0,
      createdAt: Date.now(),
    };
    rooms.set(code, room);
    bindings.set(ws, { room, team: 0 });
    send(ws, { type: 'created', code, team: 0, token });
    log('room', code, 'created');
  }

  function handleJoin(ws, msg) {
    const code = cleanCode(msg.code);
    const room = rooms.get(code);
    if (!room) return send(ws, { type: 'error', message: 'Room not found', reason: 'not_found' });
    const existing = bindings.get(ws);
    if (existing && existing.room === room) {
      return send(ws, { type: 'error', message: 'Already in this room', reason: 'already_in' });
    }
    // Seat 1 may be taken over only while its socket is gone (e.g. the joiner's
    // connection dropped before the `joined` ack arrived and it re-sent `join`).
    const seat = room.players[1];
    if (seat && seat.ws) return send(ws, { type: 'error', message: 'Room is full', reason: 'full' });
    leaveRoom(ws, true);
    if (rooms.get(code) !== room || (room.players[1] && room.players[1].ws)) {
      return send(ws, { type: 'error', message: 'Room not found', reason: 'not_found' });
    }
    const token = newToken();
    // a running game keeps the seat's name (it is baked into the sim's team names)
    const name = room.game && room.players[1] ? room.players[1].name : cleanName(msg.name, 'AWAY');
    room.players[1] = { ws, token, name, away: false };
    bindings.set(ws, { room, team: 1 });
    send(ws, { type: 'joined', code, team: 1, token });
    updateExpiry(room);
    if (room.game) {
      // took over the seat of a dropped joiner in a running game: resume like a rejoin
      send(ws, { type: 'start', team: 1, names: [room.players[0].name, room.players[1].name] });
      refreshPause(room);
      const host = room.players[0];
      if (host && host.ws) send(host.ws, { type: 'opponent_back' });
      sendOpponentStatus(room, 1, ws);
      snapshotNow(room);
      log('room', room.code, 'seat 1 taken over by a new join');
      return;
    }
    if (room.players[0].ws) {
      if (!startGame(room)) {
        send(ws, { type: 'error', message: 'Server game engine unavailable', reason: 'no_sim' });
      }
    } else {
      // Host is temporarily away; game starts when they rejoin.
      send(ws, { type: 'opponent_left' });
    }
  }

  function handleRejoin(ws, msg) {
    const code = cleanCode(msg.code);
    const room = rooms.get(code);
    if (!room) return send(ws, { type: 'error', message: 'Room not found', reason: 'not_found' });
    const token = typeof msg.token === 'string' ? msg.token : '';
    const tokenBuf = Buffer.from(token, 'utf8');
    let team = -1;
    for (let t = 0; t < 2; t++) {
      const p = room.players[t];
      if (!p || !token) continue;
      const seatBuf = Buffer.from(p.token, 'utf8');
      // compare byte lengths (multi-byte chars would make timingSafeEqual throw)
      if (seatBuf.length === tokenBuf.length && crypto.timingSafeEqual(seatBuf, tokenBuf)) team = t;
    }
    if (team < 0) return send(ws, { type: 'error', message: 'Invalid rejoin token', reason: 'bad_token' });

    const p = room.players[team];
    if (p.ws === ws) return; // already bound
    if (p.ws) {
      // A stale socket still holds the seat (phone switched networks): replace it.
      if (room.game && room.game.phase === 'live') room.sim.input(room.game, team, { t: 'stop' });
      const old = p.ws;
      bindings.delete(old);
      p.ws = null;
      try { old.terminate(); } catch (e) { /* ignore */ }
    }
    leaveRoom(ws, true);
    if (rooms.get(code) !== room) return send(ws, { type: 'error', message: 'Room not found', reason: 'not_found' });
    p.ws = ws;
    p.away = false; // a fresh connection means the page is in the foreground again
    bindings.set(ws, { room, team });
    updateExpiry(room);
    send(ws, { type: 'rejoined', code, team, token: p.token });

    const other = room.players[otherTeam(team)];
    if (!room.game) {
      if (other && other.ws) {
        // Joiner arrived while host was away: start now.
        startGame(room);
      } else if (team === 0) {
        send(ws, { type: 'created', code, team: 0, token: p.token });
      } else {
        send(ws, { type: 'opponent_left' });
      }
      return;
    }
    send(ws, { type: 'start', team, names: [room.players[0].name, room.players[1].name] });
    refreshPause(room);
    if (other && other.ws) send(other.ws, { type: 'opponent_back' });
    sendOpponentStatus(room, team, ws);
    snapshotNow(room);
    log('room', room.code, 'team', team, 'rejoined');
  }

  /** The player quit on purpose: end the room and tell the opponent right away. */
  function handleLeave(ws) {
    const b = bindings.get(ws);
    if (!b) return;
    const { room, team } = b;
    const p = room.players[team];
    if (!p || p.ws !== ws) { bindings.delete(ws); return; }
    bindings.delete(ws);
    room.players[team] = null;
    const other = room.players[otherTeam(team)];
    if (other && other.ws) send(other.ws, { type: 'opponent_quit' });
    deleteRoom(room);
    log('room', room.code, 'team', team, 'quit');
  }

  /** The player's page went to the background (`away`) or came back (`back`). */
  function handleAway(ws, away) {
    const b = bindings.get(ws);
    if (!b) return;
    const { room, team } = b;
    const p = room.players[team];
    if (!p || p.ws !== ws || !!p.away === away) return;
    p.away = away;
    updateExpiry(room);
    if (!room.game) return;
    if (away) room.rematch = [false, false];
    refreshPause(room);
    const other = room.players[otherTeam(team)];
    if (other && other.ws) send(other.ws, away ? { type: 'opponent_left', reason: 'away' } : { type: 'opponent_back' });
    if (!away) sendOpponentStatus(room, team, ws);
    snapshotNow(room);
    log('room', room.code, 'team', team, away ? 'away' : 'back');
  }

  /** Token bucket: true if the socket may send another message of this kind now. */
  function takeToken(ws, key, rate) {
    const now = Date.now();
    let bk = ws[key];
    if (!bk) bk = ws[key] = { tokens: rate, at: now };
    bk.tokens = Math.min(rate, bk.tokens + ((now - bk.at) / 1000) * rate);
    bk.at = now;
    if (bk.tokens < 1) return false;
    bk.tokens -= 1;
    return true;
  }

  function handleInput(ws, msg) {
    const b = bindings.get(ws);
    if (!b || !b.room.game) return;
    if (!takeToken(ws, '_inBucket', inputRate)) return; // flood: drop excess inputs
    const m = msg.msg;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    if (typeof m.t !== 'string' || m.t.length === 0 || m.t.length > 32) return;
    try {
      b.room.sim.input(b.room.game, b.team, m);
    } catch (e) {
      console.error('[gridiron] sim.input error:', e && e.message);
    }
  }

  function handleRematch(ws) {
    const b = bindings.get(ws);
    if (!b || !b.room.game) return;
    const room = b.room;
    if (room.game.phase !== 'gameover') return;
    room.rematch[b.team] = true;
    const other = room.players[otherTeam(b.team)];
    if (other && other.ws) send(other.ws, { type: 'rematch_requested', team: b.team });
    if (room.rematch[0] && room.rematch[1]) {
      room.rematch = [false, false];
      try {
        room.sim.reset(room.game);
      } catch (e) {
        console.error('[gridiron] sim.reset error:', e && e.message);
        return;
      }
      refreshPause(room);
      room.simAcc = 0;
      snapshotNow(room);
      log('room', room.code, 'rematch');
    }
  }

  function onMessage(ws, data, isBinary) {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch (e) {
      return; // ignore garbage
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'create': return handleCreate(ws, msg);
      case 'join': return handleJoin(ws, msg);
      case 'rejoin': return handleRejoin(ws, msg);
      case 'input': return handleInput(ws, msg);
      case 'rematch': return handleRematch(ws);
      case 'leave': return handleLeave(ws);
      case 'away': return handleAway(ws, true);
      case 'back': return handleAway(ws, false);
      case 'ping': {
        const t = typeof msg.t === 'number' || typeof msg.t === 'string' ? msg.t : null;
        return send(ws, { type: 'pong', t });
      }
      default: return; // unknown type: ignore
    }
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (ws._killed) return;
      ws.isAlive = true;
      // per-socket flood control: drop excess, kill sockets that are clearly abusive
      const now = Date.now();
      if (!ws._win || now - ws._win.at >= 1000) ws._win = { at: now, n: 0 };
      ws._win.n++;
      if (ws._win.n > msgRate * FLOOD_KILL_FACTOR) {
        // terminate outside the ws receive loop (terminating inside it can spin)
        ws._killed = true;
        setImmediate(() => { try { ws.terminate(); } catch (e) { /* ignore */ } });
        return;
      }
      if (!takeToken(ws, '_msgBucket', msgRate)) return;
      try {
        onMessage(ws, data, isBinary);
      } catch (e) {
        console.error('[gridiron] message handler error:', e);
      }
    });
    ws.on('close', () => {
      try { leaveRoom(ws); } catch (e) { console.error('[gridiron] leave error:', e); }
    });
    ws.on('error', () => { /* close follows */ });
  });
  wss.on('error', (e) => console.error('[gridiron] wss error:', e.message));

  // ---- single shared loop ----------------------------------------------------

  let last = process.hrtime.bigint();
  let heartbeatAcc = 0;
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    let elapsed = Number(now - last) / 1e9;
    last = now;
    if (elapsed > 0.5) elapsed = 0.5;
    const wall = Date.now();

    for (const room of rooms.values()) {
      if (room.expireAt && wall >= room.expireAt) {
        deleteRoom(room, 'Room expired');
        continue;
      }
      if (!room.game) continue;
      room.simAcc += elapsed * timeScale;
      let steps = 0;
      while (room.simAcc >= SIM_DT && steps < maxSteps) {
        room.simAcc -= SIM_DT;
        steps++;
        try {
          room.sim.step(room.game, SIM_DT);
        } catch (e) {
          console.error('[gridiron] sim.step error in room', room.code, e);
        }
        // broadcast every SEND_DT of sim time (20 per sim-second, independent of timeScale)
        room.sendAcc += SIM_DT;
        if (room.sendAcc >= SEND_DT - 1e-9) {
          room.sendAcc -= SEND_DT;
          if (connectedCount(room) > 0) snapshotNow(room);
        }
        if (!rooms.has(room.code)) break;
      }
      if (room.simAcc > SIM_DT * maxSteps) room.simAcc = 0;
    }

    heartbeatAcc += elapsed * 1000;
    if (heartbeatAcc >= HEARTBEAT_MS) {
      heartbeatAcc = 0;
      for (const ws of wss.clients) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch (e) { /* ignore */ }
      }
    }
  }, LOOP_MS);

  let closed = false;
  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    clearInterval(timer);
    rooms.clear();
    bindings.clear();
    for (const ws of wss.clients) {
      try { ws.terminate(); } catch (e) { /* ignore */ }
    }
    return new Promise((resolve) => {
      wss.close(() => {
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
      });
    });
  }

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      clearInterval(timer);
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      server.on('error', (e) => console.error('[gridiron] server error:', e.message));
      const stats = () => ({ rooms: rooms.size, bindings: bindings.size, clients: wss.clients.size });
      resolve({ server, wss, port: server.address().port, rooms, stats, close });
    });
  });
}

module.exports = { start, resolveStatic, lanAddresses };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  start(port, { log: true }).then(({ port: p, close }) => {
    console.log('\n  Gridiron Duel is running!\n');
    console.log('  Open on this computer:  http://localhost:' + p);
    const ips = lanAddresses();
    if (ips.length) {
      console.log('  Open on phones (same Wi-Fi):');
      for (const ip of ips) console.log('    http://' + ip + ':' + p);
    } else {
      console.log('  (No LAN IPv4 address found - connect to Wi-Fi to play on phones.)');
    }
    console.log('');
    if (!fs.existsSync(SIM_PATH)) console.warn('  WARNING: shared/sim.js not found - online games cannot start.\n');
    const shutdown = () => { close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('Port ' + port + ' is already in use. Try: PORT=3001 npm start');
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
