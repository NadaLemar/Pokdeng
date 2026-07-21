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
const STARTING_CHIPS = 1000;
const STARTING_DIAMONDS = 30;
const MAX_PLAYERS = 6;
const AUTO_START_DELAY_MS = 8000;
const NEXT_ROUND_DELAY_MS = 5000;

// ===== 재화 설정 =====
// 다이아(Diamond): 앱스토어/구글플레이 IAP로 구매하는 유료 재화 (지금은 mock 처리)
// 칩(Chip): 실제 베팅에 쓰는 재화. 현금화 불가 — 다이아→칩 교환은 일방향입니다.
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

// ===== 배팅금액별 6단계 테이블 티어 =====
const TIERS = [
  { id: 1, name: '연습 테이블',  icon: '🌱', minBet: 10,    maxPlayers: MAX_PLAYERS },
  { id: 2, name: '브론즈 테이블', icon: '🥉', minBet: 100,   maxPlayers: MAX_PLAYERS },
  { id: 3, name: '실버 테이블',  icon: '🥈', minBet: 500,   maxPlayers: MAX_PLAYERS },
  { id: 4, name: '골드 테이블',  icon: '🥇', minBet: 2000,  maxPlayers: MAX_PLAYERS },
  { id: 5, name: '플래티넘 테이블', icon: '💠', minBet: 10000, maxPlayers: MAX_PLAYERS },
  { id: 6, name: 'VIP 다이아 테이블', icon: '👑', minBet: 50000, maxPlayers: MAX_PLAYERS },
];

/** wallets[socketId] = { chips, diamonds }  — 로비/마켓/테이블 전체에서 공유되는 유저 지갑 */
const wallets = {};

/** tables[id] = {
 *   id, name, icon, minBet,
 *   players: [{id,name,balance,bet,hand,decision,connected,isBanker}],
 *   phase, deck, turnQueue, turnIndex, round, countdownEndsAt
 * } */
