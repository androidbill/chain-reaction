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

// `myTeam` matters only for a one-eyed jack: real Sequence rules never let a removal
// touch your own team's chip, only an opponent's, so it's excluded from the target
// list at the source rather than merely blocked at validation time — every caller
// (highlighting, auto-resolve, the bot, move validation) gets the same honest set of
// targets instead of each having to re-apply this exclusion itself.
export function legalTargetsFor(board, instanceId, myTeam) {
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
      if (!isCorner(i) && board[i] != null && board[i] !== myTeam) targets.push(i);
    }
    return { action: 'remove', targets };
  }
  const spots = boardIndicesFor(code);
  const targets = spots.filter((i) => board[i] == null);
  return { action: 'place', targets };
}

export function isDeadCard(board, instanceId, lockedIndices, myTeam) {
  const { action, targets } = legalTargetsFor(board, instanceId, myTeam);
  if (action === 'remove') {
    const locked = lockedIndices || new Set();
    return targets.filter((i) => !locked.has(i)).length === 0;
  }
  return targets.length === 0;
}

// The set of board cells worth highlighting just from glancing at a hand — every
// normal card's exact (empty) spot. Jacks are deliberately excluded entirely: a
// two-eyed (wild) can go on literally any empty cell, and a one-eyed (removal)
// always targets a cell that already has a chip on it — highlighting either would
// mean lighting up already-occupied spaces or flooding the whole board, instead of
// just showing where the player's hand can actually be laid down. Both jacks are
// still usable by tapping their target directly (see autoResolveTargets below).
export function ambientHighlightSet(board, hand, lockedIndices) {
  const set = new Set();
  for (const instanceId of hand) {
    const code = instanceCode(instanceId);
    if (isTwoEyedJack(code) || isOneEyedJack(code)) continue;
    const { targets } = legalTargetsFor(board, instanceId);
    for (const t of targets) set.add(t);
  }
  return set;
}

// Resolves an entire hand into a single index -> {instanceId, action} map,
// so the board can be tapped directly with no card-selection step. Priority
// when more than one card could reach the same cell: an exact matching
// card first (cheapest to spend), then a one-eyed jack removal, then a
// two-eyed wild last (most valuable, held in reserve) — this is also what
// makes a wild usable even though it's excluded from ambientHighlightSet.
export function autoResolveTargets(board, hand, lockedIndices, myTeam) {
  const locked = lockedIndices || new Set();
  const normals = [];
  const oneEyed = [];
  const twoEyed = [];
  for (const instanceId of hand) {
    const code = instanceCode(instanceId);
    if (isTwoEyedJack(code)) twoEyed.push(instanceId);
    else if (isOneEyedJack(code)) oneEyed.push(instanceId);
    else normals.push(instanceId);
  }
  const map = new Map();
  for (const instanceId of normals) {
    const { targets } = legalTargetsFor(board, instanceId, myTeam);
    for (const t of targets) if (!map.has(t)) map.set(t, { instanceId, action: 'place' });
  }
  for (const instanceId of oneEyed) {
    const { targets } = legalTargetsFor(board, instanceId, myTeam);
    for (const t of targets) {
      if (locked.has(t) || map.has(t)) continue;
      map.set(t, { instanceId, action: 'remove' });
    }
  }
  for (const instanceId of twoEyed) {
    const { targets } = legalTargetsFor(board, instanceId, myTeam);
    for (const t of targets) if (!map.has(t)) map.set(t, { instanceId, action: 'place' });
  }
  return map;
}

export function validateMove(board, instanceId, targetIndex, lockedIndices, myTeam) {
  const { action, targets } = legalTargetsFor(board, instanceId, myTeam);
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

function sharedCellCount(a, b) {
  let n = 0;
  for (const x of a) if (b.includes(x)) n++;
  return n;
}

// Returns an array of { team, cells:[5 indices] } for every DISTINCT run of
// 5 a team has completed. Per the real rules, a chip may be shared by at
// most one other sequence — so two candidate runs of 5 count as separate
// sequences only if they overlap by at most one cell (e.g. a plain 6-in-a-
// row is one sequence plus one spare chip, not two sequences). Candidates
// are scanned in a fixed board order so every client resolves the same
// board state to the same confirmed set, which multiplayer consistency
// depends on since there's no stored history of formation order.
export function findSequences(board, teamCount) {
  const candidates = [];
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
        candidates.push({ team, cells });
      }
    }
  }

  const confirmed = [];
  for (let team = 0; team < teamCount; team++) {
    const chosenForTeam = [];
    for (const cand of candidates) {
      if (cand.team !== team) continue;
      const overlapsTooMuch = chosenForTeam.some((c) => sharedCellCount(c.cells, cand.cells) > 1);
      if (!overlapsTooMuch) chosenForTeam.push(cand);
    }
    confirmed.push(...chosenForTeam);
  }
  return confirmed;
}

// A chip is "locked" (immune to one-eyed-jack removal) once it's part of a
// confirmed sequence.
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
