# Gridiron Duel — Build Plan & Interface Contract

An original retro pixel-art American football game for phones. Two friends play
head-to-head online (room code), each on their own phone. Also a "vs CPU" mode.
All art is drawn procedurally on a canvas (rectangles = pixel sprites). No external assets.
Do NOT use the name, art, or branding of any existing game.

## Stack
- Node.js (v25) server: `server/index.js`, uses `ws` (only dependency). `npm start` → port `process.env.PORT || 3000`, binds `0.0.0.0`.
- Shared deterministic game simulation: `shared/sim.js` (runs on server for online, in browser for CPU mode).
- Client: plain HTML/CSS/JS, no build step: `public/index.html`, `public/style.css`, `public/js/*.js`.
- Tests: `node --test test/` (built-in runner). `npm test`.

```
package.json
server/index.js
shared/sim.js
public/index.html
public/style.css
public/js/net.js       # websocket client + reconnect
public/js/render.js    # canvas renderer
public/js/input.js     # touch controls -> sim messages
public/js/main.js      # menus, mode switching, game loop, interpolation, sound
test/sim.test.js
test/server.test.js
```

## Game design (7-on-7, side view, short game)
- Field coords are in **yards**, in the **play frame**: offense always attacks toward +x.
  x ∈ [0,120]: offense's own endzone 0–10, field 10–110, target endzone 110–120. y ∈ [0, 53.3] (sideline to sideline).
- `ballOn` = yards from offense's own goal line (0–100). Line of scrimmage x = `10 + ballOn`.
  On change of possession: `ballOn = 100 - ballOn` (spot), renderer always shows offense moving left→right.
- Teams: index 0 (host / "HOME", red) and 1 (joiner / "AWAY", blue). `possession` = team index on offense.
- Offense (7): `QB, RB, WR1, WR2, TE, OL1, OL2`. Defense (7): `DL1, DL2, LB, CB1, CB2, S1, S2`.
- Game: 4 quarters, `quarterLength` default 150 game-seconds. Team 0 receives first; team 1 receives 2nd half. Each possession starts at own 25 (kickoffs are auto touchbacks).
- Clock: during `live`, clock runs 1:1 with sim time. After a play ending in-bounds with ball not incomplete/score, extra 20s runoff (not below 0). Quarter ends when clock hits 0 at end of a play. After Q4 → `gameover`. Ties allowed.
- Downs: 4 downs to gain 10. First down resets. Turnover on downs → possession change at spot.
- Scoring: TD = 6 + automatic extra point (1, always good) = 7 total. FG = 3. Safety = 2 (then scored-on team... simplify: scoring team gets ball at own 25).
- After any score → other team gets ball at own 25.

### Phases (`game.phase`)
1. `playcall` (max 15s, `phaseTime` counts down). Offense picks a play, defense picks a coverage. Missing picks auto-filled at timeout (offense: `slant`, defense: `zone`). CPU sides pick instantly (randomized sensible choice; CPU offense picks `punt` on 4th & >3 outside opp 35, `fg` on 4th inside opp 35, otherwise random play).
   - Offense plays: `slant`, `deep`, `screen`, `run`. On 4th down additionally: `punt`, `fg`.
   - Defense plays: `man`, `zone`, `blitz`.
2. `presnap` (1.0s): players set in formation. → `live` (or `kick` if offense chose fg, or immediate punt resolution → `result`).
3. `live`: action (see below). Ends → `result`.
4. `kick` (FG): `kickMeter` oscillates in [-1,1] (`sin(t*4)`). Offense sends `{t:'kick'}` to lock; CPU/timeout(4s) locks at a random value. Good if `|meter| < threshold`, threshold = clamp(0.65 - (dist-20)*0.012, 0.08, 0.6), dist = (100-ballOn)+17. → `result`.
5. `result` (2.5s): shows `message` (e.g. "TOUCHDOWN!", "SACKED -6", "INCOMPLETE", "1ST DOWN", "INTERCEPTED!", "FIELD GOAL GOOD"), then applies downs/possession → `playcall`, or `gameover`.
6. `gameover`: final. Rematch resets the game (online: both send rematch).
- `paused` boolean (online only, when a player disconnected): `step` does nothing while true.

