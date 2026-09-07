import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeFirestore, doc, getDoc, getDocFromServer, setDoc, updateDoc, onSnapshot,
  runTransaction, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import { firebaseConfig } from './firebase-config.js';
import { APP_VERSION } from './version.js';
import {
  cardRank, cardSuit, SUIT_SYMBOL, SUIT_COLOR, isJack, isTwoEyedJack, isOneEyedJack,
  instanceCode, buildShuffledDeck, handSizeForPlayerCount, sequencesNeededToWin,
} from './cards.js';
import {
  isDeadCard, validateMove, findSequences, lockedIndicesFrom, checkWinner, nextTurnIndex,
  ambientHighlightSet, autoResolveTargets, countSequencesByTeam,
} from './rules.js';
import { BoardView, TEAM_COLOR, setTeamColors } from './render.js';
import { sfx } from './audio.js';
import { chooseBotMove, makeBotName } from './bot.js';

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
const DEFAULT_TEAM_COLORS = ['#e0473c', '#3b7fe0', '#3fb56b'];
const DEFAULT_TURN_SECONDS = 30;
function currentTurnSeconds() {
  return (room && room.settings && room.settings.turnSeconds) || DEFAULT_TURN_SECONDS;
}
// The deck is a fixed 104 cards and every player gets a full 6- or 7-card hand
// regardless of team size (unlike real Sequence, hand size here doesn't shrink as
// the table grows) — past 12 players, dealing can run the deck dry mid-deal and
// leave the last players to join with an empty hand and no way to play at all.
const MAX_PLAYERS = 12;

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
let lastAnnouncedPid = undefined; // undefined = not initialized yet for this room
let lastCompletedLinesCount = undefined; // undefined = not initialized yet for this room
// Wall-clock timestamp (Date.now()-based) that the most recent move's own
// announcement/card-fly sequence will finish playing at — see scheduleBotTurnIfNeeded,
// which reads this to keep a bot from playing its own move on top of the previous
// move's animation still running.
let animationsBusyUntil = 0;
let highlightRevealTimeoutId = null; // reveals ambient highlight once animationsBusyUntil passes
let celebratedFinishKey = null;
let celebrating = false;
let timerState = { startedAtMillis: null, perfAtReceipt: 0, wallAtReceipt: 0, timedOutFired: false };
let timerIntervalId = null;
let deferredInstallPrompt = null;

// ---------------- Solo (bots) ----------------
// Solo runs entirely on-device — no Firestore at all, room is a plain local object,
// and roomRef stays null throughout. computeMoveResult()/computeSwapResult() below
// are the same pure functions the online path uses; solo just applies their result
// directly instead of sending it through a transaction.
let solo = false;
let soloDifficulty = 'medium';
let botTimeoutId = null;
/** Stands in for a Firestore Timestamp so the online timer code (which calls
 * .toMillis() on turnStartedAt/startedAt/finishedAt) works unchanged in solo. */
function localTimestamp(ms = Date.now()) {
  return { toMillis: () => ms };
}

// ---------------- Solo game persistence ----------------
// Solo never touches Firestore, so unlike an online room (resumed via its code —
// see 'cr_room' below) its entire state only ever lived in memory: a page refresh
// (including the "Refresh" the update banner itself asks for) silently threw the
// game away. Saved as plain JSON after every change, with the three
// localTimestamp() wrapper objects (turnStartedAt/startedAt/finishedAt — see above)
// swapped for a plain millis number on the way out and rebuilt on the way in, since
// their toMillis function can't survive JSON.stringify on its own.
const SOLO_STORAGE_KEY = 'cr_solo';
function soloJsonReplacer(key, value) {
  if (value && typeof value === 'object' && typeof value.toMillis === 'function') {
    return { __ts: value.toMillis() };
  }
  return value;
}
function soloJsonReviver(key, value) {
  if (value && typeof value === 'object' && typeof value.__ts === 'number') {
    return localTimestamp(value.__ts);
  }
  return value;
}
function saveSoloRoom() {
  if (!solo || !room) return;
  try {
    localStorage.setItem(SOLO_STORAGE_KEY, JSON.stringify({ room, soloDifficulty }, soloJsonReplacer));
  } catch (e) { /* storage full or unavailable — the game just won't survive a refresh */ }
}
function loadSoloRoom() {
  try {
    const raw = localStorage.getItem(SOLO_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw, soloJsonReviver);
  } catch (e) { return null; }
}
function clearSoloRoom() {
  localStorage.removeItem(SOLO_STORAGE_KEY);
}

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

// ---------------- Notification sounds (public/sounds/*.mp3, see audio.js) ----------------
function playTurnSound() { sfx.yourTurn(); }
function playMoveSound(lastMove) {
  if (lastMove.action === 'remove') sfx.removeCard();
  else if (isTwoEyedJack(lastMove.code)) sfx.wildCard();
  else sfx.cardLay();
}
function playSequenceSound() { sfx.sequence(); }
function playWinSound() { sfx.win(); }

// Every completed sequence stays outlined with its pill for the rest of the game
// (the cells are locked anyway, so this is just making that permanent, visually) —
// recomputed from the board itself on every render rather than tracked as an
// incremental diff, so it's correct immediately on load/rejoin too, not just for
// lines completed after this client started watching.
function syncCompletedLinePills(sequences) {
  if (!boardView) return;
  boardView.setPersistentSequences(sequences.map((s) => ({ cells: s.cells, color: TEAM_COLOR[s.team] })));
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
  'index.html', 'app.js', 'board.js', 'render.js', 'cards.js', 'rules.js', 'audio.js', 'bot.js',
  'firebase-config.js', 'version.js', 'styles.css', 'manifest.webmanifest',
  'sounds/turn-sound.mp3', 'sounds/card-lay-sound.mp3', 'sounds/wild-card-sound.mp3',
  'sounds/remove-card-sound.mp3', 'sounds/sequence-sound.mp3', 'sounds/win-sound.mp3',
  'images/jack-wild.png', 'images/jack-removal.png',
];
let refreshing = false;
async function fullRefresh() {
  // A slow tap-happy user (or the kebab item and the banner both being tappable)
  // could otherwise fire this twice concurrently — two overlapping cache-clears and
  // navigation attempts racing each other was a plausible way for a refresh to land
  // somewhere odd instead of the plain fresh reload it's supposed to be.
  if (refreshing) return;
  refreshing = true;
  const banner = $('update-banner');
  if (banner && !banner.hidden) banner.querySelector('span').textContent = 'Updating…';
  toast('Updating…');
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
  const url = new URL(location.href);
  url.searchParams.set('fresh', Date.now().toString(36));
  location.replace(url.toString());
  // An installed PWA can ignore replace() in some states, and a cold reload with
  // every cache just wiped can legitimately take a couple of seconds (re-fetching
  // the Firebase SDK from its CDN with nothing cached) — these fallbacks need to be
  // slow enough not to fire while that first navigation is still honestly in
  // progress, or a second, redundant reload can cut it off mid-load right as it was
  // about to succeed.
  setTimeout(() => { location.href = url.toString(); }, 1200);
  setTimeout(() => { location.reload(); }, 2600);
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
  if (solo || !roomCode) return; // no code to share, and the item is hidden anyway
  const url = location.origin + location.pathname;
  const text = `Join my Chain Reaction game — room code ${roomCode}`;
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
  if (!room) return;
  const next = !room.paused;
  if (solo) {
    room.paused = next;
    room.pausedBy = next ? playerId : null;
    // Resuming gives the current player a fresh 30s rather than trying to account
    // for time spent paused — simpler and matches the online behaviour.
    if (!next) { room.turnStartedAt = localTimestamp(); scheduleBotTurnIfNeeded(); }
    applyRoom();
    return;
  }
  if (!roomRef) return;
  const patch = { paused: next, pausedBy: next ? playerId : null };
  if (!next) patch.turnStartedAt = serverTimestamp();
  await updateDoc(roomRef, patch).catch(() => toast('Could not update pause state'));
});
$('btn-resume-game').addEventListener('click', async () => {
  if (!room) return;
  if (solo) {
    room.paused = false;
    room.pausedBy = null;
    room.turnStartedAt = localTimestamp();
    applyRoom();
    scheduleBotTurnIfNeeded();
    return;
  }
  if (!roomRef) return;
  await updateDoc(roomRef, { paused: false, pausedBy: null, turnStartedAt: serverTimestamp() }).catch(() => toast('Could not resume'));
});
$('kebab-restart').addEventListener('click', async () => {
  closeKebab();
  if (!room || room.hostId !== playerId) return;
  if (!confirm('Restart the game? Everyone gets a fresh deal.')) return;
  const teamCount = room.settings.teamCount;
  const order = room.order && room.order.length ? room.order : Object.keys(room.players);
  if (solo) {
    room.state = 'playing';
    room.paused = false;
    room.pausedBy = null;
    dealNewGameLocally(order, teamCount);
    applyRoom();
    scheduleBotTurnIfNeeded();
    return;
  }
  if (!roomRef) return;
  const patch = dealNewGamePatch(order, teamCount);
  await updateDoc(roomRef, { state: 'playing', paused: false, pausedBy: null, ...patch }).catch(() => toast('Could not restart game'));
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

let soloTeamCount = 2;
for (const btn of document.querySelectorAll('#solo-team-count-seg button')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#solo-team-count-seg button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    soloTeamCount = Number(btn.dataset.teams);
  });
}
for (const btn of document.querySelectorAll('#solo-difficulty-seg button')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#solo-difficulty-seg button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    soloDifficulty = btn.dataset.diff;
  });
}
$('btn-play-solo').addEventListener('click', () => {
  if (!requireName()) return;
  startSolo(soloTeamCount, soloDifficulty);
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
      settings: {
        teamCount: chosenTeamCount,
        teamColors: DEFAULT_TEAM_COLORS.slice(0, chosenTeamCount),
        turnSeconds: DEFAULT_TURN_SECONDS,
      },
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
      if (Object.keys(data.players).length >= MAX_PLAYERS) { toast(`Room is full (max ${MAX_PLAYERS} players)`); return; }
      const team = pickTeamForNewPlayer(data.players, data.settings.teamCount);
      await updateDoc(ref, {
        [`players.${playerId}`]: { name: playerName, team, joinedAt: Date.now() },
      });
    }
    enterRoom(code);
  } catch (e) {
    toast('Could not join room');
  } finally {
    $('btn-join').disabled = false;
  }
}

