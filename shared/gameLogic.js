// Pokdeng(ป๊อกเด้ง) 공용 게임 로직
// Node.js(require)와 브라우저(<script>) 양쪽에서 동일하게 사용됩니다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PokdengLogic = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  function buildDeck() {
    const deck = [];
    for (const s of SUITS) for (const r of RANKS) deck.push({ r, s });
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  function cardValue(card) {
    if (card.r === 'A') return 1;
    if (['10', 'J', 'Q', 'K'].includes(card.r)) return 0;
    return parseInt(card.r);
  }

  function handScore(hand) {
    const sum = hand.reduce((a, c) => a + cardValue(c), 0);
    return sum % 10;
  }

  function isFaceOnly(hand) { return hand.every(c => ['J', 'Q', 'K'].includes(c.r)); }
  function isTong(hand) { return hand.length === 3 && hand[0].r === hand[1].r && hand[1].r === hand[2].r; }
  function isStraight(hand) {
    if (hand.length !== 3) return false;
    const order = RANKS;
    const idx = hand.map(c => order.indexOf(c.r)).sort((a, b) => a - b);
    return idx[1] === idx[0] + 1 && idx[2] === idx[1] + 1;
  }
  function isSian(hand) { return hand.length === 3 && isFaceOnly(hand); }
  function isPok(hand) { return hand.length === 2 && (handScore(hand) === 8 || handScore(hand) === 9); }

  // tier가 높을수록 강한 패. 동률이면 handScore 비교.
  function handTier(hand) {
    if (isPok(hand)) return { tier: 4, mult: 2, name: handScore(hand) === 9 ? 'Pok 9' : 'Pok 8' };
    if (isTong(hand)) return { tier: 3, mult: 5, name: 'Tong' };
    if (isStraight(hand)) return { tier: 2, mult: 3, name: 'Straight' };
    if (isSian(hand)) return { tier: 2, mult: 3, name: 'Sian' };
    return { tier: 1, mult: 1, name: 'Normal' };
  }

  // 뱅커(dealer) 관점에서 한 명의 플레이어와 비교한 결과를 반환
  // 반환: { result: 'bankerWin'|'playerWin'|'push', mult }
  function compareToBanker(playerHand, bankerHand) {
    const pInfo = handTier(playerHand);
    const bInfo = handTier(bankerHand);
    const pScore = handScore(playerHand);
    const bScore = handScore(bankerHand);

    if (pInfo.tier !== bInfo.tier) {
      return pInfo.tier > bInfo.tier
        ? { result: 'playerWin', mult: pInfo.mult, playerHandName: pInfo.name, bankerHandName: bInfo.name }
        : { result: 'bankerWin', mult: bInfo.mult, playerHandName: pInfo.name, bankerHandName: bInfo.name };
    }
    if (pScore > bScore) return { result: 'playerWin', mult: pInfo.mult, playerHandName: pInfo.name, bankerHandName: bInfo.name };
    if (pScore < bScore) return { result: 'bankerWin', mult: bInfo.mult, playerHandName: pInfo.name, bankerHandName: bInfo.name };
    return { result: 'push', mult: 1, playerHandName: pInfo.name, bankerHandName: bInfo.name };
  }

  return {
    SUITS, RANKS,
    buildDeck, cardValue, handScore,
    isPok, isTong, isStraight, isSian,
    handTier, compareToBanker
  };
}));
