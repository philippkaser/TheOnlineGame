// ---------------------------------------------------------------------------
//  Das Liebes-Duell — client (prediction + powerups + juice)
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const COLORS = ['#ff4fa3', '#4fd4ff']; // player spawn 0 / 1
const COLORS_SOFT = ['rgba(255,79,163,', 'rgba(79,212,255,'];
const OUTLINE = '#3a1030'; // sticker outline for the flat kawaii look
// Kawaii / menhera palette (flat, saturated — Needy-Streamer vibe).
const KW = { bg: '#ffcdeb', dot: 'rgba(255,120,196,0.55)', frame: '#ff2f92', obFill: '#c98cff', obTop: '#e3c4ff' };

const POWERUPS = {
  heal: { emoji: '💚', ring: '#4ade80', label: 'Heilung' },
  rapid: { emoji: '⚡', ring: '#ffd76a', label: 'Schnellfeuer' },
  spread: { emoji: '🔱', ring: '#c084fc', label: 'Dreifach' },
  shield: { emoji: '🛡️', ring: '#38bdf8', label: 'Schild' },
  speed: { emoji: '👟', ring: '#34d399', label: 'Speed' },
  big: { emoji: '💥', ring: '#fb7185', label: 'Große Herzen' },
  cupid: { emoji: '💘', ring: '#ff8fb1', label: 'Amors Pfeil' },
  charm: { emoji: '💋', ring: '#ff4d6d', label: 'Kuss' },
};

// Lobby "dress up" options. `id` matches the server + the canvas drawing.
const COSMETIC_MENU = [
  { id: 'none', emoji: '🚫', label: 'Keins' },
  { id: 'crown', emoji: '👑', label: 'König' },
  { id: 'tiara', emoji: '👸', label: 'Prinzessin' },
  { id: 'angel', emoji: '😇', label: 'Engel' },
  { id: 'horns', emoji: '😈', label: 'Teufel' },
  { id: 'bunny', emoji: '🐰', label: 'Hase' },
  { id: 'tophat', emoji: '🎩', label: 'Gentleman' },
  { id: 'collar', emoji: '🎀', label: 'Schleife' },
  { id: 'moon', emoji: '🌙', label: 'Luna' },
  { id: 'star', emoji: '⭐', label: 'Stern' },
];
const COSMETIC_EMOJI = Object.fromEntries(COSMETIC_MENU.map((c) => [c.id, c.emoji]));

// Sweet nothings shown between rounds.
const LOVE_NOTES = [
  'Kämpfe schön, mein Schatz 💕',
  'Möge die/der Verliebtere gewinnen 💘',
  'Alles ist fair in Liebe & Herzchen 🌹',
  'Ich hab dich zum Fressen gern 😘',
  'Nur ein Spiel — aber mein Herz meint es ernst ❤️',
  'Küsschen zählen leider nicht als Treffer 💋',
];

const state = {
  ws: null,
  playerId: null,
  isHost: false,
  code: null,
  cfg: null,
  phys: null,
  latest: null,
  self: null, // predicted { x, y, vx, vy, dashUntil, dashReadyAt, prevDash }
  selfFx: {},
  selfCharm: 0,
  myCosmetic: 'none',
  opp: {}, // smoothed opponent render pos by id
  input: { mx: 0, my: 0, ax: 0, ay: 0, firing: false, dash: false },
  inputTimer: null,
  raf: null,
  lastFrame: 0,
  shake: 0,
  trails: {}, // bulletId -> [{x,y}]
};
const particles = [];

// --- Screen management ------------------------------------------------------
function show(id) {
  $$('.screen').forEach((s) => s.classList.remove('active'));
  $('#' + id).classList.add('active');
}

// --- WebSocket --------------------------------------------------------------
function connect(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;
  ws.addEventListener('open', () => onOpen && onOpen());
  ws.addEventListener('message', (e) => handleMessage(JSON.parse(e.data)));
  ws.addEventListener('close', () => {
    if (state.code) setTimeout(() => connect(() => rejoin()), 1200);
  });
}
function sendMsg(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}
function rejoin() {
  sendMsg({ type: 'join', code: state.code, name: getName() });
}
function getName() {
  return ($('#name-input').value || '').trim();
}

// --- Home / lobby actions ---------------------------------------------------
$('#btn-create').addEventListener('click', () => {
  $('#home-error').textContent = '';
  connect(() => sendMsg({ type: 'create', name: getName() || 'Spieler 1' }));
});
$('#btn-join').addEventListener('click', () => {
  const code = ($('#code-input').value || '').toUpperCase().trim();
  if (code.length !== 4) {
    $('#home-error').textContent = 'Raumcodes haben 4 Buchstaben.';
    return;
  }
  $('#home-error').textContent = '';
  state.code = code;
  connect(() => sendMsg({ type: 'join', code, name: getName() || 'Spieler 2' }));
});
$('#code-input').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase()));
$('#btn-start').addEventListener('click', () => sendMsg({ type: 'start' }));
$('#btn-propose').addEventListener('click', () => {
  sendMsg({ type: 'propose' });
  $('#btn-propose').classList.add('hidden');
  $('#lost-waiting').classList.remove('hidden');
});
$('#btn-yes').addEventListener('click', () => sendMsg({ type: 'accept' }));
$('#btn-again').addEventListener('click', () => sendMsg({ type: 'playAgain' }));

// Emote bar — blow your partner a kiss mid-duel. Emotes pop as a cute
// sticker speech-bubble above the sender's fighter (drawn on the canvas).
const EMOTE_GLYPH = { kiss: '💋', heart: '❤️', wink: '😘', rose: '🌹' };
const activeEmotes = {}; // playerId -> { glyph, born }
$$('.emote-btn').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    sendMsg({ type: 'emote', kind: b.dataset.kind });
  });
});
function showEmote(msg) {
  activeEmotes[msg.from] = { glyph: EMOTE_GLYPH[msg.kind] || '❤️', born: performance.now() };
}

// --- Messages ---------------------------------------------------------------
function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      state.playerId = msg.playerId;
      state.isHost = msg.isHost;
      state.code = msg.code;
      break;
    case 'lobby':
      renderLobby(msg);
      show('screen-lobby');
      break;
    case 'error':
      $('#home-error').textContent = msg.message;
      state.code = null;
      break;
    case 'gameStart':
      startGame(msg);
      break;
    case 'state':
      onState(msg);
      break;
    case 'emote':
      showEmote(msg);
      break;
    case 'gameOver':
      renderGameOver(msg);
      break;
    case 'proposalMade':
      renderProposalMade(msg);
      break;
    case 'proposalAccepted':
      renderCelebration();
      break;
  }
}

