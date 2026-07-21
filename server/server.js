const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const Logic = require('../shared/gameLogic.js');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3001;
const STARTING_CHIPS = 1000;
const STARTING_DIAMONDS = 30;
const MAX_PLAYERS = 6;
const AUTO_START_DELAY_MS = 8000;
const NEXT_ROUND_DELAY_MS = 5000;
const BETTING_TIMEOUT_MS = 15000;
const TURN_TIMEOUT_MS = 15000;
const FREE_CHIP_AMOUNT = 500;
const FREE_CHIP_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4시간
const RECONNECT_GRACE_MS = 30000; // 연결 끊김 후 재접속 유예 시간

const DIAMOND_PACKAGES = [
  { id: 'd1', diamonds: 50,   priceLabel: '₩1,100 (~33 THB)' },
  { id: 'd2', diamonds: 280,  priceLabel: '₩5,500 (~165 THB)' },
  { id: 'd3', diamonds: 600,  priceLabel: '₩11,000 (~330 THB)', bonus: '+40 보너스' },
  { id: 'd4', diamonds: 1300, priceLabel: '₩22,000 (~660 THB)', bonus: '+120 보너스' },
  { id: 'd5', diamonds: 3400, priceLabel: '₩55,000 (~1,650 THB)', bonus: '+400 보너스' },
  { id: 'd6', diamonds: 7200, priceLabel: '₩110,000 (~3,300 THB)', bonus: '+1000 보너스' },
];
const EXCHANGE_RATES = [
  { id: 'e1', diamonds: 5,   chips: 500 },
  { id: 'e2', diamonds: 20,  chips: 2200 },
  { id: 'e3', diamonds: 50,  chips: 6000 },
  { id: 'e4', diamonds: 150, chips: 20000 },
];
const TIERS = [
  { id: 1, name: '연습 테이블',  icon: '🌱', minBet: 10 },
  { id: 2, name: '브론즈 테이블', icon: '🥉', minBet: 100 },
  { id: 3, name: '실버 테이블',  icon: '🥈', minBet: 500 },
  { id: 4, name: '골드 테이블',  icon: '🥇', minBet: 2000 },
  { id: 5, name: '플래티넘 테이블', icon: '💠', minBet: 10000 },
  { id: 6, name: 'VIP 다이아 테이블', icon: '👑', minBet: 50000 },
];

/** wallets[clientId] = { chips, diamonds, lastFreeClaim } — clientId는 브라우저에 저장되는 영구 식별자 */
const wallets = {};
function getWallet(clientId) {
  if (!wallets[clientId]) wallets[clientId] = {
    chips: STARTING_CHIPS, diamonds: STARTING_DIAMONDS, lastFreeClaim: 0,
    stats: { roundsPlayed: 0, wins: 0, losses: 0, pushes: 0 }
  };
  return wallets[clientId];
}

/** rooms[roomId] = {
 *   id, tierId, roomNumber, name, icon, minBet,
 *   players: [{id(socketId), clientId, name, balance, bet, hand, decision, connected, isBanker, reconnectTimer}],
 *   phase, deck, turnQueue, turnIndex, round, countdownTimer, countdownEndsAt, phaseTimer, phaseTimerEndsAt
 * } */
const rooms = {};
const roomCounters = {};
function createRoom(tierId) {
  const tier = TIERS.find(t => t.id === tierId);
  roomCounters[tierId] = (roomCounters[tierId] || 0) + 1;
  const num = roomCounters[tierId];
  const roomId = `${tierId}-${num}`;
  rooms[roomId] = {
    id: roomId, tierId, roomNumber: num, name: `${tier.name} #${num}`, icon: tier.icon, minBet: tier.minBet,
    players: [], phase: 'lobby', deck: [], turnQueue: [], turnIndex: 0, round: 0,
    countdownTimer: null, countdownEndsAt: null, phaseTimer: null, phaseTimerEndsAt: null
  };
  return rooms[roomId];
}
for (const tier of TIERS) createRoom(tier.id);

function roomsForTier(tierId) { return Object.values(rooms).filter(r => r.tierId === tierId); }
function activeCount(room) { return room.players.filter(p => p.connected).length; }

function ensureAvailableRoom(tierId) {
  const list = roomsForTier(tierId);
  const hasOpen = list.some(r => r.phase === 'lobby' && activeCount(r) < MAX_PLAYERS);
  if (!hasOpen) createRoom(tierId);
}
function cleanupEmptyRooms(tierId) {
  const list = roomsForTier(tierId).filter(r => r.phase === 'lobby' && activeCount(r) === 0);
  if (list.length > 1) {
    list.sort((a, b) => a.roomNumber - b.roomNumber);
    for (let i = 1; i < list.length; i++) delete rooms[list[i].id];
  }
}

