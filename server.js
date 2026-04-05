const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static('public'));

const rooms = {};
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RV = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
const ROLES = ['p0','p1','p2','p3'];

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastAll(room, msg) {
  room.players.forEach(p => sendTo(p.ws, msg));
}

// Send each player their own personalised state (own hand visible, others hidden)
function broadcastPersonalStates(room) {
  room.players.forEach(p => {
    const s = JSON.parse(JSON.stringify(room.state));
    ROLES.forEach(r => {
      if (r !== p.role && s.hands && s.hands[r]) {
        s.hands[r] = s.hands[r].map(() => ({ hidden: true }));
      }
    });
    s.myRole = p.role;
    sendTo(p.ws, { type: 'state', state: s });
  });
}

function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

function makeDeck() {
  const d = [];
  SUITS.forEach(s => RANKS.forEach(r => d.push({ suit: s, rank: r })));
  return d;
}

function teamOf(role, teams) {
  if (!teams) return null;
  if ((teams.A || []).includes(role)) return 'A';
  if ((teams.B || []).includes(role)) return 'B';
  return null;
}

function calcKickBonuses(card, dealerRole, teams) {
  const b = [], dt = teamOf(dealerRole, teams);
  if (!dt) return b;
  if (card.rank === 'A') b.push({ pts: 1, team: dt, reason: 'Ace kicked (+1)' });
  if (card.rank === '6') b.push({ pts: 2, team: dt, reason: 'Six kicked (+2)' });
  if (card.rank === 'J' && card.suit === '♦') b.push({ pts: 4, team: dt, reason: 'Jack of Diamonds (+4)' });
  else if (card.rank === 'J') b.push({ pts: 3, team: dt, reason: 'Jack kicked (+3)' });
  return b;
}

function trackTrumpHolders(state) {
  const allC = ROLES.flatMap(r => state.hands[r] || []);
  const trumps = allC.filter(c => c.suit === state.trumpSuit);
  state.highHolder = null; state.lowHolder = null;
  if (trumps.length) {
    const ht = trumps.reduce((a, b) => RV[a.rank] > RV[b.rank] ? a : b);
    const lt = trumps.reduce((a, b) => RV[a.rank] < RV[b.rank] ? a : b);
    ROLES.forEach(r => {
      if ((state.hands[r] || []).some(c => c.suit === ht.suit && c.rank === ht.rank)) state.highHolder = r;
      if ((state.hands[r] || []).some(c => c.suit === lt.suit && c.rank === lt.rank)) state.lowHolder = r;
    });
  }
}

// SERVER-SIDE DEAL — called when host sends 'deal' message
function serverDeal(room) {
  const state = room.state;
  const deck = shuffle(makeDeck());
  state.hands = {
    p0: deck.slice(0, 6),
    p1: deck.slice(6, 12),
    p2: deck.slice(12, 18),
    p3: deck.slice(18, 24)
  };
  state.remainingDeck = deck.slice(24);
  const kick = state.remainingDeck.shift();
  state.kickCard = kick;
  state.trumpSuit = kick.suit;
  const bonuses = calcKickBonuses(kick, state.dealer, state.teams);
  state.kickBonuses = bonuses;
  bonuses.forEach(b => { state.scores[b.team] = (state.scores[b.team] || 0) + b.pts; });
  trackTrumpHolders(state);
  state.phase = 'bet';
  state.trickCard = { p0: null, p1: null, p2: null, p3: null };
  state.trickWins = { p0: 0, p1: 0, p2: 0, p3: 0 };
  state.ledSuit = null;
  state.jackCaptured = null;
  state.gamePoints = { p0: 0, p1: 0, p2: 0, p3: 0 };
  state.bettor = null;
  state.trickCount = 0;
  state.roundSummary = null;
  state.round = (state.round || 0) + 1;
  const di = ROLES.indexOf(state.dealer);
  state.turn = ROLES[(di + 1) % 4];
  broadcastPersonalStates(room);
}