// ---------------- Clock sync ----------------
// Phone clocks disagree with the server, sometimes by minutes, and the turn timer is
// only meaningful measured against the server's clock — a phone running fast would
// otherwise see its own turn expire the instant it started. A fresh (non-cached)
// delivery of the room's turnStartedAt doubles as a clock sample: the gap between
// that server timestamp and this device's Date.now() at the moment it arrived is
// (approximately) this device's offset from the server.
//
// A sample taken from a turn that's already been running a while (joining mid-game,
// resyncing after a stall) is stale, but that staleness can only ever push the
// estimate in the SAFE direction: serverMs is always <= the true current server time,
// so serverMs - Date.now() always <= the true offset, and taking the max of recent
// samples can never overshoot it. A stale sample can make the countdown run more
// generous than 30s; it can never make it expire early. So every fresh delivery is
// usable — there's no "wait for a trustworthy one" case to special-case here, and
// trying to (a previous version of this code excluded first-time reads, hunting for
// a small imprecision) risked never sampling at all if a device's live stream stayed
// flaky, which hid the timer entirely rather than just showing it a bit too generous.
//
// Relying only on turnStartedAt for samples turned out to be too sparse in real play:
// it only changes when a move actually lands, and a phone that gets locked between
// turns resubscribes on unlock — if the next move doesn't land before the NEXT lock,
// that phone can go long stretches (in principle indefinitely) without ever taking a
// usable sample, which leaves clockOffset unmeasured and the timer hidden the whole
// game. HexColony solves this with a room-independent heartbeat ticking every few
// seconds specifically so a clock sample is always imminent regardless of game
// activity; this borrows the same idea, scaled down to one field on the room doc
// (chain-reaction has no need for HexColony's full liveness/reconnect ladder, just
// the frequent server-time reference).
const CLOCK_PING_MS = 8000;
let clockSamples = [];
let clockOffset = null;
let clockPingIntervalId = null;
function noteServerTime(serverMs) {
  // Every sample UNDER-estimates the offset by its own network latency, so the
  // largest recent sample is the one that travelled fastest and is closest to truth.
  clockSamples.push(serverMs - Date.now());
  if (clockSamples.length > 8) clockSamples.shift();
  clockOffset = Math.max(...clockSamples);
}
const serverNow = () => Date.now() + (clockOffset || 0);
function noteFreshRoom(data, fresh) {
  if (!fresh) return;
  const turnMs = data.turnStartedAt ? data.turnStartedAt.toMillis() : null;
  if (turnMs != null) noteServerTime(turnMs);
  const pingMs = data.clockPingAt ? data.clockPingAt.toMillis() : null;
  if (pingMs != null) noteServerTime(pingMs);
}

// Only the host pings, to avoid every phone in the room writing every few seconds —
// one fresh timestamp every ~8s is plenty for every OTHER client's onSnapshot listener
// to pick up too, since it's a real write to the room doc they're all already watching.
function startClockPing() {
  stopClockPing();
  clockPingIntervalId = setInterval(() => {
    if (!roomRef || !room || room.hostId !== playerId) return;
    updateDoc(roomRef, { clockPingAt: serverTimestamp() }).catch(() => {});
  }, CLOCK_PING_MS);
}
function stopClockPing() {
  if (clockPingIntervalId) { clearInterval(clockPingIntervalId); clockPingIntervalId = null; }
}

function enterRoom(code) {
  solo = false;
  clearTimeout(botTimeoutId);
  // A previous solo session trusts clockOffset=0 outright (nothing but this device
  // was ever involved); an online room needs to measure its own real offset from
  // scratch rather than carry that borrowed trust over.
  clockOffset = null;
  clockSamples = [];
  roomCode = code;
  $('game-room-code').textContent = code;
  roomRef = doc(db, 'rooms', code);
  lastSeenMoveTs = undefined;
  wasMyTurn = undefined;
  lastAnnouncedPid = undefined;
  lastCompletedLinesCount = undefined;
  animationsBusyUntil = 0;
  clearTimeout(highlightRevealTimeoutId);
  lastVotesSignature = null;
  celebratedFinishKey = null;
  celebrating = false;
  localStorage.setItem('cr_room', code);
  startClockPing();
  subscribeRoom();
  // The listener above can still be the one that stalls on a cold iOS connection. A direct
  // server read runs over a fresh request rather than the long-lived stream, so it lands
  // even while that stream is still negotiating — the first paint stops depending on it.
  // Right after a forced refresh (every cache wiped, service worker just re-registering)
  // is exactly when a single attempt is least likely to land — retried a few times with
  // backoff instead of silently giving up and leaving the player stuck on the home
  // screen with no error and no obvious way back in besides restarting the app.
  fetchRoomWithRetry(roomRef, 4);
}

async function fetchRoomWithRetry(ref, attemptsLeft, delayMs = 600) {
  try {
    const snap = await getDocFromServer(ref);
    if (snap.exists()) { room = snap.data(); noteFreshRoom(room, true); applyRoom(); return; }
  } catch (e) { /* retry below */ }
  if (attemptsLeft > 1 && ref === roomRef) {
    setTimeout(() => fetchRoomWithRetry(ref, attemptsLeft - 1, delayMs * 1.5), delayMs);
  }
}

function subscribeRoom() {
  if (unsubRoom) unsubRoom();
  unsubRoom = onSnapshot(roomRef, { includeMetadataChanges: true }, (snap) => {
    if (!snap.exists()) {
      if (snap.metadata.fromCache) return;
      confirmRoomGone(roomRef);
      return;
    }
    room = snap.data();
    noteFreshRoom(room, !snap.metadata.fromCache);
    applyRoom();
  }, () => {
    // The stream itself failed outright (not just slow) — re-subscribing is what
    // recovers from that rather than leaving the player on a dead listener with no
    // visible sign anything is wrong.
    if (roomRef) setTimeout(() => { if (roomRef) subscribeRoom(); }, 1500);
  });
}

// Nothing in this app ever deletes a room document — there's no host-kick, no expiry
// sweep, nothing. So a listener reporting a fresh (non-cached) "document doesn't
// exist" should be exceedingly rare, and getting it wrong is expensive: it evicts the
// player mid-game and clears their resume state, with no way back in short of the
// room code. A reconnecting long-polling stream (which this app forces, for iOS
// reliability — see initializeFirestore above) can plausibly surface a stale/empty
// response transiently on reconnect, which would look identical to this. Requiring
// an independent, direct server read to agree before actually treating the room as
// gone costs one extra round trip on the rare real case and prevents the listener's
// word alone from being able to kick anyone.
async function confirmRoomGone(ref) {
  try {
    const snap = await getDocFromServer(ref);
    if (snap.exists()) {
      // False alarm from the listener — the room is fine. Pick the real state back
      // up rather than just dropping it; the listener should also self-correct on
      // its own next delivery, but there's no reason to wait for that.
      if (roomRef === ref) { room = snap.data(); noteFreshRoom(room, true); applyRoom(); }
      return;
    }
  } catch (e) {
    return; // Couldn't confirm either way — never evict on an inconclusive check.
  }
  if (roomRef !== ref) return; // left or switched rooms while this was in flight
  toast('The room was closed');
  leaveRoom();
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
    if (snap.exists()) { room = snap.data(); noteFreshRoom(room, true); applyRoom(); }
  }).catch(() => {});
  // If this device is the host, don't make it wait up to CLOCK_PING_MS for the
  // interval to come back around — a phone that just unlocked is exactly the device
  // most likely to still have an unmeasured clock.
  if (room && room.hostId === playerId) updateDoc(roomRef, { clockPingAt: serverTimestamp() }).catch(() => {});
});

