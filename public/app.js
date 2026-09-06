import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot, runTransaction, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import { firebaseConfig } from './firebase-config.js';
import { APP_VERSION } from './version.js';
import {
  cardRank, cardSuit, SUIT_SYMBOL, SUIT_COLOR, isJack, isTwoEyedJack, isOneEyedJack,
  instanceCode, buildShuffledDeck, handSizeForTeamCount, sequencesNeededToWin,
} from './cards.js';
import {
  legalTargetsFor, isDeadCard, validateMove, findSequences, lockedIndicesFrom, checkWinner, nextTurnIndex,
  ambientHighlightSet,
} from './rules.js';
import { BoardView, TEAM_COLOR } from './render.js';

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

const $ = (id) => document.getElementById(id);
const TEAM_NAMES = ['Red', 'Blue', 'Green'];
const TURN_SECONDS = 30;

// ---------------- Player identity ----------------
let playerId = localStorage.getItem('cr_player_id');
if (!playerId) {
  playerId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
  localStorage.setItem('cr_player_id', playerId);
}
let playerName = localStorage.getItem('cr_player_name') || '';

// ---------------- State ----------------
let roomCode = null;
let roomRef = null;
let unsubRoom = null;
let room = null; // last snapshot data
let selectedInstanceId = null;
let boardView = null;
let lastSeenMoveTs = undefined; // undefined = not initialized yet for this room
let timerState = { startedAtMillis: null, perfAtReceipt: 0, wallAtReceipt: 0, timedOutFired: false };
let timerIntervalId = null;
let deferredInstallPrompt = null;

// ---------------- Small helpers ----------------
function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}
function showSheet(id) { $(id).hidden = false; }
function hideSheet(id) { $(id).hidden = true; }
function showScreen(id) {
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== id;
}
function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 4; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}

// ---------------- Version check / update banner ----------------
async function checkForUpdate() {
  try {
    const res = await fetch('version.js?nocache=' + Date.now(), { cache: 'no-store' });
    const text = await res.text();
    const m = text.match(/APP_VERSION\s*=\s*'([^']+)'/);
    if (m && m[1] !== APP_VERSION) announceUpdate();
  } catch (e) { /* offline — ignore */ }
}
function announceUpdate() { $('update-banner').hidden = false; }
const CORE_FILES = [
  'index.html', 'app.js', 'board.js', 'render.js', 'cards.js', 'rules.js',
  'firebase-config.js', 'version.js', 'styles.css', 'manifest.webmanifest',
];
async function fullRefresh() {
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    // Unregistering the service worker and clearing Cache Storage doesn't
    // touch the browser's own HTTP cache — without this, a plain reload can
    // still load stale cached copies of these ES modules even though the
    // server has newer ones, leaving the update banner stuck forever.
    await Promise.all(CORE_FILES.map((f) => fetch(f, { cache: 'reload' }).catch(() => {})));
  } catch (e) { /* ignore */ }
  const url = location.origin + location.pathname + '?fresh=' + Date.now();
  location.replace(url);
  setTimeout(() => { location.href = url; }, 400);
  setTimeout(() => { location.reload(); }, 900);
}
let lastVisCheck = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (now - lastVisCheck < 10 * 60 * 1000) return;
  lastVisCheck = now;
  checkForUpdate();
});
function watchPublishedVersion() {
  try {
    onSnapshot(doc(db, 'meta', 'version'), (snap) => {
      const v = snap.data() && snap.data().version;
      if (v && v !== APP_VERSION) announceUpdate();
    });
  } catch (e) { /* ignore */ }
}
$('update-refresh-btn').addEventListener('click', fullRefresh);

// ---------------- Service worker ----------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`sw.js?v=${APP_VERSION}`).catch(() => {});
  });
}

