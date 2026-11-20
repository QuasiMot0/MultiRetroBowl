/* Gridiron Duel - websocket client with auto-reconnect + rejoin (window.Net) */
(function () {
  'use strict';

  var KEY = 'gd_session';
  var ws = null;
  var handlers = {};
  var want = false;          // should we stay connected?
  var timer = null;
  var delay = 500;
  var queue = [];            // messages to send once open
  var pendingHello = null;   // create/join not yet acknowledged: re-sent on every (re)connect
  var pingTimer = null;
  var pendingRejoin = false;
  var lastRx = 0;            // Date.now() of the last message from the server
  var probeTimer = null;
  var connectTimer = null;

  var Net = { latency: 0 };

  function emit(type, data) {
    var list = handlers[type];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); } catch (e) { console.error('[net] handler error', type, e); }
    }
  }

  Net.on = function (type, fn) {
    (handlers[type] || (handlers[type] = [])).push(fn);
  };

  Net.getSession = function () {
    try {
      var raw = sessionStorage.getItem(KEY);
      var s = raw ? JSON.parse(raw) : null;
      return s && s.code && s.token ? s : null;
    } catch (e) { return null; }
  };
  Net.setSession = function (s) {
    try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  };
  Net.clearSession = function () {
    try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  };

  function url() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }

  function raw(obj) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    }
    return false;
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(function () {
      // A phone that slept / switched networks can leave a "zombie" socket that still
      // reports OPEN but never delivers anything. The server answers every ping and
      // streams state at 20Hz in a game, so 7s of silence means the link is dead.
      if (ws && ws.readyState === 1 && lastRx && Date.now() - lastRx > 7000) { forceReconnect(); return; }
      raw({ type: 'ping', t: Date.now() });
    }, 3000);
  }
  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () { if (want && !ws) open(); }, delay);
    delay = Math.min(Math.round(delay * 1.7), 5000);
  }

  /** Drop the current socket (even if it claims to be open) and dial again now. */
  function forceReconnect() {
    var s = ws;
    ws = null;
    stopPing();
    clearTimeout(probeTimer);
    clearTimeout(connectTimer);
    if (s) { try { s.close(); } catch (e) { /* ignore */ } }
    emit('close');
    if (want) { delay = 500; open(); }
  }

  function open() {
    clearTimeout(timer);
    clearTimeout(connectTimer);
    var sock;
    try { sock = new WebSocket(url()); } catch (e) { ws = null; schedule(); return; }
    ws = sock;
    // a tunnel / captive network can leave the handshake hanging forever
    connectTimer = setTimeout(function () {
      if (sock === ws && sock.readyState === 0) {
        ws = null;
        try { sock.close(); } catch (e) { /* ignore */ }
        emit('close');
        if (want) schedule();
      }
    }, 8000);
    sock.onopen = function () {
      if (sock !== ws) return;
      clearTimeout(connectTimer);
      lastRx = Date.now();
      delay = 500;
      startPing();
      var sess = Net.getSession();
      if (sess) {
        pendingRejoin = true;
        raw({ type: 'rejoin', code: sess.code, token: sess.token });
      } else if (pendingHello) {
        // the socket may have died after sending create/join but before the ack:
        // ask again (the server lets a join take over its own dropped seat)
        raw(pendingHello);
      }
      while (queue.length) raw(queue.shift());
      emit('open');
    };
    sock.onmessage = function (ev) {
      if (sock !== ws) return;
      lastRx = Date.now();
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m.type !== 'string') return;
      switch (m.type) {
        case 'pong':
          if (typeof m.t === 'number') Net.latency = Date.now() - m.t;
          break;
        case 'error':
          pendingHello = null;
          if (pendingRejoin || m.reason === 'room_closed') {
            pendingRejoin = false;
            Net.clearSession();
            emit('rejoin_failed', m);
            return;
          }
          break;
        case 'created':
        case 'joined':
        case 'rejoined':
          pendingRejoin = false;
          pendingHello = null;
          if (m.code && m.token) Net.setSession({ code: m.code, token: m.token, team: m.team });
          break;
        case 'opponent_quit':
          // the room is gone: never try to rejoin it
          pendingRejoin = false;
          Net.clearSession();
          break;
        case 'state':
        case 'start':
        case 'opponent_left':
        case 'opponent_back':
          pendingRejoin = false;
          break;
      }
      emit(m.type, m);
    };
    sock.onclose = function () {
      if (sock !== ws) return;
      ws = null;
      clearTimeout(connectTimer);
      clearTimeout(probeTimer);
      stopPing();
      emit('close');
      if (want) schedule();
    };
    sock.onerror = function () { /* onclose follows */ };
  }

  /** Ensure a connection (no-op if already connecting/open). */
  Net.connect = function () {
    want = true;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    open();
  };

  /** Send now if open; returns false (and drops the message) otherwise. */
  Net.send = function (obj) { return raw(obj); };

  /** Send now, or queue and connect if not open yet. create/join stay pending until
   *  acknowledged and are re-sent after a reconnect. */
  Net.sendWhenOpen = function (obj) {
    if (obj && (obj.type === 'create' || obj.type === 'join')) {
      pendingHello = obj;
      want = true;
      if (!raw(obj)) Net.connect();
      return;
    }
    if (!raw(obj)) { queue.push(obj); Net.connect(); }
  };

  /** Leave the game for good: tell the server (so the opponent sees a quit, not a
   *  dropout), no reconnect, forget the session. */
  Net.leave = function () {
    raw({ type: 'leave' });
    want = false;
    pendingRejoin = false;
    pendingHello = null;
    queue.length = 0;
    Net.clearSession();
    clearTimeout(timer);
    clearTimeout(probeTimer);
    clearTimeout(connectTimer);
    stopPing();
    if (ws) {
      var s = ws;
      ws = null;
      try { s.close(); } catch (e) { /* ignore */ }
    }
  };

  Net.isOpen = function () { return !!(ws && ws.readyState === 1); };
  Net.isRejoining = function () { return pendingRejoin; };
  Net.wantsConnection = function () { return want; };

  /** Page came back (unlocked phone, switched apps, network back): make sure the
   *  socket is really alive. Background tabs get their timers frozen, so we ping
   *  right away and redial if nothing comes back quickly. */
  function kick() {
    if (!want) return;
    if (!ws) { delay = 500; open(); return; }
    if (ws.readyState !== 1) return;          // still connecting
    var sent = Date.now();
    raw({ type: 'ping', t: sent });
    clearTimeout(probeTimer);
    probeTimer = setTimeout(function () {
      if (want && ws && ws.readyState === 1 && lastRx < sent) forceReconnect();
    }, 2500);
  }
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') kick();
  });
  window.addEventListener('pageshow', kick);
  window.addEventListener('focus', kick);

  window.Net = Net;
})();