### Live play rules
- Fixed timestep: call `step(game, 1/30)`.
- Speeds (yd/s): WR/RB/CB/S 7.0, TE/LB 6.3, QB 5.6, OL/DL 5.0. Ball carrier +0% ; juke: +35% speed for 0.4s and cannot be tackled during it, 2.0s cooldown.
- Snap: QB holds ball. `run` play: auto handoff to RB at t=0.4s (RB becomes carrier, offense controls RB).
- Receivers run routes by play (slant: 5yd then 45° in; deep: straight 25yd then fade; screen: RB/TE swing to flat behind LOS, WRs block-ish; run: WRs block downfield). TE: short out. OL block nearest DL (stand between DL and QB/carrier, DL slowed to 40% while engaged within 1.2yd).
- Defense AI: `man` → CB1/CB2 cover WR1/WR2, LB covers TE, S over top; `zone` → drop to zones, react to ball in air; `blitz` → LB + one S rush QB, others man. DL always rush. Once ball caught/handed off, everyone pursues carrier with lead (aim at carrier pos + vel*0.5).
- **User-controlled players**:
  - Offense: QB before throw (move target), then the ball carrier (receiver after catch, RB on run). Move target given by `{t:'move',x,y}`; player runs toward it at its speed, stops within 0.3yd. `{t:'stop'}` clears target (player then holds still if QB, or AI-runs straight upfield if carrier).
  - Defense: one "user defender" (`userDefenderId`, default `S1`). `{t:'select', id}` switches to another defender. `{t:'move'}`/`{t:'stop'}` drive it. When the defense side is CPU, the user defender is AI.
  - If an offense side is CPU: QB throws to most open receiver (largest distance to nearest defender) between 1.2–2.6s, scrambles away from pressure; carrier AI runs upfield avoiding nearest defender.
- Throw `{t:'throw',x,y}`: only while QB holds ball and QB x ≤ LOS x + 1. Ball flies from QB to (x,y) at 24 yd/s, with arc height `z` (peak = dist*0.15). Target clamped to field, max distance 55.
- Ball arrival: candidates within 1.6yd of target. Nearest offensive receiver (not OL/QB) vs nearest defender. If a defender is closer than the receiver by >0.4yd and within 1.2yd → 55% INT chance else incomplete. Else if receiver within 1.6 → catch probability = 0.92 - 0.3*(defender within 1.0yd ? 1 : 0) . Else incomplete. Use a seeded PRNG in the game state (`game.seed`) so tests can be deterministic.
- Tackle: any defender within 0.9yd of carrier (not juking) → down at carrier x. QB tackled while holding ball behind LOS → "SACK".
- Carrier y < 0 or y > 53.3 → out of bounds, down at x. Carrier x ≥ 110 → TOUCHDOWN. Carrier tackled with x < 10 → SAFETY. INT: possession changes, new ballOn = spot of interception in new frame (100 - (x-10)), clamped 1..99; if INT in endzone → touchback at 20.
- Punt (no live play): net 40 yards; receiving team ballOn = 100 - (ballOn + 40); if that would be < 20 → 20 (touchback).
- Max live time 12s safety cutoff → treat as tackled where carrier is (or incomplete if ball in air).

## Sim API (`shared/sim.js`) — UMD: `module.exports` in Node, `window.GridSim` in browser. No dependencies.
```js
GridSim.createGame({ teamNames:['HOME','AWAY'], humans:[true,true], quarterLength:150, seed:12345 }) -> game
GridSim.step(game, dt)                  // advance; dt typically 1/30
GridSim.input(game, team, msg)          // team: 0|1, msg below; ignores invalid msgs silently
GridSim.snapshot(game) -> plain JSON-safe object (see below)
GridSim.reset(game)                     // rematch: fresh game, same options (new seed ok)
GridSim.OFFENSE_PLAYS, GridSim.DEFENSE_PLAYS  // arrays of {id, name, desc}
```
Input messages (`msg.t`): `pick {play}`, `move {x,y}`, `stop`, `throw {x,y}`, `juke`, `select {id}`, `kick`.
The sim decides validity from `team` vs `possession` and phase.

### Snapshot shape (sent to both clients, ~20Hz)
```js
{
  phase: 'playcall'|'presnap'|'live'|'kick'|'result'|'gameover',
  phaseTime: Number,          // seconds remaining in phase (playcall/result/kick) or elapsed (live)
  paused: Boolean,
  quarter: 1..4, clock: Number /*seconds left in quarter*/,
  score: [Number, Number], teamNames: [String, String],
  possession: 0|1, down: 1..4, toGo: Number, ballOn: Number,
  picked: [Boolean, Boolean],          // ready flags per TEAM index during playcall
  offPlay: String|null, defPlay: String|null,  // null until presnap (hidden during playcall)
  players: [{ id:'QB'|..., side:'off'|'def', x, y, vx, vy, carrier:Boolean, juking:Boolean }],
  ball: { x, y, z, state:'held'|'air'|'dead', holder: id|null, tx, ty /*target when air*/ },
  userDefenderId: String, controlledOffId: String|null,
  kickMeter: Number|null,
  message: String, sub: String,         // big banner + small line during result
  events: [String],                     // since last snapshot: 'snap','throw','catch','incomplete','int','tackle','sack','td','fg_good','fg_miss','first_down','juke','whistle','turnover','gameover'
  fourthDown: Boolean                   // offense may pick punt/fg
}
```
`snapshot()` drains `game.events` (each event delivered once). Server sends the same snapshot object to both clients.

