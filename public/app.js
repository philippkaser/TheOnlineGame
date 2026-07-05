// ---------------------------------------------------------------------------
//  The Love Duel — client
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  ws: null,
  playerId: null,
  isHost: false,
  code: null,
  answered: false,
  timerRaf: null,
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
    // Try to reconnect and rejoin the same room silently.
    if (state.code) {
      setTimeout(() => connect(() => rejoin()), 1200);
    }
  });
}

function sendMsg(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
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
  connect(() => sendMsg({ type: 'create', name: getName() || 'Player 1' }));
});

$('#btn-join').addEventListener('click', () => {
  const code = ($('#code-input').value || '').toUpperCase().trim();
  if (code.length !== 4) {
    $('#home-error').textContent = 'Room codes are 4 letters.';
    return;
  }
  $('#home-error').textContent = '';
  state.code = code;
  connect(() => sendMsg({ type: 'join', code, name: getName() || 'Player 2' }));
});

$('#code-input').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});

$('#btn-start').addEventListener('click', () => sendMsg({ type: 'start' }));
$('#btn-propose').addEventListener('click', () => {
  sendMsg({ type: 'propose' });
  $('#btn-propose').classList.add('hidden');
  $('#lost-waiting').classList.remove('hidden');
});
$('#btn-yes').addEventListener('click', () => sendMsg({ type: 'accept' }));
$('#btn-again').addEventListener('click', () => {
  sendMsg({ type: 'playAgain' });
});

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
      stopConfetti();
      break;

    case 'question':
      renderQuestion(msg);
      break;

    case 'answered':
      if (msg.playerId !== state.playerId) {
        $('#q-wait').textContent = 'Your partner has answered…';
      }
      break;

    case 'questionResult':
      renderResult(msg);
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
    li.innerHTML = `<span class="dot"></span><span>Waiting for partner…</span>`;
    list.appendChild(li);
  }

  const ready = msg.players.length === 2 && msg.players.every((p) => p.connected);
  const startBtn = $('#btn-start');
  if (state.isHost) {
    startBtn.style.display = '';
    startBtn.disabled = !ready;
    $('#lobby-status').textContent = ready ? "You're both here! 💕" : 'Waiting for your partner to join…';
  } else {
    startBtn.style.display = 'none';
    $('#lobby-status').textContent = ready ? 'Waiting for the host to start…' : 'Waiting for your partner to join…';
  }
}

// --- Question ---------------------------------------------------------------
function renderQuestion(msg) {
  state.answered = false;
  $('#q-counter').textContent = msg.tieBreak ? '⚡ Sudden death!' : `Question ${msg.round} of ${msg.total}`;
  $('#q-text').textContent = msg.text;
  $('#q-wait').textContent = '';

  const box = $('#choices');
  box.innerHTML = '';
  msg.choices.forEach((choice, i) => {
    const btn = document.createElement('button');
    btn.className = 'choice';
    btn.textContent = choice;
    btn.dataset.index = i;
    btn.addEventListener('click', () => selectChoice(i, btn));
    box.appendChild(btn);
  });

  startTimer(msg.timeMs);
  show('screen-question');
}

function selectChoice(index, btn) {
  if (state.answered) return;
  state.answered = true;
  $$('.choice').forEach((c) => {
    c.disabled = true;
    if (c === btn) c.classList.add('selected');
  });
  $('#q-wait').textContent = 'Locked in! Waiting for your partner…';
  sendMsg({ type: 'answer', choice: index });
}

function startTimer(ms) {
  cancelAnimationFrame(state.timerRaf);
  const fill = $('#q-timer-fill');
  const start = performance.now();
  const tick = (now) => {
    const remaining = Math.max(0, 1 - (now - start) / ms);
    fill.style.width = remaining * 100 + '%';
    if (remaining > 0) {
      state.timerRaf = requestAnimationFrame(tick);
    } else if (!state.answered) {
      state.answered = true;
      $$('.choice').forEach((c) => (c.disabled = true));
      $('#q-wait').textContent = "Time's up!";
    }
  };
  state.timerRaf = requestAnimationFrame(tick);
}