// ---------------- Install prompts ----------------
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
function updateInstallMenuItem() {
  $('kebab-install').hidden = isStandalone() || (!deferredInstallPrompt && !isIOS());
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  updateInstallMenuItem();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallMenuItem();
});
$('kebab-install').addEventListener('click', async () => {
  closeKebab();
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') deferredInstallPrompt = null;
    updateInstallMenuItem();
    return;
  }
  if (isIOS()) { showSheet('sheet-ios-install'); return; }
  toast('Already installed, or your browser doesn\'t support installing');
});
updateInstallMenuItem();
if (isIOS() && !isStandalone() && !localStorage.getItem('cr_ios_install_seen')) {
  setTimeout(() => {
    showSheet('sheet-ios-install');
    localStorage.setItem('cr_ios_install_seen', '1');
  }, 1500);
}

// ---------------- Kebab menu ----------------
function closeKebab() {
  $('kebab-menu').hidden = true;
  $('btn-kebab').setAttribute('aria-expanded', 'false');
}
$('btn-kebab').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('kebab-menu');
  const open = menu.hidden;
  menu.hidden = !open;
  $('btn-kebab').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => { if (!e.target.closest('#kebab-wrap')) closeKebab(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeKebab(); });
$('kebab-refresh').addEventListener('click', () => { closeKebab(); fullRefresh(); });
$('kebab-share').addEventListener('click', async () => {
  closeKebab();
  const url = location.origin + location.pathname;
  const text = roomCode ? `Join my Chain Reaction game — room code ${roomCode}` : 'Play Chain Reaction with me!';
  if (navigator.share) {
    try { await navigator.share({ title: 'Chain Reaction', text, url }); } catch (e) {}
    return;
  }
  await navigator.clipboard.writeText(`${text} ${url}`);
  toast('Link copied');
});
$('kebab-about').addEventListener('click', () => {
  closeKebab();
  $('about-version').textContent = `Version ${APP_VERSION}`;
  showSheet('sheet-about');
});
$('kebab-pause').addEventListener('click', async () => {
  closeKebab();
  if (!room || !roomRef) return;
  const next = !room.paused;
  const patch = { paused: next, pausedBy: next ? playerId : null };
  // Resuming gives the current player a fresh 30s rather than trying to
  // account for time spent paused — simpler and avoids clock-skew math.
  if (!next) patch['game.turnStartedAt'] = serverTimestamp();
  await updateDoc(roomRef, patch).catch(() => toast('Could not update pause state'));
});
$('btn-resume-game').addEventListener('click', async () => {
  if (!room || !roomRef) return;
  await updateDoc(roomRef, { paused: false, pausedBy: null, 'game.turnStartedAt': serverTimestamp() }).catch(() => toast('Could not resume'));
});
$('kebab-restart').addEventListener('click', async () => {
  closeKebab();
  if (!room || !roomRef || room.hostId !== playerId) return;
  if (!confirm('Restart the game? Everyone gets a fresh deal.')) return;
  const teamCount = room.settings.teamCount;
  const order = room.order && room.order.length ? room.order : Object.keys(room.players);
  const game = dealNewGame(order, teamCount);
  await updateDoc(roomRef, { state: 'playing', paused: false, pausedBy: null, game }).catch(() => toast('Could not restart game'));
});
$('kebab-leave-game').addEventListener('click', () => {
  closeKebab();
  if (!confirm('Leave this game?')) return;
  leaveRoom();
});
for (const el of document.querySelectorAll('[data-close]')) {
  el.addEventListener('click', (e) => { e.target.closest('.sheet-backdrop').hidden = true; });
}

// ---------------- Home screen ----------------
$('home-version').textContent = `v${APP_VERSION}`;
$('kebab-wrap').hidden = false;
$('input-name').value = playerName;
$('input-name').addEventListener('input', (e) => {
  playerName = e.target.value.trim();
  localStorage.setItem('cr_player_name', playerName);
});

let chosenTeamCount = 2;
for (const btn of document.querySelectorAll('#team-count-seg button')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#team-count-seg button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    chosenTeamCount = Number(btn.dataset.teams);
  });
}

$('btn-create').addEventListener('click', createRoom);
$('btn-join').addEventListener('click', () => {
  const code = $('input-code').value.trim().toUpperCase();
  if (code.length < 4) { toast('Enter a room code'); return; }
  joinRoom(code);
});

function requireName() {
  if (!playerName) { toast('Enter your name first'); return false; }
  return true;
}

