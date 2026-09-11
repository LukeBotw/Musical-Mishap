'use strict';
/* Musical Mishap audio engine.

   A song is pure data. Every client renders it locally with Web Audio, so we
   only ever send a few hundred bytes over the wire instead of audio.

   The guitars and basses are real plucked-string synthesis (Karplus-Strong):
   a burst of noise is fed round a short delay line that filters a little on
   every lap, which is what a vibrating string actually does. We render each
   note into a buffer once and cache it, so the room gets a proper instrument
   library without shipping a single audio file.

   Wrapped in an IIFE: these are classic scripts, so top-level names would
   otherwise collide with app.js on the shared global scope. */
(function () {

const STEPS = 32;
const LEAD_ROWS = 12;
const BASS_ROWS = 7;

const SCALES = {
  minorPent: [0, 3, 5, 7, 10],
  majorPent: [0, 2, 4, 7, 9],
  dorian:    [0, 2, 3, 5, 7, 9, 10],
  minor:     [0, 2, 3, 5, 7, 8, 10],
  major:     [0, 2, 4, 5, 7, 9, 11],
  blues:     [0, 3, 5, 6, 7, 10],
};

const SCALE_NAMES = {
  minorPent: 'Minor pentatonic',
  majorPent: 'Major pentatonic',
  dorian: 'Dorian',
  minor: 'Natural minor',
  major: 'Major',
  blues: 'Blues',
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/* Instruments.

   kind 'string' is plucked-string synthesis:
     bright     0-1, how much treble survives the pick. Low is mellow.
     damp       0-1, the delay-line filter. Higher loses highs faster.
     decayTime  seconds for the string to die away.
     drive      1 is clean; above that soft-clips, which is what makes a
                clean guitar into an electric one.
     len        seconds of audio to render per note.

   kind 'synth' is oscillator based, as before. */
const LEAD_INSTRUMENTS = [
  { name: 'Electric guitar', kind: 'string', bright: 0.62, damp: 0.50, decayTime: 1.5, drive: 3.4, len: 1.5, level: 0.40 },
  { name: 'Clean guitar',    kind: 'string', bright: 0.80, damp: 0.44, decayTime: 2.4, drive: 1.0, len: 1.6, level: 0.38 },
  { name: 'Muted guitar',    kind: 'string', bright: 0.55, damp: 0.70, decayTime: 0.26, drive: 2.2, len: 0.5, level: 0.46 },
  { name: 'Synth pluck',     kind: 'synth', wave: 'pluck',  level: 0.36 },
  { name: 'Square lead',     kind: 'synth', wave: 'square', level: 0.30 },
  { name: 'Saw lead',        kind: 'synth', wave: 'saw',    level: 0.26 },
  { name: 'Sine',            kind: 'synth', wave: 'sine',   level: 0.34 },
  { name: 'Bell',            kind: 'synth', wave: 'bell',   level: 0.30 },
  { name: 'Organ',           kind: 'synth', wave: 'organ',  level: 0.26 },
];

const BASS_INSTRUMENTS = [
  { name: 'Electric bass', kind: 'string', bright: 0.32, damp: 0.56, decayTime: 1.5, drive: 1.5, len: 1.5, level: 0.52 },
  { name: 'Picked bass',   kind: 'string', bright: 0.62, damp: 0.44, decayTime: 1.2, drive: 2.4, len: 1.3, level: 0.48 },
  { name: 'Sub',           kind: 'synth', wave: 'sine',   level: 0.50 },
  { name: 'Square bass',   kind: 'synth', wave: 'square', level: 0.34 },
  { name: 'Saw bass',      kind: 'synth', wave: 'saw',    level: 0.32 },
];

/* Drum kits. Each lane is shaped separately per kit rather than just retuned,
   because what separates a rock kit from an 808 is the envelope as much as
   the pitch. */
const KITS = [
  {
    name: 'Acoustic',
    kick:  { start: 145, end: 52, drop: 0.075, decay: 0.30, click: 0.5, drive: 1.4 },
    snare: { tone: 190, noise: 1900, q: 0.8, decay: 0.16, toneMix: 0.35, level: 0.55 },
    hat:   { metal: true, hp: 7800, decay: 0.048, level: 0.20 },
    clap:  { band: 1150, q: 5, decay: 0.16, level: 0.42 },
  },
  {
    name: 'Rock',
    kick:  { start: 190, end: 58, drop: 0.055, decay: 0.24, click: 0.85, drive: 2.2 },
    snare: { tone: 220, noise: 2400, q: 0.7, decay: 0.22, toneMix: 0.3, level: 0.68 },
    hat:   { metal: true, hp: 8800, decay: 0.038, level: 0.22 },
    clap:  { band: 1500, q: 4, decay: 0.2, level: 0.46 },
  },
  {
    name: '808',
    kick:  { start: 150, end: 44, drop: 0.11, decay: 0.55, click: 0.25, drive: 1.0 },
    snare: { tone: 180, noise: 1700, q: 1.0, decay: 0.13, toneMix: 0.45, level: 0.5 },
    hat:   { metal: true, hp: 9500, decay: 0.03, level: 0.18 },
    clap:  { band: 1000, q: 6, decay: 0.14, level: 0.40 },
  },
  {
    name: 'Lo-fi',
    // A tape-style ceiling over the whole kit. Without it the noise hat is
    // broader than the metallic ones and lo-fi ends up the brightest kit,
    // which is precisely backwards.
    lp: 3200,
    kick:  { start: 115, end: 48, drop: 0.09, decay: 0.36, click: 0.2, drive: 1.2 },
    snare: { tone: 160, noise: 1250, q: 1.2, decay: 0.19, toneMix: 0.4, level: 0.48 },
    hat:   { metal: false, hp: 4000, decay: 0.05, level: 0.16 },
    clap:  { band: 900, q: 5, decay: 0.18, level: 0.36 },
  },
];

const LEAD_WAVES = LEAD_INSTRUMENTS.map((i) => i.name);
const BASS_WAVES = BASS_INSTRUMENTS.map((i) => i.name);
const KIT_NAMES = KITS.map((k) => k.name);

// Degree index -> MIDI note. Indices past the end of the scale wrap up an octave,
// which is why every grid row lands on a note that fits the key.
function degreeToMidi(degree, scaleName, root, baseMidi) {
  const scale = SCALES[scaleName] || SCALES.minorPent;
  const octave = Math.floor(degree / scale.length);
  const step = ((degree % scale.length) + scale.length) % scale.length;
  return baseMidi + root + scale[step] + 12 * octave;
}
const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

function noteLabel(degree, scaleName, root, baseMidi) {
  const m = degreeToMidi(degree, scaleName, root, baseMidi);
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
const leadInst = (i) => LEAD_INSTRUMENTS[clamp(i | 0, 0, LEAD_INSTRUMENTS.length - 1)];
const bassInst = (i) => BASS_INSTRUMENTS[clamp(i | 0, 0, BASS_INSTRUMENTS.length - 1)];
const kitOf = (i) => KITS[clamp(i | 0, 0, KITS.length - 1)];

function emptySong() {
  const lead = [];
  const bass = [];
  for (let i = 0; i < STEPS; i++) {
    lead.push(new Array(LEAD_ROWS).fill(0));
    bass.push(-1);
  }
  const zeros = () => new Array(STEPS).fill(0);
  return {
    title: '',
    tempo: 110,
    root: 0,
    scale: 'minorPent',
    swing: 0,
    kit: 0,
    drums: { kick: zeros(), snare: zeros(), hat: zeros(), clap: zeros() },
    bass,
    lead,
    leadWave: 0,
    bassWave: 0,
    cutoff: 0.7,
    delay: 0,
  };
}

// Merge runs of adjacent cells into single sustained notes. Held notes sound far
// more musical than a wall of staccato sixteenths.
function compile(song) {
  const events = [];
  for (let i = 0; i < STEPS; i++) events.push({ lead: [], bass: null });

  for (let row = 0; row < LEAD_ROWS; row++) {
    let s = 0;
    while (s < STEPS) {
      if (!song.lead[s][row]) { s++; continue; }
      let len = 1;
      while (s + len < STEPS && song.lead[s + len][row]) len++;
      events[s].lead.push({ row, len });
      s += len;
    }
  }

  let s = 0;
  while (s < STEPS) {
    const v = song.bass[s];
    if (v < 0) { s++; continue; }
    let len = 1;
    while (s + len < STEPS && song.bass[s + len] === v) len++;
    events[s].bass = { row: v, len };
    s += len;
  }
  return events;
}

/* Karplus-Strong. Pluck a noise-filled delay line and let it filter itself
   down. The result is rendered once per pitch and cached, so this cost is
   paid at most once per note of the song. */
function renderString(sampleRate, freq, inst) {
  const n = Math.max(2, Math.round(sampleRate / freq));
  const total = Math.max(n * 4, Math.floor(sampleRate * inst.len));
  const out = new Float32Array(total);
  const ring = new Float32Array(n);

  // The excitation is noise through a one-pole lowpass: a softer pick has
  // less treble to start with, before the string filters any of it away.
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    lp += (white - lp) * inst.bright;
    ring[i] = lp;
  }

  // Per-sample loop gain chosen so the decay lasts the same wall-clock time
  // at every pitch, rather than dying quickly on high notes.
  const g = Math.exp(-1 / (inst.decayTime * sampleRate));
  const damp = inst.damp;
  let idx = 0;
  let peak = 0;
  for (let i = 0; i < total; i++) {
    const cur = ring[idx];
    const nxt = ring[(idx + 1) % n];
    ring[idx] = (cur * damp + nxt * (1 - damp)) * g;
    out[i] = cur;
    const a = cur < 0 ? -cur : cur;
    if (a > peak) peak = a;
    idx = (idx + 1) % n;
  }

  // Normalise, then soft-clip. Overdrive is what turns a clean string into an
  // electric guitar, and doing it here bakes it into the cached note.
  const norm = peak > 0 ? 1 / peak : 1;
  const drive = inst.drive || 1;
  const shape = Math.tanh(drive);
  let peak2 = 0;
  for (let i = 0; i < total; i++) {
    let v = out[i] * norm;
    if (drive > 1.01) v = Math.tanh(v * drive) / shape;
    out[i] = v;
    const a = v < 0 ? -v : v;
    if (a > peak2) peak2 = a;
  }
  if (peak2 > 0) for (let i = 0; i < total; i++) out[i] /= peak2;

  return out;
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.song = null;
    this.events = null;
    this.playing = false;
    this.step = 0;
    this.nextTime = 0;
    this.timer = null;
    this.queue = [];        // {step, time} pairs for the visual playhead
    this.onStep = null;
    this.loops = 0;
    this.samples = new Map();
  }

  // Must be called from a user gesture: browsers refuse to start audio otherwise.
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.8;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 24;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;

    this.master.connect(comp);
    comp.connect(ctx.destination);

    // Shared delay send, retuned per song when one is loaded.
    this.delay = ctx.createDelay(1.5);
    this.delayGain = ctx.createGain();
    this.delayGain.gain.value = 0;
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.34;
    this.delayFilter = ctx.createBiquadFilter();
    this.delayFilter.type = 'lowpass';
    this.delayFilter.frequency.value = 2600;

    this.delay.connect(this.delayFilter);
    this.delayFilter.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.delayFilter.connect(this.delayGain);
    this.delayGain.connect(this.master);

    // One noise buffer reused by every percussion hit.
    const len = Math.floor(ctx.sampleRate * 1.2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;

    return ctx;
  }

  get stepDur() {
    return 60 / this.song.tempo / 4;
  }

  // Fetch (or render) the cached note for a plucked instrument.
  stringBuffer(instKey, inst, midi) {
    const key = instKey + ':' + midi;
    let buf = this.samples.get(key);
    if (buf) return buf;
    const sr = this.ctx.sampleRate;
    const data = renderString(sr, midiToFreq(midi), inst);
    buf = this.ctx.createBuffer(1, data.length, sr);
    buf.copyToChannel(data, 0);
    this.samples.set(key, buf);
    return buf;
  }

  // Render every note the song could reach, so the first bar never stutters
  // while a string is being generated mid-playback.
  warm(song) {
    if (!this.ctx) return;
    const lead = leadInst(song.leadWave);
    if (lead.kind === 'string') {
      for (let r = 0; r < LEAD_ROWS; r++) {
        this.stringBuffer('L' + song.leadWave, lead, degreeToMidi(r, song.scale, song.root, 60));
      }
    }
    const bass = bassInst(song.bassWave);
    if (bass.kind === 'string') {
      for (let r = 0; r < BASS_ROWS; r++) {
        this.stringBuffer('B' + song.bassWave, bass, degreeToMidi(r, song.scale, song.root, 36));
      }
    }
  }

  load(song) {
    this.song = song;
    this.events = compile(song);
    if (this.ctx) {
      this.delayGain.gain.value = song.delay ? 0.3 : 0;
      this.delay.delayTime.value = Math.min(1.4, this.stepDur * 3);
      this.warm(song);
    }
  }

  play(song) {
    this.init();
    if (song) this.load(song);
    if (!this.song) return;
    this.warm(this.song);
    this.stop();
    this.playing = true;
    this.step = 0;
    this.loops = 0;
    this.queue.length = 0;
    this.nextTime = this.ctx.currentTime + 0.08;
    this.scheduler();
    this.timer = setInterval(() => this.scheduler(), 25);
  }

  stop() {
    this.playing = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.queue.length = 0;
    if (this.onStep) this.onStep(-1);
  }

  toggle(song) {
    if (this.playing) this.stop(); else this.play(song);
  }

  // Classic lookahead scheduler: schedule a little ahead of the clock, on a
  // coarse timer, so audio timing never depends on the main thread being free.
  scheduler() {
    if (!this.playing) return;
    const horizon = this.ctx.currentTime + 0.12;
    while (this.nextTime < horizon) {
      const swing = (this.step % 2 === 1) ? this.song.swing * this.stepDur * 0.5 : 0;
      const at = this.nextTime + swing;
      this.fireStep(this.step, at);
      this.queue.push({ step: this.step, time: at });

      this.nextTime += this.stepDur;
      this.step++;
      if (this.step >= STEPS) { this.step = 0; this.loops++; }
    }
    this.drainQueue();
  }

  drainQueue() {
    if (!this.onStep) return;
    const t = this.ctx.currentTime;
    let current = null;
    while (this.queue.length && this.queue[0].time <= t) current = this.queue.shift().step;
    if (current !== null) this.onStep(current);
  }

  fireStep(step, time) {
    const song = this.song;
    const d = song.drums;
    const kit = kitOf(song.kit);
    if (d.kick[step]) this.kick(time, kit);
    if (d.snare[step]) this.snare(time, kit);
    if (d.hat[step]) this.hat(time, kit);
    if (d.clap[step]) this.clap(time, kit);

    const ev = this.events[step];
    const sd = this.stepDur;
    if (ev.bass) {
      const midi = degreeToMidi(ev.bass.row, song.scale, song.root, 36);
      this.bassVoice(time, midi, ev.bass.len * sd, song.bassWave);
    }
    for (const n of ev.lead) {
      const midi = degreeToMidi(n.row, song.scale, song.root, 60);
      this.leadVoice(time, midi, n.len * sd, song.leadWave, song.cutoff, ev.lead.length);
    }
  }

  // ------------------------------------------------------------ helpers
  env(node, time, peak, attack, decay) {
    const g = node.gain;
    g.setValueAtTime(0.0001, time);
    g.exponentialRampToValueAtTime(peak, time + attack);
    g.exponentialRampToValueAtTime(0.0001, time + attack + decay);
  }

  noiseSource(time, dur) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(time, Math.random() * 0.5, dur);
    return src;
  }

  // Where a drum hit should land. Kits with a tone ceiling get their own
  // lowpass in front of the master, which is what makes a kit sound dusty
  // rather than merely differently tuned.
  drumDest(kit) {
    if (!kit.lp) return this.master;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = kit.lp;
    lp.Q.value = 0.7;
    lp.connect(this.master);
    return lp;
  }

  // ------------------------------------------------------------ drums
  kick(time, kit) {
    const ctx = this.ctx;
    const k = kit.kick;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(k.start, time);
    osc.frequency.exponentialRampToValueAtTime(k.end, time + k.drop);
    this.env(gain, time, 1.0, 0.003, k.decay);

    let tail = gain;
    if (k.drive > 1.05) {
      // A touch of saturation gives the beater some bite through a mix.
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = (i / 1023) * 2 - 1;
        curve[i] = Math.tanh(x * k.drive) / Math.tanh(k.drive);
      }
      shaper.curve = curve;
      gain.connect(shaper);
      tail = shaper;
    }
    tail.connect(this.master);
    osc.connect(gain);
    osc.start(time);
    osc.stop(time + k.decay + 0.1);

    // The click is most of what tells you which kit you are hearing.
    if (k.click > 0.01) {
      const src = this.noiseSource(time, 0.03);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2200;
      const cg = ctx.createGain();
      this.env(cg, time, 0.28 * k.click, 0.001, 0.02);
      src.connect(hp); hp.connect(cg); cg.connect(this.master);
    }
  }

  snare(time, kit) {
    const ctx = this.ctx;
    const s = kit.snare;
    const src = this.noiseSource(time, 0.4);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = s.noise;
    bp.Q.value = s.q;
    const g = ctx.createGain();
    this.env(g, time, s.level, 0.002, s.decay);
    src.connect(bp); bp.connect(g); g.connect(this.master);

    // Two detuned shells under the wires: that is the drum, not the snares.
    for (const mul of [1, 1.48]) {
      const tone = ctx.createOscillator();
      const tg = ctx.createGain();
      tone.type = 'triangle';
      tone.frequency.setValueAtTime(s.tone * mul, time);
      tone.frequency.exponentialRampToValueAtTime(s.tone * mul * 0.82, time + 0.06);
      this.env(tg, time, s.level * s.toneMix, 0.002, s.decay * 0.6);
      tone.connect(tg); tg.connect(this.master);
      tone.start(time); tone.stop(time + s.decay + 0.05);
    }
  }

  hat(time, kit) {
    const ctx = this.ctx;
    const h = kit.hat;
    const g = ctx.createGain();
    this.env(g, time, h.level, 0.001, h.decay);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = h.hp;
    hp.connect(g);
    g.connect(this.master);

    if (h.metal) {
      // Six inharmonic squares is the classic recipe for a metallic hat, and
      // it beats filtered noise for sounding like actual cymbal alloy.
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = h.hp * 1.25;
      bp.Q.value = 1.2;
      bp.connect(hp);
      for (const ratio of [2, 3, 4.16, 5.43, 6.79, 8.21]) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = 40 * ratio;
        o.connect(bp);
        o.start(time);
        o.stop(time + h.decay + 0.02);
      }
    } else {
      this.noiseSource(time, 0.15).connect(hp);
    }
  }

  clap(time, kit) {
    const ctx = this.ctx;
    const c = kit.clap;
    // Three staggered bursts is what gives a clap its characteristic smear.
    for (let i = 0; i < 3; i++) {
      const t = time + i * 0.012;
      const src = this.noiseSource(t, 0.25);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = c.band;
      bp.Q.value = c.q;
      const g = ctx.createGain();
      this.env(g, t, i === 2 ? c.level : c.level * 0.5, 0.001, i === 2 ? c.decay : 0.03);
      src.connect(bp); bp.connect(g); g.connect(this.master);
    }
  }

  // ------------------------------------------------------------ pitched
  stringVoice(time, midi, dur, instKey, inst, filterFreq, level, useDelay) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.stringBuffer(instKey, inst, midi);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = filterFreq;
    lp.Q.value = 0.9;

    const g = ctx.createGain();
    // Let the note ring a little past its step: strings do not stop dead when
    // the next sixteenth arrives.
    const hold = Math.max(0.12, dur * 0.95);
    const release = 0.16;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(level, time + 0.004);
    g.gain.setValueAtTime(level, time + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, time + hold + release);

    src.connect(lp); lp.connect(g); g.connect(this.master);
    if (useDelay) g.connect(this.delay);
    src.start(time);
    src.stop(time + hold + release + 0.05);
  }

  bassVoice(time, midi, dur, waveIndex) {
    const inst = bassInst(waveIndex);
    const freq = midiToFreq(midi);

    if (inst.kind === 'string') {
      // Bass stays out of the delay: echoing the low end just makes mud.
      this.stringVoice(time, midi, dur, 'B' + waveIndex, inst,
        Math.min(3000, freq * 14), inst.level, false);
      return;
    }

    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = inst.wave === 'sine' ? 'sine' : (inst.wave === 'square' ? 'square' : 'sawtooth');
    osc.frequency.value = freq;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(4000, freq * 10), time);
    lp.frequency.exponentialRampToValueAtTime(Math.max(120, freq * 3), time + Math.min(0.3, dur));
    lp.Q.value = 4;

    const g = ctx.createGain();
    const hold = Math.max(0.08, dur * 0.9);
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(inst.level, time + 0.008);
    g.gain.setValueAtTime(inst.level, time + hold * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, time + hold);

    osc.connect(lp); lp.connect(g); g.connect(this.master);
    osc.start(time);
    osc.stop(time + hold + 0.05);
  }

  leadVoice(time, midi, dur, waveIndex, cutoff, voices) {
    const inst = leadInst(waveIndex);
    const freq = midiToFreq(midi);
    // Chords get quieter per note so a fistful of cells never clips the master.
    const level = inst.level / Math.sqrt(Math.max(1, voices));
    const filterFreq = 300 + Math.pow(cutoff, 2) * 11000;

    if (inst.kind === 'string') {
      this.stringVoice(time, midi, dur, 'L' + waveIndex, inst,
        filterFreq, level, !!this.song.delay);
      return;
    }

    const ctx = this.ctx;
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = filterFreq;
    lp.Q.value = 1.2;

    lp.connect(g);
    g.connect(this.master);
    if (this.song.delay) g.connect(this.delay);

    const oscs = [];
    const add = (type, detune, mul) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq * (mul || 1);
      o.detune.value = detune || 0;
      o.connect(lp);
      oscs.push(o);
    };

    let attack = 0.008;
    let hold = Math.max(0.1, dur * 0.92);
    let peak = level;

    switch (inst.wave) {
      case 'pluck':
        add('triangle', 0); add('sine', 7, 2);
        hold = Math.min(hold, 0.28);
        peak = level * 1.2;
        break;
      case 'square': add('square', 0); add('square', -8); break;
      case 'saw': add('sawtooth', 0); add('sawtooth', 9); break;
      case 'sine': add('sine', 0); attack = 0.02; break;
      case 'bell':
        add('sine', 0); add('sine', 3, 2.76); add('sine', -3, 5.4);
        hold = Math.max(hold, 0.5);
        break;
      case 'organ':
        add('sine', 0); add('sine', 0, 2); add('sine', 4, 3); add('sine', 0, 4);
        attack = 0.015;
        break;
    }

    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(peak, time + attack);
    if (inst.wave === 'pluck' || inst.wave === 'bell') {
      g.gain.exponentialRampToValueAtTime(0.0001, time + hold);
    } else {
      g.gain.setValueAtTime(peak, time + hold * 0.75);
      g.gain.exponentialRampToValueAtTime(0.0001, time + hold);
    }

    for (const o of oscs) { o.start(time); o.stop(time + hold + 0.1); }
  }

  // One-shot preview used when clicking a cell or a row label in the editor.
  preview(song, kind, row) {
    this.init();
    this.song = song;
    const t = this.ctx.currentTime + 0.01;
    const sd = 60 / song.tempo / 4;
    const kit = kitOf(song.kit);
    if (kind === 'lead') {
      this.leadVoice(t, degreeToMidi(row, song.scale, song.root, 60), sd * 3,
        song.leadWave, song.cutoff, 1);
    } else if (kind === 'bass') {
      this.bassVoice(t, degreeToMidi(row, song.scale, song.root, 36), sd * 3, song.bassWave);
    } else if (kind === 'kick') this.kick(t, kit);
    else if (kind === 'snare') this.snare(t, kit);
    else if (kind === 'hat') this.hat(t, kit);
    else if (kind === 'clap') this.clap(t, kit);
  }
}

const API = {
  AudioEngine,
  emptySong,
  compile,
  degreeToMidi,
  midiToFreq,
  noteLabel,
  renderString,
  STEPS,
  LEAD_ROWS,
  BASS_ROWS,
  SCALES,
  SCALE_NAMES,
  NOTE_NAMES,
  LEAD_INSTRUMENTS,
  BASS_INSTRUMENTS,
  KITS,
  LEAD_WAVES,
  BASS_WAVES,
  KIT_NAMES,
};

// AudioContext is only touched inside init(), so the data half of this module
// loads fine under Node — which is what lets the tests check real presets.
if (typeof window !== 'undefined') window.SongAudio = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;

})();
