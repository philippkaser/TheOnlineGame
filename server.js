import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

// --- Arena --------------------------------------------------------------
const ARENA_W = 600;
const ARENA_H = 900;
const PLAYER_R = 18;

// --- Movement (momentum-based; mirrored on the client for prediction) ---
const PLAYER_ACCEL = 2600; // px/s² toward the stick direction
const PLAYER_FRICTION = 9; // velocity damping per second
const MAX_SPEED = 235; // px/s
const SPEED_MULT = 1.5; // "speed" powerup multiplier
const DASH_SPEED = 720; // px/s burst
const DASH_TIME = 0.16; // seconds of glide
const DASH_COOLDOWN = 1400; // ms

// --- Hearts (projectiles) -----------------------------------------------
const HEART_SPEED = 500;
const HEART_DMG = 12;
const HEART_R = 7;
const FIRE_BASE = 300; // ms between shots
const FIRE_RAPID = 120;
const FIRE_BIG = 520;
const BIG_SPEED = 400;
const BIG_DMG = 26;
const BIG_R = 13;
const SPREAD_ANGLE = 0.22; // rad between spread hearts
const AIM_ASSIST_ANGLE = 0.38; // rad: snap toward enemy if aiming within this
const AIM_ASSIST_STRENGTH = 0.55; // 0..1 blend toward the enemy
const HOMING_TURN = 4.2; // rad/s that Cupid's homing hearts can steer
const CHARM_SLOW = 0.45; // movement multiplier while "lovestruck"
const CHARM_DURATION = 1600; // ms a hit charm lasts

// --- Powerups ------------------------------------------------------------
const POWERUP_R = 16;
const POWERUP_INTERVAL = 4500; // ms between spawns
const POWERUP_MAX = 3; // max on the field at once
const POWERUP_FIRST = 2500; // ms before the first spawn
const FX_DURATION = 7000; // ms for timed effects
const SHIELD_DURATION = 4500;
const HEAL_AMOUNT = 40;
const POWERUP_WEIGHTS = [
  ['heal', 1.1],
  ['rapid', 1],
  ['spread', 1],
  ['shield', 0.9],
  ['speed', 1],
  ['big', 0.9],
  ['cupid', 0.8], // homing hearts
  ['charm', 0.7], // hits lovestruck-slow your partner
];

const MAX_HP = 100;
const ROUNDS_TO_WIN = 2; // best of 3
const TICK_MS = 1000 / 60;

// Point-symmetric obstacles so neither spawn has an advantage.
const OBSTACLES = [
  { x: 250, y: 410, w: 100, h: 80 },
  { x: 80, y: 250, w: 70, h: 70 },
  { x: 450, y: 580, w: 70, h: 70 },
  { x: 450, y: 250, w: 70, h: 70 },
  { x: 80, y: 580, w: 70, h: 70 },
];

const SPAWNS = [
  { x: ARENA_W / 2, y: ARENA_H - 70 },
  { x: ARENA_W / 2, y: 70 },
];

// The physics constants the client needs to run identical prediction.
const CLIENT_CFG = {
  accel: PLAYER_ACCEL,
  friction: PLAYER_FRICTION,
  maxSpeed: MAX_SPEED,
  speedMult: SPEED_MULT,
  dashSpeed: DASH_SPEED,
  dashTime: DASH_TIME,
  dashCooldown: DASH_COOLDOWN,
};

// ---------------------------------------------------------------------------
//  Static file server
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
    players: [],
    phase: 'lobby',
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
const COSMETICS = ['none', 'crown', 'tiara', 'angel', 'horns', 'bunny', 'tophat', 'collar', 'moon', 'star'];

function publicPlayers(room) {
  return room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected, cosmetic: p.cosmetic || 'none' }));
}
function pushLobby(room) {
  broadcast(room, { type: 'lobby', code: room.code, players: publicPlayers(room) });
}

