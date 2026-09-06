// Plain-Node sanity test for rules.js — no browser/DOM needed.
import assert from 'node:assert/strict';
import {
  legalTargetsFor,
  isDeadCard,
  validateMove,
  findSequences,
  lockedIndicesFrom,
  checkWinner,
} from '../public/rules.js';
import { boardIndicesFor, CORNER_INDICES } from '../public/cards.js';

function emptyBoard() {
  return new Array(100).fill(null);
}

// 1. Normal placement: card's two board spots are legal targets when empty.
{
  const board = emptyBoard();
  const spots = boardIndicesFor('7H');
  const { action, targets } = legalTargetsFor(board, '7H#0');
  assert.equal(action, 'place');
  assert.deepEqual(targets.sort((a, b) => a - b), spots.sort((a, b) => a - b));
  assert.equal(validateMove(board, '7H#0', spots[0]).ok, true);
  assert.equal(validateMove(board, '7H#0', 55 === spots[0] ? 54 : 55).ok, spots.includes(55 === spots[0] ? 54 : 55));
}

// 2. Two-eyed jack (wild) can target any empty non-corner cell.
{
  const board = emptyBoard();
  const { action, targets } = legalTargetsFor(board, 'JH#0');
  assert.equal(action, 'place');
  assert.equal(targets.length, 100 - CORNER_INDICES.length);
  assert.ok(!targets.some((i) => CORNER_INDICES.includes(i)));
}

// 3. One-eyed jack removes an opponent chip, but not a locked one.
{
  const board = emptyBoard();
  board[15] = 1; // opponent chip
  const { action, targets } = legalTargetsFor(board, 'JS#0');
  assert.equal(action, 'remove');
  assert.ok(targets.includes(15));
  const locked = new Set([15]);
  assert.equal(validateMove(board, 'JS#0', 15, locked).ok, false);
  assert.equal(validateMove(board, 'JS#0', 15).ok, true);
}

// 4. Dead card: both of a normal card's spots occupied => dead.
{
  const board = emptyBoard();
  const spots = boardIndicesFor('3D');
  for (const s of spots) board[s] = 0;
  assert.equal(isDeadCard(board, '3D#0'), true);
  board[spots[0]] = null;
  assert.equal(isDeadCard(board, '3D#0'), false);
}

// 5. Sequence detection: horizontal line of 5 for team 0, including a corner as wild.
{
  const board = emptyBoard();
  // row 0, cols 5..9 -> col 9 is a corner (index 9), wild for anyone.
  for (const c of [5, 6, 7, 8]) board[c] = 0;
  const seqs = findSequences(board, 2);
  assert.ok(seqs.some((s) => s.team === 0 && s.cells.includes(9)));
}

// 6. Vertical and diagonal detection.
{
  const board = emptyBoard();
  for (let r = 2; r <= 6; r++) board[r * 10 + 3] = 1; // vertical col 3, rows 2-6
  let seqs = findSequences(board, 2);
  assert.ok(seqs.some((s) => s.team === 1));

  const board2 = emptyBoard();
  for (let k = 0; k < 5; k++) board2[(2 + k) * 10 + (2 + k)] = 0; // diagonal
  seqs = findSequences(board2, 2);
  assert.ok(seqs.some((s) => s.team === 0));
}

// 7. Locked cells from completed sequences can't be removed.
{
  const board = emptyBoard();
  for (const c of [1, 2, 3, 4]) board[c] = 0;
  const seqs = findSequences(board, 2); // uses corner at 0
  const locked = lockedIndicesFrom(seqs);
  assert.ok([1, 2, 3, 4].every((i) => locked.has(i)));
}

// 8. Win thresholds: 2 teams need 2 sequences, 3 teams need 1.
{
  const board = emptyBoard();
  for (const c of [1, 2, 3, 4]) board[c] = 0; // seq #1 for team 0 (row 0)
  for (let r = 1; r <= 4; r++) board[r * 10 + 1] = 0; // seq #2 for team 0 (col 1, using row0 col1 + corner-free rows1-4) — ensure 5 real cells
  board[0 * 10 + 1] = 0; // already set above (c=1), keep for clarity
  let seqs = findSequences(board, 2);
  assert.equal(checkWinner(seqs, 2), 0);

  const board3 = emptyBoard();
  for (const c of [1, 2, 3, 4]) board3[c] = 2; // one sequence for team 2 (of 3)
  seqs = findSequences(board3, 3);
  assert.equal(checkWinner(seqs, 3), 2);
}

console.log('All rules.js tests passed.');
