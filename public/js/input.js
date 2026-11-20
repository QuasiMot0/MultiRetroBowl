/* Gridiron Duel - touch / mouse controls -> sim input messages (window.Input) */
(function () {
  'use strict';

  var FW = 53.3;
  var MOVE_INTERVAL = 50;          // ms  (~20 move msgs / s max)
  var JUKE_COOLDOWN = 2000;        // ms (visual only, sim enforces)

  var canvas = null;
  var opts = null;                 // { send(msg), getView(), myTeam(), onTap() }

  var pid = null;                  // active field pointer
  var mode = null;                 // null | 'wait' | 'drag' | 'aim' | 'follow' | 'dead'
  var sx = 0, sy = 0, cx = 0, cy = 0;
  var lastSendT = 0, lastX = NaN, lastY = NaN;
  var lastPhase = null;
  var touchedThisPlay = false;
  var jukeAt = -1e9;
  var tmp = { x: 0, y: 0 };

  var aim = { active: false, qx: 0, qy: 0, tx: 0, ty: 0, valid: false, pull: 0, lock: null, lx: 0, ly: 0 };
  // where the finger is currently steering our player (field yards), for client-side prediction
  var steer = { active: false, x: 0, y: 0 };
  var selectHoldUntil = 0;         // after a defender switch, don't predict until the server agrees

  var btn = { juke: null, sw: null, kick: null };
  var vis = { juke: null, sw: null, kick: null, cool: null };

  function send(msg) { if (opts && opts.send) opts.send(msg); }
  function view() { return opts && opts.getView ? opts.getView() : null; }
  function isOffense(s) { return !!s && s.possession === opts.myTeam(); }

  function findP(s, id) {
    var ps = s && s.players;
    if (!ps || id == null) return null;
    for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
    return null;
  }
  function qbHolds(s) {
    return !!(s && s.ball && s.ball.state === 'held' && s.ball.holder === 'QB');
  }
  /** QB holds the ball AND the sim would still accept a throw (not past the line). */
  function canThrow(s) {
    return qbHolds(s) && !!s.canThrow;
  }
  /** Kick message stamped with the kick-phase time on screen, so the sim locks the
   *  meter where the player saw the needle (online view lags the server). */
  function kickMsg(s) {
    var kt = (window.GridSim && window.GridSim.KICK_TIME) || 4;
    var m = { t: 'kick' };
    if (s && typeof s.phaseTime === 'number' && isFinite(s.phaseTime)) {
      m.at = Math.round(Math.max(0, kt - s.phaseTime) * 1000) / 1000;
    }
    return m;
  }
  /** The offensive player this client steers as a ball carrier (not the QB in the pocket). */
  function controlledCarrier(s) {
    if (!s || !s.ball || s.ball.state !== 'held') return null;
    var id = s.controlledOffId;
    if (!id || s.ball.holder !== id) return null;
    return findP(s, id);
  }
  function clampX(x) { return Math.max(0, Math.min(120, x)); }
  function clampY(y) { return Math.max(-1.5, Math.min(FW + 1.5, y)); }

  // ------------------------------------------------------------------ gesture logic
  function resolveMode(s, initial) {
    if (!s || s.phase !== 'live') { mode = 'wait'; return; }
    Render.screenToField(cx, cy, tmp);
    if (isOffense(s)) {
      if (canThrow(s)) {
        var qb = findP(s, 'QB');
        var dx = qb ? tmp.x - qb.x : 99, dy = qb ? tmp.y - qb.y : 99;
        if (dx * dx + dy * dy <= 9) {
          mode = 'drag';
        } else {
          mode = 'aim';
          if (!initial) { sx = cx; sy = cy; }   // slingshot starts where the finger is now
        }
      } else if (controlledCarrier(s)) {
        mode = 'follow';
      } else {
        mode = 'wait';
      }
    } else {
      mode = 'follow';
    }
  }

  function trySelect(s) {
    if (!s || isOffense(s) || (s.phase !== 'live' && s.phase !== 'presnap' && s.phase !== 'playcall')) return;
    Render.screenToField(cx, cy, tmp);
    var best = null, bd = 1.5 * 1.5;
    var ps = s.players || [];
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (p.side !== 'def' || p.id === s.userDefenderId) continue;
      var dx = p.x - tmp.x, dy = (p.y - 0.8) - tmp.y;    // sprite center is ~0.8yd above the feet
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = p; }
    }
    if (best) {
      send({ t: 'select', id: best.id });
      // hold move messages briefly so they steer the newly selected defender
      lastSendT = performance.now() + 150;
      lastX = NaN;
      selectHoldUntil = performance.now() + 450;
    }
  }

  function sendMove(x, y, now, force) {
    x = clampX(x); y = clampY(y);
    if (!force) {
      if (now - lastSendT < MOVE_INTERVAL) return;
      if (Math.abs(x - lastX) < 0.08 && Math.abs(y - lastY) < 0.08) return;
    }
    lastX = x; lastY = y; lastSendT = now;
    send({ t: 'move', x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
  }

  function sendStop() {
    lastX = NaN; lastY = NaN;
    send({ t: 'stop' });
  }

  var ELIGIBLE = { RB: 1, WR1: 1, WR2: 1, TE: 1 };
  var LOCK_FULL = 2.2, LOCK_MAX = 3.6;   // yd: aim-assist radius around a receiver

  function computeAim(s) {
    var qb = findP(s, 'QB');
    if (!qb) { aim.active = false; return; }
    var ppy = Render.pxPerYard() || 1;
    var dx = (sx - cx) / ppy, dy = (sy - cy) / ppy;
    var pull = Math.sqrt(dx * dx + dy * dy);
    var tx = qb.x + dx * 2.2, ty = qb.y + dy * 2.2;
    // aim assist: put the X on (or near) a receiver and the throw leads him by the
    // ball's flight time, keeping your offset - so the marker shows where he'll catch it
    aim.lock = null;
    var ps = s.players || [], best = null, bd = LOCK_MAX;
    for (var i = 0; i < ps.length; i++) {
      var r = ps[i];
      if (r.side !== 'off' || !ELIGIBLE[r.id]) continue;
      var rd = Math.sqrt((r.x - tx) * (r.x - tx) + (r.y - ty) * (r.y - ty));
      if (rd < bd) { bd = rd; best = r; }
    }
    if (best) {
      var w = bd <= LOCK_FULL ? 1 : 1 - (bd - LOCK_FULL) / (LOCK_MAX - LOCK_FULL);
      var lx = tx, ly = ty, T = 0;
      for (var k = 0; k < 3; k++) {
        T = Math.sqrt((lx - qb.x) * (lx - qb.x) + (ly - qb.y) * (ly - qb.y)) / 24;
        lx = tx + (best.vx || 0) * T * w; ly = ty + (best.vy || 0) * T * w;
      }
      tx = lx; ty = ly;
      if (w > 0.5) { aim.lock = best.id; aim.lx = best.x; aim.ly = best.y; }
    }
    var ddx = tx - qb.x, ddy = ty - qb.y, d = Math.sqrt(ddx * ddx + ddy * ddy);
    if (d > 55) { tx = qb.x + ddx * 55 / d; ty = qb.y + ddy * 55 / d; }
    aim.qx = qb.x; aim.qy = qb.y;
    aim.tx = clampX(tx); aim.ty = Math.max(0, Math.min(FW, ty));
    aim.pull = pull;
    aim.valid = pull > 1.5 && canThrow(s);
    aim.active = true;
  }

  // Grab-style steering: if the touch lands on/near the player you steer, he keeps his
  // offset from the fingertip (and always sits at least GRAB_LIFT above it) so he stays
  // visible instead of hiding under your thumb. A touch elsewhere (e.g. on the ball
  // carrier you're chasing) is a plain "run here" target.
  var GRAB_R = 2.6, GRAB_LIFT = 1.3, GRAB_MAX = 2.6;
  var grab = { key: null, dx: 0, dy: 0 };
  function steerTarget(s, fx, fy, out) {
    var off = isOffense(s);
    var me = off ? findP(s, s.controlledOffId) : findDef(s, s.userDefenderId);
    if (!me) { out.x = fx; out.y = fy; return out; }
    var key = (off ? 'o' : 'd') + me.id;
    if (grab.key !== key) {
      // only the first player steered by this touch can be grabbed; after a SWITCH or
      // a handoff mid-touch the finger is a plain target again
      var first = grab.key === null;
      grab.key = key; grab.dx = 0; grab.dy = 0;
      var ddx = me.x - fx, ddy = me.y - fy;
      if (first && ddx * ddx + ddy * ddy <= GRAB_R * GRAB_R) {
        ddy = Math.min(ddy, -GRAB_LIFT);
        var dl = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dl > GRAB_MAX) { ddx *= GRAB_MAX / dl; ddy *= GRAB_MAX / dl; }
        grab.dx = ddx; grab.dy = ddy;
      }
    }
    out.x = fx + grab.dx; out.y = fy + grab.dy;
    return out;
  }
  function findDef(s, id) {
    var ps = s && s.players;
    if (!ps) return null;
    for (var i = 0; i < ps.length; i++) if (ps[i].id === id && ps[i].side === 'def') return ps[i];
    return null;
  }

  // ------------------------------------------------------------------ pointer handlers
  function onDown(e) {
    if (opts.onTap) opts.onTap();
    if (pid !== null) return;
    var s = view();
    if (!s) return;
    e.preventDefault();
    pid = e.pointerId;
    try { canvas.setPointerCapture(pid); } catch (err) { /* ignore */ }
    sx = cx = e.clientX; sy = cy = e.clientY;
    touchedThisPlay = true;
    grab.key = null;
    if (s.phase === 'kick') {
      if (isOffense(s)) send(kickMsg(s));
      mode = 'dead';
      return;
    }
    if (!isOffense(s)) trySelect(s);
    resolveMode(s, true);
  }

  function onMove(e) {
    if (e.pointerId !== pid) return;
    e.preventDefault();
    cx = e.clientX; cy = e.clientY;
  }

  function finish(e, cancelled) {
    if (e.pointerId !== pid) return;
    cx = e.clientX; cy = e.clientY;
    var s = view();
    if (mode === 'aim' && !cancelled && s && s.phase === 'live' && canThrow(s)) {
      computeAim(s);
      if (aim.valid) {
        send({ t: 'throw', x: Math.round(aim.tx * 100) / 100, y: Math.round(aim.ty * 100) / 100 });
      }
    } else if (mode === 'drag' || mode === 'follow') {
      if (s && s.phase === 'live') sendStop();
    }
    try { canvas.releasePointerCapture(pid); } catch (err) { /* ignore */ }
    pid = null;
    mode = null;
    aim.active = false;
    steer.active = false;
    grab.key = null;
  }

  /** Abort the current touch (page hidden, menu opened): never throws, stops the runner. */
  function cancel() {
    if (pid === null) return;
    var s = view();
    if ((mode === 'drag' || mode === 'follow') && s && s.phase === 'live') sendStop();
    try { canvas.releasePointerCapture(pid); } catch (err) { /* ignore */ }
    pid = null;
    mode = null;
    aim.active = false;
    steer.active = false;
  }

  // ------------------------------------------------------------------ buttons
  function pressFx(el) {
    el.classList.add('pressed');
    setTimeout(function () { el.classList.remove('pressed'); }, 120);
  }

  function doJuke() {
    var s = view();
    if (!s || s.phase !== 'live' || !isOffense(s)) return;
    send({ t: 'juke' });
    jukeAt = performance.now();
  }

  function doSwitch() {
    var s = view();
    if (!s || isOffense(s)) return;
    var b = s.ball;
    if (!b) return;
    var ps = s.players || [];
    var best = null, bd = Infinity;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (p.side !== 'def' || p.id === s.userDefenderId) continue;
      var dx = p.x - b.x, dy = p.y - b.y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = p; }
    }
    if (best) {
      send({ t: 'select', id: best.id });
      lastX = NaN;   // make sure the new defender receives the finger target
      selectHoldUntil = performance.now() + 450;
    }
  }

  function doKick() {
    var s = view();
    if (!s || s.phase !== 'kick' || !isOffense(s)) return;
    send(kickMsg(s));
  }

  function bindButton(el, fn) {
    if (!el) return;
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (opts.onTap) opts.onTap();
      pressFx(el);
      fn();
    });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function onKey(e) {
    if (!opts || !view()) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.code === 'Space' || e.key === ' ') {
      var s = view();
      if (s.phase === 'kick') doKick(); else if (isOffense(s)) doJuke(); else doSwitch();
      e.preventDefault();
    } else if (e.key === 's' || e.key === 'S' || e.key === 'Shift') {
      doSwitch();
    } else if (e.key === 'j' || e.key === 'J') {
      doJuke();
    } else if (e.key === 'k' || e.key === 'K') {
      doKick();
    }
  }

  // ------------------------------------------------------------------ public
  function init(c, o) {
    canvas = c;
    opts = o;
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', function (e) { finish(e, false); });
    c.addEventListener('pointercancel', function (e) { finish(e, true); });
    c.addEventListener('lostpointercapture', function (e) { if (e.pointerId === pid) finish(e, true); });
    c.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    btn.juke = document.getElementById('btnJuke');
    btn.sw = document.getElementById('btnSwitch');
    btn.kick = document.getElementById('btnKick');
    bindButton(btn.juke, doJuke);
    bindButton(btn.sw, doSwitch);
    bindButton(btn.kick, doKick);
    window.addEventListener('keydown', onKey);
  }

  /** Per-frame: convert the held finger into move targets / aim. */
  function update(now) {
    var s = view();
    steer.active = false;
    if (!s) { aim.active = false; return; }
    if (s.phase !== lastPhase) {
      if (s.phase === 'presnap' || s.phase === 'playcall') touchedThisPlay = false;
      lastPhase = s.phase;
      lastX = NaN; lastY = NaN;
      if (pid !== null && mode !== 'dead') mode = 'wait';
      aim.active = false;
      grab.key = null;
    }
    if (pid === null) { aim.active = false; return; }
    if (s.phase !== 'live') { aim.active = false; return; }

    if (mode === 'wait') resolveMode(s, false);
    // a scrambling QB who crossed the line can no longer throw: he's a runner now
    if (mode === 'drag' && !canThrow(s)) mode = controlledCarrier(s) ? 'follow' : 'wait';
    if (mode === 'aim' && !canThrow(s)) { mode = 'dead'; aim.active = false; }
    if (mode === 'follow' && isOffense(s) && !controlledCarrier(s)) mode = 'wait';

    if (mode === 'drag' || mode === 'follow') {
      Render.screenToField(cx, cy, tmp);
      steerTarget(s, tmp.x, tmp.y, tmp);
      sendMove(tmp.x, tmp.y, now, false);
      aim.active = false;
      if (performance.now() >= selectHoldUntil) {
        steer.active = true;
        steer.x = clampX(tmp.x);
        steer.y = clampY(tmp.y);
      }
    } else if (mode === 'aim') {
      computeAim(s);
    } else {
      aim.active = false;
    }
  }

  function setVis(key, el, on) {
    if (!el || vis[key] === on) return;
    vis[key] = on;
    el.classList.toggle('hidden', !on);
  }

  /** Show only the controls relevant to the current role / phase. */
  function updateControls(s, inGame) {
    var off = s && isOffense(s);
    var ph = s ? s.phase : null;
    var showJuke = false;
    if (inGame && s && ph === 'live' && off && s.ball && s.ball.state === 'held' &&
        s.controlledOffId && s.ball.holder === s.controlledOffId) {
      // any carrier, incl. a scrambling QB who can no longer throw
      showJuke = s.ball.holder !== 'QB' || !s.canThrow;
    }
    var showSwitch = !!(inGame && s && !off && (ph === 'live' || ph === 'presnap'));
    var showKick = !!(inGame && s && off && ph === 'kick');
    setVis('juke', btn.juke, showJuke);
    setVis('sw', btn.sw, showSwitch);
    setVis('kick', btn.kick, showKick);
    var cool = performance.now() - jukeAt < JUKE_COOLDOWN;
    if (btn.juke && vis.cool !== cool) { vis.cool = cool; btn.juke.classList.toggle('cool', cool); }
  }

  function reset() {
    pid = null;
    mode = null;
    aim.active = false;
    steer.active = false;
    selectHoldUntil = 0;
    lastX = NaN; lastY = NaN;
    lastPhase = null;
    touchedThisPlay = false;
    jukeAt = -1e9;
  }

  window.Input = {
    init: init,
    update: update,
    updateControls: updateControls,
    reset: reset,
    cancel: cancel,
    aim: aim,
    steer: steer,
    grab: grab,
    isTouching: function () { return pid !== null; },
    touchedThisPlay: function () { return touchedThisPlay; },
    qbHolds: qbHolds,
    canThrow: canThrow,
    controlledCarrier: controlledCarrier
  };
})();
