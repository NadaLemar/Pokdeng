(() => {
  'use strict';

  // ---------------- Persistent client identity ----------------
  const CLIENT_ID_KEY = 'pokdeng_client_id';
  let clientId = localStorage.getItem(CLIENT_ID_KEY);
  if (!clientId) {
    clientId = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem(CLIENT_ID_KEY, clientId);
  }

  const socket = io();
  let wallet = null;
  let lobbyData = [];
  let currentRoomView = null;
  let currentRoomId = null;
  let mySeatIndex = -1;
  let resultsShownForState = null; // avoid re-popping modal on every broadcast

  // ============================================================
  // Sound engine (Web Audio, synthesized — no external files)
  // ============================================================
  const Sound = (() => {
    let ctx = null;
    function getCtx() {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      return ctx;
    }
    function tone(freq, duration, type = 'sine', gain = 0.15, delay = 0) {
      if (!wallet || !wallet.soundEnabled) return;
      try {
        const c = getCtx();
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        g.gain.value = gain;
        osc.connect(g).connect(c.destination);
        const t0 = c.currentTime + delay;
        g.gain.setValueAtTime(gain, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
        osc.start(t0);
        osc.stop(t0 + duration + 0.02);
      } catch (e) { /* audio unsupported, ignore */ }
    }
    return {
      click: () => tone(600, 0.06, 'square', 0.08),
      deal: () => tone(320, 0.08, 'triangle', 0.1),
      draw: () => tone(420, 0.1, 'triangle', 0.12),
      win: () => { tone(523, 0.15, 'sine', 0.15); tone(659, 0.15, 'sine', 0.15, 0.1); tone(784, 0.25, 'sine', 0.15, 0.2); },
      lose: () => { tone(300, 0.2, 'sawtooth', 0.1); tone(220, 0.3, 'sawtooth', 0.1, 0.15); },
      coin: () => { tone(880, 0.08, 'sine', 0.1); tone(1046, 0.1, 'sine', 0.1, 0.06); },
      tick: () => tone(880, 0.03, 'square', 0.05)
    };
  })();

  // ============================================================
  // Tab navigation
  // ============================================================
  const views = {
    home: document.getElementById('view-home'),
    play: document.getElementById('view-play'),
    market: document.getElementById('view-market'),
    mypage: document.getElementById('view-mypage')
  };
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      Sound.click();
      switchView(btn.dataset.view);
    });
  });
  function switchView(name) {
    Object.entries(views).forEach(([k, el]) => el.classList.toggle('active', k === name));
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'market') refreshMarketFreeStatus();
  }
  switchView('home');

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  // ============================================================
  // Wallet rendering
  // ============================================================
  function animateCount(el, from, to) {
    const dur = 500;
    const start = performance.now();
    function step(now) {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      const val = Math.round(from + (to - from) * eased);
      el.textContent = val.toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  function renderWallet(newWallet) {
    const prev = wallet;
    wallet = newWallet;
    const chipEl = document.getElementById('chipCount');
    const diamondEl = document.getElementById('diamondCount');
    if (prev) {
      if (prev.chips !== wallet.chips) animateCount(chipEl, prev.chips, wallet.chips);
      else chipEl.textContent = wallet.chips.toLocaleString();
      if (prev.diamonds !== wallet.diamonds) animateCount(diamondEl, prev.diamonds, wallet.diamonds);
      else diamondEl.textContent = wallet.diamonds.toLocaleString();
    } else {
      chipEl.textContent = wallet.chips.toLocaleString();
      diamondEl.textContent = wallet.diamonds.toLocaleString();
    }

    document.getElementById('statWins').textContent = wallet.wins;
    document.getElementById('statLosses').textContent = wallet.losses;
    document.getElementById('statPushes').textContent = wallet.pushes;
    document.getElementById('statGames').textContent = wallet.gamesPlayed;

    document.getElementById('mpWins').textContent = wallet.wins;
    document.getElementById('mpLosses').textContent = wallet.losses;
    document.getElementById('mpPushes').textContent = wallet.pushes;
    const winRate = wallet.gamesPlayed > 0 ? Math.round((wallet.wins / wallet.gamesPlayed) * 100) : 0;
    document.getElementById('mpWinRate').textContent = winRate + '%';

    document.getElementById('profileNickname').textContent = wallet.nickname;
    document.getElementById('myClientId').textContent = clientId.slice(0, 16) + '…';
    document.getElementById('soundToggle').checked = wallet.soundEnabled;

    refreshFreeChipTimer();
    refreshMarketFreeStatus();
  }

  function refreshFreeChipTimer() {
    if (!wallet) return;
    const remain = wallet.nextFreeChipAt - Date.now();
    const el = document.getElementById('freeChipTimer');
    if (remain <= 0) {
      el.textContent = '지금 받기 가능';
    } else {
      el.textContent = formatDuration(remain) + ' 후 가능';
    }
  }
  function refreshMarketFreeStatus() {
    if (!wallet) return;
    const remain = wallet.nextFreeChipAt - Date.now();
    const statusEl = document.getElementById('marketFreeStatus');
    const btn = document.getElementById('btnMarketFreeChips');
    if (remain <= 0) {
      statusEl.textContent = '지금 받을 수 있어요';
      btn.disabled = false;
    } else {
      statusEl.textContent = formatDuration(remain) + ' 후 다시 받을 수 있어요';
      btn.disabled = true;
    }
  }
  function formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}시간 ${m}분`;
  }
  setInterval(() => { refreshFreeChipTimer(); refreshMarketFreeStatus(); }, 30000);

  // ============================================================
  // Socket setup
  // ============================================================
  socket.on('connect', () => {
    socket.emit('identify', { clientId }, (res) => {
      renderWallet(res.player);
    });
  });

  socket.on('wallet', (w) => renderWallet(w));
  socket.on('lobby', (data) => { lobbyData = data; renderLobby(); });
  socket.on('errorMsg', (msg) => toast(msg));
  socket.on('roomState', (view) => {
    currentRoomView = view;
    currentRoomId = view.id;
    renderRoom(view);
  });

  // ============================================================
  // Lobby / tier list
  // ============================================================
  function renderLobby() {
    const container = document.getElementById('tierList');
    container.innerHTML = '';
    lobbyData.forEach((tier) => {
      const card = document.createElement('div');
      card.className = 'tier-card';
      const totalPlayers = tier.rooms.reduce((s, r) => s + r.playerCount, 0);
      card.innerHTML = `
        <div class="tier-card-top">
          <div class="tier-name">${tier.emoji} ${tier.name}</div>
          <div class="tier-bet">${tier.bet === 0 ? '무료' : '베팅 ' + tier.bet.toLocaleString() + ' 🪙'}</div>
        </div>
        <div class="tier-rooms"></div>
      `;
      const roomsEl = card.querySelector('.tier-rooms');
      tier.rooms.forEach((r) => {
        const chip = document.createElement('div');
        const full = r.playerCount >= r.maxSeats;
        chip.className = 'room-chip' + (full ? ' full' : r.state !== 'waiting' ? ' playing' : '');
        chip.innerHTML = `<span class="dot"></span>${r.id.split('-')[1]}번방 ${r.playerCount}/${r.maxSeats}`;
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          Sound.click();
          socket.emit('joinRoom', { roomId: r.id });
        });
        roomsEl.appendChild(chip);
      });
      card.addEventListener('click', () => {
        Sound.click();
        socket.emit('quickMatch', { tierId: tier.id });
      });
      container.appendChild(card);
    });
  }

  document.getElementById('btnQuickPlay').addEventListener('click', () => {
    Sound.click();
    switchView('play');
    socket.emit('quickMatch', { tierId: 'practice' });
  });

  // ============================================================
  // Table rendering
  // ============================================================
  const lobbyPane = document.getElementById('lobbyPane');
  const tablePane = document.getElementById('tablePane');
  let lastPhaseAudioKey = null;

  function renderRoom(view) {
    lobbyPane.classList.add('hidden');
    tablePane.classList.remove('hidden');

    document.getElementById('tableTierName').textContent = view.tierName;
    document.getElementById('tableBetAmount').textContent = view.bet.toLocaleString();

    const phaseNames = {
      waiting: '대기중',
      dealing: '카드 분배중',
      turns: '플레이어 턴',
      banker_turn: '뱅커 턴',
      results: '결과'
    };
    document.getElementById('phasePill').textContent = phaseNames[view.state] || view.state;

    mySeatIndex = view.seats.findIndex((s) => s && s.clientId === clientId);

    renderSeats(view);
    renderCountdown(view);
    renderActionBar(view);

    const audioKey = view.id + ':' + view.state + ':' + (view.turnSeatIndex ?? '');
    if (audioKey !== lastPhaseAudioKey) {
      lastPhaseAudioKey = audioKey;
      if (view.state === 'dealing') Sound.deal();
    }

    if (view.state === 'results') {
      const resultKey = view.id + ':' + view.phaseEndsAt;
      if (resultsShownForState !== resultKey) {
        resultsShownForState = resultKey;
        showResultsModal(view);
      }
    }
  }

  function renderSeats(view) {
    const container = document.getElementById('seatsContainer');
    container.innerHTML = '';
    const n = view.seats.length;
    const offset = mySeatIndex >= 0 ? mySeatIndex : 0;

    view.seats.forEach((seat, idx) => {
      const pos = (idx - offset + n) % n;
      const seatEl = document.createElement('div');
      seatEl.className = 'seat';
      seatEl.dataset.pos = String(pos);
      if (idx === view.bankerSeatIndex) seatEl.classList.add('is-banker');
      if (idx === view.turnSeatIndex) seatEl.classList.add('is-turn');

      if (!seat) {
        seatEl.innerHTML = `
          <div class="seat-avatar">➕</div>
          <div class="seat-empty">빈 자리</div>
        `;
        seatEl.style.cursor = 'pointer';
        seatEl.addEventListener('click', () => {
          if (view.state === 'waiting') socket.emit('joinRoom', { roomId: view.id });
        });
      } else {
        const cardsHtml = renderCardsHtml(seat);
        const isBankerTag = idx === view.bankerSeatIndex ? '<span class="banker-badge">뱅커</span>' : '';
        const scoreLabel = seat.evalResult ? seat.evalResult.label : (seat.cardCount > 0 ? '?' : '');
        let outcomeHtml = '';
        if (seat.outcome && seat.outcome !== 'banker') {
          const deltaTxt = seat.delta > 0 ? `+${seat.delta.toLocaleString()}` : seat.delta.toLocaleString();
          const label = seat.outcome === 'win' ? `승 ${deltaTxt}` : seat.outcome === 'lose' ? `패 ${deltaTxt}` : '푸시';
          outcomeHtml = `<div class="seat-outcome ${seat.outcome}">${label}</div>`;
        }
        seatEl.innerHTML = `
          <div class="seat-avatar">🂡${isBankerTag}</div>
          <div class="seat-name">${escapeHtml(seat.nickname)}${seat.sittingOut ? ' (대기)' : ''}</div>
          <div class="seat-cards">${cardsHtml}</div>
          <div class="seat-score">${scoreLabel}</div>
          ${outcomeHtml}
        `;
      }
      container.appendChild(seatEl);
    });
  }

  function renderCardsHtml(seat) {
    if (seat.cards && seat.cards.length) {
      return seat.cards.map((c) => cardHtml(c)).join('');
    }
    if (seat.cardCount > 0) {
      return Array.from({ length: seat.cardCount }).map(() => `<div class="seat-card back">🂠</div>`).join('');
    }
    return '';
  }

  const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  function cardHtml(c) {
    const red = c.suit === 'H' || c.suit === 'D';
    return `<div class="seat-card ${red ? 'red' : ''}">${c.rank}${SUIT_SYMBOL[c.suit]}</div>`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  let countdownInterval = null;
  function renderCountdown(view) {
    clearInterval(countdownInterval);
    const el = document.getElementById('countdownNum');
    function tick() {
      const remain = Math.max(0, Math.ceil((view.phaseEndsAt - Date.now()) / 1000));
      el.textContent = ['dealing', 'results'].includes(view.state) ? '' : (remain > 0 ? remain + 's' : '');
    }
    tick();
    countdownInterval = setInterval(tick, 250);
  }

  function renderActionBar(view) {
    const msgEl = document.getElementById('actionMsg');
    const btnsEl = document.getElementById('actionButtons');
    const mySeat = mySeatIndex >= 0 ? view.seats[mySeatIndex] : null;

    const isMyPlayerTurn = view.state === 'turns' && view.turnSeatIndex === mySeatIndex;
    const isMyBankerTurn = view.state === 'banker_turn' && view.bankerSeatIndex === mySeatIndex;

    if (mySeatIndex === -1) {
      msgEl.textContent = '관전 중이에요. 다음 라운드에 참여할 수 있어요.';
      btnsEl.classList.add('hidden');
    } else if (mySeat && mySeat.sittingOut) {
      msgEl.textContent = '다음 라운드를 기다리는 중이에요.';
      btnsEl.classList.add('hidden');
    } else if (view.state === 'waiting') {
      const count = view.seats.filter((s) => s && !s.sittingOut).length;
      msgEl.textContent = count < 2 ? '다른 플레이어를 기다리는 중...' : '곧 라운드가 시작돼요!';
      btnsEl.classList.add('hidden');
    } else if (view.state === 'dealing') {
      msgEl.textContent = '카드를 분배하고 있어요...';
      btnsEl.classList.add('hidden');
    } else if (isMyPlayerTurn || isMyBankerTurn) {
      msgEl.textContent = isMyBankerTurn ? '뱅커 차례예요! 드로우 또는 스테이를 선택하세요.' : '내 차례예요! 드로우 또는 스테이를 선택하세요.';
      btnsEl.classList.remove('hidden');
    } else if (view.state === 'turns' || view.state === 'banker_turn') {
      const activeSeat = view.seats[view.turnSeatIndex];
      msgEl.textContent = `${activeSeat ? escapeHtml(activeSeat.nickname) : '상대'}의 차례를 기다리는 중...`;
      btnsEl.classList.add('hidden');
    } else if (view.state === 'results') {
      msgEl.textContent = '라운드 결과가 나왔어요!';
      btnsEl.classList.add('hidden');
    }
  }

  document.getElementById('btnStay').addEventListener('click', () => {
    Sound.click();
    socket.emit('playerAction', { roomId: currentRoomId, action: 'stay' });
  });
  document.getElementById('btnDraw').addEventListener('click', () => {
    Sound.draw();
    socket.emit('playerAction', { roomId: currentRoomId, action: 'draw' });
  });

  document.getElementById('btnLeaveTable').addEventListener('click', () => {
    Sound.click();
    socket.emit('leaveRoom');
    currentRoomId = null;
    currentRoomView = null;
    tablePane.classList.add('hidden');
    lobbyPane.classList.remove('hidden');
  });

  // ============================================================
  // Results modal
  // ============================================================
  function showResultsModal(view) {
    const mySeat = mySeatIndex >= 0 ? view.seats[mySeatIndex] : null;
    const modal = document.getElementById('resultsModal');
    const ribbon = document.getElementById('winRibbon');
    const title = document.getElementById('resultsTitle');
    const body = document.getElementById('resultsBody');

    if (mySeat && mySeat.outcome === 'win') {
      ribbon.classList.remove('hidden');
      title.textContent = '승리!';
      Sound.win();
    } else if (mySeat && mySeat.outcome === 'lose') {
      ribbon.classList.add('hidden');
      title.textContent = '아쉬워요';
      Sound.lose();
    } else {
      ribbon.classList.add('hidden');
      title.textContent = '라운드 결과';
    }

    body.innerHTML = view.seats.map((s, idx) => {
      if (!s || s.sittingOut) return '';
      const isBanker = idx === view.bankerSeatIndex;
      const isSelf = s.clientId === clientId;
      const label = isBanker ? '뱅커' : (s.evalResult ? s.evalResult.label : '-');
      const deltaTxt = s.outcome === 'banker' ? '' :
        (s.delta > 0 ? ` (+${s.delta.toLocaleString()})` : s.delta < 0 ? ` (${s.delta.toLocaleString()})` : ' (푸시)');
      return `<div class="result-row ${isSelf ? 'self' : ''}">
        <span>${escapeHtml(s.nickname)}${isBanker ? ' 👑' : ''}</span>
        <span>${label}${deltaTxt}</span>
      </div>`;
    }).join('');

    modal.classList.remove('hidden');
  }
  document.getElementById('btnCloseResults').addEventListener('click', () => {
    Sound.click();
    document.getElementById('resultsModal').classList.add('hidden');
  });

  // ============================================================
  // Market
  // ============================================================
  document.getElementById('btnFreeChips').addEventListener('click', claimFreeChips);
  document.getElementById('btnMarketFreeChips').addEventListener('click', claimFreeChips);
  function claimFreeChips() {
    Sound.click();
    socket.emit('claimFreeChips', {}, (res) => {
      if (res.ok) {
        Sound.coin();
        toast(`🎁 무료 칩 ${res.amount.toLocaleString()}개를 받았어요!`);
      } else {
        toast(`아직이에요. ${formatDuration(res.waitMs)} 후 다시 시도해주세요.`);
      }
    });
  }

  socket.emit('getDiamondPackages', {}, (packages) => renderDiamondPackages(packages));
  function renderDiamondPackages(packages) {
    const container = document.getElementById('diamondPackages');
    container.innerHTML = '';
    packages.forEach((pack) => {
      const el = document.createElement('div');
      el.className = 'diamond-pack';
      el.innerHTML = `<div class="dp-amt">💎 ${pack.diamonds.toLocaleString()}</div><div class="dp-price">${pack.priceLabel}</div>`;
      el.addEventListener('click', () => {
        Sound.click();
        socket.emit('buyDiamonds', { packageId: pack.id }, (res) => {
          if (res.ok) {
            Sound.coin();
            toast(`💎 다이아 ${pack.diamonds.toLocaleString()}개 구매 완료! (모의 결제)`);
          }
        });
      });
      container.appendChild(el);
    });
  }

  document.getElementById('btnExchange').addEventListener('click', () => {
    const input = document.getElementById('exchangeInput');
    const val = parseInt(input.value, 10);
    if (!val || val <= 0) { toast('교환할 다이아 수를 입력해주세요.'); return; }
    doExchange(val);
  });
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const amt = btn.dataset.amt;
      if (amt === 'all') {
        if (!wallet || wallet.diamonds <= 0) { toast('보유한 다이아가 없어요.'); return; }
        doExchange(wallet.diamonds);
      } else {
        document.getElementById('exchangeInput').value = amt;
        doExchange(parseInt(amt, 10));
      }
    });
  });
  function doExchange(amount) {
    Sound.click();
    socket.emit('exchangeDiamonds', { diamonds: amount }, (res) => {
      if (res.ok) {
        Sound.coin();
        toast(`💎 ${amount.toLocaleString()}개 → 🪙 ${(amount * 1000).toLocaleString()}개로 교환했어요!`);
        document.getElementById('exchangeInput').value = '';
      } else {
        toast('교환에 실패했어요. 보유 다이아를 확인해주세요.');
      }
    });
  }

  // ============================================================
  // My Page
  // ============================================================
  document.getElementById('btnEditNickname').addEventListener('click', () => {
    Sound.click();
    document.getElementById('nicknameInput').value = wallet ? wallet.nickname : '';
    document.getElementById('nicknameModal').classList.remove('hidden');
  });
  document.getElementById('btnCancelNickname').addEventListener('click', () => {
    document.getElementById('nicknameModal').classList.add('hidden');
  });
  document.getElementById('btnSaveNickname').addEventListener('click', () => {
    const nickname = document.getElementById('nicknameInput').value;
    socket.emit('setNickname', { nickname }, (res) => {
      if (res.ok) {
        Sound.click();
        document.getElementById('nicknameModal').classList.add('hidden');
        toast('닉네임이 변경됐어요.');
      } else {
        toast(res.reason || '닉네임 변경에 실패했어요.');
      }
    });
  });
  document.getElementById('soundToggle').addEventListener('change', (e) => {
    socket.emit('setSound', { enabled: e.target.checked });
    if (wallet) wallet.soundEnabled = e.target.checked;
  });

  // Refresh lobby periodically while on the play tab without a table joined
  setInterval(() => {
    if (!currentRoomId) socket.emit('getLobby');
  }, 5000);
})();
