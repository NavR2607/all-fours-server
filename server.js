const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static('public')); // serves your HTML file

const rooms = {}; // stores game state per room code

wss.on('connection', (ws) => {
  let myRoom = null;
  let myRole = null;

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);

    if (msg.type === 'create') {
      myRoom = msg.code;
      myRole = 'host';
      rooms[myRoom] = { host: ws, guest: null, state: msg.state };
      ws.send(JSON.stringify({ type: 'created' }));
    }

    if (msg.type === 'join') {
      myRoom = msg.code;
      myRole = 'guest';
      const room = rooms[myRoom];
      if (!room) return ws.send(JSON.stringify({ type: 'error', msg: 'Room not found' }));
      if (room.guest) return ws.send(JSON.stringify({ type: 'error', msg: 'Room full' }));
      room.guest = ws;
      ws.send(JSON.stringify({ type: 'joined', state: room.state }));
      room.host.send(JSON.stringify({ type: 'opponent_joined', state: room.state }));
    }

    if (msg.type === 'update') {
      const room = rooms[myRoom];
      if (!room) return;
      room.state = msg.state;
      const other = myRole === 'host' ? room.guest : room.host;
      if (other) other.send(JSON.stringify({ type: 'state', state: msg.state }));
    }
  });

  ws.on('close', () => {
    if (!myRoom || !rooms[myRoom]) return;
    const other = myRole === 'host' ? rooms[myRoom].guest : rooms[myRoom].host;
    if (other) other.send(JSON.stringify({ type: 'opponent_left' }));
    delete rooms[myRoom];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on port ${PORT}`));