async function createRoom() {
  if (!requireName()) return;
  $('btn-create').disabled = true;
  try {
    let code = null;
    for (let i = 0; i < 12; i++) {
      const candidate = makeCode();
      const snap = await getDoc(doc(db, 'rooms', candidate));
      if (!snap.exists()) { code = candidate; break; }
    }
    if (!code) { toast('Could not create room, try again'); return; }
    const data = {
      code,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 3600 * 1000,
      hostId: playerId,
      state: 'lobby',
      settings: { teamCount: chosenTeamCount },
      players: { [playerId]: { name: playerName, team: 0, joinedAt: Date.now() } },
      order: [],
      game: null,
    };
    setDoc(doc(db, 'rooms', code), data).catch(() => {});
    enterRoom(code);
  } finally {
    $('btn-create').disabled = false;
  }
}

async function joinRoom(code) {
  if (!requireName()) return;
  $('btn-join').disabled = true;
  try {
    const ref = doc(db, 'rooms', code);
    const snap = await getDoc(ref);
    if (!snap.exists()) { toast('Room not found'); return; }
    const data = snap.data();
    if (data.state !== 'lobby' && !data.players[playerId]) { toast('That game already started'); return; }
    if (!data.players[playerId]) {
      await updateDoc(ref, {
        [`players.${playerId}`]: { name: playerName, team: 0, joinedAt: Date.now() },
      });
    }
    enterRoom(code);
  } catch (e) {
    toast('Could not join room');
  } finally {
    $('btn-join').disabled = false;
  }
}

function enterRoom(code) {
  roomCode = code;
  roomRef = doc(db, 'rooms', code);
  lastSeenMoveTs = undefined;
  localStorage.setItem('cr_room', code);
  if (unsubRoom) unsubRoom();
  unsubRoom = onSnapshot(roomRef, (snap) => {
    if (!snap.exists()) {
      toast('The room was closed');
      leaveRoom();
      return;
    }
    room = snap.data();
    applyRoom();
  }, () => {});
}

function leaveRoom() {
  if (unsubRoom) unsubRoom();
  unsubRoom = null;
  roomRef = null;
  roomCode = null;
  room = null;
  selectedInstanceId = null;
  stopTurnTimer();
  localStorage.removeItem('cr_room');
  showScreen('screen-home');
}
$('btn-leave-lobby').addEventListener('click', leaveRoom);
$('btn-win-home').addEventListener('click', () => { $('win-overlay').hidden = true; leaveRoom(); });

// ---------------- Room state -> screens ----------------
function applyRoom() {
  if (!room) return;
  updateGameKebabVisibility();
  if (room.state === 'lobby') { renderLobby(); showScreen('screen-lobby'); }
  else if (room.state === 'playing' || room.state === 'finished') {
    showScreen('screen-game');
    ensureBoardView();
    boardView.resize();
    renderGame();
    if (room.state === 'finished' && room.game && room.game.winnerTeam != null) {
      showWinOverlay(room.game.winnerTeam);
    }
  }
}

function updateGameKebabVisibility() {
  const inGame = room && (room.state === 'playing' || room.state === 'finished');
  $('kebab-leave-game').hidden = !inGame;
  $('kebab-restart').hidden = !inGame || room.hostId !== playerId;
  $('kebab-pause').hidden = !inGame || room.state === 'finished';
  $('kebab-pause').innerHTML = room.paused
    ? '<span>&#9654;&#65039;</span>Resume Game'
    : '<span>&#9208;&#65039;</span>Pause Game';
}

function renderLobby() {
  $('lobby-code').textContent = roomCode;
  const wrap = $('lobby-players');
  wrap.innerHTML = '';
  const teamCount = room.settings.teamCount;
  for (const [pid, p] of Object.entries(room.players)) {
    const row = document.createElement('div');
    row.className = 'player-row';
    const dot = document.createElement('div');
    dot.className = 'team-dot';
    dot.style.background = TEAM_COLOR[p.team] || '#888';
    if (pid === playerId) {
      dot.title = 'Tap to change team';
      dot.style.cursor = 'pointer';
      dot.addEventListener('click', () => cycleMyTeam(teamCount));
    }
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = p.name + (pid === room.hostId ? ' (host)' : '') + (pid === playerId ? ' — you' : '');
    row.appendChild(dot);
    row.appendChild(name);
    wrap.appendChild(row);
  }
  $('btn-start-game').style.display = room.hostId === playerId ? '' : 'none';
}

