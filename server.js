import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

// --- Arena & gameplay constants (shared shape with the client) --------------
const ARENA_W = 600;
const ARENA_H = 900;
const PLAYER_R = 18;
const PLAYER_SPEED = 200; // px / second
const BULLET_R = 6;
const BULLET_SPEED = 460; // px / second
const BULLET_DMG = 12;
const FIRE_COOLDOWN = 260; // ms between shots
const MAX_HP = 100;
const ROUNDS_TO_WIN = 2; // best of 3
const TICK_MS = 1000 / 30;

// Point-symmetric obstacles so neither spawn has an advantage.
const OBSTACLES = [
  { x: 250, y: 410, w: 100, h: 80 }, // centre block (self-symmetric)
  { x: 80, y: 250, w: 70, h: 70 },
  { x: 450, y: 580, w: 70, h: 70 },
  { x: 450, y: 250, w: 70, h: 70 },
  { x: 80, y: 580, w: 70, h: 70 },
];

// Spawn points: index 0 defends the bottom, index 1 the top.
const SPAWNS = [
  { x: ARENA_W / 2, y: ARENA_H - 70 },
  { x: ARENA_W / 2, y: 70 },
];

// ---------------------------------------------------------------------------
//  Tiny static file server
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
//  Rooms
// ---------------------------------------------------------------------------
/** @type {Map<string, Room>} */
const rooms = new Map();

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeRoom() {
  const code = makeCode();
  const room = {
    code,
    players: [], // { id, ws, name, connected }
    phase: 'lobby', // lobby | countdown | playing | proposal | done
    game: null,
    loop: null,
    countdownTimer: null,
  };
  rooms.set(code, room);
  return room;
}

const genId = () => Math.random().toString(36).slice(2, 10);

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  for (const p of room.players) send(p.ws, msg);
}
function publicPlayers(room) {
  return room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected }));
}
function pushLobby(room) {
  broadcast(room, { type: 'lobby', code: room.code, players: publicPlayers(room) });
}

// ---------------------------------------------------------------------------
//  Game logic
// ---------------------------------------------------------------------------
function startGame(room) {
  room.phase = 'playing';
  room.game = {
    round: 1,
    count: 0,
    lastTick: Date.now(),
    entities: room.players.map((p, i) => ({
      id: p.id,
      spawn: i,
      x: SPAWNS[i].x,
      y: SPAWNS[i].y,
      angle: i === 0 ? -Math.PI / 2 : Math.PI / 2,
      hp: MAX_HP,
      wins: 0,
      lastShot: 0,
      input: { mx: 0, my: 0, ax: 0, ay: 0, firing: false },
    })),
    bullets: [],
    nextBulletId: 1,
  };

  broadcast(room, {
    type: 'gameStart',
    arena: { w: ARENA_W, h: ARENA_H },
    obstacles: OBSTACLES,
    playerR: PLAYER_R,
    bulletR: BULLET_R,
    maxHp: MAX_HP,
    roundsToWin: ROUNDS_TO_WIN,
    players: room.game.entities.map((e) => ({ id: e.id, spawn: e.spawn })),
  });

  startRound(room);
  room.loop = setInterval(() => tick(room), TICK_MS);
}

function startRound(room) {
  const g = room.game;
  g.bullets = [];
  for (const e of g.entities) {
    e.x = SPAWNS[e.spawn].x;
    e.y = SPAWNS[e.spawn].y;
    e.angle = e.spawn === 0 ? -Math.PI / 2 : Math.PI / 2;
    e.hp = MAX_HP;
    e.input.firing = false;
  }
  g.roundEnding = false;
  room.phase = 'countdown';
  g.count = 3;
  clearTimeout(room.countdownTimer);
  const step = () => {
    g.count -= 1;
    if (g.count <= 0) {
      room.phase = 'playing';
      g.lastTick = Date.now();
    } else {
      room.countdownTimer = setTimeout(step, 1000);
    }
  };
  room.countdownTimer = setTimeout(step, 1000);
}