function lobbySummary() {
  return TIERS.map(tier => ({
    id: tier.id, name: tier.name, icon: tier.icon, minBet: tier.minBet,
    rooms: roomsForTier(tier.id)
      .map(r => ({ id: r.id, roomNumber: r.roomNumber, playerCount: activeCount(r), maxPlayers: MAX_PLAYERS, phase: r.phase, round: r.round }))
      .sort((a, b) => a.roomNumber - b.roomNumber)
  }));
}
function broadcastLobby() { io.emit('lobbyUpdate', lobbySummary()); }

function currentTurnClientId(room) {
  const socketId = room.turnQueue ? room.turnQueue[room.turnIndex] : null;
  if (!socketId) return null;
  const pl = room.players.find(p => p.id === socketId);
  return pl ? pl.clientId : null;
}
function publicRoomState(room, forClientId) {
  const revealAll = room.phase === 'resolved';
  return {
    id: room.id, name: room.name, icon: room.icon, minBet: room.minBet,
    phase: room.phase, round: room.round,
    turnPlayerId: currentTurnClientId(room),
    countdownEndsAt: room.countdownEndsAt,
    phaseTimerEndsAt: room.phaseTimerEndsAt,
    players: room.players.map(p => ({
      id: p.clientId, name: p.name, balance: p.balance, bet: p.bet,
      isBanker: p.isBanker, connected: p.connected,
      hand: (revealAll || p.clientId === forClientId || p.hand.length === 0) ? p.hand : p.hand.map(() => null),
      result: p.result || null, handName: revealAll ? p.handName : null
    }))
  };
}
function broadcastRoom(room) {
  for (const p of room.players) io.to(p.id).emit('roomUpdate', publicRoomState(room, p.clientId));
  broadcastLobby();
}
function findRoomBySocket(socketId) { return Object.values(rooms).find(r => r.players.some(p => p.id === socketId)); }
function findRoomByClientId(clientId) { return Object.values(rooms).find(r => r.players.some(p => p.clientId === clientId)); }
function syncWalletFromRoom(room) {
  for (const p of room.players) {
    const w = getWallet(p.clientId);
    w.chips = p.balance;
    io.to(p.id).emit('walletUpdate', w);
  }
}
function clearPhaseTimer(room) {
  if (room.phaseTimer) clearTimeout(room.phaseTimer);
  room.phaseTimer = null;
  room.phaseTimerEndsAt = null;
}
function clearCountdown(room) {
  if (room.countdownTimer) clearTimeout(room.countdownTimer);
  room.countdownTimer = null;
  room.countdownEndsAt = null;
}

function joinRoomInternal(socket, room, name) {
  const clientId = socket.data.clientId;
  if (findRoomByClientId(clientId)) return socket.emit('errorMsg', '이미 다른 방에 참가 중입니다.');
  if (activeCount(room) >= MAX_PLAYERS) return socket.emit('errorMsg', '방이 가득 찼습니다. 다른 방을 선택해주세요.');
  if (room.phase !== 'lobby') return socket.emit('errorMsg', '라운드가 진행 중입니다. 다른 방을 선택해주세요.');

  const wallet = getWallet(clientId);
  if (wallet.chips < room.minBet) return socket.emit('errorMsg', `이 방은 최소 ${room.minBet.toLocaleString()} 칩이 필요합니다. 마켓에서 칩을 충전해주세요.`);

  const isFirst = room.players.length === 0;
  room.players.push({
    id: socket.id, clientId, name: (name || '플레이어').slice(0, 12),
    balance: wallet.chips, bet: 0, hand: [], decision: null,
    connected: true, isBanker: isFirst, reconnectTimer: null
  });
  socket.join('room-' + room.id);
  socket.data.roomId = room.id;
  ensureAvailableRoom(room.tierId);
  maybeStartCountdown(room);
  broadcastRoom(room);
}

