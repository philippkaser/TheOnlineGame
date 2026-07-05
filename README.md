# The Love Duel 💘🔫

A real-time two-phone shooter for couples. You each control a fighter in a
top-down arena on your own phone, move for cover, and blast at each other.
Best of 3 rounds. And the loser? The loser has to **propose to the winner**,
right there on screen. 🥹💍

However the duel ends, someone gets down on one knee.

## How it plays

1. One phone taps **Create a duel** and gets a 4-letter room code.
2. The other phone enters the code and taps **Join**.
3. The host starts the match. Both phones show the same live arena.
4. **Left thumb moves, right thumb aims and fires** (twin-stick controls).
   Duck behind the blocks for cover — health bars sit above each fighter.
5. Whoever wins **2 rounds** wins the duel.
6. The loser's phone shows a **"Get down on one knee 💍"** button and a
   suggested line. Tap it, and the winner's phone lights up with
   **"Will you marry me?"** and a big **YES** button.
7. Say yes → confetti and hearts on both phones. 🎉

On a desktop browser you can test with **WASD / arrow keys** to move and the
**mouse** to aim (click or space to fire).

## Run it locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` on your computer to test, or on two phones
on the same Wi-Fi as the machine (use its local IP, e.g. `http://192.168.1.42:3000`).

## Play on two real phones (anywhere)

Deploy the folder to any Node host — [Render](https://render.com),
[Railway](https://railway.app), and [Fly.io](https://fly.io) all have free
tiers and work out of the box:

- Build command: `npm install`
- Start command: `npm start`
- The server listens on `process.env.PORT`, which these platforms set for you.

Open the deployed URL on both phones and go. HTTPS/`wss://` is handled
automatically by the client.

## Tune it ✏️

Gameplay knobs live at the top of [`server.js`](./server.js) — tweak them to
taste:

| Constant | What it does |
|---|---|
| `PLAYER_SPEED` | how fast fighters move |
| `BULLET_SPEED`, `BULLET_DMG` | bullet velocity and damage |
| `FIRE_COOLDOWN` | milliseconds between shots |
| `MAX_HP` | health per round |
| `ROUNDS_TO_WIN` | rounds needed to win (2 = best of 3) |
| `OBSTACLES` | the cover layout (kept point-symmetric so it's fair) |

You can also reword the proposal lines in `public/app.js` (the `SCRIPTS` array).

## How it works

- **`server.js`** — a tiny Node HTTP server (no framework) that serves the
  static files and runs an **authoritative 30 Hz game loop** over a WebSocket
  (`ws`). It owns movement, shooting, collisions, damage, rounds and the
  proposal handshake, so both phones always agree on the state.
- **`public/`** — the mobile-first client (`index.html`, `style.css`,
  `app.js`). It renders the arena on a `<canvas>`, smooths player motion
  between server updates, draws the twin-stick controls, and auto-reconnects if
  a phone briefly drops.

No database, no build step. State lives in memory — perfect for a game you play
once and remember forever.

Good luck out there. 💕