function resolveObstacle(e) {
  for (const o of OBSTACLES) {
    const cx = Math.max(o.x, Math.min(e.x, o.x + o.w));
    const cy = Math.max(o.y, Math.min(e.y, o.y + o.h));
    let dx = e.x - cx;
    let dy = e.y - cy;
    let dist = Math.hypot(dx, dy);
    if (dist < PLAYER_R) {
      if (dist === 0) {
        // Centre is inside the rect — push out along the smallest axis.
        const left = e.x - o.x;
        const right = o.x + o.w - e.x;
        const top = e.y - o.y;
        const bottom = o.y + o.h - e.y;
        const m = Math.min(left, right, top, bottom);
        if (m === left) e.x = o.x - PLAYER_R;
        else if (m === right) e.x = o.x + o.w + PLAYER_R;
        else if (m === top) e.y = o.y - PLAYER_R;
        else e.y = o.y + o.h + PLAYER_R;
      } else {
        const push = (PLAYER_R - dist) / dist;
        e.x += dx * push;
        e.y += dy * push;
      }
    }
  }
}

function bulletHitsObstacle(b) {
  for (const o of OBSTACLES) {
    if (b.x + BULLET_R > o.x && b.x - BULLET_R < o.x + o.w && b.y + BULLET_R > o.y && b.y - BULLET_R < o.y + o.h) {
      return true;
    }
  }
  return false;
}

function tick(room) {
  const g = room.game;
  if (!g) return;
  const now = Date.now();
  const dt = Math.min(0.05, (now - g.lastTick) / 1000);
  g.lastTick = now;

  if (room.phase === 'playing') {
    // Move players + fire.
    for (const e of g.entities) {
      const inp = e.input;
      const mmag = Math.hypot(inp.mx, inp.my);
      if (mmag > 0.05) {
        const scale = (mmag > 1 ? 1 / mmag : 1) * PLAYER_SPEED * dt;
        e.x += inp.mx * scale;
        e.y += inp.my * scale;
      }
      // Clamp to arena.
      e.x = Math.max(PLAYER_R, Math.min(ARENA_W - PLAYER_R, e.x));
      e.y = Math.max(PLAYER_R, Math.min(ARENA_H - PLAYER_R, e.y));
      resolveObstacle(e);

      const amag = Math.hypot(inp.ax, inp.ay);
      if (amag > 0.05) e.angle = Math.atan2(inp.ay, inp.ax);

      if (inp.firing && amag > 0.05 && now - e.lastShot >= FIRE_COOLDOWN) {
        e.lastShot = now;
        const dx = inp.ax / amag;
        const dy = inp.ay / amag;
        g.bullets.push({
          id: g.nextBulletId++,
          owner: e.id,
          ownerSpawn: e.spawn,
          x: e.x + dx * (PLAYER_R + BULLET_R + 1),
          y: e.y + dy * (PLAYER_R + BULLET_R + 1),
          vx: dx * BULLET_SPEED,
          vy: dy * BULLET_SPEED,
        });
      }
    }

    // Move bullets + collisions.
    const survivors = [];
    for (const b of g.bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x < 0 || b.x > ARENA_W || b.y < 0 || b.y > ARENA_H) continue;
      if (bulletHitsObstacle(b)) continue;
      let hit = false;
      for (const e of g.entities) {
        if (e.id === b.owner || e.hp <= 0) continue;
        if (Math.hypot(e.x - b.x, e.y - b.y) < PLAYER_R + BULLET_R) {
          e.hp = Math.max(0, e.hp - BULLET_DMG);
          hit = true;
          if (e.hp <= 0) handleDeath(room, e);
          break;
        }
      }
      if (!hit) survivors.push(b);
    }
    g.bullets = survivors;
  }

  broadcastState(room);
}

function handleDeath(room, dead) {
  const g = room.game;
  if (g.roundEnding) return; // a death this round was already resolved
  g.roundEnding = true;
  const killer = g.entities.find((e) => e.id !== dead.id);
  if (!killer) return;
  killer.wins += 1;

  if (killer.wins >= ROUNDS_TO_WIN) {
    room.phase = 'roundover';
    broadcastState(room);
    setTimeout(() => endGame(room, killer.id), 1400);
  } else {
    room.phase = 'roundover';
    broadcastState(room);
    g.round += 1;
    setTimeout(() => startRound(room), 1600);
  }
}

function broadcastState(room) {
  const g = room.game;
  if (!g) return;
  broadcast(room, {
    type: 'state',
    phase: room.phase,
    round: g.round,
    count: room.phase === 'countdown' ? g.count : 0,
    players: g.entities.map((e) => ({
      id: e.id,
      spawn: e.spawn,
      x: Math.round(e.x * 10) / 10,
      y: Math.round(e.y * 10) / 10,
      angle: Math.round(e.angle * 100) / 100,
      hp: e.hp,
      wins: e.wins,
    })),
    bullets: g.bullets.map((b) => [Math.round(b.x), Math.round(b.y), b.ownerSpawn]),
  });
}