function buildCosmeticPicker() {
  const grid = $('#cosmetic-grid');
  if (grid.dataset.built) return;
  grid.dataset.built = '1';
  COSMETIC_MENU.forEach((c) => {
    const btn = document.createElement('button');
    btn.className = 'cosmetic-btn';
    btn.dataset.id = c.id;
    btn.innerHTML = `<span class="cos-emoji">${c.emoji}</span><span class="cos-label">${c.label}</span>`;
    btn.addEventListener('click', () => {
      state.myCosmetic = c.id;
      sendMsg({ type: 'setCosmetic', cosmetic: c.id });
      refreshCosmeticHighlight();
    });
    grid.appendChild(btn);
  });
}
function refreshCosmeticHighlight() {
  $$('#cosmetic-grid .cosmetic-btn').forEach((b) => b.classList.toggle('selected', b.dataset.id === state.myCosmetic));
}

function renderLobby(msg) {
  state.code = msg.code;
  $('#lobby-code').textContent = msg.code;
  buildCosmeticPicker();
  refreshCosmeticHighlight();
  const list = $('#player-list');
  list.innerHTML = '';
  msg.players.forEach((p) => {
    const cos = p.cosmetic && p.cosmetic !== 'none' ? ` <span class="li-cos">${COSMETIC_EMOJI[p.cosmetic] || ''}</span>` : '';
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot"></span><span>${escapeHtml(p.name)}${p.id === state.playerId ? ' (du)' : ''}</span>${cos}`;
    list.appendChild(li);
  });
  if (msg.players.length < 2) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.innerHTML = `<span class="dot"></span><span>Warte auf Partner…</span>`;
    list.appendChild(li);
  }
  const ready = msg.players.length === 2 && msg.players.every((p) => p.connected);
  const startBtn = $('#btn-start');
  if (state.isHost) {
    startBtn.style.display = '';
    startBtn.disabled = !ready;
    $('#lobby-status').textContent = ready ? 'Ihr seid beide da! 💕' : 'Warte auf deinen Partner…';
  } else {
    startBtn.style.display = 'none';
    $('#lobby-status').textContent = ready ? 'Warte auf den Host…' : 'Warte auf deinen Partner…';
  }
}

// ---------------------------------------------------------------------------
//  Game
// ---------------------------------------------------------------------------
const canvas = $('#game-canvas');
const ctx = canvas.getContext('2d');
let view = { scale: 1, ox: 0, oy: 0, cssW: 0, cssH: 0 };

function startGame(cfg) {
  state.cfg = cfg;
  state.phys = cfg.physics;
  state.latest = null;
  state.self = null;
  state.opp = {};
  state.trails = {};
  particles.length = 0;
  state.shake = 0;
  buildBackdrop();
  stopConfetti();
  show('screen-game');
  resizeCanvas();
  bindControls();
  startInputLoop();
  state.lastFrame = performance.now();
  if (!state.raf) loop();
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  view.cssW = rect.width;
  view.cssH = rect.height;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { w, h } = state.cfg.arena;
  view.scale = Math.min(view.cssW / w, view.cssH / h);
  view.ox = (view.cssW - w * view.scale) / 2;
  view.oy = (view.cssH - h * view.scale) / 2;
}
window.addEventListener('resize', () => {
  if (state.cfg && $('#screen-game').classList.contains('active')) resizeCanvas();
});

const wx = (x) => view.ox + x * view.scale;
const wy = (y) => view.oy + y * view.scale;
const wsc = (s) => s * view.scale;

// --- State ingest + prediction reconciliation -------------------------------
function onState(msg) {
  state.latest = msg;
  const now = performance.now();
  const me = msg.players.find((p) => p.id === state.playerId);
  if (me) {
    state.selfFx = me.fx;
    state.selfCharm = me.charmed || 0;
    if (!state.self) {
      state.self = { x: me.x, y: me.y, vx: me.vx, vy: me.vy, dashUntil: 0, dashReadyAt: now + me.dashCd, prevDash: false };
    } else {
      const s = state.self;
      const err = Math.hypot(s.x - me.x, s.y - me.y);
      if (err > 55 || msg.phase !== 'playing') {
        s.x = me.x;
        s.y = me.y;
      } else {
        s.x += (me.x - s.x) * 0.25;
        s.y += (me.y - s.y) * 0.25;
      }
      s.vx = me.vx;
      s.vy = me.vy;
      s.dashReadyAt = now + me.dashCd;
    }
  }
  // Bullet trails.
  const seen = new Set();
  for (const b of msg.bullets) {
    seen.add(b.i);
    const t = (state.trails[b.i] = state.trails[b.i] || []);
    t.push({ x: b.x, y: b.y });
    if (t.length > 4) t.shift();
  }
  for (const id of Object.keys(state.trails)) if (!seen.has(Number(id))) delete state.trails[id];

  // Events → juice.
  for (const ev of msg.events || []) handleEvent(ev);
}

function handleEvent(ev) {
  const col = COLORS[ev.c] || '#fff';
  if (ev.t === 'fire') {
    for (let i = 0; i < 5; i++) {
      const a = ev.a + (Math.random() - 0.5) * 0.6;
      const sp = 60 + Math.random() * 120;
      particles.push({ x: ev.x, y: ev.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.25, max: 0.25, r: 3, color: col, kind: 'spark' });
    }
  } else if (ev.t === 'hit') {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 180;
      particles.push({ x: ev.x, y: ev.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5, max: 0.5, r: 4, color: col, kind: 'heart' });
    }
    if (ev.victim === state.playerId) state.shake = Math.min(1, state.shake + 0.8);
  } else if (ev.t === 'block') {
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 120;
      particles.push({ x: ev.x, y: ev.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.35, max: 0.35, r: 3, color: '#38bdf8', kind: 'spark' });
    }
  } else if (ev.t === 'pickup') {
    const pu = POWERUPS[ev.type];
    particles.push({ x: ev.x, y: ev.y, vx: 0, vy: -40, life: 1.1, max: 1.1, r: 0, color: pu ? pu.ring : '#fff', kind: 'float', text: pu ? pu.emoji + ' ' + pu.label : '' });
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 160;
      particles.push({ x: ev.x, y: ev.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5, max: 0.5, r: 3, color: pu ? pu.ring : '#fff', kind: 'spark' });
    }
  } else if (ev.t === 'dash') {
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * 70;
      particles.push({ x: ev.x, y: ev.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.3, max: 0.3, r: 5, color: COLORS_SOFT[ev.c] + '0.5)', kind: 'puff' });
    }
  } else if (ev.t === 'charm') {
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 90;
      particles.push({ x: ev.x, y: ev.y - 20, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 30, life: 0.8, max: 0.8, r: 4, color: '#ff4d6d', kind: 'heart' });
    }
  } else if (ev.t === 'death') {
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 320;
      particles.push({ x: ev.x, y: ev.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.9, max: 0.9, r: 5, color: col, kind: 'heart' });
    }
    state.shake = 1;
  }
}