io.on('connection', (socket) => {
  socket.on('identify', ({ clientId, name }) => {
    const cid = clientId || crypto.randomUUID();
    socket.data.clientId = cid;
    const wallet = getWallet(cid);
    socket.emit('identified', { clientId: cid });
    socket.emit('walletUpdate', wallet);

    // 재접속 처리: 같은 clientId로 참여 중이던 방이 있으면 자동 복귀
    const room = findRoomByClientId(cid);
    if (room) {
      const p = room.players.find(pl => pl.clientId === cid);
      if (p) {
        if (p.reconnectTimer) { clearTimeout(p.reconnectTimer); p.reconnectTimer = null; }
        p.id = socket.id;
        p.connected = true;
        if (name) p.name = name.slice(0, 12);
        socket.join('room-' + room.id);
        socket.data.roomId = room.id;
        broadcastRoom(room);
        socket.emit('reconnectedToRoom', { roomId: room.id });
      }
    }
    socket.emit('lobbyUpdate', lobbySummary());
  });

  socket.on('getWallet', () => {
    if (!socket.data.clientId) return;
    socket.emit('walletUpdate', getWallet(socket.data.clientId));
  });
  socket.on('getLobby', () => socket.emit('lobbyUpdate', lobbySummary()));

  socket.on('purchaseDiamonds', ({ packageId }) => {
    if (!socket.data.clientId) return;
    const pkg = DIAMOND_PACKAGES.find(p => p.id === packageId);
    if (!pkg) return socket.emit('errorMsg', '존재하지 않는 상품입니다.');
    const wallet = getWallet(socket.data.clientId);
    wallet.diamonds += pkg.diamonds;
    socket.emit('walletUpdate', wallet);
    socket.emit('purchaseSuccess', { type: 'diamond', amount: pkg.diamonds });
  });

  socket.on('exchangeDiamonds', ({ exchangeId }) => {
    if (!socket.data.clientId) return;
    const rate = EXCHANGE_RATES.find(r => r.id === exchangeId);
    if (!rate) return socket.emit('errorMsg', '존재하지 않는 교환 상품입니다.');
    const wallet = getWallet(socket.data.clientId);
    if (wallet.diamonds < rate.diamonds) return socket.emit('errorMsg', '다이아가 부족합니다.');
    wallet.diamonds -= rate.diamonds;
    wallet.chips += rate.chips;
    socket.emit('walletUpdate', wallet);
    socket.emit('purchaseSuccess', { type: 'chip', amount: rate.chips });
    const room = findRoomByClientId(socket.data.clientId);
    if (room) {
      const p = room.players.find(pl => pl.clientId === socket.data.clientId);
      if (p && room.phase === 'lobby') { p.balance = wallet.chips; broadcastRoom(room); }
    }
  });

  socket.on('claimFreeChips', () => {
    if (!socket.data.clientId) return;
    const wallet = getWallet(socket.data.clientId);
    const elapsed = Date.now() - (wallet.lastFreeClaim || 0);
    if (elapsed < FREE_CHIP_COOLDOWN_MS) {
      return socket.emit('errorMsg', `무료 칩은 ${Math.ceil((FREE_CHIP_COOLDOWN_MS - elapsed) / 60000)}분 후에 다시 받을 수 있어요.`);
    }
    wallet.chips += FREE_CHIP_AMOUNT;
    wallet.lastFreeClaim = Date.now();
    socket.emit('walletUpdate', wallet);
    socket.emit('purchaseSuccess', { type: 'chip', amount: FREE_CHIP_AMOUNT });
    const room = findRoomByClientId(socket.data.clientId);
    if (room) {
      const p = room.players.find(pl => pl.clientId === socket.data.clientId);
      if (p && room.phase === 'lobby') { p.balance = wallet.chips; broadcastRoom(room); }
    }
  });

  // ===== 직접 선택 입장 =====
  socket.on('joinRoom', ({ roomId, name }) => {
    if (!socket.data.clientId) return socket.emit('errorMsg', '연결 초기화 중입니다. 잠시 후 다시 시도해주세요.');
    const room = rooms[roomId];
    if (!room) return socket.emit('errorMsg', '존재하지 않는 방입니다. 목록을 새로고침해주세요.');
    joinRoomInternal(socket, room, name);
  });

  // ===== 빠른 매칭 =====
  socket.on('quickMatch', ({ tierId, name }) => {
    if (!socket.data.clientId) return socket.emit('errorMsg', '연결 초기화 중입니다. 잠시 후 다시 시도해주세요.');
    const tier = TIERS.find(t => t.id === tierId);
    if (!tier) return socket.emit('errorMsg', '존재하지 않는 테이블 단계입니다.');
    const wallet = getWallet(socket.data.clientId);
    if (wallet.chips < tier.minBet) return socket.emit('errorMsg', `이 단계는 최소 ${tier.minBet.toLocaleString()} 칩이 필요합니다. 마켓에서 칩을 충전해주세요.`);

    const candidates = roomsForTier(tierId).filter(r => r.phase === 'lobby' && activeCount(r) < MAX_PLAYERS);
    candidates.sort((a, b) => activeCount(b) - activeCount(a)); // 이미 사람이 있는 방을 우선 매칭
    const room = candidates[0] || createRoom(tierId);
    joinRoomInternal(socket, room, name);
  });

  socket.on('updateName', ({ name }) => {
    if (!name || !socket.data.clientId) return;
    const trimmed = name.slice(0, 12);
    const room = findRoomBySocket(socket.id);
    if (room) {
      const p = room.players.find(pl => pl.id === socket.id);
      if (p) { p.name = trimmed; broadcastRoom(room); }
    }
    socket.emit('nameUpdated', { name: trimmed });
  });

  socket.on('leaveTable', () => handleLeave(socket, true));

  socket.on('placeBet', ({ amount }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'betting') return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p || p.isBanker) return;
    amount = Math.max(0, Math.min(amount, p.balance));
    if (amount > 0 && amount < room.minBet) return socket.emit('errorMsg', `최소 베팅액은 ${room.minBet.toLocaleString()} 칩입니다.`);
    p.bet = amount;
    broadcastRoom(room);
    checkAllBetsIn(room);
  });

  socket.on('decision', ({ action }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'turns') return;
    if (room.turnQueue[room.turnIndex] !== socket.id) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (action === 'hit' && p.hand.length < 3) p.hand.push(room.deck.pop());
    p.decision = 'done';
    advanceTurn(room);
  });

  socket.on('disconnect', () => handleLeave(socket, false));
});

