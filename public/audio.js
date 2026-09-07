// Real recorded sound effects (public/sounds/*.mp3), played through a shared
// AudioContext so they respect the same one-tap unlock as everything else in the
// app (iOS blocks audio until a real user gesture). Each file is fetched and
// decoded once, then cached as an AudioBuffer so replaying a cue is instant.

let ctx = null;
let master = null;

/** Browsers only allow audio to start inside a gesture; safe to call repeatedly. */
export function unlock() {
  try {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
    }
    // iOS can leave a context 'interrupted' (after a call, Siri, the screen locking)
    // rather than merely 'suspended', and it never resumes on its own — worth a
    // resume attempt whenever it isn't already running.
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  } catch { /* no audio on this device — everything degrades to silence */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
});
document.addEventListener('pointerdown', unlock, { passive: true });

// url -> Promise<AudioBuffer|null>, so concurrent/replayed calls for the same cue
// share one fetch+decode instead of re-fetching every time it plays.
const bufferPromises = new Map();
function loadBuffer(url) {
  if (!bufferPromises.has(url)) {
    const p = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((data) => ctx.decodeAudioData(data))
      .catch(() => null);
    bufferPromises.set(url, p);
  }
  return bufferPromises.get(url);
}

function playSample(url, vol = 1) {
  try {
    unlock();
    if (!ctx) return;
    loadBuffer(url).then((buffer) => {
      if (!buffer) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const g = ctx.createGain();
      g.gain.value = vol;
      src.connect(g).connect(master);
      src.start();
    });
  } catch { /* fine */ }
}

const SOUNDS = {
  turn: './sounds/turn-sound.mp3',
  cardLay: './sounds/card-lay-sound.mp3',
  sequence: './sounds/sequence-sound.mp3',
  win: './sounds/win-sound.mp3',
};

// Kicks off the fetch+decode for every cue as soon as the context unlocks, so the
// very first turn/card/sequence/win of a session doesn't have to wait on a network
// round-trip — by the time any of them actually needs to play, it's already decoded.
document.addEventListener('pointerdown', () => {
  if (!ctx) return;
  for (const url of Object.values(SOUNDS)) loadBuffer(url);
}, { once: true });

export const sfx = {
  yourTurn: () => playSample(SOUNDS.turn, 0.85),
  cardLay: () => playSample(SOUNDS.cardLay, 0.8),
  sequence: () => playSample(SOUNDS.sequence, 0.9),
  win: () => playSample(SOUNDS.win, 1),
};