// --- Round result -----------------------------------------------------------
function renderResult(msg) {
  cancelAnimationFrame(state.timerRaf);
  const me = msg.results.find((r) => r.playerId === state.playerId);
  const gotIt = me && me.correct;

  $('#result-badge').textContent = gotIt ? '✅' : '❌';
  $('#result-headline').textContent = gotIt ? 'Nailed it!' : 'Not quite!';

  // Highlight the correct choice on the question screen too (nice touch if they linger).
  $$('.choice').forEach((c) => {
    const idx = Number(c.dataset.index);
    if (idx === msg.correctIndex) c.classList.add('correct');
    else if (me && idx === me.choice) c.classList.add('wrong');
  });

  const other = msg.results.find((r) => r.playerId !== state.playerId);
  let sub = '';
  if (other) {
    sub = other.correct ? `${escapeHtml(other.name)} got it too!` : `${escapeHtml(other.name)} missed this one.`;
  }
  $('#result-correct').innerHTML = sub;

  renderScoreboard('#scoreboard', msg.scores);
  show('screen-result');
}

function renderScoreboard(sel, players) {
  const box = $(sel);
  box.innerHTML = '';
  const max = Math.max(...players.map((p) => p.score));
  players
    .slice()
    .sort((a, b) => b.score - a.score)
    .forEach((p) => {
      const row = document.createElement('div');
      row.className = 'score-row' + (p.score === max && max > 0 ? ' leading' : '');
      row.innerHTML = `<span class="s-name">${escapeHtml(p.name)}${p.id === state.playerId ? ' (you)' : ''}</span><span class="s-val">${p.score}</span>`;
      box.appendChild(row);
    });
}

// --- Game over --------------------------------------------------------------
function renderGameOver(msg) {
  cancelAnimationFrame(state.timerRaf);
  const scores = [
    { id: msg.winner.id, name: msg.winner.name, score: msg.winner.score },
    { id: msg.loser.id, name: msg.loser.name, score: msg.loser.score },
  ];

  if (msg.youWon) {
    renderScoreboard('#won-scoreboard', scores);
    $('#won-text').innerHTML = `You won, <b>${escapeHtml(msg.winner.name)}</b>! 👑<br />Now sit tight — <b>${escapeHtml(msg.loser.name)}</b> owes you a very important question…`;
    show('screen-won');
    launchConfetti(2500);
  } else {
    renderScoreboard('#lost-scoreboard', scores);
    $('#lost-text').innerHTML = `Ohh, <b>${escapeHtml(msg.loser.name)}</b>… you lost! 😅<br />You know what that means. Time to propose to <b>${escapeHtml(msg.winner.name)}</b>.`;
    $('#proposal-script').textContent = pickScript(msg.winner.name);
    $('#btn-propose').classList.remove('hidden');
    $('#lost-waiting').classList.add('hidden');
    show('screen-lost');
  }
}

const SCRIPTS = [
  (name) => `${name}, from the moment we met, life got brighter. I lost this game, but I don't want to lose you — ever. Will you marry me?`,
  (name) => `${name}, I'd fail a thousand quizzes if it meant spending forever with you. So here goes… will you marry me?`,
  (name) => `Well, ${name}, the game has spoken — and honestly, so has my heart. Will you be mine forever? Will you marry me?`,
];

function pickScript(name) {
  return SCRIPTS[Math.floor(Math.random() * SCRIPTS.length)](escapeText(name));
}

// --- Proposal ---------------------------------------------------------------
function renderProposalMade(msg) {
  const amWinner = msg.proposee === state.playerId;
  if (amWinner) {
    launchConfetti(1500);
    show('screen-proposal');
  }
  // The proposer already switched to their "waiting" view when they tapped.
}

function renderCelebration() {
  $('#celebrate-sub').textContent = 'Here comes forever 🥂💍';
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
  const box = $('#hearts');
  box.innerHTML = '';
  const emojis = ['❤️', '💕', '💗', '💖', '💘'];
  for (let i = 0; i < 18; i++) {
    const h = document.createElement('div');
    h.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    h.style.position = 'fixed';
    h.style.left = Math.random() * 100 + 'vw';
    h.style.bottom = '-40px';
    h.style.fontSize = 1 + Math.random() * 1.5 + 'rem';
    h.style.pointerEvents = 'none';
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
function escapeText(str) {
  return str == null ? '' : String(str);
}