function removePlayerFromRoom(room, clientId) {
  const idx = room.players.findIndex(pl => pl.clientId === clientId);
  if (idx === -1) return;
  const wasBanker = room.players[idx].isBanker;
  room.players.splice(idx, 1);
  if (wasBanker && room.players.length > 0) room.players[0].isBanker = true;
  if (activeCount(room) < 2) clearCountdown(room);
  if (room.phase === 'lobby') cleanupEmptyRooms(room.tierId);
  broadcastRoom(room);
  broadcastLobby();
}

function handleLeave(socket, explicit) {
  const room = findRoomBySocket(socket.id);
  if (!room) return;
  const clientId = socket.data.clientId;
  const p = room.players.find(pl => pl.id === socket.id);
  if (p) { getWallet(clientId).chips = p.balance; p.connected = false; }

  if (explicit) {
    socket.leave('room-' + room.id);
    removePlayerFromRoom(room, clientId);
    return;
  }
  // 비자발적 연결 끊김(새로고침/네트워크 문제) → 유예 시간 후 제거 (그 사이 재접속하면 identify에서 복구)
  if (p) {
    p.reconnectTimer = setTimeout(() => {
      const stillThere = room.players.find(pl => pl.clientId === clientId);
      if (stillThere && !stillThere.connected) {
        if (room.phase === 'lobby') removePlayerFromRoom(room, clientId);
        else stillThere.connected = false; // 라운드 끝나면 resolveRound에서 정리
      }
    }, RECONNECT_GRACE_MS);
  }
  broadcastRoom(room);
}

function maybeStartCountdown(room) {
  if (room.phase === 'lobby' && activeCount(room) >= 2 && !room.countdownTimer) {
    room.countdownEndsAt = Date.now() + AUTO_START_DELAY_MS;
    room.countdownTimer = setTimeout(() => {
      room.countdownTimer = null;
      room.countdownEndsAt = null;
      if (activeCount(room) >= 2) startBettingPhase(room);
    }, AUTO_START_DELAY_MS);
  }
}

function startBettingPhase(room) {
  clearCountdown(room);
  room.round += 1;
  room.deck = Logic.buildDeck();
  for (const p of room.players) { p.hand = []; p.bet = 0; p.decision = null; p.result = null; p.handName = null; }
  room.phase = 'betting';
  clearPhaseTimer(room);
  room.phaseTimerEndsAt = Date.now() + BETTING_TIMEOUT_MS;
  room.phaseTimer = setTimeout(() => autoBetTimeout(room), BETTING_TIMEOUT_MS);
  broadcastRoom(room);
}

function autoBetTimeout(room) {
  if (room.phase !== 'betting') return;
  room.players = room.players.filter(p => {
    if (p.isBanker || p.bet > 0) return true;
    if (p.balance <= 0) return false;
    p.bet = Math.min(room.minBet, p.balance);
    return true;
  });
  clearPhaseTimer(room);
  if (room.players.length < 2) { room.phase = 'lobby'; broadcastRoom(room); return; }
  broadcastRoom(room);
  checkAllBetsIn(room);
}

