import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeFirestore, doc, getDoc, getDocFromServer, setDoc, updateDoc, onSnapshot,
  runTransaction, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import { firebaseConfig } from './firebase-config.js';
import { APP_VERSION } from './version.js';
import {
  cardRank, cardSuit, SUIT_SYMBOL, SUIT_COLOR, isJack, isTwoEyedJack, isOneEyedJack,
  instanceCode, buildShuffledDeck, handSizeForTeamCount, sequencesNeededToWin,
} from './cards.js';
import {
  isDeadCard, validateMove, findSequences, lockedIndicesFrom, checkWinner, nextTurnIndex,
  ambientHighlightSet, autoResolveTargets, countSequencesByTeam,
} from './rules.js';
import { BoardView, TEAM_COLOR } from './render.js';

const fbApp = initializeApp(firebaseConfig);
// iOS Safari (including installed PWAs) frequently stalls the SDK's default WebChannel
// stream for 10-20s on a cold connection — Android/Chrome never shows this. Auto-detecting
// long polling, and doing it over XHR rather than fetch streams (which Safari's networking
// stack handles poorly under a service worker), makes the very first connection reliable
// instead of waiting out a timeout-and-fallback dance.
const db = initializeFirestore(fbApp, {
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false,
});

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
let boardView = null;
const UNDO_ENABLED = false; // flip to true to bring back the 3s undo window
const UNDO_MS = 3000;
let pendingMove = null; // { instanceId, index, action, code, deadline } — staged locally before commit
let pendingMoveTimeout = null;
let lastSeenMoveTs = undefined; // undefined = not initialized yet for this room
let wasMyTurn = undefined; // undefined = not initialized yet for this room
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

// ---------------- Notification sounds (synthesized, no audio assets) ----------------
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}
// Browsers block audio until a user gesture — unlock on the first tap
// anywhere so sounds are ready by the time a turn/move actually happens.
document.addEventListener('pointerdown', ensureAudio, { once: true });

function playTone(freq, { start = 0, duration = 0.16, type = 'sine', volume = 0.22 } = {}) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + start;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(volume, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}
// A rising two-note chime — distinct from the move tick so "it's your turn"
// never gets confused with "someone just played a card".
function playTurnSound() {
  ensureAudio();
  playTone(587, { start: 0, duration: 0.14, type: 'sine', volume: 0.22 });
  playTone(784, { start: 0.12, duration: 0.22, type: 'sine', volume: 0.24 });
}
// A single short, low-key tick for any card played (place, remove, or wild).
function playMoveSound() {
  ensureAudio();
  playTone(392, { start: 0, duration: 0.1, type: 'triangle', volume: 0.16 });
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
  wasMyTurn = undefined;
  lastVotesSignature = null;
  localStorage.setItem('cr_room', code);
  subscribeRoom();
  // The listener above can still be the one that stalls on a cold iOS connection. A direct
  // server read runs over a fresh request rather than the long-lived stream, so it lands
  // even while that stream is still negotiating — the first paint stops depending on it.
  getDocFromServer(roomRef).then((snap) => {
    if (snap.exists()) { room = snap.data(); applyRoom(); }
  }).catch(() => {});
}

function subscribeRoom() {
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

// A backgrounded phone's realtime stream can go stale and not notice for a while once the
// tab is foregrounded again — the same stall that hits a cold connection can recur after a
// lock/unlock. Re-attaching the listener and forcing one server read on return covers both:
// whichever one is currently wedged gets replaced/refreshed immediately instead of waiting
// on the SDK's own retry timing.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !roomRef) return;
  subscribeRoom();
  getDocFromServer(roomRef).then((snap) => {
    if (snap.exists()) { room = snap.data(); applyRoom(); }
  }).catch(() => {});
});

function leaveRoom() {
  if (unsubRoom) unsubRoom();
  unsubRoom = null;
  roomRef = null;
  roomCode = null;
  room = null;
  cancelPendingMove();
  stopTurnTimer();
  localStorage.removeItem('cr_room');
  showScreen('screen-home');
}
$('btn-leave-lobby').addEventListener('click', leaveRoom);

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
    startedAt: serverTimestamp(),
    finishedAt: null,
    completedLines: [],
    stats: {},
    playAgainVotes: {},
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

