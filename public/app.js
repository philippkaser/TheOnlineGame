// ---------------------------------------------------------------------------
//  The Love Duel — top-down shooter client
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const COLORS = ['#ff5c8a', '#5ab8ff']; // player index 0 / 1

const state = {
  ws: null,
  playerId: null,
  isHost: false,
  code: null,
  cfg: null, // gameStart config
  latest: null, // most recent server state
  render: {}, // smoothed positions per player id
  input: { mx: 0, my: 0, ax: 0, ay: 0, firing: false },
  inputTimer: null,
  raf: null,
};

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

// --- Home actions -----------------------------------------------------------
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

// --- Message handling -------------------------------------------------------
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
      state.latest = msg;
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

// --- Lobby ------------------------------------------------------------------
function renderLobby(msg) {
  state.code = msg.code;
  $('#lobby-code').textContent = msg.code;
  const list = $('#player-list');
  list.innerHTML = '';
  msg.players.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot"></span><span>${escapeHtml(p.name)}${p.id === state.playerId ? ' (you)' : ''}</span>`;
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
  state.latest = null;
  state.render = {};
  stopConfetti();
  show('screen-game');
  resizeCanvas();
  bindControls();
  startInputLoop();
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
const ws = (s) => s * view.scale;

// --- Input: twin-stick touch + keyboard/mouse ------------------------------
const sticks = { move: null, aim: null }; // { id, ox, oy, x, y }
const STICK_R = 55;
const keys = {};
let mouse = { active: false, x: 0, y: 0, down: false };

function bindControls() {
  if (canvas.dataset.bound) return;
  canvas.dataset.bound = '1';

  canvas.addEventListener('touchstart', onTouch, { passive: false });
  canvas.addEventListener('touchmove', onTouch, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

  // Desktop fallback.
  window.addEventListener('keydown', (e) => (keys[e.key.toLowerCase()] = true));
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

function onTouch(e) {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  for (const t of Array.from(e.changedTouches)) {
    const x = t.clientX - r.left;
    const y = t.clientY - r.top;
    // Assign a new touch to a half if that stick is free.
    const side = x < view.cssW / 2 ? 'move' : 'aim';
    if (!sticks[side] || sticks[side].id === t.identifier) {
      if (!sticks[side]) sticks[side] = { id: t.identifier, ox: x, oy: y, x, y };
      else {
        sticks[side].x = x;
        sticks[side].y = y;
      }
    }
  }
  // Update existing sticks that moved.
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
  const inp = { mx: 0, my: 0, ax: 0, ay: 0, firing: false };

  if (sticks.move) {
    let dx = sticks.move.x - sticks.move.ox;
    let dy = sticks.move.y - sticks.move.oy;
    const m = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(m, STICK_R) / STICK_R;
    inp.mx = (dx / m) * clamped;
    inp.my = (dy / m) * clamped;
  }
  if (sticks.aim) {
    const dx = sticks.aim.x - sticks.aim.ox;
    const dy = sticks.aim.y - sticks.aim.oy;
    const m = Math.hypot(dx, dy);
    if (m > STICK_R * 0.25) {
      inp.ax = dx / m;
      inp.ay = dy / m;
      inp.firing = true;
    }
  }

  // Keyboard movement.
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
  // Mouse aim.
  const me = state.latest && state.latest.players.find((p) => p.id === state.playerId);
  if (mouse.active && me) {
    const dx = mouse.x - wx(me.x);
    const dy = mouse.y - wy(me.y);
    const m = Math.hypot(dx, dy);
    if (m > 4) {
      inp.ax = dx / m;
      inp.ay = dy / m;
      if (mouse.down || keys[' ']) inp.firing = true;
    }
  }
  return inp;
}

function startInputLoop() {
  clearInterval(state.inputTimer);
  state.inputTimer = setInterval(() => {
    if (!$('#screen-game').classList.contains('active')) return;
    const inp = computeInput();
    state.input = inp;
    sendMsg({ type: 'input', ...inp });
  }, 50);
}

// --- Render loop ------------------------------------------------------------
function loop() {
  state.raf = requestAnimationFrame(loop);
  if (!state.cfg || !$('#screen-game').classList.contains('active')) return;
  draw();
}

function draw() {
  const { w, h } = state.cfg.arena;
  ctx.clearRect(0, 0, view.cssW, view.cssH);

  // Arena floor.
  ctx.fillStyle = '#160c28';
  ctx.fillRect(wx(0), wy(0), ws(w), ws(h));
  // Grid.
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let gx = 0; gx <= w; gx += 60) {
    ctx.beginPath();
    ctx.moveTo(wx(gx), wy(0));
    ctx.lineTo(wx(gx), wy(h));
    ctx.stroke();
  }
  for (let gy = 0; gy <= h; gy += 60) {
    ctx.beginPath();
    ctx.moveTo(wx(0), wy(gy));
    ctx.lineTo(wx(w), wy(gy));
    ctx.stroke();
  }
  // Arena border.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.strokeRect(wx(0), wy(0), ws(w), ws(h));

  // Obstacles.
  ctx.fillStyle = '#3a2560';
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  for (const o of state.cfg.obstacles) {
    ctx.fillRect(wx(o.x), wy(o.y), ws(o.w), ws(o.h));
    ctx.strokeRect(wx(o.x), wy(o.y), ws(o.w), ws(o.h));
  }

  const s = state.latest;
  if (s) {
    // Hearts (projectiles).
    for (const b of s.bullets) {
      drawHeart(wx(b[0]), wy(b[1]), ws(state.cfg.bulletR) * 1.7, COLORS[b[2]] || '#fff');
    }
    // Players (smoothed).
    for (const p of s.players) {
      const r = (state.render[p.id] = state.render[p.id] || { x: p.x, y: p.y, angle: p.angle });
      r.x += (p.x - r.x) * 0.35;
      r.y += (p.y - r.y) * 0.35;
      r.angle = p.angle;
      drawPlayer(p, r);
    }
    drawHud(s);
  }

  drawSticks();
}

function drawHeart(cx, cy, size, color) {
  // Path authored in a roughly ±16 unit box, then scaled to `size`.
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

function drawPlayer(p, r) {
  const cx = wx(r.x);
  const cy = wy(r.y);
  const rad = ws(state.cfg.playerR);
  const color = COLORS[p.spawn];
  const dead = p.hp <= 0;

  ctx.globalAlpha = dead ? 0.3 : 1;

  // Body.
  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.fill();

  // Barrel.
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = ws(6);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(r.angle) * rad * 1.5, cy + Math.sin(r.angle) * rad * 1.5);
  ctx.stroke();

  // "You" ring.
  if (p.id === state.playerId) {
    ctx.strokeStyle = '#ffd76a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, rad + 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Health bar.
  const bw = rad * 2.4;
  const bh = 6;
  const bx = cx - bw / 2;
  const by = cy - rad - 16;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = p.hp > 40 ? '#4ade80' : '#fb7185';
  ctx.fillRect(bx, by, (bw * p.hp) / state.cfg.maxHp, bh);
}

function drawHud(s) {
  // Round-win pips, colour-coded, "you" marked.
  const need = state.cfg.roundsToWin;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const meFirst = s.players.find((p) => p.id === state.playerId)?.spawn === 0;
  const ordered = meFirst ? s.players : [...s.players].reverse();

  ctx.font = '600 14px system-ui, sans-serif';
  let y = view.oy + 18;
  // Left = you.
  const you = ordered[0];
  const opp = ordered[1];
  drawPips(view.ox + 14, y, need, you.wins, COLORS[you.spawn], 'left', you.id === state.playerId ? 'DU' : '');
  drawPips(view.ox + ws(state.cfg.arena.w) - 14, y, need, opp.wins, COLORS[opp.spawn], 'right', '');

  // Countdown / round banner.
  if (s.phase === 'countdown') {
    const cx = view.ox + ws(state.cfg.arena.w) / 2;
    const cy = view.oy + ws(state.cfg.arena.h) / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(wx(0), wy(0), ws(state.cfg.arena.w), ws(state.cfg.arena.h));
    ctx.fillStyle = '#ffd76a';
    ctx.font = '800 90px system-ui, sans-serif';
    ctx.fillText(s.count > 0 ? String(s.count) : 'LOS!', cx, cy);
    ctx.fillStyle = '#fdf4ff';
    ctx.font = '700 22px system-ui, sans-serif';
    ctx.fillText(`Runde ${s.round}`, cx, cy - 90);
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
    ctx.fillText(label, align === 'left' ? x : x, y + 18);
    ctx.textAlign = 'center';
  }
}

function drawSticks() {
  for (const side of ['move', 'aim']) {
    const st = sticks[side];
    if (!st) continue;
    const kx = st.x - st.ox;
    const ky = st.y - st.oy;
    const m = Math.hypot(kx, ky) || 1;
    const c = Math.min(m, STICK_R);
    const nx = st.ox + (kx / m) * c;
    const ny = st.oy + (ky / m) * c;
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 3;
    ctx.arc(st.ox, st.oy, STICK_R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.fillStyle = side === 'aim' ? 'rgba(255,92,138,0.75)' : 'rgba(255,255,255,0.55)';
    ctx.arc(nx, ny, 26, 0, Math.PI * 2);
    ctx.fill();
  }
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

// --- Proposal + celebration -------------------------------------------------
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