// --- Controls ---------------------------------------------------------------
const sticks = { move: null, aim: null };
const STICK_R = 60;
const keys = {};
let mouse = { active: false, x: 0, y: 0, down: false };
let lastLeftTap = 0;
let dashUntilSend = 0;

function bindControls() {
  if (canvas.dataset.bound) return;
  canvas.dataset.bound = '1';
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });
  window.addEventListener('keydown', (e) => {
    keys[e.key.toLowerCase()] = true;
  });
  window.addEventListener('keyup', (e) => (keys[e.key.toLowerCase()] = false));
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.active = true;
    mouse.x = e.clientX - r.left;
    mouse.y = e.clientY - r.top;
  });
  canvas.addEventListener('mousedown', () => (mouse.down = true));
  window.addEventListener('mouseup', () => (mouse.down = false));
}

function onTouchStart(e) {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const now = performance.now();
  for (const t of Array.from(e.changedTouches)) {
    const x = t.clientX - r.left;
    const y = t.clientY - r.top;
    const side = x < view.cssW / 2 ? 'move' : 'aim';
    if (side === 'move') {
      if (now - lastLeftTap < 280) dashUntilSend = now + 130; // double-tap = dash
      lastLeftTap = now;
    }
    if (!sticks[side]) sticks[side] = { id: t.identifier, ox: x, oy: y, x, y };
  }
}
function onTouchMove(e) {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  for (const t of Array.from(e.touches)) {
    for (const side of ['move', 'aim']) {
      if (sticks[side] && sticks[side].id === t.identifier) {
        sticks[side].x = t.clientX - r.left;
        sticks[side].y = t.clientY - r.top;
      }
    }
  }
}
function onTouchEnd(e) {
  e.preventDefault();
  for (const t of Array.from(e.changedTouches)) {
    for (const side of ['move', 'aim']) {
      if (sticks[side] && sticks[side].id === t.identifier) sticks[side] = null;
    }
  }
}

function computeInput() {
  const inp = { mx: 0, my: 0, ax: 0, ay: 0, firing: false, dash: false };
  if (sticks.move) {
    const dx = sticks.move.x - sticks.move.ox;
    const dy = sticks.move.y - sticks.move.oy;
    const m = Math.hypot(dx, dy) || 1;
    const c = Math.min(m, STICK_R) / STICK_R;
    if (c > 0.15) {
      inp.mx = (dx / m) * c;
      inp.my = (dy / m) * c;
    }
  }
  if (sticks.aim) {
    const dx = sticks.aim.x - sticks.aim.ox;
    const dy = sticks.aim.y - sticks.aim.oy;
    const m = Math.hypot(dx, dy);
    if (m > STICK_R * 0.28) {
      inp.ax = dx / m;
      inp.ay = dy / m;
      inp.firing = true;
    }
  }
  // Keyboard / mouse fallback.
  let kx = 0;
  let ky = 0;
  if (keys['a'] || keys['arrowleft']) kx -= 1;
  if (keys['d'] || keys['arrowright']) kx += 1;
  if (keys['w'] || keys['arrowup']) ky -= 1;
  if (keys['s'] || keys['arrowdown']) ky += 1;
  if (kx || ky) {
    const m = Math.hypot(kx, ky);
    inp.mx = kx / m;
    inp.my = ky / m;
  }
  if (mouse.active && state.self) {
    const dx = mouse.x - wx(state.self.x);
    const dy = mouse.y - wy(state.self.y);
    const m = Math.hypot(dx, dy);
    if (m > 4) {
      inp.ax = dx / m;
      inp.ay = dy / m;
      if (mouse.down || keys[' ']) inp.firing = true;
    }
  }
  if (keys['shift'] || performance.now() < dashUntilSend) inp.dash = true;
  return inp;
}

function startInputLoop() {
  clearInterval(state.inputTimer);
  state.inputTimer = setInterval(() => {
    if (!$('#screen-game').classList.contains('active')) return;
    const inp = computeInput();
    state.input = inp;
    sendMsg({ type: 'input', mx: inp.mx, my: inp.my, ax: inp.ax, ay: inp.ay, firing: inp.firing, dash: inp.dash });
  }, 40);
}

// --- Client-side prediction of your own player ------------------------------
function clientObstacleResolve(s) {
  const R = state.cfg.playerR;
  for (const o of state.cfg.obstacles) {
    const cx = Math.max(o.x, Math.min(s.x, o.x + o.w));
    const cy = Math.max(o.y, Math.min(s.y, o.y + o.h));
    const dx = s.x - cx;
    const dy = s.y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < R) {
      if (dist === 0) {
        const l = s.x - o.x, rr = o.x + o.w - s.x, tp = s.y - o.y, bt = o.y + o.h - s.y;
        const m = Math.min(l, rr, tp, bt);
        if (m === l) s.x = o.x - R;
        else if (m === rr) s.x = o.x + o.w + R;
        else if (m === tp) s.y = o.y - R;
        else s.y = o.y + o.h + R;
      } else {
        const push = (R - dist) / dist;
        s.x += dx * push;
        s.y += dy * push;
      }
      s.vx *= 0.5;
      s.vy *= 0.5;
    }
  }
}