const tables = {};
for (const tier of TIERS) {
  tables[tier.id] = {
    id: tier.id,
    name: tier.name,
    icon: tier.icon,
    minBet: tier.minBet,
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

function getWallet(id) {
  if (!wallets[id]) wallets[id] = { chips: STARTING_CHIPS, diamonds: STARTING_DIAMONDS };
  return wallets[id];
}

function lobbySummary() {
  return Object.values(tables).map(t => ({
    id: t.id,
    name: t.name,
    icon: t.icon,
    minBet: t.minBet,
    playerCount: t.players.filter(p => p.connected).length,
    maxPlayers: MAX_PLAYERS,
    phase: t.phase,
    round: t.round
  }));
}
function broadcastLobby() { io.emit('lobbyUpdate', lobbySummary()); }

function publicTableState(table, forId) {
  const revealAll = table.phase === 'resolved';
  return {
    id: table.id, name: table.name, icon: table.icon, minBet: table.minBet,
    phase: table.phase, round: table.round,
    turnPlayerId: table.turnQueue ? table.turnQueue[table.turnIndex] : null,
    countdownEndsAt: table.countdownEndsAt,
    players: table.players.map(p => ({
      id: p.id, name: p.name, balance: p.balance, bet: p.bet,
      isBanker: p.isBanker, connected: p.connected,
      hand: (revealAll || p.id === forId || p.hand.length === 0) ? p.hand : p.hand.map(() => null),
      result: p.result || null, handName: revealAll ? p.handName : null
    }))
  };
}
function broadcastTable(table) {
  for (const p of table.players) io.to(p.id).emit('tableUpdate', publicTableState(table, p.id));
  broadcastLobby();
}
function findTableByPlayer(socketId) {
  return Object.values(tables).find(t => t.players.some(p => p.id === socketId));
}
function syncWalletFromTable(table) {
  for (const p of table.players) {
    const w = getWallet(p.id);
    w.chips = p.balance;
    io.to(p.id).emit('walletUpdate', w);
  }
}

io.on('connection', (socket) => {
  const w = getWallet(socket.id);
  socket.emit('walletUpdate', w);
  socket.emit('lobbyUpdate', lobbySummary());

  socket.on('getWallet', () => socket.emit('walletUpdate', getWallet(socket.id)));
  socket.on('getLobby', () => socket.emit('lobbyUpdate', lobbySummary()));

  // ===== 마켓: 다이아 구매 (실제 서비스에서는 App Store/Google Play 영수증 검증 필요. 지금은 mock) =====
  socket.on('purchaseDiamonds', ({ packageId }) => {
    const pkg = DIAMOND_PACKAGES.find(p => p.id === packageId);
    if (!pkg) return socket.emit('errorMsg', '존재하지 않는 상품입니다.');
    const wallet = getWallet(socket.id);
    wallet.diamonds += pkg.diamonds;
    socket.emit('walletUpdate', wallet);
    socket.emit('purchaseSuccess', { type: 'diamond', amount: pkg.diamonds });
  });

  // ===== 마켓: 다이아 → 칩 교환 (일방향, 칩→다이아 및 현금화 불가) =====
  socket.on('exchangeDiamonds', ({ exchangeId }) => {
    const rate = EXCHANGE_RATES.find(r => r.id === exchangeId);
    if (!rate) return socket.emit('errorMsg', '존재하지 않는 교환 상품입니다.');
    const wallet = getWallet(socket.id);
    if (wallet.diamonds < rate.diamonds) return socket.emit('errorMsg', '다이아가 부족합니다.');
    wallet.diamonds -= rate.diamonds;
    wallet.chips += rate.chips;
    socket.emit('walletUpdate', wallet);
    socket.emit('purchaseSuccess', { type: 'chip', amount: rate.chips });

    const table = findTableByPlayer(socket.id);
    if (table) {
      const p = table.players.find(pl => pl.id === socket.id);
      if (p && table.phase === 'lobby') { p.balance = wallet.chips; broadcastTable(table); }
    }
  });

  socket.on('joinTable', ({ tableId, name }) => {
    const table = tables[tableId];
    if (!table) return socket.emit('errorMsg', '존재하지 않는 테이블입니다.');
    if (findTableByPlayer(socket.id)) return;
    const activeCount = table.players.filter(p => p.connected).length;
    if (activeCount >= MAX_PLAYERS) return socket.emit('errorMsg', '테이블이 가득 찼습니다. 다른 테이블을 선택해주세요.');
    if (table.phase !== 'lobby') return socket.emit('errorMsg', '라운드가 진행 중입니다. 다음 라운드를 기다려주세요.');

    const wallet = getWallet(socket.id);
    if (wallet.chips < table.minBet) return socket.emit('errorMsg', `이 테이블은 최소 ${table.minBet.toLocaleString()} 칩이 필요합니다. 마켓에서 칩을 충전해주세요.`);

    const isFirst = table.players.length === 0;
    table.players.push({
      id: socket.id, name: (name || '플레이어').slice(0, 12),
      balance: wallet.chips, bet: 0, hand: [], decision: null,
      connected: true, isBanker: isFirst
    });
    socket.join('table-' + tableId);
    socket.data.tableId = tableId;

    maybeStartCountdown(table);
    broadcastTable(table);
  });

  socket.on('leaveTable', () => handleLeave(socket, true));

  socket.on('placeBet', ({ amount }) => {
    const table = findTableByPlayer(socket.id);
    if (!table || table.phase !== 'betting') return;
    const p = table.players.find(pl => pl.id === socket.id);
    if (!p || p.isBanker) return;
    amount = Math.max(0, Math.min(amount, p.balance));
    if (amount > 0 && amount < table.minBet) return socket.emit('errorMsg', `최소 베팅액은 ${table.minBet.toLocaleString()} 칩입니다.`);
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

  socket.on('disconnect', () => handleLeave(socket, false));
});

function handleLeave(socket, explicit) {
  const table = findTableByPlayer(socket.id);
  if (!table) return;
  const wallet = getWallet(socket.id);
  const p = table.players.find(pl => pl.id === socket.id);
  if (p) { wallet.chips = p.balance; p.connected = false; }
  if (table.phase === 'lobby' || explicit) {
    const idx = table.players.findIndex(pl => pl.id === socket.id);
    if (idx !== -1) {
      const wasBanker = table.players[idx].isBanker;
      table.players.splice(idx, 1);
      if (wasBanker && table.players.length > 0) table.players[0].isBanker = true;
    }
    if (table.players.filter(p => p.connected).length < 2) clearCountdown(table);
  }
  if (explicit) socket.leave('table-' + table.id);
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
  for (const p of table.players) { p.hand = []; p.bet = 0; p.decision = null; p.result = null; p.handName = null; }
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
      const amt = p.bet * cmp.mult; p.balance += amt; banker.balance -= amt; p.result = `+${amt}`;
    } else if (cmp.result === 'bankerWin') {
      const amt = p.bet * cmp.mult; p.balance -= amt; banker.balance += amt; p.result = `-${amt}`;
    } else { p.result = 'push'; }
  }
  table.phase = 'resolved';
  syncWalletFromTable(table);
  broadcastTable(table);

  setTimeout(() => {
    table.players = table.players.filter(p => p.connected);
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

// 클라이언트에 마켓 상품 정의를 내려주는 REST 엔드포인트 (소켓 연결 전에도 조회 가능)
app.get('/api/market', (req, res) => {
  res.json({ diamondPackages: DIAMOND_PACKAGES, exchangeRates: EXCHANGE_RATES });
});

server.listen(PORT, () => {
  console.log(`Pokdeng multiplayer server listening on port ${PORT}`);
});
