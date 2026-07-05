# Das Liebes-Duell 💘

A real-time two-phone game for couples — in German. You each control a fighter
in a top-down arena on your own phone, dodge for cover, and **shoot hearts** at
each other. Best of 3 rounds. And the loser? The loser has to **propose to the
winner**, right there on screen. 🥹💍

However the duel ends, someone gets down on one knee.

> The whole interface is in German (*Duell erstellen*, *Raumcode*, *Willst du
> mich heiraten?* …). Gameplay logic is language-independent.

## How it plays

1. One phone taps **Duell erstellen** and gets a 4-letter **Raumcode**.
2. The other phone types the code into **RAUMCODE** and taps **Duell beitreten**.
3. The host taps **Duell starten**. Both phones show the same live arena.
4. **Left thumb moves, right thumb aims and fires hearts** (twin-stick controls).
   **Double-tap the left side to dash** for a quick dodge. Duck behind the
   blocks for cover — health bars sit above each fighter, and **aim assist**
   nudges your hearts toward your partner so it's easy to land hits.
5. Grab **power-ups** that keep spawning in the arena (just run over them):

   | | Power-up | Effect |
   |---|---|---|
   | ⚡ | Schnellfeuer | fire much faster for a few seconds |
   | 🔱 | Dreifach | three-way spread shot |
   | 🛡️ | Schild | blocks all incoming hearts briefly |
   | 👟 | Speed | move noticeably faster |
   | 💥 | Große Herzen | bigger, harder-hitting hearts |
   | 💚 | Heilung | instant health boost |
   | 💘 | Amors Pfeil | your hearts home in on your partner |
   | 💋 | Kuss | your hits leave your partner lovestruck (slowed) |

6. **Blow your partner a kiss** anytime with the emote bar at the top
   (💋 ❤️ 😘 🌹) — it flies across both phones. Sweet love notes appear
   between rounds, too.
7. Whoever wins **2 rounds** wins the duel.
8. The loser's phone shows **„Geh auf ein Knie 💍“** and a suggested line. Tap
   it, and the winner's phone lights up with **„Willst du mich heiraten?“** and
   a big **JA**-button.
9. Say yes → confetti and hearts on both phones. 🎉

On a desktop browser you can test with **WASD / arrow keys** to move, the
**mouse** to aim (click or space to fire), and **Shift** to dash.

## Run it locally

```bash
npm install
npm start
```

Open `http://localhost:3000` on your computer, or on two phones on the same
Wi-Fi as the machine (use its local IP, e.g. `http://192.168.1.42:3000`).

## Deploy on a Hetzner server

You already join via a lobby code, so once the server is reachable at a URL you
just open that URL on both phones and share the code. Here's the whole path on
a fresh **Hetzner Cloud** VM.

### 1. Create the server
- Hetzner Cloud → new project → **Add Server**.
- A **CX22** (2 vCPU / 4 GB, shared) running **Ubuntu 24.04** is plenty.
- Add your SSH key, create, and note the public IPv4.

### 2. Point a domain at it (needed for HTTPS)
Phones on mobile data need a secure `wss://` socket, which requires HTTPS.
Create a DNS **A record** for e.g. `duell.example.com` → your server IP.
(If you'll only ever play on your own Wi-Fi, you can skip the domain and use
`http://<server-ip>:3000` directly — no TLS needed on a LAN.)

### 3. Install Node and the app
```bash
ssh root@<server-ip>

# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git

# App + dedicated user
useradd --system --create-home --home-dir /opt/theonlinegame theonlinegame
git clone https://github.com/philippkaser/TheOnlineGame.git /opt/theonlinegame
cd /opt/theonlinegame
npm install --omit=dev
chown -R theonlinegame:theonlinegame /opt/theonlinegame
```

### 4. Run it as a service
A ready-made unit lives in [`deploy/theonlinegame.service`](./deploy/theonlinegame.service):
```bash
cp /opt/theonlinegame/deploy/theonlinegame.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now theonlinegame
systemctl status theonlinegame        # should be "active (running)"
```
The service listens on `PORT=3000` (edit the unit to change it).

### 5. HTTPS via Caddy (automatic Let's Encrypt)
```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# Use the sample config (edit the domain first)
cp /opt/theonlinegame/deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile        # replace duell.example.com with your domain
systemctl restart caddy
```
Caddy forwards WebSocket upgrades automatically, so the live game socket just
works. Open `https://duell.example.com` on both phones and duel away.

### 6. Firewall
In the Hetzner Cloud firewall (or `ufw`), allow inbound **80** and **443**
(and **22** for SSH). Port 3000 stays internal — only Caddy talks to it.

### Updating later
```bash
cd /opt/theonlinegame && git pull && npm install --omit=dev
systemctl restart theonlinegame
```

## Tune it ✏️

Gameplay knobs live at the top of [`server.js`](./server.js):

| Constant | What it does |
|---|---|
| `PLAYER_ACCEL`, `PLAYER_FRICTION`, `MAX_SPEED` | movement feel (momentum) |
| `DASH_SPEED`, `DASH_TIME`, `DASH_COOLDOWN` | the dash dodge |
| `HEART_SPEED`, `HEART_DMG` | heart velocity and damage |
| `FIRE_BASE` / `FIRE_RAPID` / `FIRE_BIG` | fire cooldowns per mode |
| `AIM_ASSIST_ANGLE`, `AIM_ASSIST_STRENGTH` | how much shots snap toward the enemy |
| `POWERUP_INTERVAL`, `POWERUP_MAX`, `POWERUP_WEIGHTS` | powerup spawning & odds |
| `FX_DURATION`, `SHIELD_DURATION`, `HEAL_AMOUNT` | powerup strengths |
| `MAX_HP`, `ROUNDS_TO_WIN` | health per round, rounds to win |
| `OBSTACLES` | the cover layout (kept point-symmetric so it's fair) |

The German proposal lines are the `SCRIPTS` array in `public/app.js`.

## How it works

- **`server.js`** — a tiny Node HTTP server (no framework) that serves the
  static files and runs an **authoritative 60 Hz game loop** over a WebSocket
  (`ws`). It owns momentum-based movement, dashing, shooting with aim assist,
  powerup spawning/pickups, collisions, damage, rounds and the proposal
  handshake, and streams gameplay events (fires, hits, pickups, deaths) for the
  client's effects.
- **`public/`** — the mobile-first German client (`index.html`, `style.css`,
  `app.js`). Everything is hand-drawn on a `<canvas>` in a soft romantic art
  style: a sunset sky with drifting hearts, a pink garden mat, flower-bed
  cover, and **cute winged-cupid characters** with blushing faces (hearts in
  their eyes when they're lovestruck). It runs **client-side prediction** of
  your own player (so movement feels instant) with smooth server
  reconciliation, interpolates your opponent, draws the twin-stick controls,
  aim reticle and emote bar, and auto-reconnects if a phone briefly drops.
- **`deploy/`** — the systemd unit and Caddyfile used above.

No database, no build step. State lives in memory — perfect for a game you play
once and remember forever.

Viel Glück da draußen. 💕
