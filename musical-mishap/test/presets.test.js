'use strict';
/* Checks every style preset: that the patterns are well formed, that they
   produce a song the game will actually accept, and that a preset survives a
   real round trip through the server to another player unchanged.
   Run with:  node test/presets.test.js  */

const assert = require('assert');
const path = require('path');
const { startServer, player, reporter } = require('./harness');

const A = require(path.join(__dirname, '..', 'public', 'audio.js'));
const P = require(path.join(__dirname, '..', 'public', 'presets.js'));

const PORT = 8125;
const STEPS = 32;
// Kept in step with the server's own whitelist.
const SCALES = ['minorPent', 'majorPent', 'dorian', 'minor', 'major', 'blues'];

function songIsEmpty(song) {
  for (const k of ['kick', 'snare', 'hat', 'clap']) {
    if (song.drums[k].indexOf(1) >= 0) return false;
  }
  if (song.bass.some((v) => v >= 0)) return false;
  return !song.lead.every((col) => col.indexOf(1) < 0);
}

async function main() {
  const server = startServer(PORT);
  await server.ready;
  const check = reporter();

  // ------------------------------------------------- static pattern checks
  const badPatterns = [];
  const badRanges = [];
  const emptyOnes = [];

  for (const preset of P.PRESETS) {
    const where = preset.id;

    for (const lane of ['kick', 'snare', 'hat', 'clap']) {
      const str = preset[lane];
      if (typeof str !== 'string' || str.length !== STEPS || /[^x.]/.test(str)) {
        badPatterns.push(where + '.' + lane + ' (' + (str || '').length + ' chars)');
      }
    }
    if (typeof preset.bass !== 'string' || preset.bass.length !== STEPS ||
        /[^0-9-]/.test(preset.bass)) {
      badPatterns.push(where + '.bass');
    }
    for (const c of preset.bass || '') {
      if (c !== '-' && Number(c) >= A.BASS_ROWS) {
        badRanges.push(where + '.bass degree ' + c + ' (max ' + (A.BASS_ROWS - 1) + ')');
      }
    }
    for (const n of preset.lead) {
      if (n[0] < 0 || n[0] >= STEPS) badRanges.push(where + '.lead step ' + n[0]);
      if (n[1] < 0 || n[1] >= A.LEAD_ROWS) badRanges.push(where + '.lead degree ' + n[1]);
      if (n[2] < 1) badRanges.push(where + '.lead length ' + n[2]);
      if (n[0] + n[2] > STEPS) badRanges.push(where + '.lead note overruns the bar at ' + n[0]);
    }
    if (SCALES.indexOf(preset.scale) < 0) badRanges.push(where + '.scale ' + preset.scale);
    if (preset.tempo < 60 || preset.tempo > 170) badRanges.push(where + '.tempo ' + preset.tempo);
    if (preset.kit < 0 || preset.kit >= A.KITS.length) badRanges.push(where + '.kit');
    if (preset.leadWave < 0 || preset.leadWave >= A.LEAD_INSTRUMENTS.length) {
      badRanges.push(where + '.leadWave ' + preset.leadWave);
    }
    if (preset.bassWave < 0 || preset.bassWave >= A.BASS_INSTRUMENTS.length) {
      badRanges.push(where + '.bassWave ' + preset.bassWave);
    }
    if (preset.cutoff < 0 || preset.cutoff > 1) badRanges.push(where + '.cutoff');
    if (preset.swing < 0 || preset.swing > 0.6) badRanges.push(where + '.swing');

    const song = P.applyPreset(A.emptySong(), preset, { bassRows: A.BASS_ROWS });
    if (songIsEmpty(song)) emptyOnes.push(where);
  }

  check('there are presets to choose from', () =>
    assert.ok(P.PRESETS.length >= 6, 'got ' + P.PRESETS.length));
  check('every preset id is unique', () => {
    const ids = P.PRESETS.map((p) => p.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });
  check('every pattern is 32 steps of valid characters', () =>
    assert.deepStrictEqual(badPatterns, []));
  check('every degree and setting is in range', () =>
    assert.deepStrictEqual(badRanges, []));
  check('every preset produces a playable, non-empty song', () =>
    assert.deepStrictEqual(emptyOnes, []));
  check('sound-only leaves existing notes alone', () => {
    const song = A.emptySong();
    song.drums.kick[5] = 1;
    song.lead[3][2] = 1;
    P.applyPreset(song, P.byId('lofi'), { soundOnly: true, bassRows: A.BASS_ROWS });
    assert.strictEqual(song.drums.kick[5], 1, 'kick survived');
    assert.strictEqual(song.lead[3][2], 1, 'melody survived');
    assert.strictEqual(song.tempo, P.byId('lofi').tempo, 'tempo still changed');
    assert.strictEqual(song.kit, P.byId('lofi').kit, 'kit still changed');
  });
  check('a preset keeps the key the player chose', () => {
    const song = A.emptySong();
    song.root = 7;
    P.applyPreset(song, P.byId('rock'), { bassRows: A.BASS_ROWS });
    assert.strictEqual(song.root, 7);
  });

  // ------------------------------------------------- plucked-string voices
  const stringInsts = A.LEAD_INSTRUMENTS.concat(A.BASS_INSTRUMENTS)
    .filter((i) => i.kind === 'string');
  const silent = [];
  const dirty = [];
  const noDecay = [];

  for (const inst of stringInsts) {
    for (const freq of [55, 110, 330, 880]) {
      const data = A.renderString(44100, freq, inst);
      let peak = 0;
      let bad = false;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (!Number.isFinite(v)) { bad = true; break; }
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      const label = inst.name + ' @' + freq + 'Hz';
      if (bad || peak > 1.0001) dirty.push(label);
      if (peak < 0.5) silent.push(label);

      // The tail must be quieter than the attack, or it is not a plucked note.
      const rms = (from, to) => {
        let s = 0;
        for (let i = from; i < to; i++) s += data[i] * data[i];
        return Math.sqrt(s / (to - from));
      };
      const head = rms(0, Math.floor(data.length * 0.1));
      const tail = rms(Math.floor(data.length * 0.85), data.length);
      if (!(tail < head)) noDecay.push(label);
    }
  }

  check('every plucked instrument makes sound', () =>
    assert.deepStrictEqual(silent, []));
  check('no plucked note clips or produces NaN', () =>
    assert.deepStrictEqual(dirty, []));
  check('plucked notes decay like a real string', () =>
    assert.deepStrictEqual(noDecay, []));
  check('guitars and basses are string-synthesised, not oscillators', () => {
    assert.strictEqual(A.LEAD_INSTRUMENTS[0].kind, 'string', 'lead 0 is a guitar');
    assert.strictEqual(A.BASS_INSTRUMENTS[0].kind, 'string', 'bass 0 is a bass guitar');
    assert.ok(stringInsts.length >= 5, 'got ' + stringInsts.length + ' string voices');
  });

  // ------------------------------------------- round trip through the server
  const ada = player('Ada', PORT);
  const grace = player('Grace', PORT);

  await ada.open;
  ada.send({ t: 'join', name: 'Ada', room: '' });
  const lobby = await ada.until((s) => s.phase === 'lobby', 'lobby');
  await grace.open;
  grace.send({ t: 'join', name: 'Grace', room: lobby.room });
  await ada.until((s) => s.players.length === 2, 'second player');

  ada.send({ t: 'settings', mode: 'jam', turns: 12, composeTime: 300 });
  await ada.until((s) => s.mode === 'jam', 'jam mode');
  ada.send({ t: 'start' });
  await ada.until((s) => s.phase === 'jamturn', 'turn 1');
  await grace.until((s) => s.phase === 'jamturn', 'turn 1 for Grace');

  const mangled = [];
  for (const preset of P.PRESETS) {
    const sent = P.applyPreset(A.emptySong(), preset, { bassRows: A.BASS_ROWS });
    sent.title = preset.name;
    grace.inbox.length = 0;
    ada.send({ t: 'jamdraft', song: sent });
    const push = await grace.until((m) => m.t === 'jamsong', 'push for ' + preset.id, 5000);
    try {
      assert.deepStrictEqual(push.song, sent);
    } catch (e) {
      mangled.push(preset.id);
    }
  }

  check('every preset reaches other players byte for byte', () =>
    assert.deepStrictEqual(mangled, []));

  ada.ws.close();
  grace.ws.close();
  server.proc.kill();
  check.finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
