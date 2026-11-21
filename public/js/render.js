/* Gridiron Duel - canvas renderer (window.Render)
 * The world is drawn into a low-resolution buffer (PPY low-res pixels per yard)
 * that is blitted to the full device-resolution canvas with an integer scale and
 * image smoothing disabled, which gives a crisp, authentic pixel look.
 */
(function () {
  'use strict';

  var PPY = 10;                       // low-res pixels per field yard (chosen in resize, ~9-13)
  var FW = 53.3;                      // field width (sideline to sideline) in yards
  var X0 = -8, X1 = 128, Y0 = -12, Y1 = 65.3;   // cached world bounds (yards)
  var VIEW_YARDS = 32;                // target yards visible vertically: the whole formation fits under the HUD
  var BG = '#1b1f2e';
  var ROUTE_COLORS = { WR1: '#ff93d6', WR2: '#80ecff', TE: '#d3b6ff', RB: '#ffe66b' };

  var TEAMS = [
    { main: '#d8372b', dark: '#8a1c14', pants: '#f0f0f0', ez: '#b02d23', ez2: '#93241b' },
    { main: '#2c6ee0', dark: '#173c8c', pants: '#e3c35a', ez: '#2456b6', ez2: '#1d479b' }
  ];

  // ---------------------------------------------------------------- 3x5 pixel font
  var GLYPHS = {
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
    '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001001010010',
    '8': '111101111101111', '9': '111101111001111',
    'A': '010101111101101', 'B': '110101110101110', 'C': '011100100100011', 'D': '110101101101110',
    'E': '111100110100111', 'F': '111100110100100', 'G': '011100101101011', 'H': '101101111101101',
    'I': '111010010010111', 'J': '001001001101010', 'K': '101101110101101', 'L': '100100100100111',
    'M': '101111111101101', 'N': '110101101101101', 'O': '010101101101010', 'P': '110101110100100',
    'Q': '010101101110011', 'R': '110101110101101', 'S': '011100010001110', 'T': '111010010010010',
    'U': '101101101101111', 'V': '101101101101010', 'W': '101101111111101', 'X': '101101010101101',
    'Y': '101101010010010', 'Z': '111001010100111',
    '-': '000000111000000', '.': '000000000000010', '!': '010010010000010', '?': '111001010000010',
    ':': '000010000010000', '/': '001001010100100', '&': '010101010101011', "'": '010010000000000',
    ' ': '000000000000000'
  };

  function drawText(c, str, x, y, s, color) {
    c.fillStyle = color;
    for (var i = 0; i < str.length; i++) {
      var g = GLYPHS[str.charAt(i)] || GLYPHS[str.charAt(i).toUpperCase()];
      if (g) {
        for (var b = 0; b < 15; b++) {
          if (g.charCodeAt(b) === 49) c.fillRect(x + (b % 3) * s, y + ((b / 3) | 0) * s, s, s);
        }
      }
      x += 4 * s;
    }
  }
  function textWidth(str, s) { return str.length ? str.length * 4 * s - s : 0; }

  // ---------------------------------------------------------------- pixel sprites
  var BODY = [
    '....oooo....',
    '...oHHHHo...',
    '..oHHwHHHo..',
    '..oHHwHHsmo.',
    '..oHHHHssmo.',
    '..ohHHHHsmo.',
    '...oohhoo...',
    '.oJJJJJJJJo.',
    'oJJJJJJJJJJo',
    'osJJJJJJJJso',
    'osJJJJJJJJso',
    'osJJJJJJJJso',
    '.ojjjjjjjjo.',
    '..pppppppp..'
  ];
  var LEGS = [
    ['..ppp..ppp..', '..kkk..kkk..', '..kkk..kkk..', '..bbbb.bbbb.'],
    ['.ppp....ppp.', '.kkk....kkk.', 'kkk......kkk', 'bbb.....bbbb'],
    ['...pppppp...', '...kkkkkk...', '....kkkk....', '....bbbbb...']
  ];
  var SPR_W = 12, SPR_H = 18;
  var SKINS = ['#f1c27d', '#c68642', '#8d5524', '#e0ac69', '#a8683a'];
  var ID_INFO = {
    QB: [7, 0], RB: [22, 1], WR1: [11, 2], WR2: [84, 3], TE: [88, 4], OL1: [72, 0], OL2: [65, 2],
    DL1: [91, 1], DL2: [97, 3], LB: [54, 4], CB1: [24, 2], CB2: [21, 0], S1: [32, 3], S2: [43, 1]
  };
  var PHASE = {};
  (function () {
    var k = 0;
    for (var id in ID_INFO) { PHASE[id] = (k * 0.37) % 1; k++; }
  })();

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function pixArt(rows, colors) {
    var cv = makeCanvas(rows[0].length, rows.length);
    var c = cv.getContext('2d');
    for (var r = 0; r < rows.length; r++) {
      for (var x = 0; x < rows[r].length; x++) {
        var ch = rows[r].charAt(x);
        if (ch === '.') continue;
        c.fillStyle = colors[ch];
        c.fillRect(x, r, 1, 1);
      }
    }
    return cv;
  }

  var spriteCache = [[[{}, {}, {}], [{}, {}, {}]], [[{}, {}, {}], [{}, {}, {}]]];

  function makeSprite(team, id, facing, frame) {
    var T = TEAMS[team];
    var info = ID_INFO[id] || [0, 0];
    var cv = makeCanvas(SPR_W, SPR_H);
    var c = cv.getContext('2d');
    var pal = {
      o: '#141414', m: '#c9c9c9', w: '#ffffff', b: '#1a1a1a',
      H: T.main, h: T.dark, J: T.main, j: T.dark, s: SKINS[info[1]], p: T.pants, k: T.dark
    };
    var rows = BODY.concat(LEGS[frame]);
    for (var r = 0; r < rows.length; r++) {
      for (var x = 0; x < SPR_W; x++) {
        var ch = rows[r].charAt(x);
        if (ch === '.') continue;
        c.fillStyle = pal[ch];
        c.fillRect(facing > 0 ? x : SPR_W - 1 - x, r, 1, 1);
      }
    }
    if (info[0]) {
      var n = String(info[0]);
      drawText(c, n, Math.floor((SPR_W - textWidth(n, 1)) / 2), 8, 1, '#ffffff');
    }
    return cv;
  }

  function getSprite(team, id, facing, frame) {
    var bucket = spriteCache[team ? 1 : 0][facing > 0 ? 0 : 1][frame];
    var s = bucket[id];
    if (!s) s = bucket[id] = makeSprite(team ? 1 : 0, id, facing, frame);
    return s;
  }

  var IMG_SHADOW = pixArt(['..######..', '.########.', '..######..'], { '#': 'rgba(0,0,0,0.35)' });
  var IMG_RING_A = pixArt([
    '....######....',
    '..##......##..',
    '##..........##',
    '..##......##..',
    '....######....'
  ], { '#': '#ffe23a' });
  var IMG_RING_B = pixArt([
    '....######....',
    '..##......##..',
    '##..........##',
    '..##......##..',
    '....######....'
  ], { '#': '#ffffff' });
  var IMG_ARROW = pixArt(['ooooooo', 'o#####o', '.o###o.', '..o#o..', '...o...'], { '#': '#ffe23a', o: '#141414' });
  var BALL_PAL = { b: '#9a5523', o: '#2a1306', w: '#f4f4f4' };
  var IMG_BALL_A = pixArt(['..ooo..', '.obbbo.', 'obwwwbo', '.obbbo.', '..ooo..'], BALL_PAL);
  var IMG_BALL_B = pixArt(['...oo..', '..obbo.', '.obwbo.', '.obbo..', '..oo...'], BALL_PAL);
  var IMG_BALL_SH = pixArt(['.#####.', '#######', '.#####.'], { '#': 'rgba(0,0,0,0.35)' });
  var IMG_MARK = pixArt([
    '#.....#',
    '.#...#.',
    '..#.#..',
    '...#...',
    '..#.#..',
    '.#...#.',
    '#.....#'
  ], { '#': '#ffe23a' });
  var IMG_MARK_BAD = pixArt([
    '#.....#',
    '.#...#.',
    '..#.#..',
    '...#...',
    '..#.#..',
    '.#...#.',
    '#.....#'
  ], { '#': '#ff5a4a' });

  // ---------------------------------------------------------------- canvas state
  var canvas = null, ctx = null, lo = null, lctx = null;
  var dpr = 1, P = 1, devW = 1, devH = 1, bufW = 1, bufH = 1, cssW = 1, cssH = 1;
  var topInsetCss = 0, topInsetLo = 0;
  var camX = 60, camY = FW / 2, camInit = false;
  var camLeftPx = 0, camTopPx = 0;
  var shake = 0, shX = 0, shY = 0;
  var field = null, fPoss = -1, fN0 = null, fN1 = null;
  var sorted = [];
  var DEFAULT_NAMES = ['HOME', 'AWAY'];

  function init(c) {
    canvas = c;
    ctx = c.getContext('2d', { alpha: false });
    lo = makeCanvas(1, 1);
    lctx = lo.getContext('2d', { alpha: false });
    resize();
  }

  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    cssW = window.innerWidth || 1;
    cssH = window.innerHeight || 1;
    devW = Math.max(1, Math.round(cssW * dpr));
    devH = Math.max(1, Math.round(cssH * dpr));
    canvas.width = devW;
    canvas.height = devH;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    // pick an integer upscale P and a whole number of low-res pixels per yard so that
    // ~VIEW_YARDS yards are visible vertically and sprites stay chunky
    var bestP = 1, bestErr = Infinity;
    for (var cand = 1; cand <= 10; cand++) {
      var ppy = devH / cand / VIEW_YARDS;
      if (ppy < 8 && cand > 1) break;
      var err = Math.abs(ppy - 9.5) + (ppy > 14 ? 50 : 0);   // prefers chunky (~24 css px) sprites
      if (err < bestErr) { bestErr = err; bestP = cand; }
    }
    P = bestP;
    var newPPY = Math.max(6, Math.round(devH / P / VIEW_YARDS));
    if (newPPY !== PPY) { PPY = newPPY; fPoss = -1; }
    bufW = Math.ceil(devW / P);
    bufH = Math.ceil(devH / P);
    lo.width = bufW;
    lo.height = bufH;
    ctx.imageSmoothingEnabled = false;
    lctx.imageSmoothingEnabled = false;
    topInsetLo = Math.round(topInsetCss * dpr / P);
  }

  function setTopInset(px) {
    topInsetCss = px || 0;
    topInsetLo = Math.round(topInsetCss * dpr / P);
  }

  // ---------------------------------------------------------------- coordinate helpers
  function screenToField(clientX, clientY, out) {
    out = out || { x: 0, y: 0 };
    var lx = clientX * dpr / P, ly = clientY * dpr / P;
    out.x = (lx + camLeftPx) / PPY;
    out.y = (ly + camTopPx) / PPY;
    return out;
  }
  function fieldToScreen(x, y, out) {
    out = out || { x: 0, y: 0 };
    out.x = (x * PPY - camLeftPx) * P / dpr;
    out.y = (y * PPY - camTopPx) * P / dpr;
    return out;
  }
  function pxPerYard() { return PPY * P / dpr; }

  // ---------------------------------------------------------------- field cache
  function lcg(seed) {
    var s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  var CROWD = ['#d8372b', '#2c6ee0', '#f1c27d', '#e0e0e0', '#ffd23a', '#8d5524', '#c68642', '#6a7390', '#3fbf5a'];

  function buildField(names, poss) {
    var W = Math.round((X1 - X0) * PPY), H = Math.round((Y1 - Y0) * PPY);
    if (!field) field = makeCanvas(W, H);
    else { field.width = W; field.height = H; }
    var c = field.getContext('2d');
    var rnd = lcg(1337);
    function PX(x) { return Math.round((x - X0) * PPY); }
    function PY(y) { return Math.round((y - Y0) * PPY); }
    function R(x0, y0, x1, y1, col) {
      var a = PX(x0), b = PY(y0);
      c.fillStyle = col;
      c.fillRect(a, b, PX(x1) - a, PY(y1) - b);
    }
    function crowd(pyA, pyB) {
      for (var py = pyA + 1, row = 0; py < pyB - 3; py += 4, row++) {
        c.fillStyle = row % 2 ? '#262b3d' : '#2c3147';
        c.fillRect(0, py - 1, W, 4);
        for (var px = (row % 2) * 2; px < W; px += 4) {
          if (rnd() < 0.8) {
            c.fillStyle = CROWD[(rnd() * CROWD.length) | 0];
            c.fillRect(px, py, 2, 2);
          }
        }
      }
    }

    c.fillStyle = BG;
    c.fillRect(0, 0, W, H);
    crowd(0, PY(-5.4));
    crowd(PY(58.7), H);
    R(X0, -5.4, X1, -4.6, '#454c63');
    R(X0, 57.9, X1, 58.7, '#454c63');
    R(X0, -4.6, X1, 57.9, '#2b7430');                         // apron
    R(-2, -2, 122, 55.3, '#2f7d34');

    for (var i = 0; i < 20; i++) R(10 + i * 5, 0, 15 + i * 5, FW, i % 2 ? '#45a349' : '#3c9541');
    var fx0 = PX(0), fy0 = PY(0), fw = PX(120) - fx0, fh = PY(FW) - fy0;
    for (var n = 0; n < 7000; n++) {
      c.fillStyle = rnd() < 0.55 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.06)';
      c.fillRect(fx0 + ((rnd() * fw) | 0), fy0 + ((rnd() * fh) | 0), 1, 1);
    }

    function endzone(xa, xb, team, name, dir) {
      var T = TEAMS[team];
      R(xa, 0, xb, FW, T.ez);
      var ex = PX(xa), ey = PY(0), ew = PX(xb) - ex, eh = PY(FW) - ey;
      c.fillStyle = T.ez2;
      for (var py = 0; py < eh; py++) {
        var off = (dir > 0 ? py : eh - py) % 16;
        for (var bx = off - 16; bx < ew; bx += 16) {
          var a = Math.max(0, bx), b = Math.min(ew, bx + 6);
          if (b > a) c.fillRect(ex + a, ey + py, b - a, 1);
        }
      }
      var label = String(name || '').toUpperCase().slice(0, 12);
      var s = 5;
      var tw = textWidth(label, s);
      c.save();
      c.translate(ex + Math.round(ew / 2), ey + Math.round(eh / 2));
      c.rotate(dir < 0 ? -Math.PI / 2 : Math.PI / 2);
      drawText(c, label, -Math.round(tw / 2) + 2, -Math.round(2.5 * s) + 2, s, 'rgba(0,0,0,0.35)');
      drawText(c, label, -Math.round(tw / 2), -Math.round(2.5 * s), s, '#ffffff');
      c.restore();
    }
    endzone(0, 10, poss, names[poss], -1);
    endzone(110, 120, 1 - poss, names[1 - poss], 1);

    // lines
    var white = '#f4f4f4';
    c.fillStyle = white;
    c.fillRect(PX(0) - 2, PY(0) - 2, PX(120) - PX(0) + 4, 2);
    c.fillRect(PX(0) - 2, PY(FW), PX(120) - PX(0) + 4, 2);
    c.fillRect(PX(0) - 2, PY(0), 2, PY(FW) - PY(0));
    c.fillRect(PX(120), PY(0), 2, PY(FW) - PY(0));
    c.fillRect(PX(10) - 1, PY(0), 2, PY(FW) - PY(0));
    c.fillRect(PX(110) - 1, PY(0), 2, PY(FW) - PY(0));
    for (var yl = 15; yl < 110; yl += 5) {
      c.fillStyle = yl === 60 ? white : 'rgba(244,244,244,0.85)';
      c.fillRect(PX(yl), PY(0), yl % 10 === 0 ? 2 : 1, PY(FW) - PY(0));
    }
    c.fillStyle = 'rgba(244,244,244,0.85)';
    var hashA = FW / 2 - 3.1, hashB = FW / 2 + 3.1;
    for (var hx = 11; hx < 110; hx++) {
      if (hx % 5 === 0) continue;
      var px = PX(hx);
      c.fillRect(px, PY(0), 1, 6);
      c.fillRect(px, PY(FW) - 6, 1, 6);
      c.fillRect(px, PY(hashA) - 3, 1, 6);
      c.fillRect(px, PY(hashB) - 3, 1, 6);
    }
    // yard numbers
    for (var k = 1; k <= 9; k++) {
      var v = String((k <= 5 ? k : 10 - k) * 10);
      var lx = PX(10 + k * 10);
      var tops = [PY(11) - 7, PY(FW - 11) - 7];
      for (var t = 0; t < 2; t++) {
        drawText(c, v.charAt(0), lx - 12, tops[t], 3, white);
        drawText(c, v.charAt(1), lx + 4, tops[t], 3, white);
      }
    }
    // midfield emblem (diamond)
    var mx = PX(60), my = PY(FW / 2);
    c.fillStyle = 'rgba(255,255,255,0.18)';
    for (var d = 0; d < 9; d++) c.fillRect(mx - d * 2, my - 9 + d, d * 4 + 2, 1);
    for (var d2 = 0; d2 < 9; d2++) c.fillRect(mx - (8 - d2) * 2, my + d2, (8 - d2) * 4 + 2, 1);
    // goal posts (flat, at the back of each endzone)
    c.fillStyle = '#ffd23a';
    var gpA = PY(FW / 2 - 3.1), gpB = PY(FW / 2 + 3.1);
    c.fillRect(PX(120) - 1, gpA, 3, gpB - gpA);
    c.fillRect(PX(120) - 1, gpA - 1, 6, 3);
    c.fillRect(PX(120) - 1, gpB - 2, 6, 3);
    c.fillRect(PX(0) - 2, gpA, 3, gpB - gpA);
    c.fillRect(PX(0) - 5, gpA - 1, 6, 3);
    c.fillRect(PX(0) - 5, gpB - 2, 6, 3);
  }

  // ---------------------------------------------------------------- particles & shake
  var PARTS = [];
  for (var pi = 0; pi < 260; pi++) PARTS.push({ a: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, g: 0, col: '#fff', s: 1 });
  var CONFETTI = ['#ffd23a', '#d8372b', '#2c6ee0', '#ffffff', '#3fbf5a', '#ff7ad9'];

  function burst(kind, x, y) {
    if (!isFinite(x) || !isFinite(y)) return;
    var count = kind === 'confetti' ? 80 : 14;
    for (var i = 0; i < PARTS.length && count > 0; i++) {
      var p = PARTS[i];
      if (p.a) continue;
      count--;
      p.a = true; p.x = x; p.y = y;
      var ang = Math.random() * Math.PI * 2;
      if (kind === 'confetti') {
        var sp = 2 + Math.random() * 6;
        p.vx = Math.cos(ang) * sp; p.vy = Math.sin(ang) * sp * 0.6;
        p.z = 1; p.vz = 6 + Math.random() * 8; p.g = 6; p.life = 1.6 + Math.random();
        p.col = CONFETTI[(Math.random() * CONFETTI.length) | 0]; p.s = Math.random() < 0.5 ? 3 : 2;
      } else {
        var sp2 = 1 + Math.random() * 3;
        p.vx = Math.cos(ang) * sp2; p.vy = Math.sin(ang) * sp2 * 0.6;
        p.z = 0.1; p.vz = 2 + Math.random() * 3; p.g = 14; p.life = 0.35 + Math.random() * 0.3;
        p.col = Math.random() < 0.5 ? '#d9cfa8' : '#a89a72'; p.s = Math.random() < 0.4 ? 2 : 1;
      }
    }
  }
  function addShake(a) { shake = Math.max(shake, a || 3); }

  // ---------------------------------------------------------------- drawing
  function byY(a, b) { return a.y - b.y; }

  function findPlayer(s, id) {
    var ps = s.players;
    if (!ps || id == null) return null;
    for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
    return null;
  }

  function clampCam() {
    var minL = X0 * PPY, maxL = X1 * PPY - bufW;
    camLeftPx = Math.round(camX * PPY - bufW / 2);
    if (maxL < minL) camLeftPx = Math.round((minL + maxL) / 2);
    else camLeftPx = Math.max(minL, Math.min(maxL, camLeftPx));
    var visH = bufH - topInsetLo;
    var minT = Y0 * PPY - topInsetLo, maxT = Y1 * PPY - bufH;
    camTopPx = Math.round(camY * PPY - topInsetLo - visH / 2);
    if (maxT < minT) camTopPx = Math.round((minT + maxT) / 2);
    else camTopPx = Math.max(minT, Math.min(maxT, camTopPx));
  }

  function draw(s, o) {
    if (!canvas) return;
    var now = o.now || 0, dt = Math.min(0.1, o.dt || 0.016);
    var names = (s && s.teamNames) || DEFAULT_NAMES;
    var poss = s && (s.possession === 1) ? 1 : 0;
    if (!field || poss !== fPoss || names[0] !== fN0 || names[1] !== fN1) {
      buildField(names, poss);
      fPoss = poss; fN0 = names[0]; fN1 = names[1];
    }

    // ---- camera
    var ph = s ? s.phase : null;
    var tx, ty, rate = 5;
    if (s) {
      var los = 10 + (s.ballOn || 0);
      var b = s.ball;
      var bx = b ? b.x : los, by = b ? b.y : FW / 2;
      if (ph === 'playcall' || ph === 'presnap') { tx = los + 7; ty = by; }
      else if (ph === 'kick') { tx = los + 12; ty = FW / 2; }
      else {
        tx = bx + 5; ty = by;
        if (b && b.state === 'air') rate = 7;
        // aiming: lean the camera toward the landing spot so the target stays on screen
        var am = o.aim;
        if (am && am.active && ph === 'live') { tx = Math.max(tx, (bx + am.tx) / 2 + 3); ty = by + (am.ty - by) * 0.5; rate = 4; }
      }
    } else {
      tx = 60 + Math.sin(now / 5000) * 35;
      ty = FW / 2 + Math.sin(now / 3700) * 8;
    }
    if (!isFinite(tx)) tx = 60;
    if (!isFinite(ty)) ty = FW / 2;
    if (!camInit || Math.abs(tx - camX) > 40) { camX = tx; camY = ty; camInit = true; }
    else {
      var k = 1 - Math.exp(-dt * rate);
      camX += (tx - camX) * k;
      camY += (ty - camY) * k;
    }
    clampCam();
    if (shake > 0.3) {
      shX = Math.round((Math.random() - 0.5) * 2 * shake);
      shY = Math.round((Math.random() - 0.5) * 2 * shake);
      shake *= Math.exp(-dt * 9);
    } else { shake = 0; shX = 0; shY = 0; }
    var ox = -camLeftPx + shX, oy = -camTopPx + shY;

    lctx.fillStyle = BG;
    lctx.fillRect(0, 0, bufW, bufH);
    lctx.drawImage(field, X0 * PPY + ox, Math.round(Y0 * PPY) + oy);

    if (s) {
      // ---- LOS & first-down line
      if (ph === 'playcall' || ph === 'presnap' || ph === 'live' || ph === 'kick') {
        var losX = 10 + s.ballOn;
        var fh = Math.round(FW * PPY);
        lctx.fillStyle = '#4d8dff';
        lctx.fillRect(Math.round(losX * PPY) + ox - 1, oy, 2, fh);
        var fd = losX + (s.toGo || 0);
        if (ph !== 'kick' && fd < 110 && s.toGo > 0) {
          lctx.fillStyle = '#ffe23a';
          lctx.fillRect(Math.round(fd * PPY) + ox - 1, oy, 2, fh);
        }
      }

      var routeColors = null;
      if (o.myTeam === poss && (ph === 'presnap' || ph === 'live') && window.GridSim && window.GridSim.routePreview) {
        routeColors = drawRoutes(window.GridSim.routePreview(s), ox, oy);
      }

      var ball = s.ball;
      var ctrl = (ph === 'gameover' || ph === 'kick') ? null : findPlayer(s, o.controlledId);
      var ps = s.players || [];
      sorted.length = 0;
      for (var i = 0; i < ps.length; i++) sorted.push(ps[i]);
      sorted.sort(byY);

      // shadows
      for (i = 0; i < sorted.length; i++) {
        var sp = sorted[i];
        lctx.drawImage(IMG_SHADOW, Math.round(sp.x * PPY) + ox - 5, Math.round(sp.y * PPY) + oy - 2);
      }
      if (ball && ball.state === 'air') {
        lctx.drawImage(IMG_BALL_SH, Math.round(ball.x * PPY) + ox - 3, Math.round(ball.y * PPY) + oy - 1);
      }
      // control ring
      if (ctrl) {
        var ring = ((now / 180) | 0) % 2 ? IMG_RING_A : IMG_RING_B;
        lctx.drawImage(ring, Math.round(ctrl.x * PPY) + ox - 7, Math.round(ctrl.y * PPY) + oy - 2);
      }
      // players
      var offTeam = s.possession === 1 ? 1 : 0;
      var heldBy = ball && ball.state === 'held' ? ball.holder : null;
      var drewHeld = false;
      for (i = 0; i < sorted.length; i++) {
        var p = sorted[i];
        var team = p.side === 'off' ? offTeam : 1 - offTeam;
        var facing = p.side === 'off' ? 1 : -1;
        var vx = p.vx || 0, vy = p.vy || 0;
        if (vx > 0.4) facing = 1; else if (vx < -0.4) facing = -1;
        var frame = 0;
        if (vx * vx + vy * vy > 0.5) {
          var cyc = ((now * 0.012 + (PHASE[p.id] || 0) * 4) | 0) % 4;
          frame = cyc === 0 ? 1 : (cyc === 2 ? 2 : 0);
        }
        var sx = Math.round(p.x * PPY) + ox, sy = Math.round(p.y * PPY) + oy;
        if (sx < -20 || sx > bufW + 20 || sy < -30 || sy > bufH + 30) continue;
        if (p.juking && ((now / 70) | 0) % 2) lctx.globalAlpha = 0.45;
        lctx.drawImage(getSprite(team, p.id, facing, frame), sx - 6, sy - SPR_H);
        lctx.globalAlpha = 1;
        if (routeColors && routeColors[p.id]) drawRouteTag(p.id, routeColors[p.id], sx, sy + 3);
        if (heldBy && p.id === heldBy) {
          lctx.drawImage(IMG_BALL_A, facing > 0 ? sx + 2 : sx - 9, sy - 10);
          drewHeld = true;
        }
      }
      // ball (air / dead / held but holder missing)
      if (ball && (ball.state !== 'held' || !drewHeld) && isFinite(ball.x)) {
        var bz = ball.z || 0;
        var img = ball.state === 'air' && ((now / 90) | 0) % 2 ? IMG_BALL_B : IMG_BALL_A;
        lctx.drawImage(img, Math.round(ball.x * PPY) + ox - 3, Math.round((ball.y - bz) * PPY) + oy - 5);
      }
      // arrow over controlled player / edge indicator
      if (ctrl) {
        var ax = Math.round(ctrl.x * PPY) + ox, ay = Math.round(ctrl.y * PPY) + oy - SPR_H - 7 - (((now / 250) | 0) % 2);
        var minY = topInsetLo + 2;
        if (ax < 4 || ax > bufW - 4 || ay < minY || ay > bufH - 8) {
          ax = Math.max(6, Math.min(bufW - 10, ax));
          ay = Math.max(minY + 2, Math.min(bufH - 10, ay));
          lctx.fillStyle = '#141414';
          lctx.fillRect(ax - 4, ay - 4, 9, 9);
          lctx.fillStyle = '#ffe23a';
          lctx.fillRect(ax - 3, ay - 3, 7, 7);
        } else {
          lctx.drawImage(IMG_ARROW, ax - 3, ay);
        }
      }
      // Match off-screen receivers to the same color as their route.
      if (o.showReceivers) {
        for (i = 0; i < ps.length; i++) {
          var rp = ps[i];
          if (rp.side !== 'off' || !(rp.id === 'WR1' || rp.id === 'WR2' || rp.id === 'TE' || rp.id === 'RB')) continue;
          var rx = Math.round(rp.x * PPY) + ox, ry = Math.round(rp.y * PPY) + oy - 9;
          var top = topInsetLo + 1;
          if (rx >= 0 && rx <= bufW && ry >= top && ry <= bufH) continue;
          var exx = Math.max(4, Math.min(bufW - 5, rx)), eyy = Math.max(top + 3, Math.min(bufH - 4, ry));
          lctx.fillStyle = '#141414';
          lctx.fillRect(exx - 4, eyy - 4, 9, 9);
          lctx.fillStyle = (routeColors && routeColors[rp.id]) || TEAMS[offTeam].main;
          lctx.fillRect(exx - 3, eyy - 3, 7, 7);
          lctx.fillStyle = '#ffffff';
          if (ry < top) lctx.fillRect(exx, eyy - 2, 1, 3); else if (ry > bufH) lctx.fillRect(exx, eyy, 1, 3);
          else if (rx > bufW) lctx.fillRect(exx, eyy, 3, 1); else lctx.fillRect(exx - 2, eyy, 3, 1);
        }
      }
      // aim arc & landing marker
      var a = o.aim;
      if (a && a.active && ph === 'live') drawAim(a, ox, oy, now);
    }

    // particles
    for (var q = 0; q < PARTS.length; q++) {
      var pp = PARTS[q];
      if (!pp.a) continue;
      pp.life -= dt;
      if (pp.life <= 0) { pp.a = false; continue; }
      pp.x += pp.vx * dt; pp.y += pp.vy * dt; pp.z += pp.vz * dt; pp.vz -= pp.g * dt;
      if (pp.z < 0) { pp.z = 0; pp.vz = 0; pp.vx *= 0.8; pp.vy *= 0.8; }
      lctx.fillStyle = pp.col;
      lctx.fillRect(Math.round(pp.x * PPY) + ox, Math.round((pp.y - pp.z) * PPY) + oy, pp.s, pp.s);
    }

    if (s && ph === 'kick' && s.kickMeter != null) drawKick(s);

    ctx.drawImage(lo, 0, 0, bufW, bufH, 0, 0, bufW * P, bufH * P);
  }

  function drawPlayDiagram(canvas, line, paths, offense, compact) {
    var c = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    var min = Math.min(line - 8, 103), max = Math.max(line + 25, 1);
    paths.forEach(function (path) {
      path.points.forEach(function (pt) { max = Math.max(max, pt.x + (path.radius || 0) + 2); });
    });
    var padX = compact ? 14 : 21, padY = compact ? 9 : 14;
    var sx = (w - padX * 2) / (max - min), sy = (h - padY * 2) / FW;
    function x(yards) { return padX + (yards - min) * sx; }
    function y(yards) { return padY + yards * sy; }
    function color(path) {
      return offense ? ROUTE_COLORS[path.id] : { zone: '#7ecbff', man: '#e4b9ff', rush: '#ffb36d' }[path.kind];
    }

    c.clearRect(0, 0, w, h);
    c.fillStyle = '#214937';
    c.fillRect(0, 0, w, h);
    c.lineWidth = 1;
    c.strokeStyle = compact ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.20)';
    for (var stripe = Math.ceil(min / 5) * 5; stripe < max; stripe += 5) {
      c.beginPath(); c.moveTo(x(stripe), 0); c.lineTo(x(stripe), h); c.stroke();
    }
    c.strokeStyle = '#f3e2a1';
    c.beginPath(); c.moveTo(x(line), 0); c.lineTo(x(line), h); c.stroke();

    paths.forEach(function (path) {
      if (path.kind !== 'zone') return;
      var end = path.points[1];
      c.beginPath();
      c.ellipse(x(end.x), y(end.y), path.radius * sx, path.radius * sy, 0, 0, Math.PI * 2);
      c.fillStyle = 'rgba(126,203,255,0.11)'; c.fill();
      c.strokeStyle = 'rgba(126,203,255,0.40)'; c.stroke();
    });

    c.font = 'bold 12px monospace';
    c.lineJoin = 'round';
    c.lineCap = 'round';
    var head = compact ? 6 : 8;
    paths.forEach(function (path) {
      var pts = path.points;
      var end = pts[pts.length - 1], prev = pts[pts.length - 2];
      var ex = x(end.x), ey = y(end.y);
      var angle = Math.atan2(ey - y(prev.y), ex - x(prev.x));
      c.strokeStyle = color(path);
      c.lineWidth = compact ? 2 : 2.5;
      c.setLineDash(path.kind === 'block' ? [4, 4] : []);
      c.beginPath(); c.moveTo(x(pts[0].x), y(pts[0].y));
      pts.slice(1).forEach(function (pt) { c.lineTo(x(pt.x), y(pt.y)); });
      c.stroke();
      c.setLineDash([]);
      c.beginPath();
      if (path.kind === 'block') {
        c.moveTo(ex + Math.sin(angle) * 5, ey - Math.cos(angle) * 5);
        c.lineTo(ex - Math.sin(angle) * 5, ey + Math.cos(angle) * 5);
      } else {
        c.moveTo(ex - head * Math.cos(angle - 0.55), ey - head * Math.sin(angle - 0.55));
        c.lineTo(ex, ey);
        c.lineTo(ex - head * Math.cos(angle + 0.55), ey - head * Math.sin(angle + 0.55));
      }
      c.stroke();
      if (!compact && path.target) {
        c.fillStyle = c.strokeStyle;
        c.fillText(path.target, ex - 26, ey - 6);
      }
    });

    paths.forEach(function (path) {
      var start = path.points[0], px = x(start.x), py = y(start.y);
      c.fillStyle = color(path);
      c.beginPath(); c.arc(px, py, compact ? 3 : 4, 0, 2 * Math.PI); c.fill();
      if (compact) return;
      var labelY = py + (path.id === 'DL1' ? -6 : 14);
      c.strokeStyle = '#17352a'; c.lineWidth = 3;
      c.strokeText(path.id, px + 6, labelY);
      c.fillText(path.id, px + 6, labelY);
    });
  }

  function drawKickDiagram(canvas, play) {
    var c = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    var goal = play === 'fg', farX = w * 0.8, ground = h * 0.77;
    c.fillStyle = '#214937';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(255,255,255,0.17)';
    c.lineWidth = 1;
    c.beginPath();
    for (var x = w * 0.14; x < w; x += w * 0.14) {
      c.moveTo(x, 0); c.lineTo(x, h);
    }
    c.stroke();

    c.strokeStyle = '#f3e2a1';
    c.lineWidth = 2.5;
    c.setLineDash([5, 5]);
    c.beginPath();
    c.moveTo(w * 0.18, ground);
    c.quadraticCurveTo(w * 0.46, h * -0.16, farX, goal ? h * 0.42 : ground);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = '#f3e2a1';
    c.beginPath(); c.arc(w * 0.18, ground, 4, 0, Math.PI * 2); c.fill();

    c.beginPath();
    if (goal) {
      var arm = w * 0.07, bar = h * 0.57;
      c.moveTo(farX - arm, h * 0.22); c.lineTo(farX - arm, bar);
      c.lineTo(farX + arm, bar); c.lineTo(farX + arm, h * 0.22);
      c.moveTo(farX, bar); c.lineTo(farX, ground);
    } else {
      c.arc(farX, ground, 6, 0, Math.PI * 2);
    }
    c.stroke();
  }

  function drawRoutes(routes, ox, oy) {
    if (!routes.length) return null;
    var colors = {};
    lctx.save();
    lctx.lineJoin = 'round';
    for (var i = 0; i < routes.length; i++) {
      var route = routes[i], points = route.points;
      var block = route.kind === 'block';
      var color = colors[route.id] = ROUTE_COLORS[route.id];
      lctx.setLineDash(block ? [3, 3] : []);
      lctx.beginPath();
      lctx.moveTo(Math.round(points[0].x * PPY) + ox, Math.round(points[0].y * PPY) + oy);
      for (var j = 1; j < points.length; j++) {
        lctx.lineTo(Math.round(points[j].x * PPY) + ox, Math.round(points[j].y * PPY) + oy);
      }
      lctx.lineWidth = block ? 3 : 4;
      lctx.strokeStyle = 'rgba(10,20,25,0.78)';
      lctx.stroke();
      lctx.lineWidth = block ? 1 : 2;
      lctx.strokeStyle = color;
      lctx.stroke();

      var end = points[points.length - 1], prev = points[points.length - 2];
      var dx = end.x - prev.x, dy = end.y - prev.y, len = Math.hypot(dx, dy);
      if (len < 0.01) continue;
      var ex = end.x * PPY + ox, ey = end.y * PPY + oy;
      var px = prev.x * PPY + ox, py = prev.y * PPY + oy;
      var ux = dx / len, uy = dy / len;
      var tail = block ? 0 : 6;
      // Point along the route at the screen edge if its destination is off camera.
      if (!block && px > 8 && px < bufW - 8 && py > topInsetLo + 8 && py < bufH - 8) {
        var reach = len * PPY;
        if (ux > 0) reach = Math.min(reach, (bufW - 8 - px) / ux);
        if (ux < 0) reach = Math.min(reach, (8 - px) / ux);
        if (uy > 0) reach = Math.min(reach, (bufH - 8 - py) / uy);
        if (uy < 0) reach = Math.min(reach, (topInsetLo + 8 - py) / uy);
        ex = px + ux * reach;
        ey = py + uy * reach;
      }
      ex = Math.round(ex); ey = Math.round(ey);
      lctx.setLineDash([]);
      lctx.beginPath();
      lctx.moveTo(ex - ux * tail - uy * 3, ey - uy * tail + ux * 3);
      lctx.lineTo(ex, ey);
      lctx.lineTo(ex - ux * tail + uy * 3, ey - uy * tail - ux * 3);
      lctx.stroke();
    }
    lctx.restore();
    return colors;
  }

  function drawRouteTag(id, color, x, y) {
    var width = textWidth(id, 1);
    var left = x - Math.floor(width / 2);
    lctx.fillStyle = '#101622';
    lctx.fillRect(left - 2, y - 1, width + 4, 7);
    drawText(lctx, id, left, y, 1, color);
  }

  function drawAim(a, ox, oy, now) {
    var dx = a.tx - a.qx, dy = a.ty - a.qy;
    var d = Math.sqrt(dx * dx + dy * dy);
    var N = Math.max(6, Math.min(32, (d * 0.9) | 0));
    var shift = (now / 70) | 0;
    var col = a.valid ? '#ffffff' : '#ff5a4a';
    var passHeight = window.GridSim && window.GridSim.passHeight;
    for (var i = 1; i < N; i++) {
      if ((i + shift) % 3 === 0) continue;
      var t = i / N;
      var z = passHeight ? passHeight(d, t) : 0.80 * d * t * (1 - t) + (1 - t);
      var px = Math.round((a.qx + dx * t) * PPY) + ox;
      var py = Math.round((a.qy + dy * t - z) * PPY) + oy;
      lctx.fillStyle = 'rgba(0,0,0,0.45)';           // drop shadow so the dots read on grass
      lctx.fillRect(px - 1, py, 3, 3);
      lctx.fillStyle = col;
      lctx.fillRect(px - 1, py - 1, 3, 3);
    }
    // aim assist locked on a receiver: dotted lead line from his feet to the catch spot
    if (a.lock && a.valid) {
      var lx = a.lx, ly = a.ly, ex = a.tx - lx, ey = a.ty - ly;
      var ln = Math.sqrt(ex * ex + ey * ey), M = Math.min(14, (ln * 1.5) | 0);
      lctx.fillStyle = 'rgba(255,226,58,0.85)';
      for (var j = 1; j < M; j += 2) {
        lctx.fillRect(Math.round((lx + ex * j / M) * PPY) + ox - 1, Math.round((ly + ey * j / M) * PPY) + oy - 1, 2, 2);
      }
      var rx = Math.round(lx * PPY) + ox, ry = Math.round(ly * PPY) + oy;
      lctx.fillRect(rx - 7, ry + 1, 4, 1); lctx.fillRect(rx + 4, ry + 1, 4, 1);
    }
    // landing marker drawn at 2x so it is a decent size on a phone
    var mx = Math.round(a.tx * PPY) + ox, my = Math.round(a.ty * PPY) + oy;
    var pulse = ((now / 200) | 0) % 2;
    lctx.drawImage(a.valid ? IMG_MARK : IMG_MARK_BAD, mx - 7, my - 7, 14, 14);
    if (pulse) {
      lctx.fillStyle = a.valid ? 'rgba(255,226,58,0.6)' : 'rgba(255,90,74,0.6)';
      lctx.fillRect(mx - 10, my - 10, 21, 2);
      lctx.fillRect(mx - 10, my + 9, 21, 2);
      lctx.fillRect(mx - 10, my - 10, 2, 21);
      lctx.fillRect(mx + 9, my - 10, 2, 21);
    }
  }

  function drawKick(s) {
    var w = Math.min(240, Math.round(bufW * 0.55)), h = 10;
    var x = Math.round((bufW - w) / 2), y = Math.round(bufH * 0.64);
    var dist = Math.round((100 - s.ballOn) + 17);
    var th = Math.max(0.08, Math.min(0.6, 0.65 - (dist - 20) * 0.012));
    var label = dist + (s.kickKind === 'pat' ? ' YD EXTRA POINT' : ' YD FIELD GOAL');
    var lw = textWidth(label, 2);
    lctx.fillStyle = 'rgba(0,0,0,0.6)';
    lctx.fillRect(Math.min(x, Math.round((bufW - lw) / 2)) - 6, y - 22, Math.max(w, lw) + 12, h + 34);
    drawText(lctx, label, Math.round((bufW - lw) / 2), y - 16, 2, '#ffffff');
    lctx.fillStyle = '#000000';
    lctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    lctx.fillStyle = '#b8352b';
    lctx.fillRect(x, y, w, h);
    var gw = Math.max(2, Math.round(th * w));
    lctx.fillStyle = '#3fbf5a';
    lctx.fillRect(x + Math.round((w - gw) / 2), y, gw, h);
    lctx.fillStyle = '#ffe23a';
    lctx.fillRect(x + Math.round(w / 2), y, 1, h);
    var m = Math.max(-1, Math.min(1, s.kickMeter));
    var nx = x + Math.round((m + 1) / 2 * w);
    lctx.fillStyle = '#000000';
    lctx.fillRect(nx - 2, y - 5, 5, h + 10);
    lctx.fillStyle = '#ffffff';
    lctx.fillRect(nx - 1, y - 4, 3, h + 8);
  }

  window.Render = {
    ppy: function () { return PPY; },
    FIELD_W: FW,
    TEAMS: TEAMS,
    init: init,
    resize: resize,
    setTopInset: setTopInset,
    draw: draw,
    drawPlayDiagram: drawPlayDiagram,
    drawKickDiagram: drawKickDiagram,
    screenToField: screenToField,
    fieldToScreen: fieldToScreen,
    pxPerYard: pxPerYard,
    burst: burst,
    shake: addShake,
    drawText: drawText,
    textWidth: textWidth
  };
})();