function leaveRoom() {
  if (unsubRoom) unsubRoom();
  unsubRoom = null;
  stopClockPing();
  clearTimeout(botTimeoutId);
  clearTimeout(highlightRevealTimeoutId);
  stopPlayAgainRetry();
  if (solo) clearSoloRoom();
  solo = false;
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
  if (solo) saveSoloRoom();
  setTeamColors((room.settings && room.settings.teamColors) || DEFAULT_TEAM_COLORS);
  updateGameKebabVisibility();
  // The next round already started (or this client left the finished game some other
  // way) — showWinOverlay(), which is what re-arms this timer, no longer runs, so it
  // has to be stopped explicitly here or it would just keep firing forever. The
  // overlay itself needs the same explicit hide: it isn't a .screen (showScreen()
  // below never touches it), and nothing else was hiding it on the online Play
  // Again path — solo's own play-again handler hid it directly, but voting into a
  // new round online left it sitting on screen with the new game underneath it.
  if (room.state !== 'finished') {
    stopPlayAgainRetry();
    $('win-overlay').hidden = true;
  }
  if (room.state === 'lobby') { renderLobby(); showScreen('screen-lobby'); }
  else if (room.state === 'playing' || room.state === 'finished') {
    showScreen('screen-game');
    ensureBoardView();
    boardView.resize();
    // A thrown error partway through renderGame() (a bad board index, a canvas call
    // that doesn't like a transient size) used to silently abort everything after it
    // in the same pass — including the turn timer update, which runs near the end.
    // That's a plausible way for "the timer never shows" to have nothing to do with
    // the timer at all. Surface it loudly instead of failing silently.
    try {
      renderGame();
    } catch (e) {
      console.error(e);
      toast('Render error: ' + (e && e.message ? e.message : e));
    }
    if (room.state === 'finished' && room.game && (room.game.winnerTeam != null || room.game.draw)) {
      // Keyed on room.finishedAt so this fires exactly once per finish (not once per
      // render — every snapshot delivery while finished, e.g. a clock ping, would
      // otherwise retrigger it) and so a second win later in the same room session
      // (after Play Again) isn't mistaken for one already celebrated. Same fix shape
      // as the earlier Play Again vote-signature bug — a bare state check without a
      // per-game key silently breaks on the second occurrence.
      const finishKey = room.finishedAt && room.finishedAt.toMillis ? room.finishedAt.toMillis() : null;
      if (finishKey != null && finishKey !== celebratedFinishKey && !celebrating) {
        celebratedFinishKey = finishKey;
        if (room.game.draw) {
          // Nothing to highlight or celebrate — straight to the stats screen.
          showWinOverlay(null);
        } else {
          celebrating = true;
          runWinCelebration(room.game, room.game.winnerTeam, () => {
            celebrating = false;
            showWinOverlay(room.game.winnerTeam);
          });
        }
      } else if (!celebrating && finishKey === celebratedFinishKey) {
        showWinOverlay(room.game.draw ? null : room.game.winnerTeam);
      }
      // else: celebration already in flight — the stats screen waits for it.
    }
  }
}

function updateGameKebabVisibility() {
  const inGame = room && (room.state === 'playing' || room.state === 'finished');
  $('kebab-share').hidden = solo; // solo has no room code to invite anyone to
  $('kebab-leave-game').hidden = !inGame;
  $('kebab-restart').hidden = !inGame || room.hostId !== playerId;
  $('kebab-pause').hidden = !inGame || room.state === 'finished';
  $('kebab-pause').innerHTML = room.paused
    ? '<span>&#9654;&#65039;</span>Resume Game'
    : '<span>&#9208;&#65039;</span>Pause Game';
}

// New players default onto whichever team currently has the fewest members, so a
// table fills in roughly evenly (Red, Blue, Red, Blue...) instead of everyone
// landing on team 0 until someone manually switches.
function pickTeamForNewPlayer(players, teamCount) {
  const counts = new Array(teamCount).fill(0);
  for (const p of Object.values(players)) {
    if (p.team < teamCount) counts[p.team]++;
  }
  let best = 0;
  for (let t = 1; t < teamCount; t++) if (counts[t] < counts[best]) best = t;
  return best;
}

function renderLobby() {
  $('lobby-code').textContent = roomCode;
  const teamCount = room.settings.teamCount;
  const myTeam = room.players[playerId] ? room.players[playerId].team : null;

  const wrap = $('lobby-teams');
  wrap.innerHTML = '';
  for (let t = 0; t < teamCount; t++) {
    const col = document.createElement('div');
    col.className = 'lobby-team';

    const header = document.createElement('div');
    header.className = 'lobby-team-header';
    const swatch = document.createElement('button');
    swatch.className = 'lobby-team-swatch';
    swatch.style.background = TEAM_COLOR[t];
    swatch.title = myTeam === t ? 'Tap to change this team\'s color' : `Join ${TEAM_NAMES[t]} to change its color`;
    swatch.addEventListener('click', () => {
      if (myTeam !== t) { toast(`Join ${TEAM_NAMES[t]} to change its color`); return; }
      openColorWheel(t);
    });
    const name = document.createElement('div');
    name.className = 'lobby-team-name';
    name.textContent = TEAM_NAMES[t];
    header.appendChild(swatch);
    header.appendChild(name);
    col.appendChild(header);

    const list = document.createElement('div');
    list.className = 'lobby-team-players';
    for (const [pid, p] of Object.entries(room.players)) {
      if (p.team !== t) continue;
      const row = document.createElement('div');
      row.className = 'lobby-player-chip';
      row.textContent = p.name + (pid === room.hostId ? ' (host)' : '') + (pid === playerId ? ' — you' : '');
      list.appendChild(row);
    }
    col.appendChild(list);

    if (myTeam !== t) {
      const joinBtn = document.createElement('button');
      joinBtn.className = 'btn secondary lobby-team-join';
      joinBtn.textContent = `Join ${TEAM_NAMES[t]}`;
      joinBtn.addEventListener('click', () => setMyTeam(t));
      col.appendChild(joinBtn);
    }

    wrap.appendChild(col);
  }

  const turnSeconds = room.settings.turnSeconds || DEFAULT_TURN_SECONDS;
  const isHost = room.hostId === playerId;
  for (const btn of $('lobby-timer-seg').querySelectorAll('button')) {
    btn.classList.toggle('active', Number(btn.dataset.secs) === turnSeconds);
    btn.disabled = !isHost;
  }

  $('btn-start-game').style.display = isHost ? '' : 'none';
}

async function setMyTeam(team) {
  if (!roomRef) return;
  await updateDoc(roomRef, { [`players.${playerId}.team`]: team }).catch(() => {});
}

$('lobby-timer-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-secs]');
  if (!btn || !room || room.hostId !== playerId) return;
  const secs = Number(btn.dataset.secs);
  updateDoc(roomRef, { 'settings.turnSeconds': secs }).catch(() => {});
});

// ---------------- Team color wheel ----------------
const WHEEL_SIZE = 220;
let colorWheelTeam = null;
let wheelDragging = false;
let wheelImageData = null;

function hueSatToHex(hue, sat) {
  const s = sat, l = 0.5;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) { r = c; g = x; b = 0; }
  else if (hue < 120) { r = x; g = c; b = 0; }
  else if (hue < 180) { r = 0; g = c; b = x; }
  else if (hue < 240) { r = 0; g = x; b = c; }
  else if (hue < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const to255 = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

function hexToHueSat(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { hue: h, sat: Math.min(1, s) };
}

function buildWheelImage() {
  const size = WHEEL_SIZE;
  const cvs = document.createElement('canvas');
  cvs.width = size; cvs.height = size;
  const cx = cvs.getContext('2d');
  const img = cx.createImageData(size, size);
  const radius = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - radius, dy = y - radius;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;
      if (dist > radius) { img.data[idx + 3] = 0; continue; }
      let hue = Math.atan2(dy, dx) * 180 / Math.PI;
      if (hue < 0) hue += 360;
      const hex = hueSatToHex(hue, Math.min(1, dist / radius));
      img.data[idx] = parseInt(hex.slice(1, 3), 16);
      img.data[idx + 1] = parseInt(hex.slice(3, 5), 16);
      img.data[idx + 2] = parseInt(hex.slice(5, 7), 16);
      img.data[idx + 3] = 255;
    }
  }
  return img;
}

function drawColorWheel(hex) {
  const canvas = $('color-wheel-canvas');
  const ctx = canvas.getContext('2d');
  if (!wheelImageData) wheelImageData = buildWheelImage();
  ctx.putImageData(wheelImageData, 0, 0);
  const { hue, sat } = hexToHueSat(hex);
  const radius = WHEEL_SIZE / 2;
  const rad = hue * Math.PI / 180;
  const dist = sat * radius;
  const px = radius + Math.cos(rad) * dist;
  const py = radius + Math.sin(rad) * dist;
  ctx.beginPath();
  ctx.arc(px, py, 9, 0, Math.PI * 2);
  ctx.fillStyle = hex;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

function colorAtCanvasPoint(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;
  const radius = WHEEL_SIZE / 2;
  const dx = x - radius, dy = y - radius;
  const dist = Math.min(Math.sqrt(dx * dx + dy * dy), radius);
  let hue = Math.atan2(dy, dx) * 180 / Math.PI;
  if (hue < 0) hue += 360;
  return hueSatToHex(hue, dist / radius);
}

function openColorWheel(team) {
  colorWheelTeam = team;
  $('color-wheel-title').textContent = `${TEAM_NAMES[team]} Color`;
  drawColorWheel(TEAM_COLOR[team]);
  showSheet('sheet-team-color');
}

function commitTeamColor(team, hex) {
  const base = (room.settings.teamColors && room.settings.teamColors.length === room.settings.teamCount)
    ? room.settings.teamColors
    : DEFAULT_TEAM_COLORS.slice(0, room.settings.teamCount);
  const colors = base.slice();
  colors[team] = hex;
  if (solo) {
    room.settings.teamColors = colors;
    setTeamColors(colors);
    applyRoom();
  } else if (roomRef) {
    updateDoc(roomRef, { 'settings.teamColors': colors }).catch(() => toast('Could not update color'));
  }
}

{
  const canvas = $('color-wheel-canvas');
  canvas.addEventListener('pointerdown', (e) => {
    if (colorWheelTeam == null) return;
    wheelDragging = true;
    canvas.setPointerCapture(e.pointerId);
    drawColorWheel(colorAtCanvasPoint(canvas, e.clientX, e.clientY));
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!wheelDragging || colorWheelTeam == null) return;
    drawColorWheel(colorAtCanvasPoint(canvas, e.clientX, e.clientY));
  });
  const endDrag = (e) => {
    if (!wheelDragging || colorWheelTeam == null) return;
    wheelDragging = false;
    commitTeamColor(colorWheelTeam, colorAtCanvasPoint(canvas, e.clientX, e.clientY));
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => { wheelDragging = false; });
}