// SERVER-SIDE RUN THE PACK
function serverRunPack(room) {
  const state = room.state;
  ROLES.forEach(r => {
    state.hands[r] = [...(state.hands[r] || []), ...state.remainingDeck.splice(0, 3)];
  });
  let kick = state.remainingDeck.shift();
  while (kick && kick.suit === state.trumpSuit && state.remainingDeck.length > 0) {
    state.hands[state.dealer] = [...(state.hands[state.dealer] || []), kick];
    kick = state.remainingDeck.shift();
  }
  if (!kick) { serverDeal(room); return; }
  state.kickCard = kick;
  state.trumpSuit = kick.suit;
  const nb = calcKickBonuses(kick, state.dealer, state.teams);
  state.kickBonuses = [...(state.kickBonuses || []), ...nb];
  nb.forEach(b => { state.scores[b.team] = (state.scores[b.team] || 0) + b.pts; });
  trackTrumpHolders(state);
  const di = ROLES.indexOf(state.dealer);
  state.turn = ROLES[(di + 1) % 4];
  state.phase = 'playing';
  broadcastPersonalStates(room);
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
      if (!room) return sendTo(ws, { type: 'error', msg: 'Room not found' });
      if (room.players.length >= 4) return sendTo(ws, { type: 'error', msg: 'Room is full' });
      myRole = 'p' + room.players.length;
      room.players.push({ ws, name: msg.name, role: myRole });
      room.state[myRole] = msg.name;
      room.state.playerCount = room.players.length;
      sendTo(ws, { type: 'joined', role: myRole, state: room.state });
      broadcastAll(room, { type: 'lobby_update', state: room.state });
    }

    // Client sends game actions — server applies them and broadcasts
    else if (msg.type === 'action') {
      const room = rooms[myRoom];
      if (!room) return;
      const state = room.state;
      const action = msg.action;

      if (action === 'deal') {
        // Set teams if provided
        if (msg.teams) state.teams = msg.teams;
        if (msg.dealer) state.dealer = msg.dealer;
        if (msg.scores) state.scores = msg.scores;
        if (msg.gamesWon) state.gamesWon = msg.gamesWon;
        serverDeal(room);
      }

      else if (action === 'beg') {
        state.bettor = myRole;
        state.phase = 'dealer_choice';
        state.turn = state.dealer;
        broadcastPersonalStates(room);
      }

      else if (action === 'stand') {
        state.phase = 'playing';
        const di = ROLES.indexOf(state.dealer);
        state.turn = ROLES[(di + 1) % 4];
        broadcastPersonalStates(room);
      }

      else if (action === 'give') {
        const bt = teamOf(state.bettor, state.teams);
        if (bt) state.scores[bt] = (state.scores[bt] || 0) + 1;
        state.phase = 'playing';
        const di = ROLES.indexOf(state.dealer);
        state.turn = ROLES[(di + 1) % 4];
        broadcastPersonalStates(room);
      }

      else if (action === 'run_pack') {
        serverRunPack(room);
      }

      else if (action === 'play_card') {
        const cardIdx = msg.cardIdx;
        const hand = state.hands[myRole] || [];
        const card = hand[cardIdx];
        if (!card) return;
        // Remove card from hand
        state.hands[myRole] = hand.filter((_, i) => i !== cardIdx);
        state.trickCard[myRole] = card;
        if (!state.ledSuit) state.ledSuit = card.suit;
        // Check if all 4 played
        const allPlayed = ROLES.every(r => state.trickCard[r] !== null);
        if (allPlayed) {
          // Resolve trick server-side
          const trump = state.trumpSuit, led = state.ledSuit;
          let best = null, winner = null;
          ROLES.forEach(r => {
            const c = state.trickCard[r];
            let v = 0;
            if (c.suit === trump) v = 100 + RV[c.rank];
            else if (c.suit === led) v = RV[c.rank];
            if (best === null || v > best) { best = v; winner = r; }
          });
          state.trickWins[winner]++;
          state.trickCount++;
          ROLES.forEach(r => {
            const c = state.trickCard[r];
            if (c.rank === 'J' && c.suit === trump) state.jackCaptured = winner;
            const gv = ({ A: 4, K: 3, Q: 2, J: 1, 10: 10 }[c.rank]) || 0;
            state.gamePoints[r] = (state.gamePoints[r] || 0) + gv;
          });
          state.trickCard = { p0: null, p1: null, p2: null, p3: null };
          state.ledSuit = null;
          // Check if hand is over
          const done = ROLES.every(r => (state.hands[r] || []).length === 0);
          if (done) {
            // Score round
            const rp = { A: 0, B: 0 };
            const summary = [];
            (state.kickBonuses || []).forEach(b => summary.push({ label: b.reason, team: b.team, pts: b.pts, note: '(scored at kick)' }));
            if (state.highHolder) { const t = teamOf(state.highHolder, state.teams); rp[t]++; summary.push({ label: '🏆 Highest Trump', team: t, pts: 1 }); }
            else summary.push({ label: '🏆 Highest Trump', team: null, pts: 0 });
            if (state.lowHolder) { const t = teamOf(state.lowHolder, state.teams); rp[t]++; summary.push({ label: '🔻 Lowest Trump', team: t, pts: 1 }); }
            else summary.push({ label: '🔻 Lowest Trump', team: null, pts: 0 });
            if (state.jackCaptured) { const t = teamOf(state.jackCaptured, state.teams); rp[t]++; summary.push({ label: '🃏 Hanging Jack', team: t, pts: 1 }); }
            else summary.push({ label: '🃏 Hanging Jack', team: null, pts: 0, note: 'Not in play' });
            const gpA = (state.teams.A || []).reduce((s, r) => s + (state.gamePoints[r] || 0), 0);
            const gpB = (state.teams.B || []).reduce((s, r) => s + (state.gamePoints[r] || 0), 0);
            if (gpA !== gpB) { const gw = gpA > gpB ? 'A' : 'B'; rp[gw] += 2; summary.push({ label: `🎯 Game (A:${gpA} B:${gpB})`, team: gw, pts: 2 }); }
            else summary.push({ label: `🎯 Game (Tied ${gpA})`, team: null, pts: 0 });
            state.scores.A = (state.scores.A || 0) + rp.A;
            state.scores.B = (state.scores.B || 0) + rp.B;
            state.roundSummary = summary;
            if (!state.gamesWon) state.gamesWon = { A: 0, B: 0 };
            if (state.scores.A >= 14 || state.scores.B >= 14) {
              const gw = state.scores.A >= 14 ? 'A' : 'B';
              state.gamesWon[gw]++;
              state.phase = 'game_over';
            } else {
              state.phase = 'round_end';
              const di = ROLES.indexOf(state.dealer);
              state.dealer = ROLES[(di + 1) % 4];
            }
          } else {
            state.turn = winner;
          }
        } else {
          // Next player's turn
          const i2 = ROLES.indexOf(myRole);
          state.turn = ROLES[(i2 + 1) % 4];
        }
        broadcastPersonalStates(room);
      }

      else if (action === 'update_teams') {
        state.teams = msg.teams;
        broadcastAll(room, { type: 'lobby_update', state });
      }
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
    if (room.players.length === 0) delete rooms[myRoom];
    else broadcastAll(room, { type: 'player_left', role: myRole });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`All Fours server on port ${PORT}`));