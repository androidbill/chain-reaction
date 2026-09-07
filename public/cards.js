// Card/deck definitions and the fixed 10x10 board layout.

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'D', 'C']; // spades, hearts, diamonds, clubs
export const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const SUIT_COLOR = { S: 'black', C: 'black', H: 'red', D: 'red' };

export const ALL_CODES = SUITS.flatMap((s) => RANKS.map((r) => r + s));
export const NONJACK_CODES = ALL_CODES.filter((c) => cardRank(c) !== 'J');
export const TWOEYED_JACKS = ['JH', 'JD'];
export const ONEEYED_JACKS = ['JS', 'JC'];

export const BOARD_SIZE = 10;
export const CORNER_INDICES = [0, 9, 90, 99];

export function cardRank(code) {
  return code.slice(0, -1);
}
export function cardSuit(code) {
  return code.slice(-1);
}
export function isTwoEyedJack(code) {
  return TWOEYED_JACKS.includes(code);
}
export function isOneEyedJack(code) {
  return ONEEYED_JACKS.includes(code);
}
export function isJack(code) {
  return cardRank(code) === 'J';
}
export function isCorner(index) {
  return CORNER_INDICES.includes(index);
}

// Deterministic seeded shuffle so the board layout is fixed across every game,
// like the real printed board — just our own arrangement.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seed) {
  const rng = mulberry32(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const BOARD_SEED = 20260906;

// 96 non-corner cells, each of the 48 non-jack codes appears exactly twice.
const shuffledLayout = seededShuffle(NONJACK_CODES.concat(NONJACK_CODES), BOARD_SEED);

export const BOARD_LAYOUT = (() => {
  const layout = new Array(BOARD_SIZE * BOARD_SIZE).fill(null);
  let cursor = 0;
  for (let i = 0; i < layout.length; i++) {
    if (isCorner(i)) continue;
    layout[i] = shuffledLayout[cursor++];
  }
  return layout;
})();

// Map from a board code to the (usually 2) indices where it appears.
export const CODE_TO_INDICES = (() => {
  const map = new Map();
  BOARD_LAYOUT.forEach((code, idx) => {
    if (!code) return;
    if (!map.has(code)) map.set(code, []);
    map.get(code).push(idx);
  });
  return map;
})();

export function boardIndicesFor(code) {
  return CODE_TO_INDICES.get(code) || [];
}

// Build a shuffled play deck: two full 52-card decks (104 cards) with jacks.
// Each entry is a unique instance id "CODE#n" so duplicate cards can be tracked
// independently in hands/deck/discard.
export function buildShuffledDeck(rngSeed = Date.now() ^ 0) {
  const instances = [];
  for (let copy = 0; copy < 2; copy++) {
    for (const code of ALL_CODES) instances.push(`${code}#${copy}`);
  }
  return seededShuffle(instances, rngSeed >>> 0);
}

export function instanceCode(instanceId) {
  return instanceId.split('#')[0];
}

// Real Sequence keys hand size off the number of PLAYERS at the table, not the
// number of teams — the standard rule table only names a handful of player counts
// (2:7, 3:6, 4:6, 6:5, 8:4, 9:4, 10:3, 12:3), so counts this app allows but that
// table doesn't (5, 7, 11, since teams here can be any size rather than fixed
// even splits) fall back to the next lower named count's size — a clean step
// function that matches every published value exactly.
export function handSizeForPlayerCount(playerCount) {
  if (playerCount <= 2) return 7;
  if (playerCount <= 4) return 6;
  if (playerCount <= 6) return 5;
  if (playerCount <= 9) return 4;
  return 3; // 10-12
}

export function sequencesNeededToWin(teamCount) {
  return teamCount >= 3 ? 1 : 2;
}

export function row(index) {
  return Math.floor(index / BOARD_SIZE);
}
export function col(index) {
  return index % BOARD_SIZE;
}
export function indexAt(r, c) {
  if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return -1;
  return r * BOARD_SIZE + c;
}