// Turn order alternates across teams (Red, Blue, Red, Blue — not Red, Red, Blue,
// Blue), which is how Sequence is actually played: it's what makes a removal or a
// blocked line matter to the very next player instead of only to a teammate who
// already had their turn. Join order only breaks ties within a team.
function computeTurnOrder(pids, players) {
  const byTeam = new Map();
  const sortedByJoin = pids.slice().sort((a, b) => players[a].joinedAt - players[b].joinedAt);
  for (const pid of sortedByJoin) {
    const t = players[pid].team;
    if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t).push(pid);
  }
  const teams = [...byTeam.keys()].sort((a, b) => a - b);
  const order = [];
  for (let i = 0; order.length < pids.length; i++) {
    for (const t of teams) {
      const list = byTeam.get(t);
      if (i < list.length) order.push(list[i]);
    }
  }
  return order;
}

$('btn-start-game').addEventListener('click', async () => {
  if (!room || room.hostId !== playerId) return;
  const teamCount = room.settings.teamCount;
  const pids = Object.keys(room.players);
  if (pids.length < 2) { toast('Need at least 2 players'); return; }
  if (pids.length > MAX_PLAYERS) { toast(`Too many players (max ${MAX_PLAYERS})`); return; }
  const teamsUsed = new Set(pids.map((pid) => room.players[pid].team));
  for (let t = 0; t < teamCount; t++) {
    if (!teamsUsed.has(t)) { toast(`Team ${TEAM_NAMES[t]} has no players`); return; }
  }
  const order = computeTurnOrder(pids, room.players);
  const patch = dealNewGamePatch(order, teamCount);
  await updateDoc(roomRef, { state: 'playing', paused: false, pausedBy: null, order, ...patch }).catch(() => toast('Could not start game'));
});

function dealNewGame(order, teamCount) {
  const deck = buildShuffledDeck(Date.now());
  const handSize = handSizeForPlayerCount(order.length);
  const hands = {};
  for (const pid of order) {
    hands[pid] = deck.splice(0, handSize);
  }
  return {
    deck,
    hands,
    board: new Array(100).fill(null),
    currentPlayerId: order[0],
    turnIndex: 0,
    winnerTeam: null,
    lastMove: null,
    completedLines: [],
    stats: {},
    playAgainVotes: {},
  };
}

// turnStartedAt/startedAt/finishedAt live on the ROOM document, siblings of `game`,
// never nested inside it. They used to be nested, and moves/timeouts/pause-resume
// (which write turnStartedAt as its own dotted-path field, unrelated to the rest of
// `game`) always resolved fine — but real play kept turning up games where it read
// back missing, which only ever traces to dealNewGame()'s original shape: a
// serverTimestamp() sentinel buried inside a large plain object that itself becomes
// the single value of one field (`game`) in a non-transactional updateDoc(). Top-level
// fields are the one pattern already proven solid everywhere else in this file, so
// this moves the deal-time timestamps there too rather than keep debugging the nested
// case in place.
function dealNewGamePatch(order, teamCount) {
  return {
    turnStartedAt: serverTimestamp(),
    startedAt: serverTimestamp(),
    finishedAt: null,
    game: dealNewGame(order, teamCount),
  };
}

// A local counterpart to dealNewGamePatch(), applied straight to the local room
// object instead of returned as a Firestore patch — solo has no serverTimestamp().
function dealNewGameLocally(order, teamCount) {
  room.turnStartedAt = localTimestamp();
  room.startedAt = localTimestamp();
  room.finishedAt = null;
  room.game = dealNewGame(order, teamCount);
}

// Shared setup for both starting a fresh solo game and resuming a saved one — every
// tracking var that's keyed "per room session" needs to start clean either way, or
// state left over from whatever was on screen before (an online room, another solo
// game) reads as stale/mismatched against the newly-loaded room.
function enterSoloSession() {
  solo = true;
  roomCode = null;
  roomRef = null;
  if (unsubRoom) { unsubRoom(); unsubRoom = null; }
  stopClockPing();
  lastSeenMoveTs = undefined;
  wasMyTurn = undefined;
  lastAnnouncedPid = undefined;
  lastCompletedLinesCount = undefined;
  animationsBusyUntil = 0;
  clearTimeout(highlightRevealTimeoutId);
  celebratedFinishKey = null;
  celebrating = false;
  clockOffset = 0; // nothing but this device involved — no clock skew to correct for
  localStorage.removeItem('cr_room'); // solo has no code to resume by
}

function startSolo(teamCount, difficulty) {
  enterSoloSession();
  soloDifficulty = difficulty;

  const usedNames = [playerName];
  const players = { [playerId]: { name: playerName, team: 0, joinedAt: 0 } };
  const order = [playerId];
  for (let t = 1; t < teamCount; t++) {
    const botId = `bot-${t}`;
    const name = makeBotName(usedNames);
    usedNames.push(name);
    players[botId] = { name, team: t, joinedAt: t, isBot: true };
    order.push(botId);
  }

  room = {
    hostId: playerId,
    state: 'playing',
    paused: false,
    pausedBy: null,
    settings: { teamCount },
    players,
    order,
    game: null,
  };
  dealNewGameLocally(order, teamCount);
  applyRoom();
  scheduleBotTurnIfNeeded();
}

function resumeSolo(saved) {
  enterSoloSession();
  soloDifficulty = saved.soloDifficulty || 'medium';
  room = saved.room;
  applyRoom();
  scheduleBotTurnIfNeeded();
}

// If it's now a bot's turn, has it "think" for a beat and then play — the delay is
// purely cosmetic (an instant bot move reads as broken, not fast), never affects what
// it plays. Re-derives the current player fresh each call rather than trusting a
// closed-over id, since a human move, a timeout, or another bot's move can all change
// whose turn it is before this timer fires.
function scheduleBotTurnIfNeeded() {
  clearTimeout(botTimeoutId);
  if (!solo || !room || room.state !== 'playing' || room.paused) return;
  const curPlayer = room.players[room.game.currentPlayerId];
  if (!curPlayer || !curPlayer.isBot) return;
  // At least a 2s "thinking" pause, but never less than however long the previous
  // move's own shoutout/card-fly animation still has left to run — otherwise a bot
  // could play its own move while the human's animation (or a slow wild/removal
  // sequence) is still visibly playing out on top of it.
  const delay = Math.max(2000, animationsBusyUntil - Date.now());
  // Captured now and re-checked when the timer actually fires (see runBotTurn) —
  // this exact turn is what this timer is for, identified by both who's on the
  // move and when their turn started. If anything else has already handled this
  // turn by the time the delay elapses (however that happened), turnStartedAt will
  // have moved on and the stale firing bails instead of applying a second move on
  // top of one the board has already moved past.
  const expectedPid = room.game.currentPlayerId;
  const expectedStartedAt = room.turnStartedAt ? room.turnStartedAt.toMillis() : null;
  botTimeoutId = setTimeout(() => runBotTurn(expectedPid, expectedStartedAt), delay);
}

function runBotTurn(expectedPid, expectedStartedAt) {
  if (!solo || !room || room.state !== 'playing' || room.paused) return;
  const botPid = room.game.currentPlayerId;
  if (botPid !== expectedPid) return;
  const startedAt = room.turnStartedAt ? room.turnStartedAt.toMillis() : null;
  if (startedAt !== expectedStartedAt) return;
  const botPlayer = room.players[botPid];
  if (!botPlayer || !botPlayer.isBot) return;

  const game = room.game;
  const teamCount = room.settings.teamCount;
  const hand = game.hands[botPid] || [];
  const sequences = computeSequences(game.board, teamCount);
  const locked = lockedIndicesFrom(sequences);
  const move = chooseBotMove(game.board, hand, teamCount, botPlayer.team, locked, soloDifficulty);
  if (!move) return; // shouldn't happen — a full board with cards left in hand
  if (move.pass) {
    const result = computePassResult(room, botPid);
    if (result.ok) applyPassResultLocally(result);
    return;
  }
  if (move.swap) {
    const result = computeSwapResult(room, botPid, move.swap);
    if (result.ok) applySwapResultLocally(result);
    return;
  }
  const result = computeMoveResult(room, botPid, move.instanceId, move.targetIndex);
  if (result.ok) applyMoveResultLocally(result);
}