function stopGame(room) {
  clearInterval(room.loop);
  clearTimeout(room.countdownTimer);
  room.loop = null;
}

function endGame(room, winnerId) {
  stopGame(room);
  room.phase = 'proposal';
  const winner = room.players.find((p) => p.id === winnerId);
  const loser = room.players.find((p) => p.id !== winnerId);
  room.winnerId = winner.id;
  room.loserId = loser.id;
  room.proposalState = 'pending';

  for (const p of room.players) {
    send(p.ws, {
      type: 'gameOver',
      youWon: p.id === winner.id,
      winner: { id: winner.id, name: winner.name },
      loser: { id: loser.id, name: loser.name },
    });
  }
}

function handlePropose(room, player) {
  if (room.phase !== 'proposal' || player.id !== room.loserId) return;
  room.proposalState = 'proposed';
  broadcast(room, { type: 'proposalMade', proposer: room.loserId, proposee: room.winnerId });
}

function handleAccept(room, player) {
  if (room.phase !== 'proposal' || player.id !== room.winnerId) return;
  if (room.proposalState !== 'proposed') return;
  room.proposalState = 'accepted';
  room.phase = 'done';
  broadcast(room, { type: 'proposalAccepted' });
}

// ---------------------------------------------------------------------------
//  WebSocket wiring
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const player = room.players.find((p) => p.id === ws.playerId);
    if (player) {
      player.connected = false;
      player.ws = null;
    }
    pushLobby(room);
    setTimeout(() => {
      const r = rooms.get(ws.roomCode);
      if (r && r.players.every((p) => !p.connected)) {
        stopGame(r);
        rooms.delete(ws.roomCode);
      }
    }, 60000);
  });
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create': {
      const room = makeRoom();
      const p = { id: genId(), ws, name: (msg.name || 'Player 1').slice(0, 20), connected: true };
      room.players.push(p);
      ws.roomCode = room.code;
      ws.playerId = p.id;
      send(ws, { type: 'joined', code: room.code, playerId: p.id, isHost: true });
      pushLobby(room);
      break;
    }

    case 'join': {
      const code = (msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { type: 'error', message: "That room code doesn't exist. Check the letters?" });
        return;
      }
      const dropped = room.players.find((p) => !p.connected);
      if (room.players.length >= 2 && !dropped) {
        send(ws, { type: 'error', message: 'That room is already full.' });
        return;
      }
      let p;
      if (dropped) {
        p = dropped;
        p.connected = true;
        p.ws = ws;
        if (msg.name) p.name = msg.name.slice(0, 20);
      } else {
        p = { id: genId(), ws, name: (msg.name || 'Player 2').slice(0, 20), connected: true };
        room.players.push(p);
      }
      ws.roomCode = room.code;
      ws.playerId = p.id;
      send(ws, { type: 'joined', code: room.code, playerId: p.id, isHost: room.players[0].id === p.id });
      pushLobby(room);
      break;
    }

    case 'start': {
      const room = rooms.get(ws.roomCode);
      if (!room || room.phase !== 'lobby') return;
      if (room.players.length < 2 || !room.players.every((p) => p.connected)) return;
      if (room.players[0].id !== ws.playerId) return;
      startGame(room);
      break;
    }

    case 'input': {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.game) return;
      const e = room.game.entities.find((x) => x.id === ws.playerId);
      if (!e) return;
      e.input.mx = clampNum(msg.mx);
      e.input.my = clampNum(msg.my);
      e.input.ax = clampNum(msg.ax);
      e.input.ay = clampNum(msg.ay);
      e.input.firing = !!msg.firing;
      break;
    }

    case 'propose': {
      const room = rooms.get(ws.roomCode);
      const player = room?.players.find((p) => p.id === ws.playerId);
      if (player) handlePropose(room, player);
      break;
    }

    case 'accept': {
      const room = rooms.get(ws.roomCode);
      const player = room?.players.find((p) => p.id === ws.playerId);
      if (player) handleAccept(room, player);
      break;
    }

    case 'playAgain': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (room.players[0]?.id !== ws.playerId) return;
      stopGame(room);
      room.phase = 'lobby';
      room.game = null;
      pushLobby(room);
      break;
    }
  }
}

function clampNum(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

server.listen(PORT, () => {
  console.log(`🔫  The Love Duel (shooter) running at http://localhost:${PORT}`);
});