## Server (`server/index.js`)
- HTTP static: `/` → `public/index.html`; `/js/*`, `/style.css` from `public/`; `/shared/sim.js`. Correct content types, no directory traversal.
- WebSocket on same port (path `/ws`). Rooms keyed by 4-letter code (A–Z, no ambiguous letters).
- Client → server: `{type:'create', name}`, `{type:'join', code, name}`, `{type:'rejoin', code, token}`, `{type:'input', msg}`, `{type:'rematch'}`, `{type:'ping', t}`.
- Server → client: `{type:'created', code, team:0, token}`, `{type:'joined', code, team:1, token}`, `{type:'start', team, names}`, `{type:'state', s}`, `{type:'error', message}`, `{type:'opponent_left'}`, `{type:'opponent_back'}`, `{type:'pong', t}`.
- Game starts when second player joins. Sim stepped at 30Hz with fixed dt; snapshot broadcast at 20Hz (every ~50ms).
- Disconnect: game `paused=true`, other player gets `opponent_left`; room kept 5 minutes for `rejoin` (token-validated) → `opponent_back`, unpause. Empty/expired rooms deleted.
- Rematch: when both sent rematch during `gameover` → `GridSim.reset`.
- Export for tests: `module.exports = { start(port) -> Promise<{server, close()}> }`; run directly when `require.main === module`.

## Client
- Landscape canvas game, full-screen, `touch-action:none`, viewport no-zoom, "rotate your phone" overlay in portrait. Add to home screen meta (apple-mobile-web-app-capable).
- Menu: name input, "Play Online: Create Room" (shows big code), "Join Room" (enter code), "Play vs CPU". Show local URL hint.
- Online: client is `team` (0/1). Renders snapshots with ~100ms interpolation buffer. Sends inputs via `{type:'input', msg}`.
- CPU mode: loads `/shared/sim.js`, `createGame({humans:[true,false]})`, steps locally at 30Hz, calls `snapshot()` each frame; same renderer/input paths.
- Renderer: offense always goes left→right. Camera ~32 yards visible vertically, follows ball (x,y), clamped. Green striped field, yard lines every 5 with numbers every 10, hash marks, endzones colored with team colors, LOS (blue) and first-down line (yellow) during playcall/presnap/live. Pixel sprites ~1.7yd tall (helmet, jersey team color, legs animate when moving). Ball shadow + arc via z. Highlight ring on the player you control. Aim arc + landing marker while aiming.
- HUD (top bar): score both teams, Q & clock, "2nd & 6 · OWN 34" style, possession indicator.
- Playcall overlay: if you're offense show offense play cards (+punt/fg on 4th down); defense shows coverage cards. After pick show "Waiting for opponent…". CPU mode identical.
- Touch controls during `live` (convert screen → field coords via camera):
  - Offense, QB holding ball: touch starting within 3yd of QB → drag moves QB (move target = finger). Touch elsewhere → slingshot: aim target = QB + (touchStart − touchNow) × 2.2 (in field yards); show arc & marker; release throws if pull length > 1.5yd, otherwise cancels.
  - Offense, you control a carrier: carrier follows finger (move target); lift finger → `stop`. JUKE button bottom-right.
  - Defense: your defender follows finger. Tap directly on another defender (within 1.5yd) → `select`. SWITCH button (bottom-right) selects defender closest to the ball.
  - `kick` phase: big horizontal meter + KICK button (offense only).
- Feedback: result banner, `navigator.vibrate` on tackle/td/int, tiny WebAudio beeps (whistle, catch, TD jingle). Sound toggle.
- Game over screen with final score + Rematch button.

## Cycles
1. Build (parallel subagents): A = `shared/sim.js` + `test/sim.test.js`; B = server + `package.json` + `test/server.test.js`; C = client `public/*`.
2. Integrate & test: run tests, headless 2-client online game via ws, static review of client against this contract; fix.
3. Review & polish: bug-hunt review agent → fix agent; mobile UX/game-feel pass.
