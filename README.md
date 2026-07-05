# The Love Duel 💍

A two-phone web game for couples. You each answer a rapid-fire quiz about your
relationship on your own phone — points for correct answers and speed. Whoever
scores higher wins. And the loser? The loser has to **propose to the winner**,
right there on screen. 🥹

It's rigged for romance: however the game ends, someone gets down on one knee.

## How it plays

1. One phone taps **Create a game** and gets a 4-letter room code.
2. The other phone enters the code and taps **Join**.
3. The host starts the duel. Both phones show the same question at the same time.
4. Tap your answer — faster correct answers score more.
5. After the last question (ties go to sudden death ⚡), the winner and loser
   are revealed.
6. The loser's phone shows a **"Get down on one knee 💍"** button and a
   suggested proposal line. Tap it, and the winner's phone lights up with
   **"Will you marry me?"** and a big **YES** button.
7. Say yes → confetti and hearts on both phones. 🎉

## Run it locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` on your computer to test, or on two phones
connected to the same Wi-Fi as the machine (use the machine's local IP, e.g.
`http://192.168.1.42:3000`).

## Play on two real phones (anywhere)

Deploy the folder to any Node host — [Render](https://render.com),
[Railway](https://railway.app), and [Fly.io](https://fly.io) all have free
tiers and work out of the box:

- Build command: `npm install`
- Start command: `npm start`
- The server listens on `process.env.PORT`, which these platforms set for you.

Open the deployed URL on both phones and go. HTTPS/`wss://` is handled
automatically by the client.

## Make it yours ✏️

Open [`questions.js`](./questions.js) and replace the placeholder questions with
your own inside jokes, first-date details, and favourite things. Each question
is:

```js
{
  text: 'Where did we go on our very first date?',
  choices: ['The Italian place', 'The cinema', 'A coffee shop', 'A walk'],
  correct: 0, // index of the right answer (0-based)
}
```

Add as many as you like — the game shuffles them and uses them all.

You can also tweak the proposal lines in `public/app.js` (the `SCRIPTS` array).

## How it works

- **`server.js`** — a tiny Node HTTP server (no framework) that serves the
  static files and runs a WebSocket (`ws`) game loop. It manages rooms,
  question timing, scoring, tie-breaks, and the proposal handshake.
- **`public/`** — the mobile-first single-page client (`index.html`,
  `style.css`, `app.js`). It auto-reconnects if a phone briefly drops.
- **`questions.js`** — your quiz content.

No database, no build step. State lives in memory, which is perfect for a game
you play once and remember forever.

Good luck. 💕
