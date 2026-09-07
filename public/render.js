// Pan/zoom canvas camera + board renderer. Camera math ported from
// HexColony's BoardView pattern (fit/toScreen/toWorld/zoomBy/clampPan).
import { BOARD_SIZE, CELL_W, CELL_H, boardExtent, cellCenter, indexAtPoint, cardAt } from './board.js';
import { isCorner } from './cards.js';
import { cardSuit, cardRank, SUIT_SYMBOL, SUIT_COLOR } from './cards.js';

const TEAM_COLOR = ['#e0473c', '#3b7fe0', '#3fb56b']; // red, blue, green

export class BoardView {
  constructor(canvas, { onPick } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onPick = onPick || (() => {});
    this.userScale = 1;
    this.ox = 0;
    this.oy = 0;
    this.pointers = new Map();
    this.pinch = null;
    this.dragStart = null;
    this.moved = 0;
    this.board = new Array(100).fill(null);
    this.highlight = new Set();
    this.locked = new Set();
    this.myTeam = 0;
    this.flashIndex = null;
    this.flashStart = 0;
    this._flashRaf = null;
    this.peekDrag = null; // { index, dx, dy } — set while a finger is dragging a chip aside

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => this._onDown(e));
    canvas.addEventListener('pointermove', (e) => this._onMove(e));
    canvas.addEventListener('pointerup', (e) => this._onUp(e));
    canvas.addEventListener('pointercancel', (e) => this._onUp(e));
    canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