async function cycleMyTeam(teamCount) {
  const cur = room.players[playerId].team || 0;
  const next = (cur + 1) % teamCount;
  await updateDoc(roomRef, { [`players.${playerId}.team`]: next }).catch(() => {});
}

$('btn-start-game').addEventListener('click', async () => {
  if (!room || room.hostId !== playerId) return;
  const teamCount = room.settings.teamCount;
  const pids = Object.keys(room.players);
  if (pids.length < 2) { toast('Need at least 2 players'); return; }
  const teamsUsed = new Set(pids.map((pid) => room.players[pid].team));
  for (let t = 0; t < teamCount; t++) {
    if (!teamsUsed.has(t)) { toast(`Team ${TEAM_NAMES[t]} has no players`); return; }
  }
  const order = pids.slice().sort((a, b) => room.players[a].joinedAt - room.players[b].joinedAt);
  const game = dealNewGame(order, teamCount);
  await updateDoc(roomRef, { state: 'playing', paused: false, pausedBy: null, order, game }).catch(() => toast('Could not start game'));
});

function dealNewGame(order, teamCount) {
  const deck = buildShuffledDeck(Date.now());
  const handSize = handSizeForTeamCount(teamCount);
  const hands = {};
  for (const pid of order) {
    hands[pid] = deck.splice(0, handSize);
  }
  return {
    deck,
    hands,
    board: new Array(100).fill(null),
    sequences: [],
    currentPlayerId: order[0],
    turnIndex: 0,
    winnerTeam: null,
    lastMove: null,
    turnStartedAt: serverTimestamp(),
  };
}

// ---------------- Game screen ----------------
function ensureBoardView() {
  if (boardView) return;
  boardView = new BoardView($('board-canvas'), { onPick: onBoardPick });
  $('btn-zoom-in').addEventListener('click', () => boardView.zoomBy(1.25, boardView.w / 2, boardView.h / 2));
  $('btn-zoom-out').addEventListener('click', () => boardView.zoomBy(0.8, boardView.w / 2, boardView.h / 2));
  $('btn-zoom-reset').addEventListener('click', () => boardView.resetView());
}

function myTeam() {
  return room.players[playerId] ? room.players[playerId].team : 0;
}
function isMyTurn() {
  return room.game && !room.paused && room.game.currentPlayerId === playerId && room.state === 'playing';
}

function renderGame() {
  const game = room.game;
  if (!game) return;
  const teamCount = room.settings.teamCount;
  const sequences = findSequences(game.board, teamCount);
  const locked = lockedIndicesFrom(sequences);
  let highlight = new Set();
  if (isMyTurn()) {
    if (selectedInstanceId) {
      // A selected wild jack can go on any empty cell — highlighting all of
      // them would just flood the board, so show nothing and let the player
      // tap wherever they want (validateMove still allows any empty cell).
      if (!isTwoEyedJack(instanceCode(selectedInstanceId))) {
        const { targets } = legalTargetsFor(game.board, selectedInstanceId);
        highlight = new Set(targets);
      }
    } else {
      const hand = game.hands[playerId] || [];
      highlight = ambientHighlightSet(game.board, hand, locked);
    }
  }
  boardView.setState({ board: game.board, highlight, locked, myTeam: myTeam() });

  const turnBanner = $('turn-banner');
  const curPid = game.currentPlayerId;
  const curPlayer = room.players[curPid];
  if (!curPlayer) {
    // The current player left, or turn state points at someone no longer in
    // the room — don't crash the render, just say so plainly.
    turnBanner.textContent = 'Waiting — a player is missing. Try Restart Game.';
  } else if (isMyTurn()) {
    turnBanner.innerHTML = `<span class="team-dot" style="background:${TEAM_COLOR[myTeam()]}"></span> Your turn`;
  } else if (room.paused) {
    turnBanner.innerHTML = `<span class="team-dot" style="background:${TEAM_COLOR[curPlayer.team]}"></span> Paused`;
  } else {
    turnBanner.innerHTML = `<span class="team-dot" style="background:${TEAM_COLOR[curPlayer.team]}"></span> ${curPlayer.name}'s turn`;
  }

  updateTurnTimer(game);

  if (game.lastMove && game.lastMove.ts !== lastSeenMoveTs) {
    const isFirstLoad = lastSeenMoveTs === undefined;
    lastSeenMoveTs = game.lastMove.ts;
    if (!isFirstLoad) showShoutout(game.lastMove);
  }

  const pauseOverlay = $('pause-overlay');
  if (room.paused && room.state === 'playing') {
    const byName = (room.players[room.pausedBy] && room.players[room.pausedBy].name) || 'A player';
    $('pause-by-text').textContent = `Paused by ${byName}`;
    pauseOverlay.hidden = false;
  } else {
    pauseOverlay.hidden = true;
  }

  renderHand();
}