// ---------------------------------------------------------------------------
//  Game logic
// ---------------------------------------------------------------------------
function newEntity(p, i) {
  return {
    id: p.id,
    spawn: i,
    cosmetic: p.cosmetic || 'none',
    x: SPAWNS[i].x,
    y: SPAWNS[i].y,
    vx: 0,
    vy: 0,
    angle: i === 0 ? -Math.PI / 2 : Math.PI / 2,
    hp: MAX_HP,
    wins: 0,
    lastShot: 0,
    dashUntil: 0,
    dashReadyAt: 0,
    prevDash: false,
    charmedUntil: 0,
    fx: { rapid: 0, spread: 0, shield: 0, speed: 0, big: 0, cupid: 0, charm: 0 },
    input: { mx: 0, my: 0, ax: 0, ay: 0, firing: false, dash: false },
  };
}

function startGame(room) {
  room.phase = 'playing';
  room.game = {
    round: 1,
    count: 0,
    lastTick: Date.now(),
    entities: room.players.map(newEntity),
    bullets: [],
    powerups: [],
    events: [],
    nextBulletId: 1,
    nextPuId: 1,
    powerupAt: 0,
    roundEnding: false,
  };

  broadcast(room, {
    type: 'gameStart',
    arena: { w: ARENA_W, h: ARENA_H },
    obstacles: OBSTACLES,
    playerR: PLAYER_R,
    heartR: HEART_R,
    maxHp: MAX_HP,
    roundsToWin: ROUNDS_TO_WIN,
    physics: CLIENT_CFG,
    players: room.game.entities.map((e) => ({ id: e.id, spawn: e.spawn })),
  });

  startRound(room);
  room.loop = setInterval(() => tick(room), TICK_MS);
}

