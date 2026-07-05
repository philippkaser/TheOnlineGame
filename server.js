import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { questions } from './questions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

// --- Timing / scoring knobs -------------------------------------------------
const ANSWER_TIME_MS = 12000;   // how long players get to answer a question
const RESULT_PAUSE_MS = 3000;   // how long the "correct answer" screen lingers
const MAX_SPEED_BONUS = 500;    // extra points for answering instantly
const BASE_POINTS = 500;        // points for a correct answer

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
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);

  // Prevent path traversal.
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
//  Game state
// ---------------------------------------------------------------------------
/** @type {Map<string, Room>} */
const rooms = new Map();

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I
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
    players: [], // { id, ws, name, score, connected }
    phase: 'lobby', // lobby | playing | proposal | done
    order: [], // shuffled question indices
    round: 0,
    answers: {}, // playerId -> { choice, at }
    questionStartedAt: 0,
    timer: null,
    tieBreak: false,
  };
  rooms.set(code, room);
  return room;
}

function playerId() {
  return Math.random().toString(36).slice(2, 10);
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  for (const p of room.players) send(p.ws, msg);
}

function publicPlayers(room) {
  return room.players.map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected }));
}

function pushLobby(room) {
  broadcast(room, { type: 'lobby', code: room.code, players: publicPlayers(room) });
}

// --- Game flow --------------------------------------------------------------
function startGame(room) {
  room.phase = 'playing';
  room.round = 0;
  room.tieBreak = false;
  for (const p of room.players) p.score = 0;
  // Shuffle question order.
  room.order = questions.map((_, i) => i);
  for (let i = room.order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [room.order[i], room.order[j]] = [room.order[j], room.order[i]];
  }
  broadcast(room, { type: 'gameStart', total: room.order.length });
  sendQuestion(room);
}

function sendQuestion(room) {
  room.answers = {};
  room.questionStartedAt = Date.now();
  const qIndex = room.tieBreak
    ? room.order[room.round % room.order.length]
    : room.order[room.round];
  const q = questions[qIndex];
  room.currentCorrect = q.correct;

  broadcast(room, {
    type: 'question',
    round: room.round + 1,
    total: room.order.length,
    tieBreak: room.tieBreak,
    text: q.text,
    choices: q.choices,
    timeMs: ANSWER_TIME_MS,
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => finishQuestion(room), ANSWER_TIME_MS + 300);
}

function recordAnswer(room, player, choice) {
  if (room.phase !== 'playing') return;
  if (room.answers[player.id]) return; // already answered
  const elapsed = Date.now() - room.questionStartedAt;
  room.answers[player.id] = { choice, at: elapsed };

  const correct = choice === room.currentCorrect;
  let gained = 0;
  if (correct) {
    const speedFraction = Math.max(0, 1 - elapsed / ANSWER_TIME_MS);
    gained = BASE_POINTS + Math.round(MAX_SPEED_BONUS * speedFraction);
    player.score += gained;
  }
  // Let the player know their own answer landed (without revealing the truth yet).
  send(player.ws, { type: 'answerAck', locked: true });

  broadcast(room, { type: 'answered', playerId: player.id });

  if (room.players.every((p) => room.answers[p.id])) {
    clearTimeout(room.timer);
    setTimeout(() => finishQuestion(room), 400);
  }
}

function finishQuestion(room) {
  if (room.phase !== 'playing') return;

  const results = room.players.map((p) => {
    const a = room.answers[p.id];
    return {
      playerId: p.id,
      name: p.name,
      choice: a ? a.choice : null,
      correct: a ? a.choice === room.currentCorrect : false,
      score: p.score,
    };
  });

  broadcast(room, {
    type: 'questionResult',
    correctIndex: room.currentCorrect,
    results,
    scores: publicPlayers(room),
  });

  room.round += 1;

  const moreRegular = !room.tieBreak && room.round < room.order.length;
  if (moreRegular) {
    setTimeout(() => sendQuestion(room), RESULT_PAUSE_MS);
    return;
  }

  // Regular rounds are done (or we're in tie-break). Check for a winner.
  const [a, b] = room.players;
  if (a && b && a.score === b.score) {
    // Tie -> sudden death.
    room.tieBreak = true;
    setTimeout(() => sendQuestion(room), RESULT_PAUSE_MS);
    return;
  }

  setTimeout(() => endGame(room), RESULT_PAUSE_MS);
}

function endGame(room) {
  room.phase = 'proposal';
  const sorted = [...room.players].sort((x, y) => y.score - x.score);
  const winner = sorted[0];
  const loser = sorted[1];
  room.winnerId = winner.id;
  room.loserId = loser.id;
  room.proposalState = 'pending'; // pending | proposed | accepted

  for (const p of room.players) {
    send(p.ws, {
      type: 'gameOver',
      youWon: p.id === winner.id,
      winner: { id: winner.id, name: winner.name, score: winner.score },
      loser: { id: loser.id, name: loser.name, score: loser.score },
    });
  }
}

function handlePropose(room, player) {
  if (room.phase !== 'proposal' || player.id !== room.loserId) return;
  room.proposalState = 'proposed';
  broadcast(room, {
    type: 'proposalMade',
    proposer: room.loserId,
    proposee: room.winnerId,
  });
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
    // Clean up empty rooms after a grace period.
    setTimeout(() => {
      const r = rooms.get(ws.roomCode);
      if (r && r.players.every((p) => !p.connected)) {
        clearTimeout(r.timer);
        rooms.delete(ws.roomCode);
      }
    }, 60000);
  });
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create': {
      const room = makeRoom();
      const p = { id: playerId(), ws, name: (msg.name || 'Player 1').slice(0, 20), score: 0, connected: true };
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
      // Allow reconnect into a slot that dropped.
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
        p = { id: playerId(), ws, name: (msg.name || 'Player 2').slice(0, 20), score: 0, connected: true };
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
      // Only the host starts.
      if (room.players[0].id !== ws.playerId) return;
      startGame(room);
      break;
    }

    case 'answer': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const player = room.players.find((p) => p.id === ws.playerId);
      if (player) recordAnswer(room, player, msg.choice);
      break;
    }

    case 'propose': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const player = room.players.find((p) => p.id === ws.playerId);
      if (player) handlePropose(room, player);
      break;
    }

    case 'accept': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const player = room.players.find((p) => p.id === ws.playerId);
      if (player) handleAccept(room, player);
      break;
    }

    case 'playAgain': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (room.players[0]?.id !== ws.playerId) return;
      room.phase = 'lobby';
      pushLobby(room);
      break;
    }
  }
}

server.listen(PORT, () => {
  console.log(`💍  The Online Game running at http://localhost:${PORT}`);
});