// ---------------- Game screen ----------------
function ensureBoardView() {
  if (boardView) return;
  boardView = new BoardView($('board-canvas'), { onPick: onBoardPick });
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
function renderPlayersStrip(sequences, teamCount, currentPlayerId) {
  const strip = $('players-strip');
  strip.innerHTML = '';
  const counts = countSequencesByTeam(sequences, teamCount);
  const needed = sequencesNeededToWin(teamCount);
  const order = (room.order && room.order.length ? room.order : Object.keys(room.players));
  for (const pid of order) {
    const p = room.players[pid];
    if (!p) continue;
    const chip = document.createElement('div');
    chip.className = 'player-chip' + (pid === currentPlayerId && !room.paused ? ' up' : '');
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

// findSequences() scans the whole board and is called from several places
// within a single render pass (and again on the next tap) against the same
// game.board reference — it only actually needs recomputing once a new
// snapshot replaces that reference. A single-slot cache keyed on identity
// covers that without threading the result through every call site.
let sequencesCache = { board: null, teamCount: null, result: null };
function computeSequences(board, teamCount) {
  if (sequencesCache.board !== board || sequencesCache.teamCount !== teamCount) {
    sequencesCache = { board, teamCount, result: findSequences(board, teamCount) };
  }
  return sequencesCache.result;
}

function renderGame() {
  const game = room.game;
  if (!game) return;
  const teamCount = room.settings.teamCount;
  const sequences = computeSequences(game.board, teamCount);
  const locked = lockedIndicesFrom(sequences);
  syncCompletedLinePills(sequences);

  // Update the timer before anything canvas- or DOM-heavy runs below, so a render
  // error further down (a bad board index, a transient canvas sizing issue) can never
  // take the timer down with it.
  updateTurnTimer(game);

  // While a move is staged (pending the undo window), preview it locally —
  // nothing is written to Firestore yet, so this is purely a display overlay.
  let displayBoard = game.board;
  if (pendingMove) {
    displayBoard = game.board.slice();
    displayBoard[pendingMove.index] = pendingMove.action === 'place' ? myTeam() : null;
  }

  const curPid = game.currentPlayerId;
  const curPlayer = room.players[curPid];
  const turnBanner = $('turn-banner');
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

  // How long the current move's own card-fly animation will still be running for —
  // computed below (before it's used just after, for both the highlight suppression
  // and the turn announcement) so a turn change landing on the very same move (the
  // usual case: one move both finishes a card AND hands the turn to the next
  // player) can hold off showing its "X's turn!" pill, and hold off highlighting
  // that next player's own playable spots, until the card animation is actually
  // done — instead of either popping up on top of it (z-index aside, showing a
  // large centered overlay over a still-playing one never reads as one wanting the
  // other to move out of the way) or telling them where to tap while the board is
  // still visibly mid-move.
  let cardFlyStillRunningMs = 0;

  if (game.lastMove && game.lastMove.ts !== lastSeenMoveTs) {
    const isFirstLoad = lastSeenMoveTs === undefined;
    lastSeenMoveTs = game.lastMove.ts;
    if (!isFirstLoad) {
      const move = game.lastMove;
      // An ordinary card play (not a wild, not a removal, didn't complete a line)
      // gets no shoutout at all — just the card-fly. Everything else worth calling
      // out (a timeout, a completed line, a wild, a removal) shows its pill first
      // and fully disappears before anything else about that move happens, rather
      // than starting the sound/flash/fly-animation at the same instant the pill
      // appears.
      const showsShoutout = move.type !== 'card' || move.completedLine
        || isTwoEyedJack(move.code) || isOneEyedJack(move.code);
      if (showsShoutout) showShoutout(move);
      const preAnnounceMs = showsShoutout ? MOVE_ANNOUNCE_MS : 0;
      scheduleMoveEffects(() => {
        if (move.type === 'card') {
          playMoveSound(move);
          boardView.flashCell(move.targetIndex);
          showCardFly(move);
        }
      }, preAnnounceMs);
      const totalMs = preAnnounceMs + (move.type === 'card' ? CARD_FLY_TOTAL_MS : 0);
      if (move.type === 'card') cardFlyStillRunningMs = totalMs;
      animationsBusyUntil = Date.now() + totalMs;
    }
  }

  // Highlighting a player's playable spots is held back until any animation from
  // the move that just handed them the turn is fully done (see animationsBusyUntil
  // above) — nothing else will trigger a fresh render at the exact moment that
  // finishes, so a follow-up renderGame() is scheduled for then, purely to reveal
  // the highlight; it's a harmless no-op for everything else in here since
  // lastSeenMoveTs/lastAnnouncedPid are already up to date by that point.
  const animationsStillBusy = Date.now() < animationsBusyUntil;
  let displayHighlight = new Set();
  if (isMyTurn() && !pendingMove && !animationsStillBusy) {
    const hand = game.hands[playerId] || [];
    displayHighlight = ambientHighlightSet(game.board, hand, locked);
  }
  clearTimeout(highlightRevealTimeoutId);
  if (isMyTurn() && !pendingMove && animationsStillBusy) {
    highlightRevealTimeoutId = setTimeout(renderGame, animationsBusyUntil - Date.now() + 20);
  }
  boardView.setState({ board: displayBoard, highlight: displayHighlight, locked, myTeam: myTeam() });
  renderPlayersStrip(sequences, teamCount, game.currentPlayerId);
  $('hand-tray').classList.toggle('my-turn', isMyTurn());

  // A big, unmissable "it's X's turn" announcement for everyone at the table,
  // whenever the active player actually changes (not on every render, and not on
  // the first load of a game already in progress).
  if (curPlayer && curPid !== lastAnnouncedPid) {
    const isFirstLoad = lastAnnouncedPid === undefined;
    lastAnnouncedPid = curPid;
    if (!isFirstLoad && !room.paused) {
      const text = isMyTurn() ? 'Your turn!' : `${curPlayer.name}'s turn!`;
      clearTimeout(showTurnAnnounce._delayT);
      showTurnAnnounce._delayT = setTimeout(() => showTurnAnnounce(text), cardFlyStillRunningMs);
    }
  }

  if (isMyTurn() !== wasMyTurn) {
    if (isMyTurn() && wasMyTurn !== undefined) playTurnSound();
    wasMyTurn = isMyTurn();
  }

  const completedLinesCount = (game.completedLines || []).length;
  if (completedLinesCount !== lastCompletedLinesCount) {
    const isFirstLoad = lastCompletedLinesCount === undefined;
    if (!isFirstLoad && completedLinesCount > lastCompletedLinesCount) playSequenceSound();
    lastCompletedLinesCount = completedLinesCount;
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
  const sequences = computeSequences(game.board, teamCount);
  const locked = lockedIndicesFrom(sequences);

  for (const instanceId of hand) {
    const code = instanceCode(instanceId);
    const card = document.createElement('div');
    card.className = 'hand-card';
    if (SUIT_COLOR[cardSuit(code)] === 'red') card.classList.add('red');
    if (isMyTurn() && isDeadCard(game.board, instanceId, locked, myTeam())) card.classList.add('dead');
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
      // Rank/suit font sizes are driven off the card's actual on-screen width
      // (not the CSS clamp()'s vw guess) so the doubled-size digits/symbols
      // always stay inside the card instead of spilling into neighboring cards.
      const r = el.querySelector('.r');
      const s = el.querySelector('.s');
      if (r) r.style.fontSize = Math.round(width * 0.62) + 'px';
      if (s) s.style.fontSize = Math.round(width * 0.7) + 'px';
    }
  }

  const hint = $('hand-hint');
  const deadBtn = $('btn-dead-card');
  const passBtn = $('btn-pass-turn');
  $('hand-footer').hidden = !!pendingMove;
  $('undo-bar').hidden = !pendingMove;
  if (isMyTurn()) {
    if (fullHand.length === 0) {
      // The deck ran completely dry and this hand was never topped back up — nothing
      // to play, nothing to swap. See computePassResult()/passTurn().
      hint.textContent = 'No cards left — pass your turn';
      deadBtn.hidden = true;
      passBtn.hidden = false;
    } else {
      const map = autoResolveTargets(game.board, fullHand, locked, myTeam());
      hint.textContent = map.size > 0
        ? 'Tap a highlighted space to play a card'
        : 'No plays available — swap a dead card';
      deadBtn.hidden = map.size > 0;
      passBtn.hidden = true;
    }
  } else {
    hint.textContent = 'Waiting for your turn…';
    deadBtn.hidden = true;
    passBtn.hidden = true;
  }
}

function onBoardPick(index) {
  const game = room.game;
  if (!game) return;
  if (isMyTurn() && !pendingMove) {
    const teamCount = room.settings.teamCount;
    const sequences = computeSequences(game.board, teamCount);
    const locked = lockedIndicesFrom(sequences);
    const hand = game.hands[playerId] || [];
    const map = autoResolveTargets(game.board, hand, locked, myTeam());
    const entry = map.get(index);
    if (entry) {
      if (UNDO_ENABLED) startPendingMove(entry, index);
      else applyMove(entry.instanceId, index, entry.action);
      return;
    }
  }
  // Not a move this tap can make right now (not your turn, no matching card, or the
  // cell just isn't a legal target) — nothing else happens on a plain tap. Peeking at
  // a covered card is a press-and-drag gesture handled entirely inside BoardView
  // (see peekDrag in render.js): dragging the chip aside reveals the card underneath
  // for as long as it's held, and it's purely local/visual, so it works for any
  // player on any turn with no risk of racing a real move.
}

$('btn-dead-card').addEventListener('click', () => {
  if (!isMyTurn() || pendingMove) return;
  const game = room.game;
  const teamCount = room.settings.teamCount;
  const sequences = computeSequences(game.board, teamCount);
  const locked = lockedIndicesFrom(sequences);
  const hand = game.hands[playerId] || [];
  const deadCard = hand.find((id) => isDeadCard(game.board, id, locked, myTeam()));
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

// Pure: works out what playing instanceId at targetIndex means for the current
// state, for whichever player is named — used identically by the online transaction
// and the solo local path below, so the actual rules only live in one place. `data`
// is anything shaped like a room ({ game, settings, players, order, paused, state });
// online passes the transaction's fresh read, solo passes the local room object
// directly. Returns { ok:false, reason } or { ok:true, ...everything that changed }.
function computeMoveResult(data, myPid, instanceId, targetIndex) {
  const game = data.game;
  const teamCount = data.settings.teamCount;
  if (!game || data.paused || game.currentPlayerId !== myPid || data.state !== 'playing') return { ok: false, reason: 'not-your-turn' };
  const hand = game.hands[myPid] || [];
  if (!hand.includes(instanceId)) return { ok: false, reason: 'card-not-in-hand' };
  const sequencesBefore = findSequences(game.board, teamCount);
  const locked = lockedIndicesFrom(sequencesBefore);
  const team = data.players[myPid].team;
  const check = validateMove(game.board, instanceId, targetIndex, locked, team);
  if (!check.ok) return { ok: false, reason: check.reason };

  const board = game.board.slice();
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
  // legitimately distinct lines, not just any run of 5. Matched by cell
  // set (not just count) so the actual new sequence(s) can be highlighted
  // on the board the moment they're completed, not just at game end.
  const beforeKeys = new Set(
    sequencesBefore.filter((s) => s.team === team).map((s) => s.cells.slice().sort((a, b) => a - b).join(',')),
  );
  const newSequences = sequences.filter((s) => s.team === team && !beforeKeys.has(s.cells.slice().sort((a, b) => a - b).join(',')));
  const countBefore = countSequencesByTeam(sequencesBefore, teamCount)[team];
  const completedLines = (game.completedLines || []).slice();
  let completedLine = null;
  newSequences.forEach((seq, i) => {
    const ord = countBefore + 1 + i;
    completedLines.push({ team, playerId: myPid, playerName: data.players[myPid].name, ordinal: ord, cells: seq.cells, ts: Date.now() });
    completedLine = ord;
  });

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

  return { ok: true, board, hands, deck, turnIndex, currentPlayerId, winnerTeam, stats, completedLines, lastMove };
}

async function applyMove(instanceId, targetIndex, action) {
  const myPid = playerId;
  if (solo) {
    const result = computeMoveResult(room, myPid, instanceId, targetIndex);
    if (!result.ok) { toast('Move rejected'); return; }
    applyMoveResultLocally(result);
    return;
  }
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) throw new Error('room-gone');
      const data = snap.data();
      const result = computeMoveResult(data, myPid, instanceId, targetIndex);
      if (!result.ok) throw new Error(result.reason);
      tx.update(roomRef, {
        'game.board': result.board,
        'game.hands': result.hands,
        'game.deck': result.deck,
        'game.turnIndex': result.winnerTeam == null ? result.turnIndex : data.game.turnIndex,
        'game.currentPlayerId': result.currentPlayerId,
        'game.winnerTeam': result.winnerTeam,
        'game.lastMove': result.lastMove,
        'game.stats': result.stats,
        'game.completedLines': result.completedLines,
        ...(result.winnerTeam == null ? { turnStartedAt: serverTimestamp() } : { state: 'finished', finishedAt: serverTimestamp() }),
      });
    });
  } catch (e) {
    toast('Move rejected — board may have changed');
  }
}

// Solo's counterpart to the tx.update() calls above — same fields, applied directly
// to the local room object instead of sent to Firestore. Always re-renders and then
// checks whether the turn just landed on a bot, so bot-to-bot chains (3-team solo:
// you -> bot -> bot -> you) keep themselves going without any further prompting.
function applyMoveResultLocally(result) {
  const game = room.game;
  game.board = result.board;
  game.hands = result.hands;
  game.deck = result.deck;
  if (result.winnerTeam == null) game.turnIndex = result.turnIndex;
  game.currentPlayerId = result.currentPlayerId;
  game.winnerTeam = result.winnerTeam;
  game.lastMove = result.lastMove;
  game.stats = result.stats;
  game.completedLines = result.completedLines;
  if (result.winnerTeam == null) {
    room.turnStartedAt = localTimestamp();
  } else {
    room.state = 'finished';
    room.finishedAt = localTimestamp();
  }
  applyRoom();
  scheduleBotTurnIfNeeded();
}

// Pure counterpart to computeMoveResult for the "no plays — swap a dead card" path.
function computeSwapResult(data, myPid, instanceId) {
  const game = data.game;
  const teamCount = data.settings.teamCount;
  if (!game || data.paused || game.currentPlayerId !== myPid || data.state !== 'playing') return { ok: false };
  const hand = game.hands[myPid] || [];
  if (!hand.includes(instanceId)) return { ok: false };
  const sequences = findSequences(game.board, teamCount);
  const locked = lockedIndicesFrom(sequences);
  if (!isDeadCard(game.board, instanceId, locked, data.players[myPid].team)) return { ok: false };

  const newHand = hand.filter((c) => c !== instanceId);
  const deck = game.deck.slice();
  if (deck.length > 0) newHand.push(deck.shift());
  const hands = { ...game.hands, [myPid]: newHand };
  const order = data.order;
  const turnIndex = nextTurnIndex(game.turnIndex, order.length);
  return { ok: true, hands, deck, turnIndex, currentPlayerId: order[turnIndex] };
}

async function applyDeadCardSwap(instanceId) {
  const myPid = playerId;
  if (solo) {
    const result = computeSwapResult(room, myPid, instanceId);
    if (!result.ok) { toast('Could not swap card'); return; }
    applySwapResultLocally(result);
    return;
  }
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) throw new Error('room-gone');
      const data = snap.data();
      const result = computeSwapResult(data, myPid, instanceId);
      if (!result.ok) throw new Error('cannot-swap');
      tx.update(roomRef, {
        'game.hands': result.hands,
        'game.deck': result.deck,
        'game.turnIndex': result.turnIndex,
        'game.currentPlayerId': result.currentPlayerId,
        turnStartedAt: serverTimestamp(),
      });
    });
  } catch (e) {
    toast('Could not swap card');
  }
}

