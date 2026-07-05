// ---------------------------------------------------------------------------
//  Das Liebes-Duell — client (prediction + powerups + juice)
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const COLORS = ['#ff5c8a', '#5ab8ff']; // player spawn 0 / 1
const COLORS_SOFT = ['rgba(255,92,138,', 'rgba(90,184,255,'];

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

// Emote bar — blow your partner a kiss mid-duel.
const EMOTE_GLYPH = { kiss: '💋', heart: '❤️', wink: '😘', rose: '🌹' };
$$('.emote-btn').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    sendMsg({ type: 'emote', kind: b.dataset.kind });
  });
});
function showEmote(msg) {
  const mine = msg.from === state.playerId;
  const glyph = EMOTE_GLYPH[msg.kind] || '❤️';
  const el = document.createElement('div');
  el.className = 'emote-fly';
  el.textContent = glyph;
  el.style.left = 8 + Math.random() * 74 + 'vw';
  // Yours rise from the bottom, your partner's drift from the top.
  el.style.setProperty('--from', mine ? '100vh' : '-12vh');
  el.style.setProperty('--to', mine ? '-12vh' : '100vh');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
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

function renderLobby(msg) {
  state.code = msg.code;
  $('#lobby-code').textContent = msg.code;
  const list = $('#player-list');
  list.innerHTML = '';
  msg.players.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot"></span><span>${escapeHtml(p.name)}${p.id === state.playerId ? ' (du)' : ''}</span>`;
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
  for (let i = 0; i < 26; i++) {
    backdrop.push({
      x: Math.random(),
      y: Math.random(),
      s: 0.4 + Math.random() * 1.1,
      sp: 0.008 + Math.random() * 0.02,
      ph: Math.random() * Math.PI * 2,
      heart: Math.random() < 0.5,
    });
  }
}

function drawSky(t) {
  const g = ctx.createLinearGradient(0, 0, 0, view.cssH);
  g.addColorStop(0, '#3a1b4e');
  g.addColorStop(0.45, '#7a2f5e');
  g.addColorStop(0.8, '#c94f7c');
  g.addColorStop(1, '#ff9a8b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, view.cssW, view.cssH);

  // Drifting hearts + twinkling sparkles.
  for (const d of backdrop) {
    const y = (d.y - ((t * d.sp) % 1) + 1) % 1;
    const px = d.x * view.cssW + Math.sin(t + d.ph) * 12;
    const py = y * view.cssH;
    const tw = 0.25 + 0.2 * (Math.sin(t * 2 + d.ph) + 1);
    if (d.heart) {
      drawHeart(px, py, 6 * d.s, `rgba(255,220,235,${tw * 0.7})`);
    } else {
      ctx.globalAlpha = tw;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(px, py, d.s * 1.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawFlowerBed(o) {
  const x = wx(o.x);
  const y = wy(o.y);
  const w = wsc(o.w);
  const h = wsc(o.h);
  const r = Math.min(w, h) * 0.28;
  // Soft shadow.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 5;
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, '#5fbf7a');
  g.addColorStop(1, '#2f8f57');
  ctx.fillStyle = g;
  roundRect(x, y, w, h, r);
  ctx.fill();
  ctx.restore();
  // Little flowers scattered on top (deterministic per obstacle).
  const flowerColors = ['#ff6f91', '#ffd76a', '#ff9a8b', '#ffffff', '#ff5c8a'];
  let seed = Math.round(o.x * 13 + o.y * 7);
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const count = Math.max(3, Math.round((o.w * o.h) / 1400));
  for (let i = 0; i < count; i++) {
    const fx = x + 10 + rnd() * (w - 20);
    const fy = y + 10 + rnd() * (h - 20);
    const fr = wsc(4 + rnd() * 3);
    const col = flowerColors[Math.floor(rnd() * flowerColors.length)];
    ctx.fillStyle = col;
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(fx + Math.cos(a) * fr, fy + Math.sin(a) * fr, fr * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#ffe08a';
    ctx.beginPath();
    ctx.arc(fx, fy, fr * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function draw() {
  const { w, h } = state.cfg.arena;
  const t = performance.now() / 1000;
  ctx.clearRect(0, 0, view.cssW, view.cssH);
  drawSky(t);

  ctx.save();
  if (state.shake > 0) {
    const s = state.shake * 10;
    ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
  }

  // Garden mat (the play area).
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 30;
  const mat = ctx.createLinearGradient(0, wy(0), 0, wy(h));
  mat.addColorStop(0, '#ffdbe6');
  mat.addColorStop(1, '#ffc2d6');
  ctx.fillStyle = mat;
  roundRect(wx(0), wy(0), wsc(w), wsc(h), wsc(24));
  ctx.fill();
  ctx.restore();
  // Soft heart lattice on the mat.
  ctx.save();
  roundRect(wx(0), wy(0), wsc(w), wsc(h), wsc(24));
  ctx.clip();
  ctx.globalAlpha = 0.5;
  for (let gy = 40; gy < h; gy += 80) {
    for (let gx = ((gy / 80) % 2 === 0 ? 40 : 80); gx < w; gx += 80) {
      drawHeart(wx(gx), wy(gy), wsc(7), 'rgba(255,140,177,0.35)');
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  roundRect(wx(0), wy(0), wsc(w), wsc(h), wsc(24));
  ctx.stroke();

  // Obstacles as flower beds.
  for (const o of state.cfg.obstacles) drawFlowerBed(o);

  const s = state.latest;
  if (s) {
    drawPowerups(s.powerups);
    drawTrails();
    for (const b of s.bullets) drawHeart(wx(b.x), wy(b.y), wsc(b.r) * 1.7, COLORS[b.c] || '#fff');
    drawParticlesBehind();
    drawAimReticle(s);
    for (const p of s.players) drawPlayer(p);
    drawParticlesFront();
    drawHud(s);
  }
  ctx.restore();
}

function drawPowerups(pus) {
  const t = performance.now() / 1000;
  for (const pu of pus) {
    const info = POWERUPS[pu.t] || { emoji: '❔', ring: '#fff' };
    const cx = wx(pu.x);
    const cy = wy(pu.y);
    const pulse = 1 + Math.sin(t * 4 + pu.id) * 0.08;
    const rad = wsc(16) * pulse;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rad + 6, 0, Math.PI * 2);
    ctx.fillStyle = info.ring + '22';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,10,35,0.85)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = info.ring;
    ctx.shadowColor = info.ring;
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.restore();
    ctx.font = `${Math.round(rad * 1.3)}px system-ui, sans-serif`;
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

  // Speed aura.
  if (p.fx.speed > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, rad + 9 + Math.sin(t * 10) * 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(52,211,153,0.55)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Flapping wings (behind the body).
  const flap = Math.sin(t * 14 + p.spawn) * 0.35;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  for (const dir of [-1, 1]) {
    ctx.save();
    ctx.scale(dir, 1);
    ctx.rotate(-0.5 + flap);
    ctx.beginPath();
    ctx.moveTo(rad * 0.5, -rad * 0.2);
    ctx.quadraticCurveTo(rad * 1.9, -rad * 1.2, rad * 1.7, rad * 0.2);
    ctx.quadraticCurveTo(rad * 1.3, rad * 0.5, rad * 0.5, rad * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  // Body (glossy).
  ctx.save();
  if (p.fx.big > 0) {
    ctx.shadowColor = '#fb7185';
    ctx.shadowBlur = 24;
  }
  const bg = ctx.createRadialGradient(cx - rad * 0.35, cy - rad * 0.4, rad * 0.2, cx, cy, rad);
  bg.addColorStop(0, '#ffffff');
  bg.addColorStop(0.35, color);
  bg.addColorStop(1, shade(color, -0.25));
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Face: blush + eyes + smile (upright, not rotated).
  const eyeY = cy - rad * 0.12;
  const eyeDx = rad * 0.4;
  // Blush.
  ctx.fillStyle = 'rgba(255,120,150,0.55)';
  ctx.beginPath();
  ctx.arc(cx - rad * 0.55, cy + rad * 0.15, rad * 0.22, 0, Math.PI * 2);
  ctx.arc(cx + rad * 0.55, cy + rad * 0.15, rad * 0.22, 0, Math.PI * 2);
  ctx.fill();
  if (charmed) {
    // Hearts-in-eyes when lovestruck.
    drawHeart(cx - eyeDx, eyeY, rad * 0.42, '#ff2d6d');
    drawHeart(cx + eyeDx, eyeY, rad * 0.42, '#ff2d6d');
  } else {
    ctx.fillStyle = '#2a1630';
    ctx.beginPath();
    ctx.arc(cx - eyeDx, eyeY, rad * 0.14, 0, Math.PI * 2);
    ctx.arc(cx + eyeDx, eyeY, rad * 0.14, 0, Math.PI * 2);
    ctx.fill();
    // Eye sparkle.
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx - eyeDx + rad * 0.05, eyeY - rad * 0.05, rad * 0.05, 0, Math.PI * 2);
    ctx.arc(cx + eyeDx + rad * 0.05, eyeY - rad * 0.05, rad * 0.05, 0, Math.PI * 2);
    ctx.fill();
  }
  // Smile.
  ctx.strokeStyle = '#2a1630';
  ctx.lineWidth = Math.max(1.5, wsc(2));
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy + rad * 0.28, rad * 0.32, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  // Aim pointer: a little heart at the rim in the aim direction.
  const px = cx + Math.cos(p.angle) * (rad + wsc(9));
  const py = cy + Math.sin(p.angle) * (rad + wsc(9));
  drawHeart(px, py, wsc(9), '#fff');

  // Shield bubble.
  if (p.fx.shield > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, rad + 10, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(56,189,248,${0.14 + Math.sin(t * 8) * 0.05})`;
    ctx.fill();
    ctx.strokeStyle = '#7dd3fc';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Charmed: little hearts orbiting the head.
  if (charmed) {
    for (let i = 0; i < 3; i++) {
      const a = t * 3 + (i / 3) * Math.PI * 2;
      drawHeart(cx + Math.cos(a) * (rad + 10), cy - rad - 6 + Math.sin(a) * 4, wsc(6), '#ff4d6d');
    }
  }

  // "You" ring.
  if (p.id === state.playerId) {
    ctx.strokeStyle = '#ffd76a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, rad + 6, 0, Math.PI * 2);
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

  // Health bar (animated width).
  const bw = rad * 2.4;
  const bh = 6;
  const bx = cx - bw / 2;
  const by = cy - rad - 15;
  r._hp = r._hp == null ? p.hp : r._hp + (p.hp - r._hp) * 0.2;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = r._hp > 40 ? '#4ade80' : '#fb7185';
  ctx.fillRect(bx, by, (bw * Math.max(0, r._hp)) / state.cfg.maxHp, bh);
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

function drawHeart(cx, cy, size, color) {
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
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.fill();
  ctx.restore();
}

// --- Game over --------------------------------------------------------------
function renderGameOver(msg) {
  clearInterval(state.inputTimer);
  sticks.move = sticks.aim = null;
  if (msg.youWon) {
    $('#won-text').innerHTML = `Du hast das Duell gewonnen, <b>${escapeHtml(msg.winner.name)}</b>! 🏆<br />Lehn dich zurück — <b>${escapeHtml(msg.loser.name)}</b> schuldet dir eine sehr wichtige Frage…`;
    show('screen-won');
    launchConfetti(2500);
  } else {
    $('#lost-text').innerHTML = `Du wurdest besiegt, <b>${escapeHtml(msg.loser.name)}</b>! 😅<br />Du weißt, was das bedeutet. Zeit, <b>${escapeHtml(msg.winner.name)}</b> einen Antrag zu machen.`;
    $('#proposal-script').textContent = pickScript(msg.winner.name);
    $('#btn-propose').classList.remove('hidden');
    $('#lost-waiting').classList.add('hidden');
    show('screen-lost');
  }
}

const SCRIPTS = [
  (name) => `${name}, du hast mich fair und ehrlich besiegt — aber die Wahrheit ist: Mein Herz gehört dir schon lange. Willst du mich heiraten?`,
  (name) => `Ich würde jedes Duell für den Rest meines Lebens verlieren, wenn ich dafür für immer an deiner Seite sein darf. ${name}, willst du mich heiraten?`,
  (name) => `Nun, ${name}, du gewinnst — und ehrlich gesagt gewinne ich auch, jeden einzelnen Tag mit dir. Willst du mich heiraten?`,
];
function pickScript(name) {
  return SCRIPTS[Math.floor(Math.random() * SCRIPTS.length)](name || 'mein Schatz');
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
