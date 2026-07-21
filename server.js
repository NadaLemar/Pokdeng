// ============================================================
// Pokdeng (포크덩) - social multiplayer web app
// NO REAL MONEY: 🪙 Chips are play currency used only for in-game
// bets. 💎 Diamonds are a premium currency (mock IAP in this demo)
// that can be exchanged for Chips. Nothing here touches real funds.
// ============================================================

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const {
  createDeck,
  shuffle,
  evaluateHand,
  compareHands
} = require('./game/pokdeng');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// Config
// ------------------------------------------------------------
const TIERS = [
  { id: 'practice', name: '연습', emoji: '🌱', bet: 0, roomsPerTier: 2 },
  { id: 'bronze', name: '브론즈', emoji: '🥉', bet: 100, roomsPerTier: 3 },
  { id: 'silver', name: '실버', emoji: '🥈', bet: 500, roomsPerTier: 3 },
  { id: 'gold', name: '골드', emoji: '🥇', bet: 2000, roomsPerTier: 2 },
  { id: 'platinum', name: '플래티넘', emoji: '💠', bet: 10000, roomsPerTier: 2 },
  { id: 'vip', name: 'VIP', emoji: '👑', bet: 50000, roomsPerTier: 1 }
];

const MAX_SEATS = 6;
const JOIN_PHASE_MS = 8000;
const TURN_MS = 10000;
const RESULTS_MS = 7000;
const FREE_CHIP_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const FREE_CHIP_AMOUNT = 3000;
const STARTING_CHIPS = 10000;
const STARTING_DIAMONDS = 50;
const DIAMOND_TO_CHIP_RATE = 1000; // 1 diamond -> 1000 chips

const DIAMOND_PACKAGES = [
  { id: 'pack_small', diamonds: 50, priceLabel: '₩1,200' },
  { id: 'pack_medium', diamonds: 300, priceLabel: '₩6,000' },
  { id: 'pack_large', diamonds: 700, priceLabel: '₩12,000' },
  { id: 'pack_mega', diamonds: 1600, priceLabel: '₩24,000' }
];

// ------------------------------------------------------------
// In-memory state
// ------------------------------------------------------------
/** clientId -> player record */
const players = new Map();
/** socket.id -> clientId (for quick lookup on disconnect) */
const socketToClient = new Map();
/** roomId -> room record */
const rooms = new Map();

function makePlayer(clientId) {
  return {
    clientId,
    nickname: `손님${clientId.slice(0, 4)}`,
    chips: STARTING_CHIPS,
    diamonds: STARTING_DIAMONDS,
    wins: 0,
    losses: 0,
    pushes: 0,
    gamesPlayed: 0,
    soundEnabled: true,
    lastFreeChipClaim: 0,
    currentRoom: null,
    socketId: null
  };
}

function createRoom(tier, index) {
  const id = `${tier.id}-${index}`;
  return {
    id,
    tierId: tier.id,
    tierName: tier.name,
    bet: tier.bet,
    seats: [], // { clientId, nickname, cards, evalResult, action, hasActed, isBanker, sittingOut }
    maxSeats: MAX_SEATS,
    state: 'waiting', // waiting -> dealing -> turns -> banker_turn -> results
    bankerSeatIndex: 0,
    turnSeatIndex: 0,
    deck: [],
    phaseEndsAt: 0,
    timer: null
  };
}

