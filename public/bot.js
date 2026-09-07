// Chain Reaction bots.
//
// A bot is a pure function: given the board, a hand, the team it plays for, and the
// set of locked cells, it returns the single move it wants to make. It never touches
// state — the caller runs the chosen move through the same rules.js validateMove the
// human path uses, same as HexColony's bots do, so a bot cannot cheat and an illegal
// bot move would simply be rejected like anyone else's.
//
// The three difficulties are one brain with the knobs turned — how much random noise
// gets folded into its judgement of each candidate move, from wide-open (easy) to
// none (hard). Nothing is hidden from easy that hard can't also see; hard just holds
// a steadier hand on the same reasoning.

import { legalTargetsFor, isDeadCard } from './rules.js';
import { instanceCode, isTwoEyedJack, isOneEyedJack, isCorner, row, col, indexAt } from './cards.js';

export const LEVELS = {
  easy: { label: 'Easy', noise: 60 },
  medium: { label: 'Medium', noise: 18 },
  hard: { label: 'Hard', noise: 0 },
};

const BOT_NAMES = ['Ada', 'Bram', 'Cleo', 'Dex', 'Etta', 'Finch', 'Gus', 'Hazel', 'Ivo', 'Juno'];

/** A bot display name not already in use at the table. */
export function makeBotName(usedNames) {
  const pool = BOT_NAMES.filter((n) => !usedNames.includes(n));
  if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  return `Bot ${usedNames.length + 1}`;
}

const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];

// How far a run of `team`'s own chips (corners count as anyone's) reaches outward
// from `index` in each of the 4 axes, added up — independent of what's actually at
// `index` right now, so this also answers "if `team` placed here, how big a run would
// touch this cell", which is exactly what both building toward a line and judging a
// block need. A run stops the moment it hits an opponent chip or the board edge.
function reachFrom(board, index, team) {
  let total = 0;
  const r0 = row(index), c0 = col(index);
  for (const [dr, dc] of DIRECTIONS) {
    for (const sign of [1, -1]) {
      for (let k = 1; k < 5; k++) {
        const idx = indexAt(r0 + dr * k * sign, c0 + dc * k * sign);
        if (idx === -1) break;
        const owned = isCorner(idx) || board[idx] === team;
        if (!owned) break;
        total++;
      }
    }
  }
  return total;
}

// The strongest run any OTHER team already has reaching through this empty cell —
// i.e. how much it would cost them if they never get to play here.
function bestOpponentReach(board, index, myTeam, teamCount) {
  let best = 0;
  for (let t = 0; t < teamCount; t++) {
    if (t === myTeam) continue;
    best = Math.max(best, reachFrom(board, index, t));
  }
  return best;
}

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

/**
 * Chooses the bot's move for this turn. Returns { instanceId, targetIndex, action }
 * for a normal place/remove/wild play, { swap: instanceId } when every card in hand
 * is dead and the only legal thing to do is swap one away, or { pass: true } when the
 * hand is completely empty (the deck ran out) and there's nothing to do at all.
 */
export function chooseBotMove(board, hand, teamCount, myTeam, locked, difficulty, rngSeed = Date.now()) {
  // Only reachable once the shared deck has run completely dry and this hand was
  // never topped back up — rare, but a real endgame state (found by simulating full
  // games move-by-move, not a hypothetical): nothing to play, nothing to swap either.
  if (hand.length === 0) return { pass: true };

  const cfg = LEVELS[difficulty] || LEVELS.medium;
  const rng = mulberry32(rngSeed ^ 0);

  let best = null;
  let bestScore = -Infinity;

  for (const instanceId of hand) {
    const code = instanceCode(instanceId);
    const { action, targets } = legalTargetsFor(board, instanceId);
    const wild = isTwoEyedJack(code);
    const removal = isOneEyedJack(code);

    for (const index of targets) {
      if (action === 'remove') {
        if (locked.has(index)) continue;
        const owner = board[index];
        if (owner === myTeam) continue; // never break up its own line
        // Removing hurts them in proportion to how built-up that spot was for them —
        // and extra if losing this exact chip would break a line they nearly had.
        let score = reachFrom(board, index, owner) * 6;
        score += rng() * cfg.noise;
        if (score > bestScore) { bestScore = score; best = { instanceId, targetIndex: index, action }; }
        continue;
      }

      // A placement (normal card or a two-eyed wild).
      const myReach = reachFrom(board, index, myTeam);
      let score = myReach * 5;
      if (myReach >= 4) score += 1000; // completes (or overcompletes) a line outright
      const blocked = bestOpponentReach(board, index, myTeam, teamCount);
      if (blocked >= 4) score += 900; // the cell that stops an opponent's own win
      else score += blocked * 4; // still worth denying a team building toward one
      if (wild) score -= 8; // save wilds for when nothing else reaches as far
      score += rng() * cfg.noise;
      if (score > bestScore) { bestScore = score; best = { instanceId, targetIndex: index, action }; }
    }
  }

  if (best) return best;

  // Nothing legal anywhere in hand — same fallback a human has: swap a dead card.
  const dead = hand.find((id) => isDeadCard(board, id, locked));
  if (dead) return { swap: dead };
  return null; // shouldn't happen with a full 100-cell board and 6-7 card hands
}