function renderHand() {
  const game = room.game;
  const scroller = $('hand-scroller');
  scroller.innerHTML = '';
  const hand = game.hands[playerId] || [];
  const teamCount = room.settings.teamCount;
  const sequences = findSequences(game.board, teamCount);
  const locked = lockedIndicesFrom(sequences);

  for (const instanceId of hand) {
    const code = instanceCode(instanceId);
    const card = document.createElement('div');
    card.className = 'hand-card';
    if (SUIT_COLOR[cardSuit(code)] === 'red') card.classList.add('red');
    if (instanceId === selectedInstanceId) card.classList.add('selected');
    if (isMyTurn() && isDeadCard(game.board, instanceId, locked)) card.classList.add('dead');
    if (isTwoEyedJack(code)) card.classList.add('jack-wild');
    else if (isOneEyedJack(code)) card.classList.add('jack-remove');
    card.innerHTML = `<div class="r">${cardRank(code)}</div><div class="s">${SUIT_SYMBOL[cardSuit(code)]}</div>`;
    card.addEventListener('click', () => onHandCardTap(instanceId));
    scroller.appendChild(card);
  }

  const hint = $('hand-hint');
  const deadBtn = $('btn-dead-card');
  if (isMyTurn() && selectedInstanceId) {
    const dead = isDeadCard(game.board, selectedInstanceId, locked);
    if (dead) {
      hint.textContent = 'No open spots for this card.';
      deadBtn.hidden = false;
    } else {
      const code = instanceCode(selectedInstanceId);
      hint.textContent = isTwoEyedJack(code)
        ? 'Wild! Tap anywhere on the board to place your chip.'
        : isOneEyedJack(code)
        ? 'Tap an opponent chip to remove it.'
        : 'Tap the highlighted space to place your chip.';
      deadBtn.hidden = true;
    }
  } else if (isMyTurn()) {
    const anyPlay = hand.some((id) => !isDeadCard(game.board, id, locked));
    hint.textContent = anyPlay
      ? 'Tap a card in your hand to play it'
      : 'No plays available — tap a card to swap it';
    deadBtn.hidden = true;
  } else {
    hint.textContent = 'Waiting for your turn…';
    deadBtn.hidden = true;
  }
}

function onHandCardTap(instanceId) {
  if (!isMyTurn()) return;
  selectedInstanceId = selectedInstanceId === instanceId ? null : instanceId;
  renderGame();
}

function onBoardPick(index) {
  if (!isMyTurn() || !selectedInstanceId) return;
  const game = room.game;
  const teamCount = room.settings.teamCount;
  const sequences = findSequences(game.board, teamCount);
  const locked = lockedIndicesFrom(sequences);
  const result = validateMove(game.board, selectedInstanceId, index, locked);
  if (!result.ok) return;
  applyMove(selectedInstanceId, index, result.action);
}

$('btn-dead-card').addEventListener('click', () => {
  if (!isMyTurn() || !selectedInstanceId) return;
  applyDeadCardSwap(selectedInstanceId);
});

