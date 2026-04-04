const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static('public'));

const rooms = {};

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastAll(room, msg) {
  room.players.forEach(p => sendTo(p.ws, msg));
}

function broadcastPersonalStates(room) {
  room.players.forEach(p => {
    const ps = personalState(room.state, p.role);
    sendTo(p.ws, { type: 'state', state: ps });
  });
}

// Strip other players' hands so each player only sees their own cards
function personalState(state, role) {
  const s = JSON.parse(JSON.stringify(state));
  ['p0','p1','p2','p3'].forEach(r => {
    if (r !== role && s.hands && s.hands[r]) {
      s.hands[r] = s.hands[r].map(() => ({ hidden: true }));
    }
  });
  s.myRole = role;
  return s;
}

wss.on('connection', (ws) => {
  let myRoom = null;
  let myRole = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      myRoom = msg.code;
      myRole = 'p0';
      rooms[myRoom] = {
        players: [{ ws, name: msg.name, role: 'p0' }],
        state: {
          p0: msg.name, p1: null, p2: null, p3: null,
          playerCount: 1,
          phase: 'lobby',
          teams: null,
          scores: { A: 0, B: 0 },
          hands: { p0: [], p1: [], p2: [], p3: [] },
          deck: [],
          trumpSuit: null,
          dealer: 'p0',
          turn: null,
          betStatus: null, // null | 'bet' | 'stand'
          bettor: null,
          trickCard: { p0: null, p1: null, p2: null, p3: null },
          trickWins: { p0: 0, p1: 0, p2: 0, p3: 0 },
          ledSuit: null,
          trickCount: 0,
          highTrumpHolder: null,
          lowTrumpHolder: null,
          jackCaptured: null,
          gamePoints: { p0: 0, p1: 0, p2: 0, p3: 0 },
          kickCard: null,
          kickBonuses: [],
          round: 0,
          roundPts: null,
          action: '',
        }
      };
      sendTo(ws, { type: 'created', role: 'p0', state: rooms[myRoom].state });
    }

    else if (msg.type === 'join') {
      myRoom = msg.code;
      const room = rooms[myRoom];
      if (!room) return sendTo(ws, { type: 'error', msg: 'Room not found — check the code' });
      if (room.players.length >= 4) return sendTo(ws, { type: 'error', msg: 'Room is full' });

      myRole = 'p' + room.players.length;
      room.players.push({ ws, name: msg.name, role: myRole });
      room.state[myRole] = msg.name;
      room.state.playerCount = room.players.length;

      sendTo(ws, { type: 'joined', role: myRole, state: room.state });
      broadcastAll(room, { type: 'lobby_update', state: room.state });
    }

    else if (msg.type === 'update') {
      const room = rooms[myRoom];
      if (!room) return;
      room.state = msg.state;
      broadcastPersonalStates(room);
    }

    else if (msg.type === 'update_lobby') {
      const room = rooms[myRoom];
      if (!room) return;
      room.state = msg.state;
      broadcastAll(room, { type: 'lobby_update', state: room.state });
    }

  });

  ws.on('close', () => {
    if (!myRoom || !rooms[myRoom]) return;
    const room = rooms[myRoom];
    room.players = room.players.filter(p => p.ws !== ws);
    if (room.players.length === 0) {
      delete rooms[myRoom];
    } else {
      broadcastAll(room, { type: 'player_left', role: myRole });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`All Fours server running on port ${PORT}`));