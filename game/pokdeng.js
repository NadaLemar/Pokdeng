// ============================================================
// Pokdeng (ป๊อกเด้ง) core rules engine
// Pure functions only - no side effects, easy to unit test.
// ============================================================

const SUITS = ['S', 'H', 'D', 'C']; // Spade, Heart, Diamond, Club
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const RANK_ORDER = RANKS.reduce((acc, r, i) => {
  acc[r] = i; // A=0 ... K=12
  return acc;
}, {});

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

function shuffle(deck) {
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardPoint(rank) {
  if (rank === 'A') return 1;
  if (['10', 'J', 'Q', 'K'].includes(rank)) return 0;
  return parseInt(rank, 10);
}

function scoreOf(cards) {
  const sum = cards.reduce((s, c) => s + cardPoint(c.rank), 0);
  return sum % 10;
}

// Rank tier used to break ties between two special hands with the same score.
// Higher number = stronger hand.
const HAND_TIER = {
  normal: 0,
  pok8: 1,
  pok9: 2,
  straight: 3,
  sian: 4,
  tong: 5
};

function isTong(cards) {
  // 3 of a kind (same rank)
  return cards.length === 3 && cards[0].rank === cards[1].rank && cards[1].rank === cards[2].rank;
}

function isSameSuit(cards) {
  return cards.every((c) => c.suit === cards[0].suit);
}

function isSian(cards) {
  // K, Q, J of the same suit
  if (cards.length !== 3 || !isSameSuit(cards)) return false;
  const ranks = cards.map((c) => c.rank).sort();
  return JSON.stringify(ranks) === JSON.stringify(['J', 'K', 'Q']);
}

function isStraight(cards) {
  // 3 consecutive ranks, same suit (เรียง). Ace can only be low (A-2-3) for simplicity.
  if (cards.length !== 3 || !isSameSuit(cards)) return false;
  const orders = cards.map((c) => RANK_ORDER[c.rank]).sort((a, b) => a - b);
  return orders[1] === orders[0] + 1 && orders[2] === orders[1] + 1;
}

/**
 * Evaluate a hand (2 or 3 cards) and return its type, score, and payout multiplier.
 */
function evaluateHand(cards) {
  const score = scoreOf(cards);

  if (cards.length === 2) {
    if (score === 9) return { score, type: 'pok9', label: 'Pok 9', multiplier: 2, tier: HAND_TIER.pok9 };
    if (score === 8) return { score, type: 'pok8', label: 'Pok 8', multiplier: 1, tier: HAND_TIER.pok8 };
    return { score, type: 'normal', label: `${score} \uc810`, multiplier: 1, tier: HAND_TIER.normal };
  }

  // 3-card hands
  if (isTong(cards)) return { score, type: 'tong', label: '\ud1b5 (Tong)', multiplier: 5, tier: HAND_TIER.tong };
  if (isSian(cards)) return { score, type: 'sian', label: '\uc2dc\uc548 (Sian)', multiplier: 3, tier: HAND_TIER.sian };
  if (isStraight(cards)) return { score, type: 'straight', label: '\ub9ac\uc559 (Straight)', multiplier: 3, tier: HAND_TIER.straight };
  return { score, type: 'normal', label: `${score} \uc810`, multiplier: 1, tier: HAND_TIER.normal };
}

/**
 * Compare a player's hand to the banker's hand.
 * Returns { outcome: 'win'|'lose'|'push', multiplier }
 * multiplier is the payout multiple applied to the base bet (winner's own hand multiplier,
 * except Pok always beats non-Pok regardless of raw score in classic rules - simplified here
 * so that Pok hands are only ever compared to other 2-card hands: dealing rules already stop
 * further draws whenever anyone has Pok, so this case is naturally handled).
 */
function compareHands(playerEval, bankerEval) {
  if (playerEval.score === bankerEval.score) {
    if (playerEval.tier === bankerEval.tier) {
      return { outcome: 'push', multiplier: 0 };
    }
    return playerEval.tier > bankerEval.tier
      ? { outcome: 'win', multiplier: playerEval.multiplier }
      : { outcome: 'lose', multiplier: bankerEval.multiplier };
  }
  if (playerEval.score > bankerEval.score) {
    return { outcome: 'win', multiplier: playerEval.multiplier };
  }
  return { outcome: 'lose', multiplier: bankerEval.multiplier };
}

module.exports = {
  SUITS,
  RANKS,
  createDeck,
  shuffle,
  cardPoint,
  scoreOf,
  evaluateHand,
  compareHands
};
