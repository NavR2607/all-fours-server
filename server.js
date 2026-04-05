const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ─────────────────────────────────────────────────────────────────
function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcastAll(room, msg) {
  for (const p of room.players) send(p.ws, msg);
}
function broadcastState(room) {
  for (const p of room.players)
    send(p.ws, { type: 'state', state: playerView(room.state, p.role) });
}

// Each player only sees their own hand; during beg phase only dealer+beggar see theirs
function playerView(s, role) {
  const v = JSON.parse(JSON.stringify(s));
  const di = ROLES.indexOf(s.dealer);
  const beggar = ROLES[(di + 1) % 4];
  const inBegPhase = s.phase === 'bet' || s.phase === 'give_one';
  for (const r of ROLES) {
    if (r !== role) {
      v.hands[r] = (s.hands[r] || []).map(() => 'back');
    } else if (inBegPhase && r !== s.dealer && r !== beggar) {
      v.hands[r] = (s.hands[r] || []).map(() => 'back');
    }
  }
  return v;
}

// ─── Deck & Card Helpers ─────────────────────────────────────────────────────
const ROLES = ['p0','p1','p2','p3'];
const SUITS = ['S','H','D','C'];
const RANKS = ['A','K','Q','J','10','9','8','7','6','5','4','3','2'];
const RANK_VAL = {A:14,K:13,Q:12,J:11,'10':10,9:9,8:8,7:7,6:6,5:5,4:4,3:3,2:2};
const GAME_PTS = {A:4,K:3,Q:2,J:1,'10':10};