for (const tier of TIERS) {
  for (let i = 1; i <= tier.roomsPerTier; i++) {
    const room = createRoom(tier, i);
    rooms.set(room.id, room);
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function getOrCreatePlayer(clientId) {
  let p = players.get(clientId);
  if (!p) {
    p = makePlayer(clientId);
    players.set(clientId, p);
  }
  return p;
}

function publicPlayer(p) {
  return {
    clientId: p.clientId,
    nickname: p.nickname,
    chips: p.chips,
    diamonds: p.diamonds,
    wins: p.wins,
    losses: p.losses,
    pushes: p.pushes,
    gamesPlayed: p.gamesPlayed,
    soundEnabled: p.soundEnabled,
    nextFreeChipAt: p.lastFreeChipClaim + FREE_CHIP_INTERVAL_MS
  };
}

function lobbySnapshot() {
  return TIERS.map((tier) => ({
    id: tier.id,
    name: tier.name,
    emoji: tier.emoji,
    bet: tier.bet,
    rooms: [...rooms.values()]
      .filter((r) => r.tierId === tier.id)
      .map((r) => ({
        id: r.id,
        playerCount: r.seats.filter((s) => s).length,
        maxSeats: r.maxSeats,
        state: r.state
      }))
  }));
}

function broadcastLobby() {
  io.emit('lobby', lobbySnapshot());
}

/** Build the view of a room sent to a specific clientId (hides other players' hole cards pre-reveal). */
function roomView(room, viewerClientId) {
  const revealing = room.state === 'results';
  return {
    id: room.id,
    tierId: room.tierId,
    tierName: room.tierName,
    bet: room.bet,
    state: room.state,
    maxSeats: room.maxSeats,
    bankerSeatIndex: room.bankerSeatIndex,
    turnSeatIndex: room.state === 'turns' ? room.turnSeatIndex : -1,
    phaseEndsAt: room.phaseEndsAt,
    seats: room.seats.map((s, idx) => {
      if (!s) return null;
      const isSelf = s.clientId === viewerClientId;
      const showCards = revealing || isSelf;
      return {
        seatIndex: idx,
        clientId: s.clientId,
        nickname: s.nickname,
        isBanker: idx === room.bankerSeatIndex,
        sittingOut: !!s.sittingOut,
        cardCount: s.cards ? s.cards.length : 0,
        cards: showCards ? s.cards || [] : null,
        evalResult: showCards ? s.evalResult || null : null,
        outcome: revealing ? s.outcome || null : null,
        delta: revealing ? s.delta || 0 : null,
        hasActed: s.hasActed || false,
        action: s.action || null
      };
    })
  };
}

function broadcastRoom(room) {
  for (const seat of room.seats) {
    if (!seat) continue;
    const p = players.get(seat.clientId);
    if (p && p.socketId) {
      io.to(p.socketId).emit('roomState', roomView(room, seat.clientId));
    }
  }
  broadcastLobby();
}

function seatCount(room) {
  return room.seats.filter((s) => s).length;
}

function findOpenSeat(room) {
  for (let i = 0; i < room.maxSeats; i++) {
    if (!room.seats[i]) return i;
  }
  return -1;
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function leaveRoom(clientId) {
  const p = players.get(clientId);
  if (!p || !p.currentRoom) return;
  const room = rooms.get(p.currentRoom);
  if (room) {
    const idx = room.seats.findIndex((s) => s && s.clientId === clientId);
    if (idx !== -1) {
      // Only allow instant removal during waiting phase; otherwise mark sittingOut
      if (room.state === 'waiting') {
        room.seats[idx] = null;
      } else {
        room.seats[idx].sittingOut = true;
      }
    }
    broadcastRoom(room);
  }
  p.currentRoom = null;
}

// ------------------------------------------------------------
// Game flow
// ------------------------------------------------------------
function startWaitingCountdown(room) {
  clearRoomTimer(room);
  room.state = 'waiting';
  room.phaseEndsAt = Date.now() + JOIN_PHASE_MS;
  broadcastRoom(room);
  room.timer = setTimeout(() => tryStartDealing(room), JOIN_PHASE_MS);
}

function tryStartDealing(room) {
  const active = room.seats.filter((s) => s && !s.sittingOut);
  // remove sitting-out (left) players now that round is over
  for (let i = 0; i < room.seats.length; i++) {
    if (room.seats[i] && room.seats[i].sittingOut) {
      room.seats[i] = null;
    }
  }
  if (active.length < 2) {
    // Not enough players yet, keep waiting
    startWaitingCountdown(room);
    return;
  }
  startDealing(room);
}

function startDealing(room) {
  clearRoomTimer(room);
  room.state = 'dealing';
  room.deck = shuffle(createDeck());

  // Charge the bet from every seated player who can afford it; others sit out this round.
  for (let i = 0; i < room.seats.length; i++) {
    const seat = room.seats[i];
    if (!seat) continue;
    const p = players.get(seat.clientId);
    if (!p || p.chips < room.bet) {
      seat.sittingOut = true;
      seat.cards = [];
      continue;
    }
    p.chips -= room.bet;
    seat.sittingOut = false;
    seat.cards = [room.deck.pop(), room.deck.pop()];
    seat.evalResult = evaluateHand(seat.cards);
    seat.action = null;
    seat.hasActed = false;
    seat.outcome = null;
    seat.delta = 0;
  }

  // Ensure a banker exists among active seats; rotate to next active seat.
  ensureValidBanker(room);

  broadcastRoom(room);

  const activeSeats = room.seats.filter((s) => s && !s.sittingOut);
  const anyPok = activeSeats.some((s) => s.evalResult.type === 'pok8' || s.evalResult.type === 'pok9');

  room.timer = setTimeout(() => {
    if (anyPok) {
      resolveRound(room);
    } else {
      startTurnPhase(room);
    }
  }, 1800); // brief "dealing" pause for animation
}

function ensureValidBanker(room) {
  const n = room.seats.length;
  let idx = room.bankerSeatIndex % n;
  for (let i = 0; i < n; i++) {
    const seat = room.seats[(idx + i) % n];
    if (seat && !seat.sittingOut) {
      room.bankerSeatIndex = (idx + i) % n;
      return;
    }
  }
  room.bankerSeatIndex = 0;
}

function nextActiveSeatIndex(room, fromIndex) {
  const n = room.seats.length;
  // step < n (not <=) so we never wrap all the way back around to fromIndex itself
  for (let step = 1; step < n; step++) {
    const idx = (fromIndex + step) % n;
    const seat = room.seats[idx];
    if (seat && !seat.sittingOut && idx !== room.bankerSeatIndex) return idx;
  }
  return -1;
}

function startTurnPhase(room) {
  room.state = 'turns';
  const first = nextActiveSeatIndex(room, room.bankerSeatIndex);
  if (first === -1) {
    startBankerTurn(room);
    return;
  }
  room.turnSeatIndex = first;
  beginPlayerTurn(room);
}

function beginPlayerTurn(room) {
  clearRoomTimer(room);
  room.phaseEndsAt = Date.now() + TURN_MS;
  broadcastRoom(room);
  room.timer = setTimeout(() => {
    // auto-stay on timeout
    handlePlayerAction(room, room.seats[room.turnSeatIndex].clientId, 'stay', true);
  }, TURN_MS);
}

function advanceTurn(room) {
  const next = nextActiveSeatIndex(room, room.turnSeatIndex);
  if (next === -1) {
    startBankerTurn(room);
  } else {
    room.turnSeatIndex = next;
    beginPlayerTurn(room);
  }
}

function handlePlayerAction(room, clientId, action, isAuto = false) {
  const seat = room.seats[room.turnSeatIndex];
  if (!seat || seat.clientId !== clientId || room.state !== 'turns') return;
  clearRoomTimer(room);
  seat.hasActed = true;
  seat.action = action;
  if (action === 'draw' && seat.cards.length < 3) {
    seat.cards.push(room.deck.pop());
    seat.evalResult = evaluateHand(seat.cards);
  }
  broadcastRoom(room);
  advanceTurn(room);
}

function startBankerTurn(room) {
  room.state = 'banker_turn';
  room.turnSeatIndex = room.bankerSeatIndex;
  clearRoomTimer(room);
  room.phaseEndsAt = Date.now() + TURN_MS;
  broadcastRoom(room);
  room.timer = setTimeout(() => {
    handleBankerAction(room, room.seats[room.bankerSeatIndex].clientId, 'stay', true);
  }, TURN_MS);
}

function handleBankerAction(room, clientId, action) {
  const seat = room.seats[room.bankerSeatIndex];
  if (!seat || seat.clientId !== clientId || room.state !== 'banker_turn') return;
  clearRoomTimer(room);
  seat.action = action;
  seat.hasActed = true;
  if (action === 'draw' && seat.cards.length < 3) {
    seat.cards.push(room.deck.pop());
    seat.evalResult = evaluateHand(seat.cards);
  }
  resolveRound(room);
}

function resolveRound(room) {
  room.state = 'results';
  clearRoomTimer(room);
  const bankerSeat = room.seats[room.bankerSeatIndex];
  const bankerEval = bankerSeat ? bankerSeat.evalResult : null;

  for (let i = 0; i < room.seats.length; i++) {
    const seat = room.seats[i];
    if (!seat || seat.sittingOut || i === room.bankerSeatIndex) continue;
    const p = players.get(seat.clientId);
    const result = compareHands(seat.evalResult, bankerEval);
    const bankerP = bankerSeat ? players.get(bankerSeat.clientId) : null;

    if (result.outcome === 'win') {
      const payout = room.bet * result.multiplier;
      p.chips += room.bet + payout; // return original bet + winnings
      if (bankerP) bankerP.chips -= payout;
      seat.outcome = 'win';
      seat.delta = payout;
      p.wins += 1;
    } else if (result.outcome === 'lose') {
      const loss = room.bet * result.multiplier;
      if (bankerP) bankerP.chips += loss;
      seat.outcome = 'lose';
      seat.delta = -room.bet;
      p.losses += 1;
    } else {
      p.chips += room.bet; // push - return bet
      seat.outcome = 'push';
      seat.delta = 0;
      p.pushes += 1;
    }
    p.gamesPlayed += 1;
  }
  if (bankerSeat) {
    const bankerP = players.get(bankerSeat.clientId);
    bankerP.gamesPlayed += 1;
    bankerSeat.outcome = 'banker';
  }

  broadcastRoom(room);
  syncAllPlayerWallets(room);

  // Rotate banker to next active seat for the following round.
  const next = nextActiveSeatIndex(room, room.bankerSeatIndex);
  if (next !== -1) room.bankerSeatIndex = next;

  room.timer = setTimeout(() => startWaitingCountdown(room), RESULTS_MS);
}

function syncAllPlayerWallets(room) {
  for (const seat of room.seats) {
    if (!seat) continue;
    const p = players.get(seat.clientId);
    if (p && p.socketId) {
      io.to(p.socketId).emit('wallet', publicPlayer(p));
    }
  }
}

// ------------------------------------------------------------
// Socket.io wiring
// ------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('identify', ({ clientId }, cb) => {
    if (!clientId || typeof clientId !== 'string') {
      clientId = 'anon_' + Math.random().toString(36).slice(2, 10);
    }
    const p = getOrCreatePlayer(clientId);
    p.socketId = socket.id;
    socketToClient.set(socket.id, clientId);

    if (cb) cb({ clientId, player: publicPlayer(p) });
    socket.emit('lobby', lobbySnapshot());

    // Rejoin room if reconnecting mid-session
    if (p.currentRoom && rooms.has(p.currentRoom)) {
      const room = rooms.get(p.currentRoom);
      const seat = room.seats.find((s) => s && s.clientId === clientId);
      if (seat) {
        seat.sittingOut = false;
        socket.join(room.id);
        socket.emit('roomState', roomView(room, clientId));
      } else {
        p.currentRoom = null;
      }
    }
  });

  socket.on('getLobby', () => {
    socket.emit('lobby', lobbySnapshot());
  });

  socket.on('quickMatch', ({ tierId }) => {
    const clientId = socketToClient.get(socket.id);
    if (!clientId) return;
    const candidates = [...rooms.values()].filter((r) => r.tierId === tierId);
    // Prefer a room already in 'waiting' with an open seat; else any room with an open seat.
    let target =
      candidates.find((r) => r.state === 'waiting' && findOpenSeat(r) !== -1) ||
      candidates.find((r) => findOpenSeat(r) !== -1);
    if (!target) {
      socket.emit('errorMsg', '지금은 입장 가능한 방이 없어요. 잠시 후 다시 시도해주세요.');
      return;
    }
    joinRoom(socket, clientId, target.id);
  });

  socket.on('joinRoom', ({ roomId }) => {
    const clientId = socketToClient.get(socket.id);
    if (!clientId) return;
    joinRoom(socket, clientId, roomId);
  });

  socket.on('leaveRoom', () => {
    const clientId = socketToClient.get(socket.id);
    if (!clientId) return;
    const p = players.get(clientId);
    if (p && p.currentRoom) socket.leave(p.currentRoom);
    leaveRoom(clientId);
  });

  socket.on('playerAction', ({ roomId, action }) => {
    const clientId = socketToClient.get(socket.id);
    if (!clientId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.state === 'turns') handlePlayerAction(room, clientId, action);
    else if (room.state === 'banker_turn') handleBankerAction(room, clientId, action);
  });

  // ---------------- Market ----------------
  socket.on('claimFreeChips', (_, cb) => {
    const clientId = socketToClient.get(socket.id);
    const p = clientId && players.get(clientId);
    if (!p) return;
    const now = Date.now();
    if (now - p.lastFreeChipClaim < FREE_CHIP_INTERVAL_MS) {
      const waitMs = FREE_CHIP_INTERVAL_MS - (now - p.lastFreeChipClaim);
      if (cb) cb({ ok: false, waitMs });
      return;
    }
    p.lastFreeChipClaim = now;
    p.chips += FREE_CHIP_AMOUNT;
    socket.emit('wallet', publicPlayer(p));
    if (cb) cb({ ok: true, amount: FREE_CHIP_AMOUNT, wallet: publicPlayer(p) });
  });

  socket.on('getDiamondPackages', (_, cb) => {
    if (cb) cb(DIAMOND_PACKAGES);
  });

  // Mock IAP purchase - no real payment is processed.
  socket.on('buyDiamonds', ({ packageId }, cb) => {
    const clientId = socketToClient.get(socket.id);
    const p = clientId && players.get(clientId);
    const pack = DIAMOND_PACKAGES.find((d) => d.id === packageId);
    if (!p || !pack) {
      if (cb) cb({ ok: false });
      return;
    }
    p.diamonds += pack.diamonds;
    socket.emit('wallet', publicPlayer(p));
    if (cb) cb({ ok: true, wallet: publicPlayer(p) });
  });

  socket.on('exchangeDiamonds', ({ diamonds }, cb) => {
    const clientId = socketToClient.get(socket.id);
    const p = clientId && players.get(clientId);
    const amount = parseInt(diamonds, 10);
    if (!p || !amount || amount <= 0 || amount > p.diamonds) {
      if (cb) cb({ ok: false });
      return;
    }
    p.diamonds -= amount;
    p.chips += amount * DIAMOND_TO_CHIP_RATE;
    socket.emit('wallet', publicPlayer(p));
    if (cb) cb({ ok: true, wallet: publicPlayer(p) });
  });

  // ---------------- Profile ----------------
  socket.on('setNickname', ({ nickname }, cb) => {
    const clientId = socketToClient.get(socket.id);
    const p = clientId && players.get(clientId);
    if (!p) return;
    const clean = (nickname || '').trim().slice(0, 12);
    if (clean.length < 2) {
      if (cb) cb({ ok: false, reason: '닉네임은 2자 이상이어야 해요.' });
      return;
    }
    p.nickname = clean;
    socket.emit('wallet', publicPlayer(p));
    if (cb) cb({ ok: true, wallet: publicPlayer(p) });
  });

  socket.on('setSound', ({ enabled }) => {
    const clientId = socketToClient.get(socket.id);
    const p = clientId && players.get(clientId);
    if (!p) return;
    p.soundEnabled = !!enabled;
  });

  socket.on('disconnect', () => {
    const clientId = socketToClient.get(socket.id);
    socketToClient.delete(socket.id);
    if (!clientId) return;
    const p = players.get(clientId);
    if (p) {
      p.socketId = null;
      // Keep seat reserved (marked sittingOut) so a refresh can rejoin mid-round.
      if (p.currentRoom) {
        const room = rooms.get(p.currentRoom);
        if (room) {
          const seat = room.seats.find((s) => s && s.clientId === clientId);
          if (seat && room.state === 'waiting') {
            const idx = room.seats.indexOf(seat);
            room.seats[idx] = null;
            p.currentRoom = null;
            broadcastRoom(room);
          }
        }
      }
    }
  });
});