function startRound(room) {
  const g = room.game;
  g.bullets = [];
  g.powerups = [];
  g.events = [];
  g.roundEnding = false;
  g.powerupAt = Date.now() + POWERUP_FIRST;
  for (const e of g.entities) {
    e.x = SPAWNS[e.spawn].x;
    e.y = SPAWNS[e.spawn].y;
    e.vx = e.vy = 0;
    e.angle = e.spawn === 0 ? -Math.PI / 2 : Math.PI / 2;
    e.hp = MAX_HP;
    e.dashUntil = 0;
    e.dashReadyAt = 0;
    e.charmedUntil = 0;
    e.fx = { rapid: 0, spread: 0, shield: 0, speed: 0, big: 0, cupid: 0, charm: 0 };
    e.input.firing = false;
    e.input.dash = false;
    e.prevDash = false;
  }
  room.phase = 'countdown';
  g.count = 3;
  clearTimeout(room.countdownTimer);
  const step = () => {
    g.count -= 1;
    if (g.count <= 0) {
      room.phase = 'playing';
      g.lastTick = Date.now();
      g.powerupAt = Date.now() + POWERUP_FIRST;
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
    const dx = e.x - cx;
    const dy = e.y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < PLAYER_R) {
      if (dist === 0) {
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
      // Kill velocity into the wall so we don't stick.
      e.vx *= 0.5;
      e.vy *= 0.5;
    }
  }
}

function integrate(e, dt, now) {
  const dashing = now < e.dashUntil;
  if (!dashing) {
    const charmed = e.charmedUntil > now ? CHARM_SLOW : 1;
    e.vx += e.input.mx * PLAYER_ACCEL * dt * charmed;
    e.vy += e.input.my * PLAYER_ACCEL * dt * charmed;
    const f = Math.max(0, 1 - PLAYER_FRICTION * dt);
    e.vx *= f;
    e.vy *= f;
    let sp = e.fx.speed > now ? MAX_SPEED * SPEED_MULT : MAX_SPEED;
    sp *= charmed;
    const v = Math.hypot(e.vx, e.vy);
    if (v > sp) {
      e.vx = (e.vx / v) * sp;
      e.vy = (e.vy / v) * sp;
    }
  }
  e.x += e.vx * dt;
  e.y += e.vy * dt;
  if (e.x < PLAYER_R) {
    e.x = PLAYER_R;
    e.vx = 0;
  } else if (e.x > ARENA_W - PLAYER_R) {
    e.x = ARENA_W - PLAYER_R;
    e.vx = 0;
  }
  if (e.y < PLAYER_R) {
    e.y = PLAYER_R;
    e.vy = 0;
  } else if (e.y > ARENA_H - PLAYER_R) {
    e.y = ARENA_H - PLAYER_R;
    e.vy = 0;
  }
  resolveObstacle(e);
}

function tryDash(e, now) {
  const pressed = e.input.dash && !e.prevDash;
  e.prevDash = e.input.dash;
  if (!pressed || now < e.dashReadyAt) return;
  // Dash in the movement direction, or the aim direction if standing still.
  let dx = e.input.mx;
  let dy = e.input.my;
  if (Math.hypot(dx, dy) < 0.2) {
    dx = e.input.ax;
    dy = e.input.ay;
  }
  const m = Math.hypot(dx, dy);
  if (m < 0.2) return;
  e.vx = (dx / m) * DASH_SPEED;
  e.vy = (dy / m) * DASH_SPEED;
  e.dashUntil = now + DASH_TIME * 1000;
  e.dashReadyAt = now + DASH_COOLDOWN;
  e.angle = Math.atan2(dy, dx);
  pushEvent(e.room, { t: 'dash', x: e.x, y: e.y, c: e.spawn });
}

function pushEvent(room, ev) {
  room.game.events.push(ev);
}

function bulletHitsObstacle(b) {
  for (const o of OBSTACLES) {
    if (b.x + b.r > o.x && b.x - b.r < o.x + o.w && b.y + b.r > o.y && b.y - b.r < o.y + o.h) return true;
  }
  return false;
}

function fire(room, e, now) {
  const rapid = e.fx.rapid > now;
  const spread = e.fx.spread > now;
  const big = e.fx.big > now;
  const cd = rapid ? FIRE_RAPID : big ? FIRE_BIG : FIRE_BASE;
  if (!e.input.firing || now - e.lastShot < cd) return;
  const amag = Math.hypot(e.input.ax, e.input.ay);
  if (amag < 0.2) return;
  e.lastShot = now;

  // Aim assist: nudge toward the enemy if we're already roughly on target.
  let dx = e.input.ax / amag;
  let dy = e.input.ay / amag;
  const enemy = room.game.entities.find((o) => o.id !== e.id && o.hp > 0);
  if (enemy) {
    const ex = enemy.x - e.x;
    const ey = enemy.y - e.y;
    const em = Math.hypot(ex, ey) || 1;
    const dot = dx * (ex / em) + dy * (ey / em);
    if (dot > Math.cos(AIM_ASSIST_ANGLE)) {
      dx = dx * (1 - AIM_ASSIST_STRENGTH) + (ex / em) * AIM_ASSIST_STRENGTH;
      dy = dy * (1 - AIM_ASSIST_STRENGTH) + (ey / em) * AIM_ASSIST_STRENGTH;
      const nm = Math.hypot(dx, dy) || 1;
      dx /= nm;
      dy /= nm;
    }
  }

  const baseAng = Math.atan2(dy, dx);
  e.angle = baseAng;
  const homing = e.fx.cupid > now;
  const charm = e.fx.charm > now;
  const speed = big ? BIG_SPEED : HEART_SPEED;
  const dmg = big ? BIG_DMG : HEART_DMG;
  const r = big ? BIG_R : HEART_R;
  const angles = spread ? [-SPREAD_ANGLE, 0, SPREAD_ANGLE] : [0];
  for (const off of angles) {
    const a = baseAng + off;
    const cdx = Math.cos(a);
    const cdy = Math.sin(a);
    room.game.bullets.push({
      id: room.game.nextBulletId++,
      owner: e.id,
      ownerSpawn: e.spawn,
      x: e.x + cdx * (PLAYER_R + r + 1),
      y: e.y + cdy * (PLAYER_R + r + 1),
      vx: cdx * speed,
      vy: cdy * speed,
      r,
      dmg,
      homing,
      charm,
      speed,
    });
  }
  pushEvent(room, { t: 'fire', x: e.x + Math.cos(baseAng) * PLAYER_R, y: e.y + Math.sin(baseAng) * PLAYER_R, a: baseAng, c: e.spawn });
}

function pickWeighted(list) {
  const total = list.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [name, w] of list) {
    if ((r -= w) <= 0) return name;
  }
  return list[0][0];
}