function predictSelf(dt) {
  const s = state.self;
  if (!s || !state.phys) return;
  const p = state.phys;
  const inp = state.input;
  const now = performance.now();

  const pressed = inp.dash && !s.prevDash;
  s.prevDash = inp.dash;
  if (pressed && now >= s.dashReadyAt) {
    let dx = inp.mx, dy = inp.my;
    if (Math.hypot(dx, dy) < 0.2) {
      dx = inp.ax;
      dy = inp.ay;
    }
    const m = Math.hypot(dx, dy);
    if (m >= 0.2) {
      s.vx = (dx / m) * p.dashSpeed;
      s.vy = (dy / m) * p.dashSpeed;
      s.dashUntil = now + p.dashTime * 1000;
      s.dashReadyAt = now + p.dashCooldown;
    }
  }

  const dashing = now < s.dashUntil;
  if (!dashing) {
    const charmed = state.selfCharm > 0 ? 0.45 : 1;
    s.vx += inp.mx * p.accel * dt * charmed;
    s.vy += inp.my * p.accel * dt * charmed;
    const f = Math.max(0, 1 - p.friction * dt);
    s.vx *= f;
    s.vy *= f;
    const sp = (state.selfFx.speed > 0 ? p.maxSpeed * p.speedMult : p.maxSpeed) * charmed;
    const v = Math.hypot(s.vx, s.vy);
    if (v > sp) {
      s.vx = (s.vx / v) * sp;
      s.vy = (s.vy / v) * sp;
    }
  }
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  const R = state.cfg.playerR;
  const { w, h } = state.cfg.arena;
  if (s.x < R) (s.x = R), (s.vx = 0);
  else if (s.x > w - R) (s.x = w - R), (s.vx = 0);
  if (s.y < R) (s.y = R), (s.vy = 0);
  else if (s.y > h - R) (s.y = h - R), (s.vy = 0);
  clientObstacleResolve(s);
}

// --- Render loop ------------------------------------------------------------
function loop() {
  state.raf = requestAnimationFrame(loop);
  if (!state.cfg || !$('#screen-game').classList.contains('active')) return;
  const now = performance.now();
  const dt = Math.min(0.05, (now - state.lastFrame) / 1000);
  state.lastFrame = now;

  if (state.latest && state.latest.phase === 'playing') predictSelf(dt);
  updateParticles(dt);
  state.shake = Math.max(0, state.shake - dt * 3);
  draw();
}

function selfRenderPos() {
  return state.self;
}
function playerRenderPos(p) {
  if (p.id === state.playerId && state.self) return state.self;
  const r = (state.opp[p.id] = state.opp[p.id] || { x: p.x, y: p.y });
  r.x += (p.x - r.x) * 0.4;
  r.y += (p.y - r.y) * 0.4;
  return r;
}

let backdrop = [];
function buildBackdrop() {
  backdrop = [];
  const kinds = ['heart', 'star', 'sparkle'];
  for (let i = 0; i < 22; i++) {
    backdrop.push({
      x: Math.random(),
      y: Math.random(),
      s: 8 + Math.random() * 10,
      ph: Math.random() * Math.PI * 2,
      kind: kinds[Math.floor(Math.random() * kinds.length)],
    });
  }
}

// A tiny 4-point sparkle (flat).
function drawSparkle(cx, cy, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.quadraticCurveTo(cx + r * 0.18, cy - r * 0.18, cx + r, cy);
  ctx.quadraticCurveTo(cx + r * 0.18, cy + r * 0.18, cx, cy + r);
  ctx.quadraticCurveTo(cx - r * 0.18, cy + r * 0.18, cx - r, cy);
  ctx.quadraticCurveTo(cx - r * 0.18, cy - r * 0.18, cx, cy - r);
  ctx.closePath();
  ctx.fill();
}

function drawKawaiiBg(t) {
  const { w, h } = state.cfg.arena;
  // Letterbox = deeper pink; arena = flat bright pink (no gradients).
  ctx.fillStyle = '#ff9ed2';
  ctx.fillRect(0, 0, view.cssW, view.cssH);
  ctx.fillStyle = KW.bg;
  ctx.fillRect(wx(0), wy(0), wsc(w), wsc(h));

  // Clip to arena for the decorations.
  ctx.save();
  ctx.beginPath();
  ctx.rect(wx(0), wy(0), wsc(w), wsc(h));
  ctx.clip();

  // Faint polka-heart tiling.
  ctx.globalAlpha = 0.18;
  for (let gy = 50; gy < h; gy += 84) {
    for (let gx = ((gy / 84) % 2 < 1 ? 44 : 86); gx < w; gx += 84) {
      drawHeartFlat(wx(gx), wy(gy), wsc(9), KW.dot, null);
    }
  }
  ctx.globalAlpha = 1;

  // Scattered cute stickers (gentle bob/twinkle).
  for (const d of backdrop) {
    const px = wx(d.x * w);
    const py = wy(d.y * h) + Math.sin(t * 1.6 + d.ph) * 4;
    const sz = wsc(d.s);
    if (d.kind === 'heart') drawHeartFlat(px, py, sz, 'rgba(255,110,180,0.4)', null);
    else if (d.kind === 'star') drawStar(px, py, sz, 'rgba(255,225,120,0.55)', null);
    else {
      const tw = 0.4 + 0.35 * (Math.sin(t * 3 + d.ph) + 1);
      drawSparkle(px, py, sz * 0.7 * tw, 'rgba(255,255,255,0.7)');
    }
  }
  ctx.restore();

  // Bold flat sticker frame (hard corners, no shadow).
  ctx.lineJoin = 'miter';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = wsc(7);
  ctx.strokeRect(wx(0), wy(0), wsc(w), wsc(h));
  ctx.strokeStyle = KW.frame;
  ctx.lineWidth = wsc(3);
  ctx.strokeRect(wx(0), wy(0), wsc(w), wsc(h));
}

function drawObstacle(o) {
  const x = wx(o.x);
  const y = wy(o.y);
  const w = wsc(o.w);
  const h = wsc(o.h);
  // Flat two-tone block with a bold outline (sticker look, hard corners).
  ctx.fillStyle = KW.obFill;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = KW.obTop;
  ctx.fillRect(x, y, w, Math.max(3, h * 0.22));
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = Math.max(2, wsc(3));
  ctx.strokeRect(x, y, w, h);
  // A little heart sticker in the middle.
  drawHeartFlat(x + w / 2, y + h / 2, Math.min(w, h) * 0.22, '#ffffff', null);
}

function draw() {
  const t = performance.now() / 1000;
  ctx.clearRect(0, 0, view.cssW, view.cssH);

  ctx.save();
  if (state.shake > 0) {
    const s = state.shake * 10;
    ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
  }

  drawKawaiiBg(t);
  for (const o of state.cfg.obstacles) drawObstacle(o);

  const s = state.latest;
  if (s) {
    drawPowerups(s.powerups);
    drawTrails();
    for (const b of s.bullets) drawHeartFlat(wx(b.x), wy(b.y), wsc(b.r) * 1.8, COLORS[b.c] || '#fff', OUTLINE);
    drawParticlesBehind();
    drawAimReticle(s);
    for (const p of s.players) drawPlayer(p);
    drawEmoteBubbles(s);
    drawParticlesFront();
    drawHud(s);
  }
  ctx.restore();
}