function joinRoom(socket, clientId, roomId) {
  const room = rooms.get(roomId);
  const p = players.get(clientId);
  if (!room || !p) return;

  // Leave previous room first
  if (p.currentRoom && p.currentRoom !== roomId) {
    socket.leave(p.currentRoom);
    leaveRoom(clientId);
  }

  const already = room.seats.find((s) => s && s.clientId === clientId);
  if (!already) {
    const idx = findOpenSeat(room);
    if (idx === -1) {
      socket.emit('errorMsg', '방이 가득 찼어요.');
      return;
    }
    room.seats[idx] = {
      clientId,
      nickname: p.nickname,
      cards: [],
      evalResult: null,
      action: null,
      hasActed: false,
      isBanker: false,
      sittingOut: room.state !== 'waiting', // if joining mid-round, wait for next round
      outcome: null,
      delta: 0
    };
  }
  p.currentRoom = roomId;
  socket.join(roomId);
  socket.emit('roomState', roomView(room, clientId));
  broadcastLobby();

  if (room.state === 'waiting' && seatCount(room) >= 2 && !room.timer) {
    startWaitingCountdown(room);
  } else if (room.state === 'waiting' && !room.timer) {
    // first player joined; nothing to countdown yet but reflect state
    broadcastRoom(room);
  } else {
    broadcastRoom(room);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Pokdeng server running on http://localhost:${PORT}`);
});
