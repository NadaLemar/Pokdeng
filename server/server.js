const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const Logic = require('../shared/gameLogic.js');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3001;
const STARTING_BALANCE = 1000;
const MAX_PLAYERS = 6;
const TABLE_COUNT = 6;
const AUTO_START_DELAY_MS = 8000; // 2명 이상 모이면 자동 시작까지 대기 시간
const NEXT_ROUND_DELAY_MS = 5000;

/** tables[id] = {
 *   id, name, minBet,
 *   players: [{id,name,balance,bet,hand,decision,connected,isBanker}],
 *   phase: 'lobby'|'betting'|'turns'|'resolved',
 *   deck, turnQueue, turnIndex, round, countdownEndsAt
 * } */
const tables = {};
for (let i = 1; i <= TABLE_COUNT; i++) {
  tables[i] = {
    id: i,
    name: `테이블 ${i}`,
    minBet: i <= 2 ? 10 : (i <= 4 ? 50 : 100),
    players: [],
    phase: 'lobby',
    deck: [],
    turnQueue: [],
    turnIndex: 0,
    round: 0,
    countdownTimer: null,
    countdownEndsAt: null
  };
}

function lobbySummary() {
  return Object.values(tables).map(t => ({
    id: t.id,
    name: t.name,
    minBet: t.minBet,
    playerCount: t.players.filter(p => p.connected).length,
    maxPlayers: MAX_PLAYERS,
    phase: t.phase,
    round: t.round
  }));
}

function broadcastLobby() {
  io.emit('lobbyUpdate', lobbySummary());
}

function publicTableState(table, forId) {
  const revealAll = table.phase === 'resolved';
  return {
    id: table.id,
    name: table.name,
    minBet: table.minBet,
    phase: table.phase,
    round: table.round,
    turnPlayerId: table.turnQueue ? table.turnQueue[table.turnIndex] : null,
    countdownEndsAt: table.countdownEndsAt,
    players: table.players.map(p => ({
      id: p.id,
      name: p.name,
      balance: p.balance,
      bet: p.bet,
      isBanker: p.isBanker,
      connected: p.connected,
      hand: (revealAll || p.id === forId || p.hand.length === 0) ? p.hand : p.hand.map(() => null),
      result: p.result || null,
      handName: revealAll ? p.handName : null
    }))
  };
}

function broadcastTable(table) {
  for (const p of table.players) {
    io.to(p.id).emit('tableUpdate', publicTableState(table, p.id));
  }
  broadcastLobby();
}

function findTableByPlayer(socketId) {
  return Object.values(tables).find(t => t.players.some(p => p.id === socketId));
}

io.on('connection', (socket) => {
  socket.emit('lobbyUpdate', lobbySummary());

  socket.on('getLobby', () => {
    socket.emit('lobbyUpdate', lobbySummary());
  });

  socket.on('joinTable', ({ tableId, name }) => {
    const table = tables[tableId];
    if (!table) return socket.emit('errorMsg', '존재하지 않는 테이블입니다.');
    if (findTableByPlayer(socket.id)) return; // 이미 참가 중
    const activeCount = table.players.filter(p => p.connected).length;
    if (activeCount >= MAX_PLAYERS) return socket.emit('errorMsg', '테이블이 가득 찼습니다. 다른 테이블을 선택해주세요.');
    if (table.phase !== 'lobby') return socket.emit('errorMsg', '라운드가 진행 중입니다. 다음 라운드를 기다려주세요.');

    const isFirst = table.players.length === 0;
    table.players.push({
      id: socket.id, name: (name || '플레이어').slice(0, 12),
      balance: STARTING_BALANCE, bet: 0, hand: [], decision: null,
      connected: true, isBanker: isFirst
    });
    socket.join('table-' + tableId);
    socket.data.tableId = tableId;

    maybeStartCountdown(table);
    broadcastTable(table);
  });

  socket.on('leaveTable', () => {
    handleLeave(socket);
  });

  socket.on('placeBet', ({ amount }) => {
    const table = findTableByPlayer(socket.id);
    if (!table || table.phase !== 'betting') return;
    const p = table.players.find(pl => pl.id === socket.id);
    if (!p || p.isBanker) return;
    amount = Math.max(0, Math.min(amount, p.balance));
    if (amount > 0 && amount < table.minBet) return socket.emit('errorMsg', `최소 베팅액은 ${table.minBet} 칩입니다.`);
    p.bet = amount;
    broadcastTable(table);
    checkAllBetsIn(table);
  });

  socket.on('decision', ({ action }) => {
    const table = findTableByPlayer(socket.id);
    if (!table || table.phase !== 'turns') return;
    if (table.turnQueue[table.turnIndex] !== socket.id) return;
    const p = table.players.find(pl => pl.id === socket.id);
    if (action === 'hit' && p.hand.length < 3) p.hand.push(table.deck.pop());
    p.decision = 'done';
    advanceTurn(table);
  });

  socket.on('disconnect', () => {
    handleLeave(socket);
  });
});