async function applyMove(instanceId, targetIndex, action) {
  const myPid = playerId;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) throw new Error('room-gone');
      const data = snap.data();
      const game = data.game;
      const teamCount = data.settings.teamCount;
      if (!game || data.paused || game.currentPlayerId !== myPid || data.state !== 'playing') throw new Error('not-your-turn');
      const hand = game.hands[myPid] || [];
      if (!hand.includes(instanceId)) throw new Error('card-not-in-hand');
      const sequencesBefore = findSequences(game.board, teamCount);
      const locked = lockedIndicesFrom(sequencesBefore);
      const check = validateMove(game.board, instanceId, targetIndex, locked);
      if (!check.ok) throw new Error(check.reason);

      const board = game.board.slice();
      const team = data.players[myPid].team;
      if (check.action === 'place') board[targetIndex] = team;
      else board[targetIndex] = null;

      const newHand = hand.filter((c) => c !== instanceId);
      const deck = game.deck.slice();
      if (deck.length > 0) newHand.push(deck.shift());
      const hands = { ...game.hands, [myPid]: newHand };

      const sequences = findSequences(board, teamCount);
      const winnerTeam = checkWinner(sequences, teamCount);
      const order = data.order;
      const turnIndex = nextTurnIndex(game.turnIndex, order.length);
      const currentPlayerId = winnerTeam == null ? order[turnIndex] : game.currentPlayerId;
      const lastMove = {
        type: 'card',
        playerId: myPid,
        name: data.players[myPid].name,
        code: instanceCode(instanceId),
        action: check.action,
        targetIndex,
        ts: Date.now(),
      };

      tx.update(roomRef, {
        'game.board': board,
        'game.hands': hands,
        'game.deck': deck,
        'game.sequences': sequences,
        'game.turnIndex': winnerTeam == null ? turnIndex : game.turnIndex,
        'game.currentPlayerId': currentPlayerId,
        'game.winnerTeam': winnerTeam,
        'game.lastMove': lastMove,
        ...(winnerTeam == null ? { 'game.turnStartedAt': serverTimestamp() } : { state: 'finished' }),
      });
    });
    selectedInstanceId = null;
  } catch (e) {
    toast('Move rejected — board may have changed');
  }
}

async function applyDeadCardSwap(instanceId) {
  const myPid = playerId;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) throw new Error('room-gone');
      const data = snap.data();
      const game = data.game;
      const teamCount = data.settings.teamCount;
      if (!game || data.paused || game.currentPlayerId !== myPid || data.state !== 'playing') throw new Error('not-your-turn');
      const hand = game.hands[myPid] || [];
      if (!hand.includes(instanceId)) throw new Error('card-not-in-hand');
      const sequences = findSequences(game.board, teamCount);
      const locked = lockedIndicesFrom(sequences);
      if (!isDeadCard(game.board, instanceId, locked)) throw new Error('card-not-dead');

      const newHand = hand.filter((c) => c !== instanceId);
      const deck = game.deck.slice();
      if (deck.length > 0) newHand.push(deck.shift());
      const hands = { ...game.hands, [myPid]: newHand };
      const order = data.order;
      const turnIndex = nextTurnIndex(game.turnIndex, order.length);

      tx.update(roomRef, {
        'game.hands': hands,
        'game.deck': deck,
        'game.turnIndex': turnIndex,
        'game.currentPlayerId': order[turnIndex],
        'game.turnStartedAt': serverTimestamp(),
      });
    });
    selectedInstanceId = null;
  } catch (e) {
    toast('Could not swap card');
  }
}

// A server-timestamped turnStartedAt (not any device's local clock) is the
// source of truth for the 30s turn timer — this is the same clock-skew
// lesson from the other apps: iPhones (and everything else) can't be
// trusted to agree with each other, only the server's clock is shared.
// Every connected client independently notices when time is up and tries
// this transaction; the guard on turnStartedAt makes it a safe no-op for
// every attempt after the first one that actually lands.
async function attemptTurnTimeout(expectedStartedAtMillis) {
  if (!roomRef) return;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) return;
      const data = snap.data();
      const game = data.game;
      if (!game || data.paused || data.state !== 'playing') return;
      const startedAt = game.turnStartedAt;
      if (!startedAt || startedAt.toMillis() !== expectedStartedAtMillis) return;
      const order = data.order;
      const timedOutPlayer = data.players[game.currentPlayerId];
      const turnIndex = nextTurnIndex(game.turnIndex, order.length);
      tx.update(roomRef, {
        'game.turnIndex': turnIndex,
        'game.currentPlayerId': order[turnIndex],
        'game.turnStartedAt': serverTimestamp(),
        'game.lastMove': { type: 'timeout', name: timedOutPlayer ? timedOutPlayer.name : 'A player', ts: Date.now() },
      });
    });
  } catch (e) { /* another client already handled it — fine */ }
}

