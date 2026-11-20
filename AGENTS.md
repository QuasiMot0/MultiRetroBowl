# Gridiron Duel repository map

Gridiron Duel is an original 7-on-7 football game with a browser client, local CPU games, and online rooms. The browser loads plain scripts in the order listed in `public/index.html`. There is no build step. Node.js 18+ runs the server and tests. `ws` is the only package dependency.

## Where to start

| Task | Entry points |
| --- | --- |
| Controls and aim | `public/js/input.js` exports `Input`. Start with `onDown`, `finish`, and `update` for gesture lifecycles, `computeAim` for pass targeting, and `updateControls` for context buttons. |
| Playbook, routes, and defense | `shared/sim.js` defines play metadata and `formationPositions`, `assignJobs`, `offBrain`, and `defBrain`. `cpuOffPick`, `cpuDefPick`, and `cpuQBThink` drive the CPU play calls and passing. |
| Motion and football rules | `shared/sim.js` owns `steer`, `stepLive`, `throwBall`, `resolveArrival`, and the `end*` functions. `step` advances playcall, presnap, live, kick, result, and game over. |
| HUD, menus, and game loop | `public/index.html` defines the screens and controls, `public/style.css` styles them, and `public/js/main.js` wires their events. Start with `enterGame`, `updateUI`, or `frame`. |
| Field, camera, and sprites | `public/js/render.js` exports `Render`. Look at `screenToField` for pointer coordinates, `draw` for the scene, and `drawAim` for the pass preview. |
| Online rooms and reconnect | `server/index.js` serves static files and `/health`, handles `/ws`, and owns the room lifecycle inside `start`. `public/js/net.js` exports `Net` for socket I/O and token-based rejoin. `public/js/main.js` handles game-facing `Net.on` events. |
| Online motion and feedback | `public/js/main.js` buffers snapshots in the `state` handler. `interpolate`, `applyPrediction`, and `fireQueuedEvents` consume them in `frame`. `handleEvents` drives sound, haptics, and visual effects. |

## Follow a play through the code

1. `main.js` builds play cards from the lists exported by `GridSim`. `onPick` and the `Input` module send commands through `sendInput`.
2. In CPU mode, `sendInput` calls `GridSim.input` directly and `frame` advances the game in fixed 30 Hz steps. In online mode, `Net` wraps commands in `{ type: 'input', msg }`. The server's `handleInput` forwards them to the authoritative simulation.
3. `GridSim.input` validates commands against the team, possession, and current phase. `GridSim.step` advances the game. Both modes use `GridSim.snapshot` for the UI. Online rooms broadcast snapshots at 20 Hz while active.
4. `Input` converts pointer coordinates through `Render.screenToField`. Simulation coordinates are in yards. The offense always attacks toward increasing `x`, with end zones at `0–10` and `110–120` and sidelines at `y = 0` and `y = 53.3`.

`snapshot()` drains queued game events. Use the same snapshot for every recipient of a server broadcast. The browser's predicted position is visual, while catches, tackles, legal throws, and scoring are decided by the sim. See [PLAN.md](PLAN.md) for the original design and protocol outline, and the implementation for current behavior.

`GridSim.steer` drives simulation movement and online prediction. Thumbstick moves send a `speed` fraction alongside the move target. `GridSim.passFlightTime` and `GridSim.passHeight` keep CPU targeting, the aim preview, and the actual pass in sync. `GridSim.routePreview` reuses the sim's assignments to draw routes for the offensive player.

## Run and verify

Use `npm ci`, `npm start`, and `npm test` from the repository root. The network tests listen on loopback and choose ephemeral ports. To play on a phone, open the LAN URL printed by `npm start` while on the same Wi-Fi.

| Test file | Coverage |
| --- | --- |
| `test/sim.test.js` | Phase and input rules, scoring, standings, and seeded game behavior. |
| `test/gameplay.test.js` | Play balance, run and pass outcomes, and pocket pressure. |
| `test/input.test.js` | Pointer and keyboard input, simultaneous movement and aiming, and gesture cleanup. |
| `test/routes.test.js` | Preview paths and their consistency with the sim's live assignments. |
| `test/fuzz.test.js` | Random and malformed sim inputs, finite snapshots, and bounded phases. |
| `test/server.test.js` | HTTP serving and WebSocket room behavior. `test/fixtures/` provides isolated static assets and a fake sim. |
| `test/online.test.js` | Full games over real WebSockets against the real sim. |
| `test/regressions.test.js` | Targeted sim, server, and browser socket-client regressions. |
