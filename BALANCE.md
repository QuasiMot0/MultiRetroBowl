# Gridiron Duel balance reference

The shared sim runs the same 7-on-7 rules in CPU games and online rooms. The playbooks below show what each call is trying to do. The run benchmarks give you a starting point for changing blocking, pursuit, or play selection. [Shared sim](shared/sim.js)

## Offensive playbook

| Call | Concept and first read |
| --- | --- |
| Slant (`slant`) | Both WRs cut inside after five yards. Check the TE breaking outside or the RB releasing left when defenders take away the slants. |
| Stick (`stick`) | The TE settles underneath. Read the TE and the RB in the left flat. |
| Mesh (`mesh`) | Two shallow crossers run under a deeper in-route. Look for separation as they cross. |
| Deep Shot (`deep`) | Both WRs go deep and fade outside. The RB protects and the TE gives the QB a short outlet. |
| Post Corner (`post`) | WR1 breaks inside and WR2 breaks outside. Read the safeties before choosing a side. |
| Flood (`flood`) | WR2 clears out downfield while the TE and RB attack the right side at different depths. |
| Screen (`screen`) | The RB and TE release into opposite flats behind the line. Both WRs run briefly, then block. |
| Tunnel Screen (`tunnel`) | WR1 turns back inside. The RB stays in protection. |
| Swing Screen (`swing`) | The RB swings to the right behind the TE and WR blocks. |
| Off Tackle (`run`) | Follow the left-side lane. This is the strongest measured run against Fire Zone. |
| Dive (`dive`) | Hit the middle. Compare it against a wide front such as Quarters and an inside rush such as Fire Zone. |
| Sweep (`sweep`) | Follow WR2's block on CB2 toward the right edge. This is the strongest measured run against Quarters. |
| Punt (`punt`) | Fourth down only. Net 40 yards or a touchback if the punt would pin the opponent inside its 20. |
| Field Goal (`fg`) | Fourth down only. A successful kick scores three points. The meter window narrows with distance. |

Hold a play card or press **P** while it is focused to preview the routes, blocks, or coverage. A quick tap calls the play. The left quarter of the screen is the movement area on both sides of the ball. On defense, Switch favors defenders who can reach the projected runner position or the landing spot of a pass. [Controls](public/js/input.js) · [Play picker](public/js/main.js)

## Defensive playbook

Both defensive linemen rush by default. The remaining assignments distinguish the calls. [Defensive assignments](shared/sim.js)

| Call | Coverage and pressure |
| --- | --- |
| Man (`man`) | Corners take the WRs, the LB takes the TE, and both safeties play deep zones. |
| Man Robber (`robber`) | Four defenders match receivers, including the RB. A safety reads short throws over the middle. |
| Cover 0 (`zero`) | The LB joins the rush. Four defenders play man coverage with no deep safety. |
| Zone (`zone`) | The corners and LB cover underneath, with two deep safeties. |
| Cover 3 (`cover3`) | Both corners and one safety play deep. The LB and other safety cover underneath. |
| Quarters (`quarters`) | Both corners and both safeties play deep, with the LB underneath and a wider defensive front. |
| Blitz (`blitz`) | The LB and S1 join the rush. The corners take the WRs and S2 takes the TE. |
| Edge Blitz (`edge`) | S2 rushes from the right. The LB protects the middle, S1 plays deep, and the corners take the WRs. |
| Fire Zone (`fire`) | The LB rushes inside, the corners cover short zones, and the safeties play deep. |

## Passing reads

- **Against Blitz or Cover 0**, look for the early break on Slant or the underneath route on Stick. The extra rushers shorten the time available for deeper routes.
- **Against Quarters**, check the short middle or the flats with Stick or Screen. Four defenders start with deep assignments.
- **Against Zone or Cover 3**, read the right-side windows on Flood at three depths. Against Man Robber, check the flat before throwing a crosser near the safety in the middle.

## Measured run matchups

Baseline recorded November 20, 2026. Values are mean yards per carry across seeds 1–128. Each sample starts on first-and-10 at the offense's 25 with a fresh defense. The runner follows the called lane and the defenders use their assignments. Live steering and jukes can change the matchup.

| Defense | Off Tackle | Dive | Sweep |
| --- | ---: | ---: | ---: |
| Man | **5.1** | 0.6 | 2.1 |
| Man Robber | 2.5 | 0.0 | 2.0 |
| Cover 0 | 0.0 | −1.0 | 2.1 |
| Zone | 3.8 | 0.9 | **4.2** |
| Cover 3 | 2.0 | 2.0 | 1.2 |
| Quarters | 2.0 | **2.3** | **8.9** |
| Blitz | 4.2 | 0.5 | 2.1 |
| Edge Blitz | 3.8 | 0.9 | 2.1 |
| Fire Zone | **7.0** | −1.0 | 2.8 |