function handleLeave(socket) {
  const table = findTableByPlayer(socket.id);
  if (!table) return;
  const p = table.players.find(pl => pl.id === socket.id);
  if (p) p.connected = false;
  // lobby 단계에서는 완전히 제거, 뱅커였다면 다음 사람에게 넘김
  if (table.phase === 'lobby') {
    const idx = table.players.findIndex(pl => pl.id === socket.id);
    if (idx !== -1) {
      const wasBanker = table.players[idx].isBanker;
      table.players.splice(idx, 1);
      if (wasBanker && table.players.length > 0) table.players[0].isBanker = true;
    }
    if (table.players.filter(p => p.connected).length < 2) clearCountdown(table);
  }
  broadcastTable(table);
}

function maybeStartCountdown(table) {
  const activeCount = table.players.filter(p => p.connected).length;
  if (table.phase === 'lobby' && activeCount >= 2 && !table.countdownTimer) {
    table.countdownEndsAt = Date.now() + AUTO_START_DELAY_MS;
    table.countdownTimer = setTimeout(() => {
      table.countdownTimer = null;
      table.countdownEndsAt = null;
      if (table.players.filter(p => p.connected).length >= 2) startBettingPhase(table);
    }, AUTO_START_DELAY_MS);
  }
}

function clearCountdown(table) {
  if (table.countdownTimer) clearTimeout(table.countdownTimer);
  table.countdownTimer = null;
  table.countdownEndsAt = null;
}

function startBettingPhase(table) {
  clearCountdown(table);
  table.round += 1;
  table.deck = Logic.buildDeck();
  for (const p of table.players) {
    p.hand = []; p.bet = 0; p.decision = null; p.result = null; p.handName = null;
  }
  table.phase = 'betting';
  broadcastTable(table);
}

function checkAllBetsIn(table) {
  const bettors = table.players.filter(p => !p.isBanker && p.connected);
  if (bettors.length === 0) return;
  if (bettors.every(p => p.bet > 0)) dealCards(table);
}

function dealCards(table) {
  for (const p of table.players) p.hand = [table.deck.pop(), table.deck.pop()];
  table.phase = 'turns';
  table.turnQueue = table.players.filter(p => !p.isBanker).map(p => p.id);
  table.players.forEach(p => { if (Logic.isPok(p.hand)) p.decision = 'done'; });
  const banker = table.players.find(p => p.isBanker);
  if (banker) table.turnQueue.push(banker.id);
  table.turnIndex = 0;
  skipAutoDoneAndAdvance(table);
  broadcastTable(table);
}

function skipAutoDoneAndAdvance(table) {
  while (table.turnIndex < table.turnQueue.length) {
    const pid = table.turnQueue[table.turnIndex];
    const p = table.players.find(pl => pl.id === pid);
    if (p && p.decision === 'done') { table.turnIndex += 1; continue; }
    return;
  }
  resolveRound(table);
}

function advanceTurn(table) {
  table.turnIndex += 1;
  skipAutoDoneAndAdvance(table);
  broadcastTable(table);
}

function resolveRound(table) {
  const banker = table.players.find(p => p.isBanker);
  for (const p of table.players) {
    if (p.isBanker) continue;
    const cmp = Logic.compareToBanker(p.hand, banker.hand);
    p.handName = cmp.playerHandName;
    banker.handName = cmp.bankerHandName;
    if (cmp.result === 'playerWin') {
      const amt = p.bet * cmp.mult;
      p.balance += amt; banker.balance -= amt; p.result = `+${amt}`;
    } else if (cmp.result === 'bankerWin') {
      const amt = p.bet * cmp.mult;
      p.balance -= amt; banker.balance += amt; p.result = `-${amt}`;
    } else {
      p.result = 'push';
    }
  }
  table.phase = 'resolved';
  broadcastTable(table);

  setTimeout(() => {
    table.players = table.players.filter(p => p.connected); // 나간 사람 정리
    if (table.players.length >= 2) {
      rotateBanker(table);
      table.phase = 'lobby';
      maybeStartCountdown(table);
    } else {
      table.phase = 'lobby';
    }
    broadcastTable(table);
  }, NEXT_ROUND_DELAY_MS);
}

function rotateBanker(table) {
  const idx = table.players.findIndex(p => p.isBanker);
  if (idx === -1) { if (table.players[0]) table.players[0].isBanker = true; return; }
  table.players[idx].isBanker = false;
  const nextIdx = (idx + 1) % table.players.length;
  table.players[nextIdx].isBanker = true;
}

server.listen(PORT, () => {
  console.log(`Pokdeng multiplayer server (public tables) listening on port ${PORT}`);
});