function drawEmoteBubbles(s) {
  const now = performance.now();
  for (const p of s.players) {
    const em = activeEmotes[p.id];
    if (!em) continue;
    const age = (now - em.born) / 1000;
    if (age > 1.6) {
      delete activeEmotes[p.id];
      continue;
    }
    const r = playerRenderPos(p);
    const rad = wsc(state.cfg.playerR);
    const pop = age < 0.15 ? age / 0.15 : 1; // pop-in
    const fade = age > 1.2 ? 1 - (age - 1.2) / 0.4 : 1;
    const bx = wx(r.x);
    const by = wy(r.y) - rad - wsc(30) - Math.min(age, 0.4) * 12;
    const bw = wsc(34) * pop;
    ctx.save();
    ctx.globalAlpha = fade;
    // Bubble.
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = Math.max(2, wsc(2.5));
    ctx.beginPath();
    ctx.arc(bx, by, bw / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Tail.
    ctx.beginPath();
    ctx.moveTo(bx - bw * 0.16, by + bw * 0.32);
    ctx.lineTo(bx, by + bw * 0.62);
    ctx.lineTo(bx + bw * 0.16, by + bw * 0.32);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.font = `${Math.round(bw * 0.62)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(em.glyph, bx, by + 1);
    ctx.restore();
  }
}

function drawPowerups(pus) {
  const t = performance.now() / 1000;
  for (const pu of pus) {
    const info = POWERUPS[pu.t] || { emoji: '❔', ring: '#fff' };
    const cx = wx(pu.x);
    const cy = wy(pu.y) + Math.sin(t * 3 + pu.id) * 3; // gentle bob
    const rad = wsc(17);
    // Flat sticker disc with a bold outline.
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = info.ring;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = Math.max(2, wsc(2.5));
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();
    // Little sparkle accent.
    drawSparkle(cx + rad * 0.7, cy - rad * 0.7, wsc(4) * (0.7 + 0.3 * Math.sin(t * 5 + pu.id)), '#fff');
    ctx.font = `${Math.round(rad * 1.25)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(info.emoji, cx, cy + 1);
  }
}

function drawTrails() {
  for (const id of Object.keys(state.trails)) {
    const t = state.trails[id];
    if (t.length < 2) continue;
    for (let i = 0; i < t.length - 1; i++) {
      const a = i / t.length;
      ctx.strokeStyle = `rgba(255,255,255,${0.06 + a * 0.12})`;
      ctx.lineWidth = wsc(3) * (a + 0.3);
      ctx.beginPath();
      ctx.moveTo(wx(t[i].x), wy(t[i].y));
      ctx.lineTo(wx(t[i + 1].x), wy(t[i + 1].y));
      ctx.stroke();
    }
  }
}

function drawAimReticle(s) {
  const me = s.players.find((p) => p.id === state.playerId);
  if (!me || me.hp <= 0 || !state.self) return;
  const inp = state.input;
  const amag = Math.hypot(inp.ax, inp.ay);
  if (amag < 0.2) return;
  const cx = wx(state.self.x);
  const cy = wy(state.self.y);
  const len = wsc(140);
  ctx.save();
  ctx.setLineDash([6, 8]);
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(Math.atan2(inp.ay, inp.ax)) * wsc(24), cy + Math.sin(Math.atan2(inp.ay, inp.ax)) * wsc(24));
  ctx.lineTo(cx + (inp.ax / amag) * len, cy + (inp.ay / amag) * len);
  ctx.stroke();
  ctx.restore();
}

function drawPlayer(p) {
  const r = playerRenderPos(p);
  const cx = wx(r.x);
  const cy = wy(r.y);
  const rad = wsc(state.cfg.playerR);
  const color = COLORS[p.spawn];
  const dead = p.hp <= 0;
  const t = performance.now() / 1000;
  const charmed = (p.charmed || 0) > 0;

  ctx.globalAlpha = dead ? 0.25 : 1;
  const ol = Math.max(2.5, wsc(3.5)); // sticker outline width

  // Speed aura (flat dashed ring).
  if (p.fx.speed > 0) {
    ctx.save();
    ctx.setLineDash([wsc(5), wsc(5)]);
    ctx.beginPath();
    ctx.arc(cx, cy, rad + wsc(8) + Math.sin(t * 10) * 2, 0, Math.PI * 2);
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = wsc(3);
    ctx.stroke();
    ctx.restore();
  }

  // Cosmetic back layer (e.g. angel wings) sits behind the body.
  drawCosmeticBack(p.cosmetic, cx, cy, rad, t);

  // "Big hearts" glow → flat outer ring.
  if (p.fx.big > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, rad + wsc(5), 0, Math.PI * 2);
    ctx.strokeStyle = '#ff8fb1';
    ctx.lineWidth = wsc(3);
    ctx.stroke();
  }

  // Aim pointer: a chunky flat nub poking out in the aim direction.
  const tipx = cx + Math.cos(p.angle) * rad;
  const tipy = cy + Math.sin(p.angle) * rad;
  const perp = p.angle + Math.PI / 2;
  const pw = rad * 0.42;
  ctx.beginPath();
  ctx.moveTo(tipx + Math.cos(perp) * pw, tipy + Math.sin(perp) * pw);
  ctx.lineTo(cx + Math.cos(p.angle) * (rad + wsc(11)), cy + Math.sin(p.angle) * (rad + wsc(11)));
  ctx.lineTo(tipx - Math.cos(perp) * pw, tipy - Math.sin(perp) * pw);
  ctx.closePath();
  ctx.fillStyle = shade(color, -0.15);
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = ol;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Body: flat disc with a bold sticker outline.
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = ol;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();

  // --- Cute face ---
  const eyeY = cy - rad * 0.04;
  const eyeDx = rad * 0.36;
  // Blush.
  ctx.fillStyle = 'rgba(255,120,160,0.7)';
  ctx.beginPath();
  ctx.arc(cx - rad * 0.5, cy + rad * 0.28, rad * 0.16, 0, Math.PI * 2);
  ctx.arc(cx + rad * 0.5, cy + rad * 0.28, rad * 0.16, 0, Math.PI * 2);
  ctx.fill();
  if (charmed) {
    drawHeartFlat(cx - eyeDx, eyeY, rad * 0.4, '#ff2d6d', null);
    drawHeartFlat(cx + eyeDx, eyeY, rad * 0.4, '#ff2d6d', null);
  } else {
    ctx.fillStyle = OUTLINE;
    ctx.beginPath();
    ctx.ellipse(cx - eyeDx, eyeY, rad * 0.13, rad * 0.17, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + eyeDx, eyeY, rad * 0.13, rad * 0.17, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx - eyeDx + rad * 0.05, eyeY - rad * 0.06, rad * 0.05, 0, Math.PI * 2);
    ctx.arc(cx + eyeDx + rad * 0.05, eyeY - rad * 0.06, rad * 0.05, 0, Math.PI * 2);
    ctx.fill();
  }
  // Tiny mouth.
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = Math.max(1.4, wsc(1.8));
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy + rad * 0.3, rad * 0.16, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  // Shield bubble.
  if (p.fx.shield > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, rad + wsc(10), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(120,220,255,${0.16 + Math.sin(t * 8) * 0.05})`;
    ctx.fill();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = wsc(2.5);
    ctx.stroke();
  }

  // Cosmetic front layer (crown, tiara, hat, ...).
  drawCosmeticFront(p.cosmetic, cx, cy, rad, color, t);

  // Charmed: little hearts orbiting the head.
  if (charmed) {
    for (let i = 0; i < 3; i++) {
      const a = t * 3 + (i / 3) * Math.PI * 2;
      drawHeartFlat(cx + Math.cos(a) * (rad + 12), cy - rad - 8 + Math.sin(a) * 4, wsc(6), '#ff4d6d', '#fff');
    }
  }

  // "You" ring.
  if (p.id === state.playerId) {
    ctx.strokeStyle = '#ffd76a';
    ctx.lineWidth = wsc(3);
    ctx.beginPath();
    ctx.arc(cx, cy, rad + wsc(6), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Active-effect emoji stack above the player.
  const active = [];
  if (p.fx.rapid > 0) active.push('⚡');
  if (p.fx.spread > 0) active.push('🔱');
  if (p.fx.big > 0) active.push('💥');
  if (p.fx.speed > 0) active.push('👟');
  if (p.fx.shield > 0) active.push('🛡️');
  if (p.fx.cupid > 0) active.push('💘');
  if (p.fx.charm > 0) active.push('💋');
  if (active.length) {
    ctx.font = `${Math.round(wsc(14))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(active.join(''), cx, cy - rad - 26);
  }

  // Health bar (flat, outlined, animated width).
  const bw = rad * 2.6;
  const bh = Math.max(6, wsc(7));
  const bx = cx - bw / 2;
  const by = cy - rad - wsc(16);
  r._hp = r._hp == null ? p.hp : r._hp + (p.hp - r._hp) * 0.2;
  ctx.fillStyle = '#fff';
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = r._hp > 40 ? '#4ade80' : '#ff5c8a';
  ctx.fillRect(bx, by, (bw * Math.max(0, r._hp)) / state.cfg.maxHp, bh);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = Math.max(1.5, wsc(2));
  ctx.strokeRect(bx, by, bw, bh);
}

// --- Cosmetics --------------------------------------------------------------
function drawStar(cx, cy, r, color, outline) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    ctx[i === 0 ? 'moveTo' : 'lineTo'](cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  if (outline) {
    ctx.strokeStyle = outline;
    ctx.lineWidth = Math.max(1.5, wsc(2));
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

function drawCosmeticBack(id, cx, cy, rad, t) {
  if (id !== 'angel') return;
  const flap = Math.sin(t * 6) * 0.12;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.shadowColor = 'rgba(255,255,255,0.5)';
  ctx.shadowBlur = 8;
  for (const dir of [-1, 1]) {
    ctx.save();
    ctx.scale(dir, 1);
    ctx.rotate(-0.35 + flap);
    ctx.beginPath();
    ctx.moveTo(rad * 0.4, 0);
    ctx.quadraticCurveTo(rad * 1.6, -rad * 1.1, rad * 1.95, -rad * 0.1);
    ctx.quadraticCurveTo(rad * 1.4, rad * 0.05, rad * 1.7, rad * 0.5);
    ctx.quadraticCurveTo(rad * 1.15, rad * 0.35, rad * 1.35, rad * 0.85);
    ctx.quadraticCurveTo(rad * 0.8, rad * 0.55, rad * 0.4, rad * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawCosmeticFront(id, cx, cy, rad, color, t) {
  const topY = cy - rad;
  ctx.save();
  ctx.lineJoin = 'round';
  if (id === 'crown') {
    const w = rad * 1.5, h = rad * 0.85, x0 = cx - w / 2, base = topY + rad * 0.18;
    const g = ctx.createLinearGradient(0, base - h, 0, base);
    g.addColorStop(0, '#ffe680');
    g.addColorStop(1, '#f2b705');
    ctx.fillStyle = g;
    ctx.strokeStyle = '#b8860b';
    ctx.lineWidth = Math.max(1, wsc(1.4));
    ctx.beginPath();
    ctx.moveTo(x0, base);
    ctx.lineTo(x0, base - h * 0.5);
    ctx.lineTo(x0 + w * 0.25, base - h * 0.1);
    ctx.lineTo(cx, base - h);
    ctx.lineTo(x0 + w * 0.75, base - h * 0.1);
    ctx.lineTo(x0 + w, base - h * 0.5);
    ctx.lineTo(x0 + w, base);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ff4d6d';
    for (const gx of [x0 + w * 0.25, cx, x0 + w * 0.75]) {
      ctx.beginPath();
      ctx.arc(gx, base - h * 0.1, wsc(2.2), 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (id === 'tiara') {
    const w = rad * 1.25, base = topY + rad * 0.12, h = rad * 0.55, x0 = cx - w / 2;
    ctx.strokeStyle = '#ffd1e8';
    ctx.lineWidth = Math.max(2, wsc(3));
    ctx.beginPath();
    ctx.moveTo(x0, base);
    ctx.quadraticCurveTo(cx, base - h * 1.4, x0 + w, base);
    ctx.stroke();
    ctx.fillStyle = '#ff69b4';
    ctx.beginPath();
    ctx.arc(cx, base - h * 0.8, wsc(3), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x0 + w * 0.5 - w * 0.3, base - h * 0.2, wsc(1.6), 0, Math.PI * 2);
    ctx.arc(x0 + w * 0.5 + w * 0.3, base - h * 0.2, wsc(1.6), 0, Math.PI * 2);
    ctx.fill();
  } else if (id === 'angel') {
    ctx.strokeStyle = '#ffe680';
    ctx.lineWidth = Math.max(2, wsc(3));
    ctx.shadowColor = '#ffe680';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.ellipse(cx, topY - rad * 0.55, rad * 0.6, rad * 0.22, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (id === 'horns') {
    ctx.fillStyle = '#e0345a';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + dir * rad * 0.55, topY + rad * 0.2);
      ctx.quadraticCurveTo(cx + dir * rad * 0.98, topY - rad * 0.2, cx + dir * rad * 0.68, topY - rad * 0.62);
      ctx.quadraticCurveTo(cx + dir * rad * 0.5, topY - rad * 0.1, cx + dir * rad * 0.32, topY + rad * 0.12);
      ctx.closePath();
      ctx.fill();
    }
  } else if (id === 'bunny') {
    for (const dir of [-1, 1]) {
      ctx.save();
      ctx.translate(cx + dir * rad * 0.32, topY + rad * 0.1);
      ctx.rotate(dir * 0.22);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(0, -rad * 0.7, rad * 0.22, rad * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffb6c1';
      ctx.beginPath();
      ctx.ellipse(0, -rad * 0.7, rad * 0.1, rad * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  } else if (id === 'tophat') {
    const w = rad * 1.5, brimH = wsc(4), hatH = rad * 0.95, base = topY + rad * 0.12;
    ctx.fillStyle = '#26123a';
    ctx.fillRect(cx - w / 2, base - brimH, w, brimH);
    ctx.fillRect(cx - w * 0.3, base - hatH, w * 0.6, hatH - brimH + 2);
    ctx.fillStyle = '#ff5c8a';
    ctx.fillRect(cx - w * 0.3, base - brimH - wsc(4), w * 0.6, wsc(4));
  } else if (id === 'collar') {
    const by = cy + rad * 0.78;
    const s = rad * 0.5;
    ctx.fillStyle = '#ff2d6d';
    ctx.beginPath();
    ctx.moveTo(cx, by);
    ctx.lineTo(cx - s, by - s * 0.55);
    ctx.lineTo(cx - s, by + s * 0.55);
    ctx.closePath();
    ctx.moveTo(cx, by);
    ctx.lineTo(cx + s, by - s * 0.55);
    ctx.lineTo(cx + s, by + s * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#c81d4f';
    ctx.beginPath();
    ctx.arc(cx, by, wsc(3.2), 0, Math.PI * 2);
    ctx.fill();
  } else if (id === 'moon') {
    const mx = cx, my = topY - rad * 0.5, mr = rad * 0.5;
    ctx.fillStyle = '#ffe680';
    ctx.shadowColor = '#ffe680';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(mx, my, mr, Math.PI * 0.35, Math.PI * 1.65, false);
    ctx.arc(mx + mr * 0.5, my, mr * 0.9, Math.PI * 1.5, Math.PI * 0.5, true);
    ctx.closePath();
    ctx.fill();
  } else if (id === 'star') {
    drawStar(cx, topY - rad * 0.5, rad * 0.5, '#ffe680');
  }
  ctx.restore();
}

function drawHud(s) {
  const need = state.cfg.roundsToWin;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const meFirst = s.players.find((p) => p.id === state.playerId)?.spawn === 0;
  const ordered = meFirst ? s.players : [...s.players].slice().reverse();
  const you = ordered[0];
  const opp = ordered[1];
  const y = view.oy + 18;
  drawPips(view.ox + 14, y, need, you.wins, COLORS[you.spawn], 'left', you.id === state.playerId ? 'DU' : '');
  drawPips(view.ox + wsc(state.cfg.arena.w) - 14, y, need, opp.wins, COLORS[opp.spawn], 'right', '');

  // Dash cooldown indicator under your player.
  const me = s.players.find((p) => p.id === state.playerId);
  if (me && me.hp > 0 && state.self) {
    const cx = wx(state.self.x);
    const cy = wy(state.self.y) + wsc(state.cfg.playerR) + 12;
    const ready = me.dashCd <= 0;
    ctx.beginPath();
    ctx.fillStyle = ready ? 'rgba(255,215,106,0.9)' : 'rgba(255,255,255,0.25)';
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  if (s.phase === 'countdown') {
    const cx = view.ox + wsc(state.cfg.arena.w) / 2;
    const cy = view.oy + wsc(state.cfg.arena.h) / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(wx(0), wy(0), wsc(state.cfg.arena.w), wsc(state.cfg.arena.h));
    ctx.fillStyle = '#ffd76a';
    ctx.font = '800 90px system-ui, sans-serif';
    ctx.fillText(s.count > 0 ? String(s.count) : 'LOS!', cx, cy);
    ctx.fillStyle = '#fff0f5';
    ctx.font = '700 22px system-ui, sans-serif';
    ctx.fillText(`Runde ${s.round}`, cx, cy - 90);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = 'italic 600 16px Georgia, serif';
    ctx.fillText(LOVE_NOTES[(s.round - 1) % LOVE_NOTES.length], cx, cy + 80);
  }
}

function drawPips(x, y, need, wins, color, align, label) {
  const gap = 20;
  for (let i = 0; i < need; i++) {
    const px = align === 'left' ? x + 8 + i * gap : x - 8 - i * gap;
    ctx.beginPath();
    ctx.arc(px, y, 7, 0, Math.PI * 2);
    if (i < wins) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  if (label) {
    ctx.fillStyle = '#ffd76a';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = align;
    ctx.fillText(label, x, y + 18);
    ctx.textAlign = 'center';
  }
}

// --- Particles --------------------------------------------------------------
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.92;
    p.vy *= 0.92;
    if (p.kind === 'heart') p.vy += 120 * dt;
  }
}
function drawParticlesBehind() {
  for (const p of particles) if (p.kind === 'puff') drawParticle(p);
}
function drawParticlesFront() {
  for (const p of particles) if (p.kind !== 'puff') drawParticle(p);
}
function drawParticle(p) {
  const a = Math.max(0, p.life / p.max);
  if (p.kind === 'float') {
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    ctx.font = `700 ${Math.round(wsc(15))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(p.text, wx(p.x), wy(p.y));
    ctx.globalAlpha = 1;
    return;
  }
  if (p.kind === 'heart') {
    drawHeart(wx(p.x), wy(p.y), wsc(p.r) * a * 1.6 + 2, applyAlpha(p.color, a));
    return;
  }
  ctx.globalAlpha = a;
  ctx.beginPath();
  ctx.fillStyle = p.color;
  ctx.arc(wx(p.x), wy(p.y), wsc(p.r) * (p.kind === 'puff' ? 1 + (1 - a) : a) + 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = amt < 0 ? 1 + amt : 1;
  const add = amt < 0 ? 0 : amt * 255;
  r = Math.round(r * f + add);
  g = Math.round(g * f + add);
  b = Math.round(b * f + add);
  return `rgb(${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)})`;
}

function applyAlpha(color, a) {
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return color;
}

// Flat heart with an optional bold sticker outline.
function drawHeartFlat(cx, cy, size, color, outline) {
  const k = size / 14;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(k, k);
  ctx.beginPath();
  ctx.moveTo(0, 5);
  ctx.bezierCurveTo(-2, 1, -9, -3, -9, -8);
  ctx.bezierCurveTo(-9, -13, -4, -13, 0, -8);
  ctx.bezierCurveTo(4, -13, 9, -13, 9, -8);
  ctx.bezierCurveTo(9, -3, 2, 1, 0, 5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  if (outline) {
    ctx.strokeStyle = outline;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  ctx.restore();
}
function drawHeart(cx, cy, size, color) {
  drawHeartFlat(cx, cy, size, color, null);
}

// --- Game over (messages vary every time) -----------------------------------
const WIN_TEXTS = [
  (w, l) => `Sieg für <b>${w}</b>! (๑>ᴗ<๑)♡<br />Lehn dich zurück — <b>${l}</b> schuldet dir eine sehr wichtige Frage…`,
  (w, l) => `<b>${w}</b> hat gewonnen! ٩(♡ε♡)۶<br />Und jetzt… macht <b>${l}</b> dir einen Antrag~ ♡`,
  (w, l) => `Zu süß, zu stark: <b>${w}</b> siegt! ✧<br />Zeit, dass <b>${l}</b> auf die Knie geht (˶ᵔ ᵕ ᵔ˶)`,
  (w, l) => `Gewonnen, <b>${w}</b>! ♡( ◡‿◡ )<br /><b>${l}</b> ist jetzt dran mit der großen Frage…`,
];
const LOSE_TEXTS = [
  (l, w) => `Besiegt, <b>${l}</b>! (｡•́︿•̀｡)<br />Du weißt, was das heißt… mach <b>${w}</b> einen Antrag ♡`,
  (l, w) => `Ohhh nein, <b>${l}</b> verliert~ (>﹏<)<br />Auf die Knie mit dir — <b>${w}</b> wartet! 💍`,
  (l, w) => `<b>${l}</b>, du hast verloren (๑•́ ₃ •̀๑)<br />Aber Herzchen: jetzt kommt DEIN großer Moment für <b>${w}</b>~`,
  (l, w) => `Aus, vorbei, verknallt-verloren, <b>${l}</b>! ⋆｡°✩<br />Zeit für den Antrag an <b>${w}</b> ♡`,
];
const SCRIPTS = [
  (name) => `${name}, du hast mich besiegt — aber mein Herz hast du schon längst. Willst du mich heiraten? ♡`,
  (name) => `Ich würd jedes Duell verlieren, solang ich für immer bei dir sein darf. ${name}, heiratest du mich? (๑>ᴗ<๑)`,
  (name) => `Nun, ${name}, du gewinnst — und ich gewinne jeden Tag mit dir. Willst du mich heiraten? ٩(♡ε♡)۶`,
  (name) => `${name}, mein Herz macht seit dir nur noch Doki-Doki. Willst du für immer meins sein? Heirat mich! ♡`,
  (name) => `Verloren hab ich das Spiel, aber gewonnen hab ich dich. ${name}, willst du mich heiraten? ⋆˚✩`,
];
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];

function renderGameOver(msg) {
  clearInterval(state.inputTimer);
  sticks.move = sticks.aim = null;
  const w = escapeHtml(msg.winner.name);
  const l = escapeHtml(msg.loser.name);
  if (msg.youWon) {
    $('#won-text').innerHTML = pickOne(WIN_TEXTS)(w, l);
    show('screen-won');
    launchConfetti(2500);
  } else {
    $('#lost-text').innerHTML = pickOne(LOSE_TEXTS)(l, w);
    $('#proposal-script').textContent = pickOne(SCRIPTS)(msg.winner.name || 'mein Schatz');
    $('#btn-propose').classList.remove('hidden');
    $('#lost-waiting').classList.add('hidden');
    show('screen-lost');
  }
}

function renderProposalMade(msg) {
  if (msg.proposee === state.playerId) {
    launchConfetti(1500);
    show('screen-proposal');
  }
}
function renderCelebration() {
  $('#celebrate-sub').textContent = 'Auf die Ewigkeit 🥂💍';
  show('screen-celebrate');
  spawnHearts();
  launchConfetti(6000);
}

// --- Confetti & hearts ------------------------------------------------------
let confettiTimer = null;
function launchConfetti(durationMs) {
  const box = $('#confetti');
  const colors = ['#ff5c8a', '#ffd76a', '#4ade80', '#c084fc', '#ffffff'];
  const end = Date.now() + durationMs;
  clearInterval(confettiTimer);
  confettiTimer = setInterval(() => {
    if (Date.now() > end) {
      clearInterval(confettiTimer);
      return;
    }
    for (let i = 0; i < 6; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + '%';
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.animationDuration = 2 + Math.random() * 2 + 's';
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      box.appendChild(piece);
      setTimeout(() => piece.remove(), 4000);
    }
  }, 120);
}
function stopConfetti() {
  clearInterval(confettiTimer);
  $('#confetti').innerHTML = '';
}
function spawnHearts() {
  const emojis = ['❤️', '💕', '💗', '💖', '💘'];
  for (let i = 0; i < 18; i++) {
    const h = document.createElement('div');
    h.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    h.style.position = 'fixed';
    h.style.left = Math.random() * 100 + 'vw';
    h.style.bottom = '-40px';
    h.style.fontSize = 1 + Math.random() * 1.5 + 'rem';
    h.style.pointerEvents = 'none';
    h.style.zIndex = 60;
    h.style.animation = `fall ${3 + Math.random() * 3}s linear forwards`;
    h.style.transform = 'rotate(180deg)';
    document.body.appendChild(h);
    setTimeout(() => h.remove(), 6500);
  }
}

// --- Helpers ----------------------------------------------------------------
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