**Repeated calls.** Beginning with the third straight scrimmage snap using the same defensive call, run blocks slow engaged defenders more and take longer to shed. The effect reaches its cap on the fourth straight call. Each team has its own streak, and a different call on a scrimmage snap resets it. Punts and kicks leave the streak alone. The offense can see the previous streak in the play picker.

In 48 paired replays, a third straight Blitz gave up **15 Off Tackle runs of 10+ yards**. A Blitz after the defense mixed in Man gave up **zero**. Both sequences still produced 28 stops under four yards. Compare short stops and breakaways alongside yards per carry. [Run matchup and streak tests](test/gameplay.test.js)

## Where to tune

| Area | Code to start with | What to compare |
| --- | --- | --- |
| Run lanes and blocking | `RUNS`, `runApproach`, `runLaneTarget`, `receiverAssignment`, `assignJobs`, `blockPos`, and the engagement loop in `stepLive` | The RB gets the handoff around 0.4 seconds. Compare yards per carry, stops at or behind the line, and gains of 10+ with and without manual steering. |
| Repeated defensive calls | `startLive`, `assignJobs`, `leadBlockTarget`, `RUN_COUNTERS`, and `cpuOffPick` | Each of the two levels lowers the defender's speed multiplier while engaged by an OL by 0.10 and adds 0.25 seconds to the initial shed timer. CPU offense can also weight a counter run after seeing a call twice. |
| Defensive fronts and pursuit | `DEFENSE_SCHEMES`, `DEFENSE_ALIGNMENTS`, `defBrain`, and `pursue` | Compare who first reaches the lane and where the tackle occurs. The sim tackles within 0.9 yards unless a juke is active. Check a manually steered LB or safety as well as assignment-only defense. |
| Passing and coverage | `receiverAssignment`, `PASS_ROUTES`, `defBrain`, `passFlightTime`, and `resolveArrival` | Passes travel at 23 yards per second up to 55 yards. Compare open completions, contested completions, interceptions, and time to sack. Longer throws into coverage are riskier. |
| Movement and jukes | `SPEED`, `HUMAN_ACCEL_TIME`, `DEFENDER_ACCEL_TIME`, `doJuke`, and `Input.update` | Manual defenders have a 0.19-second acceleration time versus 0.29 seconds on offense. A juke gives 0.4 seconds of tackle immunity, then a short slowdown for human carriers. Verify partial stick speed and switching during pursuit. |
| CPU calls and game pace | `cpuOffPick`, `cpuDefPick`, `cpuQBThink`, `MAX_LIVE`, and `RUNOFF` | Compare play mix by down and distance, sack timing, drives, and scoring. The default quarter is 2:30, live plays cap at 12 seconds, and in-bounds results typically use a 20-second runoff. Touchdowns score six and lead to a timed extra point. |

Simulation settings and assignments live in the shared sim. The browser uses the same movement and passing functions for prediction and previews. [Shared sim](shared/sim.js) · [Browser input](public/js/input.js) · [Prediction and HUD](public/js/main.js)

## Recheck after a balance change

Run `node --test test/gameplay.test.js test/routes.test.js test/input.test.js` for a quick check, then `npm test` for the full suite. The gameplay tests cover favorable and unfavorable run matchups, repeat-call breakaways, human tackling, passing into tight coverage, and how long a QB has to throw against a blitz. Route tests check that diagrams match live assignments.

The scripted open-receiver check expects at least 75% completions and at most 10% interceptions. In the pocket test, a stationary QB gets at least 1.5 seconds to throw against Blitz, and Blitz still reaches the QB sooner than Man. [Gameplay tests](test/gameplay.test.js)

Run this from the repo root to regenerate the fresh-defense matrix. Keep the seeds, starting spot, and input conditions fixed when comparing before and after.

```sh
node <<'NODE'
const Sim = require('./shared/sim')
const runs = { 'Off Tackle': 'run', Dive: 'dive', Sweep: 'sweep' }

function sample(play, defense) {
  const gains = []
  for (let seed = 1; seed <= 128; seed++) {
    const game = Sim.createGame({ seed, humans: [true, true] })
    const start = game.ballOn
    Sim.input(game, 0, { t: 'pick', play })
    Sim.input(game, 1, { t: 'pick', play: defense })
    for (let tick = 0; game.phase !== 'result' && tick < 1200; tick++) {
      Sim.step(game, 1 / 30)
    }
    if (game.phase !== 'result') throw new Error(`${play} vs ${defense} did not finish`)
    const spot = game.events.includes('td') ? 100
      : game.events.includes('safety') ? 0
      : game.pending.possession === 0 ? game.pending.ballOn : 100 - game.pending.ballOn
    gains.push(spot - start)
  }
  const mean = gains.reduce((sum, gain) => sum + gain, 0) / gains.length
  return mean.toFixed(1)
}

console.table(Sim.DEFENSE_PLAYS.map(({ id, name }) => ({
  Defense: name,
  ...Object.fromEntries(Object.entries(runs).map(([label, play]) => [label, sample(play, id)]))
})))
NODE
```