function makeDeck() {
  return SUITS.flatMap(s => RANKS.map(r => r + s));
}
function shuffle(d) {
  const a = [...d];
  for (let i = a.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}
const suit   = c => c.slice(-1);
const rank   = c => c.slice(0,-1);
const rankVal = c => RANK_VAL[rank(c)] || 0;
const gamePts = c => GAME_PTS[rank(c)] || 0;
const pname  = (s,r) => s[r] || r;
const teamOf = (role,teams) => teams ? (teams.A.includes(role)?'A':teams.B.includes(role)?'B':null) : null;

// ─── Deal ────────────────────────────────────────────────────────────────────
function dealCards(state, n) {
  for (let i = 0; i < n; i++)
    for (const r of ROLES)
      if (state.deck.length) state.hands[r].push(state.deck.pop());
}

function startRound(state) {
  state.deck = shuffle(makeDeck());
  state.hands = {p0:[],p1:[],p2:[],p3:[]};
  state.trick = {};
  state.trickLead = null;
  state.trickHistory = [];
  state.turnUp = null;
  state.trumpSuit = null;
  state.highTrump = null; state.highHolder = null;
  state.lowTrump  = null; state.lowHolder  = null;
  state.jackHolder = null; state.jackCapturedBy = null;
  state.gamePointsWon = {p0:0,p1:0,p2:0,p3:0};
  state.roundPts = null;
  state.roundDetail = null;

  dealCards(state, 6);
  state.turnUp    = state.deck.pop();
  state.trumpSuit = suit(state.turnUp);

  const di = ROLES.indexOf(state.dealer);
  state.beggar = ROLES[(di+1)%4];
  state.turn   = state.beggar;
  state.phase  = 'bet';
  state.action = `${pname(state,state.beggar)} to Beg or Stand`;
}

function trackTrumps(state) {
  const ts = state.trumpSuit;
  const all = [];
  for (const r of ROLES)
    for (const c of (state.hands[r]||[]))
      if (suit(c)===ts) all.push({card:c,player:r});
  if (!all.length) return;
  all.sort((a,b)=>rankVal(b.card)-rankVal(a.card));
  state.highTrump = all[0].card; state.highHolder = all[0].player;
  all.sort((a,b)=>rankVal(a.card)-rankVal(b.card));
  state.lowTrump  = all[0].card; state.lowHolder  = all[0].player;
  const jCard = 'J'+ts;
  state.jackHolder = ROLES.find(r=>(state.hands[r]||[]).includes(jCard)) || null;
}

function beginPlaying(state) {
  trackTrumps(state);
  state.phase     = 'playing';
  state.turn      = state.beggar;
  state.trickLead = state.beggar;
  state.action    = `${pname(state,state.beggar)} leads`;
}

// ─── Beg Phase ───────────────────────────────────────────────────────────────
function runPack(state) {
  dealCards(state, 3);
  if (!state.deck.length) { state.phase='redeal'; state.action='Pack depleted — reshuffling'; return; }
  const prev = state.trumpSuit;
  state.turnUp    = state.deck.pop();
  const newSuit   = suit(state.turnUp);
  if (newSuit === prev) {
    state.phase  = 'flip_again';
    state.action = `Same suit! ${pname(state,state.dealer)} must flip again`;
  } else {
    state.trumpSuit = newSuit;
    beginPlaying(state);
  }
}

function flipAgain(state) {
  if (!state.deck.length) { state.phase='redeal'; state.action='Pack depleted — reshuffling'; return; }
  state.turnUp    = state.deck.pop();
  state.trumpSuit = suit(state.turnUp);
  beginPlaying(state);
}

// ─── Play Card ───────────────────────────────────────────────────────────────
function playCard(state, role, card) {
  if (state.phase !== 'playing') return 'Not in playing phase';
  if (state.turn  !== role)      return 'Not your turn';
  const hand = state.hands[role] || [];
  if (!hand.includes(card))      return 'Card not in hand';

  // Follow suit rule
  if (Object.keys(state.trick).length > 0) {
    const leadSuit = suit(state.trick[state.trickLead]);
    const hasSuit  = hand.some(c => suit(c)===leadSuit);
    if (hasSuit && suit(card)!==leadSuit) return 'Must follow suit';
  }

  state.hands[role] = hand.filter(c=>c!==card);
  state.trick[role] = card;

  if (Object.keys(state.trick).length === 4) {
    resolveTrick(state);
  } else {
    const ci = ROLES.indexOf(role);
    state.turn   = ROLES[(ci+1)%4];
    state.action = `${pname(state,state.turn)}'s turn`;
  }
  return null;
}

function resolveTrick(state) {
  const ts = state.trumpSuit;
  let winner  = state.trickLead;
  let winCard = state.trick[state.trickLead];

  for (const [r,c] of Object.entries(state.trick)) {
    if (r===winner) continue;
    const wT = suit(winCard)===ts, cT = suit(c)===ts;
    if (wT && !cT) continue;
    if (!wT && cT) { winner=r; winCard=c; continue; }
    if (rankVal(c) > rankVal(winCard)) { winner=r; winCard=c; }
  }

  for (const c of Object.values(state.trick))
    state.gamePointsWon[winner] = (state.gamePointsWon[winner]||0) + gamePts(c);

  // Jack tracking
  const jCard = 'J'+ts;
  const jEntry = Object.entries(state.trick).find(([,c])=>c===jCard);
  if (jEntry) {
    const [jRole] = jEntry;
    state.jackCapturedBy = (winner===jRole ? 'self:' : 'opp:') + winner;
  }

  state.trickHistory.push({trick:{...state.trick}, winner, lead:state.trickLead});
  state.trick = {};
  state.trickLead = winner;

  if (ROLES.every(r=>(state.hands[r]||[]).length===0)) {
    scoreRound(state);
  } else {
    state.turn   = winner;
    state.action = `${pname(state,winner)} won the trick — leads`;
  }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────
function scoreRound(state) {
  const teams = state.teams;
  const pts   = {A:0,B:0};
  const det   = {A:{},B:{}};

  if (state.highHolder) {
    const t = teamOf(state.highHolder,teams);
    if (t) { pts[t]++; det[t].high = state.highTrump; }
  }
  if (state.lowHolder) {
    const t = teamOf(state.lowHolder,teams);
    if (t) { pts[t]++; det[t].low = state.lowTrump; }
  }
  if (state.jackHolder && state.jackCapturedBy) {
    const [how,winner] = state.jackCapturedBy.split(':');
    const jTeam = teamOf(state.jackHolder,teams);
    const wTeam = teamOf(winner,teams);
    if (how==='self' && jTeam) { pts[jTeam]++;     det[jTeam].jack     = 1; }
    else if (wTeam)            { pts[wTeam] += 3;  det[wTeam].hangJack = 3; }
  }

  const gpA = teams.A.reduce((s,r)=>s+(state.gamePointsWon[r]||0),0);
  const gpB = teams.B.reduce((s,r)=>s+(state.gamePointsWon[r]||0),0);
  if (gpA > gpB)      { pts.A++; det.A.game = gpA; }
  else if (gpB > gpA) { pts.B++; det.B.game = gpB; }

  state.scores.A = (state.scores.A||0) + pts.A;
  state.scores.B = (state.scores.B||0) + pts.B;
  state.roundPts    = pts;
  state.roundDetail = det;

  if (state.scores.A >= 14)      { state.phase='game_over'; state.winner='A'; state.action='Team A wins the game! 🎉'; }
  else if (state.scores.B >= 14) { state.phase='game_over'; state.winner='B'; state.action='Team B wins the game! 🎉'; }
  else {
    state.phase  = 'round_over';
    state.action = 'Round over — view results';
    state.dealer = ROLES[(ROLES.indexOf(state.dealer)+1)%4];
  }
}

// ─── Initial State ───────────────────────────────────────────────────────────
function makeState() {
  return {
    phase:'lobby', p0:null,p1:null,p2:null,p3:null, playerCount:0,
    teams:null, dealer:'p0', beggar:null, turn:null,
    hands:{p0:[],p1:[],p2:[],p3:[]}, deck:[], turnUp:null, trumpSuit:null,
    trick:{}, trickLead:null, trickHistory:[],
    highTrump:null,highHolder:null, lowTrump:null,lowHolder:null,
    jackHolder:null, jackCapturedBy:null,
    gamePointsWon:{p0:0,p1:0,p2:0,p3:0},
    scores:{A:0,B:0}, gamesWon:{A:0,B:0}, round:0,
    roundPts:null, roundDetail:null, winner:null,
    action:'Waiting for players...',
  };
}

// ─── WebSocket ───────────────────────────────────────────────────────────────
const rooms = {};

wss.on('connection', ws => {
  let myRoom = null, myRole = null;

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const room = myRoom ? rooms[myRoom] : null;
    const s    = room?.state;

    if (msg.type === 'create') {
      const code = (msg.code||'').toUpperCase().trim().replace(/[^A-Z0-9]/g,'');
      if (!code) return send(ws,{type:'error',msg:'Invalid room code'});
      if (rooms[code]) return send(ws,{type:'error',msg:'Room code already in use'});
      myRoom=code; myRole='p0';
      const state = makeState();
      state.p0=msg.name; state.playerCount=1;
      rooms[code]={players:[{ws,role:'p0',name:msg.name}],state};
      send(ws,{type:'created',role:'p0',state:playerView(state,'p0')});
    }

    else if (msg.type === 'join') {
      const code = (msg.code||'').toUpperCase().trim().replace(/[^A-Z0-9]/g,'');
      const r = rooms[code];
      if (!r)                    return send(ws,{type:'error',msg:'Room not found — check the code'});
      if (r.players.length >= 4) return send(ws,{type:'error',msg:'Room is full (4/4 players)'});
      myRoom=code; myRole='p'+r.players.length;
      r.state[myRole]=msg.name; r.state.playerCount=r.players.length+1;
      r.players.push({ws,role:myRole,name:msg.name});
      send(ws,{type:'joined',role:myRole,state:playerView(r.state,myRole)});
      broadcastAll(r,{type:'lobby_update',state:playerView(r.state,'p0')});
    }

    else if (msg.type === 'start_game') {
      if (!room||myRole!=='p0') return;
      if (room.players.length<4) return send(ws,{type:'error',msg:'Need 4 players to start'});
      s.teams={A:['p0','p2'],B:['p1','p3']};
      s.dealer='p0'; s.scores={A:0,B:0}; s.gamesWon={A:0,B:0}; s.round=1;
      startRound(s); broadcastState(room);
    }

    else if (msg.type === 'deal') {
      if (!room||s.phase!=='round_over') return;
      if (myRole!==s.dealer) return send(ws,{type:'error',msg:'Only the dealer deals'});
      s.round=(s.round||1)+1; startRound(s); broadcastState(room);
    }

    else if (msg.type === 'beg') {
      if (!room||s.phase!=='bet'||myRole!==s.beggar) return;
      s.phase='give_one'; s.action=`${pname(s,s.dealer)} — Give One or Run Pack?`;
      broadcastState(room);
    }

    else if (msg.type === 'stand') {
      if (!room||s.phase!=='bet'||myRole!==s.beggar) return;
      beginPlaying(s); broadcastState(room);
    }

    else if (msg.type === 'give_one') {
      if (!room||s.phase!=='give_one'||myRole!==s.dealer) return;
      const bt = teamOf(s.beggar,s.teams);
      if (bt) s.scores[bt]++;
      if (s.scores[bt]>=14) { s.phase='game_over'; s.winner=bt; s.action=`Team ${bt} wins! 🎉`; }
      else beginPlaying(s);
      broadcastState(room);
    }

    else if (msg.type === 'run_pack') {
      if (!room||myRole!==s.dealer) return;
      if (s.phase==='give_one')   runPack(s);
      else if (s.phase==='flip_again') flipAgain(s);
      else return;
      broadcastState(room);
    }

    else if (msg.type === 'redeal') {
      if (!room||s.phase!=='redeal'||myRole!==s.dealer) return;
      startRound(s); broadcastState(room);
    }

    else if (msg.type === 'play_card') {
      if (!room) return;
      const err = playCard(s,myRole,msg.card);
      if (err) return send(ws,{type:'error',msg:err});
      broadcastState(room);
    }

    else if (msg.type === 'play_again') {
      if (!room||s.phase!=='game_over'||myRole!=='p0') return;
      s.gamesWon[s.winner]=(s.gamesWon[s.winner]||0)+1;
      s.winner=null; s.scores={A:0,B:0}; s.round=1;
      s.dealer=ROLES[(ROLES.indexOf(s.dealer)+1)%4];
      startRound(s); broadcastState(room);
    }

    else if (msg.type === 'ping') send(ws,{type:'pong'});
  });

  ws.on('close',()=>{
    if (!myRoom||!rooms[myRoom]) return;
    const room=rooms[myRoom];
    room.players=room.players.filter(p=>p.ws!==ws);
    if (!room.players.length) delete rooms[myRoom];
    else broadcastAll(room,{type:'player_left',role:myRole,name:room.state[myRole]});
  });
  ws.on('error',()=>{});
});

const PORT = process.env.PORT||3000;
server.listen(PORT,()=>console.log(`All Fours running on port ${PORT}`));