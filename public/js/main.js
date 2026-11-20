/* Gridiron Duel - menus, mode switching, game loop, interpolation, sound (window.Game) */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var Sim = window.GridSim || null;
  var STEP = 1 / 30;
  var MAX_BUF = 60;
  // sim run speeds (yd/s) - used to predict our own player between snapshots
  var SPEEDS = {
    QB: 5.6, RB: 7.0, WR1: 7.0, WR2: 7.0, TE: 6.3, OL1: 5.0, OL2: 5.0,
    DL1: 5.0, DL2: 5.0, LB: 6.3, CB1: 7.0, CB2: 7.0, S1: 7.0, S2: 7.0
  };

  // ================================================================== play lists
  var FALLBACK_OFF = [
    { id: 'slant', name: 'Slant', desc: 'WRs cut inside after 5 yds. Quick, safe throw.' },
    { id: 'deep', name: 'Deep', desc: 'WRs streak 25 yds then fade. Big-play shot.' },
    { id: 'screen', name: 'Screen', desc: 'RB & TE swing to the flat behind the line.' },
    { id: 'run', name: 'Run', desc: 'Handoff to the RB. WRs block downfield.' },
    { id: 'punt', name: 'Punt', desc: 'Boot it away. Nets about 40 yards.' },
    { id: 'fg', name: 'Field Goal', desc: 'Stop the kick meter in the green.' }
  ];
  var FALLBACK_DEF = [
    { id: 'man', name: 'Man', desc: 'CBs lock onto WRs, LB takes the TE.' },
    { id: 'zone', name: 'Zone', desc: 'Drop into areas and jump the throw.' },
    { id: 'blitz', name: 'Blitz', desc: 'LB + safety rush the QB. Risky!' }
  ];
  function mergePlays(list, fb) {
    if (!list || !list.length) return fb;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i] || {};
      var f = null;
      for (var j = 0; j < fb.length; j++) if (fb[j].id === p.id) f = fb[j];
      if (!p.id) continue;
      out.push({ id: p.id, name: p.name || (f && f.name) || p.id, desc: p.desc || (f && f.desc) || '' });
    }
    return out.length ? out : fb;
  }
  var OFF_PLAYS = mergePlays(Sim && Sim.OFFENSE_PLAYS, FALLBACK_OFF);
  var DEF_PLAYS = mergePlays(Sim && Sim.DEFENSE_PLAYS, FALLBACK_DEF);
  function playName(id) {
    var all = OFF_PLAYS.concat(DEF_PLAYS);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i].name;
    return String(id || '').toUpperCase();
  }

  // ================================================================== storage helpers
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // ================================================================== sound
  var Sound = (function () {
    var ac = null, master = null, noiseBuf = null;
    var enabled = lsGet('gd_sound', '1') !== '0';

    function unlock() {
      if (!ac) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try {
          ac = new AC();
          master = ac.createGain();
          master.gain.value = 0.45;
          master.connect(ac.destination);
          var len = ac.sampleRate;
          noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
          var d = noiseBuf.getChannelData(0);
          for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
          // iOS: play a silent buffer inside the gesture
          var src = ac.createBufferSource();
          src.buffer = ac.createBuffer(1, 1, 22050);
          src.connect(ac.destination);
          src.start(0);
        } catch (e) { ac = null; return; }
      }
      // iOS reports 'interrupted' after a call / app switch; both need resume() inside a gesture
      if (ac.state !== 'running' && ac.state !== 'closed' && ac.resume) {
        try { var pr = ac.resume(); if (pr && pr.catch) pr.catch(function () { /* ignore */ }); } catch (e) { /* ignore */ }
      }
    }
    function ok() { return enabled && ac && ac.state !== 'closed'; }

    function tone(freq, start, dur, type, vol, freqEnd) {
      var t0 = ac.currentTime + start;
      var o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq, t0);
      if (freqEnd) o.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(master);
      o.start(t0); o.stop(t0 + dur + 0.05);
      return o;
    }
    function noise(start, dur, vol, ftype, f0, f1, q, attack) {
      var t0 = ac.currentTime + start;
      var src = ac.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      var f = ac.createBiquadFilter();
      f.type = ftype || 'bandpass';
      f.frequency.setValueAtTime(f0 || 1000, t0);
      if (f1) f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      f.Q.value = q || 1;
      var g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.3, t0 + (attack || 0.01));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0, Math.random() * 0.5); src.stop(t0 + dur + 0.05);
    }

    var api = {
      unlock: unlock,
      isEnabled: function () { return enabled; },
      setEnabled: function (on) { enabled = !!on; lsSet('gd_sound', on ? '1' : '0'); if (on) unlock(); },
      whistle: function (long) {
        if (!ok()) return;
        var dur = long ? 0.9 : 0.4;
        var o = tone(2850, 0, dur, 'sine', 0.22);
        var lfo = ac.createOscillator(), lg = ac.createGain();
        lfo.frequency.value = 28; lg.gain.value = 180;
        lfo.connect(lg); lg.connect(o.frequency);
        lfo.start(); lfo.stop(ac.currentTime + dur + 0.05);
        noise(0, dur, 0.05, 'bandpass', 3000, 0, 4);
      },
      hike: function () { if (ok()) { tone(190, 0, 0.07, 'square', 0.18); noise(0, 0.06, 0.12, 'lowpass', 900); } },
      whoosh: function () { if (ok()) noise(0, 0.32, 0.35, 'bandpass', 500, 2600, 1.5, 0.08); },
      swish: function () { if (ok()) noise(0, 0.18, 0.25, 'highpass', 1500, 4000, 0.8, 0.03); },
      catch: function () { if (ok()) { tone(660, 0, 0.07, 'square', 0.16); tone(990, 0.07, 0.1, 'square', 0.16); } },
      thud: function () {
        if (!ok()) return;
        tone(150, 0, 0.22, 'sine', 0.7, 45);
        noise(0, 0.16, 0.45, 'lowpass', 500, 120, 0.7);
      },
      incomplete: function () { if (ok()) { tone(330, 0, 0.12, 'triangle', 0.18); tone(247, 0.12, 0.2, 'triangle', 0.18); } },
      first: function () { if (ok()) { tone(784, 0, 0.09, 'triangle', 0.22); tone(1047, 0.09, 0.16, 'triangle', 0.22); } },
      td: function () {
        if (!ok()) return;
        var notes = [523, 659, 784, 1047, 784, 1047];
        var times = [0, 0.12, 0.24, 0.36, 0.52, 0.64];
        for (var i = 0; i < notes.length; i++) tone(notes[i], times[i], i === notes.length - 1 ? 0.5 : 0.13, 'square', 0.16);
        tone(131, 0, 0.36, 'triangle', 0.25); tone(196, 0.36, 0.7, 'triangle', 0.25);
      },
      crowd: function (big) {
        if (!ok()) return;
        var dur = big ? 2.2 : 1.3;
        noise(0, dur, big ? 0.32 : 0.2, 'bandpass', 900, 700, 0.5, 0.25);
        noise(0.05, dur * 0.9, big ? 0.16 : 0.1, 'bandpass', 2200, 1600, 0.8, 0.3);
      },
      int: function () { if (ok()) { tone(700, 0, 0.45, 'sawtooth', 0.14, 180); tone(350, 0.1, 0.4, 'square', 0.1, 90); } },
      miss: function () { if (ok()) tone(330, 0, 0.5, 'sawtooth', 0.14, 110); },
      click: function () { if (ok()) tone(1200, 0, 0.035, 'square', 0.07); }
    };
    return api;
  })();

  function vibrate(p) {
    try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* ignore */ }
  }

  // ================================================================== state
  var S = {
    mode: 'menu',          // 'menu' | 'online' | 'cpu'
    awaitOnline: false,    // waiting for an online game to start (create/join/rejoin)
    myTeam: 0,
    names: ['HOME', 'AWAY'],
    latest: null,          // newest snapshot (UI)
    view: null,            // snapshot used for drawing (interpolated online)
    buf: [],               // online: [{t, s}]
    game: null,            // cpu: sim game
    acc: 0,
    cpuPaused: false,
    menuOpen: false,
    localPick: null,
    rematchSent: false,
    oppRematch: false,
    overShown: false,
    netDown: false,
    oppLeft: false,
    oppAway: false,        // opponent's app is in the background (connected, game paused)
    oppQuit: false,        // opponent quit on purpose: room is gone
    awaySent: false,       // we told the server we're in the background
    uiPhase: null,
    bannerAt: 0,
    bannerOn: false,
    lastT: 0,
    evq: [],               // online: [{t, e, s}] events fired when the render clock reaches them
    delay: 110,            // online: current interpolation delay (ms), adaptive
    netAvg: 50,            // online: smoothed snapshot interval (ms)
    netJit: 8,             // online: smoothed |interval - avg| (ms)
    lastArr: 0
  };

  // ================================================================== DOM refs
  var canvas = $('game');
  var el = {
    hud: $('hud'),
    team0: $('hudTeam0'), team1: $('hudTeam1'),
    name0: $('hudName0'), name1: $('hudName1'),
    you0: $('hudYou0'), you1: $('hudYou1'),
    score0: $('hudScore0'), score1: $('hudScore1'),
    q: $('hudQ'), clock: $('hudClock'), down: $('hudDown'),
    banner: $('banner'), bannerBig: $('bannerBig'), bannerSub: $('bannerSub'),
    presnap: $('presnapTag'), hint: $('hint'),
    pc: $('playcall'), pcTitle: $('pcTitle'), pcTimer: $('pcTimer'), pcSub: $('pcSub'),
    pcCards: $('pcCards'), pcWaiting: $('pcWaiting'), pcPicked: $('pcPicked'),
    paused: $('pausedOverlay'), pausedMsg: $('pausedMsg'), pausedQuit: $('btnPausedQuit'),
    pauseNote: $('pauseNote'),
    toast: $('toast')
  };
  var SCREENS = ['screenMenu', 'screenCreate', 'screenJoin', 'screenRejoin', 'screenHow', 'screenOver', 'pauseMenu'];

  function setText(node, t) {
    if (node && node._t !== t) { node._t = t; node.textContent = t; }
  }
  function setShown(node, on) {
    on = !!on;
    if (node && node._shown !== on) { node._shown = on; node.classList.toggle('hidden', !on); }
  }
  function setClass(node, cls, on) {
    on = !!on;
    var k = '_c' + cls;
    if (node && node[k] !== on) { node[k] = on; node.classList.toggle(cls, on); }
  }
  function showScreen(id) {
    for (var i = 0; i < SCREENS.length; i++) {
      var n = $(SCREENS[i]);
      n.classList.toggle('hidden', SCREENS[i] !== id);
    }
    S.menuOpen = id === 'pauseMenu';
  }

  var toastTimer = null;
  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.add('hidden'); }, ms || 2600);
  }

  // ================================================================== name / settings
  var nameInput = $('nameInput');
  nameInput.value = lsGet('gd_name', '');
  function playerName() {
    var n = String(nameInput.value || '').replace(/[^\w .\-!?']/g, '').trim().slice(0, 12).toUpperCase();
    return n || 'PLAYER';
  }
  nameInput.addEventListener('input', function () { lsSet('gd_name', nameInput.value.slice(0, 12)); });
  nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') nameInput.blur(); });
  // iOS Safari can leave the (fixed) page scrolled after the keyboard closes
  function unscroll() { setTimeout(function () { try { window.scrollTo(0, 0); } catch (e) { /* ignore */ } }, 60); }
  nameInput.addEventListener('blur', unscroll);

  function refreshSoundButtons() {
    var t = 'SOUND: ' + (Sound.isEnabled() ? 'ON' : 'OFF');
    $('btnSound').textContent = t;
    $('btnPauseSound').textContent = t;
  }
  function toggleSound() { Sound.setEnabled(!Sound.isEnabled()); refreshSoundButtons(); Sound.click(); }
  refreshSoundButtons();

  (function urlHint() {
    var host = location.host;
    var h = 'BOTH PHONES OPEN: ' + location.protocol + '//' + host;
    if (/^(localhost|127\.|\[::1\])/.test(location.hostname)) {
      h += ' - ON PHONES USE THIS COMPUTER\'S WI-FI IP INSTEAD OF LOCALHOST';
    }
    $('urlHint').textContent = h;
    $('createAddr').textContent = location.protocol + '//' + host;
  })();

  // ================================================================== fullscreen helper
  function goFullscreen() {
    try {
      if (!window.matchMedia || !matchMedia('(pointer: coarse)').matches) return;
      var d = document.documentElement;
      var rq = d.requestFullscreen || d.webkitRequestFullscreen;
      if (rq && !(document.fullscreenElement || document.webkitFullscreenElement)) {
        var p = rq.call(d, { navigationUI: 'hide' });
        if (p && p.catch) p.catch(function () { /* ignore */ });
      }
      if (screen.orientation && screen.orientation.lock) {
        var q = screen.orientation.lock('landscape');
        if (q && q.catch) q.catch(function () { /* ignore */ });
      }
    } catch (e) { /* ignore */ }
  }

  // ================================================================== mode switching
  function enterGame(mode) {
    S.mode = mode;
    S.awaitOnline = false;
    S.buf.length = 0;
    S.latest = null;
    S.view = null;
    S.acc = 0;
    S.cpuPaused = false;
    S.localPick = null;
    S.rematchSent = false;
    S.oppRematch = false;
    S.overShown = false;
    S.uiPhase = null;
    S.bannerOn = false;
    S.evq.length = 0;
    S.lastArr = 0;
    pred.id = null;
    pcKey = '';
    el.banner.classList.add('hidden');
    showScreen(null);
    document.body.classList.add('ingame');
    Input.reset();
    pushTrap();
    layout();
  }

  function exitToMenu(msg) {
    if (S.mode === 'online' || S.awaitOnline) Net.leave();
    S.mode = 'menu';
    S.awaitOnline = false;
    S.game = null;
    S.latest = null;
    S.view = null;
    S.buf.length = 0;
    S.evq.length = 0;
    S.oppLeft = false;
    S.oppAway = false;
    S.oppQuit = false;
    S.awaySent = false;
    S.netDown = false;
    S.overShown = false;
    pred.id = null;
    document.body.classList.remove('ingame');
    Input.reset();
    showScreen('screenMenu');
    layout();
    if (msg) toast(msg);
  }

  function startCpu() {
    if (!Sim || !Sim.createGame) { toast('GAME ENGINE FAILED TO LOAD'); return; }
    if (S.mode === 'online' || S.awaitOnline) Net.leave();
    try {
      S.game = Sim.createGame({ humans: [true, false], teamNames: [playerName(), 'CPU'] });
    } catch (e) {
      console.error(e);
      toast('COULD NOT START GAME');
      return;
    }
    S.myTeam = 0;
    S.names = [playerName(), 'CPU'];
    goFullscreen();
    enterGame('cpu');
  }

  function startCreate() {
    Net.leave();                // forget any old session first
    S.awaitOnline = true;
    S.myTeam = 0;
    $('createCode').textContent = '····';
    $('createStatus').textContent = 'CONNECTING...';
    $('createStatus').classList.remove('err');
    showScreen('screenCreate');
    Net.sendWhenOpen({ type: 'create', name: playerName() });
  }

  function startJoin() {
    var code = String($('codeInput').value || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    var st = $('joinStatus');
    if (code.length !== 4) {
      st.textContent = 'CODE IS 4 LETTERS';
      st.classList.add('err');
      return;
    }
    Net.leave();
    S.awaitOnline = true;
    S.myTeam = 1;
    st.textContent = 'CONNECTING...';
    st.classList.remove('err');
    Net.sendWhenOpen({ type: 'join', code: code, name: playerName() });
  }

  function tryAutoRejoin() {
    var sess = Net.getSession();
    if (!sess) return false;
    S.awaitOnline = true;
    S.myTeam = sess.team === 1 ? 1 : 0;
    showScreen('screenRejoin');
    Net.connect();          // onopen sends the rejoin automatically
    return true;
  }

  // ================================================================== menu wiring
  function onClick(id, fn) {
    $(id).addEventListener('click', function (e) { e.preventDefault(); Sound.unlock(); Sound.click(); fn(); });
  }
  onClick('btnCreate', function () { goFullscreen(); startCreate(); });
  onClick('btnJoinScreen', function () {
    $('joinStatus').textContent = '';
    $('joinStatus').classList.remove('err');
    showScreen('screenJoin');
    setTimeout(function () { try { $('codeInput').focus(); } catch (e) { /* ignore */ } }, 50);
  });
  onClick('btnCpu', startCpu);
  onClick('btnHow', function () { showScreen('screenHow'); });
  onClick('btnHowBack', function () { showScreen('screenMenu'); });
  onClick('btnSound', toggleSound);
  onClick('btnPauseSound', toggleSound);
  onClick('btnCreateCancel', function () { exitToMenu(); });
  onClick('btnJoinBack', function () { if (S.awaitOnline) Net.leave(); S.awaitOnline = false; showScreen('screenMenu'); });
  onClick('btnJoin', function () { goFullscreen(); startJoin(); });
  onClick('btnRejoinCancel', function () { exitToMenu(); });

  var codeInput = $('codeInput');
  codeInput.addEventListener('input', function () {
    var v = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (v !== codeInput.value) codeInput.value = v;
  });
  codeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { codeInput.blur(); startJoin(); } });
  codeInput.addEventListener('blur', unscroll);

  // pause / quit
  function openPause() {
    if (S.mode === 'menu') return;
    Input.cancel();
    if (S.mode === 'cpu') S.cpuPaused = true;
    setText(el.pauseNote, S.mode === 'online' ? 'ONLINE GAME KEEPS RUNNING!' : '');
    refreshSoundButtons();
    showScreen('pauseMenu');
  }
  function closePause() {
    S.cpuPaused = false;
    S.acc = 0;
    showScreen(S.overShown ? 'screenOver' : null);
  }
  $('pauseBtn').addEventListener('click', function (e) { e.preventDefault(); Sound.unlock(); Sound.click(); openPause(); });
  onClick('btnResume', closePause);
  onClick('btnQuit', function () { exitToMenu(); });
  onClick('btnPausedQuit', function () { exitToMenu(); });
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || S.mode === 'menu') return;
    if (S.menuOpen) closePause(); else openPause();
  });

  // game over
  onClick('btnRematch', function () {
    if (S.mode === 'cpu' && S.game) {
      try { Sim.reset(S.game); } catch (e) { console.error(e); }
      enterGame('cpu');
    } else if (S.mode === 'online') {
      S.rematchSent = true;
      Net.send({ type: 'rematch' });
      updateOverStatus();
    }
  });
  onClick('btnOverMenu', function () { exitToMenu(); });

  function updateOverStatus() {
    var st = $('overStatus');
    var btn = $('btnRematch');
    st.classList.remove('err');
    if (S.mode === 'online') {
      if (S.oppQuit) { st.textContent = 'OPPONENT LEFT THE GAME'; st.classList.add('err'); btn.disabled = true; }
      else if (S.netDown) { st.textContent = 'CONNECTION LOST - RECONNECTING...'; st.classList.add('err'); btn.disabled = true; }
      else if (S.oppLeft) { st.textContent = S.oppAway ? 'OPPONENT SWITCHED APPS...' : 'OPPONENT DISCONNECTED...'; st.classList.add('err'); btn.disabled = true; }
      else if (S.rematchSent) { st.textContent = 'WAITING FOR OPPONENT...'; btn.disabled = true; }
      else if (S.oppRematch) { st.textContent = 'OPPONENT WANTS A REMATCH!'; btn.disabled = false; }
      else { st.textContent = ''; btn.disabled = false; }
    } else { st.textContent = ''; btn.disabled = false; }
  }

  function showGameOver(s) {
    S.overShown = true;
    var my = s.score[S.myTeam], opp = s.score[1 - S.myTeam];
    $('overTitle').textContent = my > opp ? 'YOU WIN!' : (my < opp ? 'YOU LOSE' : 'TIE GAME');
    $('overName0').textContent = (s.teamNames && s.teamNames[0]) || S.names[0];
    $('overName1').textContent = (s.teamNames && s.teamNames[1]) || S.names[1];
    $('overScore0').textContent = s.score[0];
    $('overScore1').textContent = s.score[1];
    updateOverStatus();
    if (!S.menuOpen) showScreen('screenOver');
  }

  // ================================================================== network events
  Net.on('created', function (m) {
    S.myTeam = 0;
    if (S.mode === 'online') return;        // rejoin echo while already in game
    S.awaitOnline = true;
    $('createCode').textContent = m.code;
    $('createStatus').textContent = 'WAITING FOR OPPONENT...';
    showScreen('screenCreate');
  });
  Net.on('joined', function (m) {
    S.myTeam = 1;
    $('joinStatus').textContent = 'JOINED ' + m.code + '! STARTING...';
  });
  Net.on('rejoined', function (m) {
    if (typeof m.team === 'number') S.myTeam = m.team;
    // the server treats a fresh connection as "in the foreground"
    S.awaySent = false;
    if (document.visibilityState === 'hidden') sendAway();
    S.rematchSent = false;               // the server forgets rematch votes on reconnect
    S.oppRematch = false;
    if (S.overShown) updateOverStatus();
  });
  Net.on('start', function (m) {
    if (typeof m.team === 'number') S.myTeam = m.team;
    if (m.names) S.names = m.names;
    S.oppLeft = false;
    S.oppAway = false;
    S.oppQuit = false;
    if (S.mode !== 'online') enterGame('online');
    else { S.buf.length = 0; S.evq.length = 0; S.lastArr = 0; }   // fresh timeline after a rejoin
    if (S.overShown) updateOverStatus();
  });
  Net.on('state', function (m) {
    var s = m.s;
    if (!s) return;
    if (S.mode !== 'online') {
      if (!S.awaitOnline) return;
      enterGame('online');
    }
    var now = performance.now();
    var b = S.buf;
    // adaptive jitter buffer: track the snapshot interval and its jitter
    if (S.lastArr) {
      var iv = now - S.lastArr;
      if (iv < 1000) {
        S.netAvg += (iv - S.netAvg) * 0.05;
        S.netJit += (Math.abs(iv - S.netAvg) - S.netJit) * 0.08;
      }
    }
    S.lastArr = now;
    // snapshots that arrive bunched together (TCP over a tunnel) get spread out
    var t = now;
    if (b.length) t = Math.max(now, Math.min(b[b.length - 1].t + S.netAvg * 0.6, now + 250));
    b.push({ t: t, s: s });
    if (b.length > MAX_BUF) b.splice(0, b.length - MAX_BUF);
    S.latest = s;
    if (s.events && s.events.length) {
      S.evq.push({ t: t, e: s.events, s: s });
      if (S.evq.length > 40) S.evq.shift();
    }
  });
  Net.on('error', function (m) {
    var msg = String((m && m.message) || 'ERROR').toUpperCase();
    var r = m && m.reason;
    if (r === 'not_found') msg = 'ROOM NOT FOUND - CHECK THE CODE';
    else if (r === 'full') msg = 'ROOM IS FULL';
    else if (r === 'no_sim') msg = 'SERVER ERROR - GAME ENGINE MISSING';
    if (!$('screenJoin').classList.contains('hidden')) {
      $('joinStatus').textContent = msg;
      $('joinStatus').classList.add('err');
      S.awaitOnline = false;
      Net.leave();
    } else if (!$('screenCreate').classList.contains('hidden')) {
      $('createStatus').textContent = msg;
      $('createStatus').classList.add('err');
    } else {
      toast(msg);
    }
  });
  Net.on('rejoin_failed', function (m) {
    if (S.mode === 'online' || S.awaitOnline) {
      exitToMenu(m && m.reason === 'room_closed' ? 'ROOM CLOSED' : 'GAME NO LONGER AVAILABLE');
    }
  });
  Net.on('opponent_left', function (m) {
    S.oppLeft = true;
    S.oppAway = !!(m && m.reason === 'away');
    Input.cancel();
    S.oppRematch = false;
    S.rematchSent = false;               // server clears both votes when someone drops
    if (S.overShown) updateOverStatus();
  });
  Net.on('opponent_quit', function () {
    S.oppQuit = true;
    S.oppLeft = false;
    S.oppAway = false;
    S.oppRematch = false;
    S.rematchSent = false;
    Input.cancel();
    if (S.overShown) updateOverStatus();
  });
  Net.on('opponent_back', function () {
    S.oppLeft = false;
    S.oppAway = false;
    if (S.mode === 'online') toast('OPPONENT IS BACK!');
    if (S.overShown) updateOverStatus();
  });
  Net.on('rematch_requested', function () {
    S.oppRematch = true;
    if (S.overShown) updateOverStatus();
    if (!S.rematchSent) toast('OPPONENT WANTS A REMATCH!');
  });
  Net.on('open', function () {
    S.netDown = false;
    if (S.overShown) updateOverStatus();
    var cs = $('createStatus');
    if (S.awaitOnline && cs.classList.contains('err') && /CONNECTION/.test(cs.textContent)) {
      cs.textContent = 'CONNECTING...';
      cs.classList.remove('err');
    }
  });
  Net.on('close', function () {
    if (S.mode === 'online' || S.awaitOnline) {
      S.netDown = true;
      Input.cancel();
    }
    if (S.overShown) updateOverStatus();
    if (S.awaitOnline && S.mode !== 'online') {
      var st = !$('screenCreate').classList.contains('hidden') ? $('createStatus')
        : (!$('screenJoin').classList.contains('hidden') ? $('joinStatus') : null);
      if (st) { st.textContent = 'CONNECTION LOST - RETRYING...'; st.classList.add('err'); }
    }
  });

  // ================================================================== events -> feedback
  function eventSpot(s) {
    var ps = s.players || [];
    for (var i = 0; i < ps.length; i++) if (ps[i].carrier) return ps[i];
    return s.ball || null;
  }
  function handleEvents(evts, s) {
    for (var i = 0; i < evts.length; i++) {
      var e = evts[i], sp;
      switch (e) {
        case 'snap': Sound.hike(); break;
        case 'whistle': Sound.whistle(false); break;
        case 'throw': Sound.whoosh(); break;
        case 'catch': Sound.catch(); break;
        case 'incomplete': Sound.incomplete(); break;
        case 'juke': Sound.swish(); break;
        case 'first_down': Sound.first(); break;
        case 'tackle':
          Sound.thud(); vibrate(40); Render.shake(3);
          sp = eventSpot(s); if (sp) Render.burst('dust', sp.x, sp.y);
          break;
        case 'sack':
          Sound.thud(); vibrate([60, 40, 60]); Render.shake(5);
          sp = eventSpot(s); if (sp) Render.burst('dust', sp.x, sp.y);
          break;
        case 'int':
          Sound.int(); vibrate([40, 30, 40, 30, 80]);
          break;
        case 'td':
          Sound.td(); Sound.crowd(true); vibrate([90, 50, 90, 50, 200]); Render.shake(2);
          sp = eventSpot(s);
          if (sp) {
            // a few staggered pops around the scorer so the celebration reads at phone size
            var cx0 = sp.x, cy0 = sp.y;
            Render.burst('confetti', cx0, cy0);
            setTimeout(function () { Render.burst('confetti', cx0 + 3, cy0 - 4); }, 300);
            setTimeout(function () { Render.burst('confetti', cx0 + 2, cy0 + 4); }, 600);
          }
          break;
        case 'pat_good':
        case 'fg_good': Sound.td(); Sound.crowd(false); break;
        case 'pat_miss':
        case 'fg_miss': Sound.miss(); break;
        case 'gameover': Sound.whistle(true); break;
      }
    }
  }

  // ================================================================== input plumbing
  function sendInput(msg) {
    if (S.mode === 'cpu' && S.game) {
      if (!S.cpuPaused) { try { Sim.input(S.game, S.myTeam, msg); } catch (e) { console.error(e); } }
    } else if (S.mode === 'online') {
      Net.send({ type: 'input', msg: msg });
    }
  }
  Input.init(canvas, {
    send: sendInput,
    getView: function () {
      return S.mode === 'menu' || S.menuOpen || S.netDown || S.oppLeft || S.oppQuit ? null : S.view;
    },
    myTeam: function () { return S.myTeam; },
    onTap: function () { Sound.unlock(); }
  });

  // ================================================================== interpolation
  // Online snapshots are rendered S.delay ms in the past (adaptive: ~2 snapshot
  // intervals + jitter) and blended. The result is always written into `interp`
  // so the buffered snapshots are never mutated (prediction edits the view).
  var interp = { players: [], ball: { x: 0, y: 0, z: 0, state: 'held', holder: null, tx: 0, ty: 0 } };
  var interpPlayers = [];
  var interpBall = interp.ball;

  function lerp(a, b, t) { return a + (b - a) * t; }

  function fill(bs, as, t) {
    for (var k in bs) if (k !== 'players' && k !== 'ball') interp[k] = bs[k];
    interp.events = null;
    var bp = bs.players || [], ap = as ? (as.players || []) : null;
    var out = interp.players;
    out.length = bp.length;
    for (var i = 0; i < bp.length; i++) {
      var p = bp[i];
      var o = interpPlayers[i] || (interpPlayers[i] = {});
      o.id = p.id; o.side = p.side; o.carrier = p.carrier; o.juking = p.juking;
      o.vx = p.vx; o.vy = p.vy;
      var q = null;
      if (ap) {
        if (ap[i] && ap[i].id === p.id && ap[i].side === p.side) q = ap[i];
        else for (var j = 0; j < ap.length; j++) if (ap[j].id === p.id && ap[j].side === p.side) { q = ap[j]; break; }
      }
      if (q) { o.x = lerp(q.x, p.x, t); o.y = lerp(q.y, p.y, t); }
      else { o.x = p.x; o.y = p.y; }
      out[i] = o;
    }
    var bb = bs.ball, ab = as ? as.ball : null, ib = interpBall;
    if (!bb) interp.ball = null;
    else {
      interp.ball = ib;
      ib.state = bb.state; ib.holder = bb.holder; ib.tx = bb.tx; ib.ty = bb.ty;
      if (ab && ab.state === bb.state && ab.holder === bb.holder) {
        ib.x = lerp(ab.x, bb.x, t); ib.y = lerp(ab.y, bb.y, t); ib.z = lerp(ab.z || 0, bb.z || 0, t);
      } else { ib.x = bb.x; ib.y = bb.y; ib.z = bb.z || 0; }
    }
    return interp;
  }

  function interpolate(now, delay) {
    var b = S.buf;
    if (!b.length) return null;
    var rt = now - delay;
    while (b.length > 2 && b[1].t <= rt) b.shift();
    var A = b[0], B = b.length > 1 ? b[1] : null;
    if (!B || rt <= A.t) return fill(A.s, null, 0);
    if (rt >= B.t) return fill(B.s, null, 0);
    if (!canBlend(A.s, B.s)) return fill(A.s, null, 0);
    return fill(B.s, A.s, (rt - A.t) / (B.t - A.t));
  }

  /** Blend A->B unless it's a real discontinuity: new possession, reset to playcall /
   *  gameover (formation teleport), or anyone jumping > 3yd between snapshots. Other
   *  phase changes (presnap->live, live->result, ...) are continuous motion. */
  var TELEPORT2 = 3 * 3;
  function canBlend(a, b) {
    if (a.possession !== b.possession) return false;
    if (a.phase !== b.phase && (b.phase === 'playcall' || b.phase === 'gameover')) return false;
    var ap = a.players || [], bp = b.players || [];
    if (ap.length !== bp.length) return false;
    for (var i = 0; i < bp.length; i++) {
      var p = ap[i], q = bp[i];
      if (!p || !q || p.id !== q.id || p.side !== q.side) return false;
      var dx = q.x - p.x, dy = q.y - p.y;
      if (dx * dx + dy * dy > TELEPORT2) return false;
    }
    return true;
  }

  // ================================================================== own-player prediction (online)
  // The player you steer reacts immediately and is continuously pulled back onto the server timeline.
  var pred = { id: null, side: null, poss: -1, x: 0, y: 0, vx: 0, vy: 0 };
  var PRED_MAX = 1.6;          // yd: max visual deviation from the interpolated server position

  function findIn(list, id, side) {
    if (!list) return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id && list[i].side === side) return list[i];
    return null;
  }

  function applyPrediction(v, dt) {
    if (!v || S.mode !== 'online') { pred.id = null; return; }
    var off = v.possession === S.myTeam;
    var live = v.phase === 'live' && !v.paused && !S.netDown && !S.oppLeft && !S.oppQuit;
    var id = live ? (off ? v.controlledOffId : v.userDefenderId) : null;
    var side = off ? 'off' : 'def';
    var vp;
    if (!id) {
      // play over: ease the last predicted player back onto the server position
      if (pred.id && pred.poss === v.possession && (vp = findIn(v.players, pred.id, pred.side))) {
        var kf = 1 - Math.exp(-dt * 14);
        pred.x += (vp.x - pred.x) * kf; pred.y += (vp.y - pred.y) * kf;
        if (Math.abs(vp.x - pred.x) + Math.abs(vp.y - pred.y) < 0.05) { pred.id = null; return; }
        vp.x = pred.x; vp.y = pred.y;
      } else pred.id = null;
      return;
    }
    vp = findIn(v.players, id, side);
    if (!vp) { pred.id = null; return; }
    if (pred.id !== id || pred.side !== side || pred.poss !== v.possession) {
      pred.id = id; pred.side = side; pred.poss = v.possession;
      pred.x = vp.x; pred.y = vp.y; pred.vx = vp.vx || 0; pred.vy = vp.vy || 0;
    }
    var st = Input.steer;
    var steering = st.active && st.id === id;
    if (steering) {
      var runSpeed = SPEEDS[id] || 6;
      var spd = runSpeed * st.speed * (vp.juking ? 1.35 : 1);
      if (Sim && Sim.steer) {
        var accel = runSpeed / Sim.HUMAN_ACCEL_TIME * (vp.juking ? 2 : 1);
        Sim.steer(pred, st.x, st.y, spd, accel, dt, 0.3);
      } else {
        var dx = st.x - pred.x, dy = st.y - pred.y, d = Math.hypot(dx, dy);
        var scale = d > 0.3 ? spd / d : 0;
        var ka = 1 - Math.exp(-dt / 0.29);
        pred.vx += (dx * scale - pred.vx) * ka;
        pred.vy += (dy * scale - pred.vy) * ka;
      }
    } else {
      pred.vx = vp.vx || 0; pred.vy = vp.vy || 0;
    }
    pred.x += pred.vx * dt; pred.y += pred.vy * dt;
    // reconcile with the (interpolated) server position
    var kc = 1 - Math.exp(-dt * (steering ? 2.5 : 5));
    pred.x += (vp.x - pred.x) * kc; pred.y += (vp.y - pred.y) * kc;
    var ex = pred.x - vp.x, ey = pred.y - vp.y, ed = Math.sqrt(ex * ex + ey * ey);
    if (ed > PRED_MAX) { pred.x = vp.x + ex / ed * PRED_MAX; pred.y = vp.y + ey / ed * PRED_MAX; }
    vp.x = pred.x; vp.y = pred.y;
    if (steering) { vp.vx = pred.vx; vp.vy = pred.vy; }   // face / animate the way he's going
    var bl = v.ball;
    if (bl && bl.state === 'held' && bl.holder === id) { bl.x = pred.x; bl.y = pred.y; }
  }

  function fireQueuedEvents(now) {
    var q = S.evq, rt = now - S.delay;
    while (q.length && q[0].t <= rt) {
      var it = q.shift();
      if (rt - it.t < 1500) handleEvents(it.e, it.s);   // drop stale ones (tab was hidden)
    }
  }

  // ================================================================== HUD / overlays
  function ord(n) { return n === 1 ? '1ST' : n === 2 ? '2ND' : n === 3 ? '3RD' : n + 'TH'; }
  /** "OWN 34" / "OPP 20" from the point of view of THIS player (offense or defense). */
  function fieldPos(ballOn, possession) {
    var b = Math.round(ballOn);
    if (b === 50) return 'MIDFIELD';
    var sideTeam = b < 50 ? possession : 1 - possession;     // whose half the ball is in
    var yd = b < 50 ? b : 100 - b;
    return (sideTeam === S.myTeam ? 'OWN ' : 'OPP ') + yd;
  }
  function downText(s) {
    if (s.phase === 'gameover') return 'GAME OVER';
    var dist;
    if (s.ballOn + s.toGo >= 99.95) dist = 'GOAL';
    else {
      var tg = Math.round(s.toGo);
      dist = s.toGo < 0.5 ? 'INCHES' : String(Math.max(1, tg));
    }
    return ord(s.down || 1) + ' & ' + dist + ' \u00b7 ' + fieldPos(s.ballOn, s.possession);
  }
  function clockText(c) {
    c = Math.max(0, c || 0);
    var m = Math.floor(c / 60), sec = Math.floor(c % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  var pcKey = '';
  function buildCards(offense, fourth) {
    var list = offense ? OFF_PLAYS : DEF_PLAYS;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var special = p.id === 'punt' || p.id === 'fg';
      if (special && !fourth) continue;
      var card = document.createElement('button');
      card.className = 'card' + (special ? ' special' : '') + (offense ? '' : ' def');
      card.setAttribute('data-id', p.id);
      var nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = p.name;
      var ds = document.createElement('div'); ds.className = 'ds'; ds.textContent = p.desc;
      card.appendChild(nm); card.appendChild(ds);
      card.addEventListener('click', onPick);
      frag.appendChild(card);
    }
    el.pcCards.innerHTML = '';
    el.pcCards.appendChild(frag);
  }
  function onPick(e) {
    e.preventDefault();
    Sound.unlock();
    var id = e.currentTarget.getAttribute('data-id');
    var s = S.latest;
    if (!s || s.phase !== 'playcall' || S.localPick) return;
    S.localPick = id;
    Sound.click();
    sendInput({ t: 'pick', play: id });
    var cards = el.pcCards.children;
    for (var i = 0; i < cards.length; i++) cards[i].classList.toggle('picked', cards[i].getAttribute('data-id') === id);
  }

  function showBanner(s) {
    var msg = String(s.message || '').toUpperCase();
    if (!msg) return;
    var cls = '';
    if (/INTERCEPT|PICK SIX|FUMBLE|TURNOVER|SAFETY|MISS|NO GOOD/.test(msg)) cls = 'bad';
    else if (/TOUCHDOWN|GOOD/.test(msg)) cls = 'gold';
    else if (/SACK/.test(msg)) cls = 'warn';
    else if (/1ST DOWN|FIRST DOWN/.test(msg)) cls = 'good';
    el.banner.className = 'ingame-only ' + cls;
    el.bannerBig.textContent = msg;
    el.bannerSub.textContent = String(s.sub || '').toUpperCase();
    // restart the pop animation
    el.bannerBig.style.animation = 'none';
    void el.bannerBig.offsetWidth;
    el.bannerBig.style.animation = '';
    S.bannerAt = performance.now();
    S.bannerOn = true;
  }

  function updateUI(s, now) {
    var ph = s.phase;
    var names = s.teamNames || S.names;
    var off = s.possession === S.myTeam;

    // ---- HUD
    setText(el.name0, String(names[0] || 'HOME'));
    setText(el.name1, String(names[1] || 'AWAY'));
    setText(el.score0, String(s.score ? s.score[0] : 0));
    setText(el.score1, String(s.score ? s.score[1] : 0));
    setShown(el.you0, S.myTeam === 0);
    setShown(el.you1, S.myTeam === 1);
    setClass(el.team0, 'poss', s.possession === 0 && ph !== 'gameover');
    setClass(el.team1, 'poss', s.possession === 1 && ph !== 'gameover');
    setText(el.q, ph === 'gameover' ? 'FINAL' : (s.quarter > 4 ? 'OT' : 'Q' + (s.quarter || 1)));
    setText(el.clock, ph === 'gameover' ? '' : clockText(s.clock));
    setText(el.down, s.kickKind === 'pat' ? 'EXTRA POINT' : downText(s));

    // ---- playcall overlay
    var inPc = ph === 'playcall';
    if (!inPc) S.localPick = null;
    setShown(el.pc, inPc && !S.overShown);
    if (inPc) {
      var key = (off ? 'o' : 'd') + (s.fourthDown ? '4' : '');
      if (key !== pcKey) { pcKey = key; buildCards(off, !!s.fourthDown); }
      var picked = !!(S.localPick || (s.picked && s.picked[S.myTeam]));
      setClass(el.pcCards, 'locked', picked);
      setShown(el.pcWaiting, picked);
      if (picked) setText(el.pcPicked, S.localPick ? 'YOU PICKED ' + playName(S.localPick).toUpperCase() : 'PLAY LOCKED IN');
      setText(el.pcTitle, off ? 'OFFENSE · PICK A PLAY' : 'DEFENSE · PICK A COVERAGE');
      var secs = Math.max(0, Math.ceil(s.phaseTime || 0));
      setText(el.pcTimer, String(secs));
      setClass(el.pcTimer, 'urgent', secs <= 5);
      var sub = '';
      if (s.message) sub = String(s.message).toUpperCase() + (s.sub ? ' - ' + String(s.sub).toUpperCase() : '');
      if (off && s.fourthDown) sub = (sub ? sub + ' \u00b7 ' : '') + '4TH DOWN: GO FOR IT, PUNT OR KICK';
      if (s.picked && s.picked[1 - S.myTeam] && !picked) sub = (sub ? sub + ' \u00b7 ' : '') + (S.mode === 'cpu' ? 'CPU IS READY' : 'OPPONENT IS READY');
      setText(el.pcSub, sub);
    } else {
      pcKey = '';          // rebuild fresh cards (no stale "picked" state) next playcall
    }

    // ---- presnap tag (plays are revealed by the sim at presnap)
    var showTag = (ph === 'presnap' || ph === 'kick') && s.offPlay;
    setShown(el.presnap, showTag);
    if (showTag) setText(el.presnap, playName(s.offPlay).toUpperCase() + (s.defPlay ? '  vs  ' + playName(s.defPlay).toUpperCase() : ''));

    // ---- result banner
    if (ph === 'result' && S.uiPhase !== 'result') showBanner(s);
    if (S.bannerOn && (ph !== 'result' || now - S.bannerAt > 2600)) {
      S.bannerOn = false;
    }
    setShown(el.banner, S.bannerOn);

    // ---- hint line
    var hint = '';
    if (ph === 'live' && s.phaseTime < 3 && !Input.touchedThisPlay()) {
      var touch = window.matchMedia('(pointer: coarse)').matches;
      if (off) {
        if (Input.canThrow(s)) hint = touch ? 'THUMBSTICK TO MOVE · DRAG BACK & RELEASE TO THROW' : 'WASD TO MOVE · DRAG BACK & RELEASE TO THROW';
        else if (Input.controlledCarrier(s)) hint = touch ? 'THUMBSTICK TO RUN · JUKE BEFORE CONTACT' : 'WASD TO RUN · SPACE TO JUKE';
      } else hint = touch ? 'DRAG TO MOVE · TAP A DEFENDER TO SWITCH' : 'WASD TO MOVE · SHIFT TO SWITCH';
    } else if (ph === 'kick') {
      hint = off ? 'TAP KICK WHEN THE NEEDLE IS IN THE GREEN' : 'OPPONENT IS KICKING...';
    } else if (ph === 'presnap' && !off) {
      hint = 'TAP A DEFENDER TO CONTROL HIM';
    }
    setShown(el.hint, !!hint);
    if (hint) setText(el.hint, hint);

    // ---- paused / disconnected
    var pausedMsg = '';
    var oppMsg = S.oppAway ? 'OPPONENT SWITCHED APPS - WAITING...' : 'OPPONENT DISCONNECTED - WAITING...';
    if (S.mode === 'online' && S.oppQuit) pausedMsg = 'OPPONENT LEFT THE GAME';
    else if (S.mode === 'online' && S.netDown) pausedMsg = 'CONNECTION LOST - RECONNECTING...';
    else if (S.mode === 'online' && (S.oppLeft || s.paused)) pausedMsg = oppMsg;
    setShown(el.paused, !!pausedMsg && !S.menuOpen);
    if (pausedMsg) setText(el.pausedMsg, pausedMsg);
    setClass(el.pausedMsg, 'blink', !S.oppQuit);
    setText(el.pausedQuit, S.oppQuit ? 'BACK TO MENU' : 'LEAVE GAME');

    // ---- game over
    if (ph === 'gameover' && !S.overShown) showGameOver(s);
    else if (ph !== 'gameover' && S.overShown) {
      S.overShown = false;
      S.rematchSent = false;
      S.oppRematch = false;
      if (!S.menuOpen) showScreen(null);
    }

    S.uiPhase = ph;
  }

  // ================================================================== layout
  function layout() {
    Render.resize();
    var inGame = document.body.classList.contains('ingame');
    var h = inGame ? el.hud.offsetHeight : 0;
    Render.setTopInset(h);
    if (h) document.documentElement.style.setProperty('--hudh', h + 'px');
  }
  window.addEventListener('resize', layout);
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout); } catch (e) { /* ignore */ }
  window.addEventListener('orientationchange', function () { setTimeout(layout, 120); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);

  // ================================================================== browser gesture suppression
  function isField(t) { return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'); }
  document.addEventListener('touchmove', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('.screen')) return;    // menus may scroll
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener('contextmenu', function (e) { if (!isField(e.target)) e.preventDefault(); });
  document.addEventListener('pointerdown', function () { Sound.unlock(); }, true);
  document.addEventListener('touchend', function () { Sound.unlock(); }, { capture: true, passive: true });

  // ================================================================== app switching / back button
  // Online: tell the server we're backgrounded so it pauses the game for both
  // players (instead of us standing still for 15-30s until the socket dies).
  function onlineActive() { return (S.mode === 'online' || S.awaitOnline) && Net.wantsConnection(); }
  function sendAway() {
    if (!onlineActive() || S.awaySent) return;
    if (Net.send({ type: 'away' })) S.awaySent = true;
  }
  function sendBack() {
    if (!S.awaySent) return;
    S.awaySent = false;
    // if the socket died meanwhile, Net reconnects and the rejoin clears "away"
    if (onlineActive()) Net.send({ type: 'back' });
  }
  function goHidden() {
    Input.cancel();                                    // no stuck finger when we come back
    if (S.mode === 'cpu' && !S.menuOpen && !S.overShown) openPause();
    sendAway();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') goHidden();
    else sendBack();
  });
  window.addEventListener('pagehide', goHidden);
  window.addEventListener('pageshow', function () { if (document.visibilityState !== 'hidden') sendBack(); });

  // Android back button / iOS edge swipe: keep a dummy history entry so "back"
  // opens the pause menu (or returns to the main menu) instead of leaving the page.
  function pushTrap() {
    try { if (!(history.state && history.state.gdTrap)) history.pushState({ gdTrap: 1 }, ''); } catch (e) { /* ignore */ }
  }
  function visible(id) { return !$(id).classList.contains('hidden'); }
  window.addEventListener('popstate', function () {
    if (S.mode !== 'menu') {
      if (S.menuOpen) closePause(); else openPause();
      pushTrap();
    } else if (visible('screenCreate') || visible('screenRejoin')) {
      exitToMenu();
      pushTrap();
    } else if (visible('screenJoin') || visible('screenHow')) {
      if (S.awaitOnline) { Net.leave(); S.awaitOnline = false; }
      showScreen('screenMenu');
      pushTrap();
    }
  });
  ['btnJoinScreen', 'btnHow', 'btnCreate'].forEach(function (id) {
    $(id).addEventListener('click', pushTrap);
  });

  // ================================================================== main loop
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = S.lastT ? Math.min(0.1, (now - S.lastT) / 1000) : 1 / 60;
    S.lastT = now;

    if (S.mode === 'cpu' && S.game) {
      if (!S.cpuPaused) {
        S.acc += dt;
        var n = 0;
        while (S.acc >= STEP && n < 8) {
          try { Sim.step(S.game, STEP); } catch (e) { console.error(e); }
          S.acc -= STEP;
          n++;
        }
        if (n >= 8) S.acc = 0;
      }
      var snap = null;
      try { snap = Sim.snapshot(S.game); } catch (e) { console.error(e); }
      if (snap) {
        if (snap.events && snap.events.length) handleEvents(snap.events, snap);
        S.latest = snap;
        S.view = snap;
      }
    } else if (S.mode === 'online') {
      // adapt the interpolation delay to the measured snapshot rate + jitter
      var target = Math.max(70, Math.min(320, S.netAvg * 2 + S.netJit * 2.5));
      S.delay += (target - S.delay) * (1 - Math.exp(-dt * 1.5));
      S.view = interpolate(now, S.delay);
      applyPrediction(S.view, dt);
      fireQueuedEvents(now);
    } else {
      S.view = null;
    }

    var inGame = S.mode !== 'menu' && !!S.latest;
    if (inGame) {
      Input.update(now);
      // drive the HUD/overlays from what is on screen so banners match the action
      updateUI(S.view || S.latest, now);
    }
    Input.updateControls(S.view, inGame && !S.menuOpen);

    var v = S.mode === 'menu' ? null : S.view;
    var ctrl = null;
    if (v) ctrl = v.possession === S.myTeam ? v.controlledOffId : v.userDefenderId;
    renderOpts.now = now;
    renderOpts.dt = dt;
    renderOpts.controlledId = ctrl;
    renderOpts.showReceivers = !!(v && v.phase === 'live' && v.possession === S.myTeam && Input.canThrow(v));
    renderOpts.myTeam = S.myTeam;
    Render.draw(v, renderOpts);
  }
  var renderOpts = { now: 0, dt: 0, aim: Input.aim, controlledId: null, myTeam: 0, showReceivers: false };

  // ================================================================== boot
  Render.init(canvas);
  layout();
  if (!tryAutoRejoin()) showScreen('screenMenu');
  requestAnimationFrame(frame);

  window.Game = { state: S, sound: Sound, toast: toast, exitToMenu: exitToMenu };
})();
