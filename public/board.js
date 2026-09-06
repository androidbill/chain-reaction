// Board geometry helpers built on the fixed layout from cards.js.
import { BOARD_SIZE, BOARD_LAYOUT, row, col, isCorner } from './cards.js';

export const CELL = 64; // world-space cell size in pixels, before camera scale

export function cellCenter(index) {
  const r = row(index);
  const c = col(index);
  return [c * CELL + CELL / 2, r * CELL + CELL / 2];
}

export function boardExtent() {
  return { minX: 0, minY: 0, maxX: BOARD_SIZE * CELL, maxY: BOARD_SIZE * CELL, w: BOARD_SIZE * CELL, h: BOARD_SIZE * CELL };
}

export function indexAtPoint(x, y) {
  const c = Math.floor(x / CELL);
  const r = Math.floor(y / CELL);
  if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return -1;
  return r * BOARD_SIZE + c;
}

export function cardAt(index) {
  return BOARD_LAYOUT[index];
}

export { BOARD_SIZE, isCorner };
