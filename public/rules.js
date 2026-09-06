// Pure game-engine functions — no DOM, no Firebase. Unit-testable in plain Node.
import {
  BOARD_SIZE,
  CORNER_INDICES,
  boardIndicesFor,
  instanceCode,
  isCorner,
  isOneEyedJack,
  isTwoEyedJack,
  row,
  col,
  indexAt,
  sequencesNeededToWin,
} from './cards.js';

// board: array of 100 entries, each `team` (0/1/2) or null. Corners are always
// treated as wild and are never occupied by a chip.

export function legalTargetsFor(board, instanceId) {
  const code = instanceCode(instanceId);
  if (isTwoEyedJack(code)) {
    const targets = [];
    for (let i = 0; i < board.length; i++) {
      if (!isCorner(i) && board[i] == null) targets.push(i);
    }
    return { action: 'place', targets };
  }
  if (isOneEyedJack(code)) {
    const targets = [];
    for (let i = 0; i < board.length; i++) {
      if (!isCorner(i) && board[i] != null) targets.push(i);
    }
    return { action: 'remove', targets };
  }
  const spots = boardIndicesFor(code);
  const targets = spots.filter((i) => board[i] == null);
  return { action: 'place', targets };
}

export function isDeadCard(board, instanceId, lockedIndices) {
  const { action, targets } = legalTargetsFor(board, instanceId);
  if (action === 'remove') {
    const locked = lockedIndices || new Set();
    return targets.filter((i) => !locked.has(i)).length === 0;
  }
  return targets.length === 0;
}

// The set of board cells worth highlighting just from glancing at a hand —
// every normal card's exact spot, plus removable targets for any one-eyed
// jack. Two-eyed (wild) jacks are deliberately excluded: a wild can go on
// literally any empty cell, so highlighting all of them would just flood
// the board instead of being useful — the player selects the wild card
// itself and then taps wherever they want.
export function ambientHighlightSet(board, hand, lockedIndices) {
  const locked = lockedIndices || new Set();
  const set = new Set();
  for (const instanceId of hand) {
    const code = instanceCode(instanceId);
    if (isTwoEyedJack(code)) continue;
    const { action, targets } = legalTargetsFor(board, instanceId);
    for (const t of targets) {
      if (action === 'remove' && locked.has(t)) continue;
      set.add(t);
    }
  }
  return set;
}

export function validateMove(board, instanceId, targetIndex, lockedIndices) {
  const { action, targets } = legalTargetsFor(board, instanceId);
  if (!targets.includes(targetIndex)) {
    return { ok: false, reason: 'not-a-legal-target' };
  }
  if (action === 'remove' && lockedIndices && lockedIndices.has(targetIndex)) {
    return { ok: false, reason: 'chip-is-locked-in-sequence' };
  }
  return { ok: true, action };
}

const DIRECTIONS = [
  [0, 1], // horizontal
  [1, 0], // vertical
  [1, 1], // diagonal down-right
  [1, -1], // diagonal down-left
];

function cellOwnedBy(board, index, team) {
  return isCorner(index) || board[index] === team;
}

// Returns an array of { team, cells:[5 indices] } for every run of 5 found.
export function findSequences(board, teamCount) {
  const found = [];
  const seen = new Set();
  for (let team = 0; team < teamCount; team++) {
    for (const [dr, dc] of DIRECTIONS) {
      for (let i = 0; i < board.length; i++) {
        const r0 = row(i);
        const c0 = col(i);
        const cells = [];
        let ok = true;
        for (let k = 0; k < 5; k++) {
          const idx = indexAt(r0 + dr * k, c0 + dc * k);
          if (idx === -1 || !cellOwnedBy(board, idx, team)) {
            ok = false;
            break;
          }
          cells.push(idx);
        }
        if (!ok) continue;
        // require at least one real (non-corner) chip so an all-corner "line" never counts
        if (!cells.some((c) => !isCorner(c))) continue;
        const key = team + ':' + cells.slice().sort((a, b) => a - b).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ team, cells });
      }
    }
  }
  return found;
}

// A chip is "locked" (immune to one-eyed-jack removal) once it's part of a
// completed sequence — a cell can be reused across at most 2 sequences per
// the real rules, but for v1 we lock any cell that appears in any sequence.
export function lockedIndicesFrom(sequences) {
  const set = new Set();
  for (const seq of sequences) {
    for (const idx of seq.cells) {
      if (!isCorner(idx)) set.add(idx);
    }
  }
  return set;
}

export function countSequencesByTeam(sequences, teamCount) {
  const counts = new Array(teamCount).fill(0);
  for (const seq of sequences) counts[seq.team]++;
  return counts;
}

export function checkWinner(sequences, teamCount) {
  const counts = countSequencesByTeam(sequences, teamCount);
  const need = sequencesNeededToWin(teamCount);
  for (let team = 0; team < teamCount; team++) {
    if (counts[team] >= need) return team;
  }
  return null;
}

export function nextTurnIndex(turnIndex, playerCount) {
  return (turnIndex + 1) % playerCount;
}

export { BOARD_SIZE, CORNER_INDICES };
