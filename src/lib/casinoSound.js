// Casino sounds (0.20.0). Every sound is made here with the Web Audio API: no audio files.
//
//   playSound(name)      chip · card · diceRattle · diceLand · reelStop · win · bigWin
//   startLoop('reelSpin') → stop()   a sound that runs until stopped (the reels spinning)
//   useSoundOn()         true / false, re-renders when it changes (any page, any tab of this phone)
//   setSoundOn(on)       saved per phone in localStorage ('backyardbook.casinoSound'), shared by every game; on by default
//   useCasinoSound()     a casino page (or the lobby) uses sound: the first tap creates the AudioContext (phones block sound
//                        until a tap), it is suspended while the tab is hidden, closed when the last such page unmounts
//
// Never plays while the tab is hidden or the sound is off. A win also buzzes Android phones (navigator.vibrate(30)) when the
// sound is on; iPhones have no vibrate and are skipped. Nothing here sets React state during render.

import { useEffect, useSyncExternalStore } from 'react';

export const SOUND_STORAGE_KEY = 'backyardbook.casinoSound';
const MIN_GAP_MS = 35; // the same sound twice within this is played once (several spots paying at the same moment)

function readSoundOn() {
  try {
    return window.localStorage.getItem(SOUND_STORAGE_KEY) !== 'off';
  } catch {
    return true; // storage blocked: on, and not remembered
  }
}

let soundOn = typeof window === 'undefined' ? true : readSoundOn();
const listeners = new Set();
let ctx = null;
let master = null;
let users = 0;
let noiseBuffer = null;
const lastPlayed = new Map();
const loops = new Set();

function notify() {
  listeners.forEach((fn) => fn());
}