    // Live viewport changes (phone rotation, the mobile browser's address
    // bar collapsing/expanding on scroll, a resized window) all need to
    // recompute the fit — a ResizeObserver on the canvas's parent catches
    // most of these, but window resize/orientationchange and visualViewport
    // (the most reliable signal for mobile chrome show/hide) are added too
    // so a stale scale/position can never get stuck after a live resize.
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement || canvas);
    this._onWindowResize = () => this.resize();
    window.addEventListener('resize', this._onWindowResize);
    window.addEventListener('orientationchange', this._onWindowResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this._onWindowResize);
    this.resize();
  }

  resize() {
    const parent = this.canvas.parentElement || this.canvas;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.fit();
    this.draw();
  }

  fit() {
    const ext = boardExtent();
    const padX = CELL_W * 0.6;
    const padY = CELL_H * 0.6;
    this.fitScale = Math.min(this.w / (ext.w + padX * 2), this.h / (ext.h + padY * 2));
    this.scale = this.fitScale * this.userScale;
    this.cx = this.w / 2 - ((ext.minX + ext.maxX) / 2) * this.scale;
    this.cy = this.h / 2 - ((ext.minY + ext.maxY) / 2) * this.scale;
  }

  toScreen(x, y) {
    return [this.cx + x * this.scale + this.ox, this.cy + y * this.scale + this.oy];
  }
  toWorld(px, py) {
    return [(px - this.cx - this.ox) / this.scale, (py - this.cy - this.oy) / this.scale];
  }

  zoomBy(factor, atX, atY) {
    const before = this.toWorld(atX, atY);
    this.userScale = Math.max(0.6, Math.min(3.5, this.userScale * factor));
    this.scale = this.fitScale * this.userScale;
    const after = this.toWorld(atX, atY);
    this.ox += (after[0] - before[0]) * this.scale;
    this.oy += (after[1] - before[1]) * this.scale;
    this.clampPan();
    this.draw();
  }

  clampPan() {
    const margin = Math.min(this.w, this.h) * 0.4;
    const ext = boardExtent();
    const [sx0, sy0] = this.toScreen(ext.minX, ext.minY);
    const [sx1, sy1] = this.toScreen(ext.maxX, ext.maxY);
    if (sx1 < margin) this.ox += margin - sx1;
    if (sx0 > this.w - margin) this.ox -= sx0 - (this.w - margin);
    if (sy1 < margin) this.oy += margin - sy1;
    if (sy0 > this.h - margin) this.oy -= sy0 - (this.h - margin);
  }

  resetView() {
    this.userScale = 1;
    this.ox = 0;
    this.oy = 0;
    this.fit();
    this.draw();
  }

  // Briefly glows one cell — used to call out wherever the most recent move
  // happened (place, remove, or wild), so it's obvious even on someone
  // else's screen. Needs its own animation loop since nothing else would
  // otherwise trigger a redraw during the 3s window.
  flashCell(index) {
    this.flashIndex = index;
    this.flashStart = performance.now();
    if (!this._flashRaf) this._flashLoop();
  }

  _flashLoop() {
    const elapsed = performance.now() - this.flashStart;
    if (elapsed >= 3000) {
      this.flashIndex = null;
      this._flashRaf = null;
      this.draw();
      return;
    }
    this.draw();
    this._flashRaf = requestAnimationFrame(() => this._flashLoop());
  }

  // Animates a dragged chip's offset back to (0,0) once the finger lifts, then clears
  // the drag — the "zooms back over the card" half of the gesture. Reads its distance
  // fresh each frame from whatever peekDrag currently holds, so if a new drag starts
  // on another cell mid-animation (this one's inherently over, since dx/dy belong to
  // the index that was being dragged) this loop just naturally stops mattering.
  _snapBackPeek() {
    const drag = this.peekDrag;
    if (!drag) return;
    const startDx = drag.dx, startDy = drag.dy;
    const t0 = performance.now();
    const DUR = 220;
    const step = () => {
      if (this.peekDrag !== drag) return; // superseded by a new drag or another snap-back
      const t = Math.min(1, (performance.now() - t0) / DUR);
      const ease = 1 - (1 - t) ** 3;
      drag.dx = startDx * (1 - ease);
      drag.dy = startDy * (1 - ease);
      this.draw();
      if (t < 1) requestAnimationFrame(step);
      else { this.peekDrag = null; this.draw(); }
    };
    requestAnimationFrame(step);
  }

  destroy() {
    this.ro.disconnect();
    window.removeEventListener('resize', this._onWindowResize);
    window.removeEventListener('orientationchange', this._onWindowResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', this._onWindowResize);
  }

  hitTest(px, py) {
    const [x, y] = this.toWorld(px, py);
    return indexAtPoint(x, y);
  }

  // Where a cell's center actually is on screen right now, in CSS pixels relative to
  // the canvas's own top-left — exactly what a caller outside the canvas (an
  // absolutely-positioned DOM element sharing that origin) needs to land on it.
  cellScreenPoint(index) {
    return this.toScreen(...cellCenter(index));
  }

  _onDown(e) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* some browsers can reject this; harmless */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.moved = 0;
    if (this.pointers.size === 1) {
      const [p] = this.pointers.values();
      this.dragStart = { x: p.x, y: p.y };
      // Coming down on a covered cell starts a peek-drag instead of panning the
      // board: the chip follows the finger (see _onMove/_drawCell) instead of the
      // whole camera moving. A plain tap in place (see _onUp) still falls through
      // to onPick as before, so a legal move (a removal, most likely) still happens —
      // only an actual drag is peek-only.
      const rect = this.canvas.getBoundingClientRect();
      const idx = this.hitTest(p.x - rect.left, p.y - rect.top);
      this.peekDrag = (idx >= 0 && this.board[idx] != null) ? { index: idx, dx: 0, dy: 0 } : null;
    } else if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      this.pinch = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        mid: [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2],
      };
      // A second finger means this is turning into a pinch, not a one-finger peek —
      // snap whatever was being dragged back rather than leaving it stranded off-cell.
      this._snapBackPeek();
    }
  }

  _onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1 && this.dragStart) {
      const rect = this.canvas.getBoundingClientRect();
      const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const prev = { x: this.dragStart.x - rect.left, y: this.dragStart.y - rect.top };
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      this.moved += Math.abs(dx) + Math.abs(dy);
      this.dragStart = { x: e.clientX, y: e.clientY };
      if (this.peekDrag) {
        this.peekDrag.dx += dx;
        this.peekDrag.dy += dy;
      } else {
        this.ox += dx;
        this.oy += dy;
        this.clampPan();
      }
      this.draw();
    } else if (this.pointers.size === 2 && this.pinch) {
      const pts = [...this.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
      const rect = this.canvas.getBoundingClientRect();
      const factor = dist / (this.pinch.dist || dist);
      this.zoomBy(factor, mid[0] - rect.left, mid[1] - rect.top);
      this.pinch.dist = dist;
      this.moved += 5;
    }
  }

  _onUp(e) {
    const rect = this.canvas.getBoundingClientRect();
    const wasTap = this.pointers.size === 1 && this.moved < 9;
    const last = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) this.dragStart = null;

    if (this.peekDrag) {
      const idx = this.peekDrag.index;
      // A real drag (moved past the tap threshold) was purely a peek — releasing it
      // just snaps the chip back and does nothing else. A tap-in-place still plays
      // whatever move that cell is legal for, same as before this gesture existed.
      this._snapBackPeek();
      if (wasTap && last) {
        const px = last.x - rect.left, py = last.y - rect.top;
        if (this.hitTest(px, py) === idx) this.onPick(idx);
      }
      return;
    }
    if (wasTap && last) {
      const px = last.x - rect.left;
      const py = last.y - rect.top;
      const idx = this.hitTest(px, py);
      if (idx >= 0) this.onPick(idx);
    }
  }

  _onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.zoomBy(factor, e.clientX - rect.left, e.clientY - rect.top);
  }

  setState({ board, highlight, locked, myTeam }) {
    if (board) this.board = board;
    if (highlight) this.highlight = highlight;
    if (locked) this.locked = locked;
    if (myTeam != null) this.myTeam = myTeam;
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
      this._drawCell(i);
    }
  }

  _drawCell(index) {
    const ctx = this.ctx;
    const [wx, wy] = cellCenter(index);
    const [sx, sy] = this.toScreen(wx - CELL_W / 2, wy - CELL_H / 2);
    const w = CELL_W * this.scale;
    const h = CELL_H * this.scale;
    const corner = isCorner(index);
    const highlighted = this.highlight.has(index);
    const team = this.board[index];
    const radius = Math.min(w, h) * 0.14;

    ctx.save();
    ctx.fillStyle = corner ? '#2c3547' : '#f4efe4';
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.02);
    roundRect(ctx, sx, sy, w, h, radius);
    ctx.fill();
    ctx.stroke();

    if (highlighted) {
      ctx.fillStyle = 'rgba(255, 214, 51, 0.35)';
      roundRect(ctx, sx, sy, w, h, radius);
      ctx.fill();
      ctx.strokeStyle = '#ffd633';
      ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.06);
      roundRect(ctx, sx + ctx.lineWidth / 2, sy + ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth, radius);
      ctx.stroke();
    }

    if (corner) {
      ctx.fillStyle = '#ffd633';
      ctx.font = `${Math.min(w, h) * 0.4}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('★', sx + w / 2, sy + h / 2);
    } else {
      const code = cardAt(index);
      if (code && w > 12) {
        const suit = cardSuit(code);
        const rank = cardRank(code);
        ctx.fillStyle = SUIT_COLOR[suit] === 'red' ? '#b8302a' : '#22262e';
        ctx.font = `700 ${w * 0.6}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(rank, sx + w / 2, sy + h * 0.32);
        ctx.font = `${w * 0.68}px system-ui, sans-serif`;
        ctx.fillText(SUIT_SYMBOL[suit], sx + w / 2, sy + h * 0.68);
      }
    }

    // The card is already drawn underneath every chip above, so dragging the chip
    // aside to peek is just this cell's chip getting an offset — nothing else about
    // the cell needs to know a peek is happening.
    const dragOff = (this.peekDrag && this.peekDrag.index === index) ? this.peekDrag : null;
    if (team != null) {
      const r = Math.min(w, h) * 0.34;
      const cx = sx + w / 2 + (dragOff ? dragOff.dx : 0);
      const cy = sy + h / 2 + (dragOff ? dragOff.dy : 0);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = TEAM_COLOR[team];
      ctx.fill();
      ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.03);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.stroke();
      if (this.locked.has(index)) {
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fill();
      }
    }
    if (dragOff && (dragOff.dx !== 0 || dragOff.dy !== 0)) {
      ctx.strokeStyle = '#ffd633';
      ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.06);
      roundRect(ctx, sx + ctx.lineWidth / 2, sy + ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth, radius);
      ctx.stroke();
    }

    if (index === this.flashIndex) {
      const elapsed = performance.now() - this.flashStart;
      const pulse = 0.5 + 0.5 * Math.sin(elapsed / 110);
      ctx.globalAlpha = 0.3 + 0.35 * pulse;
      ctx.fillStyle = '#ffffff';
      roundRect(ctx, sx, sy, w, h, radius);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.07);
      ctx.strokeStyle = '#ffffff';
      roundRect(ctx, sx + ctx.lineWidth / 2, sy + ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth, radius);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  // w/h can go slightly negative during a transient resize (e.g. a cell
  // briefly narrower than the highlight border's line width) — arcTo throws
  // on a negative radius, which would silently abort the whole draw() call
  // (and everything after it in that render pass, like the hand tray).
  if (w <= 0 || h <= 0) return;
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export { TEAM_COLOR };
