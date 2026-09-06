// Board geometry helpers built on the fixed layout from cards.js.
import { BOARD_SIZE, BOARD_LAYOUT, row, col, isCorner } from './cards.js';

// World-space cell size, before camera scale — portrait card proportions
// (like the real board's card-shaped spaces), not square.
export const CELL_W = 56;
export const CELL_H = 80;

export function cellCenter(index) {
  const r = row(index);
  const c = col(index);
  return [c * CELL_W + CELL_W / 2, r * CELL_H + CELL_H / 2];
}

export function boardExtent() {
  return { minX: 0, minY: 0, maxX: BOARD_SIZE * CELL_W, maxY: BOARD_SIZE * CELL_H, w: BOARD_SIZE * CELL_W, h: BOARD_SIZE * CELL_H };
}

export function indexAtPoint(x, y) {
  const c = Math.floor(x / CELL_W);
  const r = Math.floor(y / CELL_H);
  if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return -1;
  return r * BOARD_SIZE + c;
}

export function cardAt(index) {
  return BOARD_LAYOUT[index];
}

export { BOARD_SIZE, isCorner };
