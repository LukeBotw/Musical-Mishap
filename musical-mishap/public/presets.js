'use strict';
/* Style presets: a sound and a starter groove you can build on.

   Patterns are written as 32-character strings, one character per sixteenth
   note (two bars of 4/4). Beats land on steps 0, 4, 8, 12, ... which makes the
   grooves readable — and editable — straight from this file.

     drums: 'x' is a hit, '.' is a rest.
     bass:  a digit is a scale degree, '-' is a rest. Repeating a digit holds
            the note, because the engine merges runs into one sustained note.
     lead:  [step, degree, length] triples.

   Degrees index into the preset's scale, so 0 is always the root and every
   preset stays in whatever key the player has chosen. */

const STEPS = 32;

// Scale degree cheat sheet, for anyone editing the patterns below:
//   minorPent  0=root 1=b3 2=4  3=5  4=b7  5=root+8ve
//   majorPent  0=root 1=2  2=3  3=5  4=6   5=root+8ve
//   dorian     0=root 1=2  2=b3 3=4  4=5   5=6   6=b7
//   minor      0=root 1=2  2=b3 3=4  4=5   5=b6  6=b7
//   major      0=root 1=2  2=3  3=4  4=5   5=6   6=7
//   blues      0=root 1=b3 2=4  3=b5 4=5   5=b7