function spawnPowerup(g) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const x = 60 + Math.random() * (ARENA_W - 120);
    const y = 130 + Math.random() * (ARENA_H - 260);
    // Not inside an obstacle (with margin).
    let bad = false;
    for (const o of OBSTACLES) {
      if (x > o.x - 30 && x < o.x + o.w + 30 && y > o.y - 30 && y < o.y + o.h + 30) {
        bad = true;
        break;
      }
    }
    if (bad) continue;
    // Not on top of a player.
    if (g.entities.some((e) => Math.hypot(e.x - x, e.y - y) < 90)) continue;
    // Not on top of another powerup.
    if (g.powerups.some((p) => Math.hypot(p.x - x, p.y - y) < 70)) continue;
    g.powerups.push({ id: g.nextPuId++, x, y, type: pickWeighted(POWERUP_WEIGHTS) });
    return;
  }
}

function applyPowerup(room, e, type, now) {
  if (type === 'heal') e.hp = Math.min(MAX_HP, e.hp + HEAL_AMOUNT);
  else if (type === 'shield') e.fx.shield = now + SHIELD_DURATION;
  else e.fx[type] = now + FX_DURATION;
}

function tick(room) {
  const g = room.game;
  if (!g) return;
  const now = Date.now();
  const dt = Math.min(0.05, (now - g.lastTick) / 1000);
  g.lastTick = now;
  // Give entities a back-reference for event pushing this tick.
  for (const e of g.entities) e.room = room;

  if (room.phase === 'playing') {
    for (const e of g.entities) {
      tryDash(e, now);
      integrate(e, dt, now);
      const amag = Math.hypot(e.input.ax, e.input.ay);
      if (amag > 0.2 && now >= e.dashUntil) e.angle = Math.atan2(e.input.ay, e.input.ax);
      fire(room, e, now);
    }

    // Powerup spawning.
    if (now >= g.powerupAt && g.powerups.length < POWERUP_MAX) {
      spawnPowerup(g);
      g.powerupAt = now + POWERUP_INTERVAL;
    }
    // Powerup pickups.
    g.powerups = g.powerups.filter((pu) => {
      for (const e of g.entities) {
        if (e.hp > 0 && Math.hypot(e.x - pu.x, e.y - pu.y) < PLAYER_R + POWERUP_R) {
          applyPowerup(room, e, pu.type, now);
          pushEvent(room, { t: 'pickup', x: pu.x, y: pu.y, type: pu.type, c: e.spawn });
          return false;
        }
      }
      return true;
    });

    // Bullets.
    const survivors = [];
    for (const b of g.bullets) {
      if (b.homing) {
        const enemy = g.entities.find((o) => o.id !== b.owner && o.hp > 0);
        if (enemy) {
          const cur = Math.atan2(b.vy, b.vx);
          let want = Math.atan2(enemy.y - b.y, enemy.x - b.x);
          let diff = ((want - cur + Math.PI) % (Math.PI * 2)) - Math.PI;
          const step = Math.max(-HOMING_TURN * dt, Math.min(HOMING_TURN * dt, diff));
          const na = cur + step;
          b.vx = Math.cos(na) * b.speed;
          b.vy = Math.sin(na) * b.speed;
        }
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x < 0 || b.x > ARENA_W || b.y < 0 || b.y > ARENA_H) continue;
      if (bulletHitsObstacle(b)) {
        pushEvent(room, { t: 'wall', x: b.x, y: b.y, c: b.ownerSpawn });
        continue;
      }
      let hit = false;
      for (const e of g.entities) {
        if (e.id === b.owner || e.hp <= 0) continue;
        if (Math.hypot(e.x - b.x, e.y - b.y) < PLAYER_R + b.r) {
          hit = true;
          if (e.fx.shield > now) {
            pushEvent(room, { t: 'block', x: b.x, y: b.y, c: e.spawn });
          } else {
            e.hp = Math.max(0, e.hp - b.dmg);
            pushEvent(room, { t: 'hit', x: b.x, y: b.y, c: e.spawn, victim: e.id });
            if (b.charm && e.hp > 0) {
              e.charmedUntil = now + CHARM_DURATION;
              pushEvent(room, { t: 'charm', x: e.x, y: e.y, c: e.spawn, victim: e.id });
            }
            if (e.hp <= 0) handleDeath(room, e);
          }
          break;
        }
      }
      if (!hit) survivors.push(b);
    }
    g.bullets = survivors;
  }

  broadcastState(room);
  g.events = [];
}