function applySwapResultLocally(result) {
  const game = room.game;
  game.hands = result.hands;
  game.deck = result.deck;
  game.turnIndex = result.turnIndex;
  game.currentPlayerId = result.currentPlayerId;
  room.turnStartedAt = localTimestamp();
  applyRoom();
  scheduleBotTurnIfNeeded();
}

// Passing is only legal with a genuinely empty hand — the deck ran out and this
// player was never topped back up. Found via bot-vs-bot simulation, not a
// hypothetical: without this, whoever's hand runs out first has no swap target
// (isDeadCard has nothing to check) and no legal move either, so the turn — and the
// whole game, since nothing else advances it — was stuck for good. Same soft-lock
// existed for a human in the online game; this closes it for both.
//
// The simulation also turned up the case one level worse: the deck can run out with
// EVERY hand empty and no one holding a winning line — at that point nothing can ever
// happen again, and without the draw check below the game would cycle passes forever.
// For a table of humans that reads as "everyone gave up"; for a table of bots it's a
// genuine infinite loop, since nothing paces them the way a person deciding to quit
// would. Declared the instant it's true rather than waiting to see it repeat.
function computePassResult(data, myPid) {
  const game = data.game;
  if (!game || data.paused || game.currentPlayerId !== myPid || data.state !== 'playing') return { ok: false };
  const hand = game.hands[myPid] || [];
  if (hand.length > 0) return { ok: false };
  const order = data.order;
  const stalemate = game.deck.length === 0 && order.every((pid) => (game.hands[pid] || []).length === 0);
  if (stalemate) return { ok: true, draw: true };
  const turnIndex = nextTurnIndex(game.turnIndex, order.length);
  return { ok: true, turnIndex, currentPlayerId: order[turnIndex] };
}

async function passTurn() {
  const myPid = playerId;
  if (solo) {
    const result = computePassResult(room, myPid);
    if (!result.ok) return;
    applyPassResultLocally(result);
    return;
  }
  if (!roomRef) return;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) throw new Error('room-gone');
      const data = snap.data();
      const result = computePassResult(data, myPid);
      if (!result.ok) throw new Error('cannot-pass');
      tx.update(roomRef, result.draw
        ? { state: 'finished', finishedAt: serverTimestamp(), 'game.draw': true }
        : {
            'game.turnIndex': result.turnIndex,
            'game.currentPlayerId': result.currentPlayerId,
            turnStartedAt: serverTimestamp(),
          });
    });
  } catch (e) {
    toast('Could not pass turn');
  }
}

function applyPassResultLocally(result) {
  const game = room.game;
  if (result.draw) {
    room.state = 'finished';
    room.finishedAt = localTimestamp();
    game.draw = true;
    applyRoom();
    return;
  }
  game.turnIndex = result.turnIndex;
  game.currentPlayerId = result.currentPlayerId;
  room.turnStartedAt = localTimestamp();
  applyRoom();
  scheduleBotTurnIfNeeded();
}
$('btn-pass-turn').addEventListener('click', () => {
  if (!isMyTurn() || pendingMove) return;
  passTurn();
});