const PRESETS = [
  {
    id: 'rock',
    name: 'Rock',
    group: 'Genres',
    blurb: 'Overdriven electric guitar, picked bass, snare on two and four.',
    tempo: 142, scale: 'minorPent', kit: 1,
    leadWave: 0, bassWave: 1, cutoff: 0.8, swing: 0, delay: 0,
    kick:  'x.....x.x.......x.....x.x.......',
    snare: '....x.......x.......x.......x...',
    hat:   'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.',
    clap:  '................................',
    bass:  '0-0-0-0-0-0-0-0-3-3-3-3-4-4-4-4-',
    lead: [[0, 0, 2], [4, 2, 2], [8, 3, 2], [12, 2, 2],
           [16, 0, 2], [20, 2, 2], [24, 4, 2], [28, 3, 4]],
  },
  {
    id: 'pop',
    name: 'Pop',
    group: 'Genres',
    blurb: 'Major key, claps on the backbeat, a hook that will not leave.',
    tempo: 116, scale: 'majorPent', kit: 2,
    leadWave: 3, bassWave: 3, cutoff: 0.85, swing: 0, delay: 1,
    kick:  'x.......x..x....x.......x..x....',
    snare: '................................',
    hat:   'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.',
    clap:  '....x.......x.......x.......x...',
    bass:  '0000000-3333333-4444444-2222222-',
    lead: [[0, 4, 2], [2, 3, 2], [4, 2, 4], [8, 3, 2], [10, 4, 2], [12, 5, 4],
           [16, 4, 2], [18, 3, 2], [20, 2, 4], [24, 1, 2], [26, 2, 2], [28, 0, 4]],
  },
  {
    id: 'indie',
    name: 'Indie',
    group: 'Genres',
    blurb: 'Clean guitar arpeggios over a restless dorian bassline.',
    tempo: 134, scale: 'dorian', kit: 0,
    leadWave: 1, bassWave: 0, cutoff: 0.72, swing: 0.08, delay: 1,
    kick:  'x.......x.x.....x.......x.x.....',
    snare: '....x.......x.......x.......x...',
    hat:   'x.x.x.x.x.x.x.xxx.x.x.x.x.x.x.xx',
    clap:  '................................',
    bass:  '0000000-6666666-5555555-4444444-',
    lead: [[0, 2, 1], [2, 4, 1], [4, 6, 1], [6, 4, 1], [8, 2, 1], [10, 4, 1],
           [12, 6, 1], [14, 7, 1], [16, 1, 1], [18, 3, 1], [20, 5, 1],
           [22, 3, 1], [24, 1, 1], [26, 3, 1], [28, 5, 2]],
  },
  {
    id: 'party',
    name: 'Party',
    group: 'Genres',
    blurb: 'Four on the floor, offbeat hats, muted guitar stabs.',
    tempo: 126, scale: 'minorPent', kit: 2,
    leadWave: 2, bassWave: 4, cutoff: 0.9, swing: 0, delay: 1,
    kick:  'x...x...x...x...x...x...x...x...',
    snare: '................................',
    hat:   '..x...x...x...x...x...x...x...x.',
    clap:  '....x.......x.......x.......x...',
    bass:  '0-0-0-0-0-0-0-0-4-4-4-4-3-3-3-3-',
    lead: [[0, 3, 2], [4, 3, 2], [8, 4, 2], [12, 3, 2],
           [16, 5, 2], [20, 4, 2], [24, 3, 2], [28, 0, 4]],
  },
  {
    id: 'feelgood',
    name: 'Feel good',
    group: 'Genres',
    blurb: 'Warm organ, a gentle shuffle, and a chord run that keeps rising.',
    tempo: 102, scale: 'major', kit: 0,
    leadWave: 8, bassWave: 0, cutoff: 0.78, swing: 0.18, delay: 1,
    kick:  'x.....x.x.......x.....x.x.......',
    snare: '....x.......x.......x.......x...',
    hat:   'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.',
    clap:  '............x...............x...',
    bass:  '0000000-5555555-3333333-4444444-',
    lead: [[0, 2, 2], [4, 4, 2], [8, 5, 4], [12, 4, 2],
           [16, 2, 2], [20, 4, 2], [24, 6, 4], [28, 4, 4]],
  },
  {
    id: 'lofi',
    name: 'Lo-fi',
    group: 'Genres',
    blurb: 'Slow, heavily swung, filter half shut. Bells in the fog.',
    tempo: 76, scale: 'dorian', kit: 3,
    leadWave: 7, bassWave: 2, cutoff: 0.32, swing: 0.52, delay: 1,
    kick:  'x.........x.....x.........x.....',
    snare: '....x.......x.......x.......x...',
    hat:   'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.',
    clap:  '................................',
    bass:  '0000000-5555555-3333333-4444444-',
    lead: [[0, 4, 4], [6, 6, 2], [12, 5, 4],
           [18, 4, 2], [22, 2, 4], [28, 4, 4]],
  },

  // Scene flavours rather than any particular band's actual songs.
  {
    id: 'stadium',
    name: 'Stadium anthem',
    group: 'Scenes',
    blurb: 'Stomp, stomp, clap. Big clean chords held for the back row.',
    tempo: 118, scale: 'major', kit: 1,
    leadWave: 1, bassWave: 1, cutoff: 0.8, swing: 0, delay: 1,
    kick:  'x.x.....x.x.....x.x.....x.x.....',
    snare: '................................',
    hat:   'x...x...x...x...x...x...x...x...',
    clap:  '....x.......x.......x.......x...',
    bass:  '0000000-0000000-4444444-3333333-',
    lead: [[0, 4, 4], [4, 5, 4], [8, 4, 8],
           [16, 2, 4], [20, 4, 4], [24, 5, 8]],
  },
  {
    id: 'jangle',
    name: 'Manchester jangle',
    group: 'Scenes',
    blurb: 'Shuffled swagger, chiming plucks, bassline that struts.',
    tempo: 122, scale: 'majorPent', kit: 0,
    leadWave: 1, bassWave: 0, cutoff: 0.82, swing: 0.3, delay: 1,
    kick:  'x.......x..x....x.......x..x....',
    snare: '....x.......x.......x.......x...',
    hat:   'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.',
    clap:  '................................',
    bass:  '0000000-0000000-3333333-2222222-',
    lead: [[0, 5, 2], [2, 4, 1], [3, 3, 1], [4, 4, 2], [8, 3, 2], [10, 2, 2],
           [12, 3, 4], [16, 5, 2], [18, 4, 1], [19, 3, 1], [20, 4, 2],
           [24, 2, 2], [26, 1, 2], [28, 0, 4]],
  },
  {
    id: 'grunge',
    name: 'Seattle grunge',
    group: 'Scenes',
    blurb: 'Blues scale, filthy electric guitar, riff that drags its feet.',
    tempo: 112, scale: 'blues', kit: 1,
    leadWave: 0, bassWave: 1, cutoff: 0.5, swing: 0, delay: 0,
    kick:  'x..x....x.......x..x....x.......',
    snare: '....x.......x.......x.......x...',
    hat:   'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.',
    clap:  '................................',
    bass:  '00000000--------33333333--------',
    lead: [[0, 0, 4], [4, 1, 2], [6, 0, 2], [8, 3, 4], [12, 0, 4],
           [16, 0, 4], [20, 1, 2], [22, 0, 2], [24, 4, 4], [28, 3, 4]],
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    group: 'Scenes',
    blurb: 'Neon arpeggios, sub bass pulse, everything drenched in echo.',
    tempo: 108, scale: 'minor', kit: 2,
    leadWave: 5, bassWave: 2, cutoff: 0.62, swing: 0, delay: 1,
    kick:  'x...x...x...x...x...x...x...x...',
    snare: '................................',
    hat:   '..x...x...x...x...x...x...x...x.',
    clap:  '....x.......x.......x.......x...',
    bass:  '0-0-0-0-0-0-0-0-5-5-5-5-4-4-4-4-',
    lead: [[0, 0, 1], [2, 2, 1], [4, 4, 1], [6, 2, 1], [8, 0, 1], [10, 2, 1],
           [12, 4, 1], [14, 6, 1], [16, 5, 1], [18, 4, 1], [20, 2, 1],
           [22, 4, 1], [24, 0, 1], [26, 2, 1], [28, 4, 4]],
  },
];