function subscribe(fn) {
  listeners.add(fn);
  // Another tab of this phone changed it.
  const onStorage = (e) => {
    if (e.key !== SOUND_STORAGE_KEY) return;
    const next = readSoundOn();
    if (next !== soundOn) {
      soundOn = next;
      if (!soundOn) stopAllLoops();
      notify();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

export function isSoundOn() {
  return soundOn;
}

export function setSoundOn(on) {
  soundOn = Boolean(on);
  try {
    window.localStorage.setItem(SOUND_STORAGE_KEY, soundOn ? 'on' : 'off');
  } catch {
    // Not remembered on this phone; it still applies until the page is reloaded.
  }
  if (!soundOn) stopAllLoops();
  else unlock(); // the toggle tap is a user gesture: a good moment to start the context
  notify();
}

export function useSoundOn() {
  return useSyncExternalStore(subscribe, isSoundOn, () => true);
}

function hidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

// Called from a tap: creates (or wakes) the AudioContext. Phones only allow this inside a user gesture.
function unlock() {
  if (typeof window === 'undefined' || users === 0) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    if (!ctx) {
      ctx = new Ctx();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended' && !hidden()) ctx.resume().catch(() => {});
  } catch {
    ctx = null;
    master = null;
  }
}

function stopAllLoops() {
  for (const stop of [...loops]) stop();
}

// A page that uses sound. Counted, so the context lives while any casino page is open and is closed after the last one.
export function useCasinoSound() {
  useEffect(() => {
    users += 1;
    const onGesture = () => unlock();
    const onVisibility = () => {
      if (!ctx) return;
      if (hidden()) {
        stopAllLoops();
        ctx.suspend().catch(() => {});
      } else if (soundOn) {
        ctx.resume().catch(() => {});
      }
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
      document.removeEventListener('visibilitychange', onVisibility);
      users -= 1;
      if (users === 0) {
        stopAllLoops();
        const old = ctx;
        ctx = null;
        master = null;
        noiseBuffer = null;
        old?.close().catch(() => {});
      }
    };
  }, []);
}

// ---------- building blocks ----------

function ready() {
  return soundOn && !hidden() && ctx && master && ctx.state === 'running';
}

function noise() {
  if (!noiseBuffer) {
    const length = Math.floor(ctx.sampleRate * 0.5);
    noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

// A tone: frequency (Hz, or [from, to] for a sweep), start offset and length in seconds, wave, peak level.
function tone(freq, at, dur, type = 'sine', level = 0.3) {
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  const [from, to] = Array.isArray(freq) ? freq : [freq, freq];
  osc.frequency.setValueAtTime(from, t);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(level, t + Math.min(0.01, dur / 4));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// A burst of filtered noise: a click, a swish, a rattle.
function burst(at, dur, { type = 'bandpass', freq = 2000, q = 1, level = 0.3, sweepTo = null } = {}) {
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noise();
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t);
  if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(level, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(gain).connect(master);
  src.start(t, Math.random() * 0.3);
  src.stop(t + dur + 0.02);
}

const SOUNDS = {
  // Two clay chips knocking together.
  chip: () => {
    burst(0, 0.035, { freq: 3200, q: 4, level: 0.5 });
    tone(2300, 0, 0.05, 'triangle', 0.12);
    burst(0.045, 0.03, { freq: 2600, q: 4, level: 0.3 });
  },
  // A card sliding off the shoe.
  card: () => burst(0, 0.12, { type: 'highpass', freq: 1200, sweepTo: 5000, q: 0.7, level: 0.35 }),
  // Dice shaken in the hand.
  diceRattle: () => {
    for (let i = 0; i < 7; i += 1) burst(i * 0.065 + Math.random() * 0.02, 0.03, { freq: 1500 + Math.random() * 1200, q: 6, level: 0.45 });
  },
  // Dice hitting the table: two knocks.
  diceLand: () => {
    tone([180, 90], 0, 0.09, 'sine', 0.5);
    burst(0, 0.05, { type: 'lowpass', freq: 900, level: 0.5 });
    tone([160, 80], 0.11, 0.08, 'sine', 0.35);
    burst(0.11, 0.04, { type: 'lowpass', freq: 800, level: 0.35 });
  },
  // A reel locking in place.
  reelStop: () => {
    tone([260, 140], 0, 0.08, 'square', 0.12);
    burst(0, 0.05, { freq: 900, q: 2, level: 0.4 });
  },
  // A short rising chime.
  win: () => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.09, 0.22, 'triangle', 0.22));
    vibrate();
  },
  // A fanfare: an arpeggio, then a held chord.
  bigWin: () => {
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone(f, i * 0.1, 0.25, 'square', 0.08));
    [523.25, 659.25, 783.99, 1046.5].forEach((f) => tone(f, 0.55, 0.9, 'triangle', 0.14));
    vibrate();
  },
};

function vibrate() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(30);
  } catch {
    // Not supported: skipped.
  }
}

function record(name) {
  // The phone check (tools/phone-check) puts an array here to see which sounds were asked for; normal pages don't.
  if (typeof window !== 'undefined' && Array.isArray(window.__soundLog)) window.__soundLog.push(name);
}

export function playSound(name) {
  if (!soundOn || hidden()) return;
  const now = Date.now();
  if (now - (lastPlayed.get(name) ?? 0) < MIN_GAP_MS) return;
  lastPlayed.set(name, now);
  record(name);
  if (!ready()) return;
  try {
    SOUNDS[name]?.();
  } catch {
    // A sound failing must never break the game.
  }
}

// The reels spinning: a soft ticking until stop() is called (also stopped when muted, hidden or the last page closes).
export function startLoop(name) {
  if (name !== 'reelSpin' || !soundOn || hidden()) return () => {};
  record(name);
  if (!ready()) return () => {};
  let stopped = false;
  let timer = null;
  const tick = () => {
    if (stopped) return;
    if (ready()) burst(0, 0.025, { freq: 1800 + Math.random() * 600, q: 5, level: 0.18 });
    timer = setTimeout(tick, 70);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    loops.delete(stop);
  };
  loops.add(stop);
  tick();
  return stop;
}
