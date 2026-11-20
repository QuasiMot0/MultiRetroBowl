/* Gridiron Duel - touch, mouse and keyboard controls -> sim input messages (window.Input) */
(function () {
  'use strict';

  var FW = 53.3;
  var MOVE_INTERVAL = 50;          // ms  (~20 move msgs / s max)
  var JUKE_COOLDOWN = 2000;        // ms (visual only, sim enforces)

  var canvas = null;
  var opts = null;                 // { send(msg), getView(), myTeam(), onTap() }

  var movePointer = null, aimPointer = null;
  var waitingPointers = [];
  var moveKeys = { KeyW: false, KeyA: false, KeyS: false, KeyD: false };
  var lastSendT = -Infinity, lastX = NaN, lastY = NaN, lastSpeed;
  var movingId = null;
  var lastPhase = null;
  var touchedThisPlay = false;
  var jukeAt = -1e9;
  var tmp = { x: 0, y: 0 };

  var aim = { active: false, qx: 0, qy: 0, tx: 0, ty: 0, valid: false, pull: 0, lock: null, lx: 0, ly: 0 };
  // where the finger is currently steering our player (field yards), for client-side prediction
  var steer = { active: false, id: null, x: 0, y: 0, speed: 1 };
  var selectedDefender = null, selectHoldUntil = 0;
  var stick = { el: null, thumb: null, id: null, x: 0, y: 0, speed: 0, available: false };

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
  /** The offensive player this client steers as a ball carrier, including the QB. */
  function controlledCarrier(s) {
    if (!s || !s.ball || s.ball.state !== 'held') return null;
    var id = s.controlledOffId;
    if (!id || s.ball.holder !== id) return null;
    return findP(s, id);
  }
  function clampX(x) { return Math.max(0, Math.min(120, x)); }
  function clampY(y) { return Math.max(-1.5, Math.min(FW + 1.5, y)); }

  // ------------------------------------------------------------------ gesture logic
  function assignPointer(p, s) {
    p.startX = p.x; p.startY = p.y;
    if (stick.available && p.type !== 'mouse' && isOffense(s) && s.controlledOffId === 'QB') {
      if (aimPointer || !canThrow(s)) return false;
      aimPointer = p;
      return true;
    }
    if (isOffense(s) && canThrow(s) && !aimPointer) {
      Render.screenToField(p.x, p.y, tmp);
      var qb = findP(s, 'QB');
      var dx = qb ? tmp.x - qb.x : Infinity, dy = qb ? tmp.y - qb.y : Infinity;
      // The first touch keeps the QB grab. A second touch takes the free role.
      if (movePointer || p.type === 'mouse' || dx * dx + dy * dy > 9) {
        aimPointer = p;
        return true;
      }
    }
    if (movePointer) return false;
    grab.key = null;
    movePointer = p;
    return true;
  }

  function trySelect(s, p) {
    Render.screenToField(p.x, p.y, tmp);
    var best = null, bd = 1.5 * 1.5;
    var ps = s.players || [];
    for (var i = 0; i < ps.length; i++) {
      var dfn = ps[i];
      if (dfn.side !== 'def' || dfn.id === s.userDefenderId) continue;
      var dx = dfn.x - tmp.x, dy = (dfn.y - 0.8) - tmp.y;  // sprite center is ~0.8yd above the feet
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = dfn; }
    }
    if (best) selectDefender(best.id);
  }

  function sendMove(id, x, y, now, speed) {
    if (now - lastSendT < MOVE_INTERVAL) return;
    if (speed !== undefined) speed = Math.round(speed * 100) / 100;
    if (movingId === id && speed === lastSpeed && Math.abs(x - lastX) < 0.08 && Math.abs(y - lastY) < 0.08) return;
    movingId = id;
    lastX = x; lastY = y; lastSendT = now; lastSpeed = speed;
    var msg = { t: 'move', x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    if (speed !== undefined) msg.speed = speed;
    send(msg);
  }

  function stopMoving(s) {
    if (movingId && s && s.phase === 'live' && !s.paused) send({ t: 'stop' });
    movingId = null;
    steer.active = false;
  }

  var ELIGIBLE = { RB: 1, WR1: 1, WR2: 1, TE: 1 };
  var LOCK_FULL = 2.2, LOCK_MAX = 3.6;   // yd: aim-assist radius around a receiver

  function computeAim(s, p) {
    var qb = findP(s, 'QB');
    if (!qb) { aim.active = false; return; }
    var ppy = Render.pxPerYard() || 1;
    var dx = (p.startX - p.x) / ppy, dy = (p.startY - p.y) / ppy;
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
      var flightTime = window.GridSim && window.GridSim.passFlightTime;
      var w = bd <= LOCK_FULL ? 1 : 1 - (bd - LOCK_FULL) / (LOCK_MAX - LOCK_FULL);
      var lx = tx, ly = ty, T = 0;
      for (var k = 0; k < 3; k++) {
        var distance = Math.hypot(lx - qb.x, ly - qb.y);
        T = flightTime ? flightTime(distance) : distance / 23;
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
  function steerTarget(me, fx, fy, out) {
    var key = me.id;
    if (grab.key !== key) {
      // only the first player steered by this touch can be grabbed; after a SWITCH or
      // a handoff mid-touch the finger is a plain target again
      var first = grab.key === null;
      grab.key = key; grab.dx = 0; grab.dy = 0;
      if (first) {
        Render.screenToField(movePointer.startX, movePointer.startY, out);
        var ddx = me.x - out.x, ddy = me.y - out.y;
        if (ddx * ddx + ddy * ddy <= GRAB_R * GRAB_R) {
          ddy = Math.min(ddy, -GRAB_LIFT);
          var dl = Math.sqrt(ddx * ddx + ddy * ddy);
          if (dl > GRAB_MAX) { ddx *= GRAB_MAX / dl; ddy *= GRAB_MAX / dl; }
          grab.dx = ddx; grab.dy = ddy;
        }
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
    var s = view();
    if (!s || s.paused || e.button !== 0) return;
    syncPhase(s);
    e.preventDefault();
    if (opts.onTap) opts.onTap();
    if (s.phase === 'kick') {
      if (isOffense(s)) send(kickMsg(s));
      return;
    }
    var p = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY };
    if (s.phase === 'live') {
      if (!assignPointer(p, s)) return;
    } else if (s.phase === 'presnap' || s.phase === 'playcall') {
      if (waitingPointers.length >= (isOffense(s) ? 2 : 1)) return;
      waitingPointers.push(p);
    } else return;
    touchedThisPlay = true;
    if (!isOffense(s)) trySelect(s, p);
    try { canvas.setPointerCapture(p.id); } catch (err) { /* ignore */ }
  }

  function pointerFor(id) {
    if (movePointer && movePointer.id === id) return movePointer;
    if (aimPointer && aimPointer.id === id) return aimPointer;
    for (var i = 0; i < waitingPointers.length; i++) {
      if (waitingPointers[i].id === id) return waitingPointers[i];
    }
    return null;
  }

  function onMove(e) {
    var p = pointerFor(e.pointerId);
    if (!p) return;
    e.preventDefault();
    p.x = e.clientX; p.y = e.clientY;
  }

  function finish(e, cancelled) {
    var s = view();
    // A pre-snap pointer released before the first live frame has not started an aim.
    var p = pointerFor(e.pointerId);
    if (!p) return;
    if (p === aimPointer) {
      aimPointer = null;
      if (!cancelled && s && !s.paused && s.phase === 'live' && isOffense(s) && canThrow(s)) {
        p.x = e.clientX; p.y = e.clientY;
        computeAim(s, p);
        if (aim.active && aim.valid) {
          send({ t: 'throw', x: Math.round(aim.tx * 100) / 100, y: Math.round(aim.ty * 100) / 100 });
        }
      }
      aim.active = false;
    } else if (p === movePointer) {
      movePointer = null;
      grab.key = null;
      if (stick.id === null && !keyX() && !keyY()) stopMoving(s);
    } else {
      waitingPointers.splice(waitingPointers.indexOf(p), 1);
    }
    releasePointer(p);
  }

  function releasePointer(p) {
    if (!p) return;
    try { canvas.releasePointerCapture(p.id); } catch (err) { /* ignore */ }
  }

  function clearPointers() {
    var move = movePointer, a = aimPointer;
    movePointer = aimPointer = null;
    aim.active = false;
    grab.key = null;
    releasePointer(move); releasePointer(a);
    if (waitingPointers.length) waitingPointers.splice(0).forEach(releasePointer);
    clearStick();
  }

  function clearStick() {
    if (stick.id === null) return;
    var id = stick.id;
    stick.id = null;
    stick.x = stick.y = stick.speed = 0;
    stick.thumb.style.transform = '';
    try { stick.el.releasePointerCapture(id); } catch (err) { /* ignore */ }
  }

  function readStick(e) {
    var rect = stick.el.getBoundingClientRect();
    var dx = e.clientX - rect.left - rect.width / 2, dy = e.clientY - rect.top - rect.height / 2;
    var radius = rect.width * 0.34;
    var distance = Math.hypot(dx, dy);
    var scale = distance > 0 ? Math.min(1, radius / distance) : 0;
    stick.x = dx * scale; stick.y = dy * scale;
    stick.speed = Math.max(0, (Math.min(1, distance / radius) - 0.12) / 0.88);
    stick.thumb.style.transform = 'translate(' + stick.x + 'px,' + stick.y + 'px)';
  }

  function bindStick() {
    stick.el = document.getElementById('moveStick');
    if (!stick.el) return;
    stick.thumb = stick.el.firstElementChild;
    stick.available = !!(window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches);
    stick.el.addEventListener('pointerdown', function (e) {
      var s = view();
      if (!s || s.paused || !isOffense(s) || stick.id !== null || e.button !== 0 ||
          (s.phase !== 'presnap' && s.phase !== 'live')) return;
      e.preventDefault();
      syncPhase(s);
      if (opts.onTap) opts.onTap();
      stick.id = e.pointerId;
      touchedThisPlay = true;
      readStick(e);
      try { stick.el.setPointerCapture(stick.id); } catch (err) { /* ignore */ }
    });
    stick.el.addEventListener('pointermove', function (e) {
      if (e.pointerId === stick.id) readStick(e);
    });
    function finishStick(e) {
      if (e.pointerId !== stick.id) return;
      clearStick();
      if (!movePointer && !keyX() && !keyY()) stopMoving(view());
    }
    stick.el.addEventListener('pointerup', finishStick);
    stick.el.addEventListener('pointercancel', finishStick);
    stick.el.addEventListener('lostpointercapture', finishStick);
  }

  function clearKeys() {
    moveKeys.KeyW = moveKeys.KeyA = moveKeys.KeyS = moveKeys.KeyD = false;
  }

  /** Abort input on blur, page hide, or menu open without releasing a pass. */
  function cancel() {
    clearPointers();
    clearKeys();
    stopMoving(view());
  }

  // ------------------------------------------------------------------ buttons
  function pressFx(el) {
    el.classList.add('pressed');
    setTimeout(function () { el.classList.remove('pressed'); }, 120);
  }

  function doJuke() {
    var s = view();
    if (!s || s.paused || s.phase !== 'live' || !isOffense(s)) return;
    send({ t: 'juke' });
    jukeAt = performance.now();
  }

  function selectDefender(id) {
    send({ t: 'select', id: id });
    selectedDefender = id;
    selectHoldUntil = performance.now() + 450;
    movingId = null;  // the sim clears the old defender's target on select
    steer.active = false;
  }

  function doSwitch() {
    var s = view();
    if (!s || s.paused || isOffense(s) || (s.phase !== 'live' && s.phase !== 'presnap' && s.phase !== 'playcall')) return;
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
    if (best) selectDefender(best.id);
  }

  function doKick() {
    var s = view();
    if (!s || s.paused || s.phase !== 'kick' || !isOffense(s)) return;
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

  function keyX() { return Number(moveKeys.KeyD) - Number(moveKeys.KeyA); }
  function keyY() { return Number(moveKeys.KeyS) - Number(moveKeys.KeyW); }

  function onKeyDown(e) {
    var s = view();
    if (!s || s.paused || e.altKey || e.ctrlKey || e.metaKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    syncPhase(s);
    if (Object.prototype.hasOwnProperty.call(moveKeys, e.code)) {
      if ((s.phase === 'live' || s.phase === 'presnap') && (!e.repeat || moveKeys[e.code])) {
        moveKeys[e.code] = true;
        touchedThisPlay = true;
        e.preventDefault();
      }
    } else if ((e.code === 'Space' || e.key === ' ') && (s.phase === 'live' || s.phase === 'kick')) {
      e.preventDefault();
      if (e.repeat) return;
      if (s.phase === 'kick') doKick(); else if (isOffense(s)) doJuke(); else doSwitch();
    } else if (e.repeat) return;
    else if (e.key === 'Shift') {
      doSwitch();
    } else if (e.key === 'j' || e.key === 'J') {
      doJuke();
    } else if (e.key === 'k' || e.key === 'K') {
      doKick();
    }
  }

  function onKeyUp(e) {
    if (!Object.prototype.hasOwnProperty.call(moveKeys, e.code)) return;
    moveKeys[e.code] = false;
    if (!movePointer && stick.id === null && !keyX() && !keyY()) stopMoving(view());
  }

  // ------------------------------------------------------------------ public
  function init(c, o) {
    canvas = c;
    opts = o;
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', function (e) { finish(e, false); });
    c.addEventListener('pointercancel', function (e) { finish(e, true); });
    c.addEventListener('lostpointercapture', function (e) { finish(e, true); });
    c.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    btn.juke = document.getElementById('btnJuke');
    btn.sw = document.getElementById('btnSwitch');
    btn.kick = document.getElementById('btnKick');
    bindStick();
    bindButton(btn.juke, doJuke);
    bindButton(btn.sw, doSwitch);
    bindButton(btn.kick, doKick);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', cancel);
  }

  function syncPhase(s) {
    if (s.phase === lastPhase) return;
    if (lastPhase === 'live') {
      clearPointers();
      clearKeys();
    }
    if (s.phase === 'presnap' || s.phase === 'playcall') touchedThisPlay = false;
    if (s.phase === 'live') {
      var waiting = waitingPointers.splice(0);
      for (var i = 0; i < waiting.length; i++) {
        if (!assignPointer(waiting[i], s)) releasePointer(waiting[i]);
      }
      if (waiting.length) touchedThisPlay = true;
    } else if (s.phase !== 'presnap' && s.phase !== 'playcall') {
      clearPointers();
    }
    lastPhase = s.phase;
    movingId = null;
    lastSendT = -Infinity;
    steer.active = false;
  }

  function directionTarget(p, dx, dy, out) {
    // Keep the target on the input ray near the boundaries, including the out-of-bounds margin.
    var length = Math.hypot(dx, dy);
    dx /= length; dy /= length;
    var distance = 8;
    if (dx) distance = Math.min(distance, (dx > 0 ? 121.5 - p.x : p.x + 1.5) / Math.abs(dx));
    if (dy) distance = Math.min(distance, (dy > 0 ? FW + 1.5 - p.y : p.y + 1.5) / Math.abs(dy));
    distance = Math.max(0, distance);
    out.x = p.x + dx * distance;
    out.y = p.y + dy * distance;
  }

  function updateSteering(s, now) {
    var off = isOffense(s), dx = keyX(), dy = keyY();
    if (!off && selectedDefender) {
      if (s.userDefenderId !== selectedDefender && now < selectHoldUntil) return;
      selectedDefender = null;
    }
    var player = off ? controlledCarrier(s) : findDef(s, s.userDefenderId);
    var usingStick = off && stick.id !== null;
    var speed;
    if (!player || (!movePointer && !usingStick && !dx && !dy)) {
      stopMoving(s);
      return;
    }
    if (dx || dy) {
      directionTarget(player, dx, dy, tmp);
    } else if (usingStick) {
      speed = stick.speed;
      if (speed > 0) directionTarget(player, stick.x, stick.y, tmp);
      else { tmp.x = player.x; tmp.y = player.y; }
    } else {
      Render.screenToField(movePointer.x, movePointer.y, tmp);
      steerTarget(player, tmp.x, tmp.y, tmp);
      tmp.x = clampX(tmp.x); tmp.y = clampY(tmp.y);
    }
    sendMove(player.id, tmp.x, tmp.y, now, speed);
    steer.active = true;
    steer.id = player.id;
    steer.x = tmp.x;
    steer.y = tmp.y;
    steer.speed = speed === undefined ? 1 : speed;
  }

  /** Per-frame: update steering and aim independently. */
  function update(now) {
    var s = view();
    if (!s || s.paused) { cancel(); return; }
    syncPhase(s);
    if (s.phase !== 'live') return;
    updateSteering(s, now);
    if (aimPointer) {
      if (isOffense(s) && canThrow(s)) {
        computeAim(s, aimPointer);
      } else {
        var p = aimPointer;
        aimPointer = null;
        aim.active = false;
        releasePointer(p);
      }
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
    setVis('stick', stick.el, !!(stick.available && inGame && off && !s.paused && (ph === 'presnap' || ph === 'live')));
    setVis('juke', btn.juke, showJuke);
    setVis('sw', btn.sw, showSwitch);
    setVis('kick', btn.kick, showKick);
    var cool = performance.now() - jukeAt < JUKE_COOLDOWN;
    if (btn.juke && vis.cool !== cool) { vis.cool = cool; btn.juke.classList.toggle('cool', cool); }
  }

  function reset() {
    clearPointers();
    clearKeys();
    steer.active = false;
    movingId = selectedDefender = null;
    selectHoldUntil = 0;
    lastSendT = -Infinity;
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
    isTouching: function () { return !!(movePointer || aimPointer || waitingPointers.length || stick.id !== null); },
    touchedThisPlay: function () { return touchedThisPlay; },
    qbHolds: qbHolds,
    canThrow: canThrow,
    controlledCarrier: controlledCarrier
  };
})();