// ------------------------------------------------------------------ parsing
function parseHits(str) {
  const out = new Array(STEPS).fill(0);
  for (let i = 0; i < STEPS; i++) out[i] = str && str[i] === 'x' ? 1 : 0;
  return out;
}

function parseBass(str, maxRow) {
  const out = new Array(STEPS).fill(-1);
  for (let i = 0; i < STEPS; i++) {
    const c = str && str[i];
    const n = c >= '0' && c <= '9' ? Number(c) : -1;
    out[i] = n >= 0 && n < maxRow ? n : -1;
  }
  return out;
}

// Writes a preset into an existing song object, which the caller supplies so
// this file never has to know how a blank song is built.
// opts.soundOnly keeps whatever notes are already there.
function applyPreset(song, preset, opts) {
  const soundOnly = !!(opts && opts.soundOnly);
  const leadRows = song.lead[0].length;
  const bassRows = opts && opts.bassRows ? opts.bassRows : 7;

  song.tempo = preset.tempo;
  song.scale = preset.scale;
  song.kit = preset.kit;
  song.leadWave = preset.leadWave;
  song.bassWave = preset.bassWave;
  song.cutoff = preset.cutoff;
  song.swing = preset.swing;
  song.delay = preset.delay;
  // The key stays whatever the player picked; presets only choose the flavour.

  if (soundOnly) return song;

  song.drums.kick = parseHits(preset.kick);
  song.drums.snare = parseHits(preset.snare);
  song.drums.hat = parseHits(preset.hat);
  song.drums.clap = parseHits(preset.clap);
  song.bass = parseBass(preset.bass, bassRows);

  for (let s = 0; s < STEPS; s++) song.lead[s].fill(0);
  for (const note of preset.lead) {
    const step = note[0];
    const row = note[1];
    const len = note[2];
    if (row < 0 || row >= leadRows) continue;
    for (let i = 0; i < len && step + i < STEPS; i++) song.lead[step + i][row] = 1;
  }
  return song;
}

const byId = (id) => PRESETS.filter((p) => p.id === id)[0] || null;

const API = { PRESETS, applyPreset, byId, parseHits, parseBass, STEPS };

if (typeof window !== 'undefined') window.SongPresets = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;
