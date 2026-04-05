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
    const s = JSON.parse(JSON.stringify(room.state));
    ['p0','p1','p2','p3'].forEach(r => {
      if (r !== p.role && s.hands && s.hands[r]) {
        s.hands[r] = s.hands[r].map(() => ({ hidden: true }));
      }
    });
    s.myRole = p.role;
    sendTo(p.ws, { type: 'state', state: s });
  });
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
          playerCount: 1, phase: 'lobby', teams: null,
          scores: { A: 0, B: 0 }, gamesWon: { A: 0, B: 0 },
          hands: { p0: [], p1: [], p2: [], p3: [] },
          remainingDeck: [], trumpSuit: null, kickCard: null, kickBonuses: [],
          dealer: 'p0', turn: null, bettor: null,
          trickCard: { p0: null, p1: null, p2: null, p3: null },
          trickWins: { p0: 0, p1: 0, p2: 0, p3: 0 },
          ledSuit: null, trickCount: 0, highHolder: null, lowHolder: null,
          jackCaptured: null, gamePoints: { p0: 0, p1: 0, p2: 0, p3: 0 },
          round: 0, roundSummary: null,
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
      const incoming = msg.state;
      // CRITICAL: restore real hands for all players except sender
      // Client only has their own real cards; others are {hidden:true}
      if (incoming.hands && room.state.hands) {
        ['p0','p1','p2','p3'].forEach(r => {
          if (r !== myRole) {
            incoming.hands[r] = room.state.hands[r] || [];
          }
        });
      }
      room.state = incoming;
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