// A server-timestamped turnStartedAt (not any device's local clock) is the
// source of truth for the 30s turn timer — this is the same clock-skew
// lesson from the other apps: iPhones (and everything else) can't be
// trusted to agree with each other, only the server's clock is shared.
// Every connected client independently notices when time is up and tries
// this transaction; the guard on turnStartedAt makes it a safe no-op for
// every attempt after the first one that actually lands.
//
// Solo has no other clients to race against, so it just applies the timeout
// directly once its own single timer fires — same guard on turnStartedAt in case
// something else (a bot move) already moved the turn on in the meantime.
async function attemptTurnTimeout(expectedStartedAtMillis) {
  if (solo) {
    if (!room || !room.turnStartedAt || room.turnStartedAt.toMillis() !== expectedStartedAtMillis) return;
    if (room.paused || room.state !== 'playing') return;
    const game = room.game;
    const order = room.order;
    const timedOutPid = game.currentPlayerId;
    const timedOutPlayer = room.players[timedOutPid];
    const turnIndex = nextTurnIndex(game.turnIndex, order.length);
    game.turnIndex = turnIndex;
    game.currentPlayerId = order[turnIndex];
    game.lastMove = { type: 'timeout', playerId: timedOutPid, name: timedOutPlayer ? timedOutPlayer.name : 'A player', ts: Date.now() };
    room.turnStartedAt = localTimestamp();
    applyRoom();
    scheduleBotTurnIfNeeded();
    return;
  }
  if (!roomRef) return;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) return;
      const data = snap.data();
      const game = data.game;
      if (!game || data.paused || data.state !== 'playing') return;
      const startedAt = data.turnStartedAt;
      if (!startedAt || startedAt.toMillis() !== expectedStartedAtMillis) return;
      const order = data.order;
      const timedOutPid = game.currentPlayerId;
      const timedOutPlayer = data.players[timedOutPid];
      const turnIndex = nextTurnIndex(game.turnIndex, order.length);
      tx.update(roomRef, {
        'game.turnIndex': turnIndex,
        'game.currentPlayerId': order[turnIndex],
        turnStartedAt: serverTimestamp(),
        'game.lastMove': { type: 'timeout', playerId: timedOutPid, name: timedOutPlayer ? timedOutPlayer.name : 'A player', ts: Date.now() },
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
  if (!game || room.state !== 'playing' || room.paused) {
    stopTurnTimer();
    return;
  }
  // This specific condition shouldn't be reachable once a game is underway — every
  // move, timeout, and pause/resume sets it via a plain serverTimestamp() write. If
  // it's showing up in real play, that's the actual bug, not the clock math below —
  // surface it visibly instead of just hiding the timer, since a silent hide here is
  // indistinguishable from every other reason the timer might not show.
  if (!room.turnStartedAt) {
    if (timerIntervalId) { clearInterval(timerIntervalId); timerIntervalId = null; }
    const el = $('turn-timer');
    el.hidden = false;
    el.textContent = '⏱ no-start';
    el.classList.remove('low');
    return;
  }
  // clockOffset starts null until the first sample lands (normally within a couple
  // of seconds of joining, via the clock-ping heartbeat). Rendering a countdown
  // before that would anchor it to a completely uncorrected device clock for the
  // rest of the turn — so show the element with a "still working it out" placeholder
  // instead of a wrong number, the same way HexColony's timer does.
  if (clockOffset === null) {
    if (timerIntervalId) { clearInterval(timerIntervalId); timerIntervalId = null; }
    const el = $('turn-timer');
    el.hidden = false;
    el.textContent = '⏱ ⋯';
    el.classList.remove('low');
    return;
  }
  const startedAtMillis = room.turnStartedAt.toMillis();
  if (timerState.startedAtMillis !== startedAtMillis) {
    timerState = { startedAtMillis, perfAtReceipt: performance.now(), wallAtReceipt: serverNow(), timedOutFired: false };
  }
  $('turn-timer').hidden = false;
  if (!timerIntervalId) timerIntervalId = setInterval(tickTurnTimer, 250);
  tickTurnTimer();
}

function tickTurnTimer() {
  const { startedAtMillis, wallAtReceipt, perfAtReceipt } = timerState;
  if (startedAtMillis == null) return;
  // Elapsed time = (gap between server turn-start and when we anchored it, per our
  // clock-corrected estimate of the server's clock) + (monotonic time since
  // anchoring). The one-time wall-clock read only sets the starting offset;
  // performance.now() never jumps, so a skewed or drifting device clock can't
  // desync the countdown mid-turn — only the very first reading depends on it,
  // and serverNow() is what keeps that reading honest.
  const elapsed = (wallAtReceipt - startedAtMillis) + (performance.now() - perfAtReceipt);
  const remainingMs = currentTurnSeconds() * 1000 - elapsed;
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

// Every shoutout — a card played, a timeout, a completed line — goes through the
// same white-pill announcement as a wild/removal call-out (see showMoveAnnounce),
// so the game only ever has one "announcement" look rather than this plus a
// separate small dark banner.
function showShoutout(move) {
  const mover = room.players[move.playerId];
  const color = TEAM_COLOR[mover ? mover.team : 0];
  // A completed line is bigger news than which card caused it, so it takes over the
  // announcement even on an otherwise wild/removal card rather than showing both.
  const text = move.type === 'timeout'
    ? `${move.name}'s time ran out!`
    : move.completedLine
    ? `${move.name} completed their ${ordinal(move.completedLine)} line!`
    : isTwoEyedJack(move.code)
    ? `${move.name} plays Wild`
    : isOneEyedJack(move.code)
    ? `${move.name} plays Removal`
    : `${move.name} plays ${cardRank(move.code)}${SUIT_SYMBOL[cardSuit(move.code)]}`;
  showMoveAnnounce(text, color);
}

function showTurnAnnounce(text) {
  const el = $('turn-announce');
  el.innerHTML = `<div class="turn-announce-text">${text}</div>`;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth; // restart the transition if one is already showing
  el.classList.add('show');
  clearTimeout(showTurnAnnounce._t);
  showTurnAnnounce._t = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 250);
  }, 1400);
}

// Same white-pill HUD language as showTurnAnnounce, but the text is colored in the
// mover's own team color instead of the fixed dark gray. A separate element/timer
// from #turn-announce (rather than reusing it) so a wild/removal call-out and a
// turn change landing close together don't cut each other's timer short.
const MOVE_ANNOUNCE_MS = 1000;
function showMoveAnnounce(text, color) {
  const el = $('move-announce');
  el.innerHTML = `<div class="turn-announce-text" style="color:${color}">${text}</div>`;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(showMoveAnnounce._t);
  showMoveAnnounce._t = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 250);
  }, MOVE_ANNOUNCE_MS);
}

// A wild/removal play holds its showMoveAnnounce() pill on screen for 1s before the
// usual sound/flash/card-fly/shoutout sequence runs, so the call-out is actually
// read before the board changes; an ordinary card play runs that sequence
// immediately (delayMs 0). Tracked so a second move arriving while an earlier one's
// delayed effects are still pending cancels them, rather than firing late on top of
// whatever the newer move already showed.
let moveEffectsTimeoutId = null;
function scheduleMoveEffects(fn, delayMs) {
  clearTimeout(moveEffectsTimeoutId);
  if (delayMs > 0) moveEffectsTimeoutId = setTimeout(fn, delayMs);
  else fn();
}

// Named so the "how long is this animation still going to run for" calc up in
// renderGame (see cardFlyStillRunningMs) can't silently drift out of sync with the
// actual setTimeout values below.
const CARD_FLY_HOLD_MS = 1500; // ~0.5s spinning to a stop, then held still and readable
const CARD_FLY_LANDING_MS = 620; // spin back down, shrink, and move to the landed cell
const CARD_FLY_TOTAL_MS = CARD_FLY_HOLD_MS + CARD_FLY_LANDING_MS;

