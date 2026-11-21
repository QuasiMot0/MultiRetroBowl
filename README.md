# Gridiron Duel

A retro pixel-art, 7-on-7 American football game for phones. Play a friend head-to-head
(each on your own phone, using a 4-letter room code) or play against the CPU.

## Run it

Requires Node.js 18+.

```bash
npm install
npm start          # serves on port 3000 (override with PORT=4000 npm start)
npm test           # runs the test suite
```

Use `npm start -- 3001` to start a separate server while another room is in play.

On startup the server prints the URLs to open, for example:

```
  Open on this computer:  http://localhost:3000
  Open on phones (same Wi-Fi):
    http://192.168.1.23:3000
```

## Play with a friend on the same Wi-Fi

1. Run `npm start` on your computer.
2. Both phones join the **same Wi-Fi network** as the computer.
3. On each phone, open the `http://<LAN IP>:3000` address the server printed (it's your
   computer's local IP, which you can also find in your Wi-Fi settings, or with
   `ipconfig getifaddr en0` on macOS or `ipconfig` on Windows).
4. Turn the phones sideways. One player taps **Create Room** and reads out the code; the
   other taps **Join Room** and enters it. The game starts as soon as both are in.

If the phones can't connect, check that your computer's firewall allows incoming
connections for Node, and that the Wi-Fi isn't a guest network with "client isolation".

Tip: on iOS use Share → "Add to Home Screen" (Android: menu → "Add to Home screen") for full-screen play.

## Controls

Choose a play category to see its diagrams. Tap a card to call the play, or hold it for a labeled preview. On a keyboard, focus the card and press **P** to preview it.

- **Touch** — Start the thumbstick anywhere in the left quarter of the screen on offense or defense. Push it farther to move faster. Drag back and release to its right with a second finger to pass, or tap a defender to switch on defense.
- **Keyboard and mouse** — Use **WASD** to move. Hold the left mouse button, drag back, and release to pass. Use **Space** to juke, switch defenders, or kick, depending on the play. **Shift** also switches defenders.

On offense, each route arrow matches the color of the player's tag. WR1 is pink, WR2 is cyan, TE is lavender, and RB is gold. Dashes show where a player runs before blocking.

On a run call, follow the gold handoff lane. On passing plays, a defender near the landing spot can break up the catch or intercept it, with more risk on deep throws into coverage.

Every touchdown scores six points and leads to a timed extra-point kick for one more. Tap **Kick** or press **Space** when the needle is in the green.

## Play over the internet

The server is a single Node process that serves both the web page and the WebSocket
(`/ws`) on one port, so any tunnel or host that supports WebSockets works.

**Free tunnel (quickest):** keep `npm start` running and in a second terminal run one of:

```bash
cloudflared tunnel --url http://localhost:3000     # prints https://<random>.trycloudflare.com
npx localtunnel --port 3000                         # prints https://<random>.loca.lt
```

Send the printed `https://...` link to your friend; you both open it and use a room code as
usual. (localtunnel shows a one-time reminder page the first time you open the link; follow its
instructions to continue.)

**Deploy to a Node host (e.g. Render):** create a new *Web Service* from this repo with build command
`npm install` and start command `npm start`. The server reads `PORT` from the environment and binds
`0.0.0.0`. A health check is available at `/health`. Free instances sleep when idle, so the first
load can take a little while.

## Project layout

```
server/index.js    HTTP static server + WebSocket rooms (authoritative sim at 30Hz, state at 20Hz)
shared/sim.js      deterministic game simulation (used by the server and by CPU mode in the browser)
public/            client: index.html, style.css, js/*
test/              node:test suites (npm test)
```

Online rooms pause when a player disconnects and are kept for 5 minutes so they can reconnect
(rejoin happens automatically). See [AGENTS.md](AGENTS.md) for code entry points and test coverage,
and [PLAN.md](PLAN.md) for the original design and protocol outline.

See the [balance reference](BALANCE.md) for the current playbooks, run matchups, and how to retest them after changing the sim.
The [decision review](BALANCE.md#decision-review) records differences between design intent, CPU play selection, and measured outcomes.
