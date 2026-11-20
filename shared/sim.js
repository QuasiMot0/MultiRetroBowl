/*
 * Gridiron Duel - shared deterministic game simulation.
 * UMD: module.exports in Node, window.GridSim in the browser. No dependencies.
 *
 * Coordinates are in yards in the "play frame": the offense always attacks +x.
 * x in [0,120] (own endzone 0-10, field 10-110, target endzone 110-120),
 * y in [0,53.3] sideline to sideline.
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.GridSim = factory();
  }
}(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  // ---------------------------------------------------------------- constants
  var FIELD_W = 53.3;
  var CY = FIELD_W / 2;
  var PLAYCALL_TIME = 15;
  var PRESNAP_TIME = 1.0;
  var RESULT_TIME = 2.5;
  var KICK_TIME = 4;
  // online kickers see the meter ~150-250ms late (interpolation + latency): a kick
  // message may carry `at`, the kick-phase elapsed time shown on their screen, and
  // it is honoured if it lies within this window before "now"
  var KICK_LAG_WINDOW = 0.4;
  var MAX_LIVE = 12;
  var RUNOFF = 20;
  var BALL_SPEED = 23;
  var PASS_ARC = 0.20;
  var MAX_THROW = 55;
  var HUMAN_ACCEL_TIME = 0.29;
  var BLITZ_RUSH_SPEED = 0.90;
  var TACKLE_DIST = 0.9;
  var BLOCK_DIST = 1.2;
  // after a juke's burst the carrier plants his foot: roughly distance-neutral, so a juke
  // buys a moment of tackle immunity rather than a free breakaway
  var JUKE_REC = 0.45;
  var JUKE_REC_SPEED = 0.65;

  var OFF_IDS = ['QB', 'RB', 'WR1', 'WR2', 'TE', 'OL1', 'OL2'];
  var DEF_IDS = ['DL1', 'DL2', 'LB', 'CB1', 'CB2', 'S1', 'S2'];
  var ELIGIBLE = ['RB', 'WR1', 'WR2', 'TE'];
  var IDX = {};
  OFF_IDS.concat(DEF_IDS).forEach(function (id, i) { IDX[id] = i; });

  var SPEED = {
    QB: 5.6, RB: 7.0, WR1: 7.0, WR2: 7.0, TE: 6.3, OL1: 5.0, OL2: 5.0,
    DL1: 5.0, DL2: 5.0, LB: 6.3, CB1: 7.0, CB2: 7.0, S1: 7.0, S2: 7.0
  };

  var OFFENSE_PLAYS = [
    { id: 'slant', name: 'Slant', desc: 'WRs cut inside after 5 yards. Quick, safe throws.' },
    { id: 'deep', name: 'Deep Shot', desc: 'WRs go long. RB stays in to block. Big play potential.' },
    { id: 'screen', name: 'Screen', desc: 'RB and TE swing to the flats behind the line; WRs block.' },
    { id: 'run', name: 'Run', desc: 'Handoff to the RB. WRs and TE block downfield.' },
    { id: 'punt', name: 'Punt', desc: '4th down only. Net 40 yards.', fourthOnly: true },
    { id: 'fg', name: 'Field Goal', desc: '4th down only. Time the kick meter.', fourthOnly: true }
  ];
  var DEFENSE_PLAYS = [
    { id: 'man', name: 'Man', desc: 'CBs shadow the WRs, LB takes the TE, safeties over the top.' },
    { id: 'zone', name: 'Zone', desc: 'Defenders drop into areas and break on the ball.' },
    { id: 'blitz', name: 'Blitz', desc: 'LB and a safety rush the QB. Risky man coverage behind.' }
  ];
  var OFF_PLAY_IDS = ['slant', 'deep', 'screen', 'run', 'punt', 'fg'];
  var DEF_PLAY_IDS = ['man', 'zone', 'blitz'];

  // ---------------------------------------------------------------- helpers
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function fin(v) { return typeof v === 'number' && isFinite(v); }
  function r2(v) { return fin(v) ? (Math.round(v * 100) / 100) || 0 : 0; }
  function dist(ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); }
  function pd(a, b) { return dist(a.x, a.y, b.x, b.y); }

  // mulberry32 PRNG, state stored in the game
  function rand(g) {
    var t = (g.rngState = (g.rngState + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function pickWeighted(g, table) {
    var total = 0, k;
    for (k in table) total += table[k];
    var r = rand(g) * total;
    for (k in table) { r -= table[k]; if (r <= 0) return k; }
    return k;
  }

  function P(g, id) { return g.players[IDX[id]]; }
  function los(g) { return 10 + g.ballOn; }
  function ordinal(n) { return ['1st', '2nd', '3rd', '4th'][clamp(n, 1, 4) - 1]; }
  function downText(down, toGo, ballOn) {
    return ordinal(down) + ' & ' + (ballOn + toGo >= 100 ? 'Goal' : toGo);
  }
  function goalToGo(ballOn) { return Math.min(10, 100 - ballOn); }
  function emit(g, ev) {
    g.events.push(ev);
    if (g.events.length > 200) g.events.splice(0, g.events.length - 200);
  }
  function isElig(p) { return ELIGIBLE.indexOf(p.id) >= 0; }

  // ---------------------------------------------------------------- creation
  function makePlayer(id, side) {
    return {
      id: id, side: side, x: 0, y: 0, vx: 0, vy: 0, svx: 0, svy: 0,
      tx: 0, ty: 0, hasTarget: false, targetSpeed: 1,
      jukeT: 0, jukeCd: 0, recT: 0,
      job: null, manId: null, zx: 0, zy: 0, zr: 0, deep: false,
      route: null, routeIdx: 0, after: null,
      blockId: null, blockF: 1, engageT: 0, shedAt: 3, freeT: 0, stunT: 0
    };
  }

  function createGame(opts) {
    opts = opts || {};
    var names = Array.isArray(opts.teamNames) ? opts.teamNames : ['HOME', 'AWAY'];
    var humans = Array.isArray(opts.humans) ? opts.humans : [true, true];
    var ql = fin(opts.quarterLength) && opts.quarterLength > 0 ? opts.quarterLength : 150;
    var seed = fin(opts.seed) ? (opts.seed >>> 0) : ((Math.random() * 4294967296) >>> 0);
    var g = {
      opts: {
        teamNames: [String(names[0] == null ? 'HOME' : names[0]), String(names[1] == null ? 'AWAY' : names[1])],
        humans: [humans[0] !== false, humans[1] !== false],
        quarterLength: ql
      },
      seed: seed,
      rngState: seed,
      phase: 'playcall',
      phaseTime: PLAYCALL_TIME,
      paused: false,
      quarter: 1,
      clock: ql,
      score: [0, 0],
      possession: 0,
      down: 1,
      toGo: 10,
      ballOn: 25,
      picks: [null, null],
      offPlay: null,
      defPlay: null,
      players: [],
      ball: { x: 0, y: 0, z: 0, state: 'dead', holder: null, tx: 0, ty: 0, sx: 0, sy: 0, airT: 0, dur: 1, distance: 0 },
      userDefenderId: 'S1',
      kickMeter: null,
      kickT: 0,
      kickLocked: false,
      cpuKickAt: 0,
      cpuKickVal: 0,
      message: '',
      sub: '',
      events: [],
      liveT: 0,
      handedOff: false,
      qbRan: false,
      intended: null,
      cpuOpenNeed: 3,
      lastCarrier: null,
      carrierT: 0,
      runHoleY: CY,
      pending: null
    };
    g.teamNames = g.opts.teamNames.slice();
    g.humans = g.opts.humans.slice();
    g.quarterLength = ql;
    OFF_IDS.forEach(function (id) { g.players.push(makePlayer(id, 'off')); });
    DEF_IDS.forEach(function (id) { g.players.push(makePlayer(id, 'def')); });
    enterPlaycall(g);
    return g;
  }

  function reset(g) {
    if (!g || !g.opts) return g;
    var o = g.opts;
    var newSeed = (rand(g) * 4294967296) >>> 0;
    var fresh = createGame({ teamNames: o.teamNames, humans: o.humans, quarterLength: o.quarterLength, seed: newSeed });
    Object.keys(g).forEach(function (k) { delete g[k]; });
    Object.keys(fresh).forEach(function (k) { g[k] = fresh[k]; });
    return g;
  }

  // ---------------------------------------------------------------- formation
  function formationPositions(g) {
    var L = los(g), C = CY;
    var pos = {
      QB: [L - 4, C], RB: [L - 4.5, C - 2.2], WR1: [L - 0.6, C - 13], WR2: [L - 0.6, C + 13],
      TE: [L - 1, C + 3.4], OL1: [L - 1, C - 1.2], OL2: [L - 1, C + 1.2],
      DL1: [L + 1, C - 1.2], DL2: [L + 1, C + 1.2], LB: [L + 5, C],
      CB1: [L + 5, C - 13], CB2: [L + 5, C + 13], S1: [L + 12, C - 8], S2: [L + 12, C + 8]
    };
    // revealed at presnap: blitzers creep up to the line, zone corners bail
    if (g.phase === 'presnap' && g.defPlay === 'blitz') { pos.LB = [L + 4.75, C + 1.5]; pos.S1 = [L + 7.75, C - 5]; }
    if (g.phase === 'presnap' && g.defPlay === 'zone') { pos.CB1 = [L + 6.5, C - 12.5]; pos.CB2 = [L + 6.5, C + 12.5]; }
    for (var id in pos) { pos[id][0] = clamp(pos[id][0], 0.5, 119.5); pos[id][1] = clamp(pos[id][1], 0, FIELD_W); }
    return pos;
  }

  // set everyone instantly in formation, ball spotted at the LOS
  function formation(g) {
    var L = los(g), C = CY;
    var pos = formationPositions(g);
    g.players.forEach(function (p) {
      var q = pos[p.id];
      p.x = q[0]; p.y = q[1]; p.hx = q[0]; p.hy = q[1];
      p.vx = p.vy = p.svx = p.svy = 0;
      p.hasTarget = false; p.tx = p.x; p.ty = p.y;
      p.jukeT = 0; p.jukeCd = 0; p.recT = 0;
      p.job = null; p.manId = null; p.route = null; p.routeIdx = 0; p.after = null;
      p.blockId = null; p.blockF = 1; p.engageT = 0; p.freeT = 0; p.stunT = 0;
    });
    var b = g.ball;
    b.state = 'dead'; b.holder = null; b.x = clamp(L, 0, 120); b.y = C; b.z = 0;
    b.tx = b.x; b.ty = b.y;
  }

  // ---------------------------------------------------------------- phases
  function enterPlaycall(g) {
    g.phase = 'playcall';
    g.phaseTime = PLAYCALL_TIME;
    g.picks = [null, null];
    g.offPlay = null;
    g.defPlay = null;
    g.kickMeter = null;
    formation(g);
    var off = g.possession, def = 1 - off;
    if (!g.humans[off]) g.picks[off] = cpuOffPick(g);
    if (!g.humans[def]) g.picks[def] = cpuDefPick(g);
  }

  function enterPresnap(g) {
    var off = g.possession, def = 1 - off;
    if (!g.picks[off]) g.picks[off] = 'slant';
    if (!g.picks[def]) g.picks[def] = 'zone';
    g.offPlay = g.picks[off];
    g.defPlay = g.picks[def];
    g.phase = 'presnap';
    g.phaseTime = PRESNAP_TIME;
    g.message = ''; g.sub = '';
    // players walk (not teleport) to their presnap alignment
    var pos = formationPositions(g);
    var far = false;
    g.players.forEach(function (p) {
      p.hx = pos[p.id][0]; p.hy = pos[p.id][1]; p.hasTarget = false;
      if (dist(p.x, p.y, p.hx, p.hy) > 9) far = true;
    });
    if (far) formation(g); // out of position (e.g. spot changed): set up instantly

    // Set up the next scrimmage play here so the offense can see the run lane before the snap.
    if (g.offPlay === 'punt' || g.offPlay === 'fg') return;
    g.cpuOpenNeed = 2.0 + rand(g) * 1.4;
    g.readNoise = {};
    ELIGIBLE.forEach(function (id) { g.readNoise[id] = (rand(g) - 0.5) * 2.6; });
    g.runHoleY = CY + (rand(g) < 0.5 ? -1 : 1) * (4.5 + rand(g) * 4.5);
    g.misread = rand(g) < 0.16;
    g.cpuFirstRead = 1.2 + rand(g) * 0.5;
  }

  function presnapMove(g, dt) {
    g.players.forEach(function (p) {
      steer(p, p.hx, p.hy, SPEED[p.id], SPEED[p.id] / 0.3, dt, 0.1);
      p.x = clamp(p.x + p.vx * dt, 0, 120);
      p.y = clamp(p.y + p.vy * dt, -1, FIELD_W + 1);
      p.svx = p.vx; p.svy = p.vy;
    });
  }

  function startLive(g) {
    g.phase = 'live';
    g.phaseTime = 0;
    g.liveT = 0;
    g.handedOff = false;
    g.qbRan = false;
    g.intended = null;
    g.lastCarrier = 'QB';
    g.carrierT = 0;
    var b = g.ball;
    b.state = 'held'; b.holder = 'QB'; b.z = 1;
    assignJobs(g);
    emit(g, 'snap');
  }

  function enterKick(g) {
    g.phase = 'kick';
    g.phaseTime = KICK_TIME;
    g.kickT = 0;
    g.kickMeter = 0;
    g.kickLocked = false;
    if (!g.humans[g.possession]) {
      g.cpuKickAt = 0.7 + rand(g) * 1.5;
      g.cpuKickVal = (rand(g) + rand(g) - 1) * 0.75;
    }
  }

  function enterResult(g, message, sub) {
    g.phase = 'result';
    g.phaseTime = RESULT_TIME;
    g.message = message;
    g.sub = sub || '';
    g.ball.state = 'dead';
    g.ball.holder = null;
    g.ball.z = 0;
    g.players.forEach(function (p) { p.hasTarget = false; });
  }

  function finishResult(g) {
    var pend = g.pending;
    g.pending = null;
    if (pend) {
      g.possession = pend.possession;
      g.ballOn = pend.ballOn;
      g.down = pend.down;
      g.toGo = pend.toGo;
    }
    var msg = '', sub = '';
    if (g.clock <= 0) {
      if (g.quarter >= 4) {
        g.phase = 'gameover';
        g.phaseTime = 0;
        g.clock = 0;
        g.kickMeter = null;
        var s = g.score;
        g.message = s[0] === s[1] ? 'FINAL - TIE GAME' : 'FINAL';
        g.sub = g.teamNames[0] + ' ' + s[0] + ' - ' + s[1] + ' ' + g.teamNames[1];
        formation(g);
        emit(g, 'gameover');
        return;
      }
      g.quarter += 1;
      g.clock = g.quarterLength;
      if (g.quarter === 3) {
        g.possession = 1;
        g.ballOn = 25; g.down = 1; g.toGo = 10;
        msg = 'HALFTIME';
        sub = g.teamNames[1] + ' receives';
      } else {
        msg = 'END OF Q' + (g.quarter - 1);
      }
    }
    enterPlaycall(g);
    g.message = msg;
    g.sub = sub;
  }

  // ---------------------------------------------------------------- CPU play calling
  function cpuOffPick(g) {
    if (g.down === 4) {
      if (g.ballOn >= 65) return 'fg';
      if (g.toGo > 3) return 'punt';
    }
    var table;
    if (g.toGo <= 2) table = { run: 50, slant: 28, screen: 12, deep: 10 };
    else if (g.toGo >= 8 && g.down >= 2) table = { slant: 32, deep: 33, screen: 18, run: 17 };
    else table = { slant: 30, deep: 20, screen: 20, run: 30 };
    if (g.ballOn >= 88) { table.deep = 6; table.slant += 8; }
    return pickWeighted(g, table);
  }

  function cpuDefPick(g) {
    var table;
    if (g.toGo >= 8 && g.down >= 2) table = { man: 30, zone: 52, blitz: 18 };
    else if (g.toGo <= 2) table = { man: 38, zone: 22, blitz: 40 };
    else table = { man: 35, zone: 40, blitz: 25 };
    return pickWeighted(g, table);
  }

  // ---------------------------------------------------------------- assignments
  function routePt(x, y) { return { x: clamp(x, 0.5, 119), y: clamp(y, 1.5, FIELD_W - 1.5) }; }
  var RUN_APPROACH = -1, RUN_HOLE_EXIT = 2;

  function receiverAssignment(play, id, x, y, L) {
    var out = y < CY ? -1 : 1;
    if (id === 'WR1' || id === 'WR2') {
      if (play === 'slant') return { job: 'route', route: [routePt(x + 5, y), routePt(x + 35, y - out * 30)] };
      if (play === 'deep') return { job: 'route', route: [routePt(x + 25, y)], after: { x: 1, y: out * 0.35 } };
      if (play === 'screen') return { job: 'route', route: [routePt(x + 2.5, y)], thenBlock: true };
      return { job: 'route', route: [routePt(x + 3, y - out)], thenBlock: true };
    }
    if (id === 'TE') {
      if (play === 'slant') return { job: 'route', route: [routePt(x + 5, y), routePt(x + 5.5, y + out * 9)] };
      if (play === 'deep') return { job: 'route', route: [routePt(x + 6, y), routePt(x + 6.5, y + out * 9)] };
      if (play === 'screen') return { job: 'route', route: [routePt(L - 1.5, y + 3), routePt(L - 1.5, CY + 10)] };
      return { job: 'block', blockId: 'LB', blockF: 0.6 };
    }
    if (play === 'slant') return { job: 'route', route: [routePt(L - 1.5, y - 7), routePt(L + 2, y - 12), routePt(L + 7, y - 13)] };
    if (play === 'deep') return { job: 'protect' };
    if (play === 'screen') return { job: 'route', route: [routePt(L - 3, y - 5), routePt(L - 2, CY - 11)] };
    return { job: 'carry' };
  }

  function routePreview(s) {
    var play = s.offPlay, L = los(s);
    if (play !== 'slant' && play !== 'deep' && play !== 'screen' && play !== 'run') return [];
    if (s.phase !== 'presnap') {
      if (s.phase !== 'live') return [];
      if (play === 'run') {
        if (!s.ball || s.ball.state !== 'held' || s.ball.x >= L + RUN_HOLE_EXIT || s.phaseTime >= 2.5) return [];
      } else if (!s.canThrow) return [];
    }
    var pos = formationPositions(s), paths = [];
    ELIGIBLE.forEach(function (id) {
      var start = pos[id], assignment = receiverAssignment(play, id, start[0], start[1], L);
      var points = [{ x: start[0], y: start[1] }], kind;
      if (assignment.route) {
        points = points.concat(assignment.route);
        if (assignment.after) {
          var last = points[points.length - 1];
          points.push(routePt(last.x + assignment.after.x * 20, last.y + assignment.after.y * 20));
        }
        kind = assignment.thenBlock ? 'block' : 'pass';
      } else if (assignment.job === 'carry' && fin(s.runHoleY)) {
        points.push(routePt(L + RUN_APPROACH, s.runHoleY), routePt(L + RUN_HOLE_EXIT, s.runHoleY));
        kind = 'run';
      } else return;
      paths.push({ id: id, kind: kind, points: points });
    });
    return paths;
  }

  function assignJobs(g) {
    var L = los(g), C = CY, play = g.offPlay, dp = g.defPlay;
    g.players.forEach(function (p) {
      p.job = null; p.manId = null; p.route = null; p.routeIdx = 0; p.after = null;
      p.blockId = null; p.blockF = 1; p.engageT = 0; p.freeT = 0; p.stunT = 0;
      p.shedAt = 1.2 + rand(g) * 2.0;
      // coverage quality this play: 0 = blanket, 1 = gets beaten deep
      p.beat = p.side === 'def' ? rand(g) : 0;
    });
    // offense
    P(g, 'OL1').job = 'block'; P(g, 'OL1').blockId = 'DL1'; P(g, 'OL1').blockF = 0.4;
    P(g, 'OL2').job = 'block'; P(g, 'OL2').blockId = 'DL2'; P(g, 'OL2').blockF = 0.4;
    P(g, 'QB').job = 'qb';
    ELIGIBLE.forEach(function (id) {
      var p = P(g, id);
      var assignment = receiverAssignment(play, id, p.x, p.y, L);
      p.job = assignment.job;
      p.route = assignment.route || null;
      p.after = assignment.after || null;
      p.thenBlock = !!assignment.thenBlock;
      if (assignment.blockId) { p.blockId = assignment.blockId; p.blockF = assignment.blockF; }
    });
    // defense
    var dl = ['DL1', 'DL2'];
    dl.forEach(function (id) { P(g, id).job = 'rush'; });
    function man(id, target) { var d = P(g, id); d.job = 'man'; d.manId = target; }
    function zone(id, zx, zy, zr, deep) { var d = P(g, id); d.job = 'zone'; d.zx = clamp(zx, 1, 118.5); d.zy = zy; d.zr = zr; d.deep = !!deep; }
    if (dp === 'man') {
      man('CB1', 'WR1'); man('CB2', 'WR2'); man('LB', 'TE');
      zone('S1', L + 14, C - 10, 14, true); zone('S2', L + 14, C + 10, 14, true);
    } else if (dp === 'blitz') {
      P(g, 'LB').job = 'rush'; P(g, 'S1').job = 'rush';
      man('CB1', 'WR1'); man('CB2', 'WR2'); man('S2', 'TE');
    } else { // zone
      zone('CB1', L + 5, C - 14, 9, false); zone('CB2', L + 5, C + 14, 9, false);
      zone('LB', L + 6, C, 8, false);
      zone('S1', L + 17, C - 11, 13, true); zone('S2', L + 17, C + 11, 13, true);
    }
  }

  // ---------------------------------------------------------------- movement
  function steer(p, tx, ty, spd, accel, dt, stop) {
    var dx = tx - p.x, dy = ty - p.y, d = Math.sqrt(dx * dx + dy * dy);
    var dvx = 0, dvy = 0;
    if (d > stop && d > 1e-6) {
      var s = Math.min(spd, (d - stop * 0.5) * 8);
      dvx = dx / d * s; dvy = dy / d * s;
    }
    var ax = dvx - p.vx, ay = dvy - p.vy, a = Math.sqrt(ax * ax + ay * ay);
    var maxDv = accel * dt;
    if (a > maxDv && a > 0) { ax *= maxDv / a; ay *= maxDv / a; }
    p.vx += ax; p.vy += ay;
  }

  function nearestDef(g, x, y, filter) {
    var best = null, bd = Infinity;
    for (var i = 7; i < 14; i++) {
      var d = g.players[i];
      if (filter && !filter(d)) continue;
      var dd = dist(x, y, d.x, d.y);
      if (dd < bd) { bd = dd; best = d; }
    }
    return { p: best, d: bd };
  }

  // ---------------------------------------------------------------- AI brains
  // returns {x, y, m (speed multiplier), stop, human}
  function offBrain(g, p, ctx) {
    var L = ctx.L, carrier = ctx.carrier, offHuman = g.humans[g.possession];
    var ball = g.ball;
    // ball carrier
    if (carrier === p) {
      if (offHuman) {
        if (p.hasTarget) return { x: p.tx, y: p.ty, m: p.targetSpeed, stop: 0.3, human: true };
        if (p.id === 'QB') return { x: p.x, y: p.y, m: 1, stop: 0.3, human: true };
        return { x: p.x + 10, y: p.y, m: 1, stop: 0.3, human: true };
      }
      if (p.id === 'QB' && !g.qbRan && !g.handedOff) return cpuQBMove(g, p, ctx);
      return carrierAI(g, p, ctx);
    }
    // ball in the air: intended receiver attacks the ball, nearby receivers too
    if (ctx.air && isElig(p)) {
      var dT = dist(p.x, p.y, ball.tx, ball.ty);
      // receivers need a moment to track the ball, then attack the catch point
      if ((p.id === g.intended && ball.airT > 0.2) || dT < 2.5 || (dT < 5 && ball.airT > 0.3)) return { x: ball.tx, y: ball.ty, m: 1, stop: 0.05 };
    }
    // OL: always block their man, protecting the QB / carrier / landing spot
    if (p.job === 'block' && p.blockId) {
      var protect = carrier || (ctx.air ? { x: ball.tx, y: ball.ty } : P(g, 'QB'));
      // run blocking: seal defenders away from the hole
      if (g.offPlay === 'run' && (!carrier || carrier.x < L + 2)) protect = { x: L + 1, y: g.runHoleY };
      return blockPos(g, p, P(g, p.blockId), protect);
    }
    if (p.id === 'QB') {
      if (g.handedOff && !ctx.air) return { x: p.x - 1, y: p.y + (p.y < CY ? -1 : 1), m: 0.35, stop: 0.3 };
      return { x: p.x + 1, y: p.y, m: 0.3, stop: 0.3 };
    }
    // after catch / handoff: lead block
    if (ctx.pursuit && carrier) {
      var tgt = leadBlockTarget(g, p, carrier, ctx);
      if (tgt) return blockPos(g, p, tgt, carrier);
      return { x: carrier.x + 4, y: carrier.y + (p.y < carrier.y ? -3 : 3), m: 0.9, stop: 0.5 };
    }
    // pre-throw jobs
    if (p.job === 'carry') {
      // RB on run play: take the handoff on the way to the hole
      return { x: L + RUN_APPROACH, y: g.runHoleY, m: 1, stop: 0 };
    }
    if (p.job === 'protect') {
      var qb = P(g, 'QB');
      var threat = null, td = 7;
      for (var i = 7; i < 14; i++) {
        var d = g.players[i];
        if (d.id === 'DL1' || d.id === 'DL2') continue;
        var dq = pd(d, qb);
        if (dq < td && d.x > qb.x - 1) { td = dq; threat = d; }
      }
      if (threat) { p.blockF = 0.55; p.blockId = threat.id; return blockPos(g, p, threat, qb); }
      p.blockId = null;
      return { x: qb.x + 1, y: qb.y - 1.6, m: 0.8, stop: 0.3 };
    }
    if (p.job === 'route' && p.route) {
      if (p.routeIdx < p.route.length) {
        var wp = p.route[p.routeIdx];
        if (dist(p.x, p.y, wp.x, wp.y) < 0.8) p.routeIdx++;
        if (p.routeIdx < p.route.length) {
          wp = p.route[p.routeIdx];
          return { x: wp.x, y: wp.y, m: 1, stop: 0 };
        }
      }
      if (p.thenBlock) {
        p.job = 'dblock';
        p.blockId = null;
      } else if (p.after) {
        return { x: clamp(p.x + p.after.x * 20, 0.5, 119), y: clamp(p.y + p.after.y * 20, 1.5, FIELD_W - 1.5), m: 1, stop: 0 };
      } else {
        // sit down in the open, drift a little
        var last = p.route[p.route.length - 1];
        return { x: last.x + 0.5, y: last.y, m: 0.5, stop: 0.4 };
      }
    }
    if (p.job === 'dblock') {
      // downfield block: pick the nearest unblocked DB / LB
      var cur = p.blockId ? P(g, p.blockId) : null;
      if (!cur || pd(cur, p) > 12) {
        var best = null, bd = Infinity;
        for (var j = 7; j < 14; j++) {
          var dd = g.players[j];
          if (dd.id === 'DL1' || dd.id === 'DL2') continue;
          if (blockedBy(g, dd.id, p)) continue;
          var dist0 = pd(dd, p);
          if (dist0 < bd) { bd = dist0; best = dd; }
        }
        cur = best; p.blockId = best ? best.id : null; p.blockF = 0.6;
      }
      if (cur) return blockPos(g, p, cur, carrier || P(g, 'QB'));
    }
    if (p.job === 'block' && !p.blockId) return { x: p.x, y: p.y, m: 0.5, stop: 0.3 };
    return { x: p.x + 1, y: p.y, m: 0.4, stop: 0.3 };
  }

  function blockedBy(g, defId, except) {
    for (var i = 0; i < 7; i++) {
      var o = g.players[i];
      if (o !== except && o.blockId === defId) return true;
    }
    return false;
  }

  function blockPos(g, p, def, protect) {
    if (!def) return { x: p.x, y: p.y, m: 0.5, stop: 0.3 };
    var dx = protect.x - def.x, dy = protect.y - def.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    var off = Math.min(0.9, d * 0.5);
    return { x: def.x + dx / d * off, y: def.y + dy / d * off, m: p.stunT > 0 ? 0 : 1, stop: 0.1 };
  }

  function leadBlockTarget(g, p, carrier) {
    if (p.blockId) {
      var cur = P(g, p.blockId);
      if (cur && cur.side === 'def' && pd(cur, carrier) < 10 && pd(cur, p) < 6) return cur;
    }
    var best = null, bs = Infinity;
    for (var i = 7; i < 14; i++) {
      var d = g.players[i];
      var dc = pd(d, carrier);
      if (dc > 10 || dc < 1.0) continue;
      if (blockedBy(g, d.id, p)) continue;
      var s = pd(d, p) + dc * 0.5;
      if (s < bs) { bs = s; best = d; }
    }
    if (best && pd(best, p) < 7) { p.blockId = best.id; p.blockF = 0.75; return best; }
    p.blockId = null;
    return null;
  }

  function cpuQBMove(g, qb, ctx) {
    var L = ctx.L;
    if (g.liveT < 0.7 && g.offPlay !== 'screen') return { x: L - 5.5, y: CY, m: 0.9, stop: 0.2 };
    var nd = nearestDef(g, qb.x, qb.y);
    if (nd.p && nd.d < 3.2) {
      var dx = qb.x - nd.p.x, dy = qb.y - nd.p.y, d = nd.d || 1;
      var tx = qb.x + dx / d * 2, ty = qb.y + dy / d * 2 + (dy >= 0 ? 0.8 : -0.8);
      return { x: Math.min(tx, L - 0.5), y: clamp(ty, 4, FIELD_W - 4), m: 0.7, stop: 0.2 };
    }
    return { x: qb.x, y: qb.y, m: 0.5, stop: 0.3 };
  }

  function carrierAI(g, p, ctx) {
    var ax = 1, ay = 0;
    // run play: hit the hole first
    if (g.offPlay === 'run' && p.id === 'RB' && g.carrierT < 0.9 && p.x < ctx.L + 1.5) {
      return { x: ctx.L + RUN_HOLE_EXIT, y: g.runHoleY, m: 1, stop: 0 };
    }
    var nearD = Infinity, nearP = null;
    for (var i = 7; i < 14; i++) {
      var d = g.players[i];
      var dx = d.x - p.x, dy = d.y - p.y, dd = Math.sqrt(dx * dx + dy * dy);
      if (dd < nearD) { nearD = dd; nearP = d; }
      if (dd < 7 && dx > -1) {
        // defenders in the running lane push the carrier sideways
        var w = (7 - dd) / 7;
        w = w * w * 1.6 / (1 + Math.abs(dy) * 0.35);
        var side = dy > 0.05 ? -1 : (dy < -0.05 ? 1 : (p.y < CY ? 1 : -1));
        ay += side * w;
        if (dx > 0 && dx < 2.5 && Math.abs(dy) < 1.2) ax -= 0.35;
      }
    }
    if (p.y < 4) ay += (4 - p.y) * 0.5;
    if (p.y > FIELD_W - 4) ay -= (p.y - (FIELD_W - 4)) * 0.5;
    if (p.x > 100) ax += 1.5;
    ay = clamp(ay, -1.6, 1.6);
    ax = Math.max(ax, 0.55);
    var n = Math.sqrt(ax * ax + ay * ay) || 1;
    // juke when a defender is about to make contact
    if (nearP && nearD < 1.8 && p.jukeCd <= 0 && nearP.x > p.x - 0.8 && rand(g) < 0.05) doJuke(g, p);
    return { x: p.x + ax / n * 6, y: p.y + ay / n * 6, m: 1, stop: 0 };
  }

  function defBrain(g, d, ctx) {
    var carrier = ctx.carrier, ball = g.ball, defHuman = g.humans[1 - g.possession];
    if (defHuman && d.id === g.userDefenderId && d.hasTarget) {
      return { x: d.tx, y: d.ty, m: d.targetSpeed, stop: 0.3, human: true };
    }
    if (ctx.pursuit && carrier) {
      // DBs need a beat to read the handoff before they come downhill
      var reading = g.handedOff && carrier.id === 'RB' && g.carrierT < 0.45 && d.job !== 'rush' && d.id !== 'LB';
      if (!reading) return pursue(d, carrier, 0.43, 0.97);
    }
    if (ctx.air) {
      var dT = dist(d.x, d.y, ball.tx, ball.ty);
      var react = d.job === 'man' ? 0.32 : 0.42;
      if (ball.airT > react && dT < 10) return { x: ball.tx, y: ball.ty, m: 1, stop: 0.05 };
      if (d.job === 'rush') return { x: ball.tx, y: ball.ty, m: 0.6, stop: 0.5 };
    }
    var qb = P(g, 'QB');
    if (d.job === 'rush') {
      // Only the extra rushers ease off while attacking a QB in the pocket.
      var extraRush = carrier === qb && g.defPlay === 'blitz' && (d.id === 'LB' || d.id === 'S1');
      return pursue(d, carrier || qb, 0.5, extraRush ? BLITZ_RUSH_SPEED : 1);
    }
    if (d.job === 'man' && d.manId) {
      var r = P(g, d.manId);
      if (r.job === 'block' || r.job === 'protect' || r.job === 'dblock') {
        // man stays in to block: help underneath / spy QB
        return { x: Math.max(ctx.L + 3, r.x + 3), y: r.y * 0.6 + CY * 0.4, m: 0.7, stop: 0.4 };
      }
      // shadow with a small cushion: a step deeper and shading inside
      var inside = (CY - r.y) > 0 ? 0.5 : -0.5;
      var cushion = 1.0 - clamp((r.x - ctx.L - 7) / 10, 0, 1) * d.beat * 3.2;
      return { x: r.x + r.svx * 0.25 + cushion, y: r.y + r.svy * 0.25 + inside, m: 1, stop: 0.1 };
    }
    if (d.job === 'zone') return zoneTarget(g, d, ctx);
    return { x: d.x, y: d.y, m: 0.5, stop: 0.3 };
  }

  function pursue(d, c, maxLead, speed) {
    // Estimate when the defender will reach the carrier, then cap the lead.
    var spd = SPEED[d.id] || 6;
    var t0 = pd(d, c) / spd;
    var t1 = dist(d.x, d.y, c.x + c.vx * t0, c.y + c.vy * t0) / spd;
    var lead = Math.min(maxLead, t1);
    return { x: c.x + c.vx * lead, y: c.y + c.vy * lead, m: speed, stop: 0 };
  }

  // short zone defenders each pick up a different receiver in their area
  function computeZoneMatches(g, L) {
    var pairs = [], match = {}, taken = {};
    for (var i = 7; i < 14; i++) {
      var d = g.players[i];
      if (d.job !== 'zone' || d.deep) continue;
      for (var j = 0; j < 7; j++) {
        var r = g.players[j];
        if (!isElig(r) || r.job !== 'route' || r.x < L - 1.5) continue;
        var dz = dist(r.x, r.y, d.zx, d.zy);
        if (dz < d.zr + 2) pairs.push({ dz: dz, d: d.id, r: r.id });
      }
    }
    pairs.sort(function (a, b) { return a.dz - b.dz; });
    pairs.forEach(function (pr) {
      if (match[pr.d] || taken[pr.r]) return;
      match[pr.d] = pr.r; taken[pr.r] = true;
    });
    g.zoneMatch = match;
  }

  function zoneTarget(g, d, ctx) {
    var threat = null, bt = Infinity;
    if (!d.deep) {
      var mid = g.zoneMatch && g.zoneMatch[d.id];
      threat = mid ? P(g, mid) : null;
    }
    for (var i = 0; d.deep && i < 7; i++) {
      var r = g.players[i];
      if (!isElig(r) || r.job !== 'route') continue;
      if (r.x < ctx.L - 1) continue;
      var dz = dist(r.x, r.y, d.zx, d.zy);
      if (dz < d.zr + 2) {
        var score = dz - (d.deep ? r.x * 0.15 : 0);
        if (score < bt) { bt = score; threat = r; }
      }
    }
    var tx = d.zx, ty = d.zy;
    if (threat) {
      if (d.deep) {
        // stay on top, but shade toward the middle of the zone
        tx = Math.max(threat.x + threat.svx * 0.3 + 1.5 - d.beat * d.beat * 3.5, d.zx - 4);
        ty = d.zy + (threat.y + threat.svy * 0.3 - d.zy) * 0.6;
      } else {
        tx = threat.x + threat.svx * 0.4 + 0.9;
        ty = threat.y + threat.svy * 0.4;
      }
      var ox = tx - d.zx, oy = ty - d.zy, od = Math.sqrt(ox * ox + oy * oy);
      var lim = d.zr + 2;
      if (od > lim) { tx = d.zx + ox / od * lim; ty = d.zy + oy / od * lim; }
    }
    return { x: tx, y: ty, m: 1, stop: 0.2 };
  }

  // ---------------------------------------------------------------- CPU QB
  function evalTargets(g) {
    var qb = P(g, 'QB'), L = los(g), best = null;
    for (var i = 0; i < 7; i++) {
      var r = g.players[i];
      if (!isElig(r) || r.job !== 'route') continue;
      var T = passFlightTime(pd(qb, r)), px = r.x, py = r.y;
      for (var k = 0; k < 2; k++) {
        px = r.x + r.svx * T; py = r.y + r.svy * T;
        px = clamp(px, 0.5, 119.5); py = clamp(py, 1, FIELD_W - 1);
        T = passFlightTime(dist(qb.x, qb.y, px, py));
      }
      var tdist = dist(qb.x, qb.y, px, py);
      if (tdist > MAX_THROW) continue;
      var open = Infinity, lane = 0;
      for (var j = 7; j < 14; j++) {
        var d = g.players[j];
        var fx = d.x + d.svx * T * 0.6, fy = d.y + d.svy * T * 0.6;
        var od = dist(fx, fy, px, py);
        if (od < open) open = od;
        // passing lane check
        var sx = px - qb.x, sy = py - qb.y, sl = sx * sx + sy * sy || 1;
        var u = ((d.x - qb.x) * sx + (d.y - qb.y) * sy) / sl;
        if (u > 0.15 && u < 0.85) {
          var lx = qb.x + sx * u, ly = qb.y + sy * u;
          if (dist(lx, ly, d.x, d.y) < 1.4) lane = 1.5;
        }
      }
      var depth = px - L;
      var score = Math.min(open, 3.5) - lane + clamp(depth * 0.12, -0.8, 2.2);
      if (g.down >= 3 && depth >= g.toGo) score += 1;
      if (g.offPlay === 'screen' && (r.id === 'RB' || r.id === 'TE')) score += 1.5;
      var noise = (g.readNoise && g.readNoise[r.id]) || 0;
      score += noise;
      if (!best || score > best.score) best = { r: r, x: px, y: py, open: open - lane + noise, trueOpen: open - lane, score: score };
    }
    return best;
  }

  function cpuQBThink(g) {
    var qb = P(g, 'QB'), t = g.liveT;
    if (t < g.cpuFirstRead) return;
    var nd = nearestDef(g, qb.x, qb.y);
    // under pressure the QB doesn't always get it off in time
    var pressured = nd.d < 2.4 && rand(g) < 0.06;
    var best = evalTargets(g);
    var forced = t >= 2.6 || pressured;
    if (best && g.misread && (best.open >= g.cpuOpenNeed || forced)) {
      // misread: throws to a different receiver than the best one
      var alts = ELIGIBLE.map(function (id) { return P(g, id); }).filter(function (r) { return r.job === 'route' && r !== best.r; });
      if (alts.length) {
        var r = alts[Math.floor(rand(g) * alts.length)];
        var T = passFlightTime(pd(qb, r));
        g.misread = false;
        throwBall(g, r.x + r.svx * T, r.y + r.svy * T);
        return;
      }
    }
    if (!best) {
      if (forced) throwAway(g, qb);
      return;
    }
    if (best.open >= g.cpuOpenNeed || forced) {
      if (forced && best.open < 1.1 && rand(g) < 0.6) { throwAway(g, qb); return; }
      var err = 0.25 + (pressured ? 0.9 : 0) + Math.max(0, (pd(qb, best) - 20) * 0.02);
      var a = rand(g) * Math.PI * 2, m = rand(g) * err;
      var tx = best.x + Math.cos(a) * m, ty = best.y + Math.sin(a) * m;
      // occasionally the ball dies short of the receiver: trailing defenders feast
      if (rand(g) < 0.1 + (pressured ? 0.15 : 0) + (best.trueOpen < 2 ? 0.15 : 0)) {
        var ux = tx - qb.x, uy = ty - qb.y, ul = Math.sqrt(ux * ux + uy * uy) || 1;
        var short = Math.min(ul * 0.3, 2 + rand(g) * 2.5);
        tx -= ux / ul * short; ty -= uy / ul * short;
      }
      throwBall(g, tx, ty);
    }
  }

  function throwAway(g, qb) {
    var ty = qb.y < CY ? 0 : FIELD_W;
    throwBall(g, qb.x + 12, ty);
    g.intended = null;
  }

  // ---------------------------------------------------------------- actions
  function passFlightTime(distance) { return Math.max(0.15, distance / BALL_SPEED); }
  function passHeight(distance, t) { return 4 * distance * PASS_ARC * t * (1 - t) + (1 - t); }

  function throwBall(g, x, y) {
    var qb = P(g, 'QB'), b = g.ball;
    x = clamp(x, 0, 120); y = clamp(y, 0, FIELD_W);
    var dx = x - qb.x, dy = y - qb.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d > MAX_THROW) { x = qb.x + dx / d * MAX_THROW; y = qb.y + dy / d * MAX_THROW; d = MAX_THROW; }
    b.state = 'air'; b.holder = null;
    b.sx = qb.x; b.sy = qb.y; b.x = qb.x; b.y = qb.y; b.z = 1;
    b.tx = x; b.ty = y; b.airT = 0;
    b.dur = passFlightTime(d);
    b.distance = d;
    qb.hasTarget = false;
    // intended receiver: nearest eligible to the target
    var best = null, bd = 12;
    for (var i = 0; i < 7; i++) {
      var r = g.players[i];
      if (!isElig(r)) continue;
      var rd = dist(r.x, r.y, x, y);
      if (rd < bd) { bd = rd; best = r; }
    }
    g.intended = best ? best.id : null;
    emit(g, 'throw');
  }

  function doJuke(g, p) {
    if (p.jukeCd > 0) return false;
    p.jukeT = 0.4; p.jukeCd = 2.0;
    emit(g, 'juke');
    return true;
  }

  function resolveArrival(g) {
    var b = g.ball, rec = null, rd = Infinity, def = null, dd = Infinity;
    for (var i = 0; i < 14; i++) {
      var p = g.players[i];
      var d = dist(p.x, p.y, b.tx, b.ty);
      if (d > 1.6) continue;
      if (p.side === 'off') {
        if (!isElig(p)) continue;
        if (d < rd) { rd = d; rec = p; }
      } else if (d < dd) { dd = d; def = p; }
    }
    b.x = b.tx; b.y = b.ty; b.z = 0;
    if (def && dd <= 1.2 && dd < rd - 0.4) {
      if (rand(g) < 0.55) return endInterception(g, def);
      return endIncomplete(g);
    }
    if (rec) {
      var pc = 0.92 - 0.3 * (def && dd <= 1.0 ? 1 : 0);
      if (rand(g) < pc && rec.y >= 0 && rec.y <= FIELD_W && rec.x <= 120) {
        b.state = 'held'; b.holder = rec.id; b.z = 1;
        rec.hasTarget = false;
        emit(g, 'catch');
        return;
      }
    }
    return endIncomplete(g);
  }

  // ---------------------------------------------------------------- play endings
  function setPending(g, possession, ballOn, down, toGo) {
    g.pending = { possession: possession, ballOn: ballOn, down: down, toGo: toGo };
  }

  function endPlayCommon(g) {
    emit(g, 'whistle');
    g.ball.state = 'dead';
    g.ball.holder = null;
  }

  function endTouchdown(g, scorer) {
    endPlayCommon(g);
    var off = g.possession;
    g.score[off] += 7;
    emit(g, 'td');
    setPending(g, 1 - off, 25, 1, 10);
    enterResult(g, 'TOUCHDOWN!', g.teamNames[off] + ' +7' + (scorer ? ', ' + scorer : '') + ', PAT good');
  }

  function endSafety(g) {
    endPlayCommon(g);
    var def = 1 - g.possession;
    g.score[def] += 2;
    emit(g, 'tackle');
    setPending(g, def, 25, 1, 10);
    enterResult(g, 'SAFETY!', g.teamNames[def] + ' +2');
  }

  function endIncomplete(g) {
    endPlayCommon(g);
    emit(g, 'incomplete');
    var down = g.down + 1;
    if (down > 4) {
      emit(g, 'turnover');
      var nb = 100 - g.ballOn;
      setPending(g, 1 - g.possession, nb, 1, goalToGo(nb));
      enterResult(g, 'TURNOVER ON DOWNS', 'Incomplete pass');
    } else {
      setPending(g, g.possession, g.ballOn, down, g.toGo);
      enterResult(g, 'INCOMPLETE', downText(down, g.toGo, g.ballOn));
    }
  }

  function endInterception(g, def) {
    endPlayCommon(g);
    emit(g, 'int');
    emit(g, 'turnover');
    var x = def.x, nb, sub;
    if (x < 10) {
      // picked off in the offense's own endzone: defensive touchdown (pick six),
      // then the team that threw it gets the ball back at its own 25
      var off = g.possession, dteam = 1 - off;
      g.score[dteam] += 7;
      emit(g, 'td');
      setPending(g, off, 25, 1, 10);
      enterResult(g, 'PICK SIX!', g.teamNames[dteam] + ' +7, ' + def.id + ' in the endzone, PAT good');
      return;
    }
    if (x >= 110) { nb = 20; sub = 'Touchback'; }
    else { nb = clamp(Math.round(100 - (x - 10)), 1, 99); sub = g.teamNames[1 - g.possession] + ' ball'; }
    setPending(g, 1 - g.possession, nb, 1, goalToGo(nb));
    g.clock = Math.max(0, g.clock - RUNOFF);
    enterResult(g, 'INTERCEPTED!', sub);
  }

  // how: 'tackle' | 'sack' | 'oob' | 'whistle'
  function endDown(g, x, how) {
    if (x >= 110) return endTouchdown(g, null);
    if (x < 10) return endSafety(g);
    endPlayCommon(g);
    if (how === 'sack') emit(g, 'sack');
    else if (how === 'tackle') emit(g, 'tackle');
    var spot = clamp(Math.round(x - 10), 1, 99);
    var gain = spot - g.ballOn;
    var gainTxt = gain > 0 ? 'Gain of ' + gain : (gain < 0 ? 'Loss of ' + (-gain) : 'No gain');
    if (how === 'oob') gainTxt += ', Out of bounds';
    if (how === 'whistle') gainTxt += ', Whistle';
    if (how !== 'oob') g.clock = Math.max(0, g.clock - RUNOFF);
    var off = g.possession;
    if (spot >= g.ballOn + g.toGo) {
      emit(g, 'first_down');
      setPending(g, off, spot, 1, goalToGo(spot));
      return enterResult(g, how === 'sack' ? 'SACKED' : '1ST DOWN', gainTxt);
    }
    var down = g.down + 1, toGo = g.ballOn + g.toGo - spot;
    if (down > 4) {
      emit(g, 'turnover');
      var nb = 100 - spot;
      setPending(g, 1 - off, nb, 1, goalToGo(nb));
      return enterResult(g, 'TURNOVER ON DOWNS', (how === 'sack' ? 'Sacked, ' : '') + gainTxt);
    }
    setPending(g, off, spot, down, toGo);
    var msg;
    if (how === 'sack') msg = gain < 0 ? 'SACKED ' + gain : 'SACKED';
    else if (gain > 0) msg = 'GAIN OF ' + gain;
    else if (gain < 0) msg = 'LOSS OF ' + (-gain);
    else msg = 'NO GAIN';
    enterResult(g, msg, gainTxt + ', ' + downText(down, toGo, spot));
  }

  function doPunt(g) {
    var off = g.possession, landing = g.ballOn + 40, nb, sub;
    if (landing >= 100 || 100 - landing < 20) { nb = 20; sub = 'Touchback'; }
    else { nb = 100 - landing; sub = 'Net 40 yards'; }
    setPending(g, 1 - off, nb, 1, goalToGo(nb));
    emit(g, 'whistle');
    enterResult(g, 'PUNT', sub);
  }

  function fgDistance(g) { return (100 - g.ballOn) + 17; }
  function fgThreshold(g) { return clamp(0.65 - (fgDistance(g) - 20) * 0.012, 0.08, 0.6); }

  function lockKick(g, value) {
    if (g.phase !== 'kick' || g.kickLocked) return;
    g.kickLocked = true;
    g.kickMeter = clamp(value, -1, 1);
    var off = g.possession, distY = fgDistance(g);
    if (Math.abs(g.kickMeter) < fgThreshold(g)) {
      g.score[off] += 3;
      emit(g, 'fg_good');
      setPending(g, 1 - off, 25, 1, 10);
      enterResult(g, 'FIELD GOAL GOOD', distY + ' yards, ' + g.teamNames[off] + ' +3');
    } else {
      emit(g, 'fg_miss');
      emit(g, 'turnover');
      var nb = Math.max(20, 100 - g.ballOn);
      setPending(g, 1 - off, nb, 1, goalToGo(nb));
      enterResult(g, 'NO GOOD', distY + '-yard attempt ' + (g.kickMeter < 0 ? 'wide left' : 'wide right'));
    }
  }

  // ---------------------------------------------------------------- step
  function step(g, dt) {
    if (!g || g.paused || g.phase === 'gameover') return;
    if (!fin(dt) || dt <= 0) return;
    if (dt > 0.1) dt = 0.1;
    switch (g.phase) {
      case 'playcall':
        g.phaseTime -= dt;
        if (g.picks[0] && g.picks[1]) enterPresnap(g);
        else if (g.phaseTime <= 0) enterPresnap(g);
        break;
      case 'presnap':
        g.phaseTime -= dt;
        presnapMove(g, dt);
        if (g.phaseTime <= 0) {
          if (g.offPlay === 'punt') doPunt(g);
          else if (g.offPlay === 'fg') enterKick(g);
          else startLive(g);
        }
        break;
      case 'live':
        stepLive(g, dt);
        break;
      case 'kick':
        g.kickT += dt;
        g.phaseTime = Math.max(0, KICK_TIME - g.kickT);
        g.kickMeter = Math.sin(g.kickT * 4);
        // CPU kicker taps when the swinging meter passes its (imperfect) aim point
        if (!g.humans[g.possession] && g.kickT >= g.cpuKickAt && Math.abs(g.kickMeter - g.cpuKickVal) < 0.12) lockKick(g, g.kickMeter);
        else if (g.kickT >= KICK_TIME) lockKick(g, rand(g) * 2 - 1);
        break;
      case 'result':
        g.phaseTime -= dt;
        coast(g, dt);
        if (g.phaseTime <= 0) finishResult(g);
        break;
    }
  }

  function coast(g, dt) {
    var k = Math.exp(-dt * 4.2);
    g.players.forEach(function (p) {
      p.vx *= k; p.vy *= k;
      if (Math.abs(p.vx) < 0.01) p.vx = 0;
      if (Math.abs(p.vy) < 0.01) p.vy = 0;
      p.x = clamp(p.x + p.vx * dt, 0, 120);
      p.y = clamp(p.y + p.vy * dt, -1, FIELD_W + 1);
    });
  }

  function stepLive(g, dt) {
    g.liveT += dt;
    g.phaseTime = g.liveT;
    g.clock = Math.max(0, g.clock - dt);
    var L = los(g), b = g.ball, qb = P(g, 'QB'), i, p;
    var offHuman = g.humans[g.possession];

    for (i = 0; i < 14; i++) {
      p = g.players[i];
      if (p.jukeT > 0) {
        p.jukeT = Math.max(0, p.jukeT - dt);
        // plant foot: brief slowdown after the cut (human-steered carriers only; the CPU
        // carrier's cruder steering keeps the full-strength juke)
        if (p.jukeT <= 0 && offHuman) p.recT = JUKE_REC;
      } else if (p.recT > 0) p.recT = Math.max(0, p.recT - dt);
      if (p.jukeCd > 0) p.jukeCd = Math.max(0, p.jukeCd - dt);
      if (p.stunT > 0) p.stunT = Math.max(0, p.stunT - dt);
      if (p.freeT > 0) p.freeT = Math.max(0, p.freeT - dt);
    }

    // automatic handoff on run plays
    if (g.offPlay === 'run' && !g.handedOff && b.state === 'held' && b.holder === 'QB' && g.liveT >= 0.4) {
      g.handedOff = true;
      b.holder = 'RB';
      qb.hasTarget = false;
      P(g, 'RB').hasTarget = false;
    }
    if (b.state === 'held' && b.holder === 'QB' && qb.x > L + 1) g.qbRan = true;

    if (!offHuman && b.state === 'held' && b.holder === 'QB' && g.offPlay !== 'run' && !g.qbRan) cpuQBThink(g);

    var carrier = b.state === 'held' ? P(g, b.holder) : null;
    if (carrier && carrier.id !== g.lastCarrier) { g.lastCarrier = carrier.id; g.carrierT = 0; }
    g.carrierT += dt;
    var ctx = {
      L: L, carrier: carrier, air: b.state === 'air',
      pursuit: !!carrier && (carrier.id !== 'QB' || g.qbRan || qb.x > L)
    };

    // blocking engagement -> defender slow factors
    var slow = {};
    for (i = 7; i < 14; i++) {
      var d = g.players[i], f = 1, engagedBy = null;
      if (d.freeT <= 0) {
        for (var j = 0; j < 7; j++) {
          var o = g.players[j];
          if (o.blockId !== d.id || o.stunT > 0 || o === carrier) continue;
          if (pd(o, d) < BLOCK_DIST && o.blockF < f) { f = o.blockF; engagedBy = o; }
        }
      }
      if (engagedBy) {
        d.engageT += dt;
        if (d.engageT > d.shedAt) {
          d.freeT = 0.9; d.engageT = 0; d.shedAt = 1.8 + rand(g) * 2.2;
          engagedBy.stunT = 0.6;
          f = 1;
        }
      } else {
        d.engageT = Math.max(0, d.engageT - dt * 0.5);
      }
      slow[d.id] = f;
    }

    computeZoneMatches(g, L);

    // brains + steering
    for (i = 0; i < 14; i++) {
      p = g.players[i];
      var br = p.side === 'off' ? offBrain(g, p, ctx) : defBrain(g, p, ctx);
      var base = SPEED[p.id] * (br.m == null ? 1 : br.m);
      if (p.jukeT > 0) base *= 1.35;
      else if (p.recT > 0) base *= JUKE_REC_SPEED;
      if (p.side === 'def') base *= slow[p.id];
      var accelTime = br.human ? HUMAN_ACCEL_TIME : (p.side === 'off' ? 0.30 : 0.35);
      var accel = SPEED[p.id] / accelTime;
      if (p.jukeT > 0) accel *= 2;
      steer(p, fin(br.x) ? br.x : p.x, fin(br.y) ? br.y : p.y, base, accel, dt, br.stop || 0);
    }

    // integrate
    var sm = Math.min(1, dt / 0.25);
    for (i = 0; i < 14; i++) {
      p = g.players[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p !== carrier) {
        p.x = clamp(p.x, 0, 120);
        p.y = clamp(p.y, -1, FIELD_W + 1);
      }
      p.svx += (p.vx - p.svx) * sm;
      p.svy += (p.vy - p.svy) * sm;
    }

    // fighting for position at the catch point: whoever got there first keeps it
    if (b.state === 'air') {
      for (i = 0; i < 7; i++) {
        var rr = g.players[i];
        if (!isElig(rr) || dist(rr.x, rr.y, b.tx, b.ty) > 3) continue;
        for (var k = 7; k < 14; k++) {
          var dfd = g.players[k];
          var ddx = dfd.x - rr.x, ddy = dfd.y - rr.y, dds = Math.sqrt(ddx * ddx + ddy * ddy);
          if (dds >= 0.8 || dist(dfd.x, dfd.y, b.tx, b.ty) > 3) continue;
          if (dds < 1e-4) { ddx = 0; ddy = 1; dds = 1; }
          var push = 0.8 - dds;
          var rT = dist(rr.x, rr.y, b.tx, b.ty), dTg = dist(dfd.x, dfd.y, b.tx, b.ty);
          if (rT <= dTg) { dfd.x += ddx / dds * push; dfd.y += ddy / dds * push; }
          else { rr.x -= ddx / dds * push; rr.y -= ddy / dds * push; }
        }
      }
    }

    // blockers hold their ground: an engaged defender can't walk through its blocker
    for (i = 0; i < 7; i++) {
      var bo = g.players[i];
      if (!bo.blockId || bo.stunT > 0 || bo === carrier) continue;
      var bd = P(g, bo.blockId);
      if (!bd || bd.freeT > 0 || (g.humans[1 - g.possession] && bd.id === g.userDefenderId && bd.hasTarget && bo.blockF > 0.5)) continue;
      var sx = bd.x - bo.x, sy = bd.y - bo.y, sd = Math.sqrt(sx * sx + sy * sy);
      if (sd < 0.8) {
        if (sd < 1e-4) { sx = 1; sy = 0; sd = 1; }
        // the defender gets pushed out, the blocker gives a little ground
        var ov = 0.8 - sd, share = bo.blockF < 0.5 ? 0.45 : 0.6;
        bd.x += sx / sd * ov * (1 - share); bd.y += sy / sd * ov * (1 - share);
        bo.x -= sx / sd * ov * share; bo.y -= sy / sd * ov * share;
      }
    }

    // pushes may have moved non-carriers: keep them on the field
    for (i = 0; i < 14; i++) {
      p = g.players[i];
      if (p === carrier) continue;
      p.x = clamp(p.x, 0, 120);
      p.y = clamp(p.y, -1, FIELD_W + 1);
    }

    // ball
    if (b.state === 'held' && carrier) {
      b.x = carrier.x; b.y = carrier.y; b.z = 1;
    } else if (b.state === 'air') {
      b.airT += dt;
      var t = Math.min(1, b.airT / b.dur);
      b.x = b.sx + (b.tx - b.sx) * t;
      b.y = b.sy + (b.ty - b.sy) * t;
      b.z = passHeight(b.distance, t);
      if (t >= 1) {
        resolveArrival(g);
        if (g.phase !== 'live') return;
      }
    }

    // carrier checks
    carrier = b.state === 'held' ? P(g, b.holder) : null;
    if (carrier) {
      b.x = carrier.x; b.y = carrier.y;
      if (carrier.x >= 110) return endTouchdown(g, carrier.id);
      if (carrier.x < 0) return endSafety(g);
      if (carrier.y < 0 || carrier.y > FIELD_W) return endDown(g, carrier.x, 'oob');
      if (carrier.jukeT <= 0) {
        for (i = 7; i < 14; i++) {
          if (pd(g.players[i], carrier) < TACKLE_DIST) {
            var sack = carrier.id === 'QB' && !g.handedOff && carrier.x < L;
            return endDown(g, carrier.x, sack ? 'sack' : 'tackle');
          }
        }
      }
    }

    // safety cutoff
    if (g.liveT >= MAX_LIVE) {
      if (b.state === 'air' || !carrier) return endIncomplete(g);
      var sk = carrier.id === 'QB' && !g.handedOff && carrier.x < L;
      return endDown(g, carrier.x, sk ? 'sack' : 'whistle');
    }
  }

  // ---------------------------------------------------------------- input
  function input(g, team, msg) {
    if (!g || !msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    if (team !== 0 && team !== 1) return;
    if (g.paused || g.phase === 'gameover') return;
    if (!g.humans[team]) return;
    var isOff = team === g.possession;
    var b = g.ball, p;
    switch (msg.t) {
      case 'pick': {
        if (g.phase !== 'playcall' || g.picks[team]) return;
        var play = msg.play;
        if (isOff) {
          if (OFF_PLAY_IDS.indexOf(play) < 0) return;
          if ((play === 'punt' || play === 'fg') && g.down !== 4) return;
        } else if (DEF_PLAY_IDS.indexOf(play) < 0) return;
        g.picks[team] = play;
        return;
      }
      case 'move': {
        if (g.phase !== 'live' || !fin(msg.x) || !fin(msg.y)) return;
        p = isOff ? controlledOff(g) : P(g, g.userDefenderId);
        if (!p) return;
        p.hasTarget = true;
        p.tx = clamp(msg.x, -3, 123);
        p.ty = clamp(msg.y, -3, FIELD_W + 3);
        p.targetSpeed = fin(msg.speed) ? clamp(msg.speed, 0, 1) : 1;
        return;
      }
      case 'stop': {
        if (g.phase !== 'live') return;
        p = isOff ? controlledOff(g) : P(g, g.userDefenderId);
        if (p) p.hasTarget = false;
        return;
      }
      case 'throw': {
        if (!isOff || g.phase !== 'live' || !fin(msg.x) || !fin(msg.y)) return;
        if (b.state !== 'held' || b.holder !== 'QB' || g.handedOff || g.qbRan) return;
        if (!canThrow(g)) return;
        throwBall(g, msg.x, msg.y);
        return;
      }
      case 'juke': {
        if (!isOff || g.phase !== 'live' || b.state !== 'held') return;
        doJuke(g, P(g, b.holder));
        return;
      }
      case 'select': {
        if (isOff || DEF_IDS.indexOf(msg.id) < 0) return;
        if (msg.id === g.userDefenderId) return;
        var old = P(g, g.userDefenderId);
        if (old) old.hasTarget = false;
        g.userDefenderId = msg.id;
        P(g, msg.id).hasTarget = false;
        return;
      }
      case 'kick': {
        if (!isOff || g.phase !== 'kick') return;
        var kv = g.kickMeter;
        // `at` = kick-phase elapsed time the kicker saw; small rounding overshoot is clamped
        if (fin(msg.at) && msg.at >= g.kickT - KICK_LAG_WINDOW && msg.at <= g.kickT + 0.02) {
          kv = Math.sin(Math.max(0, Math.min(msg.at, g.kickT)) * 4);
        }
        lockKick(g, kv);
        return;
      }
    }
  }

  // the QB still holds the ball and may legally throw (sim rules for `throw`)
  function canThrow(g) {
    var b = g.ball;
    return g.phase === 'live' && b.state === 'held' && b.holder === 'QB' && !g.handedOff && !g.qbRan &&
      P(g, 'QB').x <= los(g) + 1;
  }

  function controlledOff(g) {
    var b = g.ball;
    if (g.phase === 'live' && b.state === 'held' && b.holder) return P(g, b.holder);
    return null;
  }

  // ---------------------------------------------------------------- snapshot
  function snapshot(g) {
    var b = g.ball, off = g.possession;
    var players = g.players.map(function (p) {
      return {
        id: p.id, side: p.side, x: r2(p.x), y: r2(p.y), vx: r2(p.vx), vy: r2(p.vy),
        carrier: b.state === 'held' && b.holder === p.id,
        juking: p.jukeT > 0
      };
    });
    var controlled = null;
    if (g.humans[off]) {
      if (g.phase === 'live') controlled = (b.state === 'held' && b.holder) ? b.holder : null;
      else if (g.phase === 'playcall' || g.phase === 'presnap') controlled = 'QB';
    }
    var air = b.state === 'air';
    var hidePlays = g.phase === 'playcall' || g.phase === 'gameover';
    var events = g.events;
    g.events = [];
    return {
      phase: g.phase,
      phaseTime: r2(Math.max(0, g.phaseTime)),
      paused: !!g.paused,
      quarter: g.quarter,
      clock: r2(Math.max(0, g.clock)),
      score: [g.score[0], g.score[1]],
      teamNames: [g.teamNames[0], g.teamNames[1]],
      possession: off,
      down: g.down,
      toGo: g.toGo,
      ballOn: g.ballOn,
      picked: [!!g.picks[0], !!g.picks[1]],
      offPlay: hidePlays ? null : (g.offPlay || null),
      defPlay: hidePlays ? null : (g.defPlay || null),
      runHoleY: g.offPlay === 'run' && (g.phase === 'presnap' || g.phase === 'live') ? r2(g.runHoleY) : null,
      players: players,
      ball: {
        x: r2(b.x), y: r2(b.y), z: r2(Math.max(0, b.z)), state: b.state,
        holder: b.state === 'held' ? (b.holder || null) : null,
        tx: r2(air ? b.tx : b.x), ty: r2(air ? b.ty : b.y)
      },
      userDefenderId: g.userDefenderId,
      controlledOffId: controlled,
      kickMeter: fin(g.kickMeter) ? r2(g.kickMeter) : null,
      canThrow: canThrow(g),
      message: String(g.message || ''),
      sub: String(g.sub || ''),
      events: events,
      fourthDown: g.down === 4
    };
  }

  return {
    createGame: createGame,
    step: step,
    input: input,
    snapshot: snapshot,
    reset: reset,
    OFFENSE_PLAYS: OFFENSE_PLAYS,
    DEFENSE_PLAYS: DEFENSE_PLAYS,
    OFF_IDS: OFF_IDS.slice(),
    DEF_IDS: DEF_IDS.slice(),
    FIELD_WIDTH: FIELD_W,
    HUMAN_ACCEL_TIME: HUMAN_ACCEL_TIME,
    steer: steer,
    passFlightTime: passFlightTime,
    passHeight: passHeight,
    routePreview: routePreview,
    KICK_TIME: KICK_TIME,
    fgThreshold: function (ballOn) { return clamp(0.65 - (((100 - ballOn) + 17) - 20) * 0.012, 0.08, 0.6); }
  };
}));
