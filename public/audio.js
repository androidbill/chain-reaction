// The "your turn" cue, ported from HexColony's audio.js as a faithful subset — same
// synthesis chain (a shared compressor so a note never clips, a short convolver
// reverb impulse so it doesn't sound like a bare test tone, notes with a real
// exponential envelope rather than switched on/off, and two slightly detuned
// oscillators per note — "fat" — so the beating between them keeps a note from
// sounding thin), trimmed down to just what sfx.yourTurn() needs. HexColony's own
// audio.js has the fuller engine (noise bursts, knocks, dice) this is a subset of;
// no reason to carry that machinery over for one cue.

let ctx = null;
let master = null;
let roomSend = null;

/** A small room, as a decaying noise impulse — see HexColony's makeRoom(). */
function makeRoom(seconds = 0.55) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2.6;
  }
  return buf;
}

/** Browsers only allow audio to start inside a gesture; safe to call repeatedly. */
export function unlock() {
  try {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.85;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 22;
      comp.ratio.value = 5;
      comp.attack.value = 0.004;
      comp.release.value = 0.18;
      master.connect(comp).connect(ctx.destination);

      const conv = ctx.createConvolver();
      conv.buffer = makeRoom();
      roomSend = ctx.createGain();
      roomSend.gain.value = 0.5;
      roomSend.connect(conv).connect(master);
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

function route(source, { vol, delay, dur, attack, room }) {
  const t0 = ctx.currentTime + delay;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  source.connect(g).connect(master);
  if (room) {
    const s = ctx.createGain();
    s.gain.value = room;
    g.connect(s);
    s.connect(roomSend);
  }
  return t0;
}

function note(freq, opts = {}) {
  try {
    unlock();
    if (!ctx) return;
    const { type = 'triangle', dur = 0.18, vol = 0.2, delay = 0, attack = 0.006, detune = 0, room = 0.16 } = opts;
    const o = ctx.createOscillator();
    o.type = type;
    const t0 = route(o, { vol, delay, dur, attack, room });
    o.frequency.setValueAtTime(freq, t0);
    if (detune) o.detune.setValueAtTime(detune, t0);
    o.start(t0);
    o.stop(t0 + dur + 0.06);
  } catch { /* fine */ }
}

/** Two notes a whisker apart. The beating between them is what stops a cue sounding thin. */
function fat(freq, opts = {}) {
  note(freq, opts);
  note(freq, { ...opts, detune: 7, vol: (opts.vol ?? 0.2) * 0.55, room: 0 });
}

const C4 = 262, G5 = 784, C6 = 1047, E6 = 1319;

export const sfx = {
  // A low root note under a rising three-note arpeggio, staggered 90ms apart —
  // identical to HexColony's sfx.yourTurn().
  yourTurn: () => {
    note(C4, { dur: 0.34, vol: 0.14, type: 'sine' });
    [G5, C6, E6].forEach((f, i) => fat(f, { delay: i * 0.09, dur: 0.26, vol: 0.17 }));
  },
};