// A persistent strip showing every player's team and how many lines their
// team has completed so far — the shoutout is a one-off notice, this is
// the "up by their name" running record the user also asked for.
function renderPlayersStrip(sequences, teamCount) {
  const strip = $('players-strip');
  strip.innerHTML = '';
  const counts = countSequencesByTeam(sequences, teamCount);
  const needed = sequencesNeededToWin(teamCount);
  const order = (room.order && room.order.length ? room.order : Object.keys(room.players));
  for (const pid of order) {
    const p = room.players[pid];
    if (!p) continue;
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    const dot = document.createElement('span');
    dot.className = 'team-dot';
    dot.style.background = TEAM_COLOR[p.team] || '#888';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.name;
    const pips = document.createElement('span');
    const have = counts[p.team] || 0;
    for (let i = 0; i < needed; i++) {
      const pip = document.createElement('span');
      pip.className = 'pip';
      pip.style.background = i < have ? TEAM_COLOR[p.team] : 'transparent';
      pip.style.border = `1px solid ${TEAM_COLOR[p.team] || '#888'}`;
      pips.appendChild(pip);
    }
    chip.appendChild(dot);
    chip.appendChild(name);
    chip.appendChild(pips);
    strip.appendChild(chip);
  }
}

function renderGame() {
  const game = room.game;
  if (!game) return;
  const teamCount = room.settings.teamCount;
  const sequences = findSequences(game.board, teamCount);
  const locked = lockedIndicesFrom(sequences);

  // While a move is staged (pending the undo window), preview it locally —
  // nothing is written to Firestore yet, so this is purely a display overlay.
  let displayBoard = game.board;
  if (pendingMove) {
    displayBoard = game.board.slice();
    displayBoard[pendingMove.index] = pendingMove.action === 'place' ? myTeam() : null;
  }

  let highlight = new Set();
  if (isMyTurn() && !pendingMove) {
    const hand = game.hands[playerId] || [];
    highlight = ambientHighlightSet(game.board, hand, locked);
  }
  boardView.setState({ board: displayBoard, highlight, locked, myTeam: myTeam() });
  renderPlayersStrip(sequences, teamCount);

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
    if (!isFirstLoad) {
      showShoutout(game.lastMove);
      if (game.lastMove.type === 'card') {
        playMoveSound();
        boardView.flashCell(game.lastMove.targetIndex);
      }
    }
  }

  if (isMyTurn() !== wasMyTurn) {
    if (isMyTurn() && wasMyTurn !== undefined) playTurnSound();
    wasMyTurn = isMyTurn();
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

const CARD_ASPECT = 0.72; // width/height, matches the board's card-shaped cells
function renderHand() {
  const game = room.game;
  const scroller = $('hand-scroller');
  scroller.innerHTML = '';
  const fullHand = game.hands[playerId] || [];
  // The card being played is hidden from the hand as soon as it's staged,
  // before the move is even committed — makes the preview feel immediate.
  const hand = pendingMove ? fullHand.filter((id) => id !== pendingMove.instanceId) : fullHand;
  const teamCount = room.settings.teamCount;
  const sequences = findSequences(game.board, teamCount);
  const locked = lockedIndicesFrom(sequences);

  for (const instanceId of hand) {
    const code = instanceCode(instanceId);
    const card = document.createElement('div');
    card.className = 'hand-card';
    if (SUIT_COLOR[cardSuit(code)] === 'red') card.classList.add('red');
    if (isMyTurn() && isDeadCard(game.board, instanceId, locked)) card.classList.add('dead');
    let badge = '';
    if (isTwoEyedJack(code)) {
      card.classList.add('jack-wild');
      badge = '<span class="jack-badge wild" title="Wild — play anywhere">W</span>';
    } else if (isOneEyedJack(code)) {
      card.classList.add('jack-remove');
      badge = '<span class="jack-badge remove" title="Removal — take an opponent\'s chip">✕</span>';
    }
    card.innerHTML = `<div class="r">${cardRank(code)}</div><div class="s">${SUIT_SYMBOL[cardSuit(code)]}</div>${badge}`;
    scroller.appendChild(card);
  }

  // Explicitly size every card from the tray's real width so all of them
  // (up to 7) always fit with no horizontal scrolling, on any device —
  // flexbox shrink + aspect-ratio alone proved unreliable across browsers.
  if (hand.length > 0) {
    const gap = 6;
    const available = scroller.clientWidth - gap * (hand.length - 1);
    const width = Math.max(30, Math.min(62, Math.floor(available / hand.length)));
    for (const el of scroller.children) {
      el.style.width = width + 'px';
      el.style.height = Math.round(width / CARD_ASPECT) + 'px';
    }
  }

  const hint = $('hand-hint');
  const deadBtn = $('btn-dead-card');
  $('hand-footer').hidden = !!pendingMove;
  $('undo-bar').hidden = !pendingMove;
  if (isMyTurn()) {
    const map = autoResolveTargets(game.board, fullHand, locked);
    hint.textContent = map.size > 0
      ? 'Tap a highlighted space to play a card'
      : 'No plays available — swap a dead card';
    deadBtn.hidden = map.size > 0;
  } else {
    hint.textContent = 'Waiting for your turn…';
    deadBtn.hidden = true;
  }
}

function onBoardPick(index) {
  if (!isMyTurn() || pendingMove) return;
  const game = room.game;
  const teamCount = room.settings.teamCount;
  const sequences = findSequences(game.board, teamCount);
  const locked = lockedIndicesFrom(sequences);
  const hand = game.hands[playerId] || [];
  const map = autoResolveTargets(game.board, hand, locked);
  const entry = map.get(index);
  if (!entry) return;
  if (UNDO_ENABLED) startPendingMove(entry, index);
  else applyMove(entry.instanceId, index, entry.action);
}

$('btn-dead-card').addEventListener('click', () => {
  if (!isMyTurn() || pendingMove) return;
  const game = room.game;
  const teamCount = room.settings.teamCount;
  const sequences = findSequences(game.board, teamCount);
  const locked = lockedIndicesFrom(sequences);
  const hand = game.hands[playerId] || [];
  const deadCard = hand.find((id) => isDeadCard(game.board, id, locked));
  if (deadCard) applyDeadCardSwap(deadCard);
});

// ---------------- Stage-then-commit move flow (3s undo window) ----------------
let undoCountdownInterval = null;

function startPendingMove(entry, index) {
  pendingMove = { instanceId: entry.instanceId, index, action: entry.action, code: instanceCode(entry.instanceId) };
  renderGame();
  let remaining = Math.ceil(UNDO_MS / 1000);
  $('btn-undo-move').textContent = `Undo (${remaining})`;
  clearInterval(undoCountdownInterval);
  undoCountdownInterval = setInterval(() => {
    remaining -= 1;
    $('btn-undo-move').textContent = `Undo (${Math.max(remaining, 0)})`;
  }, 1000);
  const rank = cardRank(pendingMove.code);
  const suit = SUIT_SYMBOL[cardSuit(pendingMove.code)];
  $('undo-text').textContent = pendingMove.action === 'remove'
    ? `Removing with ${rank}${suit}…`
    : `Playing ${rank}${suit}…`;
  clearTimeout(pendingMoveTimeout);
  pendingMoveTimeout = setTimeout(commitPendingMove, UNDO_MS);
}

async function commitPendingMove() {
  if (!pendingMove) return;
  const { instanceId, index, action } = pendingMove;
  clearTimeout(pendingMoveTimeout);
  clearInterval(undoCountdownInterval);
  pendingMoveTimeout = null;
  pendingMove = null;
  await applyMove(instanceId, index, action);
  // Whether it succeeded (real snapshot will refresh shortly) or failed
  // (toasted in applyMove), make sure the undo bar/hidden card don't get
  // stuck showing a move that isn't actually pending anymore.
  if (room) renderGame();
}

function cancelPendingMove() {
  clearTimeout(pendingMoveTimeout);
  clearInterval(undoCountdownInterval);
  pendingMoveTimeout = null;
  pendingMove = null;
  if (room) renderGame();
}
$('btn-undo-move').addEventListener('click', cancelPendingMove);

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
      const code = instanceCode(instanceId);

      // Track per-player stats (wilds/removals/cards played) for the
      // end-of-game summary.
      const prevStats = (game.stats && game.stats[myPid]) || { wildsPlayed: 0, removalsPlayed: 0, cardsPlayed: 0 };
      const stats = {
        ...game.stats,
        [myPid]: {
          wildsPlayed: prevStats.wildsPlayed + (isTwoEyedJack(code) ? 1 : 0),
          removalsPlayed: prevStats.removalsPlayed + (isOneEyedJack(code) ? 1 : 0),
          cardsPlayed: prevStats.cardsPlayed + 1,
        },
      };

      // Did this move complete one or more new sequences for the mover's
      // team? findSequences already resolves overlap so this reflects
      // legitimately distinct lines, not just any run of 5.
      const countBefore = countSequencesByTeam(sequencesBefore, teamCount)[team];
      const countAfter = countSequencesByTeam(sequences, teamCount)[team];
      const completedLines = (game.completedLines || []).slice();
      let completedLine = null;
      for (let ord = countBefore + 1; ord <= countAfter; ord++) {
        completedLines.push({ team, playerId: myPid, playerName: data.players[myPid].name, ordinal: ord, ts: Date.now() });
        completedLine = ord;
      }

      const lastMove = {
        type: 'card',
        playerId: myPid,
        name: data.players[myPid].name,
        code,
        action: check.action,
        targetIndex,
        completedLine,
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
        'game.stats': stats,
        'game.completedLines': completedLines,
        ...(winnerTeam == null ? { 'game.turnStartedAt': serverTimestamp() } : { state: 'finished', 'game.finishedAt': serverTimestamp() }),
      });
    });
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