function stopTurnTimer() {
  if (timerIntervalId) { clearInterval(timerIntervalId); timerIntervalId = null; }
  timerState = { startedAtMillis: null, perfAtReceipt: 0, wallAtReceipt: 0, timedOutFired: false };
  $('turn-timer').hidden = true;
}

function updateTurnTimer(game) {
  if (!game || room.state !== 'playing' || room.paused || !game.turnStartedAt) {
    stopTurnTimer();
    return;
  }
  const startedAtMillis = game.turnStartedAt.toMillis();
  if (timerState.startedAtMillis !== startedAtMillis) {
    timerState = { startedAtMillis, perfAtReceipt: performance.now(), wallAtReceipt: Date.now(), timedOutFired: false };
  }
  $('turn-timer').hidden = false;
  if (!timerIntervalId) timerIntervalId = setInterval(tickTurnTimer, 250);
  tickTurnTimer();
}

function tickTurnTimer() {
  const { startedAtMillis, wallAtReceipt, perfAtReceipt } = timerState;
  if (startedAtMillis == null) return;
  // Elapsed time = (gap between server turn-start and when we anchored it,
  // per our own clock) + (monotonic time since anchoring). The one-time
  // wall-clock read only sets the starting offset; performance.now() never
  // jumps, so a skewed or drifting device clock can't desync the countdown
  // mid-turn — only the very first reading depends on the local clock at all.
  const elapsed = (wallAtReceipt - startedAtMillis) + (performance.now() - perfAtReceipt);
  const remainingMs = TURN_SECONDS * 1000 - elapsed;
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const el = $('turn-timer');
  el.textContent = `⏱ ${seconds}s`;
  el.classList.toggle('low', seconds <= 10);
  if (remainingMs <= 0 && !timerState.timedOutFired) {
    timerState.timedOutFired = true;
    attemptTurnTimeout(startedAtMillis);
  }
}

function showShoutout(move) {
  const cardEl = $('shoutout-card');
  if (move.type === 'timeout') {
    cardEl.className = 'shoutout-card';
    cardEl.innerHTML = '<div class="s">&#9203;</div>';
    $('shoutout-text').textContent = `${move.name}'s time ran out!`;
  } else {
    const rank = cardRank(move.code);
    const suit = cardSuit(move.code);
    cardEl.className = 'shoutout-card' + (SUIT_COLOR[suit] === 'red' ? ' red' : '');
    cardEl.innerHTML = `<div class="r">${rank}</div><div class="s">${SUIT_SYMBOL[suit]}</div>`;
    const verb = isTwoEyedJack(move.code)
      ? 'played a WILD card!'
      : isOneEyedJack(move.code)
      ? 'removed a chip!'
      : 'played a card!';
    $('shoutout-text').textContent = `${move.name} ${verb}`;
  }
  const el = $('shoutout');
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth; // restart the transition if one is already showing
  el.classList.add('show');
  clearTimeout(showShoutout._t);
  showShoutout._t = setTimeout(() => { el.classList.remove('show'); }, 2600);
}

function showWinOverlay(winnerTeam) {
  const overlay = $('win-overlay');
  if (overlay.dataset.shownFor === String(winnerTeam)) return;
  overlay.dataset.shownFor = String(winnerTeam);
  $('win-title').textContent = `🎉 Team ${TEAM_NAMES[winnerTeam]} wins!`;
  overlay.hidden = false;
}

// ---------------- Boot ----------------
watchPublishedVersion();
checkForUpdate();
const savedRoom = localStorage.getItem('cr_room');
if (savedRoom) enterRoom(savedRoom);
