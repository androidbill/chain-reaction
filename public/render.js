// Pan/zoom canvas camera + board renderer. Camera math ported from
// HexColony's BoardView pattern (fit/toScreen/toWorld/zoomBy/clampPan).
import { BOARD_SIZE, CELL_W, CELL_H, boardExtent, cellCenter, indexAtPoint, cardAt } from './board.js';
import { isCorner } from './cards.js';
import { cardSuit, cardRank, SUIT_SYMBOL, SUIT_COLOR } from './cards.js';

const TEAM_COLOR = ['#e0473c', '#3b7fe0', '#3fb56b']; // red, blue, green
const TEAM_COLOR_SOFT = ['rgba(224,71,60,0.22)', 'rgba(59,127,224,0.22)', 'rgba(63,181,107,0.22)'];

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

  _onDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.moved = 0;
    if (this.pointers.size === 1) {
      const [p] = this.pointers.values();
      this.dragStart = { x: p.x, y: p.y };
    } else if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      this.pinch = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        mid: [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2],
      };
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
      this.ox += dx;
      this.oy += dy;
      this.moved += Math.abs(dx) + Math.abs(dy);
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.clampPan();
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
        ctx.font = `700 ${w * 0.3}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(rank, sx + w / 2, sy + h * 0.32);
        ctx.font = `${w * 0.34}px system-ui, sans-serif`;
        ctx.fillText(SUIT_SYMBOL[suit], sx + w / 2, sy + h * 0.68);
      }
    }

    if (team != null) {
      const r = Math.min(w, h) * 0.34;
      ctx.beginPath();
      ctx.arc(sx + w / 2, sy + h / 2, r, 0, Math.PI * 2);
      ctx.fillStyle = TEAM_COLOR[team];
      ctx.fill();
      ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.03);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.stroke();
      if (this.locked.has(index)) {
        ctx.beginPath();
        ctx.arc(sx + w / 2, sy + h / 2, r * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export { TEAM_COLOR, TEAM_COLOR_SOFT };