function handleDeath(room, dead) {
  const g = room.game;
  if (g.roundEnding) return;
  g.roundEnding = true;
  pushEvent(room, { t: 'death', x: dead.x, y: dead.y, c: dead.spawn });
  const killer = g.entities.find((e) => e.id !== dead.id);
  if (!killer) return;
  killer.wins += 1;

  if (killer.wins >= ROUNDS_TO_WIN) {
    room.phase = 'roundover';
    broadcastState(room);
    setTimeout(() => endGame(room, killer.id), 1500);
  } else {
    room.phase = 'roundover';
    broadcastState(room);
    g.round += 1;
    setTimeout(() => startRound(room), 1700);
  }
}

function fxRemaining(e, key, now) {
  return Math.max(0, e.fx[key] - now);
}

function broadcastState(room) {
  const g = room.game;
  if (!g) return;
  const now = Date.now();
  broadcast(room, {
    type: 'state',
    phase: room.phase,
    round: g.round,
    count: room.phase === 'countdown' ? g.count : 0,
    players: g.entities.map((e) => ({
      id: e.id,
      spawn: e.spawn,
      cosmetic: e.cosmetic,
      x: Math.round(e.x * 10) / 10,
      y: Math.round(e.y * 10) / 10,
      vx: Math.round(e.vx),
      vy: Math.round(e.vy),
      angle: Math.round(e.angle * 100) / 100,
      hp: e.hp,
      wins: e.wins,
      dashCd: Math.max(0, e.dashReadyAt - now),
      charmed: Math.max(0, e.charmedUntil - now),
      fx: {
        rapid: fxRemaining(e, 'rapid', now),
        spread: fxRemaining(e, 'spread', now),
        shield: fxRemaining(e, 'shield', now),
        speed: fxRemaining(e, 'speed', now),
        big: fxRemaining(e, 'big', now),
        cupid: fxRemaining(e, 'cupid', now),
        charm: fxRemaining(e, 'charm', now),
      },
    })),
    bullets: g.bullets.map((b) => ({ i: b.id, x: Math.round(b.x), y: Math.round(b.y), c: b.ownerSpawn, r: b.r })),
    powerups: g.powerups.map((p) => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y), t: p.type })),
    events: g.events,
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
      const p = { id: genId(), ws, name: (msg.name || 'Spieler 1').slice(0, 20), connected: true, cosmetic: 'none' };
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
        send(ws, { type: 'error', message: 'Diesen Raumcode gibt es nicht. Stimmen die Buchstaben?' });
        return;
      }
      const dropped = room.players.find((p) => !p.connected);
      if (room.players.length >= 2 && !dropped) {
        send(ws, { type: 'error', message: 'Dieser Raum ist schon voll.' });
        return;
      }
      let p;
      if (dropped) {
        p = dropped;
        p.connected = true;
        p.ws = ws;
        if (msg.name) p.name = msg.name.slice(0, 20);
      } else {
        p = { id: genId(), ws, name: (msg.name || 'Spieler 2').slice(0, 20), connected: true, cosmetic: 'none' };
        room.players.push(p);
      }
      ws.roomCode = room.code;
      ws.playerId = p.id;
      send(ws, { type: 'joined', code: room.code, playerId: p.id, isHost: room.players[0].id === p.id });
      pushLobby(room);
      break;
    }
    case 'setCosmetic': {
      const room = rooms.get(ws.roomCode);
      if (!room || room.phase !== 'lobby') return;
      const player = room.players.find((p) => p.id === ws.playerId);
      if (!player) return;
      player.cosmetic = COSMETICS.includes(msg.cosmetic) ? msg.cosmetic : 'none';
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
      e.input.dash = !!msg.dash;
      break;
    }
    case 'emote': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const player = room.players.find((p) => p.id === ws.playerId);
      if (!player) return;
      const kind = ['kiss', 'heart', 'wink', 'rose'].includes(msg.kind) ? msg.kind : 'heart';
      broadcast(room, { type: 'emote', from: player.id, kind });
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
  console.log(`💘  Das Liebes-Duell läuft auf http://localhost:${PORT}`);
});