function checkAllBetsIn(room) {
  const bettors = room.players.filter(p => !p.isBanker && p.connected);
  if (bettors.length === 0) return;
  if (bettors.every(p => p.bet > 0)) dealCards(room);
}

function dealCards(room) {
  clearPhaseTimer(room);
  for (const p of room.players) p.hand = [room.deck.pop(), room.deck.pop()];
  room.phase = 'turns';
  room.turnQueue = room.players.filter(p => !p.isBanker).map(p => p.id);
  room.players.forEach(p => { if (Logic.isPok(p.hand)) p.decision = 'done'; });
  const banker = room.players.find(p => p.isBanker);
  if (banker) room.turnQueue.push(banker.id);
  room.turnIndex = 0;
  skipAutoDoneAndAdvance(room);
  broadcastRoom(room);
}

function skipAutoDoneAndAdvance(room) {
  while (room.turnIndex < room.turnQueue.length) {
    const pid = room.turnQueue[room.turnIndex];
    const p = room.players.find(pl => pl.id === pid);
    if (p && p.decision === 'done') { room.turnIndex += 1; continue; }
    clearPhaseTimer(room);
    room.phaseTimerEndsAt = Date.now() + TURN_TIMEOUT_MS;
    room.phaseTimer = setTimeout(() => autoStayTimeout(room), TURN_TIMEOUT_MS);
    return;
  }
  clearPhaseTimer(room);
  resolveRound(room);
}

function autoStayTimeout(room) {
  if (room.phase !== 'turns') return;
  const pid = room.turnQueue[room.turnIndex];
  const p = room.players.find(pl => pl.id === pid);
  if (p) p.decision = 'done';
  advanceTurn(room);
}

function advanceTurn(room) {
  room.turnIndex += 1;
  skipAutoDoneAndAdvance(room);
  broadcastRoom(room);
}

function resolveRound(room) {
  const banker = room.players.find(p => p.isBanker);
  const bankerStats = getWallet(banker.clientId).stats;
  bankerStats.roundsPlayed += 1;
  let bankerNet = 0;
  for (const p of room.players) {
    if (p.isBanker) continue;
    const cmp = Logic.compareToBanker(p.hand, banker.hand);
    p.handName = cmp.playerHandName;
    banker.handName = cmp.bankerHandName;
    const pStats = getWallet(p.clientId).stats;
    pStats.roundsPlayed += 1;
    if (cmp.result === 'playerWin') {
      const amt = p.bet * cmp.mult; p.balance += amt; banker.balance -= amt; p.result = `+${amt}`;
      pStats.wins += 1; bankerNet -= 1;
    } else if (cmp.result === 'bankerWin') {
      const amt = p.bet * cmp.mult; p.balance -= amt; banker.balance += amt; p.result = `-${amt}`;
      pStats.losses += 1; bankerNet += 1;
    } else { p.result = 'push'; pStats.pushes += 1; }
  }
  if (bankerNet > 0) bankerStats.wins += 1; else if (bankerNet < 0) bankerStats.losses += 1; else bankerStats.pushes += 1;
  room.phase = 'resolved';
  syncWalletFromRoom(room);
  broadcastRoom(room);

  setTimeout(() => {
    room.players = room.players.filter(p => p.connected);
    if (room.players.length >= 2) {
      rotateBanker(room);
      room.phase = 'lobby';
      maybeStartCountdown(room);
    } else {
      room.phase = 'lobby';
    }
    cleanupEmptyRooms(room.tierId);
    ensureAvailableRoom(room.tierId);
    broadcastRoom(room);
  }, NEXT_ROUND_DELAY_MS);
}

function rotateBanker(room) {
  const idx = room.players.findIndex(p => p.isBanker);
  if (idx === -1) { if (room.players[0]) room.players[0].isBanker = true; return; }
  room.players[idx].isBanker = false;
  const nextIdx = (idx + 1) % room.players.length;
  room.players[nextIdx].isBanker = true;
}

app.get('/api/market', (req, res) => {
  res.json({ diamondPackages: DIAMOND_PACKAGES, exchangeRates: EXCHANGE_RATES, freeChipAmount: FREE_CHIP_AMOUNT, freeChipCooldownMs: FREE_CHIP_COOLDOWN_MS });
});

server.listen(PORT, () => {
  console.log(`Pokdeng multiplayer server listening on port ${PORT}`);
});