// A played card appears large in the middle of the board, then flies down and
// shrinks onto the exact cell it landed on — computed from the board's own current
// pan/zoom via BoardView.cellScreenPoint(), so it lands in the right place even if
// the player has panned or zoomed the board.
function showCardFly(move) {
  const el = $('card-fly');
  const rEl = $('card-fly-r');
  const sEl = $('card-fly-s');
  const imgEl = $('card-fly-img');
  const isWild = isTwoEyedJack(move.code);
  const isRemoval = isOneEyedJack(move.code);
  if (isWild || isRemoval) {
    // The illustrated jack itself already reads as "wild"/"removal" at a glance —
    // no rank/suit text needed on top of it.
    el.className = 'card-fly image-mode';
    rEl.hidden = true;
    sEl.hidden = true;
    imgEl.src = isWild ? 'images/jack-wild.png' : 'images/jack-removal.png';
    imgEl.hidden = false;
  } else {
    const rank = cardRank(move.code);
    const suit = cardSuit(move.code);
    el.className = 'card-fly' + (SUIT_COLOR[suit] === 'red' ? ' red' : '');
    rEl.hidden = false;
    sEl.hidden = false;
    rEl.textContent = rank;
    sEl.textContent = SUIT_SYMBOL[suit];
    imgEl.hidden = true;
  }
  el.style.left = '50%';
  el.style.top = '42%';
  el.style.animation = ''; // clear any leftover override from a previous play's landing (see below)
  el.hidden = false;
  clearTimeout(showCardFly._t1);
  clearTimeout(showCardFly._t2);
  // Force layout before adding .show, so the appear transition actually runs instead
  // of the browser coalescing it with the class change below into one jump.
  void el.offsetWidth;
  el.classList.add('show');
  showCardFly._t1 = setTimeout(() => {
    // The spin-in keyframe animation is still "in effect" here even though it
    // finished a second ago (it's forwards-filling) — a running/held animation on a
    // property always wins over a transition on that same property, so without
    // cancelling it here, adding .landing below would silently do nothing at all to
    // transform: the animation would keep holding it at its own end state. Safe to
    // drop to 'none' right now because that end state (scale(1) rotate(0deg)) is
    // exactly the base, non-animated value anyway — no visible jump.
    el.style.animation = 'none';
    // Force a reflow so the browser actually commits "animation cancelled, back to
    // the plain transform" as its own frame before the left/top/landing change
    // below — otherwise both changes can get coalesced into one recalc with no
    // transition in between, same reflow-forcing trick as the .show entrance above.
    void el.offsetWidth;
    const [sx, sy] = boardView.cellScreenPoint(move.targetIndex);
    el.style.left = sx + 'px';
    el.style.top = sy + 'px';
    el.classList.add('landing');
    showCardFly._t2 = setTimeout(() => {
      el.hidden = true;
      el.classList.remove('show', 'landing');
    }, CARD_FLY_LANDING_MS);
  }, CARD_FLY_HOLD_MS);
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Runs before the stats screen: highlights the winning sequences on the board with a
// pill outlined in the winning team's colour, pops the winners' names over a confetti
// burst, holds all of it for 3s, then hands off to the caller (normally
// showWinOverlay). computeSequences() gives back the actual sequence cells rather
// than trusting anything stored — nothing about the win is written to Firestore
// beyond winnerTeam itself, and this recomputes the same way every other render does.
const WIN_CELEBRATION_MS = 3000;
function runWinCelebration(game, winnerTeam, onDone) {
  playWinSound();
  const teamCount = room.settings.teamCount;
  const sequences = computeSequences(game.board, teamCount).filter((s) => s.team === winnerTeam);
  boardView.celebrateSequences(sequences.map((s) => s.cells), TEAM_COLOR[winnerTeam]);

  const order = room.order && room.order.length ? room.order : Object.keys(room.players);
  const names = order
    .map((pid) => room.players[pid])
    .filter((p) => p && p.team === winnerTeam)
    .map((p) => p.name);
  showWinConfetti(names, TEAM_COLOR[winnerTeam]);

  setTimeout(() => {
    // Back to every completed line (not just the winner's), same as ordinary
    // gameplay rendering — so if the win/stats screen is later dragged down to peek
    // at the board (see the win-overlay drag handle), the pills are still there
    // instead of the win celebration having wiped them.
    syncCompletedLinePills(computeSequences(game.board, teamCount));
    hideWinConfetti();
    onDone();
  }, WIN_CELEBRATION_MS);
}

function namesJoinedForWin(names) {
  if (names.length === 0) return 'They win!';
  if (names.length === 1) return `${names[0]} wins!`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]} win!`;
}

function showWinConfetti(names, color) {
  $('win-celebrate-names').textContent = namesJoinedForWin(names);
  spawnConfetti(color);
  $('win-celebrate').hidden = false;
}
function hideWinConfetti() {
  $('win-celebrate').hidden = true;
  $('confetti-field').innerHTML = '';
}
function spawnConfetti(teamColor, count = 60) {
  const field = $('confetti-field');
  field.innerHTML = '';
  const palette = [teamColor, '#ffd633', '#3fb56b', '#3b7fe0', '#e0473c'];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    p.style.background = palette[Math.floor(Math.random() * palette.length)];
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDuration = (2 + Math.random() * 1.4) + 's';
    p.style.animationDelay = (Math.random() * 0.5) + 's';
    p.style.setProperty('--spin', Math.round(360 + Math.random() * 540) + 'deg');
    frag.appendChild(p);
  }
  field.appendChild(frag);
}

// ---------------- Win overlay drag (peek at the board underneath) ----------------
// Dragging the little handle down slides the whole stats screen down, revealing the
// board (with its winning sequences still glowing) at the top of the viewport; drag
// or tap it again to bring the stats screen back up. Only the handle is a drag
// target, not the whole overlay, so the stats list's own internal scrolling and the
// action buttons underneath aren't affected.
let winOverlayPeeked = false;
let winOverlayDrag = null; // { startY, maxDrag, moved }
function resetWinOverlayDrag() {
  winOverlayPeeked = false;
  winOverlayDrag = null;
  const overlay = $('win-overlay');
  overlay.style.transition = 'none';
  overlay.style.transform = '';
}
function setWinOverlayOffset(px, animate) {
  const overlay = $('win-overlay');
  overlay.style.transition = animate ? 'transform 0.25s ease' : 'none';
  overlay.style.transform = px > 0 ? `translateY(${px}px)` : '';
}
(() => {
  const handle = $('win-overlay-handle');
  handle.addEventListener('pointerdown', (e) => {
    const maxDrag = Math.round(window.innerHeight * 0.62);
    winOverlayDrag = { startY: e.clientY, maxDrag, moved: false };
    handle.setPointerCapture(e.pointerId);
    setWinOverlayOffset(winOverlayPeeked ? maxDrag : 0, false);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!winOverlayDrag) return;
    const base = winOverlayPeeked ? winOverlayDrag.maxDrag : 0;
    const dy = Math.max(0, Math.min(winOverlayDrag.maxDrag, e.clientY - winOverlayDrag.startY + base));
    if (Math.abs(e.clientY - winOverlayDrag.startY) > 4) winOverlayDrag.moved = true;
    setWinOverlayOffset(dy, false);
  });
  const endDrag = (e) => {
    if (!winOverlayDrag) return;
    const { maxDrag, moved } = winOverlayDrag;
    const base = winOverlayPeeked ? maxDrag : 0;
    const dy = Math.max(0, Math.min(maxDrag, e.clientY - winOverlayDrag.startY + base));
    winOverlayDrag = null;
    winOverlayPeeked = moved ? dy > maxDrag * 0.35 : !winOverlayPeeked;
    setWinOverlayOffset(winOverlayPeeked ? maxDrag : 0, true);
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
})();

let lastVotesSignature = null;
let playAgainRetryId = null;
function stopPlayAgainRetry() {
  if (playAgainRetryId) { clearInterval(playAgainRetryId); playAgainRetryId = null; }
}
function showWinOverlay(winnerTeam) {
  const overlay = $('win-overlay');
  const game = room.game;
  // updateTurnTimer() already stops the timer once room.state !== 'playing', but that
  // depends on renderGame() reaching it on the same render pass this overlay comes
  // from — belt and suspenders, since a stray running interval this late would sit
  // right on top of a "wins!" overlay the whole table is looking at.
  stopTurnTimer();
  resetWinOverlayDrag();
  $('win-title').textContent = winnerTeam == null
    ? "🤝 It's a draw — the deck ran out"
    : `🎉 Team ${TEAM_NAMES[winnerTeam]} wins!`;

  const durationEl = $('stats-duration');
  durationEl.textContent = (room.startedAt && room.finishedAt && room.startedAt.toMillis && room.finishedAt.toMillis)
    ? `Game length: ${formatDuration(room.finishedAt.toMillis() - room.startedAt.toMillis())}`
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
  if (solo) {
    // No table to agree with — the button just redeals immediately.
    $('stats-votes').textContent = '';
    $('btn-play-again').textContent = 'Play Again';
    $('btn-play-again').disabled = false;
  } else {
    $('stats-votes').textContent = votedCount > 0 ? `${votedCount} of ${order.length} agreed to play again` : 'Everyone must agree to play again';
    $('btn-play-again').textContent = iVoted ? 'Waiting for others…' : 'Play Again';
    $('btn-play-again').disabled = iVoted;
  }

  overlay.hidden = false;

  // Keyed on this specific finish (room.finishedAt), not just who has voted — a bare
  // vote signature repeats identically across replays in the same room (the same two
  // players agreeing looks the same every time), so without a per-game key the second
  // "2 of 2 agreed" in a session would already equal lastVotesSignature from the
  // first, and the change check below would never fire the transaction at all. This
  // was a real bug, not a hypothetical: any second play-again in the same room visit
  // would silently do nothing.
  const finishKey = room.finishedAt && room.finishedAt.toMillis ? room.finishedAt.toMillis() : 'unknown';
  const signature = finishKey + ':' + order.filter((pid) => votes[pid]).sort().join(',');
  if (signature !== lastVotesSignature) {
    lastVotesSignature = signature;
    maybeStartNextGame();
  }

  // Belt-and-suspenders: everyone agreeing should always kick off the next round
  // immediately via the signature check above, but if a transaction attempt were
  // ever swallowed by a transient network error, nothing would naturally retry it
  // (nobody's vote changes again) and the whole table would sit on this screen
  // forever. So once every seat has voted, keep quietly re-attempting on a timer —
  // maybeStartNextGame() is already a safe no-op once the room has actually moved
  // on to 'playing'. Cleared as soon as this overlay is no longer being shown.
  stopPlayAgainRetry();
  if (!solo && votedCount > 0 && votedCount === order.length) {
    playAgainRetryId = setInterval(maybeStartNextGame, 4000);
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
      const patch = dealNewGamePatch(order, data.settings.teamCount);
      tx.update(roomRef, { state: 'playing', paused: false, pausedBy: null, ...patch });
    });
  } catch (e) {
    // A genuinely benign race (another client's transaction already moved the room to
    // 'playing') resolves inside the transaction body above via the state !== 'finished'
    // check, not by throwing — Firestore retries contention internally. So an error that
    // actually reaches here is far more likely a real failure than a race, and staying
    // silent about it is exactly how "everyone voted and nothing happened" goes
    // unreported. Every connected client calls this independently on each vote change,
    // so a structural failure surfaces on all of them, not just whoever clicked last.
    console.error(e);
    toast('Could not start the next game — try Play Again once more');
  }
}

$('btn-play-again').addEventListener('click', async () => {
  if (!room) return;
  if (solo) {
    // No one else to vote — deal straight away.
    const teamCount = room.settings.teamCount;
    const order = room.order && room.order.length ? room.order : Object.keys(room.players);
    room.state = 'playing';
    room.paused = false;
    room.pausedBy = null;
    dealNewGameLocally(order, teamCount);
    $('win-overlay').hidden = true;
    applyRoom();
    scheduleBotTurnIfNeeded();
    return;
  }
  if (!roomRef) return;
  await updateDoc(roomRef, { [`game.playAgainVotes.${playerId}`]: true }).catch(() => toast('Could not register vote'));
});
$('btn-quit-game').addEventListener('click', () => { stopPlayAgainRetry(); $('win-overlay').hidden = true; leaveRoom(); });

// ---------------- Boot ----------------
watchPublishedVersion();
checkForUpdate();
const savedRoom = localStorage.getItem('cr_room');
if (savedRoom) {
  enterRoom(savedRoom);
} else {
  const savedSolo = loadSoloRoom();
  if (savedSolo && savedSolo.room) resumeSolo(savedSolo);
}