function ordinal(n) {
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return n + 'th';
}

function showShoutout(move) {
  const cardEl = $('shoutout-card');
  let duration = 2600;
  if (move.type === 'timeout') {
    cardEl.className = 'shoutout-card';
    cardEl.innerHTML = '<div class="s">&#9203;</div>';
    $('shoutout-text').textContent = `${move.name}'s time ran out!`;
  } else if (move.completedLine) {
    // A completed line is bigger news than the card that caused it, so it
    // replaces the regular "played a card" shoutout rather than queuing
    // behind it, and stays up a bit longer.
    cardEl.className = 'shoutout-card';
    cardEl.innerHTML = '<div class="s">&#127942;</div>';
    $('shoutout-text').textContent = `${move.name} completed their ${ordinal(move.completedLine)} line!`;
    duration = 3400;
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
  showShoutout._t = setTimeout(() => { el.classList.remove('show'); }, duration);
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

let lastVotesSignature = null;
function showWinOverlay(winnerTeam) {
  const overlay = $('win-overlay');
  const game = room.game;
  $('win-title').textContent = `🎉 Team ${TEAM_NAMES[winnerTeam]} wins!`;

  const durationEl = $('stats-duration');
  durationEl.textContent = (game.startedAt && game.finishedAt && game.startedAt.toMillis && game.finishedAt.toMillis)
    ? `Game length: ${formatDuration(game.finishedAt.toMillis() - game.startedAt.toMillis())}`
    : '';

  const order = room.order && room.order.length ? room.order : Object.keys(room.players);

  const linesEl = $('stats-lines');
  const lines = game.completedLines || [];
  linesEl.innerHTML = lines.length === 0
    ? '<p style="color:var(--text-dim);margin:0;">No completed lines recorded.</p>'
    : lines.map((line) => `
        <div class="stats-line-row">
          <span><span class="team-dot" style="background:${TEAM_COLOR[line.team]}"></span>${line.playerName}</span>
          <span>${ordinal(line.ordinal)} line</span>
        </div>`).join('');

  const playersEl = $('stats-players');
  playersEl.innerHTML = order.filter((pid) => room.players[pid]).map((pid) => {
    const p = room.players[pid];
    const s = (game.stats && game.stats[pid]) || { wildsPlayed: 0, removalsPlayed: 0, cardsPlayed: 0 };
    return `
      <div class="stats-player-row">
        <span><span class="team-dot" style="background:${TEAM_COLOR[p.team]}"></span>${p.name}</span>
        <span class="counts">${s.cardsPlayed} cards · ${s.wildsPlayed} wild · ${s.removalsPlayed} removal</span>
      </div>`;
  }).join('');

  const votes = game.playAgainVotes || {};
  const votedCount = order.filter((pid) => votes[pid]).length;
  const iVoted = !!votes[playerId];
  $('stats-votes').textContent = votedCount > 0 ? `${votedCount} of ${order.length} agreed to play again` : 'Everyone must agree to play again';
  $('btn-play-again').textContent = iVoted ? 'Waiting for others…' : 'Play Again';
  $('btn-play-again').disabled = iVoted;

  overlay.hidden = false;

  const signature = order.filter((pid) => votes[pid]).sort().join(',');
  if (signature !== lastVotesSignature) {
    lastVotesSignature = signature;
    maybeStartNextGame();
  }
}

// Any client may notice a vote change and check for consensus — the
// transaction's own "already moved on" guard makes redundant attempts
// (including everyone piling in at once) harmless no-ops.
async function maybeStartNextGame() {
  if (!roomRef) return;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.state !== 'finished') return;
      const votes = (data.game && data.game.playAgainVotes) || {};
      const order = data.order && data.order.length ? data.order : Object.keys(data.players);
      const allVoted = order.length > 0 && order.every((pid) => votes[pid]);
      if (!allVoted) return;
      const game = dealNewGame(order, data.settings.teamCount);
      tx.update(roomRef, { state: 'playing', paused: false, pausedBy: null, game });
    });
  } catch (e) { /* lost the race or votes incomplete — fine */ }
}

$('btn-play-again').addEventListener('click', async () => {
  if (!room || !roomRef) return;
  await updateDoc(roomRef, { [`game.playAgainVotes.${playerId}`]: true }).catch(() => toast('Could not register vote'));
});
$('btn-quit-game').addEventListener('click', () => { $('win-overlay').hidden = true; leaveRoom(); });

// ---------------- Boot ----------------
watchPublishedVersion();
checkForUpdate();
const savedRoom = localStorage.getItem('cr_room');
if (savedRoom) enterRoom(savedRoom